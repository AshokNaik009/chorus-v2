/**
 * The default UI: sidebar, tab bar, status bar — and the keybindings that drive them.
 *
 * This is PHASE-4's client half, checked the way the rest of the client is checked: a
 * real client process in a real PTY, with the screen read back through an emulator. The
 * other client tests turn the furniture off so they can assert on pane columns; this one
 * is about the furniture.
 *
 * It also covers criterion 6 end to end. A chord in a TOML file has to reach an action,
 * and the only honest proof of that is a rebound key doing something visible: the
 * config below moves the prefix to Ctrl-A and splits on `|`, and the test types them.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { TuiHarness, waitUntil } from './harness.js'

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function startShell(config?: string): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 120,
    rows: 32,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    ...(config === undefined ? {} : { config })
  })
  await harness.waitForReady()
  return harness
}

/** The sidebar's column range, at the default width of 22. */
const SIDEBAR_WIDTH = 22

describe('the default layout', () => {
  it('draws a sidebar, a tab bar, a bordered pane and a status bar', async () => {
    const tui = await startShell()
    const lines = (await tui.screen()).split('\n')

    // The sidebar owns the left columns from the top; the first workspace is its first
    // row, with its active tab nested beneath.
    expect(lines[0]?.slice(0, SIDEBAR_WIDTH)).toContain('1 workspace 1')
    expect(lines[1]?.slice(0, SIDEBAR_WIDTH)).toContain('›')
    // Row 0 to the right of the sidebar is the tab bar, holding the one tab.
    expect(lines[0]?.slice(SIDEBAR_WIDTH)).toContain('1')
    // The pane's top border starts one row down and one column right of the sidebar.
    expect(lines[1]?.[SIDEBAR_WIDTH]).toBe('┌')
    expect(lines[1]?.endsWith('┐')).toBe(true)
    // The status bar owns the last row.
    expect(lines[31]).toContain('leap-chorus')
    expect(lines[31]).toContain('1 pane')
  })

  it('a new workspace appears in the sidebar and becomes active', async () => {
    const tui = await startShell()
    tui.command('w')
    const screen = await tui.waitForScreen(
      (s) => s.includes('2 workspace 2'),
      'the sidebar never listed a second workspace'
    )
    // Both are listed, and the status bar says which one we are in.
    expect(screen).toContain('1 workspace 1')
    expect(screen.split('\n')[31]).toContain('[2]')
  })

  it('a new tab appears in the tab bar and under its workspace in the sidebar', async () => {
    const tui = await startShell()
    tui.command('c')
    const screen = await tui.waitForScreen(
      (s) => (s.split('\n')[0]?.slice(SIDEBAR_WIDTH).match(/\d/gu) ?? []).length >= 2,
      'the tab bar never showed a second tab'
    )
    // The active workspace's tabs are nested under it in the sidebar, the active one
    // marked; two tabs means two markers' worth of rows.
    const sidebar = screen
      .split('\n')
      .map((line) => line.slice(0, SIDEBAR_WIDTH))
      .join('\n')
    expect(sidebar).toContain('›')
  })

  it('toggling the sidebar gives its columns back to the panes', async () => {
    const tui = await startShell()
    expect((await tui.screen()).split('\n')[1]?.[SIDEBAR_WIDTH]).toBe('┌')
    tui.command('s')
    await waitUntil(
      async () => (await tui.screen()).split('\n')[1]?.[0] === '┌',
      () => 'the pane never reclaimed column 0 after the sidebar was hidden'
    )
    tui.command('s')
    await waitUntil(
      async () => (await tui.screen()).split('\n')[1]?.[SIDEBAR_WIDTH] === '┌',
      () => 'the sidebar never came back'
    )
  })

  it('switching workspaces switches which panes are drawn', async () => {
    const tui = await startShell()
    tui.write('echo one""-here\r')
    await tui.waitForText('one-here')

    tui.command('w')
    await tui.waitForText('2 workspace 2')
    // A fresh workspace shows its own pane, not the first one's output.
    await tui.waitForScreen((s) => !s.includes('one-here'), 'the new workspace still showed the old output')

    tui.command('(')
    await tui.waitForText('one-here')
  })

  it('clicking a workspace row in the sidebar focuses it', async () => {
    const tui = await startShell()
    tui.command('w')
    const screen = await tui.waitForText('2 workspace 2')
    const row = screen.split('\n').findIndex((line) => line.includes('1 workspace 1'))
    expect(row).toBeGreaterThanOrEqual(0)

    // SGR press then release at column 3 of that row; the wire is one-based.
    tui.write(`\x1b[<0;3;${row + 1}M\x1b[<0;3;${row + 1}m`)
    await tui.waitForScreen(
      (s) => (s.split('\n')[31] ?? '').includes('[1]'),
      'clicking the first workspace never focused it'
    )
  })
})

describe('keybindings come from the config (criterion 6)', () => {
  const CONFIG = `
[keys]
prefix = "C-a"

[keys.bindings]
"|" = "pane.split-right"
"%" = ""
"W" = "workspace.create"
`

  it('a rebound prefix and a rebound split both work', async () => {
    const tui = await startShell(CONFIG)
    // The status bar advertises the configured prefix rather than the default, and
    // spells it the way a keyboard is labelled: `Ctrl+A`, not the config's `C-a`.
    // Someone reading a hint has not necessarily read the config format.
    expect((await tui.screen()).split('\n')[31]).toContain('Ctrl+A')

    // Ctrl-B is no longer the prefix, so it goes to the shell as a keystroke and
    // arms nothing.
    tui.write('\x02')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await tui.screen()).not.toContain('PREFIX')

    // Ctrl-A does arm it, and `|` splits.
    tui.write('\x01')
    await tui.waitForText('PREFIX')
    tui.write('|')
    await tui.waitForText('2 panes')
  })

  it('an unbound default key reports itself instead of acting', async () => {
    const tui = await startShell(CONFIG)
    tui.write('\x01%')
    await tui.waitForScreen(
      (s) => s.includes('no binding for %'),
      'unbinding `%` did not stop it splitting'
    )
    expect(await tui.screen()).toContain('1 pane')
  })

  it('a config-added binding fires', async () => {
    const tui = await startShell(CONFIG)
    tui.write('\x01W')
    await tui.waitForText('2 workspace 2')
  })
})

describe('the status bar reports the session', () => {
  it('shows the workspace, tab, pane count and zoom', async () => {
    const tui = await startShell()
    tui.command('%')
    await tui.waitForText('2 panes')
    tui.command('z')
    const zoomed = await tui.waitForText('[zoom]')
    expect(zoomed.split('\n')[31]).toContain('[1]')
    tui.command('z')
    await tui.waitForScreen((s) => !s.includes('[zoom]'), 'zoom never turned off')
  })
})
