/**
 * Decide whether the deployed index still matches the one this checkout would produce.
 *
 * The scheduled run exists because a plugin can publish a release without this repository seeing a push, and the index
 * is compiled into the worker, so nothing else would notice. Running the whole pipeline on a timer would deploy and
 * write KV once an hour whether or not anything moved, so the run starts here instead: it generates the index locally
 * and compares.
 *
 * Comparing the generated index rather than asking GitHub for new tags is deliberate. A tag is only one of the things
 * that changes an entry; editing `plugin.yml`, a release asset, or the display metadata in a plugin's repository
 * changes it just as much, and all of those show up in this comparison without being enumerated.
 *
 * The deployed index is fetched rather than rebuilt from memory because it is the only statement of what users are
 * actually served. A comparison against the previous build would miss a deploy that never landed.
 *
 * The verdict is written to a file named by the first argument. It is not carried by the exit code: Node exits 1 on an
 * uncaught exception as well as on a deliberate failure, so a crashed build and "the index moved" would look identical,
 * and every other exit code would be read as "nothing to publish" — the one wrong answer, since it silently skips a
 * release. Exit 0 means a verdict was written; anything else means the check broke, and the caller must not publish.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { generate } from './build.ts'

/** Repository root, one level above `src/index/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the deployed index is served from. */
const DEPLOYED = 'https://mynpm.staringplanet.top/dsh-plugins/index.json'

/** The registry base, trailing slash included, as a client sees it. */
const REGISTRY = 'https://mynpm.staringplanet.top/'

/**
 * Read the deployed index.
 *
 * The worker serves the index with `max-age=300`, because a market index that is five minutes stale costs a client
 * nothing. A comparison is the opposite: it decides whether to publish, so a cached copy would report the previous
 * release as a difference and deploy identical data. Both the request cache mode and the request header are set, since
 * `no-store` governs the client side and `no-cache` is what a CDN in the path is asked to honour.
 * @param url - the deployed index URL.
 * @returns the parsed body, or undefined when the worker could not be read.
 */
