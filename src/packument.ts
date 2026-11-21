/**
 * Build an npm packument from release tarballs.
 *
 * The registry answers `GET /<name>` with a packument, so every version it lists has to carry a `dist.tarball` and a
 * `dist.integrity` computed from the exact bytes that URL serves. This module assembles that document; reading the
 * tarballs is the caller's job, so the shape can be tested without network access.
 */
import type { Integrity } from './integrity.ts'
import { compareVersions } from './releases.ts'

/** Fields copied from a release tarball's `package.json`. */
export interface Manifest {
  readonly name: string
  readonly version: string
  readonly description?: string
  readonly license?: string
  readonly homepage?: string
  readonly repository?: string | { readonly type?: string; readonly url?: string }
  readonly keywords?: readonly string[]
  readonly engines?: Readonly<Record<string, string>>
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>
  readonly bin?: string | Readonly<Record<string, string>>
  readonly main?: string
  readonly exports?: unknown
  readonly dsh?: unknown
}

/** One version to publish, paired with the tarball that installs it. */
export interface TarballVersion {
  readonly manifest: Manifest
  /** Absolute URL npm clients download this version from. */
  readonly tarball: string
  readonly integrity: Integrity
  /**
   * When the version was published.
   *
   * The generator reads `packument.time[version]` and drops every version where it is not a string, so a packument
   * without `time` yields an index that silently lists none of this registry's plugins. The release's publish date is
   * used for it.
   */
  readonly published: string
}

/** The subset of a packument pnpm reads to resolve and install a version. */
export interface Packument {
  readonly name: string
  readonly 'dist-tags': { readonly latest: string }
  readonly versions: Readonly<Record<string, Record<string, unknown>>>
  /** ISO 8601 publish time per version, plus a `modified` stamp. Required for the generator to see any version. */
  readonly time: Readonly<Record<string, string>>
}

/** Manifest keys copied verbatim into the version record, when present. */
const COPIED = [
  'description',
  'license',
  'homepage',
  'repository',
  'keywords',
  'engines',
  'dependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bin',
  'main',
  'exports',
] as const

/**
 * Pick the highest version by SemVer precedence.
 * @param versions - the published version strings.
 * @returns the highest version, or `undefined` for an empty list.
 */
function latestOf(versions: readonly string[]): string | undefined {
  return versions.length === 0 ? undefined : [...versions].sort(compareVersions).at(-1)
}

/**
 * Build one version record.
 * @param entry - the manifest, tarball URL and hashes.
 * @returns the record pnpm reads from `versions[version]`.
 */
export function versionRecord(entry: TarballVersion): Record<string, unknown> {
  const record: Record<string, unknown> = {
    name: entry.manifest.name,
    version: entry.manifest.version,
    dist: {
      tarball: entry.tarball,
      integrity: entry.integrity.integrity,
      shasum: entry.integrity.shasum,
    },
  }
  for (const key of COPIED) {
    const value = entry.manifest[key]
    if (value !== undefined) record[key] = value
  }
  // DSH reads dsh.bundle to decide whether a package is a plugin; keeping it lets the market inspect the registry.
  if (entry.manifest.dsh !== undefined) record['dsh'] = entry.manifest.dsh
  return record
}

/**
 * Build a packument.
 * @param name - the package name every entry must agree with.
 * @param entries - the versions to publish, in any order.
 * @param latest - the version `dist-tags.latest` must name; defaults to the highest version.
 * @returns the packument document.
 * @throws when there are no entries, a manifest disagrees with `name`, or `latest` is not among the versions.
 */
export function buildPackument(name: string, entries: readonly TarballVersion[], latest?: string): Packument {
  if (entries.length === 0) throw new Error(`${name}: a packument needs at least one version`)
  const versions: Record<string, Record<string, unknown>> = {}
  const time: Record<string, string> = {}
  for (const entry of entries) {
    if (entry.manifest.name !== name) {
      throw new Error(`${name}: tarball manifest names ${JSON.stringify(entry.manifest.name)}`)
    }
    if (versions[entry.manifest.version] !== undefined) {
      throw new Error(`${name}: duplicate version ${entry.manifest.version}`)
    }
    versions[entry.manifest.version] = versionRecord(entry)
    time[entry.manifest.version] = entry.published
  }
  const highest = latest ?? latestOf(Object.keys(versions))
  if (highest === undefined || versions[highest] === undefined) {
    throw new Error(`${name}: latest ${JSON.stringify(highest)} is not one of the published versions`)
  }
  // `modified` is what the real registry sets to the newest publish time; the generator only needs the per-version keys,
  // but a packument without it looks truncated to anything that inspects one.
  const newest = Object.values(time).sort().at(-1) ?? new Date(0).toISOString()
  return { name, 'dist-tags': { latest: highest }, versions, time: { ...time, modified: newest } }
}

/**
 * Build an abridged packument, the lighter document `Accept: application/vnd.npm.install-v1+json` asks for.
 * @param packument - the full packument.
 * @returns the same document; this registry publishes no extra fields to strip.
 */
export function abridge(packument: Packument): Packument {
  return packument
}
