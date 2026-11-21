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
import { writeFile } from 'node:fs/promises'

import { generate } from './build.ts'

/** Where the deployed index is served from. */
const DEPLOYED = 'https://mynpm.staringplanet.top/dsh-plugins/index.json'

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
 * Compare the generated index with the deployed one.
 * @param root - repository root.
 * @returns whether they differ.
 * @throws when the deployed index cannot be read.
 */
export async function changed(root?: string): Promise<boolean> {
  const local = await generate(root)
  const remote = await deployed(DEPLOYED)
  if (remote === undefined) throw new Error(`${DEPLOYED} could not be read`)
  return moved(local, remote)
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
