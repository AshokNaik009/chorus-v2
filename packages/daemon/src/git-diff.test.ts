/**
 * The diff parser, driven with fixture patches and no git.
 *
 * Every case here is a real shape `git diff` emits. The line numbers are the point:
 * they are the one thing a renderer cannot recompute from the text it is handed, so
 * each test asserts them rather than asserting that a line "is there".
 */

import { describe, expect, it } from 'vitest'
import {
  DIFF_MAX_UNTRACKED,
  DiffService,
  parseHunkHeader,
  parseUnifiedDiff,
  unquotePath
} from './git-diff.js'
import type { GitResult, GitRunner } from './worktree.js'
import type { GitService } from './git.js'
import type { GitStatus } from './git.js'

const ok = (stdout: string, code = 0): GitResult => ({ stdout, stderr: '', code })

describe('parseHunkHeader', () => {
  it('reads starts and counts', () => {
    expect(parseHunkHeader('@@ -12,7 +12,9 @@')).toEqual({
      oldStart: 12,
      oldCount: 7,
      newStart: 12,
      newCount: 9,
      section: ''
    })
  })

  it('defaults an absent count to one, not zero', () => {
    // `@@ -1 +1 @@` is a one-line change. Reading the absent count as 0 would make
    // every line number after it in the file wrong.
    expect(parseHunkHeader('@@ -1 +1 @@')).toMatchObject({ oldCount: 1, newCount: 1 })
  })

  it('keeps the function-context suffix', () => {
    expect(parseHunkHeader('@@ -3,2 +3,4 @@ function render(x) {')?.section).toBe('function render(x) {')
  })

  it('rejects a line that only looks like a header', () => {
    expect(parseHunkHeader('@@ not a header')).toBeNull()
    expect(parseHunkHeader('  @@ -1,1 +1,1 @@')).toBeNull()
  })
})

