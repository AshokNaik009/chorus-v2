/**
 * The source-control service, against real repositories.
 *
 * Real ones, not a fake runner, because the thing most likely to be wrong is what git
 * actually prints — a rename's two NUL-separated fields, a repository with no commits,
 * an untracked directory. A stubbed runner would only prove that the parser agrees with
 * whatever this file imagines git says.
 *
 * The parsing unit tests below cover the cases a real repository cannot easily produce.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService, parseAheadBehind, parseBranch, parseStatus } from './git.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-git-'))
  roots.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  return root
}

function commitAll(root: string, message: string): void {
  execFileSync('git', ['add', '--all'], { cwd: root, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'pipe' })
}

const service = new GitService()

describe('parseStatus', () => {
  it('splits a path that is both staged and modified again', () => {
    // `MM`: staged once, then edited. It belongs to both lists, not one.
    const status = parseStatus('## main\0MM src/app.ts\0', '/repo')
    expect(status.staged).toEqual([{ path: 'src/app.ts', origin: null, letter: 'M' }])
    expect(status.unstaged).toEqual([{ path: 'src/app.ts', origin: null, letter: 'M' }])
  })

  it('reads a rename and its source from the following field', () => {
    const status = parseStatus('## main\0R  new.ts\0old.ts\0', '/repo')
    expect(status.staged).toEqual([{ path: 'new.ts', origin: 'old.ts', letter: 'R' }])
    expect(status.unstaged).toEqual([])
  })

  it('does not mistake a rename source for the next entry', () => {
    const status = parseStatus('## main\0R  new.ts\0old.ts\0 M other.ts\0', '/repo')
    expect(status.staged.map((entry) => entry.path)).toEqual(['new.ts'])
    expect(status.unstaged.map((entry) => entry.path)).toEqual(['other.ts'])
  })

  it('reports a conflict once, as unstaged', () => {
    const status = parseStatus('## main\0UU both.ts\0', '/repo')
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([{ path: 'both.ts', origin: null, letter: '!' }])
  })

  it('skips ignored entries and keeps untracked ones', () => {
    const status = parseStatus('## main\0!! dist/\0?? new.ts\0', '/repo')
    expect(status.unstaged).toEqual([{ path: 'new.ts', origin: null, letter: 'U' }])
  })

  it('reads a type change as a modification', () => {
    expect(parseStatus('## main\0 T link\0', '/repo').unstaged[0]?.letter).toBe('M')
  })

  it('survives a path containing a space', () => {
    expect(parseStatus('## main\0 M my file.ts\0', '/repo').unstaged[0]?.path).toBe('my file.ts')
  })
})

describe('parseBranch and parseAheadBehind', () => {
  it('reads a tracking branch', () => {
    expect(parseBranch('main...origin/main')).toBe('main')
  })

  it('reads a branch with no commits yet', () => {
    expect(parseBranch('No commits yet on main')).toBe('main')
  })

  it('reads both halves, either half, or neither', () => {
    expect(parseAheadBehind('main...origin/main [ahead 1, behind 2]')).toEqual({ ahead: 1, behind: 2 })
    expect(parseAheadBehind('main...origin/main [ahead 3]')).toEqual({ ahead: 3, behind: 0 })
    expect(parseAheadBehind('main...origin/main [behind 4]')).toEqual({ ahead: 0, behind: 4 })
    expect(parseAheadBehind('main...origin/main')).toEqual({ ahead: 0, behind: 0 })
  })

  it('treats a gone upstream as zeros rather than failing', () => {
    expect(parseAheadBehind('main...origin/main [gone]')).toEqual({ ahead: 0, behind: 0 })
  })
})

describe('GitService', () => {
  it('refuses a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'lc-plain-'))
    roots.push(plain)
    await expect(service.status(plain)).rejects.toThrow(/not inside a git repository/)
  })

  it('reports untracked files in a repository with no commits', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'hello')
    const status = await service.status(root)
    expect(status.branch).toBe('main')
    expect(status.unstaged.map((entry) => entry.path)).toEqual(['a.txt'])
    expect(status.staged).toEqual([])
  })

  it('stages and unstages before the first commit', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'hello')

    const staged = await service.stage(root, ['a.txt'])
    expect(staged.staged.map((entry) => entry.path)).toEqual(['a.txt'])
    expect(staged.unstaged).toEqual([])

    // `git restore --staged` fails here; the reset path is why this passes.
    const back = await service.unstage(root, ['a.txt'])
    expect(back.staged).toEqual([])
    expect(back.unstaged.map((entry) => entry.path)).toEqual(['a.txt'])
  })

  it('lists untracked files inside a new directory individually', async () => {
    const root = repo()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/one.ts'), '1')
    writeFileSync(join(root, 'src/two.ts'), '2')
    const status = await service.status(root)
    // `--untracked-files=all`: a bare `src/` would be unstageable per file.
    expect(status.unstaged.map((entry) => entry.path).sort()).toEqual(['src/one.ts', 'src/two.ts'])
  })

  it('commits what is staged and leaves the rest alone', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'hello')
    writeFileSync(join(root, 'b.txt'), 'world')
    await service.stage(root, ['a.txt'])

    const after = await service.commit(root, 'first')
    expect(after.staged).toEqual([])
    expect(after.unstaged.map((entry) => entry.path)).toEqual(['b.txt'])
  })

  it('refuses to commit with nothing staged, or with no message', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'hello')
    await expect(service.commit(root, 'nothing here')).rejects.toThrow(/nothing staged/)
    await service.stage(root, ['a.txt'])
    await expect(service.commit(root, '   ')).rejects.toThrow(/needs a message/)
  })

  it('restores a tracked file and deletes an untracked one on discard', async () => {
    const root = repo()
    writeFileSync(join(root, 'tracked.txt'), 'original')
    commitAll(root, 'first')
    writeFileSync(join(root, 'tracked.txt'), 'edited')
    writeFileSync(join(root, 'untracked.txt'), 'new')

    const after = await service.discard(root, ['tracked.txt', 'untracked.txt'])
    expect(after.unstaged).toEqual([])
    expect(existsSync(join(root, 'untracked.txt'))).toBe(false)
  })

  it('refuses a discard with no paths rather than wiping the tree', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'hello')
    await expect(service.discard(root, [])).rejects.toThrow(/needs paths/)
  })

  it('reports a rename through the service, not just the parser', async () => {
    const root = repo()
    writeFileSync(join(root, 'old.ts'), 'contents')
    commitAll(root, 'first')
    execFileSync('git', ['mv', 'old.ts', 'new.ts'], { cwd: root, stdio: 'pipe' })

    const status = await service.status(root)
    expect(status.staged).toHaveLength(1)
    expect(status.staged[0]?.path).toBe('new.ts')
    expect(status.staged[0]?.letter).toBe('R')
    expect(status.staged[0]?.origin).toBe('old.ts')
  })

  it('stages everything when given no paths', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'a')
    writeFileSync(join(root, 'b.txt'), 'b')
    const status = await service.stage(root, [])
    expect(status.staged).toHaveLength(2)
    expect(status.unstaged).toEqual([])
  })
})
