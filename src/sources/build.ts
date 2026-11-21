#!/usr/bin/env node
/**
 * Write `dists/plugins.txt` from the hand-maintained metadata under `plugins/by-name/`.
 *
 * Run from the repository root:
 *
 * ```sh
 * node src/sources/build.ts
 * node src/sources/build.ts --check
 * ```
 *
 * `--check` exits non-zero when the file on disk disagrees with what the metadata produces, so CI can fail on a stale
 * artifact instead of silently shipping one.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPlugins } from '../metadata.ts'
import { needsConversion, renderSources } from '../sources.ts'

/** Repository root, one level above `src/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the generated source list lives. */
export const OUTPUT = join(ROOT, 'dists', 'plugins.txt')

/**
 * Build the source list text from the metadata in the repository.
 * @param root - repository root to read `plugins/by-name/` from.
 * @returns the file contents.
 */
export async function buildSources(root: string = ROOT): Promise<string> {
  return renderSources(await readPlugins(root))
}

/**
 * Write the source list to `dists/plugins.txt`.
 * @param root - repository root.
 * @returns the plugins that were written.
 */
export async function writeSources(root: string = ROOT): Promise<ReturnType<typeof readPlugins>> {
  const plugins = await readPlugins(root)
  const target = join(root, 'dists', 'plugins.txt')
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, renderSources(plugins), 'utf8')
  return plugins
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

if (invokedDirectly()) {
  const check = process.argv.includes('--check')
  const plugins = await readPlugins(ROOT)
  const expected = renderSources(plugins)
  if (check) {
    let actual: string
    try {
      actual = await readFile(OUTPUT, 'utf8')
    } catch {
      console.error(`dists/plugins.txt is missing; run \`node src/sources/build.ts\``)
      process.exit(1)
    }
    if (actual !== expected) {
      console.error('dists/plugins.txt is stale; run `node src/sources/build.ts`')
      process.exit(1)
    }
    console.log(`dists/plugins.txt is up to date: ${plugins.length} plugin(s)`)
  } else {
    await mkdir(dirname(OUTPUT), { recursive: true })
    await writeFile(OUTPUT, expected, 'utf8')
    const converted = plugins.filter(plugin => needsConversion(plugin)).map(plugin => plugin.id)
    console.log(`wrote dists/plugins.txt: ${plugins.length} plugin(s)`)
    if (converted.length > 0) console.log(`  converted through the CF Workers registry: ${converted.join(', ')}`)
  }
}
