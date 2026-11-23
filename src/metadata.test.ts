import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIELDS, checkPluginLocation, inShard, parsePluginYml, shardOf } from './metadata.ts'

const GOOD = [
  'id: dsh-mloader',
  'package: dsh-mloader',
  'source: github',
  'repo: https://github.com/Mooling0602/dsh-mloader',
  'readme:',
  '  zh_CN: README.zh.md',
  '  en_US: README.md',
  'dispatch-type: source',
].join('\n')

test('shardOf 取 id 前两个字母', () => {
  assert.equal(shardOf('dsh-mloader'), 'dsh-ml')
  assert.equal(shardOf('dsh-hint-shell'), 'dsh-hi')
  assert.equal(shardOf('dsh-bili-danmaku-overlay'), 'dsh-bi')
  assert.equal(shardOf('dsh-better-plugin-updater'), 'dsh-be')
  assert.equal(shardOf('dsh-web-file-uploader'), 'dsh-we')
})

test('shardOf 拒绝没有两个字母的 id', () => {
  assert.throws(() => shardOf('dsh-a'), /cannot derive a shard/u)
  assert.throws(() => shardOf('dsh-'), /cannot derive a shard/u)
  assert.throws(() => shardOf('dsh-1'), /cannot derive a shard/u)
})

test('shardOf 保留插件目录是否写 dsh- 前缀', () => {
  assert.equal(shardOf('dsh-other'), 'dsh-ot')
  assert.equal(shardOf('other'), 'ot')
  assert.equal(shardOf('dshother'), 'ds')
})

test('shardOf 让 shard 与插件目录的前缀写法一致', () => {
  for (const [shard, id] of [
    ['ot', 'other'],
    ['dsh-ot', 'dsh-other'],
    ['ds', 'dshother'],
    ['dsh-ds', 'dsh-dshother'],
  ] as const) {
    assert.equal(shardOf(id), shard, id)
  }
})

test('inShard 拒绝前缀写法不一致的目录', () => {
  assert.equal(inShard('ot', 'other'), true)
  assert.equal(inShard('dsh-ot', 'dsh-other'), true)
  // 字母对了，但插件目录写了前缀而 shard 没写，反之亦然。
  assert.equal(inShard('ot', 'dsh-other'), false)
  assert.equal(inShard('dsh-ot', 'other'), false)
  assert.equal(inShard('ds', 'dsh-other'), false)
  assert.equal(inShard('dsh-hi', 'other'), false)
})

test('parsePluginYml 接受五字段文件', () => {
  assert.deepEqual(parsePluginYml(GOOD, 'p.yml'), {
    id: 'dsh-mloader',
    package: 'dsh-mloader',
    source: 'github',
    repo: 'https://github.com/Mooling0602/dsh-mloader',
    readme: { zh_CN: 'README.zh.md', en_US: 'README.md' },
    dispatchType: 'source',
  })
})

test('parsePluginYml 把 readme 读成语言映射', () => {
  const plugin = parsePluginYml(GOOD, 'p.yml')
  assert.deepEqual(plugin.readme, { zh_CN: 'README.zh.md', en_US: 'README.md' })
})

test('parsePluginYml 接受 readme 的完整链接', () => {
  const text = GOOD.replace('  zh_CN: README.zh.md', '  zh_CN: https://example.test/README.zh.md')
  assert.equal(parsePluginYml(text, 'p.yml').readme.zh_CN, 'https://example.test/README.zh.md')
})

test('parsePluginYml 接受只列一种语言的 readme', () => {
  const text = GOOD.replace('  en_US: README.md\n', '')
  assert.deepEqual(parsePluginYml(text, 'p.yml').readme, { zh_CN: 'README.zh.md' })
})

test('parsePluginYml 拒绝不支持的 readme 语言', () => {
  const text = GOOD.replace('  en_US: README.md', '  ja_JP: README.ja.md')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /readme language "ja_JP" is not supported yet/u)
})

test('parsePluginYml 拒绝重复的 readme 语言', () => {
  const text = GOOD.replace('  en_US: README.md', '  zh_CN: README.other.md')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /duplicate readme language "zh_CN"/u)
})

test('parsePluginYml 拒绝不是映射的 readme', () => {
  const text = GOOD.replace('readme:\n  zh_CN: README.zh.md\n  en_US: README.md', 'readme: README.md')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /field "readme" must map a language/u)
})

test('parsePluginYml 拒绝空路径的 readme 条目', () => {
  const text = GOOD.replace('  zh_CN: README.zh.md', '  zh_CN:')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /readme "zh_CN" must be a repository-relative path/u)
})

test('parsePluginYml 保留 readme 的语言顺序', () => {
  const text = GOOD.replace('  zh_CN: README.zh.md\n  en_US: README.md', '  en_US: README.md\n  zh_CN: README.zh.md')
  assert.deepEqual(Object.keys(parsePluginYml(text, 'p.yml').readme), ['en_US', 'zh_CN'])
})

test('parsePluginYml 接受三种 dispatch-type', () => {
  for (const kind of ['npmjs', 'tarball', 'source']) {
    const text = GOOD.replace('dispatch-type: source', `dispatch-type: ${kind}`)
    assert.equal(parsePluginYml(text, 'p.yml').dispatchType, kind)
  }
})

test('parsePluginYml 接受 source: npm 配 dispatch-type: npmjs', () => {
  const text = GOOD.replace('source: github', 'source: npm').replace('dispatch-type: source', 'dispatch-type: npmjs')
  const plugin = parsePluginYml(text, 'p.yml')
  assert.equal(plugin.source, 'npm')
  assert.equal(plugin.dispatchType, 'npmjs')
})

