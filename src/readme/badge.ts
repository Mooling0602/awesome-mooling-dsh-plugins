/**
 * Read the facts a plugin's badges display.
 *
 * Every badge is rendered from a shields.io URL, so a README needs no image assets and no network call at render time;
 * what it needs is the value to put in the URL. Those values come from GitHub: a plugin's `package.json` carries its
 * version and license, the default branch's latest commit carries the CI status, and its README may already carry
 * badges of its own that should be repeated here.
 *
 * A missing fact is never an error: the badge is simply left out. A plugin may not declare a license, may not run CI,
 * or may keep its README somewhere the API cannot reach, and the list must still render.
 */

/** The facts one plugin's badges are built from. */
export interface BadgeFacts {
  /** The version shown, already carrying its `v` prefix. `undefined` when the plugin declares none. */
  readonly version?: string
  /** Whether that version comes from a prerelease, which changes the badge label. */
  readonly prerelease?: boolean
  /** The license identifier, as written in `package.json`. */
  readonly license?: string
  /**
   * The DSH version range the plugin supports.
   *
   * Plugins declare this either as `engines.dsh` or through a `@deepseek-ai/...` peer dependency, so the reader of the
   * `package.json` accepts both. `undefined` when neither is present.
   */
  readonly dshVersion?: string
  /** Whether the latest commit on the default branch passed its checks; `undefined` when it has none. */
  readonly ci?: boolean
  /** Badges the plugin's own README already declares, in the order it declares them. */
  readonly own?: readonly string[]
}

/**
 * Read a version from a `package.json`.
 * @param manifest - the parsed `package.json`.
 * @returns the version with a `v` prefix, or `undefined` when it is absent or not a string.
 */
export function versionOf(manifest: Record<string, unknown>): string | undefined {
  const version = manifest['version']
  if (typeof version !== 'string' || version === '') return undefined
  return version.startsWith('v') ? version : `v${version}`
}

/**
 * Read whether a version is a prerelease.
 * @param version - a version with or without a `v` prefix.
 * @returns whether it carries a prerelease suffix such as `-rc.1`.
 */
export function isPrerelease(version: string | undefined): boolean {
  if (version === undefined) return false
  return /^\d+\.\d+\.\d+-/u.test(version.startsWith('v') ? version.slice(1) : version)
}

/**
 * Read the license from a `package.json`.
 * @param manifest - the parsed `package.json`.
 * @returns the license identifier, or `undefined` when absent or not a plain string.
 */
export function licenseOf(manifest: Record<string, unknown>): string | undefined {
  const license = manifest['license']
  if (typeof license === 'string' && license !== '') return license
  // The older object form is still found in the wild and carries the same identifier under `type`.
  if (typeof license === 'object' && license !== null) {
    const type = (license as Record<string, unknown>)['type']
    if (typeof type === 'string' && type !== '') return type
  }
  return undefined
}

/**
 * Read the DSH version range a plugin supports.
 *
 * `engines.dsh` is the direct declaration. A plugin that omits it usually still states the range through a peer
 * dependency on a DSH package, so the first such range is used instead. More than one distinct range is ambiguous and
 * yields `undefined` rather than a guess.
 * @param manifest - the parsed `package.json`.
 * @returns the range, or `undefined` when the manifest states none or states several disagreeing ones.
 */
export function dshVersionOf(manifest: Record<string, unknown>): string | undefined {
  const engines = manifest['engines']
  if (typeof engines === 'object' && engines !== null) {
    const declared = (engines as Record<string, unknown>)['dsh']
    if (typeof declared === 'string' && declared !== '') return declared
  }
  const peer = manifest['peerDependencies']
  if (typeof peer !== 'object' || peer === null) return undefined
  const ranges = new Set<string>()
  for (const [name, range] of Object.entries(peer as Record<string, unknown>)) {
    if (!name.startsWith('@deepseek-ai/')) continue
    if (typeof range === 'string' && range !== '') ranges.add(range)
  }
  if (ranges.size !== 1) return undefined
  return [...ranges][0]
}

/**
 * Read the shields.io badges a README already declares.
 *
 * Only shields.io images are kept: another badge service may render anything, and this repository must not embed an
 * image whose origin it cannot reason about. A badge repeated further down the same README is kept once, at the
 * position it first appears, so the list reads in the plugin author's own order.
 * @param readme - the README text.
 * @returns shields.io image URLs, deduplicated, in first-seen order.
 */
