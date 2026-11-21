/**
 * Read a plugin's display fields the way DSH reads them from an installed package.
 *
 * The index lists a localized title and description, plus an icon, and none of those live in the packument: they come
 * from the package's own files. `locale/<language>.json` carries `meta.title` and `meta.description`, and the icon is
 * resolved through the package `exports` map. Reading only the packument therefore produced a plain-string description
 * and no icon at all, which is why this module unpacks the one tarball the index needs.
 *
 * Nothing is evaluated: only JSON and image bytes are read.
 */
import { createHash } from 'node:crypto'
import { posix } from 'node:path'

/** Display fields of one plugin, in the shape format 1 accepts. */
export interface Display {
  readonly title?: unknown
  readonly description?: unknown
  readonly icon?: string
  readonly author?: string
  readonly homepage?: string
  readonly repository?: unknown
  readonly metadata?: unknown
}

/** One locale file's display fields. */
interface Fields {
  title?: string
  description?: string
}

/** Language ids, lowercase once read. */
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/u

/** Largest icon embedded as a data URL; anything larger is dropped rather than blowing up the index. */
const MAX_ICON_BYTES = 256 * 1024

/** Image extensions the format accepts, with the media type each maps to. */
const ICON_TYPES: ReadonlyMap<string, string> = new Map([
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
])

/**
 * Read a non-empty string, or undefined.
 * @param value - candidate.
 * @returns the trimmed value when it is a usable string.
 */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Parse one locale file's `meta` fields.
 * @param raw - the file contents.
 * @returns the fields, empty when the file declares no `meta`.
 */
export function localeFields(raw: string): Fields {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const meta: unknown = (parsed as { meta?: unknown }).meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {}
  const fields: Fields = {}
  for (const key of ['title', 'description'] as const) {
    const value = (meta as Record<string, unknown>)[key]
    if (value === undefined) continue
    const usable = text(value)
    // A declared-but-unusable field is ignored rather than fatal: the fallback still describes the plugin.
    if (usable !== undefined) fields[key] = usable
  }
  return fields
}

/**
 * Combine locale values with a manifest fallback.
 *
 * The format requires English text, so translations without an English value are dropped. A single English value stays
 * a plain string, which is what a client shows when it needs no translation.
 * @param field - which field to combine.
 * @param locales - fields by lowercase language id.
 * @param fallback - manifest text to use when no locale file supplies English.
 * @returns the localized value, or undefined.
 */
export function localized(
  field: keyof Fields,
  locales: ReadonlyMap<string, Fields>,
  fallback: string | undefined,
): unknown {
  const translated = [...locales].flatMap(([language, fields]) => {
    const value = fields[field]
    return value === undefined ? [] : [[language, value] as const]
  })
  if (translated.length === 0) return fallback
  const english = locales.get('en')?.[field] ?? fallback
  if (english === undefined) return undefined
  if (translated.length === 1 && translated[0]?.[0] === 'en') return english
  return Object.fromEntries([['en', english], ...translated])
}

/**
 * Turn icon bytes into the value the index records.
 *
 * A data URL keeps the index self-contained, which matters because the index ships inside the Worker script and cannot
 * reference a file beside it.
 * @param bytes - the image bytes.
 * @param extension - the file extension, with its dot.
 * @returns the data URL, or undefined when the icon is unsupported or too large.
 */
