import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSources, writeSources } from './build.ts'

/** Write one plugin.yml into a throwaway repository. */
async function fixture(plugins: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sources-'))
  for (const [dir, text] of Object.entries(plugins)) {
    const target = join(root, 'plugins', 'by-name', dir)
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'plugin.yml'), text, 'utf8')
  }
  return root
}

const NPM = (id: string) => `id: ${id}\npackage: ${id}\nsource: npm\nrepo: https://github.com/Mooling0602/${id}\ndispatch-type: npmjs\n`
const TARBALL = (id: string) => `id: ${id}\npackage: ${id}\nsource: github\nrepo: https://github.com/Mooling0602/${id}\ndispatch-type: tarball\n`
const SOURCE = (id: string) => `id: ${id}\npackage: ${id}\nsource: github\nrepo: https://github.com/Mooling0602/${id}\ndispatch-type: source\n`

test('buildSources 把 npmjs 与 tarball 都写成包名', async () => {
  const root = await fixture({
    'dsh-ap/dsh-apple': NPM('dsh-apple'),
    'dsh-ba/dsh-banana': TARBALL('dsh-banana'),
    'dsh-ch/dsh-cherry': SOURCE('dsh-cherry'),
  })
  assert.equal(
    await buildSources(root),
    'dsh-apple\ndsh-banana\nhttps://github.com/Mooling0602/dsh-cherry\n',
  )
})

test('buildSources 按 id 排序', async () => {
  const root = await fixture({
    'dsh-ze/dsh-zebra': SOURCE('dsh-zebra'),
    'dsh-ap/dsh-apple': SOURCE('dsh-apple'),
  })
  assert.equal(
    await buildSources(root),
    'https://github.com/Mooling0602/dsh-apple\nhttps://github.com/Mooling0602/dsh-zebra\n',
  )
})

test('buildSources 空仓库产出空字符串', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sources-empty-'))
  await mkdir(join(root, 'plugins', 'by-name'), { recursive: true })
  assert.equal(await buildSources(root), '')
})

test('writeSources 写出文件并返回插件', async () => {
  const root = await fixture({ 'dsh-ap/dsh-apple': NPM('dsh-apple') })
  const plugins = await writeSources(root)
  assert.equal(plugins.length, 1)
  assert.equal(plugins[0]?.id, 'dsh-apple')
  assert.equal(await readFile(join(root, 'dists', 'plugins.txt'), 'utf8'), 'dsh-apple\n')
})

test('writeSources 建出 dists 目录', async () => {
  const root = await fixture({ 'dsh-ap/dsh-apple': NPM('dsh-apple') })
  await writeSources(root)
  assert.equal(await readFile(join(root, 'dists', 'plugins.txt'), 'utf8'), 'dsh-apple\n')
})

test('writeSources 覆盖旧内容', async () => {
  const root = await fixture({ 'dsh-ap/dsh-apple': NPM('dsh-apple') })
  await writeSources(root)
  const next = await fixture({ 'dsh-ba/dsh-banana': NPM('dsh-banana') })
  const plugins = await writeSources(next)
  assert.equal(plugins[0]?.id, 'dsh-banana')
  assert.equal(await readFile(join(next, 'dists', 'plugins.txt'), 'utf8'), 'dsh-banana\n')
})
