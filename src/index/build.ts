/**
 * Generate the plugin market index from this repository's own metadata and build tree.
 *
 * The index used to be produced by the harness' own `plugin-market-generator`, run with `--registry` pointing at the
 * deployed CloudFlare Workers registry. That made index generation depend on the worker, while the worker compiles the
 * index in, so a fresh checkout could not build either one: no index meant no worker, and no worker meant no index
 * source. The worker was only ever a channel, never the origin of the data.
 *
 * This generator reads the data where it actually lives:
 *
 * - `plugins/by-name/<id>/plugin.yml` decides which plugins are listed and where their releases come from.
 * - `dists/registry/packuments/` holds the npm-side data the registry build already produced from GitHub releases.
 * - GitHub itself supplies the git-side releases and any tarball content the packuments do not carry.
 *
 * The output is validated with `parseMarketIndex` from `@deepseek-ai/dsh-plugin-market-index`, the same validator the
 * harness uses, so a change to format 1 fails the build here instead of surfacing in a client.
 *
 * Run from the repository root:
 *
 * ```sh
 * node src/index/build.ts
 * ```
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'
import { readPlugins } from '../metadata.ts'
import type { Plugin } from '../metadata.ts'
import { displayFrom, localeDirectory, type Display } from './display.ts'
import { readTarball } from './tarball.ts'

/** Repository root, two levels above `src/index/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Where the index is written. `dists/` is a build tree and is not committed. */
export const OUTPUT = join(ROOT, 'dists', 'index.json')

/**
 * The public npm registry, read directly for plugins published there.
 *
 * Only the version list is taken from here. The index still records this repository's registry as the install source,
 * because that is the proxy a client must go through for the allow rules to apply.
 */
const NPMJS = 'https://registry.npmjs.org/'

/** The registry the index records for npm-form entries. */
const REGISTRY = 'https://mynpm.staringplanet.top/'

/** Title of the market. */
const TITLE = 'awesome-mooling-dsh-plugins'

/** Stands in for the index URL when validating: only absolute URLs are accepted, and this is a real deployed URL. */
const VALIDATION_URL = 'https://mynpm.staringplanet.top/dsh-plugins/index.json'

/** One release of one plugin, in the shape `MarketVersion` describes. */
interface Release {
  readonly version: string
  readonly publishTimestamp: number
  readonly source: Record<string, unknown>
  readonly engines?: { readonly dsh: string }
}

/** A generated plugin entry. */
interface Entry {
  readonly name: string
  readonly [field: string]: unknown
}

/** One packument version, reduced to the fields the index reads. */
interface PackumentVersion {
  readonly version?: unknown
  readonly description?: unknown
  readonly homepage?: unknown
  readonly repository?: unknown
  readonly keywords?: unknown
  readonly engines?: unknown
  readonly peerDependencies?: unknown
  readonly deprecated?: unknown
  readonly private?: unknown
  readonly dsh?: unknown
  readonly exports?: unknown
  readonly dist?: { readonly tarball?: unknown }
}

/** One packument, reduced to the fields the index reads. */
interface Packument {
  readonly name?: unknown
  readonly time?: Readonly<Record<string, unknown>>
  readonly versions?: Readonly<Record<string, PackumentVersion>>
  readonly 'dist-tags'?: { readonly latest?: unknown }
}

/** The record `src/registry/build.ts` writes beside the packuments. */
interface Manifest {
  readonly packages?: Readonly<Record<string, { readonly repository?: string; readonly versions?: readonly string[] }>>
}

/** `workspace:` ranges mean the running DSH version and impose nothing, exactly as the harness generator treats them. */
const WORKSPACE_RANGE = /^workspace:[\^~*]?$/u

/** Peer dependency names that constrain the DSH version. */
const DSH_PEER = /^@deepseek-ai\/dsh(?:-|$)/u

/**
 * Read one JSON file, or return undefined when it is absent.
 * @param path - file to read.
 * @returns the parsed contents, or undefined.
 */
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * Collect the DSH version range a manifest requires.
 *
 * `engines.dsh` wins when declared. Otherwise the `@deepseek-ai/dsh*` peer ranges are joined, which is what the harness
 * generator does; a version whose ranges are absent or impose nothing lists no `engines` at all.
 * @param manifest - the version's packument entry.
 * @returns the range, or undefined when any DSH version is acceptable.
 */