describe('parseUnifiedDiff', () => {
  it('numbers every line in both files', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 1111111..2222222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,4 +10,5 @@',
      ' const before = 1',
      '-const gone = 2',
      '+const added = 2',
      '+const also = 3',
      ' const after = 4',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file?.path).toBe('src/a.ts')
    expect(file?.added).toBe(2)
    expect(file?.removed).toBe(1)
    expect(file?.hunks[0]?.lines).toEqual([
      { kind: 'ctx', old: 10, new: 10, text: 'const before = 1' },
      { kind: 'del', old: 11, new: null, text: 'const gone = 2' },
      { kind: 'add', old: null, new: 11, text: 'const added = 2' },
      { kind: 'add', old: null, new: 12, text: 'const also = 3' },
      { kind: 'ctx', old: 12, new: 13, text: 'const after = 4' }
    ])
  })

  it('carries several hunks in one file, each with its own numbering', () => {
    const patch = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      '-one',
      '+ONE',
      '@@ -50,1 +50,1 @@ inside a function',
      '-fifty',
      '+FIFTY',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file?.hunks).toHaveLength(2)
    expect(file?.hunks[1]?.section).toBe('inside a function')
    expect(file?.hunks[1]?.lines[0]).toEqual({ kind: 'del', old: 50, new: null, text: 'fifty' })
  })

  it('reads a rename, and does not repeat the path as its own origin', () => {
    const patch = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,1 +1,1 @@',
      '-a',
      '+b',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file).toMatchObject({ path: 'new.ts', origin: 'old.ts', letter: 'R' })
  })

  it('drops an origin equal to the path', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b', ''].join('\n')
    expect(parseUnifiedDiff(patch)[0]?.origin).toBeNull()
  })

  it('reads an addition against /dev/null', () => {
    const patch = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+one',
      '+two',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file).toMatchObject({ path: 'new.ts', letter: 'A', added: 2, removed: 0 })
    expect(file?.hunks[0]?.lines[0]).toEqual({ kind: 'add', old: null, new: 1, text: 'one' })
  })

  it('reads a deletion', () => {
    const patch = [
      'diff --git a/gone.ts b/gone.ts',
      'deleted file mode 100644',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file).toMatchObject({ path: 'gone.ts', letter: 'D', removed: 2 })
  })

  it('marks a binary file and gives it no hunks', () => {
    const patch = [
      'diff --git a/logo.png b/logo.png',
      'index 111..222 100644',
      '--- a/logo.png',
      '+++ b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
      ''
    ].join('\n')
    const [file] = parseUnifiedDiff(patch)
    expect(file).toMatchObject({ path: 'logo.png', binary: true })
    expect(file?.hunks).toHaveLength(0)
  })

  it('attaches "no newline" to the line above rather than making it a line', () => {
    const patch = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      ''
    ].join('\n')
    const lines = parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? []
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ kind: 'del', text: 'old', noNewline: true })
    expect(lines[1]).toMatchObject({ kind: 'add', text: 'new', noNewline: true })
  })

  it('keeps a carriage return as content', () => {
    // A file whose endings changed differs only in these bytes. Stripping the `\r`
    // here would make the overlay show two identical lines and claim a change.
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a\r', '+a', ''].join('\n')
    const lines = parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? []
    expect(lines[0]?.text).toBe('a\r')
    expect(lines[1]?.text).toBe('a')
  })

  it('treats an empty body line as empty context', () => {
    const patch = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '', '+b', ''].join('\n')
    const lines = parseUnifiedDiff(patch)[0]?.hunks[0]?.lines ?? []
    expect(lines[0]).toEqual({ kind: 'ctx', old: 1, new: 1, text: '' })
  })

  it('does not read a diff inside a diff as a new file', () => {
    // This repository contains patches in its own test fixtures. A context line whose
    // text begins with `diff --git ` must stay a line of the file being shown.
    const patch = [
      'diff --git a/doc.md b/doc.md',
      '--- a/doc.md',
      '+++ b/doc.md',
      '@@ -1,3 +1,3 @@',
      ' diff --git a/inner b/inner',
      '-old',
      '+new',
      ''
    ].join('\n')
    const files = parseUnifiedDiff(patch)
    expect(files).toHaveLength(1)
    expect(files[0]?.hunks[0]?.lines[0]?.text).toBe('diff --git a/inner b/inner')
  })

  it('separates two files', () => {
    const patch = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.ts b/two.ts',
      '--- a/two.ts',
      '+++ b/two.ts',
      '@@ -5 +5 @@',
      '-c',
      '+d',
      ''
    ].join('\n')
    expect(parseUnifiedDiff(patch).map((file) => file.path)).toEqual(['one.ts', 'two.ts'])
  })

  it('truncates a file past the cap and says so', () => {
    const body = Array.from({ length: 40 }, (_, index) => `+line ${index}`)
    const patch = ['diff --git a/big b/big', '--- a/big', '+++ b/big', '@@ -0,0 +1,40 @@', ...body, ''].join('\n')
    const [file] = parseUnifiedDiff(patch, { maxLinesPerFile: 10 })
    expect(file?.truncated).toBe(true)
    expect(file?.hunks[0]?.lines).toHaveLength(10)
  })

  it('unquotes a path git escaped', () => {
    // `core.quotePath` is on by default, so a non-ASCII filename arrives escaped.
    expect(unquotePath('"src/caf\\303\\251.ts"')).toBe('src/café.ts')
    expect(unquotePath('"a\\tb.ts"')).toBe('a\tb.ts')
    expect(unquotePath('plain.ts')).toBe('plain.ts')
  })

  it('returns nothing for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('DiffService', () => {
  const status = (entries: { path: string; letter: string }[]): GitStatus => ({
    root: '/repo',
    branch: 'main',
    staged: [],
    unstaged: entries.map((entry) => ({ path: entry.path, origin: null, letter: entry.letter })),
    ahead: 0,
    behind: 0,
    hasUpstream: false
  })

  const fakeGit = (entries: { path: string; letter: string }[]): GitService =>
    ({ status: async () => status(entries) }) as unknown as GitService

  it('refuses to let a repository substitute its own differ', async () => {
    const calls: string[][] = []
    const runner: GitRunner = async (args) => {
      calls.push([...args])
      return ok('')
    }
    await new DiffService({ git: runner }).diff(fakeGit([]), '/repo')
    expect(calls[0]).toContain('--no-ext-diff')
    expect(calls[0]).toContain('--no-textconv')
    expect(calls[0]).toContain('--no-color')
  })

  it('asks about untracked files separately, because git diff omits them', async () => {
    const calls: string[][] = []
    const runner: GitRunner = async (args) => {
      calls.push([...args])
      if (args.includes('--no-index')) {
        // `--no-index` exits 1 whenever the inputs differ, which here is always.
        return ok(
          ['diff --git a/fresh.ts b/fresh.ts', '--- /dev/null', '+++ b/fresh.ts', '@@ -0,0 +1 @@', '+hello', ''].join(
            '\n'
          ),
          1
        )
      }
      return ok('')
    }
    const result = await new DiffService({ git: runner }).diff(fakeGit([{ path: 'fresh.ts', letter: 'U' }]), '/repo')
    expect(result.files.map((file) => file.path)).toEqual(['fresh.ts'])
    expect(result.files[0]?.letter).toBe('U')
    expect(calls.some((args) => args.includes('--no-index'))).toBe(true)
  })

  it('bounds how many untracked files cost a process, and says what it skipped', async () => {
    let spawns = 0
    const runner: GitRunner = async (args) => {
      if (args.includes('--no-index')) spawns += 1
      return ok('')
    }
    const many = Array.from({ length: DIFF_MAX_UNTRACKED + 5 }, (_, index) => ({
      path: `f${index}.ts`,
      letter: 'U'
    }))
    const result = await new DiffService({ git: runner }).diff(fakeGit(many), '/repo')
    expect(spawns).toBe(DIFF_MAX_UNTRACKED)
    expect(result.note).toContain('5 more untracked files not shown')
  })

  it('does not look for untracked files when diffing the index', async () => {
    let spawns = 0
    const runner: GitRunner = async (args) => {
      if (args.includes('--no-index')) spawns += 1
      return ok('')
    }
    await new DiffService({ git: runner }).diff(fakeGit([{ path: 'fresh.ts', letter: 'U' }]), '/repo', {
      staged: true
    })
    expect(spawns).toBe(0)
  })

  it('reports a buffer overflow rather than showing an empty diff', async () => {
    // A non-zero code with empty stderr and a partial stdout is indistinguishable from
    // a quiet failure; `overflowed` is the only thing that tells them apart.
    const runner: GitRunner = async () => ({ stdout: '', stderr: '', code: 1, overflowed: true })
    const result = await new DiffService({ git: runner }).diff(fakeGit([]), '/repo')
    expect(result.note).not.toBeNull()
  })

  it('relays what git said when it genuinely failed', async () => {
    const runner: GitRunner = async () => ({ stdout: '', stderr: 'fatal: bad revision', code: 128 })
    await expect(new DiffService({ git: runner }).diff(fakeGit([]), '/repo')).rejects.toThrow('fatal: bad revision')
  })
})
