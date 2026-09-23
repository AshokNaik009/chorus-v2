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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitService,
  dropNested,
  firstHunkLine,
  parseAheadBehind,
  parseBranch,
  parseBranches,
  parseStatus,
  pathsUnder,
  under
} from './git.js'

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

/**
 * The defect PHASE-7 opens with, as a test.
 *
 * Staging a rename by the one path the user selected leaves the deletion of the other
 * one unstaged, so the panel reports a clean-looking `A new.txt` beside a stray
 * ` D old.txt` that nobody asked for. The fix is to hand git both halves at once; what
 * this asserts is the consequence — after staging that row, **nothing** is unstaged.
 */
describe('staging a rename', () => {
  /** `git mv` then decompose, which is the state a rename is usually found in. */
  function renamedRepo(): string {
    const root = repo()
    writeFileSync(join(root, 'old.txt'), 'x\n')
    commitAll(root, 'first')
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['reset', '-q', 'HEAD', '--', '.'], { cwd: root, stdio: 'pipe' })
    return root
  }

  it('is a deletion and an untracked file before anything is staged', async () => {
    const status = await service.status(renamedRepo())
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((entry) => `${entry.letter} ${entry.path}`).sort()).toEqual([
      'D old.txt',
      'U new.txt'
    ])
  })

  it('leaves nothing unstaged when the new path is staged', async () => {
    const root = renamedRepo()
    const status = await service.stage(root, ['new.txt'])
    expect(status.unstaged).toEqual([])
    expect(status.staged).toEqual([{ path: 'new.txt', origin: 'old.txt', letter: 'R' }])
  })

  it('leaves nothing unstaged when the old path is staged instead', async () => {
    const root = renamedRepo()
    const status = await service.stage(root, ['old.txt'])
    expect(status.unstaged).toEqual([])
    expect(status.staged.map((entry) => entry.letter)).toEqual(['R'])
  })

  it('unstages both halves again, leaving nothing in the index', async () => {
    const root = repo()
    writeFileSync(join(root, 'old.txt'), 'x\n')
    commitAll(root, 'first')
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: root, stdio: 'pipe' })
    expect((await service.status(root)).staged.map((entry) => entry.letter)).toEqual(['R'])

    // The mirror defect: resetting only `new.txt` would leave `D old.txt` staged.
    const status = await service.unstage(root, ['new.txt'])
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((entry) => entry.path).sort()).toEqual(['new.txt', 'old.txt'])
  })
})

describe('staging a directory', () => {
  it('stages the files under it and nothing beside it', async () => {
    const root = repo()
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'a.ts'), 'a')
    writeFileSync(join(root, 'src', 'b.ts'), 'b')
    writeFileSync(join(root, 'outside.ts'), 'c')

    const status = await service.stage(root, ['src'])
    expect(status.staged.map((entry) => entry.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(status.unstaged.map((entry) => entry.path)).toEqual(['outside.ts'])
  })

  it('does not treat a sibling with a shared prefix as being inside it', async () => {
    const root = repo()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'srcfoo'))
    writeFileSync(join(root, 'src', 'a.ts'), 'a')
    writeFileSync(join(root, 'srcfoo', 'b.ts'), 'b')

    const status = await service.stage(root, ['src'])
    expect(status.staged.map((entry) => entry.path)).toEqual(['src/a.ts'])
  })

  /**
   * `git add -- vendor` with an unregistered repository inside it records a gitlink —
   * one index entry naming a commit, in a repository with no submodule config to
   * resolve it. Enumerating the paths and dropping the ones at or inside that root is
   * what `drop_nested` in herdr-sidebar's `git.rs` exists for.
   */
  it('stops at a nested repository rather than recording it as a gitlink', async () => {
    const root = repo()
    mkdirSync(join(root, 'vendor'))
    writeFileSync(join(root, 'vendor', 'own.ts'), 'mine')
    const inner = join(root, 'vendor', 'inner')
    mkdirSync(inner)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, stdio: 'pipe' })
    writeFileSync(join(inner, 'theirs.ts'), 'theirs')

    const status = await service.stage(root, ['vendor'])
    expect(status.staged.map((entry) => entry.path)).toEqual(['vendor/own.ts'])
    // The gitlink is the thing that must not appear; git would have called it `vendor/inner`.
    expect(status.staged.map((entry) => entry.path)).not.toContain('vendor/inner')
  })

  it('says so rather than doing nothing when every path was nested', async () => {
    const root = repo()
    const inner = join(root, 'inner')
    mkdirSync(inner)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, stdio: 'pipe' })
    writeFileSync(join(inner, 'theirs.ts'), 'theirs')

    await expect(service.stage(root, ['inner'])).rejects.toThrow(/nested repository/)
  })
})

