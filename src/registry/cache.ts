/**
 * Plan the removal of the worker's cached proxy decisions.
 *
 * The worker caches two kinds of decision in KV: whether a package may be proxied, and whether it was refused. Both are
 * derived data. They are cheap to recompute and expensive to keep correct across releases, so the deploy rebuilds them
 * instead of trusting records written by an earlier version of the worker.
 *
 * That is not hypothetical. An earlier worker read dependencies from the version tagged latest only, and refused
 * several packages that a real install needed. The refusals were stored without an expiry, so they outlived the bug and
 * kept breaking installs until they were deleted by hand. Rebuilding on every deploy makes that class of mistake
 * self-healing.
 *
 * A rebuild costs one slow first install, because every decision has to be walked again: measured against the deployed
 * worker, a cold install of the largest hosted plugin took about thirty seconds against seven seconds warm. Paying that
 * once per release is the right trade for never carrying a stale refusal forward.
 *
 * Only the decision records are removed. The package records and the index are authoritative data that this module must
 * not touch: deleting a packument would make a hosted plugin unresolvable until the next deploy put it back.
 */

/** KV prefix marking a package as allowed to be proxied. Mirrors ALLOW_PREFIX in the worker. */
export const ALLOW_PREFIX = '__allow__/'

/** KV prefix marking a package as refused. Mirrors DENY_PREFIX in the worker. */
export const DENY_PREFIX = '__deny__/'

/**
 * The key prefixes holding derived data, which a deploy rebuilds.
 *
 * Kept as a list rather than two constants so the caller iterates once and cannot forget one of them.
 */
export const CACHE_PREFIXES = [ALLOW_PREFIX, DENY_PREFIX] as const

/**
 * Pick the keys that hold cached decisions out of a namespace listing.
 *
 * The listing is filtered rather than trusted wholesale, so no caller can pass the whole namespace through and delete a
 * packument by mistake.
 * @param keys - every key name in the namespace.
 * @returns the key names to delete, in listing order.
 */
export function cacheKeys(keys: readonly string[]): string[] {
  return keys.filter(key => CACHE_PREFIXES.some(prefix => key.startsWith(prefix)))
}
