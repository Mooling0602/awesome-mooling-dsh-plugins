#!/usr/bin/env node
/**
 * Check a pull request before anything is built.
 *
 * A pull request is one of two kinds, and what it touches decides which:
 *
 * - A **plugin submission** touches a file named `plugin.yml`. It must carry exactly that one file, at
 *   `plugins/by-name/<shard>/<name>/plugin.yml`, added or modified rather than deleted, and the file must parse under
 *   `parsePluginYml` and agree with `checkPluginLocation` — the same pair the registry build runs over every plugin.
 * - Anything else is an **ordinary pull request** that changes the repository rather than the plugin list. Only a person
 *   can judge a change to the worker, the build or the docs, so the shape is not constrained here.
 *
 * Because a submission is a diff of exactly one file, a pull request cannot both add a plugin and change the repository.
 * That is the point: a submission arrives from a fork and is judged by its shape alone, which only works while the shape
 * accounts for everything it does.
 *
 * The subject line is checked in both kinds. Conventions about its wording are not enforced, because a submission's
 * subject is written by the form that produces it, so the type prefix is not the contributor's to get wrong.
 *
 * Run from the repository root:
 *
 * ```sh
 * node src/contrib/check.ts
 * node src/contrib/check.ts --range origin/main...HEAD
 * ```
 */
import { execFileSync } from 'node:child_process'
import { checkPluginLocation, inShard, parsePluginYml, shardOf } from '../metadata.ts'

/** A plugin metadata path: the shard directory, the plugin directory, and the file itself. */
const METADATA = /^plugins\/by-name\/(?<shard>[^/]+)\/(?<name>[^/]+)\/plugin\.yml$/u

/** Longest subject accepted; a title has no reason to run past this. */
const SUBJECT_LIMIT = 100

/** One file the diff touched. */
export interface Changed {
  /** Path relative to the repository root, as git reports it. */
  readonly path: string
  /** The single-letter status git reports; `A` for an added file. */
  readonly status: string
}

/**
 * Check a commit subject line.
 *
 * Only the first line is read. The wording is not inspected: a submission form writes it, so a missing type prefix is
 * not a fault in the contribution.
 * @param subject - the first line of a commit message.
 * @returns the problems found, empty when the subject is usable.
 */
export function checkSubject(subject: string): string[] {
  const problems: string[] = []
  if (subject.trim() === '') return ['the commit subject is empty']
  if (subject !== subject.trim()) problems.push(`the commit subject has leading or trailing whitespace: ${JSON.stringify(subject)}`)
  if (subject.includes('\n')) problems.push('the commit subject spans more than one line')
  if (subject.trim().length > SUBJECT_LIMIT) {
    problems.push(`the commit subject is ${subject.trim().length} characters; keep it under ${SUBJECT_LIMIT}`)
  }
  return problems
}

/**
 * Whether a diff is a plugin submission rather than an ordinary pull request.
 *
 * The test is the presence of a file named `plugin.yml`, not the presence of a well-placed one. A submission that put its
 * metadata at the wrong path is still a submission, and must fail as one rather than slip through as an ordinary change.
 * @param changed - the files the diff touched.
 * @returns true when any touched file is named `plugin.yml`.
 */
export function isSubmission(changed: readonly Changed[]): boolean {
  return changed.some(file => file.path.split('/').at(-1) === 'plugin.yml')
}

/**
 * Check that a submission is exactly one added or modified plugin metadata file at its required path.
 * @param changed - the files the diff touched, one entry per file.
 * @returns the problems found, empty when the diff is a single well-placed metadata file.
 */
