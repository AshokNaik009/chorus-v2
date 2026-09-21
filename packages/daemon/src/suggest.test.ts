/**
 * Drafting a commit message, with and without a model.
 *
 * PHASE-9: "AI commit drafting, if built, is opt-in and offline-capable. Same rule as
 * `rg` in phase 8: absent is a message, not a failure, and **nothing leaves the machine
 * unless the user asked for it**."
 *
 * The last clause is the one that needs a test rather than a comment, so the first
 * `describe` below asserts the negative: with `ai` false, no subprocess is started at
 * all. A feature whose safety rests on a default is a feature whose default has to be
 * checked.
 */

import { describe, expect, it } from 'vitest'
import type { GitStatus } from './git.js'
import {
  SuggestService,
  commonScope,
  firstSubject,
  fromFilenames,
  type ClaudeOutcome,
  type ClaudeRunner
} from './suggest.js'
import type { GitRunner } from './worktree.js'

function status(staged: { path: string; letter: string }[]): GitStatus {
  return {
    root: '/repo',
    branch: 'main',
    staged: staged.map((entry) => ({ path: entry.path, origin: null, letter: entry.letter })),
    unstaged: [],
    ahead: 0,
    behind: 0,
    hasUpstream: true
  }
}

const git: GitRunner = async () => ({ stdout: 'diff --git a/x b/x\n+one\n', stderr: '', code: 0 })

function claudeSaying(stdout: string, overrides: Partial<ClaudeOutcome> = {}): ClaudeRunner {
  return async () => ({ code: 0, stdout, stderr: '', timedOut: false, spawnError: null, ...overrides })
}

describe('nothing leaves the machine unless it was asked for', () => {
  it('with ai off, the CLI is never spawned and neither is git diff', async () => {
    let claudeCalls = 0
    let gitCalls = 0
    const service = new SuggestService({
      claude: async () => {
        claudeCalls += 1
        return { code: 0, stdout: 'x', stderr: '', timedOut: false, spawnError: null }
      },
      git: async (...args) => {
        gitCalls += 1
        return git(...args)
      }
    })
    const result = await service.suggest('/repo', status([{ path: 'src/app.ts', letter: 'M' }]), false)
    expect(claudeCalls).toBe(0)
    // The diff is not even *read*, let alone sent. With the switch off this feature
    // touches nothing but the status the panel already had.
    expect(gitCalls).toBe(0)
    expect(result.source).toBe('filenames')
    expect(result.note).toBeNull()
  })

  it('with ai on, the prompt carries the diff and the CLI is asked once', async () => {
    let seen = ''
    const service = new SuggestService({
      git,
      claude: async (_args, input) => {
        seen = input
        return { code: 0, stdout: 'feat: add a thing\n', stderr: '', timedOut: false, spawnError: null }
      }
    })
    const result = await service.suggest('/repo', status([{ path: 'src/app.ts', letter: 'M' }]), true)
    expect(seen).toContain('commit subject')
    expect(seen).toContain('diff --git')
    expect(result).toEqual({ message: 'feat: add a thing', source: 'claude', note: null })
  })

  it('the diff is capped, and the excerpt says so rather than looking complete', async () => {
    let seen = ''
    const huge: GitRunner = async (args) => ({
      stdout: args[2] === '--stat' ? ' x | 1 +\n' : 'x'.repeat(50_000),
      stderr: '',
      code: 0
    })
    const service = new SuggestService({
      git: huge,
      maxDiffBytes: 1_000,
      claude: async (_args, input) => {
        seen = input
        return { code: 0, stdout: 'chore: x\n', stderr: '', timedOut: false, spawnError: null }
      }
    })
    await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(seen.length).toBeLessThan(3_000)
    // Said out loud, so the model is not allowed to conclude the change is small.
    expect(seen).toContain('diff truncated')
  })
})

