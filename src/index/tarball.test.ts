import assert from 'node:assert/strict'
import test from 'node:test'
import { gunzipSync, gzipSync } from 'node:zlib'

import { readTarball } from './tarball.ts'

/**
 * Build one tar entry: a 512-byte header followed by the padded contents.
 * @param name - path inside the archive.
 * @param contents - file bytes.
 * @param type - tar type flag.
 * @returns the bytes of the entry.
 */
function entry(name: string, contents: string, type = '0'): Uint8Array {
  const body = new TextEncoder().encode(contents)
  const header = new Uint8Array(512)
  const write = (text: string, offset: number) => {
    header.set(new TextEncoder().encode(text), offset)
  }
  write(name, 0)
  // Size is octal ASCII in a 12-byte field, the last byte being NUL.
  write(`${body.byteLength.toString(8).padStart(11, '0')}\0`, 124)
  write(type, 156)
  write('ustar\0', 257)
  const padded = Math.ceil(body.byteLength / 512) * 512
  const block = new Uint8Array(512 + padded)
  block.set(header, 0)
  block.set(body, 512)
  return block
}

/**
 * Join entries and terminate the archive with two zero blocks.
 * @param blocks - the entries.
 * @returns the archive bytes.
 */
function archive(...blocks: Uint8Array[]): Uint8Array {
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0) + 1024
  const tar = new Uint8Array(total)
  let offset = 0
  for (const block of blocks) {
    tar.set(block, offset)
    offset += block.byteLength
  }
  return tar
}

test('readTarball 去掉 npm 的 package/ 前缀', () => {
  const files = readTarball(archive(entry('package/package.json', '{"name":"x"}')))
  assert.deepEqual([...files.keys()], ['package.json'])
  assert.equal(new TextDecoder().decode(files.get('package.json')), '{"name":"x"}')
})

test('readTarball 读出多个文件', () => {
  const files = readTarball(archive(
    entry('package/package.json', '{}'),
    entry('package/locale/en.json', '{"meta":{}}'),
  ))
  assert.deepEqual([...files.keys()].sort(), ['locale/en.json', 'package.json'])
})

test('readTarball 跳过目录条目', () => {
  const files = readTarball(archive(
    entry('package/locale/', '', '5'),
    entry('package/icon.svg', '<svg/>'),
  ))
  assert.deepEqual([...files.keys()], ['icon.svg'])
})

test('readTarball 在零块处停止', () => {
  // One real entry, then an all-zero terminator, then an entry that must not be read.
  const first = entry('package/a.txt', 'a')
  const trailing = entry('package/b.txt', 'b')
  const tar = new Uint8Array(first.byteLength + 1024 + trailing.byteLength)
  tar.set(first, 0)
  tar.set(trailing, first.byteLength + 1024)
  const files = readTarball(tar)
  assert.deepEqual([...files.keys()], ['a.txt'])
})

test('readTarball 读 gunzip 之后的字节', () => {
  // `readTarball` takes decompressed tar bytes, which is what the generator hands it after `gunzipSync`.
  const raw = archive(entry('package/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'))
  const files = readTarball(new Uint8Array(gunzipSync(gzipSync(Buffer.from(raw)))))
  assert.match(new TextDecoder().decode(files.get('icon.svg')), /^<svg/u)
})

test('readTarball 对空归档返回空映射', () => {
  assert.equal(readTarball(new Uint8Array(1024)).size, 0)
})
