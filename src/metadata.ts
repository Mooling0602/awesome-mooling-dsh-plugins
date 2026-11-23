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

/**
 * The shape of a plugin id.
 *
 * An id becomes a directory name, so it carries the restrictions a path segment does: lowercase, digits and hyphens, and
 * a letter first so a name cannot look like a number or begin with a hyphen. Uppercase is excluded because macOS and
 * Windows compare file names case-insensitively, where `dsh-Foo` and `dsh-foo` are one directory, and because npm has
 * refused new package names with capitals since 2017.
 *
 * Two shapes that pass here are refused later by {@link shardOf}, which needs the first two letters of the name without
 * its `dsh-` prefix and therefore rejects `a--b` or `dsh-x-`. Leaving that to `shardOf` keeps one rule in one place; the
 * id only has to be a name a directory can carry.
 */
const ID = /^[a-z][a-z0-9-]*$/u

/**
 * Ids a plugin may not take, though they are otherwise well-formed.
 *
 * Each of these is published on npm by another project: `dsh` is a shell written in JavaScript, while `dsh-plugin` and
 * `dsh-plugins` are other tools for browsing and installing DeepSeek Harness plugins. A plugin here names itself after
 * what it is rather than after the registry, so an id spelled like one of these would claim a name this project does not
 * own, and readers would arrive expecting a different plugin.
 *
 * Only the id is held back. The `package` field names something published elsewhere, and whether that name is free is
 * settled by the registry it is published to, not by this list.
 */
const RESERVED_IDS: readonly string[] = ['dsh', 'dsh-plugin', 'dsh-plugins']

/**
 * The length limit shared by a plugin id and an npm package name.
 *
 * 214 is npm's own ceiling and the figure DSH uses in `dsh-plugin-manager`, so the two agree on where a name becomes too
 * long. It is also well under the 255 bytes a file name gets on the common filesystems, which matters because an id is
 * used as a directory name.
 */
const NAME_MAX_LENGTH = 214

/**
 * The shape of an npm package name, copied from DSH rather than re-derived.
 *
 * This is `/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/` in `dsh-plugin-manager`'s `install-spec.ts`, where it
 * guards what may be installed. Keeping the same expression means a `plugin.yml` cannot pass here and then fail to
 * install, and it allows the scoped names and underscores npm itself allows even though no plugin in this repository has
 * needed either yet.
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

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
 * The shard directory a plugin directory belongs in.
 *
 * A shard is the first two letters of the id after its `dsh-` prefix, and it is written the same way the plugin
 * directory is: `dsh-mloader` lives in `dsh-ml` and `mloader` lives in `ml`. The two spellings never mix, so
 * `ot/dsh-other` is rejected even though `ot` is the right two letters, because the plugin directory spells its prefix
 * and the shard does not.
 *
 * Consistency is the point. Listing one shard directory must find every plugin whose id starts the same way, and a
 * plugin must not be reachable under two spellings at once; both hold only while the shard and the plugin directory
 * agree on whether the `dsh-` prefix is written out.
 * @param id - the plugin directory name, for example `dsh-mloader` or `mloader`.
 * @returns the one shard directory name that matches a plugin directory of that spelling.
 * @throws when the id has no two letters to build a shard from.
 */
export function shardOf(id: string): string {
  const prefixed = id.startsWith('dsh-')
  const short = prefixed ? id.slice('dsh-'.length) : id
  if (!/^[a-z0-9]{2}/u.test(short)) throw new Error(`cannot derive a shard from ${JSON.stringify(id)}`)
  const name = short.slice(0, 2)
  return prefixed ? `dsh-${name}` : name
}

/**
 * Whether a shard directory name is the one a plugin directory belongs in.
 * @param shard - the directory name holding the plugin directory.
 * @param id - the plugin directory name.
 * @returns true when the shard spells the `dsh-` prefix the same way the plugin directory does and holds its letters.
 * @throws when the id has no two letters to build a shard from.
 */
export function inShard(shard: string, id: string): boolean {
  return shardOf(id) === shard
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
  // The id names the plugin's directory, so an unusable one would be unreachable rather than merely odd. Checking it here
  // rather than leaving it to `shardOf` is what turns a confusing "cannot derive a shard" into a message about the file.
  const id = values.get('id') as string
  if (id.length > NAME_MAX_LENGTH) {
    throw new Error(`${file}: id is ${id.length} characters; use at most ${NAME_MAX_LENGTH}`)
  }
  if (!ID.test(id)) {
    throw new Error(
      `${file}: id ${JSON.stringify(id)} must be lowercase letters, digits and hyphens, starting with a letter, for example "dsh-my-plugin"`,
    )
  }
  if (RESERVED_IDS.includes(id)) {
    throw new Error(
      `${file}: id ${JSON.stringify(id)} is reserved: another project publishes that name on npm, so pick a name that describes the plugin itself, for example "dsh-my-plugin"`,
    )
  }
  // The package is what a client installs, so it has to satisfy npm's own rule; a name npm refuses would be published as
  // a packument nothing could install.
  const packageName = values.get('package') as string
  if (packageName.length > NAME_MAX_LENGTH) {
    throw new Error(`${file}: package is ${packageName.length} characters; use at most ${NAME_MAX_LENGTH}`)
  }
  if (!PACKAGE_NAME.test(packageName)) {
    throw new Error(
      `${file}: package ${JSON.stringify(packageName)} is not a valid npm package name, for example "dsh-my-plugin" or "@scope/dsh-my-plugin"`,
    )
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
    id,
    package: packageName,
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
  if (!inShard(shard, plugin.id)) {
    throw new Error(`${file}: ${JSON.stringify(plugin.id)} belongs in ${JSON.stringify(shardOf(plugin.id))}, not ${JSON.stringify(shard)}`)
  }
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
