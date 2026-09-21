/**
 * The eight drawers, against real repositories.
 *
 * Real ones, for `git.test.ts`'s reason: the thing most likely to be wrong is what git
 * actually prints. A stubbed runner would prove the parsers agree with what this file
 * imagines `git log --graph` looks like, which is exactly the assumption worth testing.
 *
 * The recording runner appears twice and only for the two questions a real repository
 * cannot answer: *how many* commands a drawer ran, and what argv an action sends.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GitCommitRow, GitDrawerRow, GitRemoteRow, GitWorktreeRow } from '@leap-chorus/protocol'
import {
  DRAWER_IDS,
  DRAWER_LIMIT,
  GitDrawerService,
  drawerArgs,
  isCommitHash,
  parseCommitLines,
  parseRemotes,
  parseStashes,
  worktreeName
} from './git-drawers.js'
import type { GitResult, GitRunner } from './worktree.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
}

/** An empty repository: no commits, no stashes, no tags, one worktree. */
function emptyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-drawer-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  return root
}

/**
 * A repository with one of everything, including a **path with a space in it**.
 *
 * The space is deliberate and is criterion 4: it travels through file history, through
 * `worktree list --porcelain` — which does not quote — and through the `:(top)`
 * pathspec `--follow` needs.
 */
function fullRepo(): { root: string; worktree: string } {
  const root = emptyRepo()
  writeFileSync(join(root, 'a file.txt'), 'one\n')
  git(root, 'add', '--all')
  git(root, 'commit', '-q', '-m', 'first commit')

  mkdirSync(join(root, 'sub'))
  writeFileSync(join(root, 'sub', 'b.txt'), 'b\n')
  git(root, 'add', '--all')
  git(root, 'commit', '-q', '-m', 'second')

  git(root, 'checkout', '-q', '-b', 'feat')
  writeFileSync(join(root, 'a file.txt'), 'one\ntwo\n')
  git(root, 'commit', '-q', '-am', 'third on feat')
  git(root, 'checkout', '-q', 'main')
  git(root, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge feat')

  git(root, 'tag', 'v1.0')
  writeFileSync(join(root, 'sub', 'b.txt'), 'b\nstashed\n')
  git(root, 'stash', '-q')
  git(root, 'remote', 'add', 'origin', 'git@github.com:owner/repo.git')

  const worktree = join(root, '..', `${root.split('/').pop() as string}-wt dir`)
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'wtb')
  return { root, worktree }
}

const service = new GitDrawerService()

/** A runner that records what it was asked to run and answers nothing. */
function recorder(result: Partial<GitResult> = {}): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: GitRunner = async (args) => {
    calls.push([...args])
    return { stdout: '', stderr: '', code: 0, ...result }
  }
  return { runner, calls }
}

describe('the eight commands', () => {
  it('is eight drawers, in herdr-sidebar order', () => {
    expect(DRAWER_IDS).toEqual([
      'graph',
      'commits',
      'fileHistory',
      'branches',
      'worktrees',
      'remotes',
      'stashes',
      'tags'
    ])
    expect(DRAWER_LIMIT).toBe(30)
  })

  it('asks git for what PHASE-11 says, and caps at the limit', () => {
    expect(drawerArgs({ drawer: 'graph' })).toContain('--graph')
    expect(drawerArgs({ drawer: 'graph' })).toContain('-30')
    expect(drawerArgs({ drawer: 'commits' })).not.toContain('--graph')
    expect(drawerArgs({ drawer: 'worktrees' })).toEqual(['worktree', 'list', '--porcelain'])
    expect(drawerArgs({ drawer: 'remotes' })).toEqual(['remote', '-v'])
    expect(drawerArgs({ drawer: 'tags' })).toEqual(['tag', '--sort=-creatordate'])
    expect(drawerArgs({ drawer: 'stashes' })).toEqual([
      'stash',
      'list',
      '--format=%H%x00%gd%x00%gs',
      '-30'
    ])
  })

  it('serves Branches from the picker query, not from `branch -a`', () => {
    // The decision PHASE-11 asks to be made deliberately. One query, two readers.
    const args = drawerArgs({ drawer: 'branches' }) as string[]
    expect(args[0]).toBe('for-each-ref')
    expect(args.join(' ')).toContain('%(symref)')
  })

  it('follows one file, repo-relative wherever the shell is', () => {
    const args = drawerArgs({ drawer: 'fileHistory', path: 'sub/b.txt' }) as string[]
    expect(args).toContain('--follow')
    expect(args[args.length - 1]).toBe(':(top)sub/b.txt')
  })

  it('has nothing to ask when no file is selected', () => {
    expect(drawerArgs({ drawer: 'fileHistory' })).toBeNull()
  })
})

