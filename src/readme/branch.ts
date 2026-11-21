/**
 * Read the default branch each plugin repository uses.
 *
 * A relative README path has to become a link into the plugin's repository, and the link needs the branch name: a
 * `blob/main/...` URL breaks when the repository renamed its branch or never used `main` at all. `HEAD` is accepted by
 * GitHub in a blob URL, but only for some paths, so the branch is read from the API instead and the link is built from
 * the real name.
 *
 * One request per repository, not per plugin: two plugins may live in the same repository. The caller passes a token
 * when it has one, because the unauthenticated API allows 60 requests per hour and a rate-limited request would
 * otherwise turn into a broken link.
 */
import { repositoryPath } from '../releases.ts'

/** The GitHub API base URL. */
const API = 'https://api.github.com'

/** Headers that make a GitHub API call explicit; the token is omitted when there is none. */
function headers(token: string | undefined): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'awesome-mooling-dsh-plugins',
  }
  if (token !== undefined && token !== '') result.authorization = `Bearer ${token}`
  return result
}

/**
 * Read one repository's default branch.
 * @param repository - the repository URL recorded in the plugin metadata.
 * @param token - GitHub token, when the caller has one.
 * @returns the branch name.
 * @throws when the repository URL is not a GitHub URL or the API call fails.
 */
export async function defaultBranch(repository: string, token?: string): Promise<string> {
  const path = repositoryPath(repository)
  const response = await fetch(`${API}/repos/${path}`, { headers: headers(token) })
  if (!response.ok) throw new Error(`${path}: GitHub API answered ${response.status}`)
  const body = (await response.json()) as { default_branch?: unknown }
  if (typeof body.default_branch !== 'string' || body.default_branch === '') {
    throw new Error(`${path}: GitHub API returned no default_branch`)
  }
  return body.default_branch
}

/**
 * Read the default branch of every distinct repository.
 *
 * A repository that cannot be read keeps its entry out of the result rather than failing the build: the README must
 * still be generated when GitHub is unreachable, and a link built from a guessed branch is worse than one branch short.
 * @param repositories - repository URLs, possibly repeated.
 * @param token - GitHub token, when the caller has one.
 * @param warn - receives a message for every repository that could not be read.
 * @returns the branch name of each repository that was read, keyed by repository URL.
 */
export async function defaultBranches(
  repositories: readonly string[],
  token?: string,
  warn: (message: string) => void = message => console.warn(`warning: ${message}`),
): Promise<ReadonlyMap<string, string>> {
  const branches = new Map<string, string>()
  for (const repository of new Set(repositories)) {
    try {
      branches.set(repository, await defaultBranch(repository, token))
    } catch (error) {
      warn(`${repository}: ${error instanceof Error ? error.message : String(error)}; its README links will be omitted`)
    }
  }
  return branches
}
