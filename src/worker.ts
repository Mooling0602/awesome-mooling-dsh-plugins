/**
 * The CF Workers npm registry.
 *
 * Two kinds of package reach this worker.
 *
 * A plugin dispatched as `tarball` is not on npm, so its packument lives in KV and its tarballs are GitHub release
 * assets; the worker answers the packument itself and relays the tarball. Relaying rather than redirecting keeps the
 * client off GitHub's CDN, which is unreachable or slow from mainland networks; when the relay itself cannot reach
 * GitHub the tarball is redirected instead, so a reachability problem at this worker never fails an install.
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
import { HOSTED_KEY, INDEX_PATH, packageOf, route, type RegistryEntry } from './routes.ts'
import INDEX from '../dists/index.json' with { type: 'json' }
import { allowed, dependenciesOf, requestedVersion, type Hosts, type OwnDependencies, type Resolved } from './allow.ts'

/** The KV namespace holding, for each converted package, its packument and tarball locations. */
export interface Env {
  /** Bound to a KV namespace; each key is a package name. */
  readonly REGISTRY: KVNamespace
  /** Upstream registry every non-hosted request is proxied to. */
  readonly UPSTREAM?: string
  /**
   * `'1'` only in a local `wrangler dev` reproduction, never in a deployed environment.
   *
   * A local run has no edge in front of it, so it sees no client address and every grant would look absent. Setting this
   * lets the reproduction pass one in a header. It must never be deployed: a caller could then claim an address that
   * another client holds a grant for.
   */
  readonly DEV_PROXY?: string
}

/** The registry this worker proxies to when it does not host a package. */
const DEFAULT_UPSTREAM = 'https://registry.npmjs.org'

/** Response headers that must not be copied from upstream, because the body is re-encoded or the value is per-hop. */
const DROPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/**
 * How long a packument served from KV may be cached.
 *
 * Five minutes is short enough that a plugin release shows up while the user who is waiting for it is still installing,
 * and long enough that one `pnpm install` of a hosted plugin reads each packument once instead of on every dependency
 * resolution pass. A packument in KV changes only when this repository deploys, which happens far less often than five
 * minutes apart.
 */
const PACKUMENT_MAX_AGE_SECONDS = 300

/**
 * How long the market index may be cached.
 *
 * Shorter than a packument: the index is the list a client browses to find plugins, so a stale copy hides a release the
 * deploy just published, and the cost of revalidating it is one request that reads no KV at all — it is bundled into the
 * script. A client that has it cached still gets the fresh copy within the minute.
 */
const INDEX_MAX_AGE_SECONDS = 60

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

/**
 * Answer with a JSON body.
 * @param body - the value to serialise.
 * @param status - HTTP status.
 * @param maxAge - seconds the response may be cached for, or `false` to send no cache header at all.
 * @returns the response.
 */
function json(body: unknown, status: number, maxAge: number | false = false): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (maxAge !== false) headers['cache-control'] = `public, max-age=${maxAge}`
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
 * How long a refusal may be cached.
 *
 * Short on purpose. A refusal is the answer to a name the walk could not reach, and the walk is expensive — a repeated
 * request for the same unreachable name would otherwise walk the whole graph again every time. Caching it at the client
 * and at the edge is what turns a client that keeps asking into zero requests here.
 *
 * It has to expire quickly, though, because the answer can become wrong: a hosted plugin may start depending on the
 * package, and a long-lived cached 404 would then keep the install failing even after the worker learned the name. One
 * minute bounds that window without giving up the repeat-request saving, which matters far more for the requests that
 * arrive in a burst than for one that arrives a day later.
 */
const DENIED_MAX_AGE_SECONDS = 60

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
  return json({ error: `not hosted here, and not a dependency of a hosted package: ${name}` }, 404, DENIED_MAX_AGE_SECONDS)
}

/**
 * The refusal a client gets when it has gone quiet for longer than GRANT_TTL_SECONDS.
 *
 * It reads differently from `denied` on purpose. A client that reaches this point is usually in the middle of a working
 * install that paused long enough to lose the grant, and the install reports the refusal as a missing package. Saying
 * the name is not hosted would leave the user unable to tell a stall apart from a package that really is refused, so the
 * message names the gap and asks for a retry.
 * @param name - the package that was refused.
 * @returns the refusal.
 */
function lapsed(name: string): Response {
  return json(
    {
      error: `the request paused for longer than the ${String(GRANT_TTL_SECONDS)} second window this registry allows ` +
        `between requests, so it could not be completed: ${name}`,
      hint: 'run the operation again',
    },
    404,
    DENIED_MAX_AGE_SECONDS,
  )
}