describe('a repository with one of everything', () => {
  it('lists commits, newest first, with a full hash on every row', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'commits' })
    const commits = rows.filter((row): row is GitCommitRow => row.kind === 'commit')
    // Newest first is git's order, and the merge is newest. The two commits underneath
    // it share a timestamp in a test this fast, so their relative order is git's to
    // decide and not something to assert.
    expect(commits[0]?.subject).toBe('merge feat')
    expect(commits.map((row) => row.subject).sort()).toEqual(
      ['first commit', 'merge feat', 'second', 'third on feat'].sort()
    )
    // Structured, which is criterion 3: the hash is a field, not something anybody has
    // to find in the text.
    for (const commit of commits) {
      expect(commit.hash).toMatch(/^[0-9a-f]{40}$/u)
      expect(commit.short.length).toBeGreaterThanOrEqual(7)
    }
    expect(commits[0]?.refs).toContain('tag: v1.0')
    expect(commits[0]?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  })

  it('keeps the graph rails git drew, as their own rows', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'graph' })
    const rails = rows.filter((row) => row.kind === 'rail')
    // A merge is what makes `--graph` draw anything at all.
    expect(rails.length).toBeGreaterThan(0)
    const merge = rows.find((row): row is GitCommitRow => row.kind === 'commit' && row.subject === 'merge feat')
    expect(merge?.rail).toContain('*')
    const side = rows.find((row): row is GitCommitRow => row.kind === 'commit' && row.subject === 'third on feat')
    // The side of the merge is indented by git, and we draw it as given.
    expect(side?.rail).toContain('|')
  })

  it('follows a file whose name has a space in it', async () => {
    const { root } = fullRepo()
    const { rows, note } = await service.rows(root, { drawer: 'fileHistory', path: 'a file.txt' })
    expect(note).toBeNull()
    expect(rows.map((row) => (row.kind === 'commit' ? row.subject : ''))).toEqual([
      'third on feat',
      'first commit'
    ])
  })

  it('follows that file from a subdirectory too', async () => {
    const { root } = fullRepo()
    // `:(top)` is the whole reason a drawer costs one command and not two.
    const { rows } = await service.rows(join(root, 'sub'), { drawer: 'fileHistory', path: 'a file.txt' })
    expect(rows.length).toBe(2)
  })

  it('lists branches with the current one marked and no symbolic refs', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'branches' })
    const names = rows.map((row) => (row.kind === 'branch' ? row.name : ''))
    expect(names).toContain('main')
    expect(names).toContain('feat')
    expect(rows.find((row) => row.kind === 'branch' && row.current)).toMatchObject({ name: 'main' })
  })

  it('lists worktrees by folder name, with the space intact', async () => {
    const { root, worktree } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'worktrees' })
    const trees = rows.filter((row): row is GitWorktreeRow => row.kind === 'worktree')
    expect(trees.length).toBe(2)
    expect(trees[0]?.primary).toBe(true)
    const linked = trees.find((row) => !row.primary)
    expect(linked?.name).toContain('wt dir')
    expect(linked?.branch).toBe('wtb')
    // The full path travels too: it is what Remove and Copy Path need.
    expect(linked?.path.endsWith('wt dir')).toBe(true)
    rmSync(worktree, { recursive: true, force: true })
  })

  it('keeps only the fetch line of each remote', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'remotes' })
    expect(rows).toEqual([{ kind: 'remote', name: 'origin', url: 'git@github.com:owner/repo.git' }])
  })

  it('lists stashes with the ref git will act on', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'stashes' })
    expect(rows.length).toBe(1)
    expect(rows[0]).toMatchObject({ kind: 'stash', index: 0, ref: 'stash@{0}' })
  })

  it('lists tags', async () => {
    const { root } = fullRepo()
    const { rows } = await service.rows(root, { drawer: 'tags' })
    expect(rows).toEqual([{ kind: 'tag', name: 'v1.0' }])
  })
})

