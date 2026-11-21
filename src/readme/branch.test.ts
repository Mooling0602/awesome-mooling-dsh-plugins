import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultBranch, defaultBranches } from './branch.ts'

/** Replace `globalThis.fetch` for one test, restoring it afterwards. */
async function withFetch(
  answer: (url: string) => Response | Promise<Response>,
  run: (calls: string[]) => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push(url)
    return answer(url)
  }) as typeof globalThis.fetch
  try {
    await run(calls)
  } finally {
    globalThis.fetch = original
  }
}

const ok = (branch: string) => new Response(JSON.stringify({ default_branch: branch }), { status: 200 })

test('defaultBranch 读默认分支', async () => {
  await withFetch(() => ok('main'), async () => {
    assert.equal(await defaultBranch('https://github.com/Mooling0602/dsh-demo'), 'main')
  })
})

test('defaultBranch 支持非 main 的分支名', async () => {
  await withFetch(() => ok('trunk'), async () => {
    assert.equal(await defaultBranch('https://github.com/Mooling0602/dsh-demo'), 'trunk')
  })
})

test('defaultBranch 请求仓库接口', async () => {
  await withFetch(() => ok('main'), async calls => {
    await defaultBranch('https://github.com/Mooling0602/dsh-demo')
    assert.equal(calls[0], 'https://api.github.com/repos/Mooling0602/dsh-demo')
  })
})

test('defaultBranch 带 token 时加授权头', async () => {
  const original = globalThis.fetch
  let seen: string | undefined
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    seen = new Headers(init?.headers).get('authorization') ?? undefined
    return ok('main')
  }) as typeof globalThis.fetch
  try {
    await defaultBranch('https://github.com/Mooling0602/dsh-demo', 'secret')
    assert.equal(seen, 'Bearer secret')
  } finally {
    globalThis.fetch = original
  }
})

test('defaultBranch 无 token 时不加授权头', async () => {
  const original = globalThis.fetch
  let seen: string | null = 'unset'
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    seen = new Headers(init?.headers).get('authorization')
    return ok('main')
  }) as typeof globalThis.fetch
  try {
    await defaultBranch('https://github.com/Mooling0602/dsh-demo')
    assert.equal(seen, null)
  } finally {
    globalThis.fetch = original
  }
})

test('defaultBranch 对 HTTP 错误报错', async () => {
  await withFetch(() => new Response('{}', { status: 404 }), async () => {
    await assert.rejects(() => defaultBranch('https://github.com/Mooling0602/dsh-demo'), /answered 404/u)
  })
})

test('defaultBranch 在没有 default_branch 时报错', async () => {
  await withFetch(() => new Response('{}', { status: 200 }), async () => {
    await assert.rejects(() => defaultBranch('https://github.com/Mooling0602/dsh-demo'), /no default_branch/u)
  })
})

test('defaultBranch 拒绝非 GitHub 仓库地址', async () => {
  await assert.rejects(() => defaultBranch('https://gitlab.com/a/b'), /not an https:\/\/github\.com URL/u)
})

test('defaultBranches 按仓库去重', async () => {
  await withFetch(() => ok('main'), async calls => {
    const branches = await defaultBranches([
      'https://github.com/Mooling0602/a',
      'https://github.com/Mooling0602/a',
      'https://github.com/Mooling0602/b',
    ], undefined, () => {})
    assert.equal(calls.length, 2)
    assert.equal(branches.size, 2)
  })
})

test('defaultBranches 用仓库地址作键', async () => {
  await withFetch(url => ok(url.endsWith('/a') ? 'main' : 'dev'), async () => {
    const branches = await defaultBranches(
      ['https://github.com/Mooling0602/a', 'https://github.com/Mooling0602/b'],
      undefined,
      () => {},
    )
    assert.equal(branches.get('https://github.com/Mooling0602/a'), 'main')
    assert.equal(branches.get('https://github.com/Mooling0602/b'), 'dev')
  })
})

test('defaultBranches 跳过读不到的仓库并告警', async () => {
  await withFetch(url => (url.endsWith('/bad') ? new Response('{}', { status: 403 }) : ok('main')), async () => {
    const warnings: string[] = []
    const branches = await defaultBranches(
      ['https://github.com/Mooling0602/bad', 'https://github.com/Mooling0602/good'],
      undefined,
      message => warnings.push(message),
    )
    assert.equal(branches.has('https://github.com/Mooling0602/bad'), false)
    assert.equal(branches.get('https://github.com/Mooling0602/good'), 'main')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /README links will be omitted/u)
  })
})

test('defaultBranches 空输入不请求', async () => {
  await withFetch(() => ok('main'), async calls => {
    const branches = await defaultBranches([], undefined, () => {})
    assert.equal(calls.length, 0)
    assert.equal(branches.size, 0)
  })
})
