import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { check, checkBase, checkDiff, checkMetadata, checkSubject, isSubmission, type Changed } from './check.ts'

/** One added metadata file at its correct path. */
const GOOD: Changed[] = [{ status: 'A', path: 'plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml' }]

/** A valid `plugin.yml` body. */
const VALID_YML = `id: dsh-hint-shell
package: dsh-hint-shell
source: github
repo: https://github.com/Mooling0602/dsh-hint-shell
readme:
  zh_CN: README.md
  en_US: README.en.md
dispatch-type: tarball
`

/**
 * Create a throwaway tree holding one metadata file.
 * @param path - repository-relative path to write.
 * @param text - the file contents.
 * @returns the temporary root, to be passed to {@link removeTree}.
 */
function treeWith(path: string, text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'contrib-check-'))
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
  return root
}

/**
 * Delete a tree {@link treeWith} made.
 * @param root - the temporary root.
 */
function removeTree(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

test('checkSubject accepts an ordinary subject', () => {
  for (const subject of ['feat: add dsh-hint-shell', 'add dsh-hint-shell', 'Update metadata']) {
    assert.deepEqual(checkSubject(subject), [], subject)
  }
})

test('checkSubject rejects an empty subject', () => {
  assert.deepEqual(checkSubject('   '), ['the commit subject is empty'])
})

test('checkSubject rejects trailing whitespace', () => {
  assert.ok(checkSubject('add a plugin ').some(problem => problem.includes('leading or trailing whitespace')))
})

test('checkSubject rejects a subject over 100 characters', () => {
  assert.ok(checkSubject('a'.repeat(120)).some(problem => problem.includes('characters; keep it under 100')))
})

test('checkSubject rejects a subject spanning more than one line', () => {
  assert.ok(checkSubject('add a plugin\nand more').some(problem => problem.includes('spans more than one line')))
})

test('isSubmission is decided by the file name alone', () => {
  assert.equal(isSubmission(GOOD), true)
  assert.equal(isSubmission([{ status: 'M', path: 'src/worker.ts' }]), false)
  assert.equal(isSubmission([{ status: 'M', path: 'README.md' }]), false)
  assert.equal(isSubmission([]), false)
})

test('isSubmission recognises a misplaced plugin.yml, so it still fails as a submission', () => {
  assert.equal(isSubmission([{ status: 'A', path: 'plugins/by-name/dsh-hint-shell/plugin.yml' }]), true)
  assert.equal(isSubmission([{ status: 'A', path: 'plugin.yml' }]), true)
  assert.equal(isSubmission([{ status: 'A', path: 'plugins/by-name/dsh-hi/dsh-hint-shell/meta.yml' }]), false)
})

test('checkDiff accepts one added metadata file at its shard', () => {
  assert.deepEqual(checkDiff(GOOD), [])
})

test('checkDiff accepts a modified metadata file', () => {
  assert.deepEqual(checkDiff([{ status: 'M', path: 'plugins/by-name/dsh-ml/dsh-mloader/plugin.yml' }]), [])
})

test('checkDiff rejects an empty diff', () => {
  assert.deepEqual(checkDiff([]), ['the diff is empty: this pull request changes no file'])
})

test('checkDiff rejects a second file', () => {
  const problems = checkDiff([...GOOD, { status: 'M', path: 'src/metadata.ts' }])
  assert.ok(problems.some(problem => problem.includes('touches 2')), problems.join('; '))
})

test('checkDiff names every file it rejected', () => {
  const problems = checkDiff([...GOOD, { status: 'M', path: 'src/metadata.ts' }])
  assert.ok(problems.some(problem => problem.includes('A plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml')))
  assert.ok(problems.some(problem => problem.includes('M src/metadata.ts')))
})

test('checkDiff tells the author to split the pull request', () => {
  const problems = checkDiff([...GOOD, { status: 'M', path: 'src/metadata.ts' }])
  assert.ok(problems.some(problem => problem.includes('its own pull request')), problems.join('; '))
})

test('checkDiff rejects a misplaced plugin.yml', () => {
  const problems = checkDiff([{ status: 'A', path: 'README.md' }])
  assert.ok(problems.some(problem => problem.includes('not at the path one belongs at')), problems.join('; '))
})

test('checkDiff rejects a metadata file at the wrong depth', () => {
  assert.ok(checkDiff([{ status: 'A', path: 'plugins/by-name/dsh-hint-shell/plugin.yml' }]).length > 0)
  assert.ok(checkDiff([{ status: 'A', path: 'plugins/by-name/dsh-hi/dsh-hint-shell/meta.yml' }]).length > 0)
})

test('checkDiff rejects a metadata file in the wrong shard', () => {
  const problems = checkDiff([{ status: 'A', path: 'plugins/by-name/dsh-zz/dsh-hint-shell/plugin.yml' }])
  assert.ok(problems.some(problem => problem.includes('belongs in "dsh-hi", not "dsh-zz"')), problems.join('; '))
})

test('checkDiff accepts a shard that spells its dsh- prefix the same way as the plugin directory', () => {
  for (const path of [
    'plugins/by-name/ot/other/plugin.yml',
    'plugins/by-name/dsh-ot/dsh-other/plugin.yml',
    'plugins/by-name/dsh-ot/dsh-ot/plugin.yml',
    'plugins/by-name/ot/ot/plugin.yml',
    'plugins/by-name/ds/dshother/plugin.yml',
  ]) {
    assert.deepEqual(checkDiff([{ status: 'A', path }]), [], path)
  }
})

test('checkDiff rejects a shard whose prefix disagrees with the plugin directory', () => {
  // Both carry the right two letters; only the spelling of the optional `dsh-` prefix differs, and mixing it is the error.
  for (const [path, expected] of [
    ['plugins/by-name/ot/dsh-other/plugin.yml', '"dsh-other" belongs in "dsh-ot", not "ot"'],
    ['plugins/by-name/dsh-ot/other/plugin.yml', '"other" belongs in "ot", not "dsh-ot"'],
    ['plugins/by-name/ds/dsh-other/plugin.yml', '"dsh-other" belongs in "dsh-ot", not "ds"'],
    ['plugins/by-name/dsh-hi/other/plugin.yml', '"other" belongs in "ot", not "dsh-hi"'],
  ] as const) {
    const problems = checkDiff([{ status: 'A', path }])
    assert.ok(problems.some(problem => problem.includes(expected)), `${path}: ${problems.join('; ')}`)
  }
})

test('checkDiff rejects a deleted metadata file', () => {
  const problems = checkDiff([{ status: 'D', path: 'plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml' }])
  assert.ok(problems.some(problem => problem.includes('deleted')), problems.join('; '))
})

test('checkDiff rejects a name a shard cannot be derived from', () => {
  const problems = checkDiff([{ status: 'A', path: 'plugins/by-name/dsh-x/dsh-x/plugin.yml' }])
  assert.ok(problems.some(problem => problem.includes('cannot derive a shard')), problems.join('; '))
})

test('checkMetadata accepts a valid file', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', VALID_YML)
  const previous = process.cwd()
  try {
    process.chdir(root)
    assert.deepEqual(checkMetadata('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml'), [])
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('checkMetadata rejects an unknown field', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', `${VALID_YML}extra: value\n`)
  const previous = process.cwd()
  try {
    process.chdir(root)
    const problems = checkMetadata('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml')
    assert.ok(problems.some(problem => problem.includes('unknown field')), problems.join('; '))
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('checkMetadata rejects a missing field', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', 'id: dsh-hint-shell\n')
  const previous = process.cwd()
  try {
    process.chdir(root)
    const problems = checkMetadata('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml')
    assert.ok(problems.some(problem => problem.includes('missing field')), problems.join('; '))
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('checkMetadata rejects an unsupported dispatch-type', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', VALID_YML.replace('tarball', 'magic'))
  const previous = process.cwd()
  try {
    process.chdir(root)
    const problems = checkMetadata('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml')
    assert.ok(problems.some(problem => problem.includes('dispatch-type must be one of')), problems.join('; '))
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('checkMetadata rejects a file whose id disagrees with its directory', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', VALID_YML.replace('id: dsh-hint-shell', 'id: other-plugin'))
  const previous = process.cwd()
  try {
    process.chdir(root)
    const problems = checkMetadata('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml')
    assert.ok(problems.some(problem => problem.includes('must match its directory')), problems.join('; '))
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('checkMetadata rejects a file that cannot be read', () => {
  const problems = checkMetadata('plugins/by-name/dsh-zz/dsh-not-a-real-plugin/plugin.yml')
  assert.ok(problems.some(problem => problem.includes('cannot be read')), problems.join('; '))
})

test('check passes a valid pull request', () => {
  const root = treeWith('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', VALID_YML)
  const previous = process.cwd()
  try {
    process.chdir(root)
    assert.deepEqual(check(['add dsh-hint-shell'], GOOD), [])
  } finally {
    process.chdir(previous)
    removeTree(root)
  }
})

test('check reports both a bad subject and a bad shape', () => {
  const problems = check([''], [{ status: 'A', path: 'plugins/by-name/dsh-hint-shell/plugin.yml' }])
  assert.ok(problems.some(problem => problem.includes('is empty')))
  assert.ok(problems.some(problem => problem.includes('not at the path one belongs at')))
})

test('check rejects a pull request with no commits', () => {
  const problems = check([], GOOD)
  assert.ok(problems.some(problem => problem.includes('carries no commits')), problems.join('; '))
})

test('check rejects an empty diff', () => {
  const problems = check(['add a plugin'], [])
  assert.ok(problems.some(problem => problem.includes('changes no file')), problems.join('; '))
})

test('check does not read the file when the diff shape is wrong', () => {
  const problems = check(['add a plugin'], [{ status: 'M', path: 'plugins/by-name/dsh-hi/a/plugin.yml' }, { status: 'M', path: 'src/worker.ts' }])
  assert.ok(!problems.some(problem => problem.includes('cannot be read')), problems.join('; '))
})

test('check accepts an ordinary pull request that changes no plugin.yml', () => {
  for (const changed of [
    [{ status: 'M', path: 'src/worker.ts' }],
    [
      { status: 'M', path: 'src/worker.ts' },
      { status: 'M', path: 'README.md' },
    ],
    [{ status: 'A', path: '.github/workflows/pr.yml' }],
  ]) {
    assert.deepEqual(check(['fix: correct the worker'], changed), [], JSON.stringify(changed))
  }
})

test('check rejects a submission that also changes the repository', () => {
  const problems = check(['feat: add a plugin'], [...GOOD, { status: 'M', path: 'src/metadata.ts' }])
  assert.ok(problems.some(problem => problem.includes('its own pull request')), problems.join('; '))
})

test('check rejects a submission whose plugin.yml is misplaced even when nothing else changed', () => {
  const problems = check(['feat: add a plugin'], [{ status: 'A', path: 'plugins/by-name/dsh-hint-shell/plugin.yml' }])
  assert.ok(problems.some(problem => problem.includes('not at the path one belongs at')), problems.join('; '))
})

test('checkBase accepts main', () => {
  assert.deepEqual(checkBase('main'), [])
})

test('checkBase rejects any other branch', () => {
  for (const branch of ['dev', 'release', 'master', 'mainline', '']) {
    const problems = checkBase(branch)
    assert.ok(problems.some(problem => problem.includes('must target "main"')), branch)
  }
})

test('checkBase names the branch it rejected', () => {
  const problems = checkBase('dev')
  assert.ok(problems.some(problem => problem.includes('"dev"')), problems.join('; '))
})

test('check rejects a submission aimed at another branch', () => {
  const problems = check(['feat: add a plugin'], GOOD, 'dev')
  assert.ok(problems.some(problem => problem.includes('must target "main"')), problems.join('; '))
})

test('check accepts a submission aimed at main', () => {
  assert.deepEqual(check(['feat: add a plugin'], GOOD, 'main'), [])
})

test('check ignores the branch for an ordinary pull request', () => {
  // Only a submission is tied to the branch the registry is built from; a repository change is reviewed by a person.
  assert.deepEqual(check(['ci: check pull requests'], [{ status: 'M', path: 'src/worker.ts' }], 'dev'), [])
})

test('check does not check the branch when none is given', () => {
  assert.deepEqual(check(['feat: add a plugin'], GOOD), [])
})
