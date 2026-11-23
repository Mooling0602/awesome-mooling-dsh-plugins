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
import { readFileSync } from 'node:fs'
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
 * @param path - repository-relative path of the file to read.
 * @returns the problems found, empty when the file is valid.
 */
export function checkMetadata(path: string): string[] {
  const match = METADATA.exec(path)
  if (match?.groups === undefined) return [`${path} is not a plugin metadata file`]
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return [`${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`]
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
 * Read the files a diff touched.
 * @param range - the git range to diff.
 * @returns one entry per file.
 * @throws when git cannot be run, which is a broken checkout rather than a rejected pull request.
 */
export function changedFiles(range: string): Changed[] {
  const output = execFileSync('git', ['diff', '--name-status', '--no-renames', range], { encoding: 'utf8' })
  return output
    .split('\n')
    .filter(line => line !== '')
    .map((line) => {
      const [status = '', path = ''] = line.split('\t')
      return { status: status.slice(0, 1), path }
    })
}

/**
 * Read the commit subjects a range carries.
 * @param range - the git range to read.
 * @returns every subject, oldest first.
 */
export function subjectsOf(range: string): string[] {
  const output = execFileSync('git', ['log', '--format=%s', range], { encoding: 'utf8' })
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
 * @returns the problems found, empty when it passes.
 */
export function check(subjects: readonly string[], changed: readonly Changed[], branch?: string): string[] {
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
  if (shape.length === 0 && changed[0] !== undefined) problems.push(...checkMetadata(changed[0].path))
  return problems
}

/** Whether this file is the process entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return entry.endsWith('check.ts') || entry.endsWith('check.js')
}

if (invokedDirectly()) {
  const flag = process.argv.indexOf('--range')
  const range = flag === -1 ? 'origin/main...HEAD' : process.argv[flag + 1] ?? 'origin/main...HEAD'
  // The base branch is only known inside a pull request event; a local run has no target to check.
  const baseFlag = process.argv.indexOf('--base')
  const base = baseFlag === -1 ? undefined : process.argv[baseFlag + 1]
  const subjects = subjectsOf(range)
  const changed = changedFiles(range)
  const problems = check(subjects, changed, base)
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
