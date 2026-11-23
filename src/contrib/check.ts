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
 * Only the first line is read, and the wording is not inspected here: the wording `DOCS.md` fixes belongs to a
 * submission's pull request title, where {@link checkTitle} judges it and the plugin id is available to compare against.
 * What remains is what holds for every commit in this repository, whether it submits a plugin or changes the registry
 * itself.
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
 * about: a submission targets `main` or it is refused, whether or not it is a draft. Refusing here only fails the check;
 * it does not close the pull request, which the maintainer decides.
 * @param branch - the base branch the pull request targets.
 * @returns the problems found, empty when the branch is the right one.
 */
export function checkBase(branch: string): string[] {
  if (branch === 'main') return []
  return [
    `a plugin submission must target "main", but this pull request targets ${JSON.stringify(branch)}.`,
    'Retarget it to "main", or open a new pull request against "main".',
  ]
}

/**
 * The one pull request title a plugin submission may carry.
 *
 * `DOCS.md` states the title as a literal form and not as an example: `feat: add or update plugin <dsh-plugin-id>`. The
 * title matters because a submission is squash-merged with the title as the commit message, so this is what the plugin
 * index will show for the contribution. Comparing the whole string is deliberate: a title that continues past the plugin
 * id would become a different commit message.
 */
const SUBMISSION_PREFIX = 'feat: add or update plugin '

/**
 * The shape of a Conventional Commit subject.
 *
 * `DOCS.md` asks a change to the repository itself for Conventional Commits. Commit messages on a submission are not
 * held to this: a contributor who pushes a fix an hour later has to write a new message, and requiring the same wording
 * twice would only make the branch awkward to work with. The squash-merge discards those messages in favour of the title
 * anyway, so what is checked here is a courtesy rather than a gate.
 */
const CONVENTIONAL = /^[a-z][a-z0-9]*(?:\([^()\s]+\))?!?: \S/

/**
 * Check the pull request title of a submission.
 *
 * Nothing else in a pull request is judged by its wording. The body is not read at all, and the commits are only warned
 * about, so this is the single place where a submission has to say something specific: the plugin id has to appear in
 * the title because the title is what lands on `main`.
 * @param title - the pull request title.
 * @param id - the plugin id the submitted metadata declares.
 * @returns the problems found, empty when the title matches.
 */
export function checkTitle(title: string, id: string): string[] {
  const expected = `${SUBMISSION_PREFIX}${id}`
  if (title.trim() === expected) return []
  return [
    `the pull request title is ${JSON.stringify(title)}, but a plugin submission uses exactly ${JSON.stringify(expected)}`,
    'The title becomes the commit message when the pull request is squash-merged, so it is what the plugin index records.',
  ]
}

/**
 * Warn about what a commit subject looks like.
 *
 * These are advisory. A contributor pushing a second commit to a submission would otherwise have to repeat the same
 * title as the message, and a message that a squash-merge discards is not worth rejecting a pull request over.
 * @param subject - the first line of a commit message.
 * @returns the warnings, empty when the subject raises none.
 */
export function warnSubject(subject: string): string[] {
  const warnings = checkSubject(subject)
  // An empty subject is already reported by `checkSubject`; testing the pattern against it would add a second complaint
  // about the same line.
  if (subject.trim() !== '' && !CONVENTIONAL.test(subject)) {
    warnings.push('the subject is not a conventional commit such as "fix: repair the worker"')
  }
  return warnings
}

/**
 * Collect the warnings a pull request's commits raise.
 * @param subjects - the commit subjects it carries.
 * @returns one warning per problem, each naming the commit it came from.
 */
export function warnSubjects(subjects: readonly string[]): string[] {
  const warnings: string[] = []
  for (const subject of subjects) {
    for (const warning of warnSubject(subject)) warnings.push(`commit ${JSON.stringify(subject)}: ${warning}`)
  }
  return warnings
}

/**
 * Read the plugin id a metadata file declares, without validating the rest of it.
 * @param path - repository-relative path of the metadata file.
 * @param head - the commit to read it from.
 * @returns the id, or `null` when the file cannot be read or declares none.
 */
function submittedId(path: string, head: string): string | null {
  let text: string
  try {
    text = execFileSync('git', ['show', `${head}:${path}`], { encoding: 'utf8' })
  } catch {
    return null
  }
  const match = /^id:\s*(\S+)\s*$/m.exec(text)
  return match?.[1] ?? null
}

/**
 * Decide whether a pull request passes.
 *
 * Only the file changes decide this. A pull request that submits a plugin is judged on where the file sits, what it
 * says, which branch the pull request targets, and whether the title names it; the wording of its commits is reported
 * separately as a warning, and the body is never read.
 * @param subjects - the commit subjects it carries.
 * @param changed - the files it touches.
 * @param branch - the base branch it targets, when known.
 * @param head - the commit under review, where a submitted file is read from.
 * @param title - the pull request title, when known.
 * @returns the problems found, empty when it passes.
 */
export function check(
  subjects: readonly string[],
  changed: readonly Changed[],
  branch?: string,
  head = 'HEAD',
  title = '',
): string[] {
  const problems: string[] = []
  if (subjects.length === 0) problems.push('the pull request carries no commits')
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
  if (shape.length === 0 && changed[0] !== undefined) {
    const path = changed[0].path
    const metadata = checkMetadata(path, head)
    problems.push(...metadata)
    // The title names the plugin id, so the id has to be readable before the title can be judged. When the metadata is
    // broken the problems above already say why, and guessing an id here would only add a second complaint.
    const id = metadata.length === 0 ? submittedId(path, head) : null
    if (id !== null) problems.push(...checkTitle(title, id))
  }
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
  // The title is what a squash-merge turns into the commit message, so a submission is judged by it rather than by its
  // commits. A local run has no title, and an empty one only fails a submission, which is the right answer for a checkout
  // that cannot say what it is about to be merged as.
  const titleFlag = process.argv.indexOf('--title')
  const title = titleFlag === -1 ? '' : process.argv[titleFlag + 1] ?? ''
  const from = base ?? execFileSync('git', ['merge-base', 'origin/main', head], { encoding: 'utf8' }).trim()
  const subjects = subjectsOf(from, head)
  const changed = changedFiles(from, head)
  // Warnings are advisory and printed before the verdict, so a run that passes still shows them without the exit code
  // suggesting otherwise. Nothing here can fail a pull request.
  for (const warning of warnSubjects(subjects)) console.error(`warning: ${warning}`)
  const problems = check(subjects, changed, target, head, title)
  if (problems.length > 0) {
    console.error('This pull request cannot be merged:\n')
    for (const problem of problems) console.error(`  ${problem}`)
    console.error('')
    process.exit(1)
  }
  console.log(
    isSubmission(changed)
      ? 'plugin submission: title, base branch, diff shape and metadata are valid'
      : `ordinary pull request: ${changed.length} file(s) for review`,
  )
}
