/**
 * What one terminal cell holds, and the style that decorates it.
 *
 * `Cell` is the API shape; it is *not* how `Buffer` stores a grid. A 200x50 screen is
 * 10,000 cells and 15 panes of it is 150,000 — allocating an object per cell per frame
 * is how a render loop loses its 16 ms. Buffer keeps parallel typed arrays and hands out
 * `Cell` views on request, which is the same bargain xterm makes with `getNullCell()`.
 */

import { ATTR_BOLD, ATTR_DIM, ATTR_INVERSE, ATTR_ITALIC, ATTR_UNDERLINE, COLOR_DEFAULT } from '@leap-chorus/protocol'

export {
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
  isRgbColor,
  rgbColor
} from '@leap-chorus/protocol'

/** A packed color: -1 default, 0..255 palette, 0x1000000|rgb truecolor. See protocol. */
export type Color = number

export interface Style {
  readonly fg: Color
  readonly bg: Color
  readonly attrs: number
}

export const DEFAULT_STYLE: Style = { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 }

export function style(partial: Partial<Style> = {}): Style {
  return {
    fg: partial.fg ?? COLOR_DEFAULT,
    bg: partial.bg ?? COLOR_DEFAULT,
    attrs: partial.attrs ?? 0
  }
}

export function bold(base: Style = DEFAULT_STYLE): Style {
  return { ...base, attrs: base.attrs | ATTR_BOLD }
}

export function dim(base: Style = DEFAULT_STYLE): Style {
  return { ...base, attrs: base.attrs | ATTR_DIM }
}

export function italic(base: Style = DEFAULT_STYLE): Style {
  return { ...base, attrs: base.attrs | ATTR_ITALIC }
}

export function underline(base: Style = DEFAULT_STYLE): Style {
  return { ...base, attrs: base.attrs | ATTR_UNDERLINE }
}

export function inverse(base: Style = DEFAULT_STYLE): Style {
  return { ...base, attrs: base.attrs | ATTR_INVERSE }
}

export function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs
}

/**
 * One cell of the grid.
 *
 * `width` is 1 for an ordinary cell, 2 for the leading half of a double-width character,
 * and **0 for the trailing half** — a continuation cell, whose column belongs to the
 * character on its left. A continuation cell's `char` is always `''`; writing to it
 * directly corrupts the row, so go through `Buffer.setCell`.
 */
export interface Cell {
  char: string
  width: number
  fg: Color
  bg: Color
  attrs: number
}

export function emptyCell(): Cell {
  return { char: ' ', width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 }
}

export function cellEquals(a: Cell, b: Cell): boolean {
  return a.char === b.char && a.width === b.width && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs
}

export function styleOf(cell: Cell): Style {
  return { fg: cell.fg, bg: cell.bg, attrs: cell.attrs }
}
