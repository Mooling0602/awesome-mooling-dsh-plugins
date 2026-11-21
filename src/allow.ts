/**
 * Decide whether a package may be proxied to the upstream registry.
 *
 * The worker hosts a handful of packages and has to resolve their dependencies from npm, so some proxying is required.
 * Proxying everything, however, turns the domain into a free public npm mirror: anyone who points a client at it can
 * install any package through it, on this account's quota.
 *
 * So a package is proxied only when it is reachable from a hosted package's dependency graph. The graph is walked lazily
 * and the answer is remembered per package in KV, because the walk costs an upstream request per package and an install
 * would otherwise pay it again on every request.
 *
 * The walk cannot be done eagerly at build time: a hosted package's dependency can depend on another package whose
 * dependencies are only knowable by asking npm, and pinning that closure into a checked-in file would go stale as soon as
 * any dependency published a new version.
 */

/** KV prefix marking a package as allowed to be proxied. Distinct from package records, which are bare names. */
export const ALLOW_PREFIX = '__allow__/'

/** Prefix marking a package as refused, so a denial is remembered as well as a grant. */
export const DENY_PREFIX = '__deny__/'

/** The fields a package's own manifest declares as dependencies. All of them have to be resolvable for an install. */
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const

/** How many packages one walk may visit. A pathological graph must not exhaust the request budget. */
const WALK_LIMIT = 32

/**
 * How long a refusal is remembered.
 *
 * A grant is kept for good, because the dependency graph only grows: a package that is reachable now stays reachable.
 * A refusal has to expire, because the reason it was refused can change — a hosted plugin may start depending on the
 * package, and a permanent denial would then break its install with no way to recover except clearing KV by hand.
 */
const DENY_TTL_SECONDS = 60 * 60 * 24

/** The subset of a packument this module reads. */
export interface Resolved {
  readonly 'dist-tags'?: { readonly latest?: string }
  readonly versions?: Readonly<Record<string, { readonly [field: string]: unknown }>>
}

/**
 * Read the dependency names one version of a package declares.
 * @param version - the version record from a packument.
 * @returns the dependencies across all dependency fields, deduplicated.
 */
export function dependenciesOf(version: Readonly<Record<string, unknown>> | undefined): string[] {
  if (version === undefined) return []
  const names = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const value = version[field]
    if (value === null || typeof value !== 'object') continue
    for (const name of Object.keys(value)) names.add(name)
  }
  return [...names]
}

/**
 * Read the latest version record out of a packument.
 * @param packument - the upstream packument.
 * @returns the version record, or undefined when the packument names no usable latest version.
 */
export function latestOf(packument: Resolved): Readonly<Record<string, unknown>> | undefined {
  const latest = packument['dist-tags']?.latest
  if (typeof latest !== 'string') return undefined
  const version = packument.versions?.[latest]
  return version === undefined ? undefined : version
}

/** Whether a name is one this worker hosts, and therefore never needs the allow list. */
export type Hosts = (name: string) => boolean

/** Reads the dependency names a hosted package declares, without going upstream for it. */
export type OwnDependencies = (name: string) => Promise<readonly string[]>

/**
 * Fetch one package's packument from the upstream registry, or nothing when it does not exist there.
 * @param name - the package name.
 * @param upstream - registry base URL.
 * @returns the latest version record, or undefined.
 */
async function resolve(name: string, upstream: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  // The abbreviated packument is enough for dependencies and is far smaller than the full one.
  const response = await fetch(`${upstream}/${encoded}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    redirect: 'follow',
  })
  if (!response.ok) return undefined
  try {
    return latestOf((await response.json()) as Resolved)
  } catch {
    // A body that is not JSON is treated as "not resolvable here" rather than as a server error, because the caller's
    // only decision is whether to proxy.
    return undefined
  }
}

/**
 * Decide whether a package may be proxied, remembering the answer in KV.
 *
 * A package is allowed when a hosted package depends on it, directly or through other packages. The walk is bounded: it
 * stops after WALK_LIMIT packages, and it checks the KV cache before resolving anything, so a graph walked once is cheap
 * to walk again. A denial is cached too, so a client cannot make the worker re-walk the graph by repeating a request.
 *
 * A hosted package's own dependencies come from its hosted packument rather than from upstream, where the package does
 * not exist; only the dependencies of a dependency are resolved over the network.
 * @param name - the package the client asked for.
 * @param kv - the namespace.
 * @param upstream - registry base URL.
 * @param hosts - decides whether a name is hosted, which needs no allowance.
 * @param own - reads a hosted package's declared dependencies from KV.
 * @param roots - the hosted packages whose dependencies are reachable.
 * @returns whether the request may be proxied.
 */
export async function allowed(
  name: string,
  kv: KVNamespace,
  upstream: string,
  hosts: Hosts,
  own: OwnDependencies,
  roots: readonly string[],
): Promise<boolean> {
  if (hosts(name)) return true
  const cached = await kv.get(`${ALLOW_PREFIX}${name}`)
  if (cached !== null) return true
  if ((await kv.get(`${DENY_PREFIX}${name}`)) !== null) return false

  // Breadth-first from the hosted packages, so a direct dependency is found before a distant one. `seen` also guards the
  // walk against a dependency cycle.
  const seen = new Set<string>(roots)
  const queue = [...roots]
  let visited = 0
  while (queue.length > 0 && visited < WALK_LIMIT) {
    const current = queue.shift() as string
    visited += 1
    const dependencies = hosts(current) ? await own(current) : dependenciesOf(await resolve(current, upstream))
    for (const dependency of dependencies) {
      if (dependency === name) {
        await kv.put(`${ALLOW_PREFIX}${name}`, '1')
        return true
      }
      if (seen.has(dependency)) continue
      seen.add(dependency)
      queue.push(dependency)
    }
  }

  await kv.put(`${DENY_PREFIX}${name}`, '1', { expirationTtl: DENY_TTL_SECONDS })
  return false
}
