/**
 * Dragging a split divider to resize.
 *
 * Nothing covered this before, which is how it could stop working without a red test.
 * Driven through real SGR mouse reports on the client's stdin, because the bug this
 * guards against lives in how those reports are classified, not in the resize itself.
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

/** SGR (DEC 1006) mouse reports. Columns and rows on the wire are 1-based. */
const press = (col: number, row: number) => `\u001b[<0;${col + 1};${row + 1}M`
/** Motion with the left button held: the button bits plus 32. */
const dragTo = (col: number, row: number) => `\u001b[<32;${col + 1};${row + 1}M`
const release = (col: number, row: number) => `\u001b[<0;${col + 1};${row + 1}m`
/** Motion with no button held, which DEC 1003 sends whenever the pointer moves. */
const moveTo = (col: number, row: number) => `\u001b[<35;${col + 1};${row + 1}M`

/**
 * Wait until the split has actually painted, and return the divider's column.
 *
 * Reading the screen straight after `2 panes` appears is a race: the status bar
 * updates before the second pane's border is drawn, and under parallel load the gap is
 * wide enough to measure nothing.
 */
async function settledDividerColumn(tui: TuiHarness): Promise<number> {
  const screen = await tui.waitForScreen(
    (s) => dividerColumn(s, tui.size.rows) > 0,
    'the split never drew a divider'
  )
  return dividerColumn(screen, tui.size.rows)
}

/** The column of the vertical divider, found by the run of `│` down the screen. */
function dividerColumn(screen: string, rows: number): number {
  const counts = new Map<number, number>()
  for (const line of screen.split('\n').slice(1, rows - 1)) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '│') counts.set(i, (counts.get(i) ?? 0) + 1)
    }
  }
  // The divider is the interior column that is `│` on the most rows. The two outer
  // frame edges are at the screen edges, so they are excluded by looking inward.
  let best = -1
  let bestCount = 0
  for (const [column, count] of counts) {
    if (column < 5 || column > screen.split('\n')[1]!.length - 5) continue
    if (count > bestCount) {
      best = column
      bestCount = count
    }
  }
  return best
}

describe('dragging a split divider', () => {
  it('resizes the split when the grip is dragged', async () => {
    const tui = await startSplit()
    const before = await settledDividerColumn(tui)
    expect(before).toBeGreaterThan(0)

    // The grip sits at the middle of the divider's span.
    const gripRow = Math.floor(tui.size.rows / 2)
    const target = before - 15

    tui.write(press(before, gripRow))
    tui.write(dragTo(target, gripRow))
    tui.write(release(target, gripRow))

    const screen = await tui.waitForScreen(
      (s) => dividerColumn(s, tui.size.rows) < before - 5,
      `the divider never moved left from column ${before}`
    )
    expect(dividerColumn(screen, tui.size.rows)).toBeLessThan(before - 5)
  })

  it('keeps resizing when the terminal interleaves motion reports', async () => {
    // DEC 1003 is on by default, so a real drag arrives mixed with `move` events the
    // terminal sends for the same pointer travel. Cancelling the drag on the first of
    // those is the difference between a divider that moves and one that does not.
    const tui = await startSplit()
    const before = await settledDividerColumn(tui)
    const gripRow = Math.floor(tui.size.rows / 2)

    tui.write(press(before, gripRow))
    for (let step = 1; step <= 10; step++) {
      tui.write(moveTo(before - step, gripRow))
      tui.write(dragTo(before - step, gripRow))
    }
    tui.write(release(before - 10, gripRow))

    const screen = await tui.waitForScreen(
      (s) => dividerColumn(s, tui.size.rows) < before - 5,
      `the divider never moved while motion reports were interleaved (from ${before})`
    )
    expect(dividerColumn(screen, tui.size.rows)).toBeLessThan(before - 5)
  })
})
