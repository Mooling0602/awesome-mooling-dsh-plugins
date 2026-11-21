/**
 * Render the README from the template plus the plugin metadata.
 *
 * The template carries everything hand-written, and one placeholder comment marks where the generated plugin list goes.
 * This module replaces that comment with one entry per plugin, and leaves every other byte of the template alone, so
 * editing prose never means touching code.
 *
 * A plugin's own badges are not rendered yet: they need the GitHub API and that is a separate change. The entry shape
 * below is the seam where they will be attached without moving anything else.
 */
import { badgesFor, type BadgeFacts } from './badge.ts'
import type { Language, Plugin, Readme } from '../metadata.ts'

/** The comment the template uses to mark where the plugin list is inserted. */
export const PLACEHOLDER = '<!-- Plugin list data, let CI to auto generate them. -->'

/** One README this project generates, and the template and output it uses. */
export interface ReadmeTarget {
  /** Language of the template and the output. */
  readonly language: Language
  /** Template file name under `templates/`. */
  readonly template: string
  /** Generated file name at the repository root. */
  readonly output: string
  /**
   * Whether an entry links the plugin's own README in the language of this README.
   *
   * Only the Chinese README carries the link. The English README would link the very file its reader already has, which
   * says nothing, so its entries are plain name-and-repository links.
   */
  readonly linksOwnReadme: boolean
}

/** The READMEs this project generates. */
export const TARGETS: readonly ReadmeTarget[] = [
  { language: 'en_US', template: '_README.md', output: 'README.md', linksOwnReadme: false },
  { language: 'zh_CN', template: '_README.zh.md', output: 'README.zh.md', linksOwnReadme: true },
]

/** The label shown before a plugin's own README link. */
const README_LABEL = '中文'

/**
 * Read the README path a plugin names for one language.
 * @param readme - the plugin's `readme` mapping.
 * @param language - the language to read.
 * @returns the path or URL, or `undefined` when the plugin names none for that language.
 */
export function readmePathFor(readme: Readme, language: Language): string | undefined {
  const value = readme[language]
  return value === undefined || value === '' ? undefined : value
}

/**
 * Turn a plugin's relative README path into a link into its repository.
 *
 * The metadata may carry either a full link or a path relative to the repository root. A relative path is joined onto
 * the repository's `blob/<branch>` URL, using the branch the caller read from the API, so the link survives a repository
 * that renamed its default branch. A full link is used verbatim.
 * @param repo - the plugin's repository URL.
 * @param path - the `readme` value for one language.
 * @param branch - the repository's default branch; required when `path` is relative.
 * @returns an absolute URL.
 * @throws when `path` is relative and no branch was supplied.
 */
export function resolveReadmeUrl(repo: string, path: string, branch?: string): string {
  if (/^https?:\/\//u.test(path)) return path
  if (branch === undefined || branch === '') {
    throw new Error(`${repo}: cannot resolve the relative README path ${JSON.stringify(path)} without a default branch`)
  }
  const base = repo.endsWith('/') ? repo.slice(0, -1) : repo
  const clean = path.startsWith('./') ? path.slice(2) : path
  return `${base}/blob/${branch}/${clean}`
}

/**
 * Render one plugin's entry.
 *
 * The plugin name links to its repository, and when the target links a plugin's own README and the plugin names one,
 * that link follows the name so a reader stays in the language they were already reading. Any badges the plugin has are
 * put on their own indented line under the name, which is what the documentation promises: the name is enough to
 * identify the plugin, so the space under it belongs to the facts about it.
 * @param plugin - the plugin to render.
 * @param target - which README is being generated.
 * @param branch - the plugin repository's default branch, when its README path has to be resolved.
 * @param badges - badge URLs to render under the name; omitted when the plugin has none.
 * @returns one markdown entry, without a trailing newline.
 */
export function renderEntry(plugin: Plugin, target: ReadmeTarget, branch?: string, badges: readonly string[] = []): string {
  const name = `[${plugin.id}](${plugin.repo})`
  let entry = `- ${name}`
  if (target.linksOwnReadme) {
    const path = readmePathFor(plugin.readme, target.language)
    if (path !== undefined) entry = `- ${name}（[${README_LABEL}](${resolveReadmeUrl(plugin.repo, path, branch)})）`
  }
  if (badges.length === 0) return entry
  // Two spaces indent keeps the images inside the list item; a blank line would end the item and start a new block.
  return `${entry}\n  ${badges.map(badge => `![](${badge})`).join(' ')}`
}

/**
 * Insert the generated list into a template.
 * @param template - the template text, which must carry `PLACEHOLDER` exactly once.
 * @param entries - the rendered entries, in the order they should appear.
 * @returns the template with the placeholder replaced by the entries.
 * @throws when the placeholder is missing or appears more than once.
 */
export function renderReadme(template: string, entries: readonly string[]): string {
  const first = template.indexOf(PLACEHOLDER)
  if (first === -1) throw new Error(`template carries no ${JSON.stringify(PLACEHOLDER)} comment`)
  if (template.indexOf(PLACEHOLDER, first + PLACEHOLDER.length) !== -1) {
    throw new Error(`template carries ${JSON.stringify(PLACEHOLDER)} more than once`)
  }
  const body = entries.join('\n\n')
  return `${template.slice(0, first)}${body}\n${template.slice(first + PLACEHOLDER.length)}`
}

/**
 * Render one target's README from the plugins in the repository.
 * @param target - which README to render.
 * @param plugins - the plugins to list, in the order they should appear.
 * @param template - the template text for that target.
 * @param branches - default branches keyed by repository URL.
 * @param facts - badge facts keyed by plugin id; a plugin absent from the map renders without badges.
 * @returns the generated README text.
 */
export function renderTarget(
  target: ReadmeTarget,
  plugins: readonly Plugin[],
  template: string,
  branches: ReadonlyMap<string, string> = new Map(),
  facts: ReadonlyMap<string, BadgeFacts> = new Map(),
): string {
  return renderReadme(
    template,
    plugins.map(plugin => {
      const read = facts.get(plugin.id)
      return renderEntry(plugin, target, branches.get(plugin.repo), read === undefined ? [] : badgesFor(read))
    }),
  )
}
