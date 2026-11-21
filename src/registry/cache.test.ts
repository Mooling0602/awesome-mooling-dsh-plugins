import assert from 'node:assert/strict'
import test from 'node:test'

import { ALLOW_PREFIX, CACHE_PREFIXES, DENY_PREFIX, cacheKeys } from './cache.ts'

test('cacheKeys 只挑出缓存记录', () => {
  const keys = [
    `${ALLOW_PREFIX}dsh-x`,
    `${DENY_PREFIX}lodash`,
    'dsh-hint-shell',
    '__hosted__',
    '__index__',
    `${ALLOW_PREFIX}@deepseek-ai/cordis`,
  ]
  assert.deepEqual(cacheKeys(keys), [
    `${ALLOW_PREFIX}dsh-x`,
    `${DENY_PREFIX}lodash`,
    `${ALLOW_PREFIX}@deepseek-ai/cordis`,
  ])
})

test('cacheKeys 绝不返回权威数据', () => {
  // Deleting a packument would break a hosted plugin until the next deploy, so the filter has to be exclusive.
  const authoritative = ['dsh-hint-shell', 'dsh-web-file-uploader', '__hosted__', '__index__']
  assert.deepEqual(cacheKeys(authoritative), [])
})

test('cacheKeys 对空列表返回空', () => {
  assert.deepEqual(cacheKeys([]), [])
})

test('缓存前缀互不重叠', () => {
  // A prefix that is a prefix of another would make the delete plan ambiguous.
  for (const prefix of CACHE_PREFIXES) {
    const others = CACHE_PREFIXES.filter(other => other !== prefix)
    for (const other of others) assert.equal(other.startsWith(prefix), false)
  }
})
