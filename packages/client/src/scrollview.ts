/**
 * A scrolling viewport over a flat list, shared by the side panels.
 *
 * ## Why this is its own file
 *
 * The Explorer had a working `syncScroll` and the Source Control panel had nothing: it
 * drew rows until it ran out of height and stopped, while the cursor carried on moving
 * onto rows that were never drawn. `Enter` could therefore stage a file the user could
 * not see, which is the worst shape a bug can take in a panel whose job is to say what
 * is about to happen. PHASE-7 asks for one viewport rather than a second copy of the
 * first, and this is it.
 *
 * ## It holds an offset and nothing else
 *
 * No cursor, no rows, no height. The cursor belongs to the panel — it means different
 * things in a tree and in a two-section list — and the height is the renderer's, because
 * a panel that has not been drawn yet does not have one. So `follow` is called at
 * render time with both, exactly as the Explorer's version was.
 */

import { ScreenBuffer, type Rect } from '@leap-chorus/tui'
import type { Palette } from './chrome.js'

export class ScrollView {
  /** The index drawn on the viewport's first row. */
  offset = 0

  /**
   * Move the window as little as possible to put `cursor` on screen, and return the
   * first visible index.
   *
   * Clamped against `count` afterwards rather than before, so a list that shrank under
   * a stationary offset — a stage that empties a section — scrolls back up instead of
   * leaving the viewport past the end showing nothing.
   */
  follow(cursor: number, count: number, height: number): number {
    if (height <= 0 || count <= 0) {
      this.offset = 0
      return 0
    }
    if (cursor < this.offset) this.offset = cursor
    if (cursor >= this.offset + height) this.offset = cursor - height + 1
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, count - height)))
    return this.offset
  }

  /**
   * Scroll without moving a cursor — a wheel, or a page key that scrolls the view.
   *
   * The cursor is left where it was on purpose: the next `follow` drags the view back
   * to it, which is what makes "scroll away to look, then press a key" land where the
   * user was rather than where they had scrolled to.
   */
  by(delta: number, count: number, height: number): void {
    if (height <= 0 || count <= 0) {
      this.offset = 0
      return
    }
    this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, count - height)))
  }

  /**
   * Pull the offset back inside a list of `count` rows, and return it.
   *
   * For a view with **no cursor** — the preview, where the offset is the only position
   * there is. `follow` cannot serve: it takes a cursor to move towards, and passing the
   * offset as its own cursor would pin the viewport to its top row and stop `by` from
   * ever scrolling past one screen. Clamping is what `follow` does last, on its own.
   */
  clamp(count: number, height: number): number {
    if (height <= 0 || count <= 0) {
      this.offset = 0
      return 0
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, count - height)))
    return this.offset
  }

  /**
   * The list index drawn at screen row `row`, or null when that row is not a list row.
   *
   * `top` is the first screen row the list occupies, so a panel with a header passes
   * its own list origin and does not have to know about the offset at all.
   */
  indexAt(row: number, top: number, count: number, height: number): number | null {
    if (row < top || row >= top + height) return null
    const index = this.offset + (row - top)
    return index >= 0 && index < count ? index : null
  }
}

/** A list longer than its viewport needs a bar, and one that fits must not have one. */
export function needsScrollbar(count: number, height: number): boolean {
  return height > 0 && count > height
}

/**
 * Draw the bar in `area`, which is one column wide.
 *
 * Proportional: the thumb is as tall a fraction of the track as the viewport is of the
 * list, floored at one cell so a very long list still shows something to grab. The
 * track is drawn too — a thumb floating in blank space says how far down you are but
 * not how far there is to go.
 */
export function renderScrollbar(
  buffer: ScreenBuffer,
  area: Rect,
  offset: number,
  count: number,
  palette: Palette
): void {
  const height = area.height
  if (height <= 0 || count <= height) return
  const thumb = Math.max(1, Math.round((height * height) / count))
  const travel = height - thumb
  const scrollable = count - height
  const top = scrollable <= 0 ? 0 : Math.round((offset / scrollable) * travel)
  const right = area.x + 1
  for (let i = 0; i < height; i++) {
    const inThumb = i >= top && i < top + thumb
    buffer.writeString(area.x, area.y + i, inThumb ? '█' : '│', inThumb ? palette.sidebarActive : palette.sidebar, right)
  }
}
