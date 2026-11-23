import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handle, type Env } from './worker.ts'
import type { RegistryEntry } from './routes.ts'

const PACKUMENT = {
  name: 'dsh-hint-shell',
  'dist-tags': { latest: '0.1.1' },
  versions: { '0.1.1': { name: 'dsh-hint-shell', version: '0.1.1' } },
}

const ENTRY: RegistryEntry = {
  packument: PACKUMENT,
  tarballs: {
    '0.1.1': { tarball: 'https://github.com/Mooling0602/dsh-hint-shell/releases/download/0.1.1/dsh-hint-shell-0.1.1.tgz' },
  },
}

/**
 * A hosted entry that depends on `cordis`.
 *
 * The allow list only proxies packages reachable from a hosted one, so a test that needs the proxy path has to start
 * from a package that actually declares the dependency.
 */
const DEPENDS_ON_CORDIS: RegistryEntry = {
  packument: {
    name: 'dsh-hint-shell',
    'dist-tags': { latest: '0.1.1' },
    versions: { '0.1.1': { name: 'dsh-hint-shell', version: '0.1.1', peerDependencies: { '@deepseek-ai/cordis': '^4.0.5' } } },
  },
  tarballs: {},
}

/** A KV namespace backed by a plain map. */
function kv(entries: Record<string, unknown>): KVNamespace {
  return {
    async get(key: string, type?: string) {
      const value = entries[key]
      if (value === undefined) return null
      return type === 'json' ? value : JSON.stringify(value)
    },
    // The allow-list remembers its answers through `put`; storing them in the same map is what lets a test observe a
    // cached decision.
    async put(key: string, value: string) {
      entries[key] = value
    },
  } as unknown as KVNamespace
}

function env(entries: Record<string, unknown> = { 'dsh-hint-shell': ENTRY }, upstream?: string): Env {
  return upstream === undefined ? { REGISTRY: kv(entries) } : { REGISTRY: kv(entries), UPSTREAM: upstream }
}

/** How a test wants the stubbed upstream to answer. */
interface Stub {
  /** Body to answer with; `undefined` answers an empty body. */
  readonly bytes?: string
  /** Status to answer with; defaults to 200. */
  readonly status?: number
  /** Headers to answer with. */
  readonly headers?: Record<string, string>
  /** Reject the fetch instead of answering, as an unreachable host would. */
  readonly fail?: boolean
}

/** Run one request against a handler, with fetch stubbed for the proxy path. */
async function request(
  url: string,
  entries?: Record<string, unknown>,
  upstream?: string,
  stub: Stub = {},
  options: { readonly headers?: Record<string, string>; readonly dev?: string } = {},
): Promise<{ response: Response; proxied: string[] }> {
  const proxied: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    proxied.push(String(input))
    if (stub.fail === true) throw new TypeError('fetch failed')
    return new Response(stub.bytes ?? '{"from":"upstream"}', {
      status: stub.status ?? 200,
      headers: stub.headers ?? { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
  try {
    const base = env(entries, upstream)
    const bound: Env = options.dev === undefined ? base : { ...base, DEV_PROXY: options.dev }
    const response = await handle(new Request(url, options.headers === undefined ? undefined : { headers: options.headers }), bound)
    return { response, proxied }
  } finally {
    globalThis.fetch = original
  }
}

test('托管的包返回 KV 中的 packument', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell')
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), PACKUMENT)
  assert.deepEqual(proxied, [])
})

test('packument 带缓存头', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell')
  assert.match(response.headers.get('cache-control') ?? '', /max-age=300/u)
})

test('tarball 请求把 GitHub 资产转发给客户端', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-0.1.1.tgz', undefined, undefined, {
    bytes: 'tarball-bytes',
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'tarball-bytes')
  assert.deepEqual(proxied, [ENTRY.tarballs['0.1.1']?.tarball])
})

