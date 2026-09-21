/**
 * The Source Control panel.
 *
 * The idea, and the key map, come from herdr-sidebar (MIT); the implementation does
 * not — that is a ratatui application in its own pane, and this is a docked panel drawn
 * with this project's own buffer. See `NOTICE`.
 *
 * ## State here, actions at the call site
 *
 * Same split as `SettingsDialog`: this holds the cursor and the last status, decides
 * what a keystroke *means*, and performs nothing. The app does the RPC. That keeps
 * every daemon call in one place and lets this be tested by driving keys at a plain
 * object.
 *
 * ## Why it captures the keyboard
 *
 * Keys normally go to the focused pane. A panel where `d` discards a file cannot share
 * that: `d` is also a perfectly ordinary keystroke for the shell behind it. So the
 * panel takes the keyboard while it is open, exactly as the settings dialog does, and
 * escape gives it back.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { GitDrawerId, GitDrawerRow, GitFileEntry, GitStatusResult } from '@leap-chorus/protocol'
import { wrapWords, type Palette } from './chrome.js'
import { DrawersPanel, fitRowText } from './drawers.js'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'

/** Narrower than this and a path is a column of truncation, not a filename. */
export const MIN_SCM_WIDTH = 34

/** What a keystroke asked the app to do. The panel performs none of it. */
export type ScmOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'refresh' }
  | { readonly kind: 'stage'; readonly paths: readonly string[] }
  | { readonly kind: 'unstage'; readonly paths: readonly string[] }
  | { readonly kind: 'discard'; readonly paths: readonly string[]; readonly untracked: number }
  | { readonly kind: 'commit' }
  | { readonly kind: 'diff'; readonly path: string; readonly staged: boolean }
  /** Open the branch picker. The app fetches the branches; the panel holds none. */
  | { readonly kind: 'branches' }
  | { readonly kind: 'sync' }
  /**
   * Draft a commit message and open the commit box with it already filled in.
   *
   * herdr-sidebar's `A`, and the `✧` it puts beside a drafted message. The draft is
   * written from the staged filenames offline unless `[sidebar] ai-commit` is on, which
   * it is not by default — see `suggest.ts` for why that switch exists and why the
   * fallback is the interesting half.
   */
  | { readonly kind: 'suggest' }
  /**
   * A drawer header was activated. The panel has already flipped it; `fetch` says
   * whether the app has to go and get its rows.
   */
  | { readonly kind: 'drawer'; readonly id: GitDrawerId; readonly fetch: boolean }
  /** A drawer row's context menu — the only place a drawer action is reachable. */
  | { readonly kind: 'drawerMenu'; readonly drawer: GitDrawerId; readonly row: GitDrawerRow }

/**
 * A row in the flattened list.
 *
 * Five kinds, three of which the cursor can rest on. `header` is a label for the two
 * change sections and `drawer-note` is a drawer's reason for having no rows; neither
 * is a destination, and `move` steps over both.
 */
interface Row {
  readonly kind: 'header' | 'file' | 'drawer' | 'drawer-row' | 'drawer-note'
  readonly text: string
  readonly entry?: GitFileEntry
  readonly staged?: boolean
  readonly drawer?: GitDrawerId
  readonly row?: GitDrawerRow
}

/** Which rows the cursor may land on. */
function selectable(row: Row | undefined): boolean {
  return row !== undefined && (row.kind === 'file' || row.kind === 'drawer' || row.kind === 'drawer-row')
}

export class ScmPanel {
  /**
   * The eight drawers, under the changes list.
   *
   * A field rather than a second panel in `SidebarPanels`: they are part of the Source
   * Control view — one cursor, one scroll offset, one `r` — and hoisting them would
   * make a drawer row and a changed file two different kinds of selection to keep in
   * step. The app reaches them through here for fetching.
   */
  readonly drawers = new DrawersPanel()
  status: GitStatusResult | null = null
  /** Why the last call failed, shown in place of the list. */
  error: string | null = null
  /** What the last sync said, in git's words. Cleared by the next thing that happens. */
  note: string | null = null
  private cursor = 0
  private readonly view = new ScrollView()