async function deployed(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      cache: 'no-store',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  try {
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * Normalise an index for comparison.
 *
 * Both sides go through the same `JSON.stringify` call, so formatting cannot masquerade as a change. Key order does
 * count, because `JSON.stringify` keeps insertion order: both sides are written by this same generator, so a difference
 * in key order is a change the generator itself made, which is worth publishing. It cannot appear on its own, because a
 * served body is this generator's output passed through the worker unchanged.
 * @param value - an index, parsed or generated.
 * @returns a comparable string.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Whether a served index differs from a freshly generated one.
 *
 * Kept separate from the network so the comparison can be tested without a worker to talk to.
 * @param local - the index this checkout produces.
 * @param remote - the index being served.
 * @returns whether publishing would change what users receive.
 */
export function moved(local: unknown, remote: unknown): boolean {
  return canonical(local) !== canonical(remote)
}

/**
 * Ask the registry for one package's packument.
 * @param name - the package to read.
 * @returns the packument, or undefined when it could not be read.
 */
async function packumentOf(name: string): Promise<unknown> {
  try {
    const response = await fetch(`${REGISTRY}${name}`, {
      cache: 'no-store',
      headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
    })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * The newest version of every converted package in an index.
 *
 * Split out from the network so the selection can be tested: a check that asks about the wrong versions would report a
 * clean registry no matter what KV actually holds.
 * @param index - an index document.
 * @param hosted - the package names this registry converts.
 * @returns one `[name, version]` pair per converted package.
 */
export function newestOf(index: unknown, hosted: ReadonlySet<string>): [string, string][] {
  const plugins = (index as { plugins?: unknown } | null | undefined)?.plugins
  if (!Array.isArray(plugins)) return []
  const newest: [string, string][] = []
  for (const plugin of plugins) {
    const entry = plugin as { name?: unknown; versions?: unknown }
    if (typeof entry.name !== 'string' || !hosted.has(entry.name)) continue
    if (!Array.isArray(entry.versions)) continue
    const highest = (entry.versions[0] as { version?: unknown } | undefined)?.version
    if (typeof highest !== 'string') continue
    newest.push([entry.name, highest])
  }
  return newest
}

/**
 * Whether one version's packument advertises this registry.
 * @param packument - the packument read from the registry.
 * @param version - the version to inspect.
 * @returns false when the version is absent or `dist.tarball` points elsewhere.
 */
export function advertises(packument: unknown, version: string): boolean {
  const versions = (packument as { versions?: Record<string, { dist?: { tarball?: unknown } }> } | null | undefined)?.versions
  const tarball = versions?.[version]?.dist?.tarball
  return typeof tarball === 'string' && tarball.startsWith(REGISTRY)
}

/**
 * Whether a converted packument still advertises the release asset instead of this registry.
 *
 * The check exists because of a specific, observed inconsistency rather than a hypothetical one. `dist.tarball` used to
 * point at the GitHub release asset, and a client writes that field into its lockfile verbatim, which pins an install to
 * the origin this registry exists to keep it off. Fixing the generator only helps once the packuments carrying the new
 * field reach KV, and the upload is the step that fails when the write quota runs out. Comparing version lists cannot
 * see that: both sides list the same versions, and only the URL inside them changed.
 *
 * Only packages this repository converts are checked. A plugin published to npm is proxied rather than converted, so its
 * packument is npmjs's own document and its upstream URL is correct.
 * @param index - the index being served.
 * @param hosted - the package names this registry converts.
 * @returns the names still pointing somewhere other than this registry.
 */
export async function misadvertised(index: unknown, hosted: ReadonlySet<string>): Promise<string[]> {
  const wrong: string[] = []
  for (const [name, version] of newestOf(index, hosted)) {
    const packument = await packumentOf(name)
    // An unreadable packument is reported as wrong: a registry that cannot answer is not one a client can install from,
    // and silence here would mean never retrying the upload.
    if (packument === undefined || !advertises(packument, version)) wrong.push(name)
  }
  return wrong
}

/**
 * Compare the generated index with the deployed one.
 * @param root - repository root.
 * @returns whether they differ.
 * @throws when the deployed index cannot be read.
 */
export async function changed(root?: string): Promise<boolean> {
  const local = await generate(root)
  const remote = await deployed(DEPLOYED)
  if (remote === undefined) throw new Error(`${DEPLOYED} could not be read`)
  if (moved(local, remote)) return true
  // The indexes agree, which proves the worker is current but not that its data is. The packuments are uploaded by a
  // later step that fails on its own, and a market whose packuments advertise an unreachable origin is the result.
  const wrong = await misadvertised(remote, await converted(root))
  if (wrong.length > 0) {
    console.log(`the registry advertises the wrong tarball origin for: ${wrong.join(', ')}`)
    return true
  }
  return false
}

/**
 * The packages this repository converts, which are the ones whose `dist.tarball` it controls.
 *
 * Read from the generated manifest rather than from the index: the index also lists plugins published to npm and plugins
 * installed from their repository, and neither is converted here.
 * @param root - repository root.
 * @returns the converted package names.
 */
async function converted(root?: string): Promise<ReadonlySet<string>> {
  const target = join(root ?? ROOT, 'dists', 'registry', 'manifest.json')
  let text: string
  try {
    text = await readFile(target, 'utf8')
  } catch {
    // No manifest means nothing was converted, which leaves nothing to check rather than a reason to fail.
    return new Set()
  }
  const manifest = JSON.parse(text) as { packages?: Record<string, unknown> }
  return new Set(Object.keys(manifest.packages ?? {}))
}

/**
 * Run as a workflow step.
 *
 * The verdict is written to a file, not carried by the exit code. Node also exits 1 on an uncaught exception, so a
 * crashed build and "the index moved" would be indistinguishable, and any other failure would read as "nothing to
 * publish" — the one wrong answer, because it silently skips a release.
 *
 * A failed check exits non-zero and publishes nothing. The tempting alternative — publish anyway, since the release
 * pipeline would run regardless — is worse than a stale index: a failed check usually means the data the index would be
 * built from was incomplete, so publishing would push a truncated index onto every client install. An index that is an
 * hour old serves the previous, correct versions; an index built from a half-read release list silently drops plugins.
 * @param target - file to write `true` or `false` to.
 */
async function main(target: string | undefined): Promise<void> {
  if (target === undefined) {
    console.error('usage: changed.ts <output-file>')
    process.exit(3)
  }
  let differs: boolean
  try {
    differs = await changed()
  } catch (error) {
    console.error(`::error title=Index check failed::${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
  await writeFile(target, differs ? 'true\n' : 'false\n', 'utf8')
  console.log(differs
    ? 'the index differs from the deployed one; the release will run'
    : 'the index matches the deployed one; nothing to publish')
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return entry.endsWith('changed.ts') || entry.endsWith('changed.js')
}

if (invokedDirectly()) await main(process.argv[2])
