/**
 * A minimal reader for the files of an npm tarball.
 *
 * The index needs two things out of a package's tarball, its locale files and its icon, and pulling in a tar dependency
 * for that would be more code than the parser itself. A tar archive is a sequence of 512-byte headers followed by
 * file contents padded to a multiple of 512, which is small enough to read directly.
 *
 * Only regular files are returned: directories, symlinks, and pax metadata entries are skipped, because a package's
 * display fields are always plain files at paths its own `exports` map names.
 */

/** Offset of the file size field in a tar header, as octal ASCII. */
const SIZE_OFFSET = 124
/** Length of the size field. */
const SIZE_LENGTH = 12
/** Offset of the type flag. */
const TYPE_OFFSET = 156
/** Offset of the `prefix` field, which POSIX tar prepends to a short name. */
const PREFIX_OFFSET = 345
/** Length of each header field above. */
const NAME_LENGTH = 100
/** Offset of the name field. */
const NAME_OFFSET = 0
/** Length of the prefix field. */
const PREFIX_LENGTH = 155
/** Every tar block is this size. */
const BLOCK = 512

/**
 * Read an octal ASCII field.
 * @param header - one 512-byte header.
 * @param offset - where the field starts.
 * @param length - how long the field is.
 * @returns the parsed number, or zero when the field is blank.
 */
function octal(header: Uint8Array, offset: number, length: number): number {
  const raw = Buffer.from(header.subarray(offset, offset + length)).toString('ascii').replace(/\0.*$/u, '').trim()
  return raw === '' ? 0 : Number.parseInt(raw, 8) || 0
}

/**
 * Read a NUL-terminated ASCII field.
 * @param header - one 512-byte header.
 * @param offset - where the field starts.
 * @param length - how long the field is.
 * @returns the decoded text.
 */
function field(header: Uint8Array, offset: number, length: number): string {
  return Buffer.from(header.subarray(offset, offset + length)).toString('utf8').replace(/\0.*$/u, '').trim()
}

/**
 * Whether every byte of a block is zero, which marks the end of the archive.
 * @param block - one header block.
 * @returns true when the block is all zero bytes.
 */
function empty(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}

/**
 * Extract the regular files of a tar archive.
 *
 * npm prefixes every path with `package/`; that prefix is removed so callers see package-relative paths, which is what
 * `exports` targets are written in terms of.
 * @param tar - the uncompressed tar bytes.
 * @returns file contents by package-relative path.
 */
export function readTarball(tar: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + BLOCK <= tar.byteLength) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (empty(header)) break
    const name = field(header, NAME_OFFSET, NAME_LENGTH)
    const prefix = field(header, PREFIX_OFFSET, PREFIX_LENGTH)
    const size = octal(header, SIZE_OFFSET, SIZE_LENGTH)
    const type = String.fromCharCode(header[TYPE_OFFSET] ?? 48)
    const start = offset + BLOCK
    const end = start + size
    if (end > tar.byteLength) break
    // `0` and `\0` are regular files; pax headers (`x`, `g`), links, and directories are not files to read.
    if (type === '0' || type === '\0') {
      const path = (prefix === '' ? name : `${prefix}/${name}`).replace(/^package\//u, '')
      files.set(path, tar.subarray(start, end))
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK
  }
  return files
}
