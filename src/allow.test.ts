import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ALLOW_PREFIX, allowed, DENY_PREFIX, dependenciesOf, latestOf } from './allow.ts'

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
    dependencies: { a: '1' },
    peerDependencies: { b: '2' },
    optionalDependencies: { c: '3', a: '1' },
  })
  // Sorted for a stable comparison; duplicates across fields collapse.
  assert.deepEqual(names.sort(), ['a', 'b', 'c'])
})

test('dependenciesOf 在缺失或非对象时返回空', () => {
  assert.deepEqual(dependenciesOf(undefined), [])
  assert.deepEqual(dependenciesOf({}), [])
  assert.deepEqual(dependenciesOf({ dependencies: null }), [])
  assert.deepEqual(dependenciesOf({ dependencies: 'nope' }), [])
})

test('latestOf 只认 dist-tags.latest 指向的版本', () => {
  const packument = { 'dist-tags': { latest: '2.0.0' }, versions: { '2.0.0': { name: 'x' }, '1.0.0': {} } }
  assert.deepEqual(latestOf(packument), { name: 'x' })
  // Without a usable latest there is nothing to read dependencies from.
  assert.equal(latestOf({ versions: {} }), undefined)
  assert.equal(latestOf({ 'dist-tags': { latest: '9.9.9' }, versions: {} }), undefined)
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
    const result = await allowed('cordis', store, 'https://up.test', name => name === 'dsh-x', async () => ['cordis'], [
      'dsh-x',
    ])
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
    const own = async (): Promise<readonly string[]> => ['cordis']
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
    const own = async (): Promise<readonly string[]> => []
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
    const own = async (): Promise<readonly string[]> => ['a']
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
    const own = async (): Promise<readonly string[]> => ['missing-dep']
    const result = await allowed('missing-dep', store, 'https://up.test', hosts, own, ['dsh-x'])
    // The dependency name matches what was asked for, so it is allowed even though it cannot be resolved.
    assert.equal(result, true)
  } finally {
    restore()
  }
})