  /**
   * Adopt a new status, keeping the cursor on the same *file* where possible.
   *
   * Staging a file moves it between sections and renumbers everything after it. Holding
   * the index still would leave the cursor on whatever slid into that slot, so a second
   * Enter would stage a file the user never looked at.
   */
  adopt(status: GitStatusResult): void {
    const previous = this.selected()
    this.status = status
    this.error = null
    // A note describes the call that produced it. Carrying it onto the next status
    // would leave "synced with remote" sitting above a list that has moved on.
    this.note = null
    if (previous === null) {
      this.clampCursor()
      return
    }
    const rows = this.rows()
    const sameFile = rows.findIndex(
      (row) => row.kind === 'file' && row.entry?.path === previous.entry?.path && row.staged === previous.staged
    )
    // Failing that, the same path on the other side — which is where staging put it.
    const movedFile = rows.findIndex((row) => row.kind === 'file' && row.entry?.path === previous.entry?.path)
    this.cursor = sameFile !== -1 ? sameFile : movedFile !== -1 ? movedFile : this.cursor
    this.clampCursor()
  }

  fail(message: string): void {
    this.error = message
    this.note = null
  }

  /**
   * Report something that worked — what a sync did. Not an error, so the list stays.
   *
   * An empty message clears the line rather than drawing a blank one, which is how a
   * call that finished with nothing to say takes its own "working…" note back down.
   */
  report(message: string): void {
    this.note = message.length === 0 ? null : message
    this.error = null
  }

  /**
   * The flattened list — the two change sections, then the eight drawers.
   *
   * One list, because there is one cursor and one viewport. The drawers are appended
   * rather than drawn in their own rectangle for the same reason: a changes list that
   * scrolled separately from the drawers under it would need two scrollbars and two
   * ideas of where the keyboard is.
   */
  rows(): Row[] {
    const status = this.status
    if (status === null) return []
    const rows: Row[] = []
    if (status.staged.length > 0) {
      rows.push({ kind: 'header', text: `Staged Changes (${status.staged.length})` })
      for (const entry of status.staged) {
        rows.push({ kind: 'file', text: entry.path, entry, staged: true })
      }
    }
    if (status.unstaged.length > 0) {
      rows.push({ kind: 'header', text: `Changes (${status.unstaged.length})` })
      for (const entry of status.unstaged) {
        rows.push({ kind: 'file', text: entry.path, entry, staged: false })
      }
    }
    // With drawers under it, an empty changes list is no longer an empty *panel*, so
    // "no changes" is a row in the list rather than a message drawn in place of it.
    if (rows.length === 0) rows.push({ kind: 'header', text: 'no changes' })
    for (const line of this.drawers.lines()) {
      rows.push(
        line.kind === 'drawer-row'
          ? { kind: 'drawer-row', text: line.text, drawer: line.id, row: line.row }
          : { kind: line.kind, text: line.text, drawer: line.id }
      )
    }
    return rows
  }

  selected(): Row | null {
    return this.rows()[this.cursor] ?? null
  }

  /** Move by `delta`, skipping labels: a header and a drawer's reason are not destinations. */
  private move(delta: number): void {
    const rows = this.rows()
    if (rows.length === 0) return
    let next = this.cursor
    for (let step = 0; step < rows.length; step++) {
      next += delta
      if (next < 0 || next >= rows.length) return
      if (selectable(rows[next])) {
        this.cursor = next
        return
      }
    }
  }

  private clampCursor(): void {
    const rows = this.rows()
    if (rows.length === 0) {
      this.cursor = 0
      return
    }
    if (this.cursor >= rows.length) this.cursor = rows.length - 1
    if (this.cursor < 0) this.cursor = 0
    // Never rest on a header, including on first load where the cursor starts at 0.
    if (!selectable(rows[this.cursor])) {
      const first = rows.findIndex((row) => selectable(row))
      this.cursor = first === -1 ? 0 : first
    }
  }

