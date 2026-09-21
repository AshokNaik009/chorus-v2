/**
 * Search, end to end: a real client, a real daemon, a real repository.
 *
 * What these prove is the wiring the unit tests cannot — that `Ctrl+P` reaches the
 * panel rather than the shell behind it, that the file list really comes from the
 * daemon, and that clicking a chip in the activity bar switches view.
 *
 * **`rg` is not installed on this machine** (HANDOFF.md), so quick open here exercises
 * the `git ls-files` fallback and content search exercises the message. That is the
 * honest coverage available: the rg-present paths are covered against an injected
 * runner in `daemon/src/search.test.ts`.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { TuiHarness } from './harness.js'

let harness: TuiHarness | null = null
const made: string[] = []
const previousPager = process.env['PAGER']

beforeAll(() => {
  // The client reads `$PAGER` when it opens a file, so this pins what the test opens
  // rather than inheriting whatever the developer prefers. It has to be a pager that
  // *stays up*: a pane whose program exits is closed, the way a tmux pane is, so a
  // `cat` would put the file on screen and take it away again before an assertion.
  process.env['PAGER'] = 'less'
})

afterAll(() => {
  if (previousPager === undefined) delete process.env['PAGER']
  else process.env['PAGER'] = previousPager
})

afterEach(async () => {
  await harness?.stop()
  harness = null
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository with a tracked file, an untracked one, and an ignored one. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-find-'))
  made.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, '.gitignore'), 'noise.log\n')
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const needle = 1\n')
  writeFileSync(join(root, 'README.md'), '# repo\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(root, 'noise.log'), 'ignore me\n')
  return root
}

async function openPanel(cwd: string, key: string): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 110,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cwd,
    // Cleared for the daemon, which spawns the pager: a `$LESS` containing `-F` makes
    // less quit on a file that fits one screen, which every file in this repo does.
    env: { LESS: '' }
  })
  await harness.waitForReady()
  harness.command(key)
  return harness
}

/** The dock's own columns, joined into one string: the panel wraps its messages. */
function panelText(screen: string, width = 34): string {
  return screen
    .split('\n')
    .map((line) => line.slice(0, width).trimEnd())
    .join(' ')
    .replace(/\s+/gu, ' ')
}

const CTRL_P = '\u0010'
const CTRL_F = '\u0006'

describe('quick open', () => {
  it('lists the files under the root, ignored ones absent', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    tui.write(CTRL_P)
    await tui.waitForText('src/widget.ts')
    const screen = await tui.screen()
    expect(screen).toContain('README.md')
    // `.gitignore` covers it, so the listing does not: an index full of build output
    // is the failure mode the ignore rules exist to prevent.
    expect(screen).not.toContain('noise.log')
  })

  it('filters as you type', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    tui.write(CTRL_P)
    await tui.waitForText('src/widget.ts')
    tui.write('widget')
    await tui.waitForScreen(
      (screen) => screen.includes('src/widget.ts') && !screen.includes('README.md'),
      'the filter never narrowed the list'
    )
  })

  it('opens the selection in a pane', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    tui.write(CTRL_P)
    await tui.waitForText('src/widget.ts')
    tui.write('widget')
    await tui.waitForScreen((screen) => !screen.includes('README.md'), 'the filter never narrowed')
    tui.write('\r')
    // The pager shows the file, which is how the test sees *which* file was opened.
    await tui.waitForText('export const needle = 1')
    expect(await tui.screen()).toContain('2 panes')
  })

  it('ctrl-f from quick open lands in content search', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    tui.write(CTRL_P)
    await tui.waitForText('src/widget.ts')
    tui.write(CTRL_F)
    await tui.waitForText('type a query')
  })

  it('escape goes back to the view it was opened from', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    tui.write(CTRL_P)
    await tui.waitForText('files')
    tui.write('\u001b')
    // The tree, not the shell: quick open is a peek out of a view, not out of the dock.
    await tui.waitForText('src/')
    expect(await tui.screen()).toContain('stage')
  })
})

describe('content search without ripgrep', () => {
  it('says what is missing and how to install it, and does not crash', async () => {
    const root = makeRepo()
    const tui = await openPanel(root, 'f')
    await tui.waitForText('type a query')
    tui.write('needle\r')
    await tui.waitForText('ripgrep')
    const text = panelText(await tui.screen())
    expect(text).toContain('not on the daemon PATH')
    expect(text).toMatch(/install ripgrep|brew install|apt install|pacman|apk add/u)
    // Still alive, still the panel's keyboard: escape hands it back to the shell.
    tui.write('\u001b')
    await tui.waitForScreen((screen) => !screen.includes('ripgrep'), 'the panel never closed')
    tui.write('echo back-to-shell\r')
    await tui.waitForText('back-to-shell')
  })
})

describe('the activity bar', () => {
  /** An SGR (DEC 1006) left-button press. Columns and rows on the wire are 1-based. */
  const press = (col: number, row: number): string => `\u001b[<0;${col + 1};${row + 1}M`

  it('switches view when a chip is clicked', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src', 'widget.ts'), 'edited\n')
    const tui = await openPanel(root, 'e')
    await tui.waitForText('README.md')
    const screen = await tui.screen()
    expect(screen).toContain('files')
    expect(screen).toContain('search')
    expect(screen).toContain('git')

    // ` files  search  git `: the third chip starts at column 15.
    tui.write(press(16, 0))
    await tui.waitForText('Changes (1)')
    tui.write(press(1, 0))
    await tui.waitForText('README.md')
  })
})