function dshRange(manifest: PackumentVersion): string | undefined {
  const engines = manifest.engines
  const declared = typeof engines === 'object' && engines !== null && 'dsh' in engines
    ? (engines as { dsh?: unknown }).dsh
    : undefined
  if (typeof declared === 'string' && declared !== '') return declared
  const peers = manifest.peerDependencies
  if (typeof peers !== 'object' || peers === null) return undefined
  const ranges = Object.entries(peers)
    .filter((entry): entry is [string, string] => DSH_PEER.test(entry[0]) && typeof entry[1] === 'string')
    .map(([, range]) => range.trim())
    .filter(range => range !== '*' && !WORKSPACE_RANGE.test(range))
  if (ranges.length === 0) return undefined
  // Several DSH peers usually carry the same range, and writing that range once is both correct and what the harness
  // generator ends up producing after intersecting them. Distinct ranges would need a real intersection, which format 1
  // only accepts if every input is itself a valid range; a comma is the conjunction operator and parentheses are not,
  // so the distinct ranges are joined with spaces and left for the validator to reject if they do not combine.
  const unique = [...new Set(ranges)]
  return unique.length === 1 ? unique[0] : unique.join(' ')
}

/**
 * Whether a packument version declares a DSH bundle and may be listed.
 * @param manifest - the version's packument entry.
 * @returns true when the version is not deprecated, not private, and declares `dsh.bundle`.
 */
function isBundle(manifest: PackumentVersion): boolean {
  if (typeof manifest.deprecated === 'string' && manifest.deprecated !== '') return false
  if (manifest.private === true) return false
  const dsh = manifest.dsh
  return typeof dsh === 'object' && dsh !== null && 'bundle' in dsh
}

/**
 * Build the releases of an npm-form plugin from its packument.
 * @param name - package name.
 * @param packument - the package's packument.
 * @returns the releases, newest first.
 */
function npmReleases(name: string, packument: Packument): Release[] {
  const releases: Release[] = []
  for (const [version, manifest] of Object.entries(packument.versions ?? {})) {
    if (!isBundle(manifest)) continue
    const published = packument.time?.[version]
    if (typeof published !== 'string') continue
    const seconds = Math.floor(Date.parse(published) / 1000)
    if (!Number.isFinite(seconds)) continue
    const range = dshRange(manifest)
    releases.push({
      version,
      publishTimestamp: seconds,
      // The index records where a client installs the package from, which is this repository's registry. That is a
      // property of the published index, not of where this generator read the version list from.
      source: { type: 'npm', registry: REGISTRY },
      ...range === undefined ? {} : { engines: { dsh: range } },
    })
  }
  // Non-empty and in descending SemVer precedence, as format 1 requires.
  return releases.sort((left, right) => compareVersions(right.version, left.version))
}

/**
 * Compare two SemVer versions, prereleases included.
 * @param left - first version.
 * @param right - second version.
 * @returns negative, zero, or positive as `left` sorts before, with, or after `right`.
 */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string): { core: number[]; pre: string[] } => {
    const [core = '', pre = ''] = version.split('-', 2) as [string, string?]
    return {
      core: core.split('.').map(part => Number.parseInt(part, 10) || 0),
      pre: pre === '' ? [] : pre.split('.'),
    }
  }
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0)
    if (difference !== 0) return difference
  }
  // A version without a prerelease outranks one with it.
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const one = a.pre[index]
    const other = b.pre[index]
    if (one === undefined) return -1
    if (other === undefined) return 1
    const numericOne = /^\d+$/u.test(one)
    const numericOther = /^\d+$/u.test(other)
    if (numericOne && numericOther) {
      const difference = Number(one) - Number(other)
      if (difference !== 0) return difference
    } else if (numericOne !== numericOther) {
      // Numeric identifiers sort below alphanumeric ones.
      return numericOne ? -1 : 1
    } else if (one !== other) {
      return one < other ? -1 : 1
    }
  }
  return 0
}

/**
 * Download and unpack a package tarball.
 *
 * The packument's `dist.tarball` is authoritative for this exact version, and for a tarball-form plugin it points at
 * the GitHub release the registry build already verified. Reading it here keeps the whole index build on GitHub.
 * @param url - tarball URL.
 * @returns file contents by package-relative path.
 * @throws when the download fails or the body is not a gzip stream.
 */
