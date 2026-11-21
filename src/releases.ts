/**
 * Find the release tarballs a plugin publishes.
 *
 * A git source needs no tarball: the generator reads the default branch HEAD. A plugin the registry serves does need
 * one, because npm clients install `dist.tarball`, so each version must name `<plugin>-<version>.tgz` attached to a
 * GitHub release whose tag is that version.
 */

/** One GitHub release, reduced to what the registry needs. */
export interface Release {
  readonly tag: string
  readonly draft: boolean
  /** ISO 8601 publish time; the registry publishes it as the version's `time` entry. */
  readonly published_at?: string
  readonly assets: readonly {
    readonly name: string
    /** Browser-download URL; required for an asset that has to be installed. */
    readonly browser_download_url?: string
  }[]
}

/** One installable version of a plugin. */
export interface Downloadable {
  readonly version: string
  /** Browser-download URL of the release asset. */
  readonly tarball: string
  /** ISO 8601 publish time of the release the asset belongs to. */
  readonly published: string
}

/** Numeric dot-separated version, optionally with a prerelease suffix. */
const SEMVER = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/u

/**
 * Parse a version tag.
 * @param tag - a release tag such as `1.2.3` or `v1.2.3`.
 * @returns the version without a `v` prefix, or `undefined` when the tag is not a version.
 */
export function parseTag(tag: string): string | undefined {
  const bare = tag.startsWith('v') ? tag.slice(1) : tag
  return SEMVER.test(bare) ? bare : undefined
}

/**
 * Compare two versions by SemVer 2.0.0 precedence.
 * @param left - a version without a `v` prefix.
 * @param right - a version without a `v` prefix.
 * @returns a negative number when `left` is older, positive when newer, zero when equal.
 */
export function compareVersions(left: string, right: string): number {
  const a = SEMVER.exec(left)?.groups as Record<string, string | undefined> | undefined
  const b = SEMVER.exec(right)?.groups as Record<string, string | undefined> | undefined
  if (a === undefined || b === undefined) return left.localeCompare(right)
  for (const part of ['major', 'minor', 'patch'] as const) {
    const difference = Number(a[part]) - Number(b[part])
    if (difference !== 0) return difference
  }
  const x = a['prerelease']
  const y = b['prerelease']
  // A release outranks any prerelease of the same version.
  if (x === undefined && y === undefined) return 0
  if (x === undefined) return 1
  if (y === undefined) return -1
  return comparePrerelease(x, y)
}

/**
 * Compare two prerelease suffixes by SemVer 2.0.0 rule 11.
 * @param left - the first suffix, without its leading hyphen.
 * @param right - the second suffix, without its leading hyphen.
 * @returns a negative number when `left` sorts first, positive when it sorts later, zero when equal.
 */
function comparePrerelease(left: string, right: string): number {
  const a = left.split('.')
  const b = right.split('.')
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index]
    const y = b[index]
    // A shorter suffix sorts first when every preceding identifier is equal.
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/u.test(x)
    const yNumeric = /^\d+$/u.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return difference
      continue
    }
    // Numeric identifiers always sort before alphanumeric ones.
    if (xNumeric) return -1
    if (yNumeric) return 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * Read the `owner/repo` path of a GitHub repository URL.
 * @param repository - the repository URL recorded in the plugin metadata.
 * @returns the path segment used by the GitHub API.
 * @throws when the URL is not an https://github.com/<owner>/<repo> URL.
 */
export function repositoryPath(repository: string): string {
  let url: URL
  try {
    url = new URL(repository)
  } catch {
    throw new Error(`not a URL: ${JSON.stringify(repository)}`)
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com') {
    throw new Error(`not an https://github.com URL: ${JSON.stringify(repository)}`)
  }
  const segments = url.pathname.replace(/^\/+/u, '').replace(/\/+$/u, '').replace(/\.git$/u, '').split('/')
  if (segments.length !== 2 || segments.some(segment => segment === '')) {
    throw new Error(`not an https://github.com/<owner>/<repo> URL: ${JSON.stringify(repository)}`)
  }
  return segments.join('/')
}

/**
 * Pick the release assets that install a plugin.
 * @param name - the plugin package name; assets are named `<name>-<version>.tgz`.
 * @param releases - the repository releases.
 * @param warn - receives a message for every release that cannot be used.
 * @returns the installable versions, newest first.
 */
export function downloadableVersions(
  name: string,
  releases: readonly Release[],
  warn: (message: string) => void,
): Downloadable[] {
  const found = new Map<string, Downloadable>()
  for (const release of releases) {
    if (release.draft) continue
    const version = parseTag(release.tag)
    if (version === undefined) {
      warn(`${name}: skipping release ${JSON.stringify(release.tag)}: the tag is not a version`)
      continue
    }
    const asset = release.assets.find(candidate => candidate.name === `${name}-${version}.tgz`)
    if (asset === undefined) {
      warn(`${name}: skipping release ${JSON.stringify(release.tag)}: no ${name}-${version}.tgz asset`)
      continue
    }
    if (found.has(version)) {
      warn(`${name}: ignoring duplicate release for version ${version}`)
      continue
    }
    found.set(version, {
      version,
      tarball: assetDownloadUrl(release, asset.name),
      // A release always carries a date, but the type is optional so a fixture need not invent one.
      published: release.published_at ?? new Date(0).toISOString(),
    })
  }
  return [...found.values()].sort((left, right) => compareVersions(right.version, left.version))
}

/**
 * Read the browser-download URL of an asset.
 * @param release - the release holding the asset.
 * @param assetName - the asset file name.
 * @returns the URL the asset is downloaded from.
 * @throws when the release does not carry a download URL for the asset.
 */
export function assetDownloadUrl(release: Release, assetName: string): string {
  const asset = release.assets.find(candidate => candidate.name === assetName)
  if (asset?.browser_download_url === undefined) throw new Error(`${assetName}: asset carries no browser_download_url`)
  return asset.browser_download_url
}
