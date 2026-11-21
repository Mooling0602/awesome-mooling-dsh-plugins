#!/usr/bin/env node
/**
 * Build the packuments the CF Workers registry serves.
 *
 * Every plugin dispatched as `tarball` publishes its releases as `.tgz` assets rather than to an npm registry, so pnpm
 * cannot resolve it. This script reads those assets, computes the integrity of each tarball once from its exact bytes,
 * and writes one packument per plugin plus a `manifest.json` the worker reads to find the tarballs.
 *
 * Run from the repository root:
 *
 * ```sh
 * node src/registry/build.ts
 * node src/registry/build.ts --check
 * ```
 *
 * Output, under `dists/registry/`:
 *
 * - `packuments/<name>.json` — the document served at `GET /<name>`.
 * - `manifest.json` — every package, version, and asset URL the worker needs.
 *
 * GitHub serves release assets through a signed redirect that expires, so the asset URLs are re-read on every build and
 * the integrity is recomputed from the bytes actually downloaded. A release asset that is replaced in place therefore
 * cannot silently invalidate an integrity recorded earlier.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPlugins, type Plugin } from '../metadata.ts'
import { needsConversion } from '../sources.ts'
import { downloadableVersions, repositoryPath, type Release } from '../releases.ts'
import { integrityOf, type Integrity } from '../integrity.ts'
import { buildPackument, type Packument, type TarballVersion } from '../packument.ts'

/** Repository root, one level above `src/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the worker's data is written. */
export const OUTPUT = join(ROOT, 'dists', 'registry')

/** User agent GitHub's API asks clients to send. */
const USER_AGENT = 'awesome-mooling-dsh-plugins'

/** One package as the worker needs it: its packument plus where each version's bytes live. */
export interface ManifestEntry {
  /** Package name, as it appears in the packument. */
  readonly name: string
  /** Repository the assets belong to, `owner/name`. */
  readonly repository: string
  /** Version to asset URL, newest first. */
  readonly versions: Readonly<Record<string, string>>
  /** Version to integrity, so the worker can answer without re-reading the asset. */
  readonly integrity: Readonly<Record<string, string>>
}

/** Everything the worker reads from KV. */
export interface RegistryManifest {
  /** Build time, informational only. */
  readonly builtAt: string
  /** The converted packages, keyed by name. */
  readonly packages: Readonly<Record<string, ManifestEntry>>
}

/** One release exactly as GitHub's API returns it, reduced to the fields this script reads. */
interface ApiRelease {
  readonly tag_name: string
  readonly draft: boolean
  readonly published_at?: string
  readonly assets: readonly { readonly name: string; readonly browser_download_url?: string }[]
}

/**
 * Read every release of a repository.
 * @param repository - `owner/name`.
 * @param token - GitHub token; unauthenticated requests are limited to 60 per hour.
 * @returns the releases, in the reduced shape the rest of this module uses.
 * @throws when GitHub answers with a non-success status.
 */
