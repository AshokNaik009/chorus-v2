/**
 * Cell runs to bytes.
 *
 * Two state machines run side by side while encoding a frame: where the terminal's cursor
 * is, and what SGR state it is in. Both exist to *not* emit bytes — a repaint that
 * re-states the cursor position and the full style for every run is correct and roughly
 * four times the size.
 *
 * Attribute removal is the one place this gives up and resets. There is no single escape
 * that clears "bold" without also clearing "dim" (both are SGR 22), so when a run needs
 * fewer attributes than the last one, the encoder emits `SGR 0` and re-states. Adding
 * attributes stays incremental, which is the common direction inside a line.
 */

import type { ScreenBuffer } from './buffer.js'
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
  COLOR_RGB_FLAG,
  type Color,
  type Style
} from './cell.js'
import type { DiffSpan } from './diff.js'

export const CSI = '\x1b['

export const SHOW_CURSOR = `${CSI}?25h`
export const HIDE_CURSOR = `${CSI}?25l`
export const ENTER_ALT_SCREEN = `${CSI}?1049h`
export const LEAVE_ALT_SCREEN = `${CSI}?1049l`
export const RESET_SGR = `${CSI}0m`
export const CLEAR_SCREEN = `${CSI}2J`
/** DEC private mode 2026: synchronized output. Only ever emitted after a DECRQM probe. */
export const BEGIN_SYNC = `${CSI}?2026h`
export const END_SYNC = `${CSI}?2026l`

/** `CSI row ; col H`, 1-based. */
export function cursorTo(x: number, y: number): string {
  return `${CSI}${y + 1};${x + 1}H`
}

const ATTR_CODES: ReadonlyArray<readonly [number, number]> = [
  [ATTR_BOLD, 1],
  [ATTR_DIM, 2],
  [ATTR_ITALIC, 3],
  [ATTR_UNDERLINE, 4],
  [ATTR_BLINK, 5],
  [ATTR_INVERSE, 7],
  [ATTR_INVISIBLE, 8],
  [ATTR_STRIKETHROUGH, 9]
]

function pushColor(out: number[], color: Color, foreground: boolean): void {
  if (color === COLOR_DEFAULT) {
    out.push(foreground ? 39 : 49)
    return
  }
  if (color >= COLOR_RGB_FLAG) {
    const rgb = color & 0xffffff
    out.push(foreground ? 38 : 48, 2, (rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff)
    return
  }
  if (color < 8) {
    out.push((foreground ? 30 : 40) + color)
    return
  }
  if (color < 16) {
    out.push((foreground ? 90 : 100) + (color - 8))
    return
  }
  out.push(foreground ? 38 : 48, 5, color)
}

/**
 * The shortest SGR that moves the terminal from `from` to `to`.
 *
 * `from === null` means the state is unknown, which is the frame-start case: everything
 * is stated, preceded by a reset.
 */
export function sgrSequence(from: Style | null, to: Style): string {
  if (from !== null && from.fg === to.fg && from.bg === to.bg && from.attrs === to.attrs) return ''

  const codes: number[] = []
  const removing = from === null || (from.attrs & ~to.attrs) !== 0

  if (removing) {
    codes.push(0)
    for (const [flag, code] of ATTR_CODES) if ((to.attrs & flag) !== 0) codes.push(code)
    if (to.fg !== COLOR_DEFAULT) pushColor(codes, to.fg, true)
    if (to.bg !== COLOR_DEFAULT) pushColor(codes, to.bg, false)
    return `${CSI}${codes.join(';')}m`
  }

  const added = to.attrs & ~from.attrs
  for (const [flag, code] of ATTR_CODES) if ((added & flag) !== 0) codes.push(code)
  if (from.fg !== to.fg) pushColor(codes, to.fg, true)
  if (from.bg !== to.bg) pushColor(codes, to.bg, false)
  if (codes.length === 0) return ''
  return `${CSI}${codes.join(';')}m`
}

export interface FrameCursor {
  readonly x: number
  readonly y: number
  readonly visible: boolean
}

export interface EncodeOptions {
  /** Wrap the frame in DEC 2026. Only pass true when a DECRQM probe said yes. */
  readonly synchronizedOutput?: boolean
  /** Where to leave the cursor, and whether to show it. */
  readonly cursor?: FrameCursor | null
  /** Suppress the cursor-hide/show bracket; the benchmark measures payload without it. */
  readonly manageCursorVisibility?: boolean
}

/**
 * Encode the given spans of `buffer` as the bytes to write to a terminal.
 *
 * The cursor is hidden for the duration: without that, a repaint drags a visible cursor
 * across the screen, which on a slow link looks exactly like corruption.
 */
export function encodeFrame(
  buffer: ScreenBuffer,
  spans: readonly DiffSpan[],
  options: EncodeOptions = {}
): string {
  const manageCursor = options.manageCursorVisibility ?? true
  const parts: string[] = []
  if (options.synchronizedOutput === true) parts.push(BEGIN_SYNC)
  if (manageCursor) parts.push(HIDE_CURSOR)

  let style: Style | null = null
  // Cursor column after the last write, or -1 when the position is not known.
  let cursorX = -1
  let cursorY = -1

  for (const span of spans) {
    const { y } = span
    if (y < 0 || y >= buffer.rows) continue
    let x = Math.max(0, span.x)
    const end = Math.min(span.end, buffer.cols)
    if (x >= end) continue

    // A span may open on a continuation cell when a caller built it by hand; back up
    // onto the wide character that owns the column rather than printing its trailing half.
    const firstIndex = y * buffer.cols + x
    if (buffer.widths[firstIndex] === 0 && x > 0) x -= 1

    if (cursorY !== y || cursorX !== x) {
      // Same row and a short forward hop: CUF is shorter than a full CUP.
      if (cursorY === y && cursorX >= 0 && x > cursorX && x - cursorX <= 3) {
        parts.push(`${CSI}${x - cursorX}C`)
      } else {
        parts.push(cursorTo(x, y))
      }
      cursorX = x
      cursorY = y
    }

    let text = ''
    for (let column = x; column < end; ) {
      const i = y * buffer.cols + column
      const width = buffer.widths[i] as number
      if (width === 0) {
        // Owned by the cell to the left, which already emitted the glyph.
        column += 1
        continue
      }
      const next: Style = {
        fg: buffer.fg[i] as number,
        bg: buffer.bg[i] as number,
        attrs: buffer.attrs[i] as number
      }
      const sgr = sgrSequence(style, next)
      if (sgr.length > 0) {
        if (text.length > 0) {
          parts.push(text)
          text = ''
        }
        parts.push(sgr)
        style = next
      }
      const char = buffer.chars[i] as string
      text += char.length === 0 ? ' ' : char
      column += width === 2 ? 2 : 1
    }
    if (text.length > 0) parts.push(text)

    cursorX = end
    // Writing through the last column leaves the cursor somewhere autowrap-dependent.
    // Rather than depend on DECAWM, forget the position and re-state it next time.
    if (end >= buffer.cols) {
      cursorX = -1
      cursorY = -1
    }
  }

  const cursor = options.cursor
  if (cursor) {
    parts.push(cursorTo(cursor.x, cursor.y))
    if (manageCursor && cursor.visible) parts.push(SHOW_CURSOR)
  } else if (manageCursor) {
    parts.push(SHOW_CURSOR)
  }
  if (options.synchronizedOutput === true) parts.push(END_SYNC)
  return parts.join('')
}