describe('under, pathsUnder and dropNested', () => {
  it('contains a path, its descendants, and nothing that merely shares a prefix', () => {
    expect(under('src', 'src')).toBe(true)
    expect(under('src/app.ts', 'src')).toBe(true)
    expect(under('srcfoo/app.ts', 'src')).toBe(false)
    expect(under('anything', undefined)).toBe(true)
    expect(under('src/app.ts', 'src/')).toBe(true)
  })

  it('takes both halves of a rename, whichever half the prefix names', () => {
    const entries = [{ path: 'b/new.txt', origin: 'a/old.txt', letter: 'R' }]
    expect(pathsUnder(entries, 'b')).toEqual(['a/old.txt', 'b/new.txt'])
    // Moving a file *out* of a directory is a change to that directory.
    expect(pathsUnder(entries, 'a')).toEqual(['a/old.txt', 'b/new.txt'])
    expect(pathsUnder(entries, 'c')).toEqual([])
  })

  it('drops a path at or inside a nested root and keeps its siblings', () => {
    const paths = ['vendor/inner', 'vendor/inner/a.ts', 'vendor/own.ts']
    expect(dropNested(paths, ['vendor/inner'])).toEqual(['vendor/own.ts'])
  })
})

describe('parseBranches', () => {
  it('reads the current marker, the short name and remoteness', () => {
    const raw = ' \0feature\0refs/heads/feature\0\n*\0main\0refs/heads/main\0\n \0origin/main\0refs/remotes/origin/main\0\n'
    expect(parseBranches(raw)).toEqual([
      { name: 'main', current: true, remote: false },
      { name: 'origin/main', current: false, remote: true },
      { name: 'feature', current: false, remote: false }
    ])
  })

  /**
   * `refs/remotes/origin/HEAD` is an alias for the remote's default branch. Checking it
   * out by that name gives a detached HEAD at a branch the user never picked, so it
   * never reaches the picker. Confirmed present in a real clone on 2026-09-20.
   */
  it('drops a symbolic ref such as origin/HEAD', () => {
    const raw = ' \0origin\0refs/remotes/origin/HEAD\0refs/remotes/origin/main\n \0origin/main\0refs/remotes/origin/main\0\n'
    expect(parseBranches(raw).map((branch) => branch.name)).toEqual(['origin/main'])
  })

  it('leaves the order alone when nothing is current, as in a detached HEAD', () => {
    const raw = ' \0b\0refs/heads/b\0\n \0a\0refs/heads/a\0\n'
    expect(parseBranches(raw).map((branch) => branch.name)).toEqual(['b', 'a'])
  })
})

