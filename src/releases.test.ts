import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareVersions, downloadableVersions, parseTag, repositoryPath } from './releases.ts'

test('parseTag 接受裸版本与 v 前缀', () => {
  assert.equal(parseTag('1.2.3'), '1.2.3')
  assert.equal(parseTag('v1.2.3'), '1.2.3')
  assert.equal(parseTag('1.0.0-rc.3'), '1.0.0-rc.3')
  assert.equal(parseTag('v1.0.0-alpha.1'), '1.0.0-alpha.1')
})

test('parseTag 拒绝非版本 tag', () => {
  assert.equal(parseTag('latest'), undefined)
  assert.equal(parseTag('release-1'), undefined)
  assert.equal(parseTag('1.2'), undefined)
  assert.equal(parseTag('1.2.3.4'), undefined)
  assert.equal(parseTag(''), undefined)
})

test('compareVersions 比较主次修订号', () => {
  assert.ok(compareVersions('1.0.0', '2.0.0') < 0)
  assert.ok(compareVersions('2.0.0', '1.0.0') > 0)
  assert.ok(compareVersions('1.2.0', '1.1.9') > 0)
  assert.ok(compareVersions('1.2.3', '1.2.3') === 0)
})

test('compareVersions 让正式版高于同号预发布', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0)
})

test('compareVersions 按字母序比较预发布标识', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-beta') < 0)
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.2') < 0)
  assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10') < 0)
})

test('compareVersions 让短预发布后缀排在前面', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0)
})

test('compareVersions 让数字标识低于字母标识', () => {
  assert.ok(compareVersions('1.0.0-1', '1.0.0-alpha') < 0)
})

test('compareVersions 复现 dsh-web-file-uploader 的真实顺序', () => {
  const versions = [
    '0.4.0', '0.4.1', '0.4.2', '0.4.3',
    '1.0.0-alpha.1', '1.0.0-alpha.2', '1.0.0-alpha.3', '1.0.0-alpha.4', '1.0.0-alpha.5',
    '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0-rc.3',
  ]
  const sorted = [...versions].sort((left, right) => compareVersions(right, left))
  assert.equal(sorted[0], '1.0.0-rc.3')
  assert.equal(sorted.at(-1), '0.4.0')
  assert.deepEqual([...sorted].reverse(), versions)
})

test('repositoryPath 取 owner/repo', () => {
  assert.equal(repositoryPath('https://github.com/Mooling0602/dsh-mloader'), 'Mooling0602/dsh-mloader')
  assert.equal(repositoryPath('https://github.com/o/r.git'), 'o/r')
  assert.equal(repositoryPath('https://github.com/o/r/'), 'o/r')
})

test('repositoryPath 拒绝非 GitHub 或非 https 的 URL', () => {
  assert.throws(() => repositoryPath('http://github.com/o/r'), /https:\/\/github\.com/u)
  assert.throws(() => repositoryPath('https://gitlab.com/o/r'), /https:\/\/github\.com/u)
  assert.throws(() => repositoryPath('https://github.com/onlyowner'), /<owner>\/<repo>/u)
  assert.throws(() => repositoryPath('not a url'), /not a URL/u)
})

test('downloadableVersions 按资产名挑版本', () => {
  const warnings: string[] = []
  const found = downloadableVersions('dsh-x', [
    { tag: '1.0.0', draft: false, assets: [{ name: 'dsh-x-1.0.0.tgz', browser_download_url: 'https://e/1.tgz' }] },
    { tag: '0.9.0', draft: false, assets: [{ name: 'dsh-x-0.9.0.tgz', browser_download_url: 'https://e/0.tgz' }] },
  ], message => warnings.push(message))
  assert.deepEqual(found.map(entry => entry.version), ['1.0.0', '0.9.0'])
  assert.deepEqual(warnings, [])
})

test('downloadableVersions 跳过草稿', () => {
  const found = downloadableVersions('dsh-x', [
    { tag: '1.0.0', draft: true, assets: [{ name: 'dsh-x-1.0.0.tgz', browser_download_url: 'https://e/1.tgz' }] },
  ], () => {})
  assert.deepEqual(found, [])
})

test('downloadableVersions 跳过没有资产的 release 并记录原因', () => {
  const warnings: string[] = []
  const found = downloadableVersions('dsh-x', [
    { tag: '0.4.3', draft: false, assets: [] },
  ], message => warnings.push(message))
  assert.deepEqual(found, [])
  assert.match(warnings[0] as string, /no dsh-x-0\.4\.3\.tgz asset/u)
})

test('downloadableVersions 跳过非版本 tag 并记录原因', () => {
  const warnings: string[] = []
  downloadableVersions('dsh-x', [{ tag: 'latest', draft: false, assets: [] }], message => warnings.push(message))
  assert.match(warnings[0] as string, /not a version/u)
})

test('downloadableVersions 忽略重复版本', () => {
  const warnings: string[] = []
  const found = downloadableVersions('dsh-x', [
    { tag: '1.0.0', draft: false, assets: [{ name: 'dsh-x-1.0.0.tgz', browser_download_url: 'https://e/1.tgz' }] },
    { tag: 'v1.0.0', draft: false, assets: [{ name: 'dsh-x-1.0.0.tgz', browser_download_url: 'https://e/2.tgz' }] },
  ], message => warnings.push(message))
  assert.equal(found.length, 1)
  assert.match(warnings[0] as string, /duplicate release/u)
})

test('downloadableVersions 结果按新到旧排序', () => {
  const found = downloadableVersions('dsh-x', [
    { tag: '0.9.0', draft: false, assets: [{ name: 'dsh-x-0.9.0.tgz', browser_download_url: 'https://e/0.tgz' }] },
    { tag: '1.0.0', draft: false, assets: [{ name: 'dsh-x-1.0.0.tgz', browser_download_url: 'https://e/1.tgz' }] },
    { tag: '1.0.0-rc.1', draft: false, assets: [{ name: 'dsh-x-1.0.0-rc.1.tgz', browser_download_url: 'https://e/rc.tgz' }] },
  ], () => {})
  assert.deepEqual(found.map(entry => entry.version), ['1.0.0', '1.0.0-rc.1', '0.9.0'])
})
