/**
 * Read the facts a plugin's badges display from GitHub.
 *
 * Three requests per repository at most, not per plugin, because several plugins may live in one repository: the parsed
 * `package.json`, the latest commit on the default branch with its check status, and the plugin's own README. All three
 * are optional in effect, since a missing fact only drops a badge.
 *
 * Nothing here throws on a missing or unreadable file. The README must render even when GitHub is briefly unavailable,
 * so a failure is reported through `warn` and the affected fact is left undefined.
 */
import { repositoryPath } from '../releases.ts'
import { dshVersionOf, isPrerelease, licenseOf, ownBadgesOf, versionOf, type BadgeFacts } from './badge.ts'
import { readmePathFor } from './render.ts'
import type { Language, Plugin } from '../metadata.ts'

/** The GitHub API base URL. */
const API = 'https://api.github.com'

/**
 * Request headers for a GitHub API call.
 * @param token - GitHub token, when the caller has one.
 * @returns headers carrying the API version and, when present, the token.
 */
function headers(token: string | undefined): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'awesome-mooling-dsh-plugins',
  }
  if (token !== undefined && token !== '') result.authorization = `Bearer ${token}`
  return result
}

/**
 * Read and parse a repository file, treating an absent file as an absent value.
 * @param path - the `owner/repo` path.
 * @param file - the file path within the repository.
 * @param token - GitHub token, when the caller has one.
 * @returns the decoded text, or `undefined` when the file does not exist or cannot be read.
 */
async function readFile(path: string, file: string, token: string | undefined): Promise<string | undefined> {
  const response = await fetch(`${API}/repos/${path}/contents/${file}`, { headers: headers(token) })
  if (!response.ok) return undefined
  const body = (await response.json()) as { content?: unknown; encoding?: unknown }
  if (body.encoding !== 'base64' || typeof body.content !== 'string') return undefined
  return Buffer.from(body.content, 'base64').toString('utf8')
}

/**
 * Read whether the latest commit on a branch passes its checks.
 *
 * A commit with no check runs at all yields `undefined` rather than a failure: not running CI is not the same as failing
 * it, and a red badge would misreport a plugin that simply has none.
 * @param path - the `owner/repo` path.
 * @param branch - the branch to inspect.
 * @param token - GitHub token, when the caller has one.
 * @returns whether every completed check passed, or `undefined` when the commit has no checks.
 */
async function readCi(path: string, branch: string, token: string | undefined): Promise<boolean | undefined> {
  const response = await fetch(`${API}/repos/${path}/commits/${branch}/check-runs`, { headers: headers(token) })
  if (!response.ok) return undefined
  const body = (await response.json()) as { total_count?: unknown; check_runs?: readonly { conclusion?: unknown }[] }
  const runs = body.check_runs
  if (!Array.isArray(runs) || runs.length === 0) return undefined
  // A run still in progress has no conclusion yet; it must not be counted as a failure.
  const concluded = runs.filter(run => typeof run.conclusion === 'string' && run.conclusion !== '')
  if (concluded.length === 0) return undefined
  return concluded.every(run => run.conclusion === 'success' || run.conclusion === 'skipped' || run.conclusion === 'neutral')
}

/**
 * Read every badge fact for one plugin.
 * @param plugin - the plugin to read facts for.
 * @param branches - default branches keyed by repository URL.
 * @param token - GitHub token, when the caller has one.
 * @param warn - receives a message for every repository that could not be read.
 * @returns the facts, with any unreadable one left undefined.
 */
export async function readFacts(
  plugin: Plugin,
  branches: ReadonlyMap<string, string>,
  token: string | undefined,
  warn: (message: string) => void,
): Promise<BadgeFacts> {
  let path: string
  try {
    path = repositoryPath(plugin.repo)
  } catch (error) {
    warn(`${plugin.id}: ${error instanceof Error ? error.message : String(error)}; its badges are omitted`)
    return {}
  }
  const branch = branches.get(plugin.repo)

  let facts: BadgeFacts = {}
  const manifestText = await readFile(path, 'package.json', token)
  if (manifestText !== undefined) {
    try {
      const manifest = JSON.parse(manifestText) as Record<string, unknown>
      const version = versionOf(manifest)
      facts = {
        ...facts,
        ...(version === undefined ? {} : { version }),
        prerelease: isPrerelease(version),
        ...(() => {
          const license = licenseOf(manifest)
          return license === undefined ? {} : { license }
        })(),
        ...(() => {
          const dshVersion = dshVersionOf(manifest)
          return dshVersion === undefined ? {} : { dshVersion }
        })(),
      }
    } catch {
      warn(`${plugin.id}: package.json is not valid JSON; its version, license and dsh badges are omitted`)
    }
  }

  if (branch !== undefined) {
    const ci = await readCi(path, branch, token)
    if (ci !== undefined) facts = { ...facts, ci }
  }

  const readmePath = readmePathFor(plugin.readme, 'en_US' as Language) ?? readmePathFor(plugin.readme, 'zh_CN' as Language)
  if (readmePath !== undefined && !/^https?:\/\//u.test(readmePath)) {
    const text = await readFile(path, readmePath.replace(/^\.\//u, ''), token)
    if (text !== undefined) {
      const own = ownBadgesOf(text)
      if (own.length > 0) facts = { ...facts, own }
    }
  }

  return facts
}

/**
 * Read the badge facts of every plugin.
 * @param plugins - the plugins to read.
 * @param branches - default branches keyed by repository URL.
 * @param token - GitHub token, when the caller has one.
 * @param warn - receives a message for every plugin whose facts could not be read.
 * @returns facts keyed by plugin id.
 */
export async function readAllFacts(
  plugins: readonly Plugin[],
  branches: ReadonlyMap<string, string>,
  token: string | undefined,
  warn: (message: string) => void = message => console.warn(`warning: ${message}`),
): Promise<ReadonlyMap<string, BadgeFacts>> {
  const facts = new Map<string, BadgeFacts>()
  for (const plugin of plugins) {
    facts.set(plugin.id, await readFacts(plugin, branches, token, warn))
  }
  return facts
}
