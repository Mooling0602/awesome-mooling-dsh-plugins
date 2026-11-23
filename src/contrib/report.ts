#!/usr/bin/env node
/**
 * Render the one comment a pull request gets from its check run.
 *
 * The comment is built from GitHub's own record of the run rather than from the run's output. A fork's pull request can
 * write anything into a step's log or into an artifact, but it cannot change the conclusion GitHub assigns to that step,
 * and this only reads conclusions. That keeps the privileged workflow which posts the comment free of attacker-written
 * text.
 *
 * Whether a run gets a comment at all is {@link shouldPost}, and the answer is deliberately narrow:
 *
 * - A passing run is reported, because that is the signal a maintainer acts on.
 * - A failing run is reported only while the pull request is a draft, where a failure is expected work in progress.
 * - A failing run on a ready pull request is not reported. Such a pull request is closed rather than corrected, and the
 *   closure is the whole response; a comment explaining how to fix something that is already closed is noise.
 *
 * The rows are the checks `pr.yml` runs, in the order it runs them. A step that never started reports as not run, so a
 * run that stopped early still produces a complete table.
 *
 * ```sh
 * node src/contrib/report.ts --jobs jobs.json --conclusion success --draft false
 * ```
 */
import { readFileSync } from 'node:fs'

/** Marker identifying the comment this repository owns, so a later run can update or remove exactly that one. */
export const MARKER = '<!-- dsh-pr-report -->'

/** A short label written in both languages the comment uses. */
interface Bilingual {
  /** English text. */
  readonly en: string
  /** Chinese text. */
  readonly zh: string
}

/** What each check step is called in `pr.yml`, in the order that workflow runs them. */
const CHECKS: readonly { readonly name: string; readonly check: Bilingual; readonly about: Bilingual }[] = [
  {
    name: 'Dependencies',
    check: { en: 'Dependencies', zh: '依赖' },
    about: { en: 'the lockfile resolves without changes', zh: '锁文件无需改动即可解析' },
  },
  {
    name: 'Check the pull request title and the submitted metadata',
    check: { en: 'Submission', zh: '投稿内容' },
    about: {
      en: 'one plugin.yml, valid fields, correct shard, the title names it',
      zh: '仅一个 plugin.yml，字段有效，分片正确，标题指明插件',
    },
  },
  {
    name: 'Build registry data',
    check: { en: 'Registry', zh: '注册表数据' },
    about: { en: 'every hosted release resolves to a tarball', zh: '每个托管的发布都能解析到 tarball' },
  },
  {
    name: 'Build index',
    check: { en: 'Index', zh: '索引' },
    about: { en: 'dists/index.json lists every plugin', zh: 'dists/index.json 列出所有插件' },
  },
  {
    name: 'Typecheck',
    check: { en: 'Types', zh: '类型' },
    about: { en: 'tsc accepts every source file', zh: 'tsc 接受所有源文件' },
  },
  {
    name: 'Test',
    check: { en: 'Tests', zh: '测试' },
    about: { en: 'the whole suite passes', zh: '全部测试通过' },
  },
  {
    name: 'Verify the worker bundles',
    check: { en: 'Bundle', zh: '打包' },
    about: { en: 'wrangler builds the worker without an account', zh: 'wrangler 无需账号即可构建 worker' },
  },
]

/**
 * Run conclusions that carry no verdict about the code, so describing them as a result would mislead.
 *
 * A cancelled run means a newer push superseded it and that newer run will report instead; a skipped or stale run never
 * reached the checks at all. Reporting these would show a table of nothing on a pull request that is still being worked
 * on.
 */
const NO_VERDICT = new Set(['cancelled', 'skipped', 'stale'])

/** One step as the jobs API reports it. */
export interface Step {
  /** The step's `name` in the workflow. */
  readonly name: string
  /** `success`, `failure`, `skipped`, `cancelled`, or null when the step never started. */
  readonly conclusion: string | null
}

/** One job as the jobs API reports it. */
export interface Job {
  /** The job's key or name; not used to pick checks, since all of them run in one job. */
  readonly name?: string
  /** The steps the job ran, in order. */
  readonly steps?: readonly Step[]
}

/** One rendered table row. */
export interface Row {
  /** Short name of the area the check covers, in both languages. */
  readonly check: Bilingual
  /** How the check ended, as a word a reader can scan without knowing the icons, in both languages. */
  readonly result: Bilingual
  /** What the check establishes when it passes, in both languages. */
  readonly about: Bilingual
}

/** Everything the renderer needs about one run. */
export interface Report {
  /** The run's overall conclusion, as GitHub reports it: `success`, `failure`, `cancelled`, and so on. */
  readonly conclusion: string
  /** The jobs the run reported. */
  readonly jobs: readonly Job[]
}

/**
 * Decide whether a run gets a comment.
 * @param conclusion - the run's overall conclusion.
 * @param draft - whether the pull request is a draft at the time the comment would be written.
 * @returns true when the run should be reported, false when silence is the right response.
 */