test('转发时丢弃逐跳与编码头', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-0.1.1.tgz', undefined, undefined, {
    bytes: 'x',
    headers: { 'content-encoding': 'gzip', 'content-length': '999', connection: 'keep-alive', 'cache-control': 'max-age=60' },
  })
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-length'), null)
  assert.equal(response.headers.get('connection'), null)
  // A header that survives re-encoding is still forwarded.
  assert.equal(response.headers.get('cache-control'), 'max-age=60')
})

test('回源失败时回退到 302，而不是让安装失败', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-0.1.1.tgz', undefined, undefined, {
    fail: true,
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), ENTRY.tarballs['0.1.1']?.tarball)
  // The attempt was made, so the redirect is a fallback and not the default path.
  assert.deepEqual(proxied, [ENTRY.tarballs['0.1.1']?.tarball])
})

test('回源返回错误状态时也回退到 302', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-0.1.1.tgz', undefined, undefined, {
    status: 503,
    bytes: '<html>not a package</html>',
  })
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), ENTRY.tarballs['0.1.1']?.tarball)
})

test('未托管的依赖代理回上游', async () => {
  // A scoped dependency of a hosted package, so the allow list lets it through to the proxy.
  const { response, proxied } = await request('https://reg.test/@deepseek-ai%2Fcordis', {
    'dsh-hint-shell': DEPENDS_ON_CORDIS,
    __hosted__: ['dsh-hint-shell'],
  })
  assert.equal(await response.text(), '{"from":"upstream"}')
  assert.equal(proxied.length, 1)
  assert.match(proxied[0] ?? '', /^https:\/\/registry\.npmjs\.org\//u)
})

test('未托管的包若无托管包依赖则拒绝', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-other?write=true')
  // Refusing is the point: proxying any name on request would make this domain a free public npm mirror.
  assert.equal(response.status, 404)
  assert.equal(proxied.length, 0)
  const body = (await response.json()) as { error: string }
  assert.match(body.error, /not a dependency of a hosted package/u)
})

test('编码的 scope 斜杠不能绕过拒绝', async () => {
  // `@scope%2Fname` has to be recognised as a package. If it were not, it would fall into the "no package name" branch
  // and be proxied unconditionally, which reopens the public-mirror hole this worker is meant to close.
  const encoded = await request('https://reg.test/@types%2Fnode')
  assert.equal(encoded.response.status, 404)
  assert.equal(encoded.proxied.length, 0)
})

test('根路径代理回上游', async () => {
  const { proxied } = await request('https://reg.test/')
  assert.equal(proxied.length, 1)
})

test('托管的包但版本不存在时 404', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-9.9.9.tgz')
  assert.equal(response.status, 404)
  const body = (await response.json()) as { error: string }
  assert.match(body.error, /no version "9\.9\.9"/u)
})

test('托管的包但文件名不匹配时 404', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell/-/other-1.0.0.tgz')
  assert.equal(response.status, 404)
})

