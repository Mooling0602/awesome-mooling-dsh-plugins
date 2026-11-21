/**
 * Read the hand-maintained metadata under `plugins/by-name/`.
 *
 * Each plugin is one directory `<shard>/<name>/plugin.yml`. Only `id` and `repo` reach the index; `package`, `source`
 * and `dispatch-type` describe how the plugin is delivered and are read by the registry builder instead. `readme`
 * points the README generator at that plugin's own documentation in each supported language.
 *
 * The file is parsed as real YAML so `readme` can be a nested mapping; the scalar fields keep the strict `key: value`
 * shape the rest of this module documents.
 */

import { isMap, isScalar, parseDocument } from 'yaml'

/** The fields `plugin.yml` carries, in the order they appear. */
export const FIELDS = ['id', 'package', 'source', 'repo', 'readme', 'dispatch-type'] as const

/** Languages a plugin may point its own README at; the generator links only these. */
export const LANGUAGES = ['zh_CN', 'en_US'] as const

/** A language `plugin.yml` may name in its `readme` mapping. */
export type Language = (typeof LANGUAGES)[number]

/** Repository-relative path or absolute URL of one plugin's own README, per language. */
export type Readme = Readonly<Partial<Record<Language, string>>>

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
  /** Where each language's README for this plugin lives. */
  readonly readme: Readme
  readonly dispatchType: DispatchType
  /** Directory name of the shard, derived from the plugin id. */
  readonly shard: string
  /** Repository-relative path of the file this plugin was read from. */
  readonly file: string
}

const SOURCES: readonly Source[] = ['npm', 'github']
const DISPATCH_TYPES: readonly DispatchType[] = ['npmjs', 'tarball', 'source']

/** The one field whose value is a nested mapping rather than a scalar. */
const NESTED = 'readme'

/** Whether a value is a non-empty string. */
function filled(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Read one `readme` mapping.
 * @param node - the YAML value of the `readme` field.
 * @param at - `file:line` of the `readme` key, used in error messages.
 * @returns the language-to-path mapping, in the order the file lists it.
 * @throws when the value is not a mapping, a language is unsupported or repeated, or a path is missing.
 */
function parseReadme(node: unknown, at: string): Readme {
  if (!isMap(node)) {
    throw new Error(`${at}: field "readme" must map a language to that language's README, for example zh_CN: README.zh.md`)
  }
  const readme: Partial<Record<Language, string>> = {}
  for (const pair of node.items) {
    const key = pair.key
    if (!isScalar(key) || typeof key.value !== 'string') {
      throw new Error(`${at}: readme must be keyed by a language id, one of ${LANGUAGES.join(', ')}`)
    }
    const language = key.value
    if (!(LANGUAGES as readonly string[]).includes(language)) {
      throw new Error(`${at}: readme language ${JSON.stringify(language)} is not supported yet; use one of ${LANGUAGES.join(', ')}`)
    }
    if (Object.hasOwn(readme, language)) throw new Error(`${at}: duplicate readme language ${JSON.stringify(language)}`)
    const value = pair.value
    if (!isScalar(value) || !filled(value.value)) {
      throw new Error(`${at}: readme ${JSON.stringify(language)} must be a repository-relative path or an absolute URL`)
    }
    readme[language as Language] = value.value
  }
  if (Object.keys(readme).length === 0) throw new Error(`${at}: field "readme" is empty`)
  return readme
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
 * @throws when the YAML is malformed, a field is missing, duplicated, unknown or empty, or the fields are out of order.
 */
export function parsePluginYml(text: string, file: string): Omit<Plugin, 'shard' | 'file'> {
  const document = parseDocument(text, { uniqueKeys: false })
  const first = document.errors[0]
  if (first !== undefined) {
    const line = first.linePos?.[0]?.line
    throw new Error(`${file}${line === undefined ? '' : `:${line}`}: ${first.message.split('\n')[0]}`)
  }
  if (!isMap(document.contents)) {
    throw new Error(`${file}: expected a mapping carrying ${FIELDS.join(', ')}`)
  }
  const values = new Map<string, string | Readme>()
  let previous: (typeof FIELDS)[number] | undefined
  let previousLine = 1
  for (const pair of document.contents.items) {
    const keyNode = pair.key
    if (!isScalar(keyNode) || typeof keyNode.value !== 'string') {
      throw new Error(`${file}: expected a field name, got ${JSON.stringify(keyNode?.toJSON?.() ?? keyNode)}`)
    }
    const key = keyNode.value
    const line = lineOf(text, keyNode)
    const at = `${file}:${line}`
    const field = FIELDS.find(candidate => candidate === key)
    if (field === undefined) throw new Error(`${at}: unknown field ${JSON.stringify(key)}; plugin.yml may only carry ${FIELDS.join(', ')}`)
    if (values.has(field)) throw new Error(`${at}: duplicate field ${JSON.stringify(field)}`)
    if (previous !== undefined && FIELDS.indexOf(field) <= FIELDS.indexOf(previous)) {
      throw new Error(`${file}:${previousLine}: field ${JSON.stringify(previous)} must come after ${JSON.stringify(field)}; expected ${FIELDS.join(', ')}`)
    }
    if (field === NESTED) {
      values.set(field, parseReadme(pair.value, at))
    } else {
      const value = pair.value
      if (!isScalar(value)) throw new Error(`${at}: field ${JSON.stringify(field)} must be a single value`)
      const scalar = value.value
      if (typeof scalar !== 'string' && typeof scalar !== 'number' && typeof scalar !== 'boolean') {
        throw new Error(`${at}: field ${JSON.stringify(field)} is empty`)
      }
      const scalarText = String(scalar)
      if (!filled(scalarText)) throw new Error(`${at}: field ${JSON.stringify(field)} is empty`)
      values.set(field, scalarText)
    }
    previous = field
    previousLine = line
  }
  const missing = FIELDS.filter(field => !values.has(field))
  if (missing.length > 0) throw new Error(`${file}: missing field(s) ${missing.join(', ')}`)
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
    readme: values.get(NESTED) as Readme,
    dispatchType,
  }
}

/**
 * Find the 1-based line a YAML node starts on.
 * @param text - the whole document, so offsets can be counted into lines.
 * @param node - the node whose `range[0]` is an offset into `text`.
 * @returns the line number, or 1 when the node carries no range.
 */
function lineOf(text: string, node: { readonly range?: readonly [number, number, number] | null }): number {
  const offset = node.range?.[0] ?? 0
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') line += 1
  }
  return line
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
