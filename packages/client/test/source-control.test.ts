/**
 * The Source Control panel, end to end.
 *
 * A real client, a real daemon and a real repository, driven by keystrokes. What these
 * prove is the wiring the unit tests cannot: that `C-b g` reaches the panel, that the
 * panel's keys are captured instead of reaching the shell, and that a stage actually
 * moves a file between the two sections on screen.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TuiHarness } from './harness.js'

let harness: TuiHarness | null = null
const repos: string[] = []

afterEach(async () => {
  await harness?.stop()
  harness = null
  for (const root of repos.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-scm-'))
  repos.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'tracked.txt'), 'original\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  return root
}

/**
 * The panel's own column, joined into one string.
 *
 * The panel wraps long text, so a message can be split across lines and no contiguous
 * substring of it appears on the screen. Reading its column back as one run is how a
 * test asserts on what a person would read.
 */
function panelText(screen: string, width = 34): string {
  return screen
    .split('\n')
    .map((line) => line.slice(0, width).trimEnd())
    .join(' ')
    .replace(/\s+/gu, ' ')
}

/** Start a client whose first pane sits in `cwd`, with the panel open. */
async function openPanel(cwd: string): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 110,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cwd
  })
  await harness.waitForReady()
  harness.command('g')
  return harness
}

describe('the source control panel', () => {
  it('opens on prefix g and shows the branch and the changed files', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    writeFileSync(join(root, 'fresh.txt'), 'new\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (2)')
    const screen = await tui.screen()
    expect(screen).toContain('main')
    expect(screen).toContain('tracked.txt')
    expect(screen).toContain('fresh.txt')
  })

  it('stages the selected file with enter, moving it between sections', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    tui.write('\r')

    await tui.waitForText('Staged Changes (1)')
    // "Staged Changes (1)" contains "Changes (1)", so the unstaged section has to be
    // ruled out by its own header rather than by that substring.
    expect(await tui.screen()).not.toMatch(/^\s*Changes \(/mu)
  })

  it('unstages again with enter, because the cursor follows the file', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    tui.write('\r')
    await tui.waitForText('Staged Changes (1)')
    // The file moved sections; the cursor has to have moved with it for this to work.
    tui.write('\r')
    await tui.waitForScreen((s) => s.includes('Changes (1)') && !s.includes('Staged'), 'never unstaged')
  })

  it('stages everything with a and clears it with u', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')
    writeFileSync(join(root, 'fresh.txt'), 'new\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (2)')
    tui.write('a')
    await tui.waitForText('Staged Changes (2)')
    tui.write('u')
    await tui.waitForScreen((s) => s.includes('Changes (2)') && !s.includes('Staged'), 'never unstaged all')
  })

  it('commits what is staged through the message prompt', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    tui.write('a')
    await tui.waitForText('Staged Changes (1)')

    tui.write('c')
    await tui.waitForText('commit message')
    tui.write('a real commit\r')

    await tui.waitForText('no changes')
    const log = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: root, encoding: 'utf8' })
    expect(log.trim()).toBe('a real commit')
  })

  it('refuses to commit with nothing staged, in the panel', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    tui.write('c')
    await tui.waitForText('nothing staged to commit')
  })

  it('asks before discarding, and says an untracked file is deleted', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'fresh.txt'), 'new\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    tui.write('d')
    // The wording has to distinguish a delete from a restore: only one is recoverable.
    await tui.waitForText('untracked and will be deleted')
  })

  it('keeps its keys away from the shell behind it', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    const tui = await openPanel(root)
    await tui.waitForText('Changes (1)')
    // `d` is a discard here and an ordinary character to bash. It must not be typed.
    tui.write('d')
    await tui.waitForText('will be restored')
    tui.write('\u001b')

    await tui.waitForScreen((s) => !s.includes('will be restored'), 'the confirm never closed')
    expect(await tui.screen()).not.toContain('$ d')
  })

  it('closes on escape and gives the keyboard back', async () => {
    const root = makeRepo()
    const tui = await openPanel(root)
    await tui.waitForText('no changes')
    tui.write('\u001b')

    await tui.waitForScreen((s) => !s.includes('no changes'), 'the panel never closed')
    // The shell has the keyboard again.
    tui.write('echo back-to-shell\r')
    await tui.waitForText('back-to-shell')
  })

  it('follows the shell into a repository it cd-ed to after starting', async () => {
    // The bug this covers: `pane.cwd` is the spawn directory and a `cd` does not touch
    // it, so a pane started at `/` reported "/ is not inside a git repository" however
    // far into a checkout the shell had moved.
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'edited\n')

    harness = await TuiHarness.start({
      cols: 110,
      rows: 30,
      command: '/bin/bash',
      args: ['--norc', '--noprofile'],
      cwd: '/'
    })
    await harness.waitForReady()
    harness.write(`cd ${root}\r`)
    await harness.waitForText('$ ')

    harness.command('g')
    await harness.waitForText('Changes (1)')
    expect(await harness.screen()).toContain('tracked.txt')
  })

  it('reports a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'lc-plain-'))
    repos.push(plain)
    const tui = await openPanel(plain)
    await tui.waitForScreen(
      (screen) => panelText(screen).includes('is not inside a git repository'),
      'the panel never reported a missing repository'
    )
  })
})

