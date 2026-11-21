/**
 * The CF Workers npm registry.
 *
 * Two kinds of package reach this worker.
 *
 * A plugin dispatched as `tarball` is not on npm, so its packument lives in KV and its tarballs are GitHub release
 * assets; the worker answers the packument itself and redirects the tarball to GitHub.
 *
 * Everything else — a plugin already on the official registry, and every dependency pnpm has to resolve — is proxied to
 * registry.npmjs.org. That fallback is not optional: a converted package's `peerDependencies` are ordinary npm packages,
 * so a worker that answered only from KV could not resolve an install.
 *
 * The fallback is scoped, though. Proxying any name on request would turn this domain into a free public npm mirror, on
 * this account's quota, so a package is proxied only when it is reachable from a hosted package's dependency graph. That
 * decision lives in `allow.ts`; this module only wires it in.
 *
 * Nothing else is computed per request. Release assets and integrity are precomputed by `src/registry/build.ts` in CI,
 * because the unauthenticated GitHub API allows 60 requests per hour and Workers egress addresses are shared.
 */
import { HOSTED_KEY, INDEX_KEY, INDEX_PATH, packageOf, route, type RegistryEntry } from './routes.ts'
import { allowed, dependenciesOf, latestOf, type Hosts, type OwnDependencies, type Resolved } from './allow.ts'

/** The KV namespace holding, for each converted package, its packument and tarball locations. */
export interface Env {
  /** Bound to a KV namespace; each key is a package name. */
  readonly REGISTRY: KVNamespace
  /** Upstream registry every non-hosted request is proxied to. */
  readonly UPSTREAM?: string
}

/** The registry this worker proxies to when it does not host a package. */
const DEFAULT_UPSTREAM = 'https://registry.npmjs.org'

/** Response headers that must not be copied from upstream, because the body is re-encoded or the value is per-hop. */
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/**
 * Read one package out of KV.
 * @param kv - the namespace.
 * @param name - the package name.
 * @returns the entry, or undefined when the worker does not host the package.
 */
async function lookup(kv: KVNamespace, name: string): Promise<RegistryEntry | undefined> {
  const raw = await kv.get(name, 'json')
  return raw === null ? undefined : (raw as RegistryEntry)
}

/** Answer with a JSON body. */
function json(body: unknown, status: number, cache = false): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (cache) headers['cache-control'] = 'public, max-age=300'
  return new Response(JSON.stringify(body), { status, headers })
}

/**
 * Read the names of the packages this worker hosts.
 * @param kv - the namespace.
 * @returns the hosted names, or an empty set when the list has not been published.
 */
async function hostedNames(kv: KVNamespace): Promise<ReadonlySet<string>> {
  const raw = await kv.get(HOSTED_KEY, 'json')
  if (!Array.isArray(raw)) return new Set()
  return new Set(raw.filter((name): name is string => typeof name === 'string'))
}

/**
 * Answer for a package this worker will not proxy.
 *
 * A 404 with an npm-shaped body is deliberate: npm and pnpm both report it as a missing package, which is the truth from
 * the client's point of view, while a 403 would read as an authorisation problem the user cannot fix. The message names
 * the reason so a dependency that genuinely needs adding is diagnosable instead of silent.
 * @param name - the package name.
 * @returns the response.
 */
function denied(name: string): Response {
  return json({ error: `not hosted here, and not a dependency of a hosted package: ${name}` }, 404)
}

/**
 * Proxy a request to the upstream registry.
 *
 * The path, query and method are preserved so that dist-tags, abbreviated packuments and scoped names all keep working.
 * The response body is passed through as a stream; only the body-encoding headers are dropped, because Workers
 * transparently decompresses and re-chunks the stream.
 * @param request - the incoming request.
 * @param upstream - registry base URL.
 * @returns the upstream response.
 */
async function proxy(request: Request, upstream: string): Promise<Response> {
  const incoming = new URL(request.url)
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstream)
  const headers = new Headers(request.headers)
  headers.delete('host')
  const response = await fetch(target, { method: request.method, headers, redirect: 'follow' })
  const forwarded = new Headers()
  for (const [key, value] of response.headers) {
    if (!DROPPED_HEADERS.has(key.toLowerCase())) forwarded.set(key, value)
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: forwarded })
}

/**
 * Serve the market index.
 *
 * The index is stored as one KV value rather than computed here, for the same reason the packuments are: building it
 * needs every plugin's release inventory, which is far past the CPU budget of a request. Nothing is cached when it is
 * missing, so a client retries once the publishing job has written it instead of pinning a 404.
 * @param kv - the namespace.
 * @returns the index, or a 404 when it has not been published yet.
 */
async function index(kv: KVNamespace): Promise<Response> {
  const raw = await kv.get(INDEX_KEY, 'json')
  if (raw === null) return json({ error: 'the index has not been published yet' }, 404)
  return json(raw, 200, true)
}

/**
 * Answer one request.
 * @param request - the incoming request.
 * @param env - bindings.
 * @returns the response.
 */
export async function handle(request: Request, env: Env): Promise<Response> {
  const upstream = env.UPSTREAM ?? DEFAULT_UPSTREAM
  // The index is not a package, so it is resolved before any package name is parsed; routing it later would send it
  // upstream and 404, because no such npm package exists.
  if (new URL(request.url).pathname === INDEX_PATH) return index(env.REGISTRY)
  const parts = new URL(request.url).pathname.split('/').filter(segment => segment !== '')
  const found = packageOf(parts)
  // A path that names no package cannot be hosted here, and `/` alone (a browse request) belongs to the registry. It is
  // still proxied: `/-/v1/search` and the audit endpoints are not package-scoped, and a client rejecting them would fail
  // an install before any package is resolved.
  if (found === undefined) return proxy(request, upstream)
  const entry = await lookup(env.REGISTRY, found.name)
  if (entry === undefined) {
    // Not hosted: proxying it is what lets pnpm resolve a hosted package's dependencies. It is not opened to everything,
    // though, because that would make this domain a free public npm mirror.
    const hosted = await hostedNames(env.REGISTRY)
    const hosts: Hosts = name => hosted.has(name)
    // Only a converted package has a packument in KV, so an npm-published plugin yields `undefined` and the walk asks
    // upstream for its dependencies instead.
    const own: OwnDependencies = async name => {
      const entry = await lookup(env.REGISTRY, name)
      if (entry === undefined) return undefined
      return dependenciesOf(latestOf(entry.packument as Resolved))
    }
    if (!(await allowed(found.name, env.REGISTRY, upstream, hosts, own, [...hosted]))) return denied(found.name)
    return proxy(request, upstream)
  }
  const decided = route(new URL(request.url), name => (name === found.name ? entry : undefined))
  switch (decided.kind) {
    case 'packument':
      return json(entry.packument, 200, true)
    case 'download':
      // GitHub serves the asset through a signed, expiring redirect of its own, so a 302 here keeps that intact.
      return Response.redirect(decided.tarball, 302)
    case 'not-found':
      return json({ error: decided.reason }, 404)
    case 'proxy':
      return proxy(request, upstream)
  }
}

export default {
  fetch: handle,
}