async function tarballFiles(url: string): Promise<Map<string, Uint8Array>> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${String(response.status)}`)
  const { gunzipSync } = await import('node:zlib')
  return readTarball(gunzipSync(new Uint8Array(await response.arrayBuffer())))
}

/**
 * The display fields of one npm-form release.
 *
 * The packument carries the English fallback text and the keywords, but the localized title and the icon only exist in
 * the package's own files, so the tarball of the highest release is unpacked for them.
 * @param manifest - the version's packument entry.
 * @param repository - the repository recorded by the registry build, as `owner/name`.
 * @param files - the tarball's files, or undefined when it could not be read.
 * @returns the display fields format 1 accepts.
 */
async function npmDisplay(name: string, repository: string | undefined, files: Map<string, Uint8Array> | undefined): Promise<Display> {
  // The tarball's own `package.json` is what DSH reads after installing, so it is the authority here too. The packument
  // omits fields npm never stores verbatim, `author` being the one that matters.
  const declared = files?.get('package.json')
  const manifest: GitManifest = declared === undefined
    ? {}
    : JSON.parse(Buffer.from(declared).toString('utf8')) as GitManifest
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
    : []
  const url = gitUrl(typeof manifest.repository === 'string' ? manifest.repository : undefined)
    ?? (repository === undefined ? undefined : `https://github.com/${repository}`)
  return displayFrom(files ?? new Map(), {
    ...manifest.exports === undefined ? {} : { exports: manifest.exports },
    name,
    ...typeof manifest.description === 'string' ? { description: manifest.description } : {},
    ...typeof manifest.homepage === 'string' ? { homepage: manifest.homepage } : {},
    ...manifest.author === undefined ? {} : { author: manifest.author },
    ...url === undefined ? {} : { repository: { url } },
    keywords,
  })
}

/**
 * Build one plugin entry from its releases and display fields.
 *
 * A missing field is omitted rather than written as null, because format 1 distinguishes the two: an absent `engines`
 * means any DSH version, and an absent `metadata` means no keywords or labels.
 * @param name - package name.
 * @param releases - the plugin's releases.
 * @param display - display fields taken from the highest release.
 * @returns the plugin entry.
 */
function entryOf(name: string, releases: readonly Release[], display: Display): Entry {
  const highest = releases[0]
  if (highest === undefined) throw new Error(`${name}: no releases`)
  const fields: Record<string, unknown> = { name }
  for (const key of ['title', 'description', 'icon', 'author', 'homepage', 'repository', 'metadata'] as const) {
    const value = (display as Record<string, unknown>)[key]
    if (value !== undefined) fields[key] = value
  }
  fields['versions'] = releases
  return fields as Entry
}

/**
 * Build one entry from a packument, whatever registry it came from.
 * @param name - package name.
 * @param packument - the package's packument.
 * @param repository - repository recorded by the registry build, as `owner/name`; absent for npmjs-form plugins.
 * @returns the plugin entry.
 */
async function entryFromPackument(name: string, packument: Packument, repository: string | undefined): Promise<Entry> {
  const releases = npmReleases(name, packument)
  const highest = releases[0]
  if (highest === undefined) throw new Error(`${name}: no published version declares dsh.bundle`)
  const version = packument.versions?.[highest.version]
  if (version === undefined) throw new Error(`${name}: packument has no entry for ${highest.version}`)
  const tarball = version.dist?.tarball
  // A missing tarball costs the icon and the translations, not the entry: the packument still names every version.
  const files = typeof tarball === 'string' ? await tarballFiles(tarball).catch(() => undefined) : undefined
  return entryOf(name, releases, await npmDisplay(name, repository, files))
}

/**
 * Read a plugin dispatched to npmjs, straight from the public registry.
 *
 * The plugin is published to npmjs itself, so its own packument is authoritative and there is no reason to route the
 * read through a source repository. Only the recorded install source points at this repository's registry: the index
 * describes where a client installs from, which stays the local registry so the proxy rules keep applying.
 * @param plugin - the plugin metadata.
 * @returns the plugin entry.
 */