/**
 * PHASE-7 criterion 3: a repository with more changed files than the panel is tall.
 *
 * The defect these close: the panel drew rows until it ran out of height and stopped,
 * while the cursor carried on moving onto rows that had never been drawn. `Enter` could
 * therefore stage a file the user could not see, which is the worst way for a panel
 * whose job is to say what is about to happen to be wrong.
 *
 * Driven at a deliberately short terminal so the case is forced rather than hoped for.
 */
describe('a changes list taller than the panel', () => {
  const FILES = 24
  /** Short enough that the list cannot possibly fit, on any reasonable chrome budget. */
  const ROWS = 14

  function crowdedRepo(): string {
    const root = makeRepo()
    for (let i = 0; i < FILES; i++) {
      writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), `body ${i}\n`)
    }
    return root
  }

  async function openTall(root: string): Promise<TuiHarness> {
    harness = await TuiHarness.start({
      cols: 110,
      rows: ROWS,
      command: '/bin/bash',
      args: ['--norc', '--noprofile'],
      cwd: root
    })
    await harness.waitForReady()
    harness.command('g')
    await harness.waitForText(`Changes (${FILES})`)
    return harness
  }

  it('shows the top of the list and not the bottom, before anything moves', async () => {
    const tui = await openTall(crowdedRepo())
    const screen = await tui.screen()
    expect(screen).toContain('f00.txt')
    expect(screen).not.toContain('f23.txt')
  })

  it('scrolls to reach the last file, which no amount of height would have shown', async () => {
    const tui = await openTall(crowdedRepo())
    for (let i = 0; i < FILES - 1; i++) tui.write('j')
    await tui.waitForText('f23.txt')
    // The view followed: the first file has scrolled off the top.
    expect(await tui.screen()).not.toContain('f00.txt')
  })

  it('stages the file that is highlighted, not the one at that index', async () => {
    const root = crowdedRepo()
    const tui = await openTall(root)
    for (let i = 0; i < FILES - 1; i++) tui.write('j')
    await tui.waitForText('f23.txt')
    tui.write('\r')

    await tui.waitForText('Staged Changes (1)')
    const staged = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
    expect(staged.trim()).toBe('f23.txt')
  })

  it('comes back up with the cursor, and reaches the first file again', async () => {
    const tui = await openTall(crowdedRepo())
    for (let i = 0; i < FILES - 1; i++) tui.write('j')
    await tui.waitForText('f23.txt')
    for (let i = 0; i < FILES - 1; i++) tui.write('k')
    await tui.waitForText('f00.txt')
    expect(await tui.screen()).not.toContain('f23.txt')
  })
})