describe('the empty cases, which are the common ones', () => {
  it('says there are no commits yet rather than failing', async () => {
    const root = emptyRepo()
    for (const drawer of ['graph', 'commits'] as const) {
      const result = await service.rows(root, { drawer })
      expect(result.rows).toEqual([])
      expect(result.note).toBe('no commits yet')
    }
  })

  it('has no file history until a file is selected, and says so', async () => {
    const root = emptyRepo()
    const { rows, note } = await service.rows(root, { drawer: 'fileHistory' })
    expect(rows).toEqual([])
    expect(note).toBe('select a file to see its history')
  })

  it('returns an empty list, with no note, for the drawers that are simply empty', async () => {
    const root = emptyRepo()
    for (const drawer of ['branches', 'remotes', 'stashes', 'tags'] as const) {
      const result = await service.rows(root, { drawer })
      expect(result).toEqual({ rows: [], note: null })
    }
  })

  it('reports the one worktree a fresh repository has', async () => {
    const root = emptyRepo()
    const { rows } = await service.rows(root, { drawer: 'worktrees' })
    expect(rows.length).toBe(1)
    expect((rows[0] as GitWorktreeRow).primary).toBe(true)
  })
})

describe('how many commands a drawer costs', () => {
  it('runs exactly one, for every drawer', async () => {
    for (const drawer of DRAWER_IDS) {
      const { runner, calls } = recorder()
      await new GitDrawerService({ git: runner }).rows('/repo', {
        drawer,
        ...(drawer === 'fileHistory' ? { path: 'a.txt' } : {})
      })
      expect(calls.length, drawer).toBe(1)
    }
  })

  it('runs none at all when there is nothing to ask', async () => {
    const { runner, calls } = recorder()
    await new GitDrawerService({ git: runner }).rows('/repo', { drawer: 'fileHistory' })
    expect(calls).toEqual([])
  })
})

describe('the actions', () => {
  it('sends the argv PHASE-11 describes, and never opens an editor', async () => {
    const { runner, calls } = recorder()
    const acting = new GitDrawerService({ git: runner })
    const hash = 'a'.repeat(40)
    await acting.act('/repo', 'commit.checkout', hash)
    await acting.act('/repo', 'commit.cherryPick', hash)
    await acting.act('/repo', 'commit.revert', hash)
    await acting.act('/repo', 'commit.reset', hash)
    await acting.act('/repo', 'branch.merge', 'feat')
    await acting.act('/repo', 'branch.delete', 'feat')
    await acting.act('/repo', 'stash.apply', 'stash@{1}')
    await acting.act('/repo', 'stash.drop', 'stash@{1}')
    await acting.act('/repo', 'remote.fetch', 'origin')
    await acting.act('/repo', 'tag.delete', 'v1.0')
    expect(calls).toEqual([
      ['checkout', '--detach', hash],
      ['cherry-pick', hash],
      ['revert', '--no-edit', hash],
      ['reset', '--mixed', hash],
      ['merge', '--no-edit', 'feat'],
      ['branch', '-d', 'feat'],
      ['stash', 'apply', 'stash@{1}'],
      ['stash', 'drop', 'stash@{1}'],
      ['fetch', 'origin'],
      ['tag', '-d', 'v1.0']
    ])
    // `--hard` is the spelling that destroys work, and nothing here has it.
    expect(calls.flat()).not.toContain('--hard')
  })

  it('refuses a commit action whose ref is not a hash', async () => {
    const { runner, calls } = recorder()
    const acting = new GitDrawerService({ git: runner })
    await expect(acting.act('/repo', 'commit.revert', 'main')).rejects.toThrow(/commit hash/u)
    // The validator runs before git does, which is the point of having one.
    expect(calls).toEqual([])
  })

  it('refuses a ref that would be read as an option', async () => {
    const { runner, calls } = recorder()
    const acting = new GitDrawerService({ git: runner })
    await expect(acting.act('/repo', 'branch.delete', '--all')).rejects.toThrow(/not a name/u)
    await expect(acting.act('/repo', 'stash.drop', 'stash@{x}')).rejects.toThrow(/stash@/u)
    expect(calls).toEqual([])
  })

  it('really drops a stash, and really reverts a commit', async () => {
    const { root } = fullRepo()
    await service.act(root, 'stash.drop', 'stash@{0}')
    expect(git(root, 'stash', 'list').trim()).toBe('')

    // Not HEAD: HEAD is the merge, and git refuses to revert one without being told
    // which side to keep — see the test below, which is the more interesting half.
    const second = git(root, 'rev-parse', 'HEAD^1').trim()
    await service.act(root, 'commit.revert', second)
    expect(git(root, 'log', '--oneline', '-1')).toContain('Revert')
  })

  it('relays git\'s refusal to revert a merge instead of guessing a side', async () => {
    const { root } = fullRepo()
    const merge = git(root, 'rev-parse', 'HEAD').trim()
    // `-m 1` is a decision about which parent history to keep, and a menu entry with
    // no way to ask is not allowed to make it. git's own sentence says exactly that.
    await expect(service.act(root, 'commit.revert', merge)).rejects.toThrow(/is a merge/u)
  })

  it('fails with a message rather than hanging, for an unreachable remote', async () => {
    const { root } = fullRepo()
    // `origin` here is a GitHub URL nothing in this test can reach. It must come back
    // with a message — the credential guard in `gitEnv` is what makes that immediate
    // rather than a thirty-second block on a prompt nothing is attached to.
    await expect(service.act(root, 'remote.fetch', 'origin')).rejects.toThrow()
  }, 40_000)
})

