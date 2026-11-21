import assert from 'node:assert/strict'
import test from 'node:test'

import { moved } from './changed.ts'

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
