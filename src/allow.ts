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

/**
 * Scopes whose packages are proxied without walking the dependency graph.
 *
 * A DSH plugin is useless without the runtime it plugs into, so every plugin's graph reaches into the same vendor scope
 * and pulls a large part of it in. Walking that closure per request does not work: measured against npm, the graph
 * including every published version is over eight hundred packages, and resolving it takes around ninety seconds, far
 * past what one request may spend. The vendor scope is therefore answered directly.
 *
 * This stays narrower than "proxy everything": names outside these scopes still have to be reachable from a hosted
 * package, so the domain cannot be used to install arbitrary packages.
 */
const OPEN_SCOPES = ['@deepseek-ai/'] as const

/** How many packages one walk may visit. A pathological graph must not exhaust the request budget. */
const WALK_LIMIT = 64

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
 * Read the dependency names a package declares for the purposes of the walk.
 *
 * A dependency is walked at its latest version, not every published one. A package with a long release history would
 * otherwise contribute the dependencies of every release it ever shipped, and those historical packages dwarf the graph
 * that an install actually touches. The latest version is the one a client resolves for a plain name, so it is the right
 * approximation for a guess — a walk is a guess, and the request itself is what confirms it.
 *
 * Peer dependencies count. npm satisfies a peer constraint by fetching the named package, so a name that appears only in
 * `peerDependencies` is still requested by the client.
 * @param packument - the packument, holding every published version.
 * @param version - the one version to read, or `undefined` to read the latest.
 * @returns the dependency names across the selected version and all dependency fields, deduplicated.
 */
export function dependenciesOf(packument: Resolved | undefined, version?: string): string[] {
  if (packument === undefined) return []
  const wanted = version ?? packument['dist-tags']?.latest
  const record = wanted === undefined ? undefined : packument.versions?.[wanted]
  if (record === undefined || record === null || typeof record !== 'object') return []
  const names = new Set<string>()
  for (const field of DEPENDENCY_FIELDS) {
    const value = record[field]
    if (value === null || typeof value !== 'object') continue
    for (const name of Object.keys(value)) names.add(name)
  }
  return [...names]
}

/** Whether a name is one this worker answers for directly, and therefore never needs the allow list. */
export type Hosts = (name: string) => boolean

/**
 * Reads the dependency names a package declares from local data, without going upstream.
 *
 * Returns `undefined` when the package's manifest is not available locally, which is the case for a package this worker
 * only proxies. The caller then resolves it over the network instead.
 */
export type OwnDependencies = (name: string, version?: string) => Promise<readonly string[] | undefined>

/**
 * The version a request asks for, when it asks for one.
 *
 * A packument request names no version: the client is about to choose one. A tarball request does name one, and then only
 * that version's dependencies can matter for the install in progress.
 * @param name - the package name.
 * @param parts - the path segments after the package name.
 * @returns the version, or `undefined` when the request is not version-specific.
 */
export function requestedVersion(name: string, parts: readonly string[]): string | undefined {
  if (parts.length !== 2 || parts[0] !== '-') return undefined
  const file = decodeURIComponent(parts[1] as string)
  const base = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  const prefix = `${base}-`
  if (!file.startsWith(prefix) || !file.endsWith('.tgz')) return undefined
  const version = file.slice(prefix.length, -'.tgz'.length)
  return version === '' ? undefined : version
}

/**
 * Fetch one package's packument from the upstream registry, or nothing when it does not exist there.
 * @param name - the package name.
 * @param upstream - registry base URL.
 * @returns the packument, or undefined.
 */
async function resolve(name: string, upstream: string): Promise<Resolved | undefined> {  const encoded = name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)
  // The abbreviated packument is enough for dependencies and is far smaller than the full one.
  const response = await fetch(`${upstream}/${encoded}`, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    redirect: 'follow',
  })
  if (!response.ok) return undefined
  try {
    return (await response.json()) as Resolved
  } catch {
    // A body that is not JSON is treated as "not resolvable here" rather than as a server error, because the caller's
    // only decision is whether to proxy.
    return undefined
  }
}

/**
 * Record a set of packages as reachable, so a later request for any of them needs no walk.
 *
 * Called only with the path a walk proved, never while the walk is still exploring: a refusal traverses the whole
 * WALK_LIMIT budget and proves nothing the caller asked for, so writing during the walk would spend the quota on
 * packages no request named.
 *
 * A write failure is swallowed on purpose. The record is an optimisation, not the answer: the walk has already decided
 * that these packages may be proxied, and losing the shortcut only means the next request walks again. Letting the write
 * throw would turn a full KV write quota into a failed request, which is exactly what happened on the free plan, where
 * the daily write limit is small enough for a busy deploy day to exhaust it. Reads keep working then, so a worker that
 * ignores the failed write still resolves every package it can walk to.
 * @param kv - the namespace.
 * @param names - the package names to record.
 */
