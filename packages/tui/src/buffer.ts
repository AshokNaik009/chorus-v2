/**
 * The cell grid.
 *
 * Storage is parallel typed arrays, not `Cell[]`. The render loop touches every cell of
 * every frame twice (compose, then diff); an object per cell would mean 150,000
 * allocations per frame at 15 panes of 200x50, and the GC pauses would show up as p99
 * frame time. `get()` writes into a caller-supplied `Cell` so a loop can reuse one.
 *
 * Wide characters occupy two columns: the leading cell carries `width === 2` and the
 * character, the trailing cell carries `width === 0` and an empty string. Every writer
 * here maintains that pairing, and `setCell` cleans up the wreckage when a write lands on
 * half of an existing pair.
 */

import { COLOR_DEFAULT, type Cell, type Color, type Style, DEFAULT_STYLE } from './cell.js'
import { clusterWidth, graphemes, isPlainAscii } from './width.js'
import { intersection, type Rect } from './rect.js'

const BLANK = ' '

export class ScreenBuffer {
  cols: number
  rows: number
  /** One entry per cell. `''` marks the trailing half of a wide character. */
  chars: string[]
  fg: Int32Array
  bg: Int32Array
  attrs: Uint16Array
  /** 1 ordinary, 2 leading half of a wide char, 0 trailing half. */
  widths: Uint8Array

  constructor(cols: number, rows: number) {
    this.cols = Math.max(0, Math.floor(cols))
    this.rows = Math.max(0, Math.floor(rows))
    const size = this.cols * this.rows
    this.chars = new Array<string>(size).fill(BLANK)
    this.fg = new Int32Array(size).fill(COLOR_DEFAULT)
    this.bg = new Int32Array(size).fill(COLOR_DEFAULT)
    this.attrs = new Uint16Array(size)
    this.widths = new Uint8Array(size).fill(1)
  }

  get size(): number {
    return this.cols * this.rows
  }

  get rect(): Rect {
    return { x: 0, y: 0, width: this.cols, height: this.rows }
  }

  index(x: number, y: number): number {
    return y * this.cols + x
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows
  }

  /** Read a cell into `out` (reused across a loop) or into a fresh object. */
  get(x: number, y: number, out?: Cell): Cell {
    const cell = out ?? { char: BLANK, width: 1, fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 }
    if (!this.inBounds(x, y)) {
      cell.char = BLANK
      cell.width = 1
      cell.fg = COLOR_DEFAULT
      cell.bg = COLOR_DEFAULT
      cell.attrs = 0
      return cell
    }
    const i = this.index(x, y)
    cell.char = this.chars[i] as string
    cell.width = this.widths[i] as number
    cell.fg = this.fg[i] as number
    cell.bg = this.bg[i] as number
    cell.attrs = this.attrs[i] as number
    return cell
  }

  set(x: number, y: number, cell: Cell): void {
    this.setCell(x, y, cell.char, cell.width, cell.fg, cell.bg, cell.attrs)
  }

  /**
   * Write one cell, repairing any wide pair the write lands on.
   *
   * Overwriting the leading half of a wide character leaves its trailing half orphaned,
   * and vice versa; an orphan would render as a hole that never gets repainted because
   * both buffers agree it is empty. Both cases are patched to a blank here.
   */
  setCell(x: number, y: number, char: string, width: number, fg: Color, bg: Color, attrs: number): void {
    if (!this.inBounds(x, y)) return
    const i = this.index(x, y)

    // Landing on a trailing half: blank the leading half to its left.
    if (this.widths[i] === 0 && x > 0) {
      const left = i - 1
      if (this.widths[left] === 2) {
        this.chars[left] = BLANK
        this.widths[left] = 1
      }
    }
    // Overwriting a leading half: blank the trailing half to its right.
    if (this.widths[i] === 2 && x + 1 < this.cols) {
      const rightIndex = i + 1
      if (this.widths[rightIndex] === 0) {
        this.chars[rightIndex] = BLANK
        this.widths[rightIndex] = 1
        this.fg[rightIndex] = fg
        this.bg[rightIndex] = bg
        this.attrs[rightIndex] = attrs
      }
    }

    if (width === 2) {
      // A wide character at the last column has nowhere to put its trailing half.
      if (x + 1 >= this.cols) {
        this.chars[i] = BLANK
        this.widths[i] = 1
        this.fg[i] = fg
        this.bg[i] = bg
        this.attrs[i] = attrs
        return
      }
      const rightIndex = i + 1
      // Clear whatever the trailing column used to own before claiming it.
      if (this.widths[rightIndex] === 2 && x + 2 < this.cols && this.widths[rightIndex + 1] === 0) {
        this.chars[rightIndex + 1] = BLANK
        this.widths[rightIndex + 1] = 1
      }
      this.chars[rightIndex] = ''
      this.widths[rightIndex] = 0
      this.fg[rightIndex] = fg
      this.bg[rightIndex] = bg
      this.attrs[rightIndex] = attrs
    }

    this.chars[i] = char
    this.widths[i] = width
    this.fg[i] = fg
    this.bg[i] = bg
    this.attrs[i] = attrs
  }

  /** Style a cell without touching its character. Used for selection and focus tinting. */
  setStyle(x: number, y: number, s: Style): void {
    if (!this.inBounds(x, y)) return
    const i = this.index(x, y)
    this.fg[i] = s.fg
    this.bg[i] = s.bg
    this.attrs[i] = s.attrs
  }

