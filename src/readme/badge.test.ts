import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  badgesFor,
  dshVersionOf,
  isPrerelease,
  licenseOf,
  ownBadgesOf,
  staticBadge,
  subjectOf,
  versionOf,
} from './badge.ts'

test('versionOf 加上 v 前缀', () => {
  assert.equal(versionOf({ version: '1.2.3' }), 'v1.2.3')
})

test('versionOf 不重复加前缀', () => {
  assert.equal(versionOf({ version: 'v1.2.3' }), 'v1.2.3')
})

test('versionOf 对缺失或非字符串返回 undefined', () => {
  assert.equal(versionOf({}), undefined)
  assert.equal(versionOf({ version: 1 }), undefined)
  assert.equal(versionOf({ version: '' }), undefined)
})

test('isPrerelease 识别 rc 等后缀', () => {
  assert.equal(isPrerelease('v1.0.0-rc.1'), true)
  assert.equal(isPrerelease('1.0.0-beta'), true)
  assert.equal(isPrerelease('v1.0.0'), false)
  assert.equal(isPrerelease(undefined), false)
})

test('isPrerelease 不把版本号里的连字符当预发布', () => {
  assert.equal(isPrerelease('v2.0.0'), false)
})

test('licenseOf 读字符串形式', () => {
  assert.equal(licenseOf({ license: 'MIT' }), 'MIT')
})

test('licenseOf 读旧的对象形式', () => {
  assert.equal(licenseOf({ license: { type: 'LGPL-3.0-only' } }), 'LGPL-3.0-only')
})

test('licenseOf 对缺失返回 undefined', () => {
  assert.equal(licenseOf({}), undefined)
  assert.equal(licenseOf({ license: '' }), undefined)
})

test('dshVersionOf 优先读 engines.dsh', () => {
  assert.equal(dshVersionOf({ engines: { dsh: '>=0.2.1-rc.4 <0.3.0' } }), '>=0.2.1-rc.4 <0.3.0')
})

test('dshVersionOf 在缺 engines.dsh 时从 peerDependencies 推断', () => {
  assert.equal(dshVersionOf({ peerDependencies: { '@deepseek-ai/cordis': '~4.0.5' } }), '~4.0.5')
})

test('dshVersionOf 忽略非 DSH 的 peer 依赖', () => {
  assert.equal(dshVersionOf({ peerDependencies: { react: '^18' } }), undefined)
})

test('dshVersionOf 在多个不同范围时返回 undefined', () => {
  const manifest = { peerDependencies: { '@deepseek-ai/a': '^1.0.0', '@deepseek-ai/b': '^2.0.0' } }
  assert.equal(dshVersionOf(manifest), undefined)
})

test('dshVersionOf 在多个相同范围时返回该范围', () => {
  const manifest = { peerDependencies: { '@deepseek-ai/a': '^1.0.0', '@deepseek-ai/b': '^1.0.0' } }
  assert.equal(dshVersionOf(manifest), '^1.0.0')
})

test('dshVersionOf 对空 manifest 返回 undefined', () => {
  assert.equal(dshVersionOf({}), undefined)
})

test('ownBadgesOf 只保留 shields.io 图片', () => {
  const readme = '![](https://img.shields.io/badge/a-b-blue) ![](https://example.test/x.svg)'
  assert.deepEqual(ownBadgesOf(readme), ['https://img.shields.io/badge/a-b-blue'])
})

test('ownBadgesOf 去重并保持首次出现顺序', () => {
  const readme = '![](https://img.shields.io/badge/z-z-red) ![](https://img.shields.io/badge/a-a-blue) ![](https://img.shields.io/badge/z-z-red)'
  assert.deepEqual(ownBadgesOf(readme), ['https://img.shields.io/badge/z-z-red', 'https://img.shields.io/badge/a-a-blue'])
})

test('ownBadgesOf 对没有徽标的 README 返回空数组', () => {
  assert.deepEqual(ownBadgesOf('# hi\n\ntext'), [])
})

