import { test } from 'node:test'
import assert from 'node:assert/strict'
import { packageOf, route, tarballUrl, versionOfAsset, type RegistryEntry } from './routes.ts'

const ENTRIES: Record<string, RegistryEntry> = {
  'dsh-x': {
    packument: { name: 'dsh-x' },
    tarballs: {
      '1.0.0': { tarball: 'https://e/dsh-x-1.0.0.tgz' },
      '1.0.0-rc.3': { tarball: 'https://e/dsh-x-1.0.0-rc.3.tgz' },
    },
  },
  '@scope/dsh-y': {
    packument: { name: '@scope/dsh-y' },
    tarballs: { '2.0.0': { tarball: 'https://e/dsh-y-2.0.0.tgz' } },
  },
}

function lookup(name: string): RegistryEntry | undefined {
  return ENTRIES[name]
}

test('packageOf 读普通名', () => {
  assert.deepEqual(packageOf(['dsh-x']), { name: 'dsh-x', consumed: 1 })
})

test('packageOf 读 scope 名占两段', () => {
  assert.deepEqual(packageOf(['@scope', 'dsh-y']), { name: '@scope/dsh-y', consumed: 2 })
  assert.deepEqual(packageOf(['@scope', 'dsh-y', '-', 'f.tgz']), { name: '@scope/dsh-y', consumed: 2 })
})

test('packageOf 把编码的 scope 斜杠解析成同一个包', () => {
  // A client may send `@scope%2Fname` as a single segment. Recognising only the literal form would make the encoded
  // spelling look like "no package", which is how an allow-list gets bypassed.
  assert.deepEqual(packageOf(['@scope%2Fdsh-y']), { name: '@scope/dsh-y', consumed: 1 })
  assert.deepEqual(packageOf(['@scope%2Fdsh-y', '-', 'f.tgz']), { name: '@scope/dsh-y', consumed: 1 })
  // Both spellings must agree, or one of them skips whichever check keys off the name.
  assert.equal(packageOf(['@scope%2Fdsh-y'])?.name, packageOf(['@scope', 'dsh-y'])?.name)
})

test('packageOf 拒绝只有 scope 没有名字的路径', () => {
  assert.equal(packageOf(['@scope%2F']), undefined)
  assert.equal(packageOf(['@scope']), undefined)
})

test('packageOf 对空路径返回 undefined', () => {
  assert.equal(packageOf([]), undefined)
  assert.equal(packageOf(['@scope']), undefined)
})

test('packageOf 解码百分号转义', () => {
  assert.deepEqual(packageOf(['%40scope', 'dsh-y']), { name: '@scope/dsh-y', consumed: 2 })
})

test('route 把根路径指向 packument', () => {
  const result = route(new URL('https://reg.example/dsh-x'), lookup)
  assert.deepEqual(result, { kind: 'packument', name: 'dsh-x' })
})

test('route 对未托管的包走代理', () => {
  const result = route(new URL('https://reg.example/@deepseek-ai/cordis'), lookup)
  assert.deepEqual(result, { kind: 'proxy' })
})

test('route 把 tarball 路径指向下载', () => {
  const result = route(new URL('https://reg.example/dsh-x/-/dsh-x-1.0.0.tgz'), lookup)
  assert.deepEqual(result, { kind: 'download', name: 'dsh-x', version: '1.0.0', tarball: 'https://e/dsh-x-1.0.0.tgz' })
})

test('route 认得预发布版本 tarball', () => {
  const result = route(new URL('https://reg.example/dsh-x/-/dsh-x-1.0.0-rc.3.tgz'), lookup)
  assert.equal(result.kind, 'download')
  assert.equal(result.kind === 'download' ? result.version : '', '1.0.0-rc.3')
})

test('route 处理 scope 包的 tarball', () => {
  const result = route(new URL('https://reg.example/@scope/dsh-y/-/dsh-y-2.0.0.tgz'), lookup)
  assert.equal(result.kind, 'download')
})

test('route 拒绝不属于该包的 tarball', () => {
  const result = route(new URL('https://reg.example/dsh-x/-/other-1.0.0.tgz'), lookup)
  assert.equal(result.kind, 'not-found')
  assert.match(result.kind === 'not-found' ? result.reason : '', /does not name a tarball/u)
})

test('route 拒绝不存在的版本', () => {
  const result = route(new URL('https://reg.example/dsh-x/-/dsh-x-9.9.9.tgz'), lookup)
  assert.equal(result.kind, 'not-found')
  assert.match(result.kind === 'not-found' ? result.reason : '', /no version "9\.9\.9"/u)
})

test('route 把 dist-tags 与 audit 等路径走代理', () => {
  assert.equal(route(new URL('https://reg.example/dsh-x/dist-tags'), lookup).kind, 'proxy')
  assert.equal(route(new URL('https://reg.example/-/v1/search?text=x'), lookup).kind, 'proxy')
  assert.equal(route(new URL('https://reg.example/'), lookup).kind, 'not-found')
})

test('route 对未托管的 tarball 路径走代理', () => {
  assert.equal(route(new URL('https://reg.example/unknown/-/unknown-1.0.0.tgz'), lookup).kind, 'proxy')
})

test('versionOfAsset 解析版本', () => {
  assert.equal(versionOfAsset('dsh-x-1.0.0.tgz', 'dsh-x'), '1.0.0')
  assert.equal(versionOfAsset('dsh-x-1.0.0-rc.3.tgz', 'dsh-x'), '1.0.0-rc.3')
})

test('versionOfAsset 拒绝不符的文件名', () => {
  assert.equal(versionOfAsset('other-1.0.0.tgz', 'dsh-x'), undefined)
  assert.equal(versionOfAsset('dsh-x-1.0.0.zip', 'dsh-x'), undefined)
  assert.equal(versionOfAsset('dsh-x-.tgz', 'dsh-x'), undefined)
})

test('tarballUrl 生成的地址就是 route 应答的地址', () => {
  // The advertised `dist.tarball` and the path `route` answers have to be the same string, or a client follows the
  // packument to an address the worker does not recognise and every install fails.
  const url = tarballUrl('https://reg.example/', 'dsh-x', '1.0.0')
  assert.equal(url, 'https://reg.example/dsh-x/-/dsh-x-1.0.0.tgz')
  const entries = new Map([['dsh-x', { packument: {}, tarballs: { '1.0.0': { tarball: 'https://github.com/x.tgz' } } }]])
  const decision = route(new URL(url), name => entries.get(name))
  assert.equal(decision.kind, 'download')
  assert.equal(decision.kind === 'download' ? decision.version : undefined, '1.0.0')
})

test('tarballUrl 把 scoped 包的斜杠留在路径里而不是文件名里', () => {
  // `@scope/name` occupies two path segments, so the asset file itself carries only `name`.
  const url = tarballUrl('https://reg.example/', '@scope/dsh-x', '1.0.0')
  assert.equal(url, 'https://reg.example/@scope/dsh-x/-/dsh-x-1.0.0.tgz')
  assert.equal(versionOfAsset('dsh-x-1.0.0.tgz', '@scope/dsh-x'), '1.0.0')
})