export async function readReleases(repository: string, token = process.env.GITHUB_TOKEN): Promise<Release[]> {
  const releases: Release[] = []
  for (let page = 1; ; page += 1) {
    const url = `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }
    if (token !== undefined && token !== '') headers.authorization = `Bearer ${token}`
    const response = await fetch(url, { headers })
    if (!response.ok) throw new Error(`${repository}: GitHub answered HTTP ${response.status} for ${url}`)
    const batch = (await response.json()) as ApiRelease[]
    // GitHub calls the tag `tag_name`; the rest of this module works with `tag`.
    releases.push(...batch.map(release => ({
      tag: release.tag_name,
      draft: release.draft,
      assets: release.assets,
      ...release.published_at === undefined ? {} : { published_at: release.published_at },
    })))
    if (batch.length < 100) return releases
  }
}

/**
 * Download one tarball.
 * @param url - the asset's browser download URL.
 * @returns the bytes.
 * @throws when the download fails.
 */
export async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow' })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Read a tarball's `package.json`.
 *
 * The asset is a gzipped tar, so this reads only the `package.json` member rather than the whole archive. The integrity
 * is computed separately from the complete bytes, so a member this function cannot parse never weakens the check.
 * @param bytes - the tarball.
 * @returns the manifest.
 * @throws when the archive holds no readable `package.json`.
 */
export async function readManifest(bytes: Uint8Array): Promise<TarballVersion['manifest']> {
  const { gunzipSync } = await import('node:zlib')
  const tar = gunzipSync(bytes)
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') break
    const rawSize = header.subarray(124, 136).toString('utf8').replace(/\0.*$/u, '').trim()
    const size = Number.parseInt(rawSize === '' ? '0' : rawSize, 8)
    const body = tar.subarray(offset + 512, offset + 512 + size)
    // npm packs every member under a single `package/` prefix; a bare root and a leading `./` are tolerated too.
    const base = name.replace(/^\.\//u, '').replace(/^package\//u, '').replace(/\/$/u, '')
    if (base === 'package.json') return JSON.parse(body.toString('utf8')) as TarballVersion['manifest']
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('the tarball has no package.json at its root')
}

/**
 * Build the packument of one plugin from its release tarballs.
 * @param plugin - the plugin to convert.
 * @param releases - its repository releases.
 * @param warn - receives a message for every unusable release.
 * @returns the packument and the manifest entry, or undefined when no version could be used.
 */
export async function buildEntry(
  plugin: Plugin,
  releases: readonly Release[],
  warn: (message: string) => void,
): Promise<{ packument: Packument; entry: ManifestEntry } | undefined> {
  const downloadable = downloadableVersions(plugin.package, releases, warn)
  if (downloadable.length === 0) {
    warn(`${plugin.package}: no release carries a usable tarball asset`)
    return undefined
  }
  const versions: TarballVersion[] = []
  const urls: Record<string, string> = {}
  const integrities: Record<string, string> = {}
  for (const candidate of downloadable) {
    const bytes = await download(candidate.tarball)
    const integrity: Integrity = integrityOf(bytes)
    const manifest = await readManifest(bytes)
    // The release page segment is the release tag, which need not equal the version: a tag may carry a `v` prefix.
    // `browser_download_url` already names the right asset, so it is used verbatim instead of being rebuilt.
    versions.push({ manifest, tarball: candidate.tarball, integrity, published: candidate.published })
    urls[candidate.version] = candidate.tarball
    integrities[candidate.version] = integrity.integrity
  }
  // Newest first, so the latest tag is the first entry.
  const latest = versions[0]?.manifest.version
  const packument = buildPackument(plugin.package, versions, latest)
  return {
    packument,
    entry: { name: plugin.package, repository: repositoryPath(plugin.repo), versions: urls, integrity: integrities },
  }
}

/**
 * Build every packument the registry serves.
 * @param root - repository root.
 * @param warn - receives a message for every plugin or release that cannot be converted.
 * @returns the manifest and the packuments, keyed by package name.
 */
export async function buildRegistry(
  root: string = ROOT,
  warn: (message: string) => void = message => console.warn(`warning: ${message}`),
): Promise<{ manifest: RegistryManifest; packuments: Map<string, Packument> }> {
  const plugins = (await readPlugins(root)).filter(plugin => needsConversion(plugin))
  const packuments = new Map<string, Packument>()
  const packages: Record<string, ManifestEntry> = {}
  for (const plugin of plugins) {
    const releases = await readReleases(repositoryPath(plugin.repo))
    const built = await buildEntry(plugin, releases, warn)
    if (built === undefined) continue
    packuments.set(plugin.package, built.packument)
    packages[plugin.package] = built.entry
  }
  return { manifest: { builtAt: new Date().toISOString(), packages }, packuments }
}

/**
 * The KV records the worker reads, in the shape `wrangler kv bulk put` accepts.
 *
 * Each key is a package name and each value is the packument plus the tarball location of every version, which is
 * exactly what `route()` expects through its lookup callback.
 * @param manifest - the built manifest.
 * @param packuments - the built packuments.
 * @returns one record per hosted package.
 */
export function kvRecords(
  manifest: RegistryManifest,
  packuments: ReadonlyMap<string, Packument>,
): { key: string; value: string }[] {
  return Object.entries(manifest.packages).map(([name, entry]) => {
    const tarballs: Record<string, { tarball: string }> = {}
    for (const [version, url] of Object.entries(entry.versions)) tarballs[version] = { tarball: url }
    return { key: name, value: JSON.stringify({ packument: packuments.get(name), tarballs }) }
  })
}

/**
 * Write the manifest, every packument, and the KV bulk file under `dists/registry/`.
 * @param root - repository root.
 * @returns how many packages were written.
 */
export async function writeRegistry(root: string = ROOT): Promise<number> {
  const { manifest, packuments } = await buildRegistry(root)
  const dist = join(root, 'dists', 'registry')
  await mkdir(join(dist, 'packuments'), { recursive: true })
  for (const [name, packument] of packuments) {
    await writeFile(join(dist, 'packuments', `${name}.json`), `${JSON.stringify(packument)}\n`, 'utf8')
  }
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  // Consumed by `wrangler kv bulk put`; keeping it beside the packuments means the deployed KV and the checked-in
  // output can never describe different versions.
  await writeFile(join(dist, 'kv.json'), `${JSON.stringify(kvRecords(manifest, packuments), null, 2)}\n`, 'utf8')
  return packuments.size
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

if (invokedDirectly()) {
  const check = process.argv.includes('--check')
  if (check) {
    let manifest: RegistryManifest
    try {
      manifest = JSON.parse(await readFile(join(OUTPUT, 'manifest.json'), 'utf8')) as RegistryManifest
    } catch {
      console.error('dists/registry/manifest.json is missing; run `node src/registry/build.ts`')
      process.exit(1)
    }
    const count = Object.keys(manifest.packages).length
    console.log(`dists/registry/manifest.json lists ${count} package(s)`)
  } else {
    const count = await writeRegistry(ROOT)
    console.log(`wrote dists/registry/: ${count} packument(s)`)
  }
}