/** A bare origin and a clone of it, for the tests that need a remote. */
function clonedRepo(): { origin: string; work: string } {
  const base = mkdtempSync(join(tmpdir(), 'lc-remote-'))
  repos.push(base)
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  execFileSync('git', ['init', '-q', '-b', 'main', '--bare', origin], { stdio: 'pipe' })
  execFileSync('git', ['clone', '-q', origin, work], { stdio: 'pipe' })
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: work, stdio: 'pipe' })
  }
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(work, 'tracked.txt'), 'original\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  git('push', '-q', '-u', 'origin', 'main')
  return { origin, work }
}

/**
 * PHASE-7 criterion 5: the branch picker.
 *
 * What these prove that `src/branch.test.ts` cannot: that `b` reaches the picker rather
 * than closing the panel, that the letters typed into it filter instead of running the
 * panel's commands, and that a checkout updates the branch line off its own return
 * value with no refresh keystroke in between.
 */
describe('the branch picker', () => {
  it('opens on b and lists local and remote branches', async () => {
    const { work } = clonedRepo()
    execFileSync('git', ['branch', 'feature/login'], { cwd: work, stdio: 'pipe' })
    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('b')

    await tui.waitForText('switch branch')
    const screen = await tui.screen()
    expect(screen).toContain('main')
    expect(screen).toContain('feature/login')
    expect(screen).toContain('origin/main')
    expect(screen).toContain('remote')
  })

  it('filters as you type, and the letters do not reach the panel', async () => {
    const { work } = clonedRepo()
    execFileSync('git', ['branch', 'feature/login'], { cwd: work, stdio: 'pipe' })
    execFileSync('git', ['branch', 'chore/deps'], { cwd: work, stdio: 'pipe' })
    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('b')
    await tui.waitForText('switch branch')

    // `d` discards in the panel and `c` opens the commit prompt; here they are text.
    tui.write('chore')
    await tui.waitForScreen((s) => !s.includes('feature/login'), 'the filter never narrowed the list')
    const screen = await tui.screen()
    expect(screen).toContain('chore/deps')
    expect(screen).toContain('/chore')
    expect(screen).not.toContain('commit message')
  })

  it('switches branch on enter and updates the branch line with no refresh', async () => {
    const { work } = clonedRepo()
    execFileSync('git', ['branch', 'feature/login'], { cwd: work, stdio: 'pipe' })
    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('b')
    await tui.waitForText('switch branch')
    tui.write('feature')
    await tui.waitForScreen((s) => s.includes('/feature'), 'the filter never took')
    tui.write('\r')

    await tui.waitForScreen(
      (screen) => panelText(screen).includes('feature/login'),
      'the branch line never became the new branch'
    )
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: work, encoding: 'utf8' }).trim()).toBe('feature/login')
  })

  it('creates a local tracking branch when a remote one is picked', async () => {
    const { work } = clonedRepo()
    execFileSync('git', ['branch', 'released'], { cwd: work, stdio: 'pipe' })
    execFileSync('git', ['push', '-q', 'origin', 'released'], { cwd: work, stdio: 'pipe' })
    execFileSync('git', ['branch', '-q', '-D', 'released'], { cwd: work, stdio: 'pipe' })
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: work, stdio: 'pipe' })

    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('b')
    await tui.waitForText('switch branch')
    tui.write('origin/released')
    await tui.waitForScreen((s) => s.includes('/origin/released'), 'the filter never took')
    tui.write('\r')

    await tui.waitForScreen(
      (screen) => panelText(screen).includes('released'),
      'the branch line never became the new branch'
    )
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: work, encoding: 'utf8' }).trim()).toBe('released')
    expect(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'released@{upstream}'], { cwd: work, encoding: 'utf8' }).trim()
    ).toBe('origin/released')
  })

  it('closes on escape, leaving the branch alone and the panel focused', async () => {
    const { work } = clonedRepo()
    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('b')
    await tui.waitForText('switch branch')
    tui.write('\u001b')

    await tui.waitForScreen((s) => !s.includes('switch branch'), 'the picker never closed')
    // Still the panel's keyboard: `r` refreshes rather than reaching the shell.
    expect(await tui.screen()).toContain('no changes')
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: work, encoding: 'utf8' }).trim()).toBe('main')
  })
})