test('可覆盖上游地址', async () => {
  // A dependency of the hosted package, so the request reaches the proxy and the overridden base URL can be observed.
  const { proxied } = await request(
    'https://reg.test/cordis',
    { 'dsh-hint-shell': DEPENDS_ON_CORDIS, __hosted__: ['dsh-hint-shell'] },
    'https://mirror.test',
  )
  assert.match(proxied[0] ?? '', /^https:\/\/mirror\.test\//u)
})

test('代理不改写路径', async () => {
  const { proxied } = await request('https://reg.test/@deepseek-ai%2Fcordis', {
    'dsh-hint-shell': DEPENDS_ON_CORDIS,
    __hosted__: ['dsh-hint-shell'],
  })
  assert.match(proxied[0] ?? '', /\/@deepseek-ai%2Fcordis$/u)
})

test('多个包各自从 KV 读取', async () => {
  const second: RegistryEntry = {
    packument: { name: 'dsh-web-file-uploader', 'dist-tags': { latest: '1.0.0-rc.3' }, versions: {} },
    tarballs: {},
  }
  const { response } = await request('https://reg.test/dsh-web-file-uploader', {
    'dsh-hint-shell': ENTRY,
    'dsh-web-file-uploader': second,
  })
  const body = (await response.json()) as { name: string }
  assert.equal(body.name, 'dsh-web-file-uploader')
})

test('索引来自打包进脚本的模块，且不走代理', async () => {
  // The index ships with the worker rather than living in KV, so publishing it costs a deploy and no KV write.
  const { response, proxied } = await request('https://reg.test/dsh-plugins/index.json', {})
  assert.equal(response.status, 200)
  const body = (await response.json()) as { format: number; plugins: unknown[] }
  assert.equal(body.format, 1)
  assert.ok(Array.isArray(body.plugins))
  assert.deepEqual(proxied, [])
})

test('索引带缓存头', async () => {
  const { response } = await request('https://reg.test/dsh-plugins/index.json', {})
  // Shorter than a packument: a stale index hides a release the deploy just published, and revalidating it reads no KV.
  assert.match(response.headers.get('cache-control') ?? '', /max-age=60/u)
})

test('索引不读 KV', async () => {
  // A KV entry left over from the previous design must not be served: the bundled module is the only source now.
  const { response } = await request('https://reg.test/dsh-plugins/index.json', {
    __index__: { title: 'stale', plugins: [] },
  })
  const body = (await response.json()) as { title: string }
  assert.notEqual(body.title, 'stale')
})



test('索引路径不会被当成包名代理', async () => {
  // Guards the ordering in `handle`: routing the path as a package would proxy it, and no such npm package exists.
  const { proxied } = await request('https://reg.test/dsh-plugins/index.json', {})
  assert.deepEqual(proxied, [])
})

test('拒绝响应带短缓存头，避免重复请求重走依赖遍历', async () => {
  // A refusal costs a whole graph walk, and without a cache header every repeat of the same request pays it again. The
  // window stays short because a hosted plugin may later start depending on the name.
  const { response } = await request('https://reg.test/no-such-package', {})
  assert.equal(response.status, 404)
  assert.match(response.headers.get('cache-control') ?? '', /max-age=60/u)
})

test('托管包的未知子路径返回 404，不被代理', async () => {
  // Proxying it would answer with whatever the public registry serves under the same name and cache that here.
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/bad/path', {})
  assert.equal(response.status, 404)
  assert.deepEqual(proxied, [])
})

test('托管包的版本端点返回该版本的 manifest', async () => {
  // A shape registry.npmjs.org answers for a package it holds, so a hosted package has to answer it too.
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/0.1.1')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { version?: string }
  assert.equal(body.version, '0.1.1')
  assert.deepEqual(proxied, [])
})

test('托管包的 tag 端点解析到 dist-tags 指向的版本', async () => {
  const { response } = await request('https://reg.test/dsh-hint-shell/latest')
  assert.equal(response.status, 200)
  const body = (await response.json()) as { version?: string }
  assert.equal(body.version, '0.1.1')
})

test('不存在的版本返回 404 而不是代理', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/9.9.9')
  assert.equal(response.status, 404)
  assert.deepEqual(proxied, [])
})

/**
 * Serve a Cache API stand-in for the grant tests.
 *
 * The worker keeps its grant in the edge cache rather than KV so that a client's whole dependency tree does not cost a
 * KV read each, and Node has no such cache. This stands one up: entries live in the map for the duration of a callback,
 * which is what lets a test spend a grant on a hosted request and then observe the redirect.
 * @param run - the test body, receiving the cache it should use.
 * @returns whatever the body returns.
 */
async function withCache<T>(run: () => Promise<T>): Promise<T> {
  const store = new Map<string, Response>()
  const holder = globalThis as { caches?: unknown }
  const original = holder.caches
  const match = async (request: Request | string | URL): Promise<Response | undefined> =>
    store.get(new URL(String(request)).pathname)
  const put = async (request: Request | string | URL, response: Response): Promise<void> => {
    store.set(new URL(String(request)).pathname, response)
  }
  const standIn: unknown = { open: async () => ({ match, put }) }
  holder.caches = standIn
  try {
    return await run()
  } finally {
    holder.caches = original
  }
}