describe('pairing a decomposed rename', () => {
  it('does not pair empty files, which every placeholder shares', async () => {
    const root = repo()
    mkdirSync(join(root, 'keep'))
    writeFileSync(join(root, 'keep', '.gitkeep'), '')
    commitAll(root, 'first')
    rmSync(join(root, 'keep', '.gitkeep'))
    writeFileSync(join(root, 'other.txt'), '')

    const status = await service.stage(root, ['other.txt'])
    expect(status.staged.map((entry) => entry.path)).toEqual(['other.txt'])
    // The unrelated deletion is still the user's to stage, not ours to guess at.
    expect(status.unstaged.map((entry) => entry.path)).toEqual(['keep/.gitkeep'])
  })

  it('refuses to guess when two deletions have the same content', async () => {
    const root = repo()
    writeFileSync(join(root, 'one.txt'), 'shared\n')
    writeFileSync(join(root, 'two.txt'), 'shared\n')
    commitAll(root, 'first')
    rmSync(join(root, 'one.txt'))
    rmSync(join(root, 'two.txt'))
    writeFileSync(join(root, 'moved.txt'), 'shared\n')

    const status = await service.stage(root, ['moved.txt'])
    expect(status.staged.map((entry) => entry.path)).toEqual(['moved.txt'])
    expect(status.unstaged.map((entry) => entry.path).sort()).toEqual(['one.txt', 'two.txt'])
  })

  it('pairs from the deletion too, not only from the new file', async () => {
    const root = repo()
    writeFileSync(join(root, 'old.txt'), 'body\n')
    commitAll(root, 'first')
    execFileSync('git', ['mv', 'old.txt', 'new.txt'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['reset', '-q', 'HEAD', '--', '.'], { cwd: root, stdio: 'pipe' })

    const status = await service.stage(root, ['old.txt'])
    expect(status.unstaged).toEqual([])
    expect(status.staged).toEqual([{ path: 'new.txt', origin: 'old.txt', letter: 'R' }])
  })
})

/**
 * Branches, checkout and sync, against a real remote.
 *
 * A bare repository on disk rather than a stub: `--track`, `[ahead n]` and a rebase
 * conflict are all things only a real remote produces, and they are the whole subject.
 */
describe('branches, checkout and sync', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
  }

  /** A bare origin with one commit on `main`, and a clone of it. */
  function cloned(): { origin: string; work: string } {
    const base = mkdtempSync(join(tmpdir(), 'lc-remote-'))
    roots.push(base)
    const origin = join(base, 'origin.git')
    const work = join(base, 'work')
    execFileSync('git', ['init', '-q', '-b', 'main', '--bare', origin], { stdio: 'pipe' })
    execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' })
    git(work, 'config', 'user.email', 'test@example.com')
    git(work, 'config', 'user.name', 'Test')
    git(work, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(work, 'f.txt'), 'base\n')
    git(work, 'add', '--all')
    git(work, 'commit', '-q', '-m', 'first')
    git(work, 'push', '-q', '-u', 'origin', 'main')
    return { origin, work }
  }

  it('lists local and remote branches with the current one marked and first', async () => {
    const { work } = cloned()
    git(work, 'branch', 'feature')
    git(work, 'push', '-q', 'origin', 'feature')
    git(work, 'fetch', '-q', 'origin')

    const { branches } = await service.branches(work)
    expect(branches[0]).toEqual({ name: 'main', current: true, remote: false })
    expect(branches.filter((branch) => branch.remote).map((branch) => branch.name).sort()).toEqual([
      'origin/feature',
      'origin/main'
    ])
    expect(branches.filter((branch) => branch.current)).toHaveLength(1)
    // origin/HEAD is a symbolic alias and must never be offered as a checkout target.
    expect(branches.map((branch) => branch.name)).not.toContain('origin')
  })

  it('switches to a local branch and reports the new one in the status', async () => {
    const { work } = cloned()
    git(work, 'branch', 'feature')
    const status = await service.checkout(work, 'feature', false)
    expect(status.branch).toBe('feature')
  })

  it('creates a local tracking branch from a remote one', async () => {
    const { work } = cloned()
    git(work, 'branch', 'remote-only')
    git(work, 'push', '-q', 'origin', 'remote-only')
    git(work, 'branch', '-q', '-D', 'remote-only')
    git(work, 'fetch', '-q', 'origin')

    const status = await service.checkout(work, 'origin/remote-only', true)
    expect(status.branch).toBe('remote-only')
    expect(status.hasUpstream).toBe(true)
    expect(git(work, 'rev-parse', '--abbrev-ref', 'remote-only@{upstream}').trim()).toBe('origin/remote-only')
  })

  it('refuses a checkout that would lose work, in git’s own words', async () => {
    const { work } = cloned()
    git(work, 'checkout', '-q', '-b', 'feature')
    writeFileSync(join(work, 'f.txt'), 'on feature\n')
    git(work, 'commit', '-q', '-am', 'feature edit')
    git(work, 'checkout', '-q', 'main')
    writeFileSync(join(work, 'f.txt'), 'uncommitted\n')

    await expect(service.checkout(work, 'feature', false)).rejects.toThrow(/would be overwritten|local changes/)
    expect((await service.status(work)).branch).toBe('main')
  })

  it('is a no-op on the branch that is already checked out', async () => {
    const { work } = cloned()
    expect((await service.checkout(work, 'main', false)).branch).toBe('main')
  })

  /**
   * The dirty tree is the point of `--autostash`. A panel is open because there is
   * something to look at, so "sync only works on a clean tree" would mean "sync never
   * works".
   */
  it('syncs a dirty tree without losing the dirty part', async () => {
    const { origin } = cloned()
    const other = mkdtempSync(join(tmpdir(), 'lc-other-'))
    roots.push(other)
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' })
    git(other, 'config', 'user.email', 'other@example.com')
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(other, 'theirs.txt'), 'theirs\n')
    git(other, 'add', '--all')
    git(other, 'commit', '-q', '-m', 'theirs')
    git(other, 'push', '-q')

    const mine = mkdtempSync(join(tmpdir(), 'lc-mine-'))
    roots.push(mine)
    execFileSync('git', ['clone', '-q', origin, mine], { stdio: 'pipe' })
    git(mine, 'config', 'user.email', 'mine@example.com')
    git(mine, 'config', 'user.name', 'Mine')
    git(mine, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(mine, 'mine.txt'), 'mine\n')
    git(mine, 'add', '--all')
    git(mine, 'commit', '-q', '-m', 'mine')
    writeFileSync(join(mine, 'dirty.txt'), 'not committed\n')

    const { status, message } = await service.sync(mine)
    expect(readFileSync(join(mine, 'dirty.txt'), 'utf8')).toBe('not committed\n')
    expect(existsSync(join(mine, 'theirs.txt'))).toBe(true)
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
    expect(status.unstaged.map((entry) => entry.path)).toEqual(['dirty.txt'])
    expect(message.length).toBeGreaterThan(0)
  })

  /**
   * A conflict must read as a conflict. It is also the case where push must NOT run:
   * a stopped rebase leaves a detached HEAD, and pushing from there fails with "you
   * are not currently on a branch", which describes nothing the user did.
   */
  it('reports a rebase conflict as a failure, and does not push over it', async () => {
    const { origin, work } = cloned()
    const other = mkdtempSync(join(tmpdir(), 'lc-conflict-'))
    roots.push(other)
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' })
    git(other, 'config', 'user.email', 'other@example.com')
    git(other, 'config', 'user.name', 'Other')
    git(other, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(other, 'f.txt'), 'theirs\n')
    git(other, 'commit', '-q', '-am', 'theirs')
    git(other, 'push', '-q')

    writeFileSync(join(work, 'f.txt'), 'mine\n')
    git(work, 'commit', '-q', '-am', 'mine')

    await expect(service.sync(work)).rejects.toThrow(/CONFLICT|could not apply/i)
    // The remote still has only the other clone's commit: nothing was pushed over it.
    expect(git(origin, 'log', '--oneline', 'main')).toContain('theirs')
    expect(git(origin, 'log', '--oneline', 'main')).not.toContain('mine')
  })

  it('reports a sync with no upstream rather than appearing to succeed', async () => {
    const root = repo()
    writeFileSync(join(root, 'a.txt'), 'a')
    commitAll(root, 'first')
    await expect(service.sync(root)).rejects.toThrow()
  })
})