/**
 * PHASE-7 criterion 6: sync, on a dirty tree, and when a rebase conflicts.
 *
 * `--autostash` is what makes this work at all — the tree a source-control panel is
 * open over is a dirty tree by definition. See `daemon/src/git.ts` for why push does
 * not run after a failed pull.
 */
describe('sync', () => {
  /** A second clone that pushes a commit, so the first one has something to pull. */
  function pushFrom(origin: string, name: string, write: (dir: string) => void): void {
    const other = mkdtempSync(join(tmpdir(), `lc-${name}-`))
    repos.push(other)
    execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' })
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: other, stdio: 'pipe' })
    }
    git('config', 'user.email', 'other@example.com')
    git('config', 'user.name', 'Other')
    git('config', 'commit.gpgsign', 'false')
    write(other)
    git('add', '--all')
    git('commit', '-q', '-m', name)
    git('push', '-q')
  }

  it('pulls and pushes on S, keeping the dirty work and saying what it did', async () => {
    const { origin, work } = clonedRepo()
    pushFrom(origin, 'theirs', (dir) => writeFileSync(join(dir, 'theirs.txt'), 'theirs\n'))
    writeFileSync(join(work, 'mine.txt'), 'mine\n')
    execFileSync('git', ['add', '--all'], { cwd: work, stdio: 'pipe' })
    execFileSync('git', ['commit', '-q', '-m', 'mine'], { cwd: work, stdio: 'pipe' })
    writeFileSync(join(work, 'tracked.txt'), 'uncommitted edit\n')

    const tui = await openPanel(work)
    await tui.waitForText('Changes (1)')
    tui.write('S')

    // git's own conclusion line, not a phrase of ours — "Successfully rebased …" or
    // "Already up to date." depending on what there was to do.
    await tui.waitForScreen(
      (screen) => /rebased|up to date/iu.test(panelText(screen)),
      'the panel never reported what the sync did'
    )
    // The uncommitted edit came back out of the autostash, and the remote's commit is here.
    expect(readFileSync(join(work, 'tracked.txt'), 'utf8')).toBe('uncommitted edit\n')
    expect(existsSync(join(work, 'theirs.txt'))).toBe(true)
    expect(execFileSync('git', ['log', '--oneline', 'main'], { cwd: origin, encoding: 'utf8' })).toContain('mine')
    // Still the panel's own view: the edit is listed, not swallowed by the sync.
    expect(await tui.screen()).toContain('tracked.txt')
  })

  it('reports a rebase conflict as a conflict rather than as success', async () => {
    const { origin, work } = clonedRepo()
    pushFrom(origin, 'theirs', (dir) => writeFileSync(join(dir, 'tracked.txt'), 'theirs\n'))
    writeFileSync(join(work, 'tracked.txt'), 'mine\n')
    execFileSync('git', ['commit', '-q', '-am', 'mine'], { cwd: work, stdio: 'pipe' })

    const tui = await openPanel(work)
    await tui.waitForText('no changes')
    tui.write('S')

    await tui.waitForScreen(
      (screen) => /conflict|could not apply/iu.test(panelText(screen)),
      'the panel never reported the conflict'
    )
    // Nothing was pushed over the other clone's commit.
    const log = execFileSync('git', ['log', '--oneline', 'main'], { cwd: origin, encoding: 'utf8' })
    expect(log).toContain('theirs')
    expect(log).not.toContain('mine')
  })

  it('reports a repository with no remote instead of appearing to work', async () => {
    const root = makeRepo()
    const tui = await openPanel(root)
    await tui.waitForText('no changes')
    tui.write('S')
    await tui.waitForScreen(
      (screen) => /no.*(remote|upstream)|does not appear to be a git repository/iu.test(panelText(screen)),
      'the panel never reported the missing remote'
    )
  })
})