describe('the parsers, on shapes a fixture cannot easily produce', () => {
  it('splits a graph line at the first NUL and keeps everything before it', () => {
    const rows = parseCommitLines(`|\\  \n| * \0${'b'.repeat(40)}\0bbbbbbb\0\0\0on a branch`)
    expect(rows[0]).toEqual({ kind: 'rail', rail: '|\\' })
    expect(rows[1]).toMatchObject({ kind: 'commit', rail: '| * ', subject: 'on a branch' })
  })

  it('drops a line whose hash is not a hash', () => {
    expect(parseCommitLines('\0not-a-hash\0x\0\0\0subject')).toEqual([])
  })

  it('splits %D into refs', () => {
    const rows = parseCommitLines(`\0${'c'.repeat(40)}\0ccccccc\0HEAD -> main, tag: v2, origin/main\0\0s`)
    expect((rows[0] as GitCommitRow).refs).toEqual(['HEAD -> main', 'tag: v2', 'origin/main'])
  })

  it('keeps the fetch URL and drops the push line', () => {
    const rows: GitRemoteRow[] = parseRemotes(
      'origin\thttps://example.com/o/r.git (fetch)\norigin\thttps://example.com/o/r.git (push)\n'
    )
    expect(rows).toEqual([{ kind: 'remote', name: 'origin', url: 'https://example.com/o/r.git' }])
  })

  it('takes a stash index from its position, not from its text', () => {
    const rows = parseStashes(`${'d'.repeat(40)}\0stash@{0}\0WIP one\n${'e'.repeat(40)}\0stash@{1}\0WIP two`)
    expect(rows.map((row) => row.index)).toEqual([0, 1])
  })

  it('knows a hash from anything else', () => {
    expect(isCommitHash('1e7f2c9')).toBe(true)
    expect(isCommitHash('1e7f2c')).toBe(false)
    expect(isCommitHash('1E7F2C9')).toBe(false)
    expect(isCommitHash('main')).toBe(false)
  })

  it('takes the folder name off a path that has spaces in it', () => {
    expect(worktreeName('/tmp/some dir/my repo-wt dir')).toBe('my repo-wt dir')
    expect(worktreeName('/tmp/repo/')).toBe('repo')
  })

  it('never invents a row out of an empty answer', () => {
    const rows: GitDrawerRow[] = parseCommitLines('')
    expect(rows).toEqual([])
    expect(parseStashes('')).toEqual([])
    expect(parseRemotes('')).toEqual([])
  })
})