test('staticBadge 转义空格与分隔符', () => {
  assert.equal(staticBadge('a b', 'c-d', 'blue'), 'https://img.shields.io/badge/a_b-c--d-blue')
})

test('staticBadge 下划线也被转义', () => {
  assert.equal(staticBadge('a_b', 'c', 'blue'), 'https://img.shields.io/badge/a__b-c-blue')
})

test('badgesFor 按顺序给出全部徽标', () => {
  const badges = badgesFor({
    version: 'v1.0.0',
    prerelease: false,
    ci: true,
    license: 'MIT',
    dshVersion: '^0.2.0',
    own: ['https://img.shields.io/badge/x-x-red'],
  })
  assert.equal(badges.length, 5)
  assert.match(badges[0] ?? '', /version/u)
  assert.match(badges[1] ?? '', /passing/u)
  assert.match(badges[2] ?? '', /MIT/u)
  assert.match(badges[3] ?? '', /4D6BFE/u)
  assert.equal(badges[4], 'https://img.shields.io/badge/x-x-red')
})

test('badgesFor 用 pre-release 标签', () => {
  assert.match(badgesFor({ version: 'v1.0.0-rc.1', prerelease: true })[0] ?? '', /pre--release/u)
})

test('badgesFor 对 CI 失败给出 failing', () => {
  assert.match(badgesFor({ ci: false })[0] ?? '', /failing/u)
})

test('badgesFor 在没有任何事实时返回空数组', () => {
  assert.deepEqual(badgesFor({}), [])
})

test('badgesFor 跳过 undefined 的事实', () => {
  const badges = badgesFor({ license: 'MIT' })
  assert.equal(badges.length, 1)
  assert.match(badges[0] ?? '', /MIT/u)
})

test('subjectOf 认出各类主题', () => {
  assert.equal(subjectOf('https://img.shields.io/badge/version-v1.0.0-blue'), 'version')
  assert.equal(subjectOf('https://img.shields.io/badge/license-MIT-blue'), 'license')
  assert.equal(subjectOf('https://img.shields.io/github/license/a/b'), 'license')
  assert.equal(subjectOf('https://img.shields.io/badge/ci-passing-brightgreen'), 'ci')
  assert.equal(subjectOf('https://img.shields.io/badge/dsh-%5E0.2.0-4D6BFE'), 'dsh')
})

test('subjectOf 把 powered_by-dsh 认作 dsh 主题', () => {
  assert.equal(subjectOf('https://img.shields.io/badge/powered_by-dsh-4D6BFE'), 'dsh')
})

test('subjectOf 对无关徽标返回 undefined', () => {
  assert.equal(subjectOf('https://img.shields.io/badge/made_with-love-red'), undefined)
})

test('badgesFor 丢掉被自动徽标覆盖的同主题自带徽标', () => {
  const badges = badgesFor({
    version: 'v1.0.0',
    license: 'MIT',
    own: ['https://img.shields.io/github/license/a/b'],
  })
  assert.equal(badges.length, 2)
  assert.doesNotMatch(badges[1] ?? '', /github\/license/u)
})

test('badgesFor 保留没撞主题的自带徽标', () => {
  const badges = badgesFor({
    license: 'MIT',
    own: ['https://img.shields.io/badge/made_with-love-red'],
  })
  assert.equal(badges.length, 2)
  assert.match(badges[1] ?? '', /made_with-love/u)
})

test('badgesFor 在没有自动 license 时保留自带 license 徽标', () => {
  const badges = badgesFor({ own: ['https://img.shields.io/github/license/a/b'] })
  assert.equal(badges.length, 1)
  assert.match(badges[0] ?? '', /license/u)
})

test('badgesFor 对自带徽标内部去重', () => {
  const url = 'https://img.shields.io/badge/made_with-love-red'
  assert.deepEqual(badgesFor({ own: [url, url] }), [url])
})