async function readNpmjsPlugin(plugin: Plugin): Promise<Entry> {
  const name = plugin.package
  const response = await fetch(`${NPMJS}/${name}`)
  if (!response.ok) throw new Error(`${name}: ${NPMJS}${name} answered HTTP ${String(response.status)}`)
  return await entryFromPackument(name, await response.json() as Packument, repositoryOf(plugin))
}

/**
 * Read a plugin dispatched as a tarball, from the packument the registry build already produced.
 * @param plugin - the plugin metadata.
 * @param manifest - the registry build record.
 * @returns the plugin entry.
 */
async function readTarballPlugin(plugin: Plugin, manifest: Manifest): Promise<Entry> {
  const name = plugin.package
  const packument = await readJson<Packument>(join(ROOT, 'dists', 'registry', 'packuments', `${name}.json`))
  if (packument === undefined) {
    throw new Error(`${name}: dists/registry/packuments/${name}.json is missing; run \`pnpm registry\` first`)
  }
  return await entryFromPackument(name, packument, manifest.packages?.[name]?.repository ?? repositoryOf(plugin))
}

/**
 * The repository a plugin's metadata names, as `owner/name`.
 * @param plugin - the plugin metadata.
 * @returns the repository, or undefined when the URL is not a GitHub one.
 */
function repositoryOf(plugin: Plugin): string | undefined {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/u.exec(plugin.repo)
  return match?.[1]
}

/**
 * Run one git command and return its standard output.
 * @param args - arguments after `git`.
 * @param cwd - directory to run in.
 * @returns the standard output.
 * @throws when git exits non-zero.
 */
async function git(args: readonly string[], cwd?: string): Promise<string> {
  const child = await import('node:child_process')
  return await new Promise<string>((resolve, reject) => {
    child.execFile('git', [...args], { maxBuffer: 64 * 1024 * 1024, ...cwd === undefined ? {} : { cwd } }, (error, stdout) => {
      if (error) reject(error)
      else resolve(stdout)
    })
  })
}

/**
 * A scratch repository holding the commits of one remote, so their files can be read without a full clone.
 *
 * `git show <commit>:<path>` reads from a local object store, and a bare `git ls-remote` leaves nothing behind. One
 * shallow fetch per repository buys every file of every listed commit; the directory is removed afterwards.
 */
class RemoteFiles {
  readonly #directory: string

  private constructor(directory: string) {
    this.#directory = directory
  }

  /**
   * Prepare a scratch repository for one remote.
   * @param url - repository URL.
   * @returns the reader, to be disposed with {@link dispose}.
   */
  static async open(url: string): Promise<RemoteFiles> {
    const { mkdtemp } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-index-'))
    await git(['init', '-q', '.'], directory)
    await git(['remote', 'add', 'origin', url], directory)
    return new RemoteFiles(directory)
  }

