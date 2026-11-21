import assert from 'node:assert/strict'
import test from 'node:test'

import { compareVersions } from './build.ts'
import { displayFrom, iconOf, localeFields, localized, person } from './display.ts'

test('compareVersions 按 SemVer 优先级排序', () => {
  const sorted = ['0.1.0', '0.10.0', '0.2.0', '1.0.0', '1.0.0-rc.2', '1.0.0-rc.1', '1.0.0-alpha.10', '1.0.0-alpha.2']
    .sort(compareVersions)
  assert.deepEqual(sorted, ['0.1.0', '0.2.0', '0.10.0', '1.0.0-alpha.2', '1.0.0-alpha.10', '1.0.0-rc.1', '1.0.0-rc.2', '1.0.0'])
})

test('compareVersions 让正式版高于预发布版', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0)
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})

test('compareVersions 把数字标识排在字母标识之前', () => {
  assert.ok(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.beta') < 0)
})

test('localeFields 读 meta 里的标题和描述', () => {
  const fields = localeFields(JSON.stringify({ meta: { title: '标题', description: '描述' } }))
  assert.deepEqual(fields, { title: '标题', description: '描述' })
})

test('localeFields 忽略没有 meta 的文件', () => {
  assert.deepEqual(localeFields('{}'), {})
  assert.deepEqual(localeFields(JSON.stringify({ other: 1 })), {})
})

test('localized 只有一个英文值时返回字符串', () => {
  const locales = new Map([['en', { title: 'Plugin' }]])
  assert.equal(localized('title', locales, undefined), 'Plugin')
})

test('localized 有多种语言时返回以 en 开头的映射', () => {
  const locales = new Map([['en', { title: 'Plugin' }], ['zh', { title: '插件' }]])
  assert.deepEqual(localized('title', locales, undefined), { en: 'Plugin', zh: '插件' })
})

test('localized 在没有英文时退回 manifest 值', () => {
  const locales = new Map([['zh', { title: '插件' }]])
  assert.deepEqual(localized('title', locales, 'Fallback'), { en: 'Fallback', zh: '插件' })
})

test('localized 在没有英文也没有回退时返回 undefined', () => {
  const locales = new Map([['zh', { title: '插件' }]])
  assert.equal(localized('title', locales, undefined), undefined)
})

test('person 从 npm 的 person 字符串里只保留名字', () => {
  assert.equal(person('Mooling0602 <a@b.c> (https://example.test)'), 'Mooling0602')
  assert.equal(person({ name: 'Mooling0602', email: 'a@b.c' }), 'Mooling0602')
  assert.equal(person(undefined), undefined)
})

test('iconOf 生成 data URL 并拒绝过大的图标', () => {
  const svg = new TextEncoder().encode('<svg/>')
  assert.match(iconOf(svg, '.svg') ?? '', /^data:image\/svg\+xml;base64,/u)
  assert.equal(iconOf(svg, '.txt'), undefined)
  assert.equal(iconOf(new Uint8Array(300 * 1024), '.png'), undefined)
})

test('displayFrom 在没有 locale 时用包名作标题', () => {
  const display = displayFrom(new Map(), { name: 'dsh-example' })
  assert.equal(display.title, 'dsh-example')
})

test('displayFrom 丢弃不是 http(s) 的 homepage', () => {
  const display = displayFrom(new Map(), { name: 'x', homepage: 'ftp://example.test/' })
  assert.equal(display.homepage, undefined)
})

test('displayFrom 保留合法的 homepage', () => {
  const display = displayFrom(new Map(), { name: 'x', homepage: 'https://example.test/' })
  assert.equal(display.homepage, 'https://example.test/')
})

test('displayFrom 从 exports 声明的 locale 目录读标题', () => {
  const files = new Map<string, Uint8Array>([
    ['i18n/en.json', new TextEncoder().encode(JSON.stringify({ meta: { title: 'From locale' } }))],
  ])
  const display = displayFrom(files, { name: 'x', exports: { './locale/*.json': './i18n/*.json' } })
  assert.equal(display.title, 'From locale')
})

test('displayFrom 从 exports 声明的图标路径读图标', () => {
  const files = new Map<string, Uint8Array>([
    ['assets/logo.svg', new TextEncoder().encode('<svg/>')],
  ])
  const display = displayFrom(files, { name: 'x', exports: { './icon': './assets/logo.svg' } })
  assert.match(display.icon ?? '', /^data:image\/svg\+xml;base64,/u)
})
