/**
 * Read the hand-maintained metadata under `plugins/by-name/`.
 *
 * Each plugin is one directory `<shard>/<name>/plugin.yml`. Only `id` and `repo` reach the index; `package`, `source`
 * and `dispatch-type` describe how the plugin is delivered and are read by the registry builder instead.
 */

/** The fields `plugin.yml` carries, in the order they appear. */
export const FIELDS = ['id', 'package', 'source', 'repo', 'dispatch-type'] as const

/** How a plugin's bytes reach a consumer. */
export type DispatchType = 'npmjs' | 'tarball' | 'source'

/** How the plugin is published. */
export type Source = 'npm' | 'github'

/** One plugin as declared on disk. */
export interface Plugin {
  /** Plugin identifier; also the index entry name. */
  readonly id: string
  /** npm package name the plugin installs as. */
  readonly package: string
  readonly source: Source
  /** Repository the plugin lives in; also its index entry source. */
  readonly repo: string
  readonly dispatchType: DispatchType
  /** Directory name of the shard, derived from the plugin id. */
  readonly shard: string
  /** Repository-relative path of the file this plugin was read from. */
  readonly file: string
}

const SOURCES: readonly Source[] = ['npm', 'github']
const DISPATCH_TYPES: readonly DispatchType[] = ['npmjs', 'tarball', 'source']

/** Whether a value is a non-empty string. */
function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Derive the shard directory for a plugin id.
 * @param id - the plugin identifier, for example `dsh-mloader`.
 * @returns `dsh-` plus the first two letters of the id without its `dsh-` prefix.
 * @throws when the id has no two letters to build a shard from.
 */
export function shardOf(id: string): string {
  const short = id.startsWith('dsh-') ? id.slice('dsh-'.length) : id
  if (!/^[a-z0-9]{2}/u.test(short)) throw new Error(`cannot derive a shard from ${JSON.stringify(id)}`)
  return `dsh-${short.slice(0, 2)}`
}

/**
 * Parse one `plugin.yml`.
 * @param text - the file contents.
 * @param file - repository-relative path, used in error messages.
 * @returns the parsed fields.
 * @throws when a line is malformed, a field is missing, duplicated, unknown or empty, or the fields are out of order.
 */
export function parsePluginYml(text: string, file: string): Omit<Plugin, 'shard' | 'file'> {
  const values = new Map<string, string>()
  const order: string[] = []
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = `${file}:${index + 1}`
    const colon = line.indexOf(':')
    if (colon === -1) throw new Error(`${at}: expected "key: value", got ${JSON.stringify(line)}`)
    const key = line.slice(0, colon).trim()
    let value = line.slice(colon + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    const field = FIELDS.find(candidate => candidate === key)
    if (field === undefined) throw new Error(`${at}: unknown field ${JSON.stringify(key)}; plugin.yml may only carry ${FIELDS.join(', ')}`)
    if (values.has(field)) throw new Error(`${at}: duplicate field ${JSON.stringify(field)}`)
    if (!filled(value)) throw new Error(`${at}: field ${JSON.stringify(field)} is empty`)
    values.set(field, value)
    order.push(field)
  }
  const missing = FIELDS.filter(field => !values.has(field))
  if (missing.length > 0) throw new Error(`${file}: missing field(s) ${missing.join(', ')}`)
  for (const [index, field] of order.entries()) {
    const expected = FIELDS[index]
    if (field !== expected) throw new Error(`${file}: field ${JSON.stringify(field)} must come after ${JSON.stringify(expected)}; expected ${FIELDS.join(', ')}`)
  }
  const source = values.get('source') as Source
  if (!SOURCES.includes(source)) {
    throw new Error(`${file}: unsupported custom git hosting service ${JSON.stringify(source)}: source must be one of ${SOURCES.join(', ')}`)
  }
  const dispatchType = values.get('dispatch-type') as DispatchType
  if (!DISPATCH_TYPES.includes(dispatchType)) {
    throw new Error(`${file}: dispatch-type must be one of ${DISPATCH_TYPES.join(', ')}, got ${JSON.stringify(dispatchType)}`)
  }
  if (source === 'npm' && dispatchType !== 'npmjs') {
    throw new Error(
      `${file}: source "npm" requires dispatch-type "npmjs", got ${JSON.stringify(dispatchType)}; third-party npm mirrors are not supported, only the CF Workers registry this project publishes`,
    )
  }
  return {
    id: values.get('id') as string,
    package: values.get('package') as string,
    source,
    repo: values.get('repo') as string,
    dispatchType,
  }
}

/**
 * Validate a parsed plugin against its location on disk.
 * @param plugin - the parsed fields.
 * @param directory - the directory name holding `plugin.yml`.
 * @param shard - the shard directory name holding the plugin directory.
 * @param file - repository-relative path, used in error messages.
 * @returns the plugin with its shard and file recorded.
 * @throws when the directory name or the shard disagrees with the plugin id.
 */
export function checkPluginLocation(
  plugin: Omit<Plugin, 'shard' | 'file'>,
  directory: string,
  shard: string,
  file: string,
): Plugin {
  if (plugin.id !== directory) throw new Error(`${file}: id ${JSON.stringify(plugin.id)} must match its directory ${JSON.stringify(directory)}`)
  const expected = shardOf(plugin.id)
  if (shard !== expected) throw new Error(`${file}: ${JSON.stringify(plugin.id)} belongs in ${JSON.stringify(expected)}, not ${JSON.stringify(shard)}`)
  return { ...plugin, shard, file }
}

/**
 * Read every plugin under `plugins/by-name/`.
 * @param root - repository root directory.
 * @returns the plugins sorted by id.
 * @throws when the tree is malformed or two plugins share an id.
 */
export async function readPlugins(root: string): Promise<Plugin[]> {
  const { readdir, readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const base = join(root, 'plugins', 'by-name')
  const plugins: Plugin[] = []
  for (const shard of await readdir(base)) {
    const shardPath = join(base, shard)
    for (const directory of await readdir(shardPath)) {
      const file = join(shardPath, directory, 'plugin.yml')
      const text = await readFile(file, 'utf8')
      plugins.push(checkPluginLocation(parsePluginYml(text, file), directory, shard, file))
    }
  }
  const byId = new Map<string, Plugin>()
  for (const plugin of plugins) {
    const previous = byId.get(plugin.id)
    if (previous !== undefined) throw new Error(`duplicate plugin ${JSON.stringify(plugin.id)}: ${previous.file} and ${plugin.file}`)
    byId.set(plugin.id, plugin)
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id))
}
