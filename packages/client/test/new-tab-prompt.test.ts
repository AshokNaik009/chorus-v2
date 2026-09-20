/**
 * Naming a tab as it is created.
 *
 * The `+` in the tab bar asks for a name first. The cancel case is the one worth
 * pinning down: the tab is created when the dialog is answered, not before it opens,
 * so an escape has to leave the session exactly as it was.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { TuiHarness } from './harness.js'

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function start(): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 100,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile']
  })
  await harness.waitForReady()
  return harness
}

const click = (col: number, row: number) => `\u001b[<0;${col + 1};${row + 1}M\u001b[<0;${col + 1};${row + 1}m`

/** The `+` sits in the tab bar, which is row 0 to the right of the sidebar. */
async function clickNewTab(tui: TuiHarness): Promise<void> {
  const screen = await tui.screen()
  const bar = screen.split('\n')[0] ?? ''
  const column = bar.indexOf('+')
  expect(column).toBeGreaterThan(0)
  tui.write(click(column, 0))
}

describe('creating a tab from the tab bar', () => {
  it('asks for a name and puts it on the new tab', async () => {
    const tui = await start()
    await clickNewTab(tui)
    await tui.waitForText('new tab')

    // The field is seeded with the number the tab would get, so clear it first.
    tui.write('\u0003scratch\r')
    await tui.waitForText('scratch')
    const screen = await tui.screen()
    expect(screen).not.toContain('new tab')
    expect(screen.split('\n')[0]).toContain('scratch')
  })

  it('accepting the seeded number creates an ordinary numbered tab', async () => {
    const tui = await start()
    await clickNewTab(tui)
    await tui.waitForText('new tab')
    tui.write('\r')

    await tui.waitForScreen((s) => !s.includes('new tab'), 'the dialog never closed')
    // Two tabs in the bar now, the second one numbered rather than labelled.
    const bar = (await tui.screen()).split('\n')[0] ?? ''
    expect(bar).toContain('1')
    expect(bar).toContain('2')
  })

  it('escape creates no tab at all', async () => {
    const tui = await start()
    const before = (await tui.screen()).split('\n')[0] ?? ''
    await clickNewTab(tui)
    await tui.waitForText('new tab')
    tui.write('\u001b')

    await tui.waitForScreen((s) => !s.includes('new tab'), 'the dialog never closed')
    const after = (await tui.screen()).split('\n')[0] ?? ''
    expect(after).toBe(before)
  })
})
