import assert from 'node:assert/strict'
import test from 'node:test'
import { jobsOf, MARKER, render, resultOf, rowsOf, shouldPost, type Job } from './report.ts'

/** A job whose steps all passed, named as `pr.yml` names them. */
const PASSING: Job[] = [
  {
    name: 'check',
    steps: [
      { name: 'Checkout', conclusion: 'success' },
      { name: 'Dependencies', conclusion: 'success' },
      { name: 'Check the pull request title and the submitted metadata', conclusion: 'success' },
      { name: 'Build registry data', conclusion: 'success' },
      { name: 'Build index', conclusion: 'success' },
      { name: 'Typecheck', conclusion: 'success' },
      { name: 'Test', conclusion: 'success' },
      { name: 'Verify the worker bundles', conclusion: 'success' },
    ],
  },
]

test('shouldPost reports a passing run', () => {
  assert.equal(shouldPost('success'), true)
})

test('shouldPost reports a failing run, so the stale pass is replaced rather than left standing', () => {
  assert.equal(shouldPost('failure'), true)
})

test('shouldPost reports every other failure kind too', () => {
  for (const conclusion of ['timed_out', 'startup_failure', 'action_required']) {
    assert.equal(shouldPost(conclusion), true, conclusion)
  }
})

test('shouldPost stays silent for a run with no verdict', () => {
  for (const conclusion of ['cancelled', 'skipped', 'stale']) {
    assert.equal(shouldPost(conclusion), false, conclusion)
  }
})

test('resultOf maps every conclusion GitHub reports', () => {
  assert.deepEqual(resultOf('success'), { en: '✅ Passed', zh: '✅ 通过' })
  assert.deepEqual(resultOf('failure'), { en: '❌ Failed', zh: '❌ 失败' })
  assert.deepEqual(resultOf('skipped'), { en: '⏭️ Skipped', zh: '⏭️ 跳过' })
  assert.deepEqual(resultOf('cancelled'), { en: '⏹️ Cancelled', zh: '⏹️ 取消' })
  assert.deepEqual(resultOf(null), { en: '⚪ Not run', zh: '⚪ 未运行' })
})

test('resultOf treats an unknown conclusion as not run', () => {
  assert.deepEqual(resultOf('timed_out'), { en: '⚪ Not run', zh: '⚪ 未运行' })
})

test('resultOf writes every result in both languages', () => {
  for (const conclusion of ['success', 'failure', 'skipped', 'cancelled', null]) {
    const result = resultOf(conclusion)
    assert.ok(result.en.length > 0, String(conclusion))
    assert.ok(result.zh.length > 0, String(conclusion))
    assert.notEqual(result.en, result.zh, String(conclusion))
  }
})

test('rowsOf returns one row per check in workflow order', () => {
  const rows = rowsOf(PASSING)
  assert.equal(rows.length, 7)
  assert.deepEqual(
    rows.map(row => row.check.en),
    ['Dependencies', 'Submission', 'Registry', 'Index', 'Types', 'Tests', 'Bundle'],
  )
})

test('rowsOf returns every check name in both languages', () => {
  const rows = rowsOf(PASSING)
  assert.deepEqual(
    rows.map(row => row.check.zh),
    ['依赖', '投稿内容', '注册表数据', '索引', '类型', '测试', '打包'],
  )
  for (const row of rows) {
    assert.ok(row.about.en.length > 0, row.check.en)
    assert.ok(row.about.zh.length > 0, row.check.en)
  }
})

test('rowsOf reports a check the run never reached as not run', () => {
  const rows = rowsOf([{ steps: [{ name: 'Dependencies', conclusion: 'success' }] }])
  assert.equal(rows[0]?.result.en, '✅ Passed')
  for (const row of rows.slice(1)) assert.equal(row.result.en, '⚪ Not run', row.check.en)
})

test('rowsOf reports every check as not run when the run has no jobs', () => {
  assert.deepEqual(
    rowsOf([]).map(row => row.result.en),
    Array.from({ length: 7 }, () => '⚪ Not run'),
  )
})

test('rowsOf merges steps from more than one job', () => {
  const rows = rowsOf([
    { steps: [{ name: 'Dependencies', conclusion: 'success' }] },
    { steps: [{ name: 'Test', conclusion: 'failure' }] },
  ])
  assert.equal(rows[0]?.result.en, '✅ Passed')
  assert.equal(rows[5]?.result.en, '❌ Failed')
})

test('render starts with the marker so a later run can find the comment', () => {
  const body = render({ conclusion: 'success', jobs: PASSING })
  assert.ok(body.startsWith(MARKER), body.slice(0, 40))
})