export function checkDiff(changed: readonly Changed[]): string[] {
  if (changed.length === 0) return ['the diff is empty: this pull request changes no file']
  if (changed.length > 1) {
    return [
      `a plugin submission changes exactly one metadata file, but this pull request touches ${changed.length}:`,
      ...changed.map(file => `  ${file.status} ${file.path}`),
      'Add the plugin in its own pull request, without changing the repository in the same one.',
    ]
  }
  const only = changed[0]
  /* v8 ignore next -- the length check above already returned */
  if (only === undefined) return ['the diff is empty']
  const match = METADATA.exec(only.path)
  if (match?.groups === undefined) {
    return [
      `this pull request touches ${JSON.stringify(only.path)}, a plugin submission but not at the path one belongs at.`,
      'A plugin submission adds plugins/by-name/<shard>/<name>/plugin.yml and changes nothing else.',
    ]
  }
  const problems: string[] = []
  if (only.status !== 'A' && only.status !== 'M') {
    problems.push(`the metadata file is ${only.status === 'D' ? 'deleted' : 'changed'} rather than added or modified`)
  }
  const name = match.groups['name'] ?? ''
  const shard = match.groups['shard'] ?? ''
  let expected: string
  try {
    expected = shardOf(name)
  } catch (error) {
    return [...problems, error instanceof Error ? error.message : String(error)]
  }
  if (!inShard(shard, name)) {
    problems.push(`${JSON.stringify(name)} belongs in ${JSON.stringify(expected)}, not ${JSON.stringify(shard)}`)
  }
  return problems
}

/**
 * Check one metadata file against the rules the registry build applies.
 *
 * The file is read from the commit under review with `git show`, not from the working tree. A working tree carries
 * whichever files happen to be checked out, so reading from it would tie the answer to how the checkout was prepared;
 * naming the commit and the path means the content is always the one being judged.
 * @param path - repository-relative path of the file to read.
 * @param commit - the commit to read it from.
 * @returns the problems found, empty when the file is valid.
 */