/**
 * How long a client keeps the right to resolve packages this worker does not host.
 *
 * Fifteen seconds of silence, renewed by every request that uses it. The grant is written when a client asks for a
 * hosted package and renewed on each refused name that is forwarded, so what has to fit inside this window is the pause
 * between two requests of one install, not the install itself.
 *
 * Measured against a cold install of a realistic profile: 712 requests over 15.6 seconds, whose longest pause between
 * two requests was 3.7 seconds and whose median was under a millisecond. Fifteen seconds covers that pause four times
 * over while staying far below the length of the install, so a client that stalls loses the grant quickly instead of
 * keeping it.
 *
 * The window bounds how long an install leaves a right behind, not how much a client may resolve. Limiting volume needs
 * a counter per client, which is a separate concern with its own storage cost and belongs with rate limiting.
 */
const GRANT_TTL_SECONDS = 15

/** Prefix of the cache key marking a client as allowed to resolve non-hosted packages. */
const GRANT_PREFIX = 'grant:'

/**
 * How long the record of a client survives, which is longer than the grant it carries.
 *
 * Keeping the entry after its grant ends is what lets a refusal say the install lapsed rather than implying the package
 * does not exist. The value stored is the moment the grant stops, so the two states are read from one entry.
 */
const GRANT_MEMORY_SECONDS = 60 * 60

/**
 * What this client is currently allowed to do, and whether it used to be allowed.
 *
 * A client refused after a pause and one that never asked for a hosted package both end in a 404, and only the first is
 * worth telling to retry, so the difference is kept and reported.
 */
type Grant = 'granted' | 'lapsed' | 'never'

/**
 * Whether this request comes from a client that has recently used a hosted package.
 *
 * The grant lives in the edge cache rather than KV. It is written on every hosted request and read on every refused one,
 * which is exactly the traffic KV meters: a single install resolves a whole profile, so the refused reads alone would be
 * dozens per install against a 100,000-a-day allowance. The cache has no such quota, and its eviction only costs a
 * client one more hosted request before the next refusal is forwarded again.
 * @param address - the client address, or null when the edge did not report one.
 * @returns the state of this client's grant.
 */
async function grantOf(address: string | null): Promise<Grant> {
  if (address === null) return 'never'
  const cache = await caches.open('grant')
  const hit = await cache.match(new URL(`https://grant.invalid/${GRANT_PREFIX}${address}`))
  if (hit === undefined) return 'never'
  const expires = Number(await hit.text())
  return Number.isFinite(expires) && Date.now() < expires ? 'granted' : 'lapsed'
}

/**
 * Remember that a client is using this domain, so its next refused dependency is forwarded instead of denied.
 *
 * The value written is the moment the grant stops rather than a flag, so a later read can tell a lapsed grant from a
 * missing one. The entry is kept for GRANT_MEMORY_SECONDS so that distinction stays available after the grant ends.
 * @param address - the client address, or null when the edge did not report one.
 */
async function remember(address: string | null): Promise<void> {
  if (address === null) return
  const cache = await caches.open('grant')
  await cache.put(
    new URL(`https://grant.invalid/${GRANT_PREFIX}${address}`),
    new Response(String(Date.now() + GRANT_TTL_SECONDS * 1000), {
      headers: { 'cache-control': `max-age=${String(GRANT_MEMORY_SECONDS)}` },
    }),
  )
}

/**
 * The address a grant is keyed on.
 *
 * The address comes from Cloudflare's own header, which the edge sets rather than the caller, so a client cannot claim
 * another's address. `wrangler dev` runs without that edge and fills the header with its own loopback address, which no
 * grant would ever name, so a local reproduction may pass one instead when the deployment sets DEV_PROXY. That fallback
 * must never be deployed: a caller could then claim an address another client holds a grant for.
 * @param request - the incoming request.
 * @param dev - whether the deployment opted into the local reproduction's header.
 * @returns the address, or null when neither header is present.
 */
function clientAddress(request: Request, dev: boolean): string | null {
  const address = dev
    ? request.headers.get('x-dev-address') ?? request.headers.get('cf-connecting-ip')
    : request.headers.get('cf-connecting-ip')
  return address
}

/**
 * Redirect a package this worker does not host to the public registry.
 *
 * A 302 rather than a proxy: pnpm follows it and fetches the tarball from the public registry directly, so this worker
 * neither pays for the bytes nor stores anything. The metadata is what pins the client afterwards, because a lockfile
 * written through a redirect records the public registry's tarball URL, not this domain's. One granted install is
 * therefore enough for that dependency to stop asking this worker at all.
 * @param request - the incoming request.
 * @param upstream - registry base URL.
 * @returns the redirect.
 */
