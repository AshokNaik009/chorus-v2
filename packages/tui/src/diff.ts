/**
 * Previous frame vs next frame, as the minimal set of cell runs to repaint.
 *
 * A span is a half-open `[x, end)` range on one row. Spans do not carry cell data: the
 * encoder reads it straight out of `next`, so a frame's worth of changes costs one small
 * object per changed run instead of one per changed cell.
 *
 * Two rules keep the output correct rather than merely small:
 *
 * - A span never starts on a continuation cell. Repainting the trailing half of a wide
 *   character without its leading half writes the wrong glyph, so a span that would start
 *   there is extended left onto its owner.
 * - Runs separated by fewer than JOIN_GAP unchanged cells are merged. Emitting a cursor
 *   move costs ~6 bytes; repainting three unchanged cells costs three. Splitting on every
 *   single-cell gap makes the output larger, not smaller.
 */

import type { ScreenBuffer } from './buffer.js'

/** A half-open run of columns on one row that needs repainting. */
export interface DiffSpan {
  readonly y: number
  readonly x: number
  /** Exclusive. */
  readonly end: number
}

/**
 * Unchanged cells tolerated inside one span before it is worth splitting.
 *
 * A cursor-move escape is `CSI row;col H` — 6 to 10 bytes. Repainting an unchanged cell
 * is 1 byte plus whatever SGR it needs. 4 is the break-even point with a little slack in
 * favour of fewer, longer writes, which are also fewer syscalls.
 */
export const JOIN_GAP = 4

function cellDiffers(prev: ScreenBuffer, next: ScreenBuffer, i: number): boolean {
  return (
    prev.chars[i] !== next.chars[i] ||
    prev.widths[i] !== next.widths[i] ||
    prev.fg[i] !== next.fg[i] ||
    prev.bg[i] !== next.bg[i] ||
    prev.attrs[i] !== next.attrs[i]
  )
}

/**
 * Spans to repaint so that the terminal showing `prev` shows `next`.
 *
 * A `null` prev, or a size change, means nothing on screen can be trusted: the result is
 * a full repaint.
 */
export function diffBuffers(prev: ScreenBuffer | null, next: ScreenBuffer): DiffSpan[] {
  if (prev === null || prev.cols !== next.cols || prev.rows !== next.rows) return fullSpans(next)

  const spans: DiffSpan[] = []
  const cols = next.cols

  for (let y = 0; y < next.rows; y++) {
    const rowStart = y * cols
    let spanStart = -1
    let spanEnd = -1

    for (let x = 0; x < cols; x++) {
      const i = rowStart + x
      if (!cellDiffers(prev, next, i)) continue

      // Never begin on the trailing half of a wide character: its glyph lives one cell left.
      let start = x
      if (next.widths[i] === 0 && x > 0) start = x - 1
      // A changed leading half drags its trailing half along.
      let end = x + 1
      if (next.widths[i] === 2 && x + 1 < cols) end = x + 2

      if (spanStart < 0) {
        spanStart = start
        spanEnd = end
      } else if (start - spanEnd <= JOIN_GAP) {
        spanEnd = Math.max(spanEnd, end)
      } else {
        spans.push({ y, x: spanStart, end: spanEnd })
        spanStart = start
        spanEnd = end
      }
    }
    if (spanStart >= 0) spans.push({ y, x: spanStart, end: spanEnd })
  }
  return spans
}

/** Every cell of every row: the baseline a diff has to beat. */
export function fullSpans(buffer: ScreenBuffer): DiffSpan[] {
  if (buffer.cols === 0) return []
  const spans: DiffSpan[] = []
  for (let y = 0; y < buffer.rows; y++) spans.push({ y, x: 0, end: buffer.cols })
  return spans
}

/** Total cells covered by a span list. Used by tests and the benchmark. */
export function spanCells(spans: readonly DiffSpan[]): number {
  let total = 0
  for (const s of spans) total += s.end - s.x
  return total
}