export function checkMetadata(path: string, commit = 'HEAD'): string[] {
  const match = METADATA.exec(path)
  if (match?.groups === undefined) return [`${path} is not a plugin metadata file`]
  let text: string
  try {
    text = execFileSync('git', ['show', `${commit}:${path}`], { encoding: 'utf8' })
  } catch {
    return [`${path} cannot be read from ${commit}`]
  }
  try {
    const parsed = parsePluginYml(text, path)
    checkPluginLocation(parsed, match.groups['name'] ?? '', match.groups['shard'] ?? '', path)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  return []
}

/**
 * Find the commit a pull request branched from.
 *
 * A pull request is judged on what it *added*, not on how the two branches currently differ. Those are the same question
 * only while the base branch has not moved: once anything lands on `main`, a plain `git diff base head` also reports the
 * base branch's own newer commits as though the pull request had reverted them. A submission opened last week against a
 * `check.ts` that has since changed would be told it modified `check.ts`, and rejected for touching more than one file.
 *
 * The branch point is therefore the comparison point, which is what `git merge-base` computes. It needs the history the
 * two commits share, so a run that fetched only the two endpoint commits cannot resolve it; that is why the workflow
 * checks out real history rather than a single depth-1 commit per side.
 * @param base - the commit the pull request would merge into.
 * @param head - the commit under review.
 * @returns the merge base, or `head` itself when the histories are unrelated.
 * @throws when git cannot be run, which is a broken checkout rather than a rejected pull request.
 */
export function branchPoint(base: string, head: string): string {
  let found = ''
  try {
    found = execFileSync('git', ['merge-base', base, head], { encoding: 'utf8' }).trim()
  } catch {
    // Unrelated histories have no branch point; git exits non-zero and nothing is printed.
    found = ''
  }
  // A shallow clone is the case worth guarding: with only the two endpoint commits present there is no shared history to
  // walk, and git can answer with nothing *and* exit successfully. Passing that emptiness on would fail later as an
  // unrelated "ambiguous argument" error, so it is treated as the same absence as a non-zero exit.
  return found === '' ? head : found
}

/**
 * Read the files a diff touched.
 *
 * The comparison runs from the branch point to the head, not from the base tip to the head. A pull request carries only
 * its own commits, and once the base branch moves on, `git diff base head` counts the base branch's newer commits as
 * changes the pull request made. Anchoring at the branch point describes the contribution instead of the divergence.
 * @param base - the commit the pull request would merge into.
 * @param head - the commit under review.
 * @returns one entry per file.
 * @throws when git cannot be run, which is a broken checkout rather than a rejected pull request.
 */
export function changedFiles(base: string, head: string): Changed[] {
  const output = execFileSync('git', ['diff', '--name-status', '--no-renames', branchPoint(base, head), head], {
    encoding: 'utf8',
  })
  return output
    .split('\n')
    .filter(line => line !== '')
    .map((line) => {
      const [status = '', path = ''] = line.split('\t')
      return { status: status.slice(0, 1), path }
    })
}

/**
 * Read the commit subjects a pull request carries.
 *
 * The subjects are read from the head's own history back to the base, which `git log base..head` expresses as "what
 * `head` reaches that `base` does not". That is already the pull request's own contribution, so unlike the diff below it
 * needs no branch point: commits that only the base branch has are excluded by construction, and commits the base branch
 * gained after the pull request was opened are equally irrelevant to what the pull request said.
 * @param base - the commit the pull request would merge into.
 * @param head - the commit under review.
 * @returns every subject, oldest first.
 */
export function subjectsOf(base: string, head: string): string[] {
  const output = execFileSync('git', ['log', '--format=%s', `${base}..${head}`], { encoding: 'utf8' })
  return output.split('\n').filter(line => line !== '')
}

/**
 * Check that a submission targets the branch this repository publishes from.
 *
 * A plugin submission changes what the registry publishes, and the registry is built from `main`. A submission aimed
 * anywhere else can never be merged into what it changes, so the answer is a rejection rather than a rule to reason
 * about: a submission targets `main` or it is closed, whether or not it is a draft.
 * @param branch - the base branch the pull request targets.
 * @returns the problems found, empty when the branch is the right one.
 */
export function checkBase(branch: string): string[] {
  if (branch === 'main') return []
  return [
    `a plugin submission must target "main", but this pull request targets ${JSON.stringify(branch)}.`,
    'Reopen it against "main", or retarget it before submitting again.',
  ]
}

/**
 * Decide whether a pull request passes.
 * @param subjects - the commit subjects it carries.
 * @param changed - the files it touches.
 * @param branch - the base branch it targets, when known.
 * @param head - the commit under review, where a submitted file is read from.
 * @returns the problems found, empty when it passes.
 */
export function check(
  subjects: readonly string[],
  changed: readonly Changed[],
  branch?: string,
  head = 'HEAD',
): string[] {
  const problems: string[] = []
  if (subjects.length === 0) problems.push('the pull request carries no commits')
  for (const subject of subjects) {
    for (const problem of checkSubject(subject)) problems.push(`commit ${JSON.stringify(subject)}: ${problem}`)
  }
  if (changed.length === 0) {
    problems.push('the diff is empty: this pull request changes no file')
    return problems
  }
  // An ordinary pull request changes the repository rather than the plugin list; only a person can judge that.
  if (!isSubmission(changed)) return problems
  // A submission has to land where the registry is built from, so its target branch is part of its shape.
  if (branch !== undefined) problems.push(...checkBase(branch))
  const shape = checkDiff(changed)
  problems.push(...shape)
  // Only a well-shaped diff names a file worth reading; a rejected shape already explained itself.
  if (shape.length === 0 && changed[0] !== undefined) problems.push(...checkMetadata(changed[0].path, head))
  return problems
}

/** Whether this file is the process entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return entry.endsWith('check.ts') || entry.endsWith('check.js')
}

if (invokedDirectly()) {
  // The two commits under comparison. `--base` names where the pull request would merge and `--head` the commit under
  // review; without them a local run falls back to the merge base with `main`, which is what a developer expects.
  const baseFlag = process.argv.indexOf('--base')
  const headFlag = process.argv.indexOf('--head')
  const base = baseFlag === -1 ? null : process.argv[baseFlag + 1] ?? null
  const head = headFlag === -1 ? 'HEAD' : process.argv[headFlag + 1] ?? 'HEAD'
  // The branch a pull request targets is only known inside a pull request event; a local run has no target to check.
  const refFlag = process.argv.indexOf('--target')
  const target = refFlag === -1 ? undefined : process.argv[refFlag + 1]
  const from = base ?? execFileSync('git', ['merge-base', 'origin/main', head], { encoding: 'utf8' }).trim()
  const subjects = subjectsOf(from, head)
  const changed = changedFiles(from, head)
  const problems = check(subjects, changed, target, head)
  if (problems.length > 0) {
    console.error('This pull request cannot be merged:\n')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(
    isSubmission(changed)
      ? 'plugin submission: subject, base branch, diff shape and metadata are valid'
      : `ordinary pull request: ${changed.length} file(s) for review`,
  )
}
