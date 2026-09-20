/**
 * A text prompt, as a dialog.
 *
 * This replaces the status-line version. The status line was the right call for the
 * mechanism — a one-line answer needs one line — and the wrong call for *discovery*:
 * a caret appearing at the bottom of a 30-row screen is easy to miss, and nothing
 * about it says what Escape would do. A box in the middle with its buttons written on
 * it answers both questions without being asked.
 *
 * Three controls, following herdr: save, clear, cancel. `clear` earns its place
 * because emptying the field is how you get the *default* name back, and selecting
 * all of a line with no selection support is otherwise a row of backspaces.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { Palette } from './chrome.js'

export type PromptOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'saved'; readonly value: string }

export class PromptDialog {
  value: string

  constructor(
    readonly title: string,
    initial: string
  ) {
    this.value = initial
  }

  handleKey(name: string, char: string | undefined, ctrl: boolean): PromptOutcome {
    if (name === 'escape') return { kind: 'cancelled' }
    if (name === 'enter') return { kind: 'saved', value: this.value.trim() }
    // ^C clears rather than cancelling: cancel already has a key, and "start this name
    // over" has no other gesture in a field with no selection.
    if (ctrl && (char === 'c' || name === 'c')) {
      this.value = ''
      return { kind: 'pending' }
    }
    if (name === 'backspace') {
      this.value = this.value.slice(0, -1)
      return { kind: 'pending' }
    }
    if (ctrl) return { kind: 'pending' }
    if (char !== undefined && char.length > 0) this.value += char
    return { kind: 'pending' }
  }

  handleClick(column: number, row: number, area: Rect): PromptOutcome {
    const buttons = buttonSpans(area)
    if (row !== buttons.row) return { kind: 'pending' }
    if (column >= buttons.save.x && column < buttons.save.end) return { kind: 'saved', value: this.value.trim() }
    if (column >= buttons.clear.x && column < buttons.clear.end) {
      this.value = ''
      return { kind: 'pending' }
    }
    if (column >= buttons.cancel.x && column < buttons.cancel.end) return { kind: 'cancelled' }
    return { kind: 'pending' }
  }

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    buffer.fill(area, ' ', palette.sidebar)
    const width = area.width - 2
    buffer.writeString(area.x + 1, area.y + 1, truncate(this.title, width), palette.paneTitle, area.x + area.width)

    // The field is a filled row, so it reads as somewhere you type rather than as a
    // line of text that happens to be there.
    const field = ` ${this.value}█`
    buffer.writeString(area.x + 1, area.y + 3, truncate(field, width).padEnd(width, ' '), palette.tabIdle, area.x + area.width)

    const buttons = buttonSpans(area)
    buffer.writeString(buttons.save.x, buttons.row, SAVE, palette.sidebarActive, area.x + area.width)
    buffer.writeString(buttons.clear.x, buttons.row, CLEAR, palette.tabIdle, area.x + area.width)
    buffer.writeString(buttons.cancel.x, buttons.row, CANCEL, palette.tabIdle, area.x + area.width)
  }
}

const SAVE = ' ↵ save '
const CLEAR = ' ^c clear '
const CANCEL = ' esc cancel '

function buttonSpans(area: Rect): {
  row: number
  save: { x: number; end: number }
  clear: { x: number; end: number }
  cancel: { x: number; end: number }
} {
  const row = area.y + 4
  const x = area.x + 2
  const save = { x, end: x + SAVE.length }
  const clear = { x: save.end + 1, end: save.end + 1 + CLEAR.length }
  const cancel = { x: clear.end + 1, end: clear.end + 1 + CANCEL.length }
  return { row, save, clear, cancel }
}

export function promptArea(cols: number, rows: number): Rect {
  const width = Math.min(58, Math.max(30, cols - 4))
  const height = 7
  return {
    x: Math.max(0, Math.floor((cols - width) / 2)),
    y: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height
  }
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

export interface MenuItem {
  readonly label: string
  readonly id: string
}

/** Named, rather than inlined at both call sites, so a caller can narrow on `kind`. */
export type MenuOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'chosen'; readonly id: string }

/**
 * A right-click menu, drawn where the pointer is.
 *
 * Right-click already reached the client — phase 3 parsed it and phase 4 routed it to
 * the pane — so this is the first thing to *use* it. Placement is clamped to the
 * screen rather than centred: a context menu that appears in the middle is a dialog,
 * and loses the connection to the thing that was clicked.
 */
export class ContextMenu {
  cursor = 0

  constructor(
    readonly items: readonly MenuItem[],
    readonly anchor: { column: number; row: number }
  ) {}

  area(cols: number, rows: number): Rect {
    const width = Math.min(
      Math.max(12, ...this.items.map((item) => item.label.length + 4)),
      Math.max(12, cols - 2)
    )
    const height = this.items.length + 2
    return {
      x: Math.max(0, Math.min(this.anchor.column, cols - width)),
      y: Math.max(0, Math.min(this.anchor.row, rows - height)),
      width,
      height
    }
  }

  handleKey(name: string): MenuOutcome {
    if (name === 'escape') return { kind: 'cancelled' }
    if (name === 'up') {
      this.cursor = Math.max(0, this.cursor - 1)
      return { kind: 'pending' }
    }
    if (name === 'down') {
      this.cursor = Math.min(this.items.length - 1, this.cursor + 1)
      return { kind: 'pending' }
    }
    if (name === 'enter') {
      const item = this.items[this.cursor]
      return item === undefined ? { kind: 'cancelled' } : { kind: 'chosen', id: item.id }
    }
    return { kind: 'pending' }
  }

  handleClick(column: number, row: number, area: Rect): MenuOutcome {
    const index = row - (area.y + 1)
    const item = this.items[index]
    if (item === undefined || column < area.x || column >= area.x + area.width) return { kind: 'cancelled' }
    return { kind: 'chosen', id: item.id }
  }

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    buffer.fill(area, ' ', palette.sidebar)
    for (const [index, item] of this.items.entries()) {
      const y = area.y + 1 + index
      if (y >= area.y + area.height - 1) break
      buffer.writeString(
        area.x + 1,
        y,
        truncate(` ${item.label}`, area.width - 2).padEnd(area.width - 2, ' '),
        index === this.cursor ? palette.sidebarActive : palette.sidebar,
        area.x + area.width
      )
    }
  }
}
