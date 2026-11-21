/**
 * Make sure the index the worker imports exists, without rebuilding it when it does.
 *
 * The worker compiles `dists/index.json` in, so the bundler and the type checker need the file before they run, while
 * `dists/` is a build tree and is not committed. CI always builds the index explicitly and never reaches this module;
 * it exists so that `pnpm check` and `pnpm test` work on a checkout that has not built one yet.
 *
 * The index is generated from the packuments that `pnpm registry` writes, because a tarball-form plugin's versions can
 * only be read from them. That means this cannot bootstrap a completely empty checkout: it needs `pnpm registry` to have
 * run at least once. It says so instead of failing with a stack trace.
 */
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIndex } from './build.ts'

/** The file the worker imports. */
export const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dists', 'index.json')

/** The directory `pnpm registry` writes. */
export const PACKUMENTS = resolve(dirname(INDEX), 'registry', 'packuments')

/**
 * Whether a path exists.
 * @param path - path to test.
 * @returns true when it is there.
 */
async function present(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Generate the index when it is missing.
 * @returns whether it had to be generated.
 * @throws when the packuments the build needs are absent.
 */
export async function ensureIndex(): Promise<boolean> {
  if (await present(INDEX)) return false
  if (!await present(PACKUMENTS)) {
    throw new Error(`dists/index.json is missing and cannot be generated: ${PACKUMENTS} does not exist yet. Run \`pnpm registry\` first, which needs GITHUB_TOKEN set.`)
  }
  await writeIndex()
  return true
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

if (invokedDirectly()) {
  const generated = await ensureIndex()
  console.log(generated ? 'generated dists/index.json' : 'dists/index.json is present')
}
