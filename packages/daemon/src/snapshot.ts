/**
 * Cell-grid snapshots.
 *
 * Phase 2 renders these, so the shape is chosen for a renderer, not for a diff: the
 * visible screen only, run-length encoded by style, with columns counted separately
 * from characters. A run's `width` is authoritative — `text.length` is not, because a
 * double-width character is one char in two columns and a combining mark is several
 * code units in one.
 */

import type xterm from '@xterm/headless'
import {
  ATTR_BLINK,
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  ATTR_INVISIBLE,
  ATTR_ITALIC,
  ATTR_STRIKETHROUGH,
  ATTR_UNDERLINE,
  COLOR_DEFAULT,
  rgbColor,
  type SnapshotBufferKind,
  type SnapshotColor,
  type SnapshotKeyboard,
  type SnapshotRow,
  type SnapshotRun,
  type TerminalSnapshot
} from '@leap-chorus/protocol'

type Terminal = xterm.Terminal
type IBuffer = ReturnType<() => Terminal['buffer']['active']>
type IBufferCell = NonNullable<ReturnType<NonNullable<ReturnType<IBuffer['getLine']>>['getCell']>>

export type SnapshotBufferSelector = 'active' | 'normal' | 'alternate'

export interface CaptureOptions {
  /** Which buffer to read. `active` follows the program into the alternate screen. */
  readonly buffer?: SnapshotBufferSelector
  readonly sequence: number
  readonly title: string | null
  readonly cursorVisible: boolean
  /** What the pane expects its input to look like. See emulator.ts. */
  readonly keyboard?: SnapshotKeyboard
  /**
   * Lines to scroll back before capturing. 0, the default, is live output.
   *
   * Clamped to the scrollback that exists, so a `pane.scroll` past the top shows the
   * top rather than an empty grid.
   */
  readonly scrollOffset?: number
}

function fgOf(cell: IBufferCell): SnapshotColor {
  if (cell.isFgDefault()) return COLOR_DEFAULT
  if (cell.isFgPalette()) return cell.getFgColor()
  if (cell.isFgRGB()) return rgbColor(cell.getFgColor())
  return COLOR_DEFAULT
}

function bgOf(cell: IBufferCell): SnapshotColor {
  if (cell.isBgDefault()) return COLOR_DEFAULT
  if (cell.isBgPalette()) return cell.getBgColor()
  if (cell.isBgRGB()) return rgbColor(cell.getBgColor())
  return COLOR_DEFAULT
}

function attrsOf(cell: IBufferCell): number {
  let attrs = 0
  if (cell.isBold()) attrs |= ATTR_BOLD
  if (cell.isDim()) attrs |= ATTR_DIM
  if (cell.isItalic()) attrs |= ATTR_ITALIC
  if (cell.isUnderline()) attrs |= ATTR_UNDERLINE
  if (cell.isBlink()) attrs |= ATTR_BLINK
  if (cell.isInverse()) attrs |= ATTR_INVERSE
  if (cell.isInvisible()) attrs |= ATTR_INVISIBLE
  if (cell.isStrikethrough()) attrs |= ATTR_STRIKETHROUGH
  return attrs
}

const BLANK_RUN_STYLE = { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 } as const

function captureRow(buffer: IBuffer, lineIndex: number, cols: number, scratch: IBufferCell | undefined): SnapshotRow {
  const line = buffer.getLine(lineIndex)
  if (!line) {
    return { runs: cols > 0 ? [{ text: ' '.repeat(cols), width: cols, ...BLANK_RUN_STYLE }] : [] }
  }

  const runs: SnapshotRun[] = []
  let text = ''
  let width = 0
  let fg = COLOR_DEFAULT
  let bg = COLOR_DEFAULT
  let attrs = 0
  let open = false

  const flush = (): void => {
    if (!open || width === 0) return
    runs.push({ text, width, fg, bg, attrs })
    open = false
    text = ''
    width = 0
  }

  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x, scratch)
    if (!cell) {
      // Past the stored length of the line: the rest is blank default cells.
      if (open && fg === COLOR_DEFAULT && bg === COLOR_DEFAULT && attrs === 0) {
        text += ' '.repeat(cols - x)
        width += cols - x
      } else {
        flush()
        runs.push({ text: ' '.repeat(cols - x), width: cols - x, ...BLANK_RUN_STYLE })
      }
      break
    }

    const cellWidth = cell.getWidth()
    // Width 0 is the placeholder column owned by the preceding wide character; its
    // columns were already counted there, so emitting anything for it would shift the row.
    if (cellWidth === 0) continue

    const cellFg = fgOf(cell)
    const cellBg = bgOf(cell)
    const cellAttrs = attrsOf(cell)
    if (!open || cellFg !== fg || cellBg !== bg || cellAttrs !== attrs) {
      flush()
      fg = cellFg
      bg = cellBg
      attrs = cellAttrs
      open = true
    }
    const chars = cell.getChars()
    text += chars.length === 0 ? ' ' : chars
    width += cellWidth
  }
  flush()

  return { runs }
}