async function rememberAll(kv: KVNamespace, names: readonly string[]): Promise<void> {
  try {
    // Each name is recorded only when absent. The walk reaches every package on a dependency path, so without this
    // check one install rewrites the whole path even though a previous install already recorded it: the free plan allows
    // 1,000 writes a day, and re-writing known answers spends that budget on nothing. The read is cheap against the write
    // it saves, and the read quota is a hundred times the write quota.
    const absent: string[] = []
    for (const name of names) {
      if ((await kv.get(`${ALLOW_PREFIX}${name}`)) === null) absent.push(name)
    }
    for (const name of absent) await kv.put(`${ALLOW_PREFIX}${name}`, '1')
  } catch {
    // Nothing to do: the answer is already known, only the shortcut is lost.
  }
}

/**
 * Whether a package name sits in a scope this worker always proxies.
 * @param name - the package name.
 * @returns whether the scope is open.
 */
export function openScope(name: string): boolean {
  return OPEN_SCOPES.some(scope => name.startsWith(scope))
}

/**
 * Decide whether a package may be proxied, remembering the answer in KV.
 *
 * A package is allowed when it is reachable from a package this worker answers for. The walk is breadth-first from those
 * roots and stops at WALK_LIMIT packages, and every package it traverses is recorded as allowed, not only the one that
 * was asked for: the whole path from a root is part of the same dependency graph, so a later request for a package the
 * walk has already proven reachable costs one KV read and no network call.
 *
 * A denial is cached with a TTL rather than for good, because the graph can grow: a plugin may start depending on a
 * package that was refused before.
 *
 * A package this worker only proxies — a plugin published to npm — is a root as well, because the index points at this
 * domain for those too. Its own dependencies are not in KV, so they are resolved upstream like any other.
 * @param name - the package the client asked for.
 * @param kv - the namespace.
 * @param upstream - registry base URL.
 * @param hosts - decides whether a name is answered for, which needs no allowance.
 * @param own - reads a package's declared dependencies from local data, or `undefined` when it holds none.
 * @param roots - the packages whose dependencies are reachable.
 * @param version - the one version the request asks for, or `undefined` for a packument request.
 * @returns whether the request may be proxied.
 */
export async function allowed(
  name: string,
  kv: KVNamespace,
  upstream: string,
  hosts: Hosts,
  own: OwnDependencies,
  roots: readonly string[],
  version?: string,
): Promise<boolean> {
  if (hosts(name)) return true
  // The vendor scope is answered directly rather than walked, for the reason OPEN_SCOPES records.
  if (openScope(name)) return true
  if ((await kv.get(`${ALLOW_PREFIX}${name}`)) !== null) return true
  if ((await kv.get(`${DENY_PREFIX}${name}`)) !== null) return false

  // Breadth-first from the roots, so a direct dependency is found before a distant one. `seen` also guards the walk
  // against a dependency cycle.
  //
  // Nothing is written while the walk runs. Recording each dependency as the walk discovers it costs one KV read and one
  // KV write per node, and a refusal visits every node before it can answer: a client asking for one name outside the
  // graph spends the whole WALK_LIMIT budget on packages nothing asked for. The reachable set is also recomputed from
  // the same roots on the next request, so the records only pay off once the walked name itself is asked for again.
  // Instead the walk collects what it proves and writes it once, when the answer is a grant.
  const reachable: string[] = []
  const seen = new Set<string>(roots)
  const queue = [...roots]
  let visited = 0
  while (queue.length > 0 && visited < WALK_LIMIT) {
    const current = queue.shift() as string
    visited += 1
    const local = await own(current, current === name ? version : undefined)
    // A package whose manifest is not held locally is resolved upstream; one that is skips the request entirely.
    const dependencies = local ?? dependenciesOf(await resolve(current, upstream))
    for (const dependency of dependencies) {
      if (seen.has(dependency)) continue
      seen.add(dependency)
      reachable.push(dependency)
      if (dependency === name) {
        // The walk proved this name reachable, so the path to it is worth keeping: a later request for it or for any
        // package on that path then costs one read instead of another walk.
        await rememberAll(kv, reachable)
        return true
      }
      // A vendor package is answered without being walked, so its own dependencies have to be collected here instead:
      // an open scope is not expanded, and dropping this edge would leave a package like `react` unreachable even
      // though the plugin install genuinely needs it. Its dependencies are recorded but not recursed into, which keeps
      // the walk small while still covering what an install pulls in.
      if (openScope(dependency)) {
        const transitive = dependenciesOf(await resolve(dependency, upstream))
        for (const nested of transitive) {
          if (seen.has(nested)) continue
          seen.add(nested)
          reachable.push(nested)
          if (nested === name) {
            await rememberAll(kv, reachable)
            return true
          }
        }
        // The vendor package itself is answered directly on request, so the walk never recurses into it.
        continue
      }
      queue.push(dependency)
    }
  }

  // A refusal that cannot be remembered still refuses: the walk reached no path here, and caching that is only a saving
  // for the next caller. Swallowed for the same reason as the grant above.
  try {
    // Re-writing a live denial would reset its TTL without changing what it says, so it is left alone while it holds.
    // `allowed` already returns early on a live denial, so this only saves the write when two requests race.
    if ((await kv.get(`${DENY_PREFIX}${name}`)) === null) {
      await kv.put(`${DENY_PREFIX}${name}`, '1', { expirationTtl: DENY_TTL_SECONDS })
    }
  } catch {
    // Nothing to do: the answer is already known, only the shortcut is lost.
  }
  return false
}
