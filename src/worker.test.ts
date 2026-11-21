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

/** A KV namespace backed by a plain map. */
function kv(entries: Record<string, unknown>): KVNamespace {
  return {
    async get(key: string, type?: string) {
      const value = entries[key]
      if (value === undefined) return null
      return type === 'json' ? value : JSON.stringify(value)
    },
  } as unknown as KVNamespace
}

function env(entries: Record<string, unknown> = { 'dsh-hint-shell': ENTRY }, upstream?: string): Env {
  return upstream === undefined ? { REGISTRY: kv(entries) } : { REGISTRY: kv(entries), UPSTREAM: upstream }
}

/** Run one request against a handler, with fetch stubbed for the proxy path. */
async function request(
  url: string,
  entries?: Record<string, unknown>,
  upstream?: string,
): Promise<{ response: Response; proxied: string[] }> {
  const proxied: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    proxied.push(String(input))
    return new Response('{"from":"upstream"}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof globalThis.fetch
  try {
    const response = await handle(new Request(url), env(entries, upstream))
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

test('tarball 请求 302 到 GitHub 资产', async () => {
  const { response, proxied } = await request('https://reg.test/dsh-hint-shell/-/dsh-hint-shell-0.1.1.tgz')
  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get('location'),
    'https://github.com/Mooling0602/dsh-hint-shell/releases/download/0.1.1/dsh-hint-shell-0.1.1.tgz',
  )
  assert.deepEqual(proxied, [])
})

test('未托管的包代理回上游', async () => {
  const { response, proxied } = await request('https://reg.test/@deepseek-ai%2Fcordis')
  assert.equal(await response.text(), '{"from":"upstream"}')
  assert.equal(proxied.length, 1)
  assert.match(proxied[0] ?? '', /^https:\/\/registry\.npmjs\.org\//u)
})

test('未托管时保留查询串', async () => {
  const { proxied } = await request('https://reg.test/dsh-other?write=true')
  assert.match(proxied[0] ?? '', /\?write=true$/u)
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
  const { proxied } = await request('https://reg.test/dsh-other', {}, 'https://mirror.test')
  assert.match(proxied[0] ?? '', /^https:\/\/mirror\.test\//u)
})

test('代理不改写路径', async () => {
  const { proxied } = await request('https://reg.test/@scope%2Fname')
  assert.match(proxied[0] ?? '', /\/@scope%2Fname$/u)
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
