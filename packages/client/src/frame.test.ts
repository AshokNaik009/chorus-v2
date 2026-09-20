import { describe, expect, it } from 'vitest'
import { ATTR_BOLD, ScreenBuffer, rect, rgbColor } from '@leap-chorus/tui'
import type { SnapshotRun, TerminalSnapshot } from '@leap-chorus/protocol'
import { blitSnapshot, snapshotCursor } from './frame.js'

function run(text: string, extra: Partial<SnapshotRun> = {}): SnapshotRun {
  return { text, width: extra.width ?? text.length, fg: -1, bg: -1, attrs: 0, ...extra }
}

function snapshotOf(rows: SnapshotRun[][], options: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  const cols = options.cols ?? Math.max(...rows.map((r) => r.reduce((n, s) => n + s.width, 0)), 0)
  return {
    cols,
    rows: rows.length,
    buffer: 'normal',
    cursor: { x: 0, y: 0, visible: true },
    lines: rows.map((runs) => ({ runs })),
    scrollbackLines: 0,
    title: null,
    sequence: 0,
    ...options
  }
}

describe('blitSnapshot', () => {
  it('draws a snapshot at an offset', () => {
    const buffer = new ScreenBuffer(10, 4)
    blitSnapshot(buffer, rect(2, 1, 5, 2), snapshotOf([[run('hello')], [run('world')]]))
    expect(buffer.rowText(0)).toBe('')
    expect(buffer.rowText(1)).toBe('  hello')
    expect(buffer.rowText(2)).toBe('  world')
  })

  it('carries style through per run', () => {
    const buffer = new ScreenBuffer(6, 1)
    blitSnapshot(
      buffer,
      rect(0, 0, 6, 1),
      snapshotOf([[run('ab', { fg: 2, attrs: ATTR_BOLD }), run('cd', { bg: rgbColor(0x112233) })]])
    )
    expect(buffer.get(0, 0)).toMatchObject({ char: 'a', fg: 2, attrs: ATTR_BOLD })
    expect(buffer.get(2, 0)).toMatchObject({ char: 'c', bg: rgbColor(0x112233) })
  })

  it('clips a snapshot wider than its pane', () => {
    const buffer = new ScreenBuffer(10, 1)
    blitSnapshot(buffer, rect(0, 0, 4, 1), snapshotOf([[run('abcdefgh')]]))
    expect(buffer.rowText(0)).toBe('abcd')
  })

  it('blanks the remainder when the snapshot is narrower than the pane', () => {
    const buffer = new ScreenBuffer(8, 1)
    buffer.writeString(0, 0, 'XXXXXXXX')
    blitSnapshot(buffer, rect(0, 0, 8, 1), snapshotOf([[run('ab')]]))
    expect(buffer.rowText(0)).toBe('ab')
  })

  it('blanks rows the snapshot does not have', () => {
    const buffer = new ScreenBuffer(4, 3)
    buffer.writeString(0, 2, 'stale')
    blitSnapshot(buffer, rect(0, 0, 4, 3), snapshotOf([[run('a')]]))
    expect(buffer.rowText(2)).toBe('')
  })

  it('respects a run whose width disagrees with its text length', () => {
    const buffer = new ScreenBuffer(6, 1)
    // One character, two columns: the daemon reports width 2 with text of length 1.
    blitSnapshot(buffer, rect(0, 0, 6, 1), snapshotOf([[run('漢', { width: 2 }), run('ab')]]))
    expect(buffer.get(0, 0)).toMatchObject({ char: '漢', width: 2 })
    expect(buffer.get(1, 0)).toMatchObject({ width: 0 })
    expect(buffer.rowText(0)).toBe('漢ab')
  })

  it('drops a wide character that would straddle the pane edge', () => {
    const buffer = new ScreenBuffer(6, 1)
    blitSnapshot(buffer, rect(0, 0, 3, 1), snapshotOf([[run('ab'), run('漢', { width: 2 })]]))
    expect(buffer.get(2, 0)).toMatchObject({ char: ' ', width: 1 })
  })

  it('attaches a combining mark to the cell on its left', () => {
    const buffer = new ScreenBuffer(4, 1)
    blitSnapshot(buffer, rect(0, 0, 4, 1), snapshotOf([[run('éx', { width: 2 })]]))
    expect(buffer.get(0, 0).char).toBe('é')
    expect(buffer.get(1, 0).char).toBe('x')
  })

  it('overwrites a wide character left by a previous frame', () => {
    const buffer = new ScreenBuffer(6, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    blitSnapshot(buffer, rect(0, 0, 6, 1), snapshotOf([[run('abcdef')]]))
    expect(buffer.rowText(0)).toBe('abcdef')
    expect(buffer.get(1, 0).width).toBe(1)
  })

  it('scrolls', () => {
    const buffer = new ScreenBuffer(4, 1)
    blitSnapshot(buffer, rect(0, 0, 4, 1), snapshotOf([[run('one')], [run('two')]]), { scrollY: 1 })
    expect(buffer.rowText(0)).toBe('two')
  })

  it('does nothing for a degenerate area', () => {
    const buffer = new ScreenBuffer(4, 1)
    buffer.writeString(0, 0, 'keep')
    blitSnapshot(buffer, rect(0, 0, 0, 1), snapshotOf([[run('xxxx')]]))
    expect(buffer.rowText(0)).toBe('keep')
  })
})

describe('snapshotCursor', () => {
  it('translates into screen coordinates', () => {
    const snapshot = snapshotOf([[run('abcd')]], { cursor: { x: 2, y: 0, visible: true } })
    expect(snapshotCursor(rect(5, 3, 4, 1), snapshot)).toEqual({ x: 7, y: 3, visible: true })
  })

  it('returns null when the cursor is outside the pane', () => {
    const snapshot = snapshotOf([[run('abcd')]], { cursor: { x: 9, y: 0, visible: true } })
    expect(snapshotCursor(rect(0, 0, 4, 1), snapshot)).toBeNull()
  })

  it('carries the visibility flag through', () => {
    const snapshot = snapshotOf([[run('abcd')]], { cursor: { x: 0, y: 0, visible: false } })
    expect(snapshotCursor(rect(0, 0, 4, 1), snapshot)?.visible).toBe(false)
  })
})
