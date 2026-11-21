import assert from 'node:assert/strict'
import test from 'node:test'

import { advertises, moved, newestOf } from './changed.ts'

const INDEX = {
  format: 1,
  title: { en: 'Plugins' },
  plugins: [
    { name: 'a', versions: [{ version: '1.0.0', publishTimestamp: 1 }] },
    { name: 'b', versions: [{ version: '2.0.0', publishTimestamp: 2 }] },
  ],
}

test('moved 对相同索引返回 false', () => {
  assert.equal(moved(INDEX, structuredClone(INDEX)), false)
})

test('moved 对新增版本返回 true', () => {
  const remote = structuredClone(INDEX)
  remote.plugins[0]?.versions.push({ version: '1.1.0', publishTimestamp: 3 })
  assert.equal(moved(INDEX, remote), true)
})

test('moved 对新增插件返回 true', () => {
  const remote = structuredClone(INDEX)
  remote.plugins.push({ name: 'c', versions: [] })
  assert.equal(moved(INDEX, remote), true)
})

test('moved 对改动显示信息返回 true', () => {
  const remote = structuredClone(INDEX)
  remote.title.en = 'Plugins 2'
  assert.equal(moved(INDEX, remote), true)
})

test('moved 把键顺序不同视为变化', () => {
  // `JSON.stringify` keeps insertion order, so a body whose keys were reordered compares as different. Both sides of a
  // real comparison come from the same code path — the worker serves what this generator wrote — so this only ever
  // reports a change that the generator itself made, which is a change worth publishing.
  const reordered = Object.fromEntries(Object.entries(INDEX).reverse()) as typeof INDEX
  assert.equal(moved(INDEX, reordered), true)
})

test('moved 对空插件列表与有内容的索引返回 true', () => {
  assert.equal(moved({ format: 1, title: { en: 'x' }, plugins: [] }, INDEX), true)
})

test('newestOf 只挑被转换的包', () => {
  // The index also lists plugins published to npm and plugins installed from their repository. Neither is converted
  // here, so checking them would report a clean registry as broken.
  const newest = newestOf(INDEX, new Set(['a']))
  assert.deepEqual(newest, [['a', '1.0.0']])
})

test('newestOf 取列表第一个版本作为最新', () => {
  // The index lists versions newest first, which is what makes the first entry the default install.
  const index = { plugins: [{ name: 'a', versions: [{ version: '2.0.0' }, { version: '1.0.0' }] }] }
  assert.deepEqual(newestOf(index, new Set(['a'])), [['a', '2.0.0']])
})

test('newestOf 忽略结构异常的条目', () => {
  const index = { plugins: [{ name: 'a' }, { versions: [{ version: '1.0.0' }] }, { name: 'c', versions: [] }] }
  assert.deepEqual(newestOf(index, new Set(['a', 'c'])), [])
})

test('newestOf 对不是索引的输入返回空', () => {
  assert.deepEqual(newestOf({}, new Set(['a'])), [])
  assert.deepEqual(newestOf(null, new Set(['a'])), [])
})

test('advertises 认这个 registry 的地址', () => {
  const packument = { versions: { '1.0.0': { dist: { tarball: 'https://mynpm.staringplanet.top/a/-/a-1.0.0.tgz' } } } }
  assert.equal(advertises(packument, '1.0.0'), true)
})

test('advertises 拒绝 release asset 地址', () => {
  // This is the inconsistency the check exists for: the version is listed, but installing it would pin the lockfile to
  // the origin the registry is meant to replace.
  const packument = { versions: { '1.0.0': { dist: { tarball: 'https://github.com/x/a/releases/download/1.0.0/a-1.0.0.tgz' } } } }
  assert.equal(advertises(packument, '1.0.0'), false)
})

test('advertises 拒绝缺版本或缺 dist 的 packument', () => {
  assert.equal(advertises({ versions: {} }, '1.0.0'), false)
  assert.equal(advertises({ versions: { '1.0.0': {} } }, '1.0.0'), false)
  assert.equal(advertises(null, '1.0.0'), false)
})
