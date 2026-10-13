/**
 * The Changes overlay, end to end.
 *
 * A real client, a real daemon and a real repository, driven by keystrokes. What these
 * prove is the wiring the unit tests cannot: that `C-b D` and `o` both reach the
 * overlay, that the daemon really produces a patch for a real `git diff`, and — the one
 * that matters most — that an **untracked** file appears in it. `git diff` omits
 * untracked files entirely, so a new file an agent wrote would be invisible without the
 * separate `--no-index` pass, and only a test against real git can catch that
 * regressing.
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
  const root = mkdtempSync(join(tmpdir(), 'lc-diff-'))
  repos.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'tracked.txt'), 'original\nsecond\nthird\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  return root
}

async function start(cwd: string): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 110,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cwd
  })
  await harness.waitForReady()
  return harness
}

describe('the changes overlay', () => {
  it('opens on prefix D and shows the patch for the focused pane', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'original\nEDITED\nthird\n')

    const tui = await start(root)
    tui.command('D')
    await tui.waitForText('tracked.txt')
    const screen = await tui.screen()
    // The header names where this is from, which is the point of the overlay.
    expect(screen).toContain('Changes —')
    expect(screen).toContain('main')
    // The patch itself: the removed line and the added one, with their signs.
    expect(screen).toContain('-second')
    expect(screen).toContain('+EDITED')
    // Context is context, and keeps both line numbers.
    expect(screen).toMatch(/1 +1 +original/u)
    expect(screen).toMatch(/3 +3 +third/u)
  })

  it('lists every changed file in the index beside the patch', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'original\nEDITED\nthird\n')
    writeFileSync(join(root, 'another.txt'), 'also changed\n')

    const tui = await start(root)
    tui.command('D')
    await tui.waitForText('Changes (2)')
    const screen = await tui.screen()
    // Both files are in the standing list, whichever one the patch is scrolled to.
    expect(screen).toContain('tracked.txt')
    expect(screen).toContain('another.txt')
  })

  it('includes an untracked file, which plain `git diff` omits', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'brand-new.txt'), 'written by an agent\n')

    const tui = await start(root)
    tui.command('D')
    await tui.waitForText('brand-new.txt')
    const screen = await tui.screen()
    expect(screen).toContain('+written by an agent')
    // Its letter is the one the Source Control list uses for the same file.
    expect(screen).toMatch(/U\s+brand-new\.txt/u)
  })

  it('says so, rather than showing a blank box, when nothing has changed', async () => {
    const tui = await start(makeRepo())
    tui.command('D')
    await tui.waitForText('no changes')
  })

  it('closes on escape and leaves the session alone', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'changed\n')

    const tui = await start(root)
    tui.command('D')
    await tui.waitForText('Changes —')
    tui.write('\u001b')
    await tui.waitForScreen((screen) => !screen.includes('Changes —'), 'never closed')
  })

  it('is reachable from the source control panel, and leaves the dock open behind it', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'tracked.txt'), 'original\nEDITED\nthird\n')

    const tui = await start(root)
    tui.command('g')
    await tui.waitForText('Changes (1)')
    tui.write('o')
    await tui.waitForText('+EDITED')
    // `esc` closes the overlay; the dock is still open underneath, with its own list.
    tui.write('\u001b')
    await tui.waitForScreen((screen) => screen.includes('Changes (1)') && !screen.includes('+EDITED'), 'dock was lost')
  })
})
