import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLACEHOLDER, TARGETS, readmePathFor, renderEntry, renderReadme, renderTarget, resolveReadmeUrl } from './render.ts'
import type { Plugin } from '../metadata.ts'

function plugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    id: 'dsh-demo',
    package: 'dsh-demo',
    source: 'github',
    repo: 'https://github.com/Mooling0602/dsh-demo',
    readme: { zh_CN: 'README.zh.md', en_US: 'README.md' },
    dispatchType: 'tarball',
    shard: 'dsh-de',
    file: 'p.yml',
    ...overrides,
  }
}

const ZH = TARGETS.find(target => target.language === 'zh_CN')
const EN = TARGETS.find(target => target.language === 'en_US')

test('TARGETS 覆盖两个 README，且只有中文版链接插件自己的 README', () => {
  assert.equal(TARGETS.length, 2)
  assert.equal(ZH?.output, 'README.zh.md')
  assert.equal(EN?.output, 'README.md')
  assert.equal(ZH?.linksOwnReadme, true)
  assert.equal(EN?.linksOwnReadme, false)
})

test('readmePathFor 读到对应语言', () => {
  const readme = { zh_CN: 'README.zh.md', en_US: 'README.md' }
  assert.equal(readmePathFor(readme, 'zh_CN'), 'README.zh.md')
  assert.equal(readmePathFor(readme, 'en_US'), 'README.md')
})

test('readmePathFor 对缺失的语言返回 undefined', () => {
  assert.equal(readmePathFor({}, 'zh_CN'), undefined)
})

test('resolveReadmeUrl 用默认分支拼链接', () => {
  assert.equal(
    resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo', 'README.zh.md', 'main'),
    'https://github.com/Mooling0602/dsh-demo/blob/main/README.zh.md',
  )
})

test('resolveReadmeUrl 接受非 main 的默认分支', () => {
  assert.equal(
    resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo', 'docs/README.zh.md', 'master'),
    'https://github.com/Mooling0602/dsh-demo/blob/master/docs/README.zh.md',
  )
})

test('resolveReadmeUrl 去掉仓库尾斜杠与路径的 ./ 前缀', () => {
  assert.equal(
    resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo/', './README.md', 'main'),
    'https://github.com/Mooling0602/dsh-demo/blob/main/README.md',
  )
})

test('resolveReadmeUrl 原样返回完整链接', () => {
  const url = 'https://example.test/README.zh.md'
  assert.equal(resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo', url, 'main'), url)
})

test('resolveReadmeUrl 对完整链接不要求分支', () => {
  assert.equal(resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo', 'https://example.test/a.md'), 'https://example.test/a.md')
})

test('resolveReadmeUrl 缺少分支时对相对路径报错', () => {
  assert.throws(() => resolveReadmeUrl('https://github.com/Mooling0602/dsh-demo', 'README.md'), /without a default branch/u)
})

test('renderEntry 在中文版带上中文链接', () => {
  assert.equal(
    renderEntry(plugin(), ZH!, 'main'),
    '- [dsh-demo](https://github.com/Mooling0602/dsh-demo)（[中文](https://github.com/Mooling0602/dsh-demo/blob/main/README.zh.md)）',
  )
})

test('renderEntry 在英文版不带任何翻译链接', () => {
  assert.equal(renderEntry(plugin(), EN!, 'main'), '- [dsh-demo](https://github.com/Mooling0602/dsh-demo)')
})

test('renderEntry 在插件没提供中文 README 时只留名称', () => {
  assert.equal(renderEntry(plugin({ readme: { en_US: 'README.md' } }), ZH!, 'main'), '- [dsh-demo](https://github.com/Mooling0602/dsh-demo)')
})

test('renderReadme 用条目替换占位注释', () => {
  const template = `# t\n\n${PLACEHOLDER}\n`
  assert.equal(renderReadme(template, ['- a', '- b']), '# t\n\n- a\n\n- b\n\n')
})

test('renderReadme 保留占位注释前后的内容', () => {
  const template = `head\n${PLACEHOLDER}\ntail`
  assert.equal(renderReadme(template, ['- a']), 'head\n- a\n\ntail')
})

test('renderReadme 接受空列表', () => {
  assert.equal(renderReadme(`a\n${PLACEHOLDER}\nb`, []), 'a\n\n\nb')
})

test('renderReadme 拒绝缺少占位注释的模板', () => {
  assert.throws(() => renderReadme('# no placeholder', []), /carries no/u)
})

test('renderReadme 拒绝重复的占位注释', () => {
  assert.throws(() => renderReadme(`${PLACEHOLDER}\n\n${PLACEHOLDER}`, []), /more than once/u)
})

test('renderTarget 按传入顺序列出插件', () => {
  const plugins = [plugin({ id: 'dsh-b', repo: 'https://github.com/x/dsh-b' }), plugin({ id: 'dsh-a', repo: 'https://github.com/x/dsh-a' })]
  const text = renderTarget(EN!, plugins, PLACEHOLDER, new Map())
  assert.match(text, /dsh-b[\s\S]*dsh-a/u)
})

test('renderTarget 缺少分支时仍能渲染不链接 README 的目标', () => {
  const text = renderTarget(EN!, [plugin()], PLACEHOLDER)
  assert.match(text, /\[dsh-demo\]/u)
})

test('renderTarget 缺少分支时对需要链接的目标报错', () => {
  assert.throws(() => renderTarget(ZH!, [plugin()], PLACEHOLDER), /without a default branch/u)
})
