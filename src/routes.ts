/**
 * Route one request for the read-only npm registry.
 *
 * The Worker serves packuments from KV and hands tarballs out by redirecting to the release asset, because GitHub
 * signs and expires the real download URL. Everything else is proxied to the public registry, so a client that asks
 * for a dependency the registry does not host still installs. Routing is pure so it can be tested without KV.
 */

/**
 * The path the market index is served from.
 *
 * It is not a package, so it is resolved before any name is parsed: routing it as one would proxy it to the public
 * registry, where the name does not exist, and the index would 404 instead of being served. It is also a plain KV key,
 * so publishing a new index is one write and needs no deploy.
 */
export const INDEX_PATH = '/dsh-plugins/index.json'

/**
 * The KV key the index is stored under.
 *
 * A package name cannot collide with it, because no valid npm name starts with two underscores, so the same namespace
 * safely holds the index and every packument.
 */
export const INDEX_KEY = '__index__'

/**
 * The KV key listing every hosted package name.
 *
 * The worker reads it to decide whether an unhosted package may still be proxied, which is only true when a hosted
 * package depends on it. Without the list that decision would need a KV `list` on every request, because a KV key is
 * otherwise indistinguishable from the package it describes.
 */
export const HOSTED_KEY = '__hosted__'

/** What the Worker should do with a request. */
export type Route =
  | { readonly kind: 'packument'; readonly name: string }
  | { readonly kind: 'download'; readonly name: string; readonly version: string; readonly tarball: string }
  | { readonly kind: 'proxy' }
  | { readonly kind: 'not-found'; readonly reason: string }

/** A precomputed tarball location, as stored alongside the packument. */
export interface TarballEntry {
  readonly tarball: string
}

/** Everything the registry serves for one package. */
export interface RegistryEntry {
  readonly packument: unknown
  readonly tarballs: Readonly<Record<string, TarballEntry>>
}

/** The shape read out of KV. */
export interface Lookup {
  /** The package's registry entry, when the registry hosts it. */
  readonly entry: RegistryEntry | undefined
}

/** Percent-decode one path segment, tolerating malformed escapes. */
function decode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** Split a path into its non-empty segments. */
function segments(pathname: string): string[] {
  return pathname.split('/').filter(segment => segment !== '')
}

/**
 * Find the package name a path addresses.
 *
 * npm names are either `name` or `@scope/name`, so a scoped name spans two path segments. The name is returned with its
 * path prefix dropped, which keeps `/dsh-x` and `/dsh-x/-/dsh-x-1.0.0.tgz` uniformly addressable.
 *
 * A client may encode the slash of a scoped name, so `@scope%2Fname` arrives as one segment. Both spellings have to
 * resolve to the same package, because a caller that only recognised the literal form would treat the encoded one as
 * "no package" and let it through whatever check it applies to named packages. That asymmetry is a way around an
 * allow-list, so the encoded form is decoded before the name is split.
 * @param parts - the non-empty path segments.
 * @returns the package name and the number of segments it occupies, or `undefined` when the path holds no name.
 */
export function packageOf(parts: readonly string[]): { name: string; consumed: number } | undefined {
  const first = parts[0]
  if (first === undefined) return undefined
  const decoded = decode(first)
  if (!decoded.startsWith('@')) return { name: decoded, consumed: 1 }
  // `@scope%2Fname` carries the slash inside the segment; `@scope/name` splits it across two.
  const encoded = decoded.indexOf('/')
  if (encoded !== -1) {
    const name = decoded.slice(encoded + 1)
    return name === '' ? undefined : { name: decoded, consumed: 1 }
  }
  const second = parts[1]
  if (second === undefined) return undefined
  return { name: `${decoded}/${decode(second)}`, consumed: 2 }
}

/**
 * Decide what to do with a request.
 * @param url - the request URL.
 * @param lookup - reads the registry entry for a package name.
 * @returns the action to take.
 */
export function route(url: URL, lookup: (name: string) => RegistryEntry | undefined): Route {
  const parts = segments(url.pathname)
  const found = packageOf(parts)
  if (found === undefined) return { kind: 'not-found', reason: 'the path names no package' }
  const { name, consumed } = found
  const rest = parts.slice(consumed)

  // GET /<name> — the packument a client resolves versions from.
  if (rest.length === 0) {
    const entry = lookup(name)
    if (entry === undefined) return { kind: 'proxy' }
    return { kind: 'packument', name }
  }

  // GET /<name>/-/<file>.tgz — the tarball itself.
  if (rest.length === 2 && rest[0] === '-') {
    const file = decode(rest[1] as string)
    const entry = lookup(name)
    if (entry === undefined) return { kind: 'proxy' }
    const version = versionOfAsset(file, name)
    if (version === undefined) return { kind: 'not-found', reason: `${JSON.stringify(file)} does not name a tarball of ${name}` }
    const tarball = entry.tarballs[version]
    if (tarball === undefined) return { kind: 'not-found', reason: `${name} has no version ${JSON.stringify(version)}` }
    return { kind: 'download', name, version, tarball: tarball.tarball }
  }

  // Everything else — dist-tags, audit, search — belongs to the public registry.
  return { kind: 'proxy' }
}

/**
 * Read the version a tarball file name encodes.
 * @param file - the asset file name, `<base>-<version>.tgz`.
 * @param name - the package name the file must belong to; a scope is not part of the asset name.
 * @returns the version, or `undefined` when the file is not this package's tarball.
 */
export function versionOfAsset(file: string, name: string): string | undefined {
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const prefix = `${base}-`
  if (!file.startsWith(prefix) || !file.endsWith('.tgz')) return undefined
  const version = file.slice(prefix.length, -'.tgz'.length)
  return version === '' ? undefined : version
}