test('没有授权的客户端请求未收录包仍被拒绝', async () => {
  await withCache(async () => {
    const { response, proxied } = await request(
      'https://reg.test/dsh-context',
      { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] },
      undefined,
      {},
      { headers: { 'cf-connecting-ip': '5.5.5.5' }, dev: '1' },
    )
    assert.equal(response.status, 404)
    assert.deepEqual(proxied, [])
  })
})

test('请求过托管包的客户端，未收录包被重定向到公共源', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    const headers = { 'cf-connecting-ip': '5.5.5.5' }
    // The first request is the one pnpm makes: the named plugin, before any of its dependencies.
    const hosted = await request('https://reg.test/dsh-hint-shell', entries, 'https://up.test', {}, { headers, dev: '1' })
    assert.equal(hosted.response.status, 200)
    const { response } = await request('https://reg.test/dsh-context', entries, 'https://up.test', {}, { headers, dev: '1' })
    assert.equal(response.status, 302)
    assert.equal(response.headers.get('location'), 'https://up.test/dsh-context')
  })
})

test('重定向按客户端地址区分，未授予的地址不受影响', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    await request('https://reg.test/dsh-hint-shell', entries, 'https://up.test', {}, {
      headers: { 'cf-connecting-ip': '5.5.5.5' }, dev: '1',
    })
    const other = await request('https://reg.test/dsh-context', entries, 'https://up.test', {}, {
      headers: { 'cf-connecting-ip': '9.9.9.9' }, dev: '1',
    })
    assert.equal(other.response.status, 404)
  })
})

test('没有客户端地址时不授予，即使已用过托管包', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    await request('https://reg.test/dsh-hint-shell', entries, 'https://up.test')
    const { response } = await request('https://reg.test/dsh-context', entries, 'https://up.test')
    assert.equal(response.status, 404)
  })
})

test('重定向不带缓存头，避免把授权回给同一地址上的其他客户端', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    const headers = { 'cf-connecting-ip': '5.5.5.5' }
    await request('https://reg.test/dsh-hint-shell', entries, 'https://up.test', {}, { headers, dev: '1' })
    const { response } = await request('https://reg.test/dsh-context', entries, 'https://up.test', {}, { headers, dev: '1' })
    assert.equal(response.headers.get('cache-control'), null)
  })
})

test('授权过期后的拒绝说明是超时而不是包不存在', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    const headers = { 'cf-connecting-ip': '7.7.7.7' }
    // A grant written by a hosted request, then read after the window it recorded has passed.
    await request('https://reg.test/dsh-hint-shell', entries, 'https://up.test', {}, { headers, dev: '1' })
    const cache = await caches.open('grant')
    const key = new URL('https://grant.invalid/grant:7.7.7.7')
    const stale = await cache.match(key)
    assert.notEqual(stale, undefined)
    await cache.put(key, new Response(String(Date.now() - 1000), { headers: { 'cache-control': 'max-age=3600' } }))
    const { response } = await request('https://reg.test/dsh-context', entries, 'https://up.test', {}, { headers, dev: '1' })
    assert.equal(response.status, 404)
    const body = (await response.json()) as { error: string; hint: string }
    assert.match(body.error, /longer than/)
    assert.doesNotMatch(body.error, /not hosted here/)
    assert.match(body.hint, /again/)
  })
})

test('从未授权的客户端得到的是包不存在而不是超时', async () => {
  await withCache(async () => {
    const entries = { 'dsh-hint-shell': ENTRY, '__hosted__': ['dsh-hint-shell'] }
    const { response } = await request(
      'https://reg.test/dsh-context', entries, 'https://up.test', {}, { headers: { 'cf-connecting-ip': '6.6.6.6' }, dev: '1' },
    )
    assert.equal(response.status, 404)
    const body = (await response.json()) as { error: string; hint?: string }
    assert.match(body.error, /not hosted here/)
    assert.equal(body.hint, undefined)
  })
})