  /**
   * A click in the panel.
   *
   * The branch line is a button, which is how herdr-sidebar opens its picker. Below it,
   * a click lands on a file row — through the viewport's offset, so what is clicked is
   * what was drawn rather than the row that would have been there with no scrolling.
   */
  handleClick(row: number, area: Rect): ScmOutcome {
    if (row === area.y && this.status !== null) return { kind: 'branches' }
    const rows = this.rows()
    const index = this.view.indexAt(row, area.y + LIST_TOP, rows.length, this.listHeight(area))
    if (index === null || !selectable(rows[index])) return { kind: 'none' }
    this.cursor = index
    // A click on a drawer header opens it, which is the gesture a `▸` invites. A click
    // on a file row still only selects: staging is `⏎`, and phase 10 settled that a
    // click is the lighter gesture everywhere in the dock.
    const hit = rows[index] as Row
    if (hit.kind === 'drawer') return this.toggleDrawer(hit)
    return { kind: 'none' }
  }

  /** Scroll without moving the cursor. The next keystroke pulls the view back to it. */
  scrollBy(delta: number, area: Rect): void {
    this.view.by(delta, this.rows().length, this.listHeight(area))
  }

  private listHeight(area: Rect): number {
    return Math.max(0, area.height - LIST_TOP)
  }

  /**
   * Put the cursor in view and say where the list now starts.
   *
   * Called by the renderer, because the height is the renderer's to know. That is the
   * same arrangement `explorer.ts` already had; the whole point of this phase's
   * `ScrollView` is that there is now one of them instead of one and a half.
   */
  follow(height: number): number {
    const rows = this.rows()
    const offset = this.view.follow(this.cursor, rows.length, height)
    // A header is a label for the rows under it, so it comes along when the cursor lands
    // on the first of them. Without this, staging a file scrolls the view to the file's
    // new position and leaves "Staged Changes (1)" one row above the top — which reads
    // as the file having moved into nothing.
    if (offset === this.cursor && height > 1 && rows[this.cursor - 1]?.kind === 'header') {
      this.view.offset = offset - 1
      return this.view.offset
    }
    return offset
  }

  handleKey(name: string, char: string | undefined): ScmOutcome {
    if (name === 'escape') return { kind: 'close' }
    if (name === 'up') {
      this.move(-1)
      return { kind: 'none' }
    }
    if (name === 'down') {
      this.move(1)
      return { kind: 'none' }
    }
    if (name === 'enter') return this.activateSelected()
    // `→` opens a drawer and `←` closes it, which is what an arrow means beside a `▸`.
    if (name === 'right' || name === 'left') {
      const row = this.selected()
      if (row?.kind !== 'drawer' || row.drawer === undefined) return { kind: 'none' }
      const id = row.drawer
      if (name === 'right') {
        return { kind: 'drawer', id, fetch: this.drawers.expand(id) }
      }
      this.drawers.collapse(id)
      this.clampCursor()
      return { kind: 'drawer', id, fetch: false }
    }

    switch (char) {
      case 'k':
        this.move(-1)
        return { kind: 'none' }
      case 'j':
        this.move(1)
        return { kind: 'none' }
      case 'q':
        return { kind: 'close' }
      case 'b':
        // `b` used to be a second `q`. It is the branch line's key now, which is worth
        // more: closing already has escape and `q`, and switching branch had nothing.
        return { kind: 'branches' }
      case 'S':
        // Capitalised, as in herdr-sidebar. Sync talks to the remote and can rebase, so
        // it is the one action here that should not be one relaxed finger away.
        return { kind: 'sync' }
      case 'A':
        // Capitalised for the same reason, doubled: with `[sidebar] ai-commit` on this
        // is the only key in the project that can put a working tree in front of a model.
        return { kind: 'suggest' }
      case 'r':
        return { kind: 'refresh' }
      case 'a':
        // Everything unstaged, which is what `git add --all` means, sent as an empty
        // path list so the daemon does not have to trust a stale client's idea of it.
        return { kind: 'stage', paths: [] }
      case 'u':
        return { kind: 'unstage', paths: [] }
      case 'c':
        return { kind: 'commit' }
      case 'd':
        return this.discardSelected()
      case 'o': {
        const row = this.selected()
        if (row?.entry === undefined) return { kind: 'none' }
        return { kind: 'diff', path: row.entry.path, staged: row.staged === true }
      }
      case 'm':
        // herdr-sidebar's row menu. Only drawer rows have one here: the changes list's
        // own menu is phase 9's question and every one of its actions is a key already.
        return this.menuForSelected()
      default:
        return { kind: 'none' }
    }
  }