export function shouldPost(conclusion: string, draft: boolean): boolean {
  if (conclusion === 'success') return true
  if (NO_VERDICT.has(conclusion)) return false
  // Everything else is a failure of some kind: `failure`, `timed_out`, `startup_failure`, `action_required`. On a draft
  // that is work in progress worth showing; on a ready pull request it closes the pull request and needs no comment.
  return draft
}

/**
 * Turn one step's conclusion into a word with its icon, in both languages.
 * @param conclusion - the conclusion GitHub assigned, or null when the step never started.
 * @returns the scan-friendly result text.
 */
export function resultOf(conclusion: string | null): Bilingual {
  switch (conclusion) {
    case 'success':
      return { en: '✅ Passed', zh: '✅ 通过' }
    case 'failure':
      return { en: '❌ Failed', zh: '❌ 失败' }
    case 'skipped':
      return { en: '⏭️ Skipped', zh: '⏭️ 跳过' }
    case 'cancelled':
      return { en: '⏹️ Cancelled', zh: '⏹️ 取消' }
    default:
      return { en: '⚪ Not run', zh: '⚪ 未运行' }
  }
}

/**
 * Collect the table rows for a run.
 * @param jobs - the jobs the run reported.
 * @returns one row per check, in workflow order, whether or not the run reached it.
 */
export function rowsOf(jobs: readonly Job[]): Row[] {
  const byName = new Map<string, string | null>()
  for (const job of jobs) {
    for (const step of job.steps ?? []) byName.set(step.name, step.conclusion)
  }
  return CHECKS.map(({ name, check, about }) => ({
    check,
    result: resultOf(byName.get(name) ?? null),
    about,
  }))
}

/**
 * Render the comment body.
 *
 * The comment is bilingual because a contributor's language is not known when the workflow runs, and a table a reader
 * cannot read is not a report. Each cell carries both languages rather than the comment being written twice, so the
 * table stays one table and the two readings stay aligned.
 * @param report - the run to describe.
 * @returns the markdown body, marker first so a later run can find it.
 */
export function render(report: Report): string {
  const passed = report.conclusion === 'success'
  const lines: string[] = [MARKER]
  if (passed) {
    lines.push('## ✅ Checks passed / 检查全部通过', '')
    lines.push('All checks passed. This pull request is ready to merge.', '')
    lines.push('所有检查通过，这个 PR 可以合并。', '')
  } else {
    lines.push('## ❌ Checks failed / 检查未通过', '')
    lines.push('One or more checks failed. Expand the failing step under **Checks** to read its log.', '')
    lines.push('有检查未通过。在 **Checks** 标签页展开失败的步骤即可查看日志。', '')
  }
  lines.push('| Check / 检查项 | Result / 结果 | What it verifies / 验证内容 |')
  lines.push('| --- | --- | --- |')
  for (const row of rowsOf(report.jobs)) {
    lines.push(`| ${row.check.en} / ${row.check.zh} | ${row.result.en} / ${row.result.zh} | ${row.about.en}<br>${row.about.zh} |`)
  }
  lines.push('')
  lines.push('<sub>Posted by the PR workflow. It updates this comment instead of adding another.</sub>')
  lines.push('<sub>由 PR 工作流发布，会更新本条评论而不是重复添加。</sub>')
  return `${lines.join('\n')}\n`
}

/** Whether this file is the process entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return entry.endsWith('report.ts') || entry.endsWith('report.js')
}

/**
 * Read a flag's value.
 * @param flag - the flag to look for, including its leading dashes.
 * @param fallback - the value to use when the flag is absent.
 * @returns the value given, or the fallback.
 */
function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag)
  if (index === -1) return fallback
  return process.argv[index + 1] ?? fallback
}

/**
 * Read a jobs payload, accepting either shape GitHub hands out.
 *
 * The jobs endpoint answers with `{ total_count, jobs: [...] }` while the list itself is what the rows are built from.
 * The workflow unwraps it with `--jq '.jobs'`, and this accepts the wrapped form too: the failure it prevents is a
 * `jobs is not iterable` crash after a successful run, which is the worst moment to lose the report.
 * @param text - the file contents.
 * @returns the job list.
 */
export function jobsOf(text: string): Job[] {
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed as Job[]
  if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { jobs?: unknown }).jobs)) {
    return (parsed as { jobs: Job[] }).jobs
  }
  return []
}

if (invokedDirectly()) {
  const path = arg('--jobs', '')
  if (path === '') {
    console.error('usage: node src/contrib/report.ts --jobs <jobs.json> [--conclusion <s>] [--draft <bool>]')
    process.exit(2)
  }
  const conclusion = arg('--conclusion', 'failure')
  const draft = arg('--draft', 'false') === 'true'
  if (!shouldPost(conclusion, draft)) {
    // Nothing is written to stdout, so the caller can treat an empty file as "say nothing". The reason goes to stderr,
    // which the workflow shows in the run log without ever becoming part of the comment.
    console.error(`Nothing to report for a ${conclusion} run on a ${draft ? 'draft' : 'ready'} pull request.`)
    process.exit(0)
  }
  process.stdout.write(render({ conclusion, jobs: jobsOf(readFileSync(path, 'utf8')) }))
}