export function ownBadgesOf(readme: string): string[] {
  const seen = new Set<string>()
  for (const match of readme.matchAll(/!\[[^\]]*\]\((https:\/\/img\.shields\.io\/[^)\s]+)\)/gu)) {
    const url = match[1]
    if (url !== undefined) seen.add(url)
  }
  return [...seen]
}

/**
 * The subject a badge is about, used to keep a plugin's own badge from repeating one this repository generates.
 *
 * The mapping is deliberately coarse: an automatically generated license badge and a shields.io `github/license` badge
 * say the same thing even though their URLs share nothing, so comparing URLs would miss the duplicate. A badge whose
 * subject cannot be recognised keeps its own value and is never treated as a duplicate.
 */
const SUBJECTS: readonly { readonly subject: string; readonly test: RegExp }[] = [
  { subject: 'version', test: /(?:^|[/-])(?:version|release|tag|v)(?:$|[-/])|shields\.io\/badge\/version|shields\.io\/github\/v\//iu },
  { subject: 'license', test: /licen[cs]e|shields\.io\/github\/license/iu },
  { subject: 'ci', test: /(?:^|[/-])(?:ci|build|tests?|checks?)(?:$|[-/])|actions\/workflow\/status|travis|circleci/iu },
  { subject: 'dsh', test: /(?:^|[/-])dsh(?:$|[-/])|deepseek/iu },
]

/**
 * Read the subject a badge is about.
 * @param url - the badge URL.
 * @returns the subject, or `undefined` when the badge is about something else.
 */
export function subjectOf(url: string): string | undefined {
  for (const { subject, test } of SUBJECTS) {
    if (test.test(url)) return subject
  }
  return undefined
}

/**
 * Build a shields.io static badge URL.
 * @param label - the left-hand text.
 * @param value - the right-hand text.
 * @param color - the right-hand colour, as a shields.io colour name or hex value.
 * @returns the badge URL.
 */
export function staticBadge(label: string, value: string, color: string): string {
  const escape = (text: string): string =>
    // shields.io reads `-` as a separator and `_` as a space, so both are doubled to survive the round trip.
    encodeURIComponent(text.replace(/-/gu, '--').replace(/_/gu, '__').replace(/ /gu, '_'))
  return `https://img.shields.io/badge/${escape(label)}-${escape(value)}-${color}`
}

/**
 * Render every badge for one plugin.
 *
 * Version comes first because it is the fact a reader looks for, then whether that version is a prerelease, then the
 * health and compatibility facts, and finally whatever the plugin already shows about itself.
 *
 * A plugin's own badge is kept unless this repository already generates a badge about the same subject: a plugin whose
 * README carries its own license badge would otherwise show the license twice, once with each URL. The generated badge
 * wins because its text is read from `package.json`, which is what the plugin actually declares, rather than from a URL
 * the plugin author wrote by hand.
 * @param facts - the facts read for this plugin.
 * @returns badge URLs in display order.
 */
export function badgesFor(facts: BadgeFacts): string[] {
  const generated: string[] = []
  if (facts.version !== undefined) {
    generated.push(
      facts.prerelease === true
        ? staticBadge('pre-release', facts.version, 'orange')
        : staticBadge('version', facts.version, 'blue'),
    )
  }
  if (facts.ci !== undefined) generated.push(staticBadge('ci', facts.ci ? 'passing' : 'failing', facts.ci ? 'brightgreen' : 'red'))
  if (facts.license !== undefined) generated.push(staticBadge('license', facts.license, 'blue'))
  if (facts.dshVersion !== undefined) generated.push(staticBadge('dsh', facts.dshVersion, '4D6BFE'))

  const covered = new Set<string>()
  for (const badge of generated) {
    const subject = subjectOf(badge)
    if (subject !== undefined) covered.add(subject)
  }

  const own: string[] = []
  for (const badge of facts.own ?? []) {
    const subject = subjectOf(badge)
    if (subject !== undefined && covered.has(subject)) continue
    if (own.includes(badge)) continue
    own.push(badge)
    if (subject !== undefined) covered.add(subject)
  }

  return [...generated, ...own]
}
