/**
 * Naming a pane.
 *
 * Two routes to the same modal: `prefix P`, and a click on a split's divider grip.
 * The click is the interesting one, because the same grip is also the resize handle —
 * these pin down that a click names and a drag resizes, and that neither becomes the
 * other.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { PLAIN_UI_CONFIG, TuiHarness } from './harness.js'

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function startSplit(): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 100,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    config: PLAIN_UI_CONFIG
  })
  await harness.waitForReady()
  harness.command('%')
  await harness.waitForText('2 panes')
  return harness
}

const press = (col: number, row: number) => `\u001b[<0;${col + 1};${row + 1}M`
const dragTo = (col: number, row: number) => `\u001b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\u001b[<0;${col + 1};${row + 1}m`

/** The column of the vertical divider, found by the run of `│` down the screen. */
function dividerColumn(screen: string, rows: number): number {
  const counts = new Map<number, number>()
  for (const line of screen.split('\n').slice(1, rows - 1)) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '│') counts.set(i, (counts.get(i) ?? 0) + 1)
    }
  }
  let best = -1
  let bestCount = 0
  const width = screen.split('\n')[1]?.length ?? 0
  for (const [column, count] of counts) {
    if (column < 5 || column > width - 5) continue
    if (count > bestCount) {
      best = column
      bestCount = count
    }
  }
  return best
}

async function settledDividerColumn(tui: TuiHarness): Promise<number> {
  const screen = await tui.waitForScreen(
    (s) => dividerColumn(s, tui.size.rows) > 0,
    'the split never drew a divider'
  )
  return dividerColumn(screen, tui.size.rows)
}

describe('renaming a pane', () => {
  it('opens the modal on prefix P and puts the name on the border', async () => {
    const tui = await startSplit()
    tui.command('P')
    await tui.waitForText('rename pane')

    tui.write('builder\r')
    await tui.waitForText('builder')
    const screen = await tui.screen()
    // On the border of the focused pane, which is the right-hand one after a split.
    expect(screen).toContain('builder')
    expect(screen).not.toContain('rename pane')
  })

  it('opens the modal when the divider grip is clicked without dragging', async () => {
    const tui = await startSplit()
    const column = await settledDividerColumn(tui)
    const gripRow = Math.floor(tui.size.rows / 2)

    tui.write(press(column, gripRow))
    tui.write(release(column, gripRow))

    await tui.waitForText('rename pane')
    tui.write('api\r')
    await tui.waitForText('api')
    expect(await tui.screen()).not.toContain('rename pane')
  })

  it('does not open the modal when the grip is dragged', async () => {
    const tui = await startSplit()
    const column = await settledDividerColumn(tui)
    const gripRow = Math.floor(tui.size.rows / 2)

    tui.write(press(column, gripRow))
    tui.write(dragTo(column - 12, gripRow))
    tui.write(release(column - 12, gripRow))

    await tui.waitForScreen(
      (s) => dividerColumn(s, tui.size.rows) < column - 5,
      'the drag did not resize'
    )
    // A resize is not a rename: the modal must never have opened.
    expect(await tui.screen()).not.toContain('rename pane')
  })

  it('escape leaves the pane name alone', async () => {
    const tui = await startSplit()
    tui.command('P')
    await tui.waitForText('rename pane')
    tui.write('discarded\u001b')

    await tui.waitForScreen((s) => !s.includes('rename pane'), 'the modal never closed')
    expect(await tui.screen()).not.toContain('discarded')
  })
})
