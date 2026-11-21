import { test } from 'node:test'
import assert from 'node:assert/strict'
import { indexModeOf, isNpmPackage, needsConversion, renderSources } from './sources.ts'
import type { Plugin } from './metadata.ts'

function plugin(id: string, source: Plugin['source'], dispatchType: Plugin['dispatchType']): Plugin {
  return {
    id,
    package: id,
    source,
    repo: `https://github.com/Mooling0602/${id}`,
    dispatchType,
    shard: 'dsh-xx',
    file: 'p.yml',
  }
}

test('indexModeOf 对 npmjs 和 tarball 都是 npm', () => {
  assert.equal(indexModeOf(plugin('dsh-a1', 'npm', 'npmjs')), 'npm')
  assert.equal(indexModeOf(plugin('dsh-a1', 'github', 'tarball')), 'npm')
})

test('indexModeOf 对 source 是 git', () => {
  assert.equal(indexModeOf(plugin('dsh-a1', 'github', 'source')), 'git')
})

test('indexModeOf 只看 dispatch-type', () => {
  assert.equal(indexModeOf(plugin('dsh-a1', 'npm', 'source')), 'git')
  assert.equal(indexModeOf(plugin('dsh-a1', 'github', 'npmjs')), 'npm')
})

test('needsConversion 只对 tarball 为真', () => {
  assert.equal(needsConversion(plugin('dsh-a1', 'github', 'tarball')), true)
  assert.equal(needsConversion(plugin('dsh-a1', 'npm', 'npmjs')), false)
  assert.equal(needsConversion(plugin('dsh-a1', 'github', 'source')), false)
})

test('isNpmPackage 只对 source: npm 为真', () => {
  assert.equal(isNpmPackage(plugin('dsh-a1', 'npm', 'npmjs')), true)
  assert.equal(isNpmPackage(plugin('dsh-a1', 'github', 'tarball')), false)
  assert.equal(isNpmPackage(plugin('dsh-a1', 'github', 'source')), false)
})

test('renderSources 对 npmjs 插件写包名', () => {
  assert.equal(renderSources([plugin('dsh-a1', 'npm', 'npmjs')]), 'dsh-a1\n')
})

test('renderSources 对 tarball 插件写包名', () => {
  // tarball 经 CF Workers 变成 npm 包，索引必须指向 npm 源才能被 pnpm 拉到。
  assert.equal(renderSources([plugin('dsh-a1', 'github', 'tarball')]), 'dsh-a1\n')
})

test('renderSources 对 source 插件写仓库地址', () => {
  assert.equal(renderSources([plugin('dsh-a1', 'github', 'source')]), 'https://github.com/Mooling0602/dsh-a1\n')
})

test('renderSources 只有 source 一类写仓库地址', () => {
  const lines = renderSources([
    plugin('dsh-a1', 'github', 'source'),
    plugin('dsh-b2', 'npm', 'npmjs'),
    plugin('dsh-c3', 'github', 'tarball'),
  ])
  assert.deepEqual(lines.trimEnd().split('\n'), [
    'https://github.com/Mooling0602/dsh-a1',
    'dsh-b2',
    'dsh-c3',
  ])
})

test('renderSources 用 package 而不是 id 当包名', () => {
  const custom = { ...plugin('dsh-a1', 'github', 'tarball'), package: 'other-name' }
  assert.equal(renderSources([custom]), 'other-name\n')
})

test('renderSources 用 repo 而不是拼地址', () => {
  const custom = { ...plugin('dsh-a1', 'github', 'source'), repo: 'https://github.com/SomeoneElse/thing' }
  assert.equal(renderSources([custom]), 'https://github.com/SomeoneElse/thing\n')
})

test('renderSources 空列表产出空字符串', () => {
  assert.equal(renderSources([]), '')
})

test('renderSources 末尾恰好一个换行', () => {
  const text = renderSources([plugin('dsh-a1', 'github', 'source')])
  assert.ok(text.endsWith('\n'))
  assert.ok(!text.endsWith('\n\n'))
})
