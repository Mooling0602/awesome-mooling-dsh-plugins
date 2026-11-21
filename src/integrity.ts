/**
 * Compute the npm integrity fields of a release tarball.
 *
 * npm clients verify a download against `dist.integrity` and `dist.shasum`, so both have to be computed once from the
 * exact bytes the registry hands out. Re-uploading an asset changes its bytes and therefore its hashes, which breaks
 * every lockfile already pinning the old value.
 */
import { createHash } from 'node:crypto'

/** The two hash fields an npm version record carries. */
export interface Integrity {
  /** Subresource-integrity string, `sha512-` plus base64 of the digest. */
  readonly integrity: string
  /** Hex SHA-1 of the tarball, kept for clients that still read it. */
  readonly shasum: string
}

/**
 * Hash a tarball's bytes.
 * @param bytes - the exact contents of the `.tgz`.
 * @returns the `dist.integrity` and `dist.shasum` values.
 */
export function integrityOf(bytes: Uint8Array): Integrity {
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  }
}
