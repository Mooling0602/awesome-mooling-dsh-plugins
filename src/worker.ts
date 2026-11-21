/**
 * The CF Workers npm registry.
 *
 * Two kinds of package reach this worker.
 *
 * A plugin dispatched as `tarball` is not on npm, so its packument lives in KV and its tarballs are GitHub release
 * assets; the worker answers the packument itself and redirects the tarball to GitHub.
 *
 * Everything else — a plugin already on the official registry, and every transitive dependency pnpm has to resolve —
 * is proxied to registry.npmjs.org unchanged. That fallback is not optional: a converted package's `peerDependencies`
 * are ordinary npm packages, so a worker that answered only from KV could not resolve an install.
 *
 * Nothing is computed per request. Release assets and integrity are precomputed by `src/registry/build.ts` in CI,
 * because the unauthenticated GitHub API allows 60 requests per hour and Workers egress addresses are shared.
 */
import { packageOf, route, type RegistryEntry } from './routes.ts'

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
 * Answer one request.
 * @param request - the incoming request.
 * @param env - bindings.
 * @returns the response.
 */
export async function handle(request: Request, env: Env): Promise<Response> {
  const upstream = env.UPSTREAM ?? DEFAULT_UPSTREAM
  const parts = new URL(request.url).pathname.split('/').filter(segment => segment !== '')
  const found = packageOf(parts)
  // A path that names no package cannot be hosted here, and `/` alone (a browse request) belongs to the registry.
  if (found === undefined) return proxy(request, upstream)
  const entry = await lookup(env.REGISTRY, found.name)
  // Not hosted: every npm package pnpm resolves while installing a hosted one arrives here too.
  if (entry === undefined) return proxy(request, upstream)
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