  /**
   * Fetch a commit, so its files can be read.
   * @param commit - commit to fetch.
   */
  async fetch(commit: string): Promise<void> {
    // Already present: a repeated fetch of one commit would only cost another round trip.
    const known = await git(['cat-file', '-e', `${commit}^{commit}`], this.#directory).then(() => true, () => false)
    if (!known) await git(['fetch', '-q', '--depth', '1', 'origin', commit], this.#directory)
  }

  /**
   * Read one file of a fetched commit.
   * @param commit - commit to read.
   * @param path - path inside the commit.
   * @returns the file contents as text.
   */
  async show(commit: string, path: string): Promise<string> {
    return await git(['show', `${commit}:${path}`], this.#directory)
  }

  /**
   * Read one binary file of a fetched commit.
   * @param commit - commit to read.
   * @param path - path inside the commit.
   * @returns the file contents, or undefined when the path is not a file.
   */
  async bytes(commit: string, path: string): Promise<Uint8Array | undefined> {
    const child = await import('node:child_process')
    return await new Promise<Uint8Array | undefined>(resolve => {
      child.execFile('git', ['show', `${commit}:${path}`], { cwd: this.#directory, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
        (error, stdout) => { resolve(error ? undefined : new Uint8Array(stdout)) })
    })
  }

  /**
   * Read the committer time of a fetched commit.
   * @param commit - commit to read.
   * @returns Unix seconds.
   */
  async commitTime(commit: string): Promise<number> {
    const raw = await git(['show', '-s', '--format=%ct', commit], this.#directory)
    return Number(raw.trim())
  }

  /**
   * List the files of a directory in a fetched commit.
   * @param commit - commit to read.
   * @param directory - directory to list, empty for the repository root.
   * @returns the entry names directly inside it.
   */
  async list(commit: string, directory: string): Promise<string[]> {
    const paths = await git(['ls-tree', '--name-only', `${commit}:${directory === '' ? '.' : directory}`], this.#directory)
    return paths.split('\n').flatMap(line => line === '' ? [] : [line.trim().split('/').pop() as string])
  }

  /** Remove the scratch directory. */
  async dispose(): Promise<void> {
    const { rm } = await import('node:fs/promises')
    await rm(this.#directory, { recursive: true, force: true })
  }
}

/** The `package.json` fields a git-form release is read from. */
interface GitManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly description?: unknown
  readonly homepage?: unknown
  readonly author?: unknown
  readonly keywords?: unknown
  readonly engines?: unknown
  readonly peerDependencies?: unknown
  readonly repository?: unknown
  readonly dsh?: unknown
  readonly private?: unknown
  readonly deprecated?: unknown
  readonly exports?: unknown
}

/**
 * Read a plugin published straight from its Git repository.
 *
 * A repository that tags its releases is described by the tags; one that does not is described by its default branch
 * head, which is the only version there is. Either way the manifest is read out of the commit being described, so a
 * history of fifty commits needs fifty `package.json` reads, not fifty clones: `git show` fetches one object each.
 * @param plugin - the plugin metadata.
 * @returns the plugin entry.
 */
async function readGitPlugin(plugin: Plugin): Promise<Entry> {
  const url = plugin.repo
  const [heads, tags] = await Promise.all([
    git(['ls-remote', '--heads', url]),
    git(['ls-remote', '--tags', url]),
  ])
  // Release tags, in the two forms the harness generator accepts: `vX.Y.Z` and `X.Y.Z`.
  const releases = tags.split('\n').flatMap(line => {
    const [commit = '', ref = ''] = line.split('\t', 2) as [string, string?]
    const tag = ref.replace(/^refs\/tags\//u, '')
    const version = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(tag)?.[1]
    return commit === '' || version === undefined ? [] : [{ commit, version }]
  })
  if (releases.length === 0) {
    const head = heads.split('\n').find(line => line.endsWith('\trefs/heads/main')) ?? heads.split('\n')[0]
    const commit = head?.split('\t', 2)[0]
    if (commit === undefined || commit === '') throw new Error(`${plugin.id}: no branch to read`)
    releases.push({ commit, version: undefined as unknown as string })
  }
  const resolved: Release[] = []
  let display: Display = {}
  const files = await RemoteFiles.open(url)
  try {
    for (const release of releases) {
      await files.fetch(release.commit)
      const manifest = JSON.parse(await files.show(release.commit, 'package.json')) as GitManifest
      if (typeof manifest.version !== 'string') throw new Error(`${plugin.id}: ${release.commit.slice(0, 8)} package.json has no version`)
      // A tag names the version it claims; the manifest has to agree, or the tag is not a release of this package.
      if (release.version !== undefined && release.version !== manifest.version) continue
      // The release time of a git plugin is the committer time of the commit the version was read from.
      const seconds = await files.commitTime(release.commit)
      const range = dshRange(manifest as PackumentVersion)
      resolved.push({
        version: manifest.version,
        publishTimestamp: seconds,
        source: { type: 'git', url, commit: release.commit },
        ...range === undefined ? {} : { engines: { dsh: range } },
      })
      if (Object.keys(display).length === 0) display = await gitDisplay(manifest, files, release.commit)
    }
  } finally {
    await files.dispose()
  }
  if (resolved.length === 0) throw new Error(`${plugin.id}: no release tag matches its package.json version`)
  resolved.sort((left, right) => compareVersions(right.version, left.version))
  return entryOf(plugin.package, resolved, display)
}

/**
 * The display fields of a git-form release.
 * @param manifest - the release's `package.json`.
 * @returns the display fields format 1 accepts.
 */
async function gitDisplay(manifest: GitManifest, files: RemoteFiles, commit: string): Promise<Display> {
  const keywords = Array.isArray(manifest.keywords)
    ? manifest.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
    : []
  // `author` is either a plain name or an object with `name` and `email`.
  const author = typeof manifest.author === 'string'
    ? manifest.author
    : typeof manifest.author === 'object' && manifest.author !== null && typeof (manifest.author as { name?: unknown }).name === 'string'
      ? String((manifest.author as { name: string }).name)
      : undefined
  // A Git plugin declares its repository as an object rather than a path, and the index wants its web URL.
  const declared = typeof manifest.repository === 'string'
    ? manifest.repository
    : typeof manifest.repository === 'object' && manifest.repository !== null && typeof (manifest.repository as { url?: unknown }).url === 'string'
      ? String((manifest.repository as { url: string }).url)
      : undefined
  const repository = gitUrl(declared)
  const entries = new Map<string, Uint8Array>()
  const directory = localeDirectory(manifest.exports) ?? 'locale'
  for (const name of await files.list(commit, directory).catch(() => [])) {
    const bytes = await files.bytes(commit, `${directory}/${name}`)
    if (bytes !== undefined) entries.set(`${directory}/${name}`, bytes)
  }
  for (const extension of ['.svg', '.png', '.jpg', '.jpeg', '.webp']) {
    const bytes = await files.bytes(commit, `icon${extension}`)
    if (bytes !== undefined) {
      entries.set(`icon${extension}`, bytes)
      break
    }
  }
  return displayFrom(entries, {
    ...manifest.exports === undefined ? {} : { exports: manifest.exports },
    ...typeof manifest.name === 'string' ? { name: manifest.name } : {},
    ...typeof manifest.description === 'string' ? { description: manifest.description } : {},
    ...typeof manifest.homepage === 'string' ? { homepage: manifest.homepage } : {},
    ...author === undefined ? {} : { author },
    ...repository === undefined ? {} : { repository: { url: repository } },
    keywords,
  })
}

/**
 * The web URL of a declared repository.
 * @param declared - a `git+https` URL, a plain URL, or `owner/name`.
 * @returns the browse URL without a `.git` suffix, or undefined.
 */
export function gitUrl(declared: string | undefined): string | undefined {
  if (declared === undefined) return undefined
  const bare = declared.replace(/^git\+/u, '').replace(/#.*$/u, '').replace(/\.git$/u, '').replace(/\/$/u, '')
  if (/^https?:\/\//u.test(bare)) return bare
  if (/^[^/\s]+\/[^/\s]+$/u.test(bare)) return `https://github.com/${bare}`
  return undefined
}

/**
 * Generate the index.
 * @param root - repository root to read metadata from.
 * @returns the validated index.
 */
export async function generate(root: string = ROOT): Promise<unknown> {
  const plugins = await readPlugins(root)
  const manifest = await readJson<Manifest>(join(root, 'dists', 'registry', 'manifest.json')) ?? {}
  const entries: Entry[] = []
  for (const plugin of plugins) {
    if (plugin.dispatchType === 'npmjs') {
      entries.push(await readNpmjsPlugin(plugin))
      continue
    }
    if (plugin.dispatchType === 'tarball') {
      entries.push(await readTarballPlugin(plugin, manifest))
      continue
    }
    // `source`: the package is installed straight from its repository, so the repository is the version list.
    entries.push(await readGitPlugin(plugin))
  }
  const index = { format: 1 as const, title: TITLE, plugins: entries }
  // The harness' own validator: format 1 is defined by it, so a drift from the format fails here.
  parseMarketIndex(index, VALIDATION_URL)
  return index
}

/**
 * Write the index to `dists/index.json`.
 * @param root - repository root.
 * @returns the number of plugins written.
 */
export async function writeIndex(root: string = ROOT): Promise<number> {
  const index = await generate(root) as { plugins: unknown[] }
  await mkdir(dirname(OUTPUT), { recursive: true })
  await writeFile(OUTPUT, `${JSON.stringify(index, undefined, 2)}\n`, 'utf8')
  return index.plugins.length
}

/** Whether this module is the entry point. */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
}

if (invokedDirectly()) {
  const count = await writeIndex()
  console.log(`wrote dists/index.json: ${count} plugin(s)`)
}