describe('firstHunkLine', () => {
  it('takes the new-side start of the first hunk', () => {
    expect(firstHunkLine('@@ -40,0 +42,3 @@ function x()\n+a\n+b\n')).toBe(42)
  })

  it('ignores everything above the first hunk header', () => {
    const diff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1e7f2c9..5b0e2f6 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -7 +7 @@',
      '-old',
      '+new',
      '@@ -99 +99 @@',
      '-x',
      '+y'
    ].join('\n')
    expect(firstHunkLine(diff)).toBe(7)
  })

  it('never returns 0 for a deletion at the top of a file', () => {
    // `@@ -1,3 +0,0 @@` is everything removed from line 1. There is no line 0 to open.
    expect(firstHunkLine('@@ -1,3 +0,0 @@\n-a\n-b\n-c\n')).toBe(1)
  })

  it('is null when there is no diff at all, which is an untracked file', () => {
    expect(firstHunkLine('')).toBeNull()
    expect(firstHunkLine('Binary files a/x.png and b/x.png differ\n')).toBeNull()
  })
})

describe('GitService.firstChangedLine', () => {
  it('points at the line that changed, not at the top of the file', async () => {
    const root = repo()
    writeFileSync(join(root, 'file.txt'), Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n')
    commitAll(root, 'first')
    const lines = readFileSync(join(root, 'file.txt'), 'utf8').split('\n')
    lines[11] = 'line 12 edited'
    writeFileSync(join(root, 'file.txt'), lines.join('\n'))

    expect(await service.firstChangedLine(root, 'file.txt', false)).toBe(12)
    // Nothing is staged, so the index side has no hunk to report.
    expect(await service.firstChangedLine(root, 'file.txt', true)).toBeNull()
  })

  it('reports null for an untracked file rather than guessing line 1', async () => {
    const root = repo()
    writeFileSync(join(root, 'seed.txt'), 'seed\n')
    commitAll(root, 'first')
    writeFileSync(join(root, 'fresh.txt'), 'new\n')
    expect(await service.firstChangedLine(root, 'fresh.txt', false)).toBeNull()
  })

  it('reads the index side when asked, for a staged change', async () => {
    const root = repo()
    writeFileSync(join(root, 'file.txt'), 'a\nb\nc\nd\n')
    commitAll(root, 'first')
    writeFileSync(join(root, 'file.txt'), 'a\nb\nCHANGED\nd\n')
    execFileSync('git', ['add', 'file.txt'], { cwd: root, stdio: 'pipe' })
    expect(await service.firstChangedLine(root, 'file.txt', true)).toBe(3)
  })

  it('survives a path with a space in it', async () => {
    const root = repo()
    writeFileSync(join(root, 'a file.txt'), 'one\ntwo\n')
    commitAll(root, 'first')
    writeFileSync(join(root, 'a file.txt'), 'one\nTWO\n')
    expect(await service.firstChangedLine(root, 'a file.txt', false)).toBe(2)
  })
})
