/**
 * The Source Control panel, end to end.
 *
 * A real client, a real daemon and a real repository, driven by keystrokes. What these
 * prove is the wiring the unit tests cannot: that `C-b g` reaches the panel, that the
 * panel's keys are captured instead of reaching the shell, and that a stage actually
 * moves a file between the two sections on screen.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
