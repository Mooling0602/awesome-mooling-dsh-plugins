import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { buildEntry, kvRecords, readManifest, type ManifestEntry } from './build.ts'
import type { Release } from '../releases.ts'

/** Build a minimal tar archive holding the given files. */
function tar(files: Record<string, string>): Uint8Array {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8')
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'utf8')
    header.write('0000000\0', 108, 8, 'utf8')
    header.write('0000000\0', 116, 8, 'utf8')
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    header.write('ustar\0', 257, 6, 'utf8')
    header.write('00', 263, 2, 'utf8')
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
    blocks.push(header, body)
    const padding = (512 - (body.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return new Uint8Array(gzipSync(Buffer.concat(blocks)))
}

const MANIFEST = { name: 'dsh-demo', version: '1.0.0', description: 'demo' }

test('readManifest 读出根目录 package.json', async () => {
  const bytes = tar({ 'package.json': JSON.stringify(MANIFEST), 'index.js': 'export {}' })
  assert.deepEqual(await readManifest(bytes), MANIFEST)
})

test('readManifest 容忍 package/ 前缀', async () => {
  const bytes = tar({ 'package/package.json': JSON.stringify(MANIFEST), 'package/index.js': 'export {}' })
  assert.deepEqual(await readManifest(bytes), MANIFEST)
})

test('readManifest 跳过排在前面的文件', async () => {
  const bytes = tar({ 'index.js': 'x'.repeat(1000), 'package.json': JSON.stringify(MANIFEST) })
  assert.deepEqual(await readManifest(bytes), MANIFEST)
})

test('readManifest 没有 package.json 就报错', async () => {
  const bytes = tar({ 'index.js': 'export {}' })
  await assert.rejects(() => readManifest(bytes), /no package\.json/u)
})

/** A release carrying one asset named after the package and version. */
function release(tag: string, name: string, version: string): Release {
  return {
    tag,
    draft: false,
    assets: [{ name: `${name}-${version}.tgz`, browser_download_url: `https://example.test/${name}-${version}.tgz` }],
  }
}

test('buildEntry 组装 packument 与 manifest 条目', async () => {
  const plugin = {
    id: 'dsh-demo',
    package: 'dsh-demo',
    source: 'github' as const,
    repo: 'https://github.com/Mooling0602/dsh-demo',
    dispatchType: 'tarball' as const,
    shard: 'dsh-de',
    file: 'p.yml',
  }
  const tarball = tar({ 'package/package.json': JSON.stringify(MANIFEST), 'package/index.js': 'export {}' })
  const original = globalThis.fetch
  globalThis.fetch = (async () => new Response(tarball)) as typeof globalThis.fetch
  try {
    const warnings: string[] = []
    const built = await buildEntry(plugin, [release('1.0.0', 'dsh-demo', '1.0.0')], message => warnings.push(message))
    assert.ok(built !== undefined)
    assert.equal(built.packument.name, 'dsh-demo')
    assert.deepEqual(built.packument['dist-tags'], { latest: '1.0.0' })
    assert.ok(built.packument.versions['1.0.0'] !== undefined)
    assert.equal(built.entry.repository, 'Mooling0602/dsh-demo')
    assert.equal(Object.keys(built.entry.versions).length, 1)
    assert.match(built.entry.versions['1.0.0'] ?? '', /^https:\/\/example\.test\//u)
    assert.match(built.entry.integrity['1.0.0'] ?? '', /^sha512-/u)
  } finally {
    globalThis.fetch = original
  }
})

test('buildEntry 没有可用资产时返回 undefined', async () => {
  const plugin = {
    id: 'dsh-demo',
    package: 'dsh-demo',
    source: 'github' as const,
    repo: 'https://github.com/Mooling0602/dsh-demo',
    dispatchType: 'tarball' as const,
    shard: 'dsh-de',
    file: 'p.yml',
  }
  const warnings: string[] = []
  const built = await buildEntry(plugin, [], message => warnings.push(message))
  assert.equal(built, undefined)
  assert.ok(warnings.some(message => message.includes('no release carries a usable tarball asset')))
})

test('ManifestEntry 的形状被测试锁住', () => {
  const entry: ManifestEntry = {
    name: 'a',
    repository: 'o/r',
    versions: { '1.0.0': 'https://example.test/a-1.0.0.tgz' },
    integrity: { '1.0.0': 'sha512-x' },
  }
  assert.equal(Object.keys(entry).sort().join(','), 'integrity,name,repository,versions')
})

test('kvRecords 产出的值能被 worker 直接使用', () => {
  const manifest = {
    builtAt: '2026-01-01T00:00:00.000Z',
    packages: {
      'dsh-demo': {
        name: 'dsh-demo',
        repository: 'Mooling0602/dsh-demo',
        versions: { '1.0.0': 'https://example.test/dsh-demo-1.0.0.tgz' },
        integrity: { '1.0.0': 'sha512-x' },
      },
    },
  }
  const packument = {
    name: 'dsh-demo',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'dsh-demo', version: '1.0.0' } },
    time: { '1.0.0': '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z' },
  }
  const records = kvRecords(manifest, new Map([['dsh-demo', packument]]))
  assert.equal(records.length, 1)
  assert.equal(records[0]?.key, 'dsh-demo')
  // The worker reads `{ packument, tarballs }`, so the record has to match `routes.ts`'s RegistryEntry exactly.
  const value = JSON.parse(records[0]?.value ?? '{}') as { packument: unknown; tarballs: Record<string, unknown> }
  assert.deepEqual(value.packument, packument)
  assert.deepEqual(value.tarballs, { '1.0.0': { tarball: 'https://example.test/dsh-demo-1.0.0.tgz' } })
})

test('kvRecords 跳过没有 packument 的包', () => {
  const manifest = {
    builtAt: '2026-01-01T00:00:00.000Z',
    packages: {
      a: { name: 'a', repository: 'o/a', versions: {}, integrity: {} },
    },
  }
  const records = kvRecords(manifest, new Map())
  // A package whose artifact failed to build must not become a KV key holding `"packument": undefined`.
  assert.equal(records.length, 1)
  assert.equal(JSON.parse(records[0]?.value ?? '{}').packument ?? null, null)
})
