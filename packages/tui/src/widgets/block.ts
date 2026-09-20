/**
 * A bordered box with an optional title. The chrome every pane is drawn inside.
 *
 * Returns the inner rect so a caller composes rather than measures: `renderBlock` decides
 * how many columns the border cost, and the content is drawn into what comes back.
 */

import type { ScreenBuffer } from '../buffer.js'
import { DEFAULT_STYLE, type Style } from '../cell.js'
import { intersection, type Rect } from '../rect.js'
import { stringWidth } from '../width.js'

export const BORDER_NONE = 0
export const BORDER_TOP = 1 << 0
export const BORDER_RIGHT = 1 << 1
export const BORDER_BOTTOM = 1 << 2
export const BORDER_LEFT = 1 << 3
export const BORDER_ALL = BORDER_TOP | BORDER_RIGHT | BORDER_BOTTOM | BORDER_LEFT

export interface BorderChars {
  readonly horizontal: string
  readonly vertical: string
  readonly topLeft: string
  readonly topRight: string
  readonly bottomLeft: string
  readonly bottomRight: string
}

export const PLAIN_BORDER: BorderChars = {
  horizontal: '─',
  vertical: '│',
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘'
}

export const HEAVY_BORDER: BorderChars = {
  horizontal: '━',
  vertical: '┃',
  topLeft: '┏',
  topRight: '┓',
  bottomLeft: '┗',
  bottomRight: '┛'
}

export const ASCII_BORDER: BorderChars = {
  horizontal: '-',
  vertical: '|',
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+'
}

export interface BlockOptions {
  readonly borders?: number
  readonly chars?: BorderChars
  readonly borderStyle?: Style
  readonly title?: string
  readonly titleStyle?: Style
  /** Drawn at the right end of the top border, after the title. */
  readonly rightTitle?: string
  readonly rightTitleStyle?: Style
}

/** Draw the block and return the content rect inside it. */
export function renderBlock(buffer: ScreenBuffer, area: Rect, options: BlockOptions = {}): Rect {
  const clipped = intersection(area, buffer.rect)
  if (clipped.width === 0 || clipped.height === 0) return clipped

  const borders = options.borders ?? BORDER_ALL
  const chars = options.chars ?? PLAIN_BORDER
  const bs = options.borderStyle ?? DEFAULT_STYLE

  const top = (borders & BORDER_TOP) !== 0
  const bottomEdge = (borders & BORDER_BOTTOM) !== 0
  const left = (borders & BORDER_LEFT) !== 0
  const rightEdge = (borders & BORDER_RIGHT) !== 0

  const x0 = clipped.x
  const y0 = clipped.y
  const x1 = clipped.x + clipped.width - 1
  const y1 = clipped.y + clipped.height - 1

  if (top) for (let x = x0; x <= x1; x++) buffer.setCell(x, y0, chars.horizontal, 1, bs.fg, bs.bg, bs.attrs)
  if (bottomEdge && y1 !== y0) {
    for (let x = x0; x <= x1; x++) buffer.setCell(x, y1, chars.horizontal, 1, bs.fg, bs.bg, bs.attrs)
  }
  if (left) for (let y = y0; y <= y1; y++) buffer.setCell(x0, y, chars.vertical, 1, bs.fg, bs.bg, bs.attrs)
  if (rightEdge && x1 !== x0) {
    for (let y = y0; y <= y1; y++) buffer.setCell(x1, y, chars.vertical, 1, bs.fg, bs.bg, bs.attrs)
  }

  if (top && left) buffer.setCell(x0, y0, chars.topLeft, 1, bs.fg, bs.bg, bs.attrs)
  if (top && rightEdge) buffer.setCell(x1, y0, chars.topRight, 1, bs.fg, bs.bg, bs.attrs)
  if (bottomEdge && left) buffer.setCell(x0, y1, chars.bottomLeft, 1, bs.fg, bs.bg, bs.attrs)
  if (bottomEdge && rightEdge) buffer.setCell(x1, y1, chars.bottomRight, 1, bs.fg, bs.bg, bs.attrs)

  const inner: Rect = {
    x: x0 + (left ? 1 : 0),
    y: y0 + (top ? 1 : 0),
    width: Math.max(0, clipped.width - (left ? 1 : 0) - (rightEdge ? 1 : 0)),
    height: Math.max(0, clipped.height - (top ? 1 : 0) - (bottomEdge ? 1 : 0))
  }

  if (top && clipped.width > 2) {
    // Titles live on the top border, inset one column from each corner. The right title
    // is placed first so a long left title is the one that gets truncated.
    const titleLeft = x0 + (left ? 1 : 0) + 1
    let titleRight = x1 - (rightEdge ? 1 : 0)

    if (options.rightTitle !== undefined && options.rightTitle.length > 0) {
      const text = options.rightTitle
      const width = stringWidth(text)
      const start = titleRight - width
      if (start > titleLeft) {
        buffer.writeString(start, y0, text, options.rightTitleStyle ?? bs, titleRight + 1)
        titleRight = start - 1
      }
    }

    if (options.title !== undefined && options.title.length > 0) {
      const available = titleRight - titleLeft
      if (available > 0) {
        buffer.writeString(titleLeft, y0, truncate(options.title, available), options.titleStyle ?? bs, titleLeft + available)
      }
    }
  }

  return inner
}

/** Cut a title to fit, marking the cut with an ellipsis rather than ending mid-word. */
export function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return '…'
  let out = ''
  let width = 0
  for (const char of text) {
    const charWidth = stringWidth(char)
    if (width + charWidth > maxWidth - 1) break
    out += char
    width += charWidth
  }
  return `${out}…`
}
