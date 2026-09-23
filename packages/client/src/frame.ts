/**
 * Snapshot -> cell buffer.
 *
 * 
 * 
 * This is the hot loop of the whole client: it runs once per visible pane per frame, so
 * 15 panes of 200x50 is 150,000 cells of work inside a 16 ms budget. Two things keep it
 * inside that budget:
 *
 * - The ASCII fast path. A run whose `width` equals its `text.length` is single-width
 *   throughout, so it is written character by character with no segmentation and no
 *   per-character width lookup. On a real screen this is very nearly every run.
 * - No intermediate objects. Cells go straight into the buffer's typed arrays; nothing
 *   allocates per cell, per run, or per row.
 *
 * The slow path segments into grapheme clusters, because a run's `width` is the total for
 * the run and says nothing about where inside it the double-width characters are.
 */

import type { SnapshotRun, TerminalSnapshot } from '@leap-chorus/protocol'
import { clusterWidth, graphemes, isPlainAscii, type ScreenBuffer, type Rect, type Style } from '@leap-chorus/tui'

export interface BlitOptions {
  /** Rows of the snapshot to skip; the start of a scrolled view. */
  readonly scrollY?: number
  /** Painted where the snapshot has no content, e.g. a pane taller than its session. */
  readonly padStyle?: Style
}

/**
 * Draw a snapshot into `area`.
 *
 * The snapshot and the area routinely disagree on size for a frame or two: a resize
 * reaches the daemon asynchronously, so the client keeps rendering the old geometry until
 * the new snapshot lands. Everything here clips rather than assuming they match.
 */
export function blitSnapshot(
  buffer: ScreenBuffer,
  area: Rect,
  snapshot: TerminalSnapshot,
  options: BlitOptions = {}
): void {
  if (area.width <= 0 || area.height <= 0) return

  const scrollY = options.scrollY ?? 0
  const maxX = Math.min(area.x + area.width, buffer.cols)
  const maxY = Math.min(area.y + area.height, buffer.rows)

  for (let row = 0; row < area.height; row++) {
    const y = area.y + row
    if (y < 0) continue
    if (y >= maxY) break

    const snapshotRow = snapshot.lines[row + scrollY]
    if (!snapshotRow) {
      // Beyond the session's screen: blank, so stale content from a larger previous
      // layout does not survive under the new one.
      for (let x = area.x; x < maxX; x++) buffer.setCell(x, y, ' ', 1, -1, -1, 0)
      continue
    }

    let x = area.x
    for (let r = 0; r < snapshotRow.runs.length && x < maxX; r++) {
      x = writeRun(buffer, x, y, snapshotRow.runs[r] as SnapshotRun, maxX)
    }
    // The snapshot is narrower than the pane; blank the remainder.
    for (; x < maxX; x++) buffer.setCell(x, y, ' ', 1, -1, -1, 0)
  }
}

function writeRun(buffer: ScreenBuffer, startX: number, y: number, run: SnapshotRun, maxX: number): number {
  const { text, fg, bg, attrs } = run
  let x = startX

  // Single-width throughout: one character is one column, no segmentation needed.
  if (run.width === text.length && isPlainAscii(text)) {
    const rowBase = y * buffer.cols
    for (let i = 0; i < text.length; i++) {
      if (x >= maxX) break
      const cellIndex = rowBase + x
      // Inline rather than setCell: this is the innermost loop of the render path, and
      // the wide-pair repair setCell does cannot apply to a single-width ASCII write
      // unless it lands on half of an existing pair — handled explicitly below.
      if (buffer.widths[cellIndex] !== 1) {
        buffer.setCell(x, y, text[i] as string, 1, fg, bg, attrs)
      } else {
        buffer.chars[cellIndex] = text[i] as string
        buffer.fg[cellIndex] = fg
        buffer.bg[cellIndex] = bg
        buffer.attrs[cellIndex] = attrs
      }
      x++
    }
    return x
  }

  for (const cluster of graphemes(text)) {
    if (x >= maxX) break
    const width = clusterWidth(cluster)
    if (width === 0) {
      // A combining mark joins the cell already written to its left.
      if (x > startX) {
        const i = y * buffer.cols + (x - 1)
        if (buffer.widths[i] !== 0) buffer.chars[i] = (buffer.chars[i] as string) + cluster
      }
      continue
    }
    if (width === 2 && x + 1 >= maxX) {
      // A wide character with only one column left: blank it rather than split it.
      buffer.setCell(x, y, ' ', 1, fg, bg, attrs)
      x += 1
      continue
    }
    buffer.setCell(x, y, cluster, width, fg, bg, attrs)
    x += width
  }
  return x
}

/** Where a pane's cursor lands in screen coordinates, or null when it is off the pane. */
export function snapshotCursor(
  area: Rect,
  snapshot: TerminalSnapshot,
  options: { readonly scrollY?: number } = {}
): { x: number; y: number; visible: boolean } | null {
  const scrollY = options.scrollY ?? 0
  const x = area.x + snapshot.cursor.x
  const y = area.y + snapshot.cursor.y - scrollY
  if (x < area.x || x >= area.x + area.width) return null
  if (y < area.y || y >= area.y + area.height) return null
  return { x, y, visible: snapshot.cursor.visible }
}
