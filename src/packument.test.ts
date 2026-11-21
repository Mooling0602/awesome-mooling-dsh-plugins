import { test } from 'node:test'
import assert from 'node:assert/strict'
import { abridge, buildPackument, versionRecord, type TarballVersion } from './packument.ts'

function entry(version: string, overrides: Partial<TarballVersion['manifest']> = {}): TarballVersion {
  return {
    manifest: { name: 'dsh-x', version, license: 'MIT', ...overrides },
    tarball: `https://reg.example/dsh-x/-/dsh-x-${version}.tgz`,
    integrity: { integrity: `sha512-${version}`, shasum: 'a'.repeat(40) },
    published: '2026-01-01T00:00:00.000Z',
  }
}

test('versionRecord 带 dist 三个字段', () => {
  const record = versionRecord(entry('1.0.0'))
  assert.deepEqual(record['dist'], {
    tarball: 'https://reg.example/dsh-x/-/dsh-x-1.0.0.tgz',
    integrity: 'sha512-1.0.0',
    shasum: 'a'.repeat(40),
  })
  assert.equal(record['name'], 'dsh-x')
  assert.equal(record['version'], '1.0.0')
})

test('versionRecord 透传 license 与 engines', () => {
  const record = versionRecord(entry('1.0.0', { engines: { dsh: '>=0.2.1-rc.4 <0.3.0' } }))
  assert.equal(record['license'], 'MIT')
  assert.deepEqual(record['engines'], { dsh: '>=0.2.1-rc.4 <0.3.0' })
})

test('versionRecord 保留 dsh.bundle', () => {
  const record = versionRecord(entry('1.0.0', { dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  assert.deepEqual(record['dsh'], { bundle: { patch: './cordis.patch.yml' } })
})

test('versionRecord 不写 undefined 字段', () => {
  const record = versionRecord(entry('1.0.0'))
  assert.ok(!('homepage' in record))
  assert.ok(!('keywords' in record))
})

test('buildPackument 设 dist-tags.latest 为最高版本', () => {
  const doc = buildPackument('dsh-x', [entry('1.0.0'), entry('2.0.0'), entry('1.5.0')])
  assert.equal(doc['dist-tags'].latest, '2.0.0')
  assert.deepEqual(Object.keys(doc['versions']).sort(), ['1.0.0', '1.5.0', '2.0.0'])
})

test('buildPackument 用 SemVer 而不是字典序挑 latest', () => {
  const doc = buildPackument('dsh-x', [entry('1.0.0-rc.3'), entry('1.0.0')])
  assert.equal(doc['dist-tags'].latest, '1.0.0')
})

test('buildPackument 允许显式指定 latest', () => {
  const doc = buildPackument('dsh-x', [entry('1.0.0'), entry('2.0.0')], '1.0.0')
  assert.equal(doc['dist-tags'].latest, '1.0.0')
})

test('buildPackument 拒绝空的版本列表', () => {
  assert.throws(() => buildPackument('dsh-x', []), /at least one version/u)
})

test('buildPackument 拒绝名字不符的 manifest', () => {
  const wrong = { ...entry('1.0.0'), manifest: { name: 'dsh-y', version: '1.0.0' } }
  assert.throws(() => buildPackument('dsh-x', [wrong]), /names "dsh-y"/u)
})

test('buildPackument 拒绝重复版本', () => {
  assert.throws(() => buildPackument('dsh-x', [entry('1.0.0'), entry('1.0.0')]), /duplicate version/u)
})

test('buildPackument 拒绝不在列表里的 latest', () => {
  assert.throws(() => buildPackument('dsh-x', [entry('1.0.0')], '9.9.9'), /not one of the published versions/u)
})

test('abridge 返回同样的文档', () => {
  const doc = buildPackument('dsh-x', [entry('1.0.0')])
  assert.deepEqual(abridge(doc), doc)
})

test('buildPackument 为每个版本写 time', () => {
  const doc = buildPackument('dsh-x', [entry('1.0.0'), entry('2.0.0')])
  // The generator skips any version whose `packument.time[version]` is not a string, so this field is what makes the
  // index list this registry's plugins at all.
  assert.equal(typeof doc.time['1.0.0'], 'string')
  assert.equal(typeof doc.time['2.0.0'], 'string')
  assert.equal(doc.time['1.0.0'], '2026-01-01T00:00:00.000Z')
})

test('buildPackument 的 modified 是最新的发布时间', () => {
  const older = { ...entry('1.0.0'), published: '2026-01-01T00:00:00.000Z' }
  const newer = { ...entry('2.0.0'), published: '2026-06-01T00:00:00.000Z' }
  const doc = buildPackument('dsh-x', [older, newer])
  assert.equal(doc.time['modified'], '2026-06-01T00:00:00.000Z')
})

test('buildPackument 保留每个版本各自的发布时间而不是统一值', () => {
  const first = { ...entry('1.0.0'), published: '2025-03-04T05:06:07.000Z' }
  const second = { ...entry('2.0.0'), published: '2026-07-08T09:10:11.000Z' }
  const doc = buildPackument('dsh-x', [first, second])
  assert.equal(doc.time['1.0.0'], '2025-03-04T05:06:07.000Z')
  assert.equal(doc.time['2.0.0'], '2026-07-08T09:10:11.000Z')
})