function redirect(request: Request, upstream: string): Response {
  const incoming = new URL(request.url)
  const target = new URL(`${incoming.pathname}${incoming.search}`, upstream)
  // No cache header: a redirect is only correct for a granted client, and caching it at the edge would serve it to
  // everyone else behind the same address.
  return new Response(null, { status: 302, headers: { location: target.href } })
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
 * Relay a release asset, falling back to a redirect.
 *
 * The bytes are streamed, never buffered: the response body is the upstream body, so relaying a large asset costs the
 * same CPU as relaying a small one. GitHub answers with a redirect to a signed URL of its own, which `follow` resolves
 * before any header is written.
 *
 * The fallback covers the case where this worker cannot reach GitHub at all. It cannot cover a transfer that dies
 * halfway, because by then the status line has been sent and the only thing left to do is end the body; the client
 * sees a truncated download and its own integrity check rejects it, which is a correct failure rather than a silent
 * corruption.
 * @param request - the incoming request.
 * @param tarball - the absolute URL the asset lives at.
 * @returns the asset, or a redirect when the relay could not be started.
 */
async function relay(request: Request, tarball: string): Promise<Response> {
  const headers = new Headers(request.headers)
  headers.delete('host')
  let response: Response
  try {
    response = await fetch(tarball, { method: request.method, headers, redirect: 'follow' })
  } catch {
    return Response.redirect(tarball, 302)
  }
  // An upstream error is not worth relaying: the client would store an HTML body as a package. Redirecting instead
  // gives it a second chance against GitHub directly, which fails with its own status rather than a misleading one.
  if (!response.ok) return Response.redirect(tarball, 302)
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
function index(): Response {
  return json(INDEX, 200, INDEX_MAX_AGE_SECONDS)
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
  if (new URL(request.url).pathname === INDEX_PATH) return index()
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
    // upstream for its dependencies instead. The hosted set answers that without a KV read: the walk visits up to
    // WALK_LIMIT packages per refusal, and reading KV for each of them costs a hundred reads on a path that is about to
    // be refused anyway. The set is already in memory, so the read is only paid for a package that may hold a packument.
    const own: OwnDependencies = async (name, version) => {
      // A name outside the hosted set has no packument here by definition, so the walk should ask upstream instead.
      if (!hosted.has(name)) return undefined
      const entry = await lookup(env.REGISTRY, name)
      if (entry === undefined) return undefined
      return dependenciesOf(entry.packument as Resolved, version)
    }
    const version = requestedVersion(found.name, parts.slice(found.consumed))
    if (!(await allowed(found.name, env.REGISTRY, upstream, hosts, own, [...hosted], version))) {
      // A client that installs a hosted plugin does so with a registry flag that replaces the registry for its whole
      // dependency tree, so a name outside the hosted graph is expected here. It is forwarded only for a client that has
      // just used a hosted package. See GRANT_PREFIX.
      const address = clientAddress(request, env.DEV_PROXY === '1')
      const state = await grantOf(address)
      if (state === 'granted') {
        // Renewing while forwarding is what keeps a grant alive for the length of an install. The hosted request that
        // opened the install is the only hosted request it makes, so without this the grant would be a hard limit from
        // the first request rather than a budget that the install's own progress extends.
        await remember(address)
        return redirect(request, upstream)
      }
      return state === 'lapsed' ? lapsed(found.name) : denied(found.name)
    }
    return proxy(request, upstream)
  }
  // A request for a hosted package is what earns the right to resolve the ones this worker does not host. Renewing it
  // here rather than only at install time is what keeps a client covered across the update checks that follow, each of
  // which reads a hosted packument first.
  await remember(clientAddress(request, env.DEV_PROXY === '1'))
  const decided = route(new URL(request.url), name => (name === found.name ? entry : undefined))
  switch (decided.kind) {
    case 'packument':
      return json(entry.packument, 200, PACKUMENT_MAX_AGE_SECONDS)
    case 'manifest': {
      // Resolved from the packument already in hand rather than proxied, for the same reason as the packument: the
      // public registry holds no package under this name, so a forwarded request would 404 for a version this worker
      // can answer. A tag is a valid specifier too (`latest`), which is why the tag map is consulted before the version
      // list, exactly as the registry does.
      const packument = entry.packument as {
        readonly 'dist-tags'?: Readonly<Record<string, string>>
        readonly versions?: Readonly<Record<string, unknown>>
      }
      const tagged = packument['dist-tags']?.[decided.specifier]
      const version = tagged ?? decided.specifier
      const manifest = packument.versions?.[version]
      if (manifest === undefined) {
        return json({ error: `${decided.name} has no version or tag ${JSON.stringify(decided.specifier)}` }, 404, DENIED_MAX_AGE_SECONDS)
      }
      return json(manifest, 200, PACKUMENT_MAX_AGE_SECONDS)
    }
    case 'download':
      return relay(request, decided.tarball)
    case 'not-found':
      return json({ error: decided.reason }, 404, DENIED_MAX_AGE_SECONDS)
    case 'proxy':
      return proxy(request, upstream)
  }
}

export default {
  fetch: handle,
}