  fill(target: Rect, char: string = BLANK, s: Style = DEFAULT_STYLE): void {
    const clipped = intersection(target, this.rect)
    if (clipped.width === 0 || clipped.height === 0) return
    const width = char.length === 0 ? 1 : clusterWidth(char) || 1
    for (let y = clipped.y; y < clipped.y + clipped.height; y++) {
      for (let x = clipped.x; x < clipped.x + clipped.width; x += width) {
        this.setCell(x, y, char, width, s.fg, s.bg, s.attrs)
      }
    }
  }

  clear(s: Style = DEFAULT_STYLE): void {
    this.chars.fill(BLANK)
    this.widths.fill(1)
    this.fg.fill(s.fg)
    this.bg.fill(s.bg)
    this.attrs.fill(s.attrs)
  }

  /**
   * Write text starting at (x, y), clipped to `maxX` (exclusive). Returns the column just
   * past the last one written, so a caller can chain spans without re-measuring.
   */
  writeString(x: number, y: number, text: string, s: Style = DEFAULT_STYLE, maxX: number = this.cols): number {
    if (y < 0 || y >= this.rows) return x
    const limit = Math.min(maxX, this.cols)
    let cursor = x

    // Fast path: printable ASCII is one column per char, so no segmentation is needed.
    if (isPlainAscii(text)) {
      for (let i = 0; i < text.length && cursor < limit; i++) {
        this.setCell(cursor, y, text[i] as string, 1, s.fg, s.bg, s.attrs)
        cursor++
      }
      return cursor
    }

    for (const cluster of graphemes(text)) {
      const width = clusterWidth(cluster)
      if (width === 0) {
        // A combining mark belongs to the cell already written to its left.
        if (cursor > x && cursor - 1 < limit) {
          const i = this.index(cursor - 1, y)
          if (this.widths[i] !== 0) this.chars[i] = (this.chars[i] as string) + cluster
        }
        continue
      }
      if (cursor + width > limit) break
      this.setCell(cursor, y, cluster, width, s.fg, s.bg, s.attrs)
      cursor += width
    }
    return cursor
  }

  /**
   * Resize in place, preserving the overlapping top-left region.
   *
   * Content is kept because a SIGWINCH repaint reuses the previous frame as its diff
   * baseline; throwing it away would be correct but would force a full repaint on every
   * resize step, which is exactly the flicker resizing is supposed to avoid.
   */
  resize(cols: number, rows: number): void {
    const nextCols = Math.max(0, Math.floor(cols))
    const nextRows = Math.max(0, Math.floor(rows))
    if (nextCols === this.cols && nextRows === this.rows) return

    const size = nextCols * nextRows
    const chars = new Array<string>(size).fill(BLANK)
    const fg = new Int32Array(size).fill(COLOR_DEFAULT)
    const bg = new Int32Array(size).fill(COLOR_DEFAULT)
    const attrs = new Uint16Array(size)
    const widths = new Uint8Array(size).fill(1)

    const copyCols = Math.min(nextCols, this.cols)
    const copyRows = Math.min(nextRows, this.rows)
    for (let y = 0; y < copyRows; y++) {
      const from = y * this.cols
      const to = y * nextCols
      for (let x = 0; x < copyCols; x++) {
        chars[to + x] = this.chars[from + x] as string
        fg[to + x] = this.fg[from + x] as number
        bg[to + x] = this.bg[from + x] as number
        attrs[to + x] = this.attrs[from + x] as number
        widths[to + x] = this.widths[from + x] as number
      }
      // A wide character straddling the new right edge loses its trailing half.
      if (copyCols > 0 && widths[to + copyCols - 1] === 2) {
        chars[to + copyCols - 1] = BLANK
        widths[to + copyCols - 1] = 1
      }
    }

    this.cols = nextCols
    this.rows = nextRows
    this.chars = chars
    this.fg = fg
    this.bg = bg
    this.attrs = attrs
    this.widths = widths
  }

  /** Copy every cell of `other` into this buffer. Both must have the same dimensions. */
  copyFrom(other: ScreenBuffer): void {
    if (other.cols !== this.cols || other.rows !== this.rows) {
      this.cols = other.cols
      this.rows = other.rows
      this.chars = new Array<string>(other.size)
      this.fg = new Int32Array(other.size)
      this.bg = new Int32Array(other.size)
      this.attrs = new Uint16Array(other.size)
      this.widths = new Uint8Array(other.size)
    }
    for (let i = 0; i < other.chars.length; i++) this.chars[i] = other.chars[i] as string
    this.fg.set(other.fg)
    this.bg.set(other.bg)
    this.attrs.set(other.attrs)
    this.widths.set(other.widths)
  }

  /** One row as plain text. Tests and the pty-driven render checks read frames with this. */
  rowText(y: number, options: { trimRight?: boolean } = {}): string {
    if (y < 0 || y >= this.rows) return ''
    let text = ''
    for (let x = 0; x < this.cols; x++) {
      const i = this.index(x, y)
      if (this.widths[i] === 0) continue
      const char = this.chars[i] as string
      text += char.length === 0 ? BLANK : char
    }
    return options.trimRight === false ? text : text.replace(/\s+$/u, '')
  }

  toText(options: { trimRight?: boolean } = {}): string {
    const lines: string[] = []
    for (let y = 0; y < this.rows; y++) lines.push(this.rowText(y, options))
    return lines.join('\n')
  }
}