  /**
   * `⏎`, whatever is under the cursor.
   *
   * A file is staged or unstaged, a drawer opens, and a drawer *row* opens its menu.
   * The menu rather than a default action: every drawer row's primary entry is
   * something different — Show Changes for a commit, Checkout for a branch — and a key
   * that means four things depending on which section you scrolled into is a key that
   * cherry-picks a commit when you meant to look at it.
   */
  private activateSelected(): ScmOutcome {
    const row = this.selected()
    if (row === null) return { kind: 'none' }
    if (row.kind === 'drawer') return this.toggleDrawer(row)
    if (row.kind === 'drawer-row') return this.menuForSelected()
    if (row.entry === undefined) return { kind: 'none' }
    return row.staged === true
      ? { kind: 'unstage', paths: [row.entry.path] }
      : { kind: 'stage', paths: [row.entry.path] }
  }

  private toggleDrawer(row: Row): ScmOutcome {
    const id = row.drawer
    if (id === undefined) return { kind: 'none' }
    const fetch = this.drawers.toggle(id)
    // Collapsing can leave the cursor pointing at a row that no longer exists.
    this.clampCursor()
    return { kind: 'drawer', id, fetch }
  }

  private menuForSelected(): ScmOutcome {
    const row = this.selected()
    if (row?.kind !== 'drawer-row' || row.row === undefined || row.drawer === undefined) return { kind: 'none' }
    return { kind: 'drawerMenu', drawer: row.drawer, row: row.row }
  }

  /**
   * Discard the selected file.
   *
   * Only ever the one under the cursor — there is no discard-all, because the whole
   * working tree is the one thing nobody means to throw away by pressing a letter.
   * `untracked` travels with it so the confirmation can say the file will be deleted
   * rather than reverted.
   */
  private discardSelected(): ScmOutcome {
    const row = this.selected()
    if (row?.entry === undefined || row.staged === true) return { kind: 'none' }
    return {
      kind: 'discard',
      paths: [row.entry.path],
      untracked: row.entry.letter === 'U' ? 1 : 0
    }
  }
}

/** Rows above the file list: the branch line and a blank. */
const LIST_TOP = 2

/** The status letter's colour, by role rather than by letter. */
function letterStyle(letter: string, palette: Palette) {
  if (letter === '!') return palette.agent['blocked'] ?? palette.sidebar
  if (letter === 'U' || letter === 'A') return palette.agent['done'] ?? palette.sidebar
  if (letter === 'D') return palette.agent['blocked'] ?? palette.sidebar
  return palette.agent['working'] ?? palette.sidebar
}

