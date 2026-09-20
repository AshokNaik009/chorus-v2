/**
 * The branch picker: a filtering overlay over `git.branches`.
 *
 * The shape is herdr-sidebar's `branch_ui.rs` (MIT) — a centred list, the current
 * branch marked and selected on open, remote entries labelled. See `NOTICE`. What is
 * added here is the filter: that file's picker is arrow keys only, and a checkout with
 * forty branches is a scroll rather than a choice.
 *
 * ## State here, the checkout at the call site
 *
 * Same split as every other dialog in this client. The picker decides what a keystroke
 * means and performs nothing; the app runs `git.checkout` and adopts the status it gets
 * back. That is what makes the panel's branch line update without a refresh — the
 * checkout's own return value is the new status.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { GitBranch } from '@leap-chorus/protocol'
import type { Palette } from './chrome.js'
import { ScrollView, renderScrollbar } from './scrollview.js'

export type BranchOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'checkout'; readonly branch: GitBranch }

/** Rows of chrome: the title's border row above, the filter line, the border below. */
const HEADER_ROWS = 2

export class BranchPicker {
  filter = ''
  private cursor = 0
  private readonly view = new ScrollView()

  constructor(readonly branches: readonly GitBranch[]) {
    // Open on the branch you are on, which is where "switch away from here" starts.
    const current = branches.findIndex((branch) => branch.current)
    this.cursor = current === -1 ? 0 : current
  }

  /**
   * The branches the filter leaves, in the order they arrived.
   *
   * Case-insensitive substring, not a fuzzy match: branch names are already full of
   * slashes and dashes, and a subsequence matcher over `feat/user-auth` matches most of
   * what anyone types. A substring says exactly what it will do.
   */
  matches(): readonly GitBranch[] {
    if (this.filter.length === 0) return this.branches
    const needle = this.filter.toLowerCase()
    return this.branches.filter((branch) => branch.name.toLowerCase().includes(needle))
  }

  selected(): GitBranch | null {
    return this.matches()[this.cursor] ?? null
  }

  handleKey(name: string, char: string | undefined, ctrl: boolean): BranchOutcome {
    if (name === 'escape') return { kind: 'close' }
    if (name === 'enter') {
      const branch = this.selected()
      return branch === null ? { kind: 'none' } : { kind: 'checkout', branch }
    }
    if (name === 'up') {
      this.moveBy(-1)
      return { kind: 'none' }
    }
    if (name === 'down') {
      this.moveBy(1)
      return { kind: 'none' }
    }
    if (name === 'backspace') {
      this.retype(this.filter.slice(0, -1))
      return { kind: 'none' }
    }
    // ^C empties the filter, matching the prompt dialog: escape already closes, and
    // "start the search over" has no other gesture in a field with no selection.
    if (ctrl && (char === 'c' || name === 'c')) {
      this.retype('')
      return { kind: 'none' }
    }
    if (ctrl) return { kind: 'none' }
    // Every printable character types. There are no letter shortcuts here on purpose:
    // `j` and `k` would be unreachable in a filter, and a branch called `k` exists.
    if (char !== undefined && char.length > 0) {
      this.retype(this.filter + char)
      return { kind: 'none' }
    }
    return { kind: 'none' }
  }

  /** A click on a row checks that branch out; anywhere else in the box does nothing. */
  handleClick(column: number, row: number, area: Rect): BranchOutcome {
    if (column < area.x || column >= area.x + area.width) return { kind: 'none' }
    const list = this.matches()
    const index = this.view.indexAt(row, area.y + HEADER_ROWS, list.length, this.listHeight(area))
    if (index === null) return { kind: 'none' }
    this.cursor = index
    const branch = list[index]
    return branch === undefined ? { kind: 'none' } : { kind: 'checkout', branch }
  }

  /**
   * Re-filter, keeping the cursor on the same branch where it survives.
   *
   * Holding the *index* would move the selection under a typing user, which is how a
   * picker checks out the wrong branch: the name under the cursor when Enter is pressed
   * must be the one that was under it when the last character was typed.
   */
  private retype(filter: string): void {
    const before = this.selected()
    this.filter = filter
    const list = this.matches()
    const same = before === null ? -1 : list.findIndex((branch) => branch.name === before.name)
    this.cursor = same !== -1 ? same : 0
    this.clamp()
  }

  private moveBy(delta: number): void {
    this.cursor += delta
    this.clamp()
  }

  private clamp(): void {
    const count = this.matches().length
    this.cursor = count === 0 ? 0 : Math.min(Math.max(this.cursor, 0), count - 1)
  }

  private listHeight(area: Rect): number {
    return Math.max(0, area.height - HEADER_ROWS)
  }

  /**
   * Centred, a third of the way down, and no taller than it needs to be.
   *
   * Sized to the longest name so the common case does not truncate, capped at the
   * screen. The height follows the *unfiltered* count, so the box does not resize under
   * every keystroke — a dialog that changes shape as you type is hard to read.
   */
  area(cols: number, rows: number): Rect {
    const longest = this.branches.reduce((max, branch) => Math.max(max, branch.name.length), 0)
    const width = Math.min(Math.max(longest + 14, 30), Math.max(20, cols - 4))
    const height = Math.min(this.branches.length + HEADER_ROWS + 1, Math.max(6, Math.min(18, rows - 2)))
    return {
      x: Math.max(0, Math.floor((cols - width) / 2)),
      y: Math.max(0, Math.floor((rows - height) / 3)),
      width,
      height
    }
  }

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    buffer.fill(area, ' ', palette.sidebar)
    const right = area.x + area.width
    const inner = area.width - 2

    // The filter *is* the title: there is no room for both, and a box that says
    // "Switch Branch" while you are typing tells you less than the text you typed.
    const heading = this.filter.length === 0 ? 'switch branch — type to filter' : `/${this.filter}█`
    buffer.writeString(area.x + 1, area.y, truncate(heading, inner), palette.paneTitle, right)

    const list = this.matches()
    const height = this.listHeight(area)
    if (list.length === 0) {
      buffer.writeString(area.x + 1, area.y + HEADER_ROWS, truncate('no branch matches', inner), palette.sidebar, right)
      return
    }

    const bar = list.length > height
    const room = inner - (bar ? 1 : 0)
    const offset = this.view.follow(this.cursor, list.length, height)
    for (const [index, branch] of list.slice(offset, offset + height).entries()) {
      const y = area.y + HEADER_ROWS + index
      const isSelected = offset + index === this.cursor
      const rowStyle = isSelected ? palette.sidebarActive : palette.sidebar
      buffer.fill({ x: area.x + 1, y, width: room, height: 1 }, ' ', rowStyle)
      const mark = branch.current ? '✓ ' : '  '
      // `remote` right-aligned rather than prefixed, so the names stay in one column
      // and `origin/` is not read twice.
      const tag = branch.remote ? 'remote' : ''
      const name = truncate(`${mark}${branch.name}`, Math.max(0, room - tag.length - 1))
      buffer.writeString(area.x + 1, y, name, rowStyle, right)
      if (tag.length > 0) {
        buffer.writeString(area.x + 1 + room - tag.length, y, tag, rowStyle, right)
      }
    }
    if (bar) {
      renderScrollbar(
        buffer,
        { x: area.x + area.width - 1, y: area.y + HEADER_ROWS, width: 1, height },
        offset,
        list.length,
        palette
      )
    }
  }
}

/** The status-bar hint while the picker has the keyboard. */
export const BRANCH_HINT = '↑↓ move · ⏎ switch · type to filter · ^c clear · esc cancel'
