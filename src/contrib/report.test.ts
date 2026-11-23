import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseDocument } from 'yaml'
import { CHECKS, jobsOf, MARKER, render, resultOf, rowsOf, shouldPost, verdictOf, type Job } from './report.ts'

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
  const body = render({ verdict: 'success', jobs: PASSING })
  assert.ok(body.startsWith(MARKER), body.slice(0, 40))
})

test('render reports success in both languages', () => {
  const body = render({ verdict: 'success', jobs: PASSING })
  assert.match(body, /^## ✅ Checks passed \/ 检查全部通过$/mu)
  assert.match(body, /ready to merge/u)
  assert.match(body, /可以合并/u)
})

test('render renders every row as a bilingual table row', () => {
  const body = render({ verdict: 'success', jobs: PASSING })
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
  const body = render({ verdict: 'failure', jobs: failing })
  assert.match(body, /^## ❌ Checks failed \/ 检查未通过$/mu)
  assert.match(body, /\*\*Checks\*\*/u)
  assert.match(body, /标签页/u)
  assert.match(body, /^\| Submission \/ 投稿内容 \| ❌ Failed \/ ❌ 失败 \|/mu)
  assert.match(body, /^\| Registry \/ 注册表数据 \| ⏭️ Skipped \/ ⏭️ 跳过 \|/mu)
})

test('render is stable for the same input', () => {
  const once = render({ verdict: 'success', jobs: PASSING })
  const twice = render({ verdict: 'success', jobs: PASSING })
  assert.equal(once, twice)
})

test('render leaves no unsubstituted placeholder', () => {
  for (const verdict of ['success', 'failure'] as const) {
    const body = render({ verdict, jobs: PASSING })
    assert.doesNotMatch(body, /\$\{|\{\{/u, verdict)
  }
})

test('the comment makes no promise about the pull request being closed', () => {
  // Nothing closes a pull request any more: a failure leaves it open and fixable, and the comment says what broke.
  const body = render({ verdict: 'failure', jobs: PASSING })
  assert.doesNotMatch(body, /is a draft/u)
  assert.doesNotMatch(body, /closed|关闭/iu)
})

test('the comment says the same thing in both languages', () => {
  // Every line of prose carries an English and a Chinese half; a row that lost one half would read as a truncation.
  const body = render({ verdict: 'success', jobs: PASSING })
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
  assert.match(render({ verdict: 'success', jobs: jobsOf(payload) }), /Checks passed/)
})

test('verdictOf calls a run whose checks never ran no verdict at all', () => {
  // This is the shape a `/recheck` run that judged nothing reports, and the failure it guards is that such a run used to
  // read as a pass: the run concluded `success`, the table was all "not run", and the comment said the pull request was
  // ready to merge — replacing whatever the last run that really did the work had said.
  const skipped: Job[] = [{ name: 'Check', conclusion: 'skipped', steps: [] }]
  assert.equal(verdictOf(skipped, 'success'), null)
})

test('verdictOf calls a passing run a pass only once a check has concluded', () => {
  const noChecks: Job[] = [
    { name: 'Resolve', conclusion: 'success', steps: [{ name: 'Read the pull request', conclusion: 'success' }] },
    { name: 'Check', conclusion: 'skipped', steps: [] },
  ]
  assert.equal(verdictOf(noChecks, 'success'), null)
  assert.equal(verdictOf(PASSING, 'success'), 'success')
})

test('verdictOf calls a failing run a failure whatever its checks say', () => {
  // A run concludes `failure` only because a job failed, and a job only because a step did. That step need not be one of
  // the seven table rows, so a failure is taken at face value rather than re-derived from the table.
  const onlyResolveFailed: Job[] = [
    { name: 'Resolve', conclusion: 'failure', steps: [{ name: 'Read the pull request', conclusion: 'failure' }] },
    { name: 'Check', conclusion: 'skipped', steps: [] },
  ]
  assert.equal(verdictOf(onlyResolveFailed, 'failure'), 'failure')
})

test('verdictOf reads a check that failed as a failure even on a successful run', () => {
  // Defensive: a run that reported `success` while a check failed is contradictory, but reading it as a pass would be the
  // one wrong answer, so a failed check decides the verdict whichever way the run concluded.
  const contradictory: Job[] = [{ steps: [{ name: 'Test', conclusion: 'failure' }] }]
  assert.equal(verdictOf(contradictory, 'success'), 'failure')
})

/** One step of a workflow, as much of it as these tests read. */
interface WorkflowStep {
  name?: unknown
  id?: unknown
  uses?: unknown
  if?: unknown
  run?: unknown
  env?: Record<string, unknown>
  with?: { name?: unknown }
}

/** One job of a workflow, as much of it as these tests read. */
interface WorkflowJob {
  name?: unknown
  steps?: WorkflowStep[]
  concurrency?: unknown
  if?: unknown
}

/** One workflow file, as much of it as these tests read. */
interface Workflow {
  concurrency?: { group?: unknown; queue?: unknown }
  jobs?: Record<string, WorkflowJob>
}

/**
 * Parse one workflow file from `.github/workflows`.
 *
 * The file is parsed rather than grepped so a value written across lines, or quoted in a way YAML allows and a regular
 * expression would not, still compares as the value GitHub reads.
 * @param name the file name, such as `pr.yml`.
 * @returns the workflow as plain objects.
 */
function workflow(name: string): Workflow {
  // A path built from `import.meta.url` rather than a `URL` object: `tsconfig.json` loads `@cloudflare/workers-types` as
  // well as `@types/node`, and the two declare incompatible globals named `URL`, so passing one to a `node:fs` function
  // does not typecheck. `fileURLToPath` and `join` also decode percent-escapes, which `URL.pathname` leaves in place, so a
  // checkout under a directory with a space in its name is read rather than missed.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const document = parseDocument(readFileSync(join(root, '.github', 'workflows', name), 'utf8'))
  assert.deepEqual(document.errors, [], `${name} does not parse`)
  return document.toJS() as Workflow
}

/**
 * The group a concurrency block names, whether written as a shorthand string or as an object.
 * @param concurrency the `concurrency` value, possibly absent.
 * @returns the group, or undefined when there is no concurrency block.
 */
function groupOf(concurrency: unknown): unknown {
  if (typeof concurrency === 'string') return concurrency
  if (concurrency === null || typeof concurrency !== 'object') return undefined
  return (concurrency as { group?: unknown }).group
}

/**
 * The step names `pr.yml` actually gives the check job, in the order it runs them.
 *
 * A step with no `name` is skipped: the jobs API reports such a step under its `uses` or its command, never under an
 * empty string, so it can never be one of the rows this file renders.
 *
 * The steps come from the `check` job specifically. `pr.yml` also resolves which pull request the run is about, in a job
 * of its own, and those steps are not checks: their outcome is not what the comment reports, and a row for them would
 * claim a result nobody gates on.
 * @returns the names of the named steps in the `check` job.
 */
function stepNames(): string[] {
  const check = workflow('pr.yml').jobs?.check
  assert.ok(check, 'pr.yml has no job named "check"')
  const steps = check.steps ?? []
  return steps.flatMap(step => (typeof step.name === 'string' ? [step.name] : []))
}

test('every row is a step pr.yml runs', () => {
  // Binding the table to the workflow. Without this the two are kept aligned by hand: a step renamed in `pr.yml` stops
  // matching its row here, the row reports "Not run" for a step that succeeded, and nothing goes red to say so.
  const names = new Set(stepNames())
  for (const { name } of CHECKS) assert.ok(names.has(name), `pr.yml has no step named "${name}"`)
})

test('the checks are reported in the order pr.yml runs them', () => {
  // The table reads top to bottom as the workflow reads top to bottom, so a reader following a failure in the comment
  // finds the same order in the run's log. A name `pr.yml` does not have indexes as -1, which sorts ahead of everything
  // and so fails here too: this test catches a reordering, and repeats the previous one's complaint about a name that
  // does not exist rather than passing over it.
  const order = stepNames()
  const positions = CHECKS.map(({ name }) => order.indexOf(name))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'CHECKS is not in workflow order')
})

test('pr.yml takes its lock at the job that does the work, not for the whole run', () => {
  // A workflow-level group is chosen from `github` alone, before any job has run, so it cannot ask the one question that
  // decides whether two runs may cancel each other: do they report on the same check. The run has to answer that first,
  // which makes it a job, and the lock has to sit on the job that answers it. Moving the group back up would compile and
  // run, and would silently go back to letting a trigger that reports nothing cancel a run that reports the required
  // check.
  const pr = workflow('pr.yml')
  assert.equal(
    groupOf(pr.concurrency),
    undefined,
    'pr.yml sets a workflow-level concurrency group, which cannot see which check a run reports',
  )
  const check = pr.jobs?.check
  assert.ok(check, 'pr.yml has no job named "check"')
  assert.ok(groupOf(check.concurrency), 'the job that reports the check takes no lock, so nothing serialises its runs')
})

test('the deploy workflows share one lock, so the worker is never deployed twice at once', () => {
  // Both files deploy the same Cloudflare worker, and a concurrency group's name is unique across a repository rather
  // than per workflow: two different names are not two locks, they are none. A manual run overlapping a push could then
  // deploy the older tree over the newer one. Sharing a name costs a wait and nothing else, because each run builds what
  // it deploys.
  const registry = groupOf(workflow('registry.yml').concurrency)
  const manual = groupOf(workflow('update-cf-worker.yml').concurrency)
  assert.ok(registry, 'registry.yml takes no lock')
  assert.equal(manual, registry, 'the two files that deploy the worker lock on different names, which locks nothing')
})

test('the deploy workflows keep waiting runs rather than replacing them', () => {
  // A group holds one pending run by default, and each new arrival replaces it, so a run that waited is dropped without
  // ever starting — and a run that never starts reports nothing, so the loss is silent. A timer run discarded by a push
  // is a stale index nobody is told about, and a manual deploy discarded by the next push is worse.
  for (const name of ['registry.yml', 'update-cf-worker.yml']) {
    const { queue } = workflow(name).concurrency as { queue?: unknown }
    assert.equal(queue, 'max', `${name} drops waiting runs instead of keeping them`)
  }
})

test('the check job locks on the commit, so an older run cannot cancel a newer one', () => {
  // A job joins its group when it starts rather than when the workflow was dispatched. Keyed on the pull request alone,
  // a run of an older commit whose `resolve` happened to be slow would join after a newer run had started and cancel it,
  // leaving the required check reporting a verdict about a commit that had already been replaced. The commit in the key
  // is what makes the run that loses the race always the older one.
  const check = workflow('pr.yml').jobs?.check
  assert.ok(check, 'pr.yml has no job named "check"')
  const group = String(groupOf(check.concurrency))
  assert.ok(
    group.includes('needs.resolve.outputs.head'),
    `the check job's group does not name the commit, so an older run can cancel a newer one: ${group}`,
  )
})

test('a verdict is only posted for a commit the run can attribute', () => {
  // The comment is edited in place, so a run that finished late can overwrite a newer verdict with an older one. The
  // check workflow records the pull request number and commit it judged, and the reporting workflow reads that record
  // back from the run rather than from its own event: under `issue_comment` the event's `head_sha` is the tip of the
  // default branch, not the commit the run went on to read and judge. These two steps are the ends of that wire, and
  // either one going missing makes the comparison silently unenforceable rather than red.
  const record = workflow('pr.yml')
    .jobs?.check?.steps?.find(step => step.name === 'Record what was judged')
  assert.ok(record, 'pr.yml does not record what it judged')

  const read = workflow('pr-result.yml')
    .jobs?.resolve?.steps?.find(step => String(step.uses ?? '').startsWith('actions/download-artifact@'))
  assert.ok(read, 'pr-result.yml does not read the record back')
  const uses = String((read as { uses?: unknown }).uses ?? '')
  assert.ok(uses.startsWith('actions/download-artifact@'), `pr-result.yml reads the record with ${uses}`)
  // Named after the attempt, not `judged`: an artifact belongs to the run, not to one attempt of it, so a fixed name
  // returns whichever attempt uploaded last while the conclusions beside it describe the attempt being reported on.
  assert.equal((read as { with?: { name?: unknown } }).with?.name, 'judged-${{ github.event.workflow_run.run_attempt }}')

  // The upload half has to name the same artifact, and has to be able to skip: a run that resolved no pull request has
  // nothing to record, and `if-no-files-found: error` would otherwise turn its own failure into an error about paths.
  const upload = workflow('pr.yml')
    .jobs?.check?.steps?.find(step => String(step.uses ?? '').startsWith('actions/upload-artifact@'))
  assert.ok(upload, 'pr.yml does not upload what it judged')
  assert.equal(upload.with?.name, 'judged-${{ github.run_attempt }}')
  assert.ok(String(upload.if ?? '').includes("needs.resolve.outputs.number != ''"), 'the upload cannot be skipped')
})

test('a report reads the attempt it is reporting on, not the latest one', () => {
  // `workflow_run` fires once per completed attempt and carries that attempt's conclusion, but the jobs endpoint without
  // `/attempts/<n>` answers with the latest attempt's jobs. A report on a re-run would then pair this attempt's
  // conclusion with a different attempt's steps, and the comment would describe a run that never happened.
  const steps = workflow('pr-result.yml').jobs?.comment?.steps ?? []
  const read = steps.find(step => step.name === "Read the run's steps")
  assert.ok(read, "pr-result.yml no longer reads the run's steps")
  const command = String(read.run ?? '')
  assert.ok(
    command.includes('/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT/jobs'),
    `pr-result.yml reads the jobs with ${command}`,
  )
  assert.equal(read.env?.RUN_ATTEMPT, '${{ github.event.workflow_run.run_attempt }}')
})

test('a superseded run deploys nothing, and does not fail over it', () => {
  // A run joins the deploy group when it starts, not when it was triggered, so one that waited its turn can begin after
  // the commit it carries stopped being the tip of `main`. Deploying it would put an older tree in front of the newer
  // one and leave the worker serving that older code. A pushed or timer run must not fail over it either: the newer
  // commit has a run of its own queued behind this one, so a red mark would blame a merge that was fine.
  const registry = workflow('registry.yml')
  const gate = registry.jobs?.registry?.steps?.find(step => step.name === 'Check that this run is still the tip of main')
  assert.ok(gate, 'registry.yml deploys without checking whether main has moved on')

  const command = String(gate.run ?? '')
  assert.ok(gate.id === 'fresh', 'the check does not name its result, so nothing downstream can read it')
  assert.ok(command.includes('refs/heads/main'), `the check does not read main: ${command}`)
  assert.ok(
    command.includes("echo \"superseded=true\" >> \"$GITHUB_OUTPUT\""),
    'nothing downstream can tell that the run was superseded, so every step publishes anyway',
  )

  // Being behind means different things to the two kinds of trigger, so the verdict is not a single line: the quiet
  // skip has to be reachable without passing the failure that a dispatched run takes. Both are in this one step because
  // `superseded` must always be written by the same place rather than read out of a step that may not have run.
  //
  // The region is sliced from the "is this run the tip" comparison to the quiet skip, and not from the first mention of
  // the event name: that name appears twice, once in the rollback exemption above, and a slice that started there would
  // span the unrelated failure for an unreadable `main` and pass with the dispatch branch deleted.
  const tipCheck = command.indexOf('if [ "$head" = "$tip" ]')
  const quietSkip = command.indexOf('echo "superseded=true"')
  assert.ok(tipCheck >= 0, `the gate never compares the run's commit with main: ${command}`)
  assert.ok(quietSkip > tipCheck, 'the quiet skip is not behind the comparison it depends on')
  const behind = command.slice(tipCheck, quietSkip)
  const dispatch = behind.indexOf('workflow_dispatch')
  assert.ok(dispatch >= 0, 'a dispatched run that is behind is not refused, so it skips green about a deploy it did not make')
  assert.ok(
    behind.indexOf('exit 1', dispatch) >= 0,
    'the dispatch branch names the problem but does not stop, so a stale manual run goes green',
  )
  assert.ok(
    !command.slice(quietSkip).includes('exit 1'),
    'a pushed run fails over being superseded, which blames a merge that was fine',
  )

  // Every step that builds, installs or writes has to read the answer, or the check only warns while the run does the
  // work anyway: an older tree gets installed, bundled, deployed and written to KV. `Drop cached proxy decisions` is
  // deliberately not in the list — it runs only for a dispatched run, and one of those that is behind stops at the gate
  // above with a failed step before it ever gets here.
  const steps = registry.jobs?.registry?.steps ?? []
  const guarded = steps.filter(step =>
    [
      'Build registry data',
      'Build index',
      'Verify the worker bundles',
      'Deploy worker',
      'Upload packuments to KV',
      'Point the config at the namespace',
    ].includes(String(step.name)),
  )
  assert.equal(guarded.length, 6, 'registry.yml no longer has the steps these tests know about')
  for (const step of guarded) {
    assert.ok(
      String(step.if ?? '').includes("steps.fresh.outputs.superseded != 'true'"),
      `${String(step.name)} works whether or not the run was superseded`,
    )
  }

  // The index comparison is the one that has to be guarded for a reason beyond wasted work: it reads the deployed index
  // to compare against, and stops the run when that read fails. Unguarded, a timer run that had already decided to
  // publish nothing would go red because the registry it was going to leave alone could not be reached.
  const changed = steps.find(step => step.name === 'Check whether the index moved')
  assert.ok(changed, 'registry.yml no longer compares the index it built')
  assert.ok(
    String(changed.if ?? '').includes("steps.fresh.outputs.superseded != 'true'"),
    'a superseded timer run still compares the index and can fail over a registry it was not going to touch',
  )

  // Installing is the slowest part of the run, so it is skipped too: the point of asking at the gate is that an overtaken
  // run costs a checkout and nothing else. The setup steps are skipped with it, since a run installs nothing.
  const install = steps.find(step => String(step.run ?? '').startsWith('pnpm install'))
  assert.ok(install, 'registry.yml no longer installs dependencies')
  assert.ok(
    String(install.if ?? '').includes("steps.fresh.outputs.superseded != 'true'"),
    'a superseded run installs dependencies for a tree it is not going to publish',
  )
  for (const setup of steps.filter(step => String(step.uses ?? '').startsWith('pnpm/action-setup@') || String(step.uses ?? '').startsWith('actions/setup-node@'))) {
    assert.ok(
      String(setup.if ?? '').includes("steps.fresh.outputs.superseded != 'true'"),
      `${String(setup.uses)} prepares a run that installs nothing`,
    )
  }

  // A dispatched run publishes by name rather than by assumption: the exemption exists, but only when it was asked for,
  // and the gate can still see the event name. Without both halves a manual dispatch on a branch that has since been
  // merged would deploy a tree `main` has moved past — an accidental rollback, which is the very thing this gate is for.
  assert.equal(gate.if, undefined, 'the gate is skipped for some trigger, so its answer is missing rather than false')
  assert.ok(String(gate.run ?? '').includes('GITHUB_EVENT_NAME'), 'the gate cannot tell a dispatched run from a pushed one')
  assert.ok(String(gate.run ?? '').includes('ROLLBACK'), 'the gate exempts every dispatched run, so a stale dispatch deploys')
  assert.equal(gate.env?.ROLLBACK, '${{ inputs.rollback }}', 'the gate reads a rollback nobody asked for')
})

test('a publish that could not confirm it is current refuses to publish', () => {
  // A failed lookup is not an answer, and treating it as one is how an older tree ends up in front of the newer one
  // without anyone deciding that. Both ways of publishing have to keep "confirmed behind" and "could not tell" apart:
  // the first is handled by the trigger, the second stops the run after a bounded number of attempts. A warning that
  // deploys anyway makes the whole gate advisory for anyone whose network happened to hiccup.
  for (const [name, job] of [
    ['registry.yml', 'registry'],
    ['update-cf-worker.yml', 'update'],
  ] as const) {
    const gate = workflow(name).jobs?.[job]?.steps?.find(step => step.name === 'Check that this run is still the tip of main')
    assert.ok(gate, `${name} deploys without checking whether main has moved on`)
    const command = String(gate.run ?? '')

    assert.ok(command.includes('for attempt in'), `${name} asks main once, so a dropped connection publishes anyway`)
    const retried = command.slice(command.indexOf('for attempt in'), command.indexOf('if [ -z "$tip" ]'))
    assert.ok(retried.includes('sleep'), `${name} retries without pausing, which fires three times in one outage`)
    assert.ok(retried.includes('break'), `${name} retries after a success`)

    const unknown = command.slice(command.indexOf('if [ -z "$tip" ]'))
    const stop = unknown.indexOf('exit 1')
    assert.ok(stop > 0, `${name} publishes the commit it carries when it cannot tell whether main moved on`)
    assert.ok(
      unknown.slice(0, stop).includes('::error'),
      `${name} stops on an unreadable main without naming it, so the run looks like a flake`,
    )
    assert.ok(
      !command.includes('Tip of main unknown'),
      `${name} still warns about an unknown main and deploys, which is the behaviour this test exists to prevent`,
    )
  }
})

test('the manual deploy refuses a superseded run rather than reporting a green one', () => {
  // `update-cf-worker.yml` deploys the same worker and shares the same queue, but it has no newer run of itself waiting
  // behind it — a manual run is the only one that exists. Skipping green there would report a deploy that never
  // happened, so it stops with an error that names both ways forward. The rollback input is what keeps an intentional
  // rollback possible without making "dispatched by hand" mean "publish whatever commit this is".
  const update = workflow('update-cf-worker.yml')
  const gate = update.jobs?.update?.steps?.find(step => step.name === 'Check that this run is still the tip of main')
  assert.ok(gate, 'update-cf-worker.yml deploys without checking whether main has moved on')
  assert.equal(gate.env?.ROLLBACK, '${{ inputs.rollback }}', 'the manual gate cannot tell a rollback from a stale dispatch')

  const command = String(gate.run ?? '')
  assert.ok(command.includes('refs/heads/main'), `the manual gate does not read main: ${command}`)
  assert.ok(command.includes('exit 1'), 'a superseded manual deploy reports success although it published nothing')

  // Both workflows that deploy the worker publish a commit only when that commit is what `main` carries, and the
  // rollback input has to exist in both or the check has no way to be overridden where it is needed.
  for (const name of ['registry.yml', 'update-cf-worker.yml']) {
    const inputs = (workflow(name) as { on?: { workflow_dispatch?: { inputs?: Record<string, unknown> } } }).on
      ?.workflow_dispatch?.inputs
    assert.ok(inputs?.rollback, `${name} has no rollback input, so an intentional rollback cannot be published`)
  }
})

test('a report names the pull request the run recorded, not the one it would have guessed', () => {
  // Resolving the pull request is guesswork when the run reports no `pull_requests` entry, which is every fork pull
  // request. The run's own record is not a guess: it names the pull request it read and the commit it judged. Reading
  // that first is what stops a good verdict from being thrown away — resolving first and comparing afterwards declined
  // to report at all whenever the two disagreed, and the report of a run that judged #5 was dropped because the guess
  // said #7. The recording step has to stay ahead of every other way of finding the number.
  const steps = workflow('pr-result.yml').jobs?.resolve?.steps ?? []
  const read = steps.find(step => String(step.uses ?? '').startsWith('actions/download-artifact@'))
  const resolve = steps.find(step => step.name === 'Read the pull request')
  assert.ok(read, 'pr-result.yml resolves the number before it has read what the run recorded')
  assert.ok(resolve, 'pr-result.yml no longer reads the pull request')
  assert.ok(
    steps.indexOf(read) < steps.indexOf(resolve),
    'the record is downloaded after the number was guessed, so the guess decides which pull request is reported on',
  )
  const command = String(resolve.run ?? '')
  assert.ok(command.includes('judged.json'), `the recorded judgement is not read at all: ${command}`)
  assert.ok(
    command.indexOf('judged.json') < command.indexOf('pull_requests[0]'),
    'the recorded number is read after the guess, so the guess still wins',
  )

  // The job has to publish the recorded commit as well as the number, because the check before posting compares it
  // against the pull request's head and a missing value would compare equal to nothing.
  const outputs = workflow('pr-result.yml').jobs?.resolve as { outputs?: Record<string, unknown> } | undefined
  assert.ok(outputs?.outputs?.judged, 'pr-result.yml does not pass the judged commit on')
  assert.ok(outputs?.outputs?.recorded, 'pr-result.yml cannot tell a recording from a missing one')
})

test('a run that judges nothing reports under a name the merge gate does not read', () => {
  // `Check` is the name the ruleset requires, and GitHub keeps a check run for every job a run contains — including one
  // its `if` skipped — while a skipped check counts as a passing one. A maintainer adding a `plugins` or category label
  // is a `pull_request_target` event on the same commit, resolves no lane, and skips this job; that skip would then be
  // the newest result under the required name, a green tick published by an event that judged nothing. Not queueing such
  // a run was never enough: the result it leaves behind is the problem.
  const check = workflow('pr.yml').jobs?.check
  assert.ok(check, 'pr.yml has no job named "check"')
  const name = String(check.name ?? '')
  const condition = String(check.if ?? '')
  assert.ok(name, 'the check job has no name, so no rule can require it')

  // The name has to be the negation of the `if`, term for term, or the two drift: a skipped `Check` hides a failure,
  // and a `Check` under any other name leaves a pull request waiting for a check nothing will report. The name drops
  // `always()`, which only exists on the `if` so that a failed `resolve` still reaches the job and turns it red.
  const nothingToJudge = name
  assert.ok(
    nothingToJudge.includes("needs.resolve.outputs.lane == ''"),
    `the job name ignores the lane, so a skipped run can keep the required name: ${nothingToJudge}`,
  )
  assert.ok(
    nothingToJudge.includes("needs.resolve.result == 'success'"),
    `the job name ignores whether resolve failed, so a red run could be renamed green: ${nothingToJudge}`,
  )
  assert.ok(
    condition.includes("needs.resolve.outputs.lane != ''"),
    `the if ignores the lane: ${condition}`,
  )
  assert.ok(
    condition.includes("needs.resolve.result != 'success'"),
    `the if ignores whether resolve failed: ${condition}`,
  )
  assert.ok(name.includes("'Check'"), `the job never reports under the required name: ${name}`)
  assert.ok(name.includes('Nothing to judge'), `a skipped run still reports under the required name: ${name}`)
})
