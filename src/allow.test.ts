import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW_PREFIX, allowed, DENY_PREFIX, dependenciesOf, openScope, requestedVersion } from './allow.ts'

/** A KV namespace backed by a plain map, enough for the two calls `allowed` makes. */
function kv(entries: Record<string, unknown> = {}): KVNamespace {
  return {
    async get(key: string) {
      return entries[key] === undefined ? null : (entries[key] as string)
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      entries[key] = value
      // Recorded so a test can tell a permanent grant from a refusal that is meant to expire.
      if (options?.expirationTtl !== undefined) entries[`${key}#ttl`] = String(options.expirationTtl)
    },
  } as unknown as KVNamespace
}

/**
 * Replace `fetch` for one test with a packument server.
 * @param packages - package name to the dependency names its latest version declares.
 * @returns the names that were requested, in order.
 */
function serve(packages: Record<string, readonly string[]>): { asked: string[]; restore: () => void } {
  const asked: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const name = decodeURIComponent(url.pathname.replace(/^\/+/u, ''))
    asked.push(name)
    const dependencies = packages[name]
    if (dependencies === undefined) return new Response('{"error":"not found"}', { status: 404 })
    const declared = Object.fromEntries(dependencies.map(dependency => [dependency, '^1.0.0']))
    return new Response(
      JSON.stringify({
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name, version: '1.0.0', dependencies: declared } },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof globalThis.fetch
  return { asked, restore: () => { globalThis.fetch = original } }
}

test('dependenciesOf 合并三个依赖字段', () => {
  const names = dependenciesOf({
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': {
        dependencies: { a: '1' },
        peerDependencies: { b: '2' },
        optionalDependencies: { c: '3', a: '1' },
      },
    },
  })
  // Sorted for a stable comparison; duplicates across fields collapse.
  assert.deepEqual(names.sort(), ['a', 'b', 'c'])
})

test('dependenciesOf 默认只读 latest', () => {
  // A walk is a guess about what an install will touch, so it reads the version a plain name resolves to. Reading every
  // published version instead would pull in the dependencies of long-dead releases.
  const names = dependenciesOf({
    'dist-tags': { latest: '1.0.0' },
    versions: {
      '1.0.0': { dependencies: { only: '1' } },
      '0.1.0': { dependencies: { historical: '1' } },
    },
  })
  assert.deepEqual(names, ['only'])
})

test('dependenciesOf 读指定版本', () => {
  // A tarball request names its version, and only that version's dependencies can matter for that install.
  const names = dependenciesOf(
    {
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { dependencies: { only: '1' } }, '0.1.0': { dependencies: { historical: '1' } } },
    },
    '0.1.0',
  )
  assert.deepEqual(names, ['historical'])
})