function selectBuffer(term: Terminal, selector: SnapshotBufferSelector): IBuffer {
  switch (selector) {
    case 'normal':
      return term.buffer.normal
    case 'alternate':
      return term.buffer.alternate
    case 'active':
      return term.buffer.active
  }
}

export function captureSnapshot(term: Terminal, options: CaptureOptions): TerminalSnapshot {
  const selector = options.buffer ?? 'active'
  const buffer = selectBuffer(term, selector)
  const cols = term.cols
  const rows = term.rows

  // The screen starts at baseY: lines before it are scrollback, and lines after it do
  // not exist yet. This is the same window the user sees when not scrolled back.
  const requested = Math.max(0, Math.floor(options.scrollOffset ?? 0))
  // The alternate screen has no scrollback; a scroll request there captures the screen.
  const offset = Math.min(requested, buffer.baseY)
  const base = buffer.baseY - offset
  const lines: SnapshotRow[] = []
  // One reusable cell object for the whole grid; xterm's API exists to avoid allocating
  // 10,000 objects per snapshot.
  let scratch: IBufferCell | undefined
  const probe = buffer.getLine(base)?.getCell(0)
  if (probe) scratch = probe

  for (let y = 0; y < rows; y++) {
    lines.push(captureRow(buffer, base + y, cols, scratch))
  }

  const bufferKind: SnapshotBufferKind = buffer.type
  return {
    cols,
    rows,
    buffer: bufferKind,
    cursor: {
      x: Math.min(buffer.cursorX, Math.max(0, cols - 1)),
      // Scrolled back, the cursor is off screen unless the scroll is shallow enough.
      y: Math.min(buffer.cursorY + offset, Math.max(0, rows - 1)),
      visible: options.cursorVisible && buffer.cursorY + offset < rows
    },
    lines,
    scrollbackLines: buffer.baseY,
    scrollOffset: offset,
    ...(options.keyboard === undefined ? {} : { keyboard: options.keyboard }),
    title: options.title,
    sequence: options.sequence
  }
}

/**
 * Every content row as plain text: scrollback first, then the visible screen.
 *
 * This is what `core`'s copy-mode functions read. It reads the buffer directly rather
 * than a snapshot because a selection can reach anywhere in the scrollback, and a
 * snapshot is only ever one screen.
 */
export function bufferTextLines(term: Terminal, selector: SnapshotBufferSelector = 'active'): string[] {
  const buffer = selectBuffer(term, selector)
  const out: string[] = []
  const total = buffer.baseY + term.rows
  for (let y = 0; y < total; y++) {
    const line = buffer.getLine(y)
    // `translateToString(true)` trims the trailing blanks a terminal row is padded with;
    // keeping them would make every column count in a selection wrong by the pad width.
    out.push(line ? line.translateToString(true) : '')
  }
  return out
}

/** Flatten a snapshot to plain text, one line per row. Used by tests. */
export function snapshotToText(snapshot: TerminalSnapshot, options: { trimRight?: boolean } = {}): string {
  const trimRight = options.trimRight ?? true
  const lines = snapshot.lines.map((line) => {
    const text = line.runs.map((run) => run.text).join('')
    return trimRight ? text.replace(/\s+$/u, '') : text
  })
  return lines.join('\n')
}
