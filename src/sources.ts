/**
 * Turn the plugin metadata into the generator's source list.
 *
 * `dispatch-type` decides how a plugin reaches a consumer, and that is what the source list records.
 * `npmjs` and `tarball` both resolve to an npm package, so the line is the package name and the generator reads a
 * packument from whichever registry `--registry` names; for `tarball` that registry is the CF Workers mirror built
 * from the release assets. `source` resolves to no npm package at all, so the line is the repository and the generator
 * reads the git default branch.
 *
 * `source` does not pick the line shape; it records where the bytes come from, which is what the registry builder uses
 * to decide whether to read GitHub release assets or the official registry.
 */
import type { Plugin } from './metadata.ts'

/** How the index records a plugin. */
export type IndexMode = 'npm' | 'git'

/**
 * Decide whether the index records a plugin as an npm package or as a git repository.
 * @param plugin - the plugin to inspect.
 * @returns `npm` for `npmjs` and `tarball`, `git` for `source`.
 */
export function indexModeOf(plugin: Pick<Plugin, 'dispatchType'>): IndexMode {
  return plugin.dispatchType === 'source' ? 'git' : 'npm'
}

/**
 * Decide whether a plugin has to be republished through the CF Workers npm registry.
 * @param plugin - the plugin to inspect.
 * @returns true for `tarball`, the only dispatch type whose package does not exist on the official registry.
 */
export function needsConversion(plugin: Pick<Plugin, 'dispatchType'>): boolean {
  return plugin.dispatchType === 'tarball'
}

/**
 * Decide whether a plugin's package already exists on the official npm registry.
 * @param plugin - the plugin to inspect.
 * @returns true when `source` is `npm`, so the package resolves without the CF Workers mirror.
 */
export function isNpmPackage(plugin: Pick<Plugin, 'source'>): boolean {
  return plugin.source === 'npm'
}

/**
 * Render the source list.
 * @param plugins - the plugins to list, in the order they should appear.
 * @returns the file contents, ending in a single newline, or an empty string for no plugins.
 */
export function renderSources(plugins: readonly Plugin[]): string {
  if (plugins.length === 0) return ''
  const lines = plugins.map(plugin => (indexModeOf(plugin) === 'npm' ? plugin.package : plugin.repo))
  return `${lines.join('\n')}\n`
}