export function iconOf(bytes: Uint8Array, extension: string): string | undefined {
  const type = ICON_TYPES.get(extension.toLowerCase())
  if (type === undefined || bytes.byteLength > MAX_ICON_BYTES) return undefined
  return `data:${type};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * Pick the icon path a package declares.
 *
 * An `exports` map is honoured when it exposes `./icon`; otherwise the conventional files are tried in order. The
 * harness generator resolves through `resolve.exports`, but for the two shapes that matter here, a literal target and a
 * wildcard over the locale directory, a direct lookup agrees with it.
 * @param exports - the manifest `exports` field.
 * @returns the icon path inside the package, or undefined.
 */
export function iconPath(exports: unknown): string | undefined {
  if (typeof exports === 'object' && exports !== null && !Array.isArray(exports)) {
    const icon = (exports as Record<string, unknown>)['./icon']
    if (typeof icon === 'string') return posix.normalize(icon).replace(/^\.\//u, '')
    if (typeof icon === 'object' && icon !== null && !Array.isArray(icon)) {
      const target = (icon as Record<string, unknown>)['default']
      if (typeof target === 'string') return posix.normalize(target).replace(/^\.\//u, '')
    }
  }
  return undefined
}

/**
 * The locale directory a package declares, if any.
 * @param exports - the manifest `exports` field.
 * @returns the directory path inside the package, or undefined.
 */
export function localeDirectory(exports: unknown): string | undefined {
  if (typeof exports === 'object' && exports !== null && !Array.isArray(exports)) {
    const locale = (exports as Record<string, unknown>)['./locale/*.json']
    const target = typeof locale === 'string' ? locale : undefined
    if (target !== undefined) return posix.dirname(posix.normalize(target)).replace(/^\.\//u, '')
  }
  return undefined
}

/**
 * Build display fields from a package's files.
 * @param entries - file contents by path inside the package.
 * @param options - manifest fallbacks and the package's `exports`.
 * @returns the display fields.
 */
export function displayFrom(
  entries: ReadonlyMap<string, Uint8Array>,
  options: {
    readonly exports?: unknown
    readonly name?: string
    readonly description?: string
    readonly homepage?: string
    readonly author?: unknown
    readonly repository?: unknown
    readonly keywords?: readonly string[]
  },
): Display {
  const locales = new Map<string, Fields>()
  const directory = localeDirectory(options.exports) ?? 'locale'
  for (const [path, bytes] of entries) {
    if (!path.startsWith(`${directory}/`) || !path.endsWith('.json')) continue
    const language = path.slice(directory.length + 1, -'.json'.length).toLowerCase()
    if (!LANGUAGE_ID.test(language) || locales.has(language)) continue
    try {
      locales.set(language, localeFields(Buffer.from(bytes).toString('utf8')))
    } catch {
      // An unparseable locale file says nothing about the plugin; the manifest fallback still applies.
    }
  }
  // A plugin with no locale file is titled by its package name, which is what a client lists it as.
  const title = localized('title', locales, text(options.name))
  const description = localized('description', locales, text(options.description))
  const icon = iconFile(entries, options.exports)
  const author = person(options.author)
  // A homepage that is not http(s) is dropped rather than emitted: the format accepts only a link a client can open.
  const homepage = text(options.homepage)
  const linkable = homepage !== undefined && URL.canParse(homepage) && ['https:', 'http:'].includes(new URL(homepage).protocol)
  return {
    ...title === undefined ? {} : { title },
    ...description === undefined ? {} : { description },
    ...icon === undefined ? {} : { icon },
    ...author === undefined ? {} : { author },
    ...linkable ? { homepage } : {},
    ...options.repository === undefined ? {} : { repository: options.repository },
    ...options.keywords === undefined || options.keywords.length === 0 ? {} : { metadata: { keywords: options.keywords } },
  }
}

/**
 * Read an npm person field down to a name.
 *
 * npm writes `Name <email> (url)`; only the name is published, so no address spreads into the index.
 * @param value - a string, or an object with a `name`.
 * @returns the name, or undefined.
 */
export function person(value: unknown): string | undefined {
  const raw = typeof value === 'object' && value !== null ? (value as { name?: unknown }).name : value
  if (typeof raw !== 'string') return undefined
  return text(raw.replace(/<[^>]*>|\([^)]*\)/gu, '').trim())
}

/**
 * Read the declared icon, falling back to the conventional names.
 * @param entries - file contents by path.
 * @param exports - the manifest `exports` field.
 * @returns the data URL, or undefined when there is no usable icon.
 */
function iconFile(entries: ReadonlyMap<string, Uint8Array>, exports: unknown): string | undefined {
  const declared = iconPath(exports)
  const candidates = [
    ...declared === undefined ? [] : [declared],
    ...[...ICON_TYPES.keys()].map(extension => `icon${extension}`),
  ]
  for (const candidate of candidates) {
    const bytes = entries.get(candidate)
    if (bytes === undefined) continue
    const icon = iconOf(bytes, posix.extname(candidate))
    if (icon !== undefined) return icon
  }
  return undefined
}

/**
 * A content hash for an icon, for diagnostics.
 * @param bytes - the image bytes.
 * @returns the first 16 hex digits of its SHA-256.
 */
export function iconDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}
