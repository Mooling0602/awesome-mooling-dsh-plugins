import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { check, checkBase, checkDiff, checkMetadata, checkSubject, isSubmission, branchPoint, changedFiles, type Changed } from './check.ts'

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
/**
 * Create a temporary git repository holding one file, and return its path.
 *
 * The metadata check reads the submitted file out of a commit rather than off the disk, so a fixture has to be a real
 * repository with a real commit: a plain directory would only prove that `git` fails when there is no history.
 * @param path - repository-relative path of the file.
 * @param text - the file's contents.
 * @returns the temporary root, committed.
 */
function treeWith(path: string, text: string): string {
  const root = mkdtempSync(join(tmpdir(), 'contrib-check-'))
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, text)
  const run = (args: string[]): void => {
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  }
  run(['init', '--quiet', '--initial-branch', 'main'])
  run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '--all'])
  run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '--message', 'fixture'])
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

test('changedFiles reports what the pull request added once the base branch has moved on', () => {
  // A pull request opened against an older `main` carries one commit, but the base branch has since gained a commit of
  // its own. Comparing the two tips would report the base branch's newer file as a change the pull request made; the
  // contribution is what the pull request itself committed.
  const root = mkdtempSync(join(tmpdir(), 'contrib-check-'))
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  const write = (path: string, text: string): void => {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  const commit = (message: string): void => {
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '--all'])
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '--message', message])
  }
  run(['init', '--quiet', '--initial-branch', 'main'])
  write('src/worker.ts', 'before\n')
  commit('initial')
  const fork = run(['rev-parse', 'HEAD']).trim()

  // The pull request branches off, adding one metadata file.
  run(['checkout', '--quiet', '-b', 'submission'])
  write('plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml', VALID_YML)
  commit('feat: add a plugin')
  const head = run(['rev-parse', 'HEAD']).trim()

  // Meanwhile main gains its own commit touching a different file.
  run(['checkout', '--quiet', 'main'])
  write('src/worker.ts', 'after\n')
  commit('fix: change the worker')
  const base = run(['rev-parse', 'HEAD']).trim()

  try {
    assert.notEqual(base, fork)
    // `changedFiles` runs git in the current directory, which in CI is the checkout it was started in.
    const previous = process.cwd()
    process.chdir(root)
    try {
      assert.deepEqual(changedFiles(base, head), [
        { status: 'A', path: 'plugins/by-name/dsh-hi/dsh-hint-shell/plugin.yml' },
      ])
    } finally {
      process.chdir(previous)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('branchPoint falls back to the head when the histories are unrelated', () => {
  // Two independent roots share no ancestry. The comparison must not crash; it reports an empty contribution instead.
  const root = mkdtempSync(join(tmpdir(), 'contrib-check-'))
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  const commitFile = (branch: string, name: string): string => {
    run(['checkout', '--quiet', '--orphan', branch])
    writeFileSync(join(root, name), `${name}\n`)
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', '--all'])
    run(['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '--message', name])
    return run(['rev-parse', 'HEAD']).trim()
  }
  run(['init', '--quiet', '--initial-branch', 'main'])
  const one = commitFile('main', 'one.txt')
  const two = commitFile('other', 'two.txt')
  try {
    assert.equal(branchPoint(one, two), two)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