export function renderScmPanel(
  buffer: ScreenBuffer,
  area: Rect,
  panel: ScmPanel,
  palette: Palette,
  focused: boolean
): void {
  buffer.fill(area, ' ', palette.sidebar)
  const right = area.x + area.width
  const status = panel.status

  // The branch line, with ahead/behind when there is an upstream to be ahead of.
  const branch = status === null ? 'source control' : status.branch || 'detached'
  const counts =
    status === null || !status.hasUpstream
      ? ''
      : `${status.ahead > 0 ? ` ↑${status.ahead}` : ''}${status.behind > 0 ? ` ↓${status.behind}` : ''}`
  buffer.writeString(
    area.x,
    area.y,
    truncate(`${focused ? '▸ ' : '  '}${branch}${counts}`, area.width),
    focused ? palette.sidebarActive : palette.sidebar,
    right
  )

  // Under the branch line: what the last remote operation said. Truncated rather than
  // wrapped, unlike an error — this one leads with its conclusion.
  if (panel.note !== null) {
    buffer.writeString(area.x, area.y + 1, truncate(panel.note, area.width), palette.agent['idle'] ?? palette.sidebar, right)
  }

  if (panel.error !== null) {
    // Wrapped, not truncated. Git's own messages lead with the path — "/very/long/dir
    // is not inside a git repository" — so a single truncated line shows the directory
    // and hides the reason, which is the half that matters.
    let y = area.y + LIST_TOP
    for (const line of wrapWords(panel.error, area.width)) {
      if (y >= area.y + area.height) break
      buffer.writeString(area.x, y, line, letterStyle('!', palette), right)
      y += 1
    }
    return
  }
  if (status === null) {
    buffer.writeString(area.x, area.y + LIST_TOP, truncate('loading…', area.width), palette.sidebar, right)
    return
  }

  const rows = panel.rows()
  if (rows.length === 0) return

  const selected = panel.selected()
  const height = Math.max(0, area.height - LIST_TOP)
  // A bar takes the last column, and only when there is something to scroll. Reserving
  // it unconditionally would steal a column of filename from every panel that fits.
  const bar = needsScrollbar(rows.length, height)
  const room = area.width - (bar ? 1 : 0)
  const offset = panel.follow(height)

  let y = area.y + LIST_TOP
  for (const row of rows.slice(offset, offset + height)) {
    if (row.kind === 'header') {
      buffer.writeString(area.x, y, truncate(row.text, room), palette.paneTitle, right)
      y += 1
      continue
    }
    if (row.kind === 'drawer' || row.kind === 'drawer-row' || row.kind === 'drawer-note') {
      const isSelected = row === selected
      const rowStyle =
        isSelected && focused
          ? palette.sidebarActive
          : row.kind === 'drawer'
            ? palette.paneTitle
            : row.kind === 'drawer-note'
              ? (palette.agent['idle'] ?? palette.sidebar)
              : palette.sidebar
      buffer.fill({ x: area.x, y, width: room, height: 1 }, ' ', rowStyle)
      // A drawer's rows are indented under its header, which is the only thing saying
      // a commit belongs to Commits rather than to the list above it.
      const indent = row.kind === 'drawer' ? '' : '  '
      // A drawer row is fitted by `fitRowText`, not truncated: a remote clipped from
      // the right loses the `owner/repo` that says which remote it is. See `drawers.ts`.
      const text = row.row === undefined ? row.text : fitRowText(row.row, Math.max(0, room - indent.length))
      buffer.writeString(area.x, y, truncate(`${indent}${text}`, room), rowStyle, area.x + room)
      y += 1
      continue
    }
    const entry = row.entry as GitFileEntry
    const isSelected = row === selected
    const rowStyle = isSelected && focused ? palette.sidebarActive : palette.sidebar
    // The whole row takes the selection background, so the eye follows a band rather
    // than a single highlighted character.
    buffer.fill({ x: area.x, y, width: room, height: 1 }, ' ', rowStyle)
    // The path is shown tail-first when it does not fit: `…/deep/file.ts` says more
    // than `packages/client/sr…`.
    const space = room - 4
    const shown = entry.path.length > space ? `…${entry.path.slice(entry.path.length - space + 1)}` : entry.path
    buffer.writeString(area.x + 2, y, shown, rowStyle, area.x + room)
    buffer.writeString(area.x, y, entry.letter, isSelected && focused ? rowStyle : letterStyle(entry.letter, palette), right)
    y += 1
  }
  if (bar) {
    renderScrollbar(
      buffer,
      { x: area.x + area.width - 1, y: area.y + LIST_TOP, width: 1, height },
      offset,
      rows.length,
      palette
    )
  }
}

/** The one-line hint for the status bar while the panel has the keyboard. */
export const SCM_HINT =
  '↑↓ move · ⏎ stage/open · m menu · →← drawer · a/u all · c commit · A draft · d discard · o diff · b branch · S sync · r refresh · esc close'
