/**
 * A confirm dialog: one question, two answers.
 *
 * The second of the two modals PHASE-4 deferred. Renaming turned out not to need one —
 * a one-line answer belongs on the status line — but this does, for a reason the
 * rename case does not have: the action is *destructive and plural*. Closing a
 * workspace takes several panes and whatever was running in them, and the click that
 * does it is one cell wide on a list row you were probably aiming at for a different
 * reason.
 *
 * Deliberately not used for closing a *pane*. That is one pane, the button is on that
 * pane's own border, and a split is one keystroke to get back. A confirmation there
 * would be a dialog you learn to dismiss without reading, which is worse than none:
 * it trains the reflex that makes the workspace one ineffective too.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { Palette } from './chrome.js'

export type ConfirmOutcome = 'pending' | 'confirmed' | 'cancelled'

export interface ConfirmRequest {
  readonly title: string
  /** The line under the title: what exactly is about to go. */
  readonly detail: string
  /** Run on confirm. The dialog never performs anything itself. */
  confirm(): Promise<void>
}

export class ConfirmDialog {
  constructor(readonly request: ConfirmRequest) {}

  handleKey(name: string): ConfirmOutcome {
    if (name === 'enter') return 'confirmed'
    // `q` is not a cancel here, unlike the settings dialog: this dialog can appear
    // while the user is mid-keystroke, and a letter must not answer a question about
    // destroying their work.
    if (name === 'escape') return 'cancelled'
    return 'pending'
  }

  /** A click. Outside the dialog cancels, which is the safe direction. */
  handleClick(column: number, row: number, area: Rect): ConfirmOutcome {
    const buttons = buttonSpans(area)
    if (row !== buttons.row) return 'pending'
    if (column >= buttons.confirm.x && column < buttons.confirm.end) return 'confirmed'
    if (column >= buttons.cancel.x && column < buttons.cancel.end) return 'cancelled'
    return 'pending'
  }

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    buffer.fill(area, ' ', palette.sidebar)
    const width = area.width - 2
    // The title takes the blocked colour: this dialog only ever asks about losing
    // something, and that is the palette's "this one needs you" role.
    buffer.writeString(area.x + 1, area.y + 1, truncate(this.request.title, width), palette.agent['blocked'] ?? palette.paneTitle, area.x + area.width)
    buffer.writeString(area.x + 1, area.y + 2, truncate(this.request.detail, width), palette.sidebar, area.x + area.width)

    const buttons = buttonSpans(area)
    buffer.writeString(buttons.confirm.x, buttons.row, CONFIRM_LABEL, palette.sidebarActive, area.x + area.width)
    buffer.writeString(buttons.cancel.x, buttons.row, CANCEL_LABEL, palette.tabIdle, area.x + area.width)
  }
}

const CONFIRM_LABEL = ' ↵ confirm '
const CANCEL_LABEL = ' esc cancel '

/** Where the two buttons sit. One definition, used by both drawing and hit testing. */
function buttonSpans(area: Rect): {
  row: number
  confirm: { x: number; end: number }
  cancel: { x: number; end: number }
} {
  const row = area.y + area.height - 2
  const total = CONFIRM_LABEL.length + 1 + CANCEL_LABEL.length
  const start = area.x + Math.max(1, area.width - total - 2)
  return {
    row,
    confirm: { x: start, end: start + CONFIRM_LABEL.length },
    cancel: { x: start + CONFIRM_LABEL.length + 1, end: start + total + 1 }
  }
}

/** Centred, and only as tall as it needs to be. */
export function confirmArea(cols: number, rows: number): Rect {
  const width = Math.min(56, Math.max(28, cols - 4))
  const height = 6
  return {
    x: Math.max(0, Math.floor((cols - width) / 2)),
    y: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height
  }
}
