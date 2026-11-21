import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildReadme, checkReadmes, writeReadmes } from './build.ts'
import { PLACEHOLDER, TARGETS } from './render.ts'

const ZH = TARGETS.find(target => target.language === 'zh_CN')!
const EN = TARGETS.find(target => target.language === 'en_US')!

const README = 'readme:\n  zh_CN: README.zh.md\n  en_US: README.md\n'
const REPO = 'https://github.com/Mooling0602/dsh-demo'

/** Branches for the fixture repository, so no test reaches the network. */
const BRANCHES = new Map([[REPO, 'main']])

/** Write one plugin.yml into a throwaway repository. */
async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-readme-'))
  for (const [path, text] of Object.entries(files)) {
    const target = join(root, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, text, 'utf8')
  }
  return root
}

/** A repository with one plugin and both templates. */
function repo(): Promise<string> {
  return fixture({
    'plugins/by-name/dsh-de/dsh-demo/plugin.yml':
      `id: dsh-demo\npackage: dsh-demo\nsource: github\nrepo: ${REPO}\n${README}dispatch-type: tarball\n`,
    'templates/_README.md': `# en\n\n${PLACEHOLDER}\n`,
    'templates/_README.zh.md': `# zh\n\n${PLACEHOLDER}\n`,
  })
}

test('buildReadme 把插件填进模板', async () => {
  const text = await buildReadme(await repo(), EN, { branches: BRANCHES })
  assert.match(text, /\[dsh-demo\]\(https:\/\/github\.com\/Mooling0602\/dsh-demo\)/u)
})

test('buildReadme 用注入的分支解析相对路径', async () => {
  const text = await buildReadme(await repo(), ZH, { branches: BRANCHES })
  assert.match(text, /blob\/main\/README\.zh\.md/u)
})

test('buildReadme 接受非 main 的分支', async () => {
  const text = await buildReadme(await repo(), ZH, { branches: new Map([[REPO, 'dev']]) })
  assert.match(text, /blob\/dev\/README\.zh\.md/u)
})

test('buildReadme 英文版不带翻译链接', async () => {
  const text = await buildReadme(await repo(), EN, { branches: BRANCHES })
  assert.doesNotMatch(text, /blob\/main/u)
})

test('writeReadmes 写出两个 README', async () => {
  const root = await repo()
  const written = await writeReadmes(root, { branches: BRANCHES })
  assert.equal(written.length, 2)
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /dsh-demo/u)
  assert.match(await readFile(join(root, 'README.zh.md'), 'utf8'), /blob\/main/u)
})

test('checkReadmes 对刚写出的文件通过', async () => {
  const root = await repo()
  await writeReadmes(root, { branches: BRANCHES })
  assert.deepEqual(await checkReadmes(root, { branches: BRANCHES }), [])
})

test('checkReadmes 报告缺失的 README', async () => {
  const stale = await checkReadmes(await repo(), { branches: BRANCHES })
  assert.equal(stale.length, 2)
  assert.match(stale[0] ?? '', /is missing/u)
})

test('checkReadmes 报告过期的 README', async () => {
  const root = await repo()
  await writeReadmes(root, { branches: BRANCHES })
  await writeFile(join(root, 'README.md'), '# stale\n', 'utf8')
  const stale = await checkReadmes(root, { branches: BRANCHES })
  assert.equal(stale.length, 1)
  assert.match(stale[0] ?? '', /is stale/u)
})

test('checkReadmes 在模板缺占位注释时报错', async () => {
  const root = await fixture({
    'plugins/by-name/dsh-de/dsh-demo/plugin.yml':
      `id: dsh-demo\npackage: dsh-demo\nsource: github\nrepo: ${REPO}\n${README}dispatch-type: tarball\n`,
    'templates/_README.md': '# no placeholder\n',
    'templates/_README.zh.md': `# zh\n\n${PLACEHOLDER}\n`,
  })
  await assert.rejects(() => checkReadmes(root, { branches: BRANCHES }), /carries no/u)
})