describe('the offline draft, which is the interesting half', () => {
  it('one added file gets a feat and its own name', () => {
    expect(fromFilenames(status([{ path: 'src/thing.ts', letter: 'A' }]))).toBe('feat: add thing.ts')
  })

  it('one modified file is a chore that updates it', () => {
    expect(fromFilenames(status([{ path: 'src/thing.ts', letter: 'M' }]))).toBe('chore: update thing.ts')
  })

  it('deletions say remove', () => {
    expect(fromFilenames(status([{ path: 'old.ts', letter: 'D' }]))).toBe('chore: remove old.ts')
  })

  it('several files under one directory get it as a scope', () => {
    const message = fromFilenames(
      status([
        { path: 'packages/client/a.ts', letter: 'M' },
        { path: 'packages/client/b.ts', letter: 'M' }
      ])
    )
    expect(message).toBe('chore(packages/client): update 2 files')
  })

  it('files with nothing in common get no scope rather than a wrong one', () => {
    const message = fromFilenames(
      status([
        { path: 'a.ts', letter: 'M' },
        { path: 'docs/b.md', letter: 'M' }
      ])
    )
    expect(message).toBe('chore: update 2 files')
  })

  it('a change entirely under tests is a test, and entirely under docs is docs', () => {
    expect(
      fromFilenames(
        status([
          { path: 'src/a.test.ts', letter: 'M' },
          { path: 'src/b.test.ts', letter: 'M' }
        ])
      )
    ).toMatch(/^test/u)
    expect(
      fromFilenames(
        status([
          { path: 'docs/a.md', letter: 'M' },
          { path: 'README.md', letter: 'M' }
        ])
      )
    ).toMatch(/^docs/u)
  })

  it('a mixed change does not guess `fix` from a filename', () => {
    // Guessing `fix` is a claim the paths cannot support, and one the user then has to
    // notice and correct — which is worse than a plain `chore`.
    expect(
      fromFilenames(
        status([
          { path: 'src/a.ts', letter: 'M' },
          { path: 'src/b.test.ts', letter: 'A' }
        ])
      )
    ).toMatch(/^chore/u)
  })

  it('refuses to draft anything for an empty index', async () => {
    const service = new SuggestService({ git, claude: claudeSaying('x') })
    await expect(service.suggest('/repo', status([]), false)).rejects.toThrow(/nothing staged/u)
  })

  it('commonScope finds the shared directory and nothing else', () => {
    expect(commonScope(['a/b/one.ts', 'a/b/two.ts'])).toBe('a/b')
    expect(commonScope(['a/b/one.ts', 'a/c/two.ts'])).toBe('a')
    expect(commonScope(['one.ts', 'two.ts'])).toBeNull()
    expect(commonScope([])).toBeNull()
  })
})

describe('when the model is asked for and does not answer', () => {
  it('a missing CLI falls back with a note, and never says "not installed"', async () => {
    const service = new SuggestService({
      git,
      claude: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' })
    })
    const result = await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(result.source).toBe('filenames')
    // The draft is still usable — a missing CLI is a reason the message is plainer, not
    // a reason there is no message.
    expect(result.message).toBe('chore: update a.ts')
    // The same distinction phase 8 draws for `rg`: the daemon's PATH is not a login
    // shell's, so "not installed" is a claim we cannot support.
    expect(result.note).toContain('not on the daemon PATH')
    expect(result.note).not.toContain('not installed')
  })

  it('a transient launch failure names the code and does not offer install advice', async () => {
    const service = new SuggestService({
      git,
      claude: async () => ({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'EMFILE' })
    })
    const result = await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(result.note).toContain('EMFILE')
    expect(result.note).not.toContain('PATH')
  })

  it('a timeout falls back rather than leaving the commit box waiting', async () => {
    const service = new SuggestService({ git, claude: claudeSaying('', { timedOut: true, code: null }) })
    const result = await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(result.source).toBe('filenames')
    expect(result.note).toContain('too long')
  })

  it('a non-zero exit relays what the CLI said', async () => {
    const service = new SuggestService({
      git,
      claude: claudeSaying('', { code: 1, stderr: 'not logged in\n' })
    })
    const result = await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(result.note).toContain('not logged in')
  })

  it('an answer with no usable subject falls back rather than committing an empty line', async () => {
    const service = new SuggestService({ git, claude: claudeSaying('\n\n   \n') })
    const result = await service.suggest('/repo', status([{ path: 'a.ts', letter: 'M' }]), true)
    expect(result.source).toBe('filenames')
    expect(result.message).toBe('chore: update a.ts')
  })
})

describe('reading a subject out of whatever the CLI said', () => {
  it('takes the first real line and drops everything after it', () => {
    expect(firstSubject('feat: a thing\n\nAnd here is why.\n')).toBe('feat: a thing')
  })

  it('strips a fence and surrounding quotes', () => {
    expect(firstSubject('```\nfix: the bug\n```')).toBe('fix: the bug')
    expect(firstSubject('"fix: the bug"')).toBe('fix: the bug')
    expect(firstSubject('`fix: the bug`')).toBe('fix: the bug')
  })

  it('collapses whitespace and cuts an over-long subject', () => {
    const long = firstSubject(`feat: ${'x'.repeat(300)}`)
    expect(long.length).toBeLessThanOrEqual(120)
    expect(long.endsWith('…')).toBe(true)
  })

  it('an empty answer is empty, not whitespace', () => {
    expect(firstSubject('')).toBe('')
    expect(firstSubject('\n \n')).toBe('')
  })
})