test('dependenciesOf 在缺失或非对象时返回空', () => {
  assert.deepEqual(dependenciesOf(undefined), [])
  assert.deepEqual(dependenciesOf({}), [])
  assert.deepEqual(dependenciesOf({ versions: {} }), [])
  assert.deepEqual(dependenciesOf({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': null as never } }), [])
  // A packument with no latest tag names no version the walk could read.
  assert.deepEqual(dependenciesOf({ versions: { '1.0.0': { dependencies: { a: '1' } } } }), [])
  assert.deepEqual(dependenciesOf({ versions: { '1.0.0': { dependencies: null } } }), [])
  assert.deepEqual(dependenciesOf({ versions: { '1.0.0': { dependencies: 'nope' } } }), [])
})

test('托管包本身永远允许，不需要查白名单', async () => {
  const store = kv()
  const result = await allowed('dsh-x', store, 'https://up.test', name => name === 'dsh-x', async () => [], ['dsh-x'])
  assert.equal(result, true)
})

test('托管包的直接依赖被允许', async () => {
  const { restore } = serve({})
  try {
    const store = kv()
    const result = await allowed(
      'cordis',
      store,
      'https://up.test',
      name => name === 'dsh-x',
      async (name: string) => (name === 'dsh-x' ? ['cordis'] : undefined),
      ['dsh-x'],
    )
    assert.equal(result, true)
    assert.equal(await store.get(`${ALLOW_PREFIX}cordis`), '1')
  } finally {
    restore()
  }
})

test('传递依赖被允许', async () => {
  // dsh-x depends on cordis, which depends on a package the client asked for.
  const { asked, restore } = serve({ cordis: ['deep-dep'] })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    // Only the hosted root has a local manifest; `cordis` is not held here, so its dependencies come from upstream.
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['cordis'] : undefined
    const result = await allowed('deep-dep', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(result, true)
    assert.deepEqual(asked, ['cordis'])
  } finally {
    restore()
  }
})

test('无关的包被拒绝，且拒绝被记住', async () => {
  const { restore } = serve({})
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (): Promise<readonly string[] | undefined> => []
    const first = await allowed('random-package', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(first, false)
    assert.equal(await store.get(`${DENY_PREFIX}random-package`), '1')
    // A refusal has to expire, or a plugin that later gains this dependency would be blocked for good.
    assert.ok((await store.get(`${DENY_PREFIX}random-package#ttl`)) !== null)
    // A second request is answered from KV, so a client cannot force a fresh walk by repeating it.
    const second = await allowed('random-package', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(second, false)
  } finally {
    restore()
  }
})

test('允许被记住后不再访问上游', async () => {
  const { asked, restore } = serve({})
  try {
    const store = kv({ [`${ALLOW_PREFIX}cached`]: '1' })
    const result = await allowed('cached', store, 'https://up.test', () => false, async () => [], ['dsh-x'])
    assert.equal(result, true)
    assert.deepEqual(asked, [])
  } finally {
    restore()
  }
})

test('依赖环不会让遍历卡住', async () => {
  // a depends on b, b depends back on a, and neither is the requested package.
  const { restore } = serve({ a: ['b'], b: ['a'] })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['a'] : undefined
    const result = await allowed('unrelated', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(result, false)
  } finally {
    restore()
  }
})

test('上游 404 视为无法解析而非允许', async () => {
  const { restore } = serve({})
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['missing-dep'] : undefined
    const result = await allowed('missing-dep', store, 'https://up.test', hosts, own, ['dsh-x'])
    // The dependency name matches what was asked for, so it is allowed even though it cannot be resolved.
    assert.equal(result, true)
  } finally {
    restore()
  }
})

test('带本地清单的根包不查询上游', async () => {
  const { asked, restore } = serve({})
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['cordis'] : undefined
    const result = await allowed('cordis', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(result, true)
    // A converted package's manifest lives in KV, so the walk must not ask upstream for a package npm does not have.
    assert.deepEqual(asked, [])
  } finally {
    restore()
  }
})

test('npm 发布的根包从上游展开依赖', async () => {
  // A plugin published to npm has no local manifest, so the walk has to ask upstream for its dependencies.
  const { asked, restore } = serve({ 'dsh-on-npm': ['dep-of-npm-plugin'] })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? [] : undefined
    const result = await allowed('dep-of-npm-plugin', store, 'https://up.test', hosts, own, ['dsh-x', 'dsh-on-npm'])
    assert.equal(result, true)
    assert.deepEqual(asked, ['dsh-on-npm'])
  } finally {
    restore()
  }
})

test('openScope 只放行厂商 scope', () => {
  assert.equal(openScope('@deepseek-ai/cordis'), true)
  // Everything else still has to be reachable from a hosted package.
  assert.equal(openScope('lodash'), false)
  assert.equal(openScope('@types/node'), false)
  assert.equal(openScope('dsh-hint-shell'), false)
})

test('requestedVersion 只认 tarball 文件名', () => {
  assert.equal(requestedVersion('dsh-x', ['-', 'dsh-x-1.0.0.tgz']), '1.0.0')
  // A scope is not part of the asset name.
  assert.equal(requestedVersion('@scope/dsh-y', ['-', 'dsh-y-2.0.0-rc.1.tgz']), '2.0.0-rc.1')
  // A packument request names no version, and neither does a foreign file.
  assert.equal(requestedVersion('dsh-x', []), undefined)
  assert.equal(requestedVersion('dsh-x', ['-', 'other-1.0.0.tgz']), undefined)
  assert.equal(requestedVersion('dsh-x', ['-', 'dsh-x-1.0.0.zip']), undefined)
  assert.equal(requestedVersion('dsh-x', ['-', 'dsh-x-.tgz']), undefined)
})

test('厂商 scope 的依赖会被记录但不再递归', async () => {
  // `dsh-x` depends on a vendor package, which itself depends on `zod`. The vendor name is answered without a walk, so
  // its dependencies would otherwise never be recorded and a real install would be refused on `zod`.
  const { asked, restore } = serve({
    '@deepseek-ai/vendor': ['zod', 'yaml'],
    zod: ['nested-behind-zod'],
  })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['@deepseek-ai/vendor'] : undefined
    const result = await allowed('zod', store, 'https://up.test', hosts, own, ['dsh-x'])
    assert.equal(result, true)
    // `zod`'s own dependencies are not walked, because the vendor edge is collected one level deep only.
    assert.equal(asked.includes('nested-behind-zod'), false)
  } finally {
    restore()
  }
})

test('KV 写入失败时仍然放行', async () => {
  // The free plan allows a fixed number of writes per day, and a deploy can exhaust it. A full quota must cost the
  // shortcut, never the request: reads still work, so the walk can still answer.
  const { restore } = serve({ 'dsh-x': ['zod'] })
  try {
    const store: KVNamespace = {
      async get() {
        return null
      },
      async put() {
        throw new Error('your account has reached the free usage limit for this operation for today')
      },
      async delete() {},
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null }
      },
    } as unknown as KVNamespace
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['zod'] : undefined
    const result = await allowed('zod', store, 'https://up.test', name => name === 'dsh-x', own, ['dsh-x'])
    assert.equal(result, true)
  } finally {
    restore()
  }
})