test('render reports success in both languages', () => {
  const body = render({ conclusion: 'success', jobs: PASSING })
  assert.match(body, /^## ✅ Checks passed \/ 检查全部通过$/mu)
  assert.match(body, /ready to merge/u)
  assert.match(body, /可以合并/u)
})

test('render renders every row as a bilingual table row', () => {
  const body = render({ conclusion: 'success', jobs: PASSING })
  assert.match(body, /^\| Check \/ 检查项 \| Result \/ 结果 \| What it verifies \/ 验证内容 \|$/mu)
  assert.match(body, /^\| Dependencies \/ 依赖 \| ✅ Passed \/ ✅ 通过 \| the lockfile resolves without changes<br>锁文件无需改动即可解析 \|$/mu)
  assert.match(body, /^\| Bundle \/ 打包 \| ✅ Passed \/ ✅ 通过 \|/mu)
})

test('render reports a failure in both languages and points at the log', () => {
  const failing: Job[] = [
    {
      steps: [
        { name: 'Dependencies', conclusion: 'success' },
        { name: 'Check the pull request title and the submitted metadata', conclusion: 'failure' },
        { name: 'Build registry data', conclusion: 'skipped' },
        { name: 'Build index', conclusion: 'skipped' },
        { name: 'Typecheck', conclusion: 'skipped' },
        { name: 'Test', conclusion: 'skipped' },
        { name: 'Verify the worker bundles', conclusion: 'skipped' },
      ],
    },
  ]
  const body = render({ conclusion: 'failure', jobs: failing })
  assert.match(body, /^## ❌ Checks failed \/ 检查未通过$/mu)
  assert.match(body, /\*\*Checks\*\*/u)
  assert.match(body, /标签页/u)
  assert.match(body, /^\| Submission \/ 投稿内容 \| ❌ Failed \/ ❌ 失败 \|/mu)
  assert.match(body, /^\| Registry \/ 注册表数据 \| ⏭️ Skipped \/ ⏭️ 跳过 \|/mu)
})

test('render is stable for the same input', () => {
  const once = render({ conclusion: 'success', jobs: PASSING })
  const twice = render({ conclusion: 'success', jobs: PASSING })
  assert.equal(once, twice)
})

test('render leaves no unsubstituted placeholder', () => {
  for (const conclusion of ['success', 'failure']) {
    const body = render({ conclusion, jobs: PASSING })
    assert.doesNotMatch(body, /\$\{|\{\{/u, conclusion)
  }
})

test('the comment makes no promise about the pull request being closed', () => {
  // Nothing closes a pull request any more: a failure leaves it open and fixable, and the comment says what broke.
  const body = render({ conclusion: 'failure', jobs: PASSING })
  assert.doesNotMatch(body, /is a draft/u)
  assert.doesNotMatch(body, /closed|关闭/iu)
})

test('the comment says the same thing in both languages', () => {
  // Every line of prose carries an English and a Chinese half; a row that lost one half would read as a truncation.
  const body = render({ conclusion: 'success', jobs: PASSING })
  for (const line of body.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Check /')) continue
    if (line.startsWith('| ---')) continue
    const [left, right] = line.split('<br>')
    assert.ok((left ?? '').length > 0, line)
    assert.ok((right ?? '').length > 0, line)
    assert.match(right ?? '', /\p{Script=Han}/u, line)
  }
})

test('the silent branch keeps stdout empty so the caller can treat it as nothing to say', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  for (const conclusion of ['cancelled', 'skipped', 'stale']) {
    const { stdout } = await run(process.execPath, ['--experimental-strip-types', 'src/contrib/report.ts', '--jobs', '/dev/null', '--conclusion', conclusion], {
      cwd: new URL('../..', import.meta.url).pathname,
    })
    assert.equal(stdout, '', conclusion)
  }
})

test('jobsOf reads a bare list of jobs', () => {
  assert.deepEqual(jobsOf('[{"steps":[{"name":"Dependencies","conclusion":"success"}]}]'), [
    { steps: [{ name: 'Dependencies', conclusion: 'success' }] },
  ])
})

test('jobsOf unwraps the shape the jobs endpoint returns', () => {
  // `gh api .../jobs` answers `{ total_count, jobs }`. Reading only the array form crashed the report after a run that
  // had already succeeded, which is the one moment the comment cannot be skipped.
  const payload = '{"total_count":1,"jobs":[{"steps":[{"name":"Tests","conclusion":"success"}]}]}'
  assert.deepEqual(jobsOf(payload), [{ steps: [{ name: 'Tests', conclusion: 'success' }] }])
})

test('jobsOf treats an unrecognised payload as no jobs', () => {
  assert.deepEqual(jobsOf('null'), [])
  assert.deepEqual(jobsOf('{}'), [])
})

test('jobsOf renders a passing report from the wrapped shape', () => {
  const payload = JSON.stringify({
    total_count: 1,
    jobs: [{ steps: PASSING[0]?.steps ?? [] }],
  })
  assert.match(render({ conclusion: 'success', jobs: jobsOf(payload) }), /Checks passed/)
})