test('parsePluginYml 要求 source: npm 配 dispatch-type: npmjs', () => {
  for (const kind of ['tarball', 'source']) {
    const text = GOOD.replace('source: github', 'source: npm').replace('dispatch-type: source', `dispatch-type: ${kind}`)
    assert.throws(() => parsePluginYml(text, 'p.yml'), /source "npm" requires dispatch-type "npmjs"/u)
  }
})

test('parsePluginYml 的交叉校验报错点名实际值', () => {
  const text = GOOD.replace('source: github', 'source: npm').replace('dispatch-type: source', 'dispatch-type: tarball')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /got "tarball"/u)
})

test('parsePluginYml 的交叉校验提到不支持第三方镜像', () => {
  const text = GOOD.replace('source: github', 'source: npm').replace('dispatch-type: source', 'dispatch-type: source')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /third-party npm mirrors are not supported/u)
})

test('parsePluginYml 允许 source: github 配任意 dispatch-type', () => {
  for (const kind of ['npmjs', 'tarball', 'source']) {
    const text = GOOD.replace('dispatch-type: source', `dispatch-type: ${kind}`)
    assert.equal(parsePluginYml(text, 'p.yml').dispatchType, kind)
  }
})

test('parsePluginYml 拒绝未知的 dispatch-type', () => {
  const text = GOOD.replace('dispatch-type: source', 'dispatch-type: magic')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /dispatch-type must be one of npmjs, tarball, source/u)
})

test('parsePluginYml 拒绝自定义 git 托管服务', () => {
  for (const host of ['gitlab', 'codeberg', 'gitea', 'bitbucket']) {
    const text = GOOD.replace('source: github', `source: ${host}`)
    assert.throws(() => parsePluginYml(text, 'p.yml'), /unsupported custom git hosting service/u)
  }
})

test('parsePluginYml 的 source 报错点名该值', () => {
  const text = GOOD.replace('source: github', 'source: gitlab')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /unsupported custom git hosting service "gitlab"/u)
})

test('parsePluginYml 忽略空行与注释', () => {
  const text = `# 头部\n\n${GOOD}\n\n# 尾部\n`
  assert.equal(parsePluginYml(text, 'p.yml').id, 'dsh-mloader')
})

test('parsePluginYml 去掉成对引号', () => {
  const text = GOOD.replace('repo: https://github.com/Mooling0602/dsh-mloader', 'repo: "https://github.com/Mooling0602/dsh-mloader"')
  assert.equal(parsePluginYml(text, 'p.yml').repo, 'https://github.com/Mooling0602/dsh-mloader')
})

test('parsePluginYml 拒绝多余字段', () => {
  assert.throws(() => parsePluginYml(`${GOOD}\nversion: 0.1.0\n`, 'p.yml'), /unknown field "version"/u)
})

test('parsePluginYml 拒绝缺少字段', () => {
  const text = [
    'id: dsh-mloader',
    'package: dsh-mloader',
    'source: github',
    'repo: https://github.com/Mooling0602/dsh-mloader',
  ].join('\n')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /missing field\(s\) readme, dispatch-type/u)
})

test('parsePluginYml 单独点名缺少的 readme', () => {
  const text = GOOD.replace('readme:\n  zh_CN: README.zh.md\n  en_US: README.md\n', '')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /missing field\(s\) readme$/u)
})

test('parsePluginYml 拒绝空值', () => {
  assert.throws(() => parsePluginYml(GOOD.replace('package: dsh-mloader', 'package:'), 'p.yml'), /"package" is empty/u)
})

test('parsePluginYml 拒绝重复字段', () => {
  assert.throws(() => parsePluginYml(`${GOOD}\nid: dsh-other\n`, 'p.yml'), /duplicate field "id"/u)
})

test('parsePluginYml 拒绝字段顺序错误', () => {
  const text = [
    'package: dsh-mloader',
    'id: dsh-mloader',
    'source: github',
    'repo: https://github.com/Mooling0602/dsh-mloader',
    'dispatch-type: source',
  ].join('\n')
  assert.throws(() => parsePluginYml(text, 'p.yml'), /must come after "id"/u)
})

test('parsePluginYml 报错带行号', () => {
  assert.throws(() => parsePluginYml(`${GOOD}\nbogus: 1\n`, 'p.yml'), /p\.yml:9/u)
})

test('checkPluginLocation 接受匹配的目录与 shard', () => {
  const plugin = checkPluginLocation(parsePluginYml(GOOD, 'p.yml'), 'dsh-mloader', 'dsh-ml', 'p.yml')
  assert.equal(plugin.shard, 'dsh-ml')
  assert.equal(plugin.file, 'p.yml')
})

test('checkPluginLocation 拒绝目录名不符', () => {
  assert.throws(
    () => checkPluginLocation(parsePluginYml(GOOD, 'p.yml'), 'dsh-other', 'dsh-ml', 'p.yml'),
    /must match its directory/u,
  )
})

test('checkPluginLocation 拒绝放错 shard', () => {
  assert.throws(
    () => checkPluginLocation(parsePluginYml(GOOD, 'p.yml'), 'dsh-mloader', 'dsh-zz', 'p.yml'),
    /belongs in "dsh-ml"/u,
  )
})

test('FIELDS 恰好是六个字段', () => {
  assert.deepEqual([...FIELDS], ['id', 'package', 'source', 'repo', 'readme', 'dispatch-type'])
})