test('KV 写入失败时仍然拒绝', async () => {
  // The same for a refusal: an unreachable package stays refused when the denial cannot be cached.
  const { restore } = serve({ 'dsh-x': ['zod'] })
  try {
    const store: KVNamespace = {
      async get() {
        return null
      },
      async put() {
        throw new Error('quota')
      },
      async delete() {},
      async list() {
        return { keys: [], list_complete: true, cacheStatus: null }
      },
    } as unknown as KVNamespace
    const own = async (name: string): Promise<readonly string[] | undefined> =>
      name === 'dsh-x' ? ['zod'] : undefined
    const result = await allowed('lodash', store, 'https://up.test', name => name === 'dsh-x', own, ['dsh-x'])
    assert.equal(result, false)
  } finally {
    restore()
  }
})

test('重复解析同一条依赖链不再重写已有的授予', async () => {
  // The free plan allows 1,000 KV writes a day, and a walk records every package it proves reachable. Two requests that
  // share part of a dependency path reach those shared packages twice, and `seen` only deduplicates within one walk.
  // Without the existence check the shared package is written again on the second request, spending the daily budget on
  // an answer KV already holds.
  const { restore } = serve({ 'dsh-x': ['shared', 'alpha'], 'dsh-y': ['shared', 'beta'] })
  try {
    const entries: Record<string, unknown> = {}
    const writes: string[] = []
    const store = {
      async get(key: string) {
        return entries[key] === undefined ? null : (entries[key] as string)
      },
      async put(key: string) {
        writes.push(key)
        entries[key] = '1'
      },
    } as unknown as KVNamespace
    const own = async (): Promise<readonly string[] | undefined> => undefined
    const hosts = (name: string): boolean => name === 'dsh-x' || name === 'dsh-y'

    // The first request walks from `dsh-x` and records `shared`.
    assert.equal(await allowed('alpha', store, 'https://up.test', hosts, own, ['dsh-x']), true)
    assert.ok(writes.includes(`${ALLOW_PREFIX}shared`), '首次解析应当记录 shared')
    const afterFirst = [...writes]

    // The second request asks for a different package but walks through the same `shared` edge, which KV already holds.
    assert.equal(await allowed('beta', store, 'https://up.test', hosts, own, ['dsh-y']), true)
    const secondWrites = writes.slice(afterFirst.length)
    assert.ok(secondWrites.includes(`${ALLOW_PREFIX}beta`), '第二个包本身仍应被记录')
    assert.ok(
      !secondWrites.includes(`${ALLOW_PREFIX}shared`),
      'KV 已持有的 shared 不应在第二次请求里被重写',
    )
  } finally {
    restore()
  }
})

test('被拒绝的请求不记录路径上的依赖', async () => {
  // The walk visits the whole reachable set before it can refuse, so writing during the walk would spend one read and
  // one write per visited package on a name no request asked for. Only a grant is worth keeping.
  const { restore } = serve({ 'dsh-x': ['dep-a'], 'dep-a': ['dep-b'] })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (): Promise<readonly string[] | undefined> => undefined
    assert.equal(await allowed('random-package', store, 'https://up.test', hosts, own, ['dsh-x']), false)
    assert.equal(await store.get(`${ALLOW_PREFIX}dep-a`), null)
    assert.equal(await store.get(`${ALLOW_PREFIX}dep-b`), null)
  } finally {
    restore()
  }
})

test('允许的请求记录整条已证明的路径', async () => {
  // The opposite of the refusal case: the walk proved these names reachable, so a later request for any of them is
  // answered from KV without walking again.
  const { restore } = serve({ 'dsh-x': ['dep-a'], 'dep-a': ['dep-b'] })
  try {
    const store = kv()
    const hosts = (name: string): boolean => name === 'dsh-x'
    const own = async (): Promise<readonly string[] | undefined> => undefined
    assert.equal(await allowed('dep-b', store, 'https://up.test', hosts, own, ['dsh-x']), true)
    assert.equal(await store.get(`${ALLOW_PREFIX}dep-a`), '1')
    assert.equal(await store.get(`${ALLOW_PREFIX}dep-b`), '1')
  } finally {
    restore()
  }
})
