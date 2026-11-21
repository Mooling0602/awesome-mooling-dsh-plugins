#!/usr/bin/env node
/**
 * Write every README from its template plus the plugin metadata.
 *
 * Run from the repository root:
 *
 * ```sh
 * node src/readme/build.ts
 * node src/readme/build.ts --check
 * ```
 *
 * `--check` exits non-zero when a README on disk disagrees with what the metadata produces, so CI can fail on a stale
 * README instead of silently shipping one.
 *
 * The default branch of each plugin repository is read from the GitHub API, because a relative README path has to become
 * a link and a guessed branch breaks as soon as a repository renames its default branch. `GITHUB_TOKEN` is used when it
 * is set, which keeps the run inside the API rate limit.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPlugins, type Plugin } from '../metadata.ts'
import { defaultBranches } from './branch.ts'
import { readAllFacts } from './badge-source.ts'
import { TARGETS, renderTarget, type ReadmeTarget } from './render.ts'
import type { BadgeFacts } from './badge.ts'

/** Repository root, two levels above `src/readme/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * How the builder reaches GitHub.
 *
 * Branches are read once per run and injected, so a test can supply them instead of calling the API: rendering must be
 * reproducible offline, and only the CLI needs the network.
 */
export interface Options {
  /** GitHub token, when the caller has one. */
  readonly token?: string
  /** Default branches keyed by repository URL; read from the API when omitted. */
  readonly branches?: ReadonlyMap<string, string>
  /** Badge facts keyed by plugin id; read from the API when omitted. */
  readonly facts?: ReadonlyMap<string, BadgeFacts>
  /** Receives a message for every repository whose branch could not be read. */
  readonly warn?: (message: string) => void
}

/**
 * Read the branches the READMEs will link, unless the caller already supplied them.
 * @param plugins - the plugins that may carry a README link.
 * @param options - how to reach GitHub.
 * @returns default branches keyed by repository URL.
 */
async function resolveBranches(
  plugins: readonly Plugin[],
  options: Options,
): Promise<ReadonlyMap<string, string>> {
  if (options.branches !== undefined) return options.branches
  if (!TARGETS.some(target => target.linksOwnReadme)) return new Map()
  return defaultBranches(
    plugins.map(plugin => plugin.repo),
    options.token,
    options.warn ?? (message => console.warn(`warning: ${message}`)),
  )
}

/**
 * Read the badge facts the READMEs will show, unless the caller already supplied them.
 * @param plugins - the plugins to read facts for.
 * @param branches - the branches already resolved.
 * @param options - how to reach GitHub.
 * @returns facts keyed by plugin id.
 */
async function resolveFacts(
  plugins: readonly Plugin[],
  branches: ReadonlyMap<string, string>,
  options: Options,
): Promise<ReadonlyMap<string, BadgeFacts>> {
  if (options.facts !== undefined) return options.facts
  return readAllFacts(
    plugins,
    branches,
    options.token,
    options.warn ?? (message => console.warn(`warning: ${message}`)),
  )
}

/**
 * Build one target's README text from the repository.
 * @param root - repository root to read `plugins/by-name/` and `templates/` from.
 * @param target - which README to build.
 * @param options - where to read default branches and badge facts from.
 * @param plugins - the plugins to list; read from disk when omitted.
 * @returns the generated README text.
 */
export async function buildReadme(
  root: string,
  target: ReadmeTarget,
  options: Options = {},
  plugins?: readonly Plugin[],
): Promise<string> {
  const template = await readFile(join(root, 'templates', target.template), 'utf8')
  const list = plugins ?? (await readPlugins(root))
  const branches = await resolveBranches(list, options)
  const facts = await resolveFacts(list, branches, options)
  return renderTarget(target, list, template, branches, facts)
}

/**
 * Write every README.
 * @param root - repository root.
 * @param options - where to read default branches and badge facts from.
 * @returns the targets written.
 */
export async function writeReadmes(root: string = ROOT, options: Options = {}): Promise<readonly ReadmeTarget[]> {
  const plugins = await readPlugins(root)
  const branches = await resolveBranches(plugins, options)
  const facts = await resolveFacts(plugins, branches, options)
  for (const target of TARGETS) {
    const template = await readFile(join(root, 'templates', target.template), 'utf8')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, target.output), renderTarget(target, plugins, template, branches, facts), 'utf8')
  }
  return TARGETS
}

/**
 * Check every README against what the metadata produces.
 * @param root - repository root.
 * @param options - where to read default branches and badge facts from.
 * @returns one message per stale or missing README; empty when all are current.
 */
export async function checkReadmes(root: string = ROOT, options: Options = {}): Promise<string[]> {
  const plugins = await readPlugins(root)
  const branches = await resolveBranches(plugins, options)
  const facts = await resolveFacts(plugins, branches, options)
  const stale: string[] = []
  for (const target of TARGETS) {
    const template = await readFile(join(root, 'templates', target.template), 'utf8')
    const expected = renderTarget(target, plugins, template, branches, facts)
    let actual: string
    try {
      actual = await readFile(join(root, target.output), 'utf8')
    } catch {
      stale.push(`${target.output} is missing; run \`node src/readme/build.ts\``)
      continue
    }
    if (actual !== expected) stale.push(`${target.output} is stale; run \`node src/readme/build.ts\``)
  }
  return stale
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

if (invokedDirectly()) {
  const token = process.env['GITHUB_TOKEN']
  const options: Options = token === undefined || token === '' ? {} : { token }
  if (process.argv.includes('--check')) {
    const stale = await checkReadmes(ROOT, options)
    if (stale.length > 0) {
      for (const message of stale) console.error(message)
      process.exit(1)
    }
    console.log(`READMEs are up to date: ${TARGETS.length} file(s)`)
  } else {
    const written = await writeReadmes(ROOT, options)
    console.log(`wrote ${written.length} README(s): ${written.map(target => target.output).join(', ')}`)
  }
}
