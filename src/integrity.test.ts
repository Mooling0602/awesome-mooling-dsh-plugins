import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { integrityOf } from './integrity.ts'

test('integrityOf 产出 sha512 base64 与 sha1 十六进制', () => {
  const bytes = new TextEncoder().encode('hello')
  const result = integrityOf(bytes)
  assert.match(result.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/u)
  assert.match(result.shasum, /^[0-9a-f]{40}$/u)
})

test('integrityOf 与直接计算一致', () => {
  const bytes = new TextEncoder().encode('the quick brown fox')
  const result = integrityOf(bytes)
  assert.equal(result.integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`)
  assert.equal(result.shasum, createHash('sha1').update(bytes).digest('hex'))
})

test('integrityOf 对空输入也稳定', () => {
  const result = integrityOf(new Uint8Array())
  assert.equal(result.integrity, `sha512-${createHash('sha512').update('').digest('base64')}`)
  assert.equal(result.shasum, 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
})

test('integrityOf 对内容敏感', () => {
  const a = integrityOf(new TextEncoder().encode('a'))
  const b = integrityOf(new TextEncoder().encode('b'))
  assert.notEqual(a.integrity, b.integrity)
  assert.notEqual(a.shasum, b.shasum)
})

test('integrityOf 对真实 gzip 字节可用', () => {
  const original = new TextEncoder().encode('{"name":"dsh-x","version":"1.0.0"}')
  const bytes = new Uint8Array(gzipSync(original))
  const result = integrityOf(bytes)
  assert.match(result.integrity, /^sha512-/u)
  // 同样的字节必须给出同样的哈希，否则 lockfile 会失效。
  assert.deepEqual(integrityOf(bytes), result)
})
