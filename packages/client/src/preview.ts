/**
 * The embedded preview: a file, in the dock, for glancing at.
 *
 * herdr-sidebar's Preview view (MIT), minus everything that needs a graphics protocol
 * or a syntax engine. See `NOTICE`.
 *
 * ## What this is for, and what it is not for
 *
 * It is for *glancing*: you are moving down a tree and want to know whether this is the
 * file. It is not for reading — reading happens in `$PAGER`, in a pane, with the tool
 * the user already chose and configured, and three phases of this port have taken that
 * position. So the preview has no search, no line numbers you can jump to, and no
 * theme of its own, and `⏎` on a file still opens a pane unless `[sidebar] preview` is
 * on.
 *
 * ## State here, actions at the call site
 *
 * The same split as every other view: this holds the lines, the scroll offset and the
 * wrap flag, decides what a keystroke means, and performs nothing. `app.ts` makes the
 * RPC.
 */

import { ScreenBuffer, stringWidth, truncate, type Rect } from '@leap-chorus/tui'
import type { PreviewResult } from '@leap-chorus/protocol'
import { wrapWords, type Palette } from './chrome.js'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'
import type { PanelKey } from './search.js'

export type PreviewOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  /** Hand this file to `$PAGER` in a pane, which is where reading belongs. */
  | { readonly kind: 'open'; readonly path: string }

/** Rows of chrome above the text: the filename, and the status line. */
const LIST_TOP = 2

export class PreviewPanel {
  result: PreviewResult | null = null
  error: string | null = null
  /** The path we asked for, so a reply for a file the cursor has left is discarded. */
  pending: string | null = null
  /**
   * Wrap long lines, or let them run off the right edge.
   *
   * Off by default and toggled with `w`, as in herdr-sidebar. Off is right for code —
   * indentation carries meaning and wrapping destroys the shape of it — and on is right
   * for prose, which is why it is a key rather than a setting.
   */
  wrap = false
  /** Horizontal scroll, in columns. Only reachable while `wrap` is off. */
  private column = 0
  private readonly view = new ScrollView()

  adopt(result: PreviewResult): void {
    // A reply for a file the cursor has already left is not an answer to any question
    // that is still being asked. Dropping it is what stops a fast cursor from leaving
    // the wrong file on screen.
    if (this.pending !== null && result.path !== this.pending) return
    this.result = result
    this.pending = null
    this.error = null
    this.view.offset = 0
    this.column = 0
  }

  fail(path: string, message: string): void {
    if (this.pending !== null && path !== this.pending) return
    this.result = null
    this.pending = null
    this.error = message
  }

  /** Say what is being fetched, so the panel can show the name before the bytes land. */
  request(path: string): void {
    this.pending = path
    this.error = null
  }

  /** The lines as they will be drawn, wrapped when asked. */
  rows(width: number): string[] {
    const result = this.result
    if (result === null) return []
    if (!this.wrap) return [...result.lines]
    const out: string[] = []
    for (const line of result.lines) {
      // An empty line is a paragraph break and has to survive wrapping, which
      // `wrapWords` of '' would otherwise drop.
      if (line.length === 0) {
        out.push('')
        continue
      }
      out.push(...wrapWords(line, Math.max(1, width)))
    }
    return out
  }

  /**
   * The rows currently on screen, in order, exactly as the renderer will draw them —
   * scrolled, panned and with tabs expanded.
   *
   * The renderer calls this rather than repeating the arithmetic, which is what makes a
   * test of "what is visible" a test of what a user sees. The only thing left to the
   * renderer is the final `truncate`, because that depends on whether a scrollbar took
   * the last column.
   */
  rowsShown(area: Rect): string[] {
    const height = this.listHeight(area)
    const rows = this.rows(this.textWidth(area))
    const offset = this.view.clamp(rows.length, height)
    return rows.slice(offset, offset + height).map((line) => {
      // Tabs are expanded rather than sent through: the buffer has no tab stops, so a
      // raw tab would draw as one blank cell and silently destroy the indentation the
      // reader is here to see.
      const shown = line.replace(/\t/gu, '    ')
      return this.wrap || this.column === 0 ? shown : sliceColumns(shown, this.column)
    })
  }

  handleKey(key: PanelKey, area: Rect): PreviewOutcome {
    const height = this.listHeight(area)
    const width = this.textWidth(area)
    const count = this.rows(width).length

    if (key.name === 'escape' || key.char === 'q') return { kind: 'close' }
    if (key.char === 'w') {
      this.wrap = !this.wrap
      // The offset was an index into the *unwrapped* list and means something else now.
      // Going back to the top is honest; keeping a number that no longer points at the
      // same text is not.
      this.view.offset = 0
      this.column = 0
      return { kind: 'none' }
    }
    if (key.name === 'enter' || key.char === 'o') {
      const path = this.result?.path ?? null
      return path === null ? { kind: 'none' } : { kind: 'open', path }
    }
    if (key.name === 'up' || key.char === 'k') {
      this.view.by(-1, count, height)
      return { kind: 'none' }
    }
    if (key.name === 'down' || key.char === 'j') {
      this.view.by(1, count, height)
      return { kind: 'none' }
    }
    if (key.name === 'pageup') {
      this.view.by(-Math.max(1, height - 1), count, height)
      return { kind: 'none' }
    }
    if (key.name === 'pagedown') {
      this.view.by(Math.max(1, height - 1), count, height)
      return { kind: 'none' }
    }
    if (key.name === 'home') {
      this.view.offset = 0
      this.column = 0
      return { kind: 'none' }
    }
    if (key.name === 'end') {
      this.view.by(count, count, height)
      return { kind: 'none' }
    }
    // Horizontal movement exists only unwrapped: with wrapping on there is nothing to
    // the right, and a left/right that silently did nothing would read as a broken key.
    if (!this.wrap && (key.name === 'left' || key.char === 'h')) {
      this.column = Math.max(0, this.column - 8)
      return { kind: 'none' }
    }
    if (!this.wrap && (key.name === 'right' || key.char === 'l')) {
      this.column = Math.min(this.maxColumn(width), this.column + 8)
      return { kind: 'none' }
    }
    return { kind: 'none' }
  }

  scrollBy(delta: number, area: Rect): void {
    this.view.by(delta, this.rows(this.textWidth(area)).length, this.listHeight(area))
  }

  private listHeight(area: Rect): number {
    return Math.max(0, area.height - LIST_TOP)
  }

  private textWidth(area: Rect): number {
    return Math.max(1, area.width)
  }

  /** How far right there is anything to see. Past this, scrolling shows blank columns. */
  private maxColumn(width: number): number {
    let longest = 0
    for (const line of this.result?.lines ?? []) longest = Math.max(longest, stringWidth(line))
    return Math.max(0, longest - width)
  }

  /**
   * What the status line says.
   *
   * Never silent about a cap, for the same reason search is not: a preview that stopped
   * at 5,000 lines and a file that is 5,000 lines long look identical, and somebody
   * concluding the string they are looking for is absent would be wrong.
   */
  statusLine(): string {
    if (this.error !== null) return 'failed'
    if (this.pending !== null) return 'reading…'
    const result = this.result
    if (result === null) return 'nothing selected'
    if (result.binary) return `binary · ${formatSize(result.size)}`
    const parts = [`${result.lines.length} lines`, formatSize(result.size)]
    if (result.renderer !== 'plain') parts.push(result.renderer)
    if (result.cap !== null) parts.push(result.cap === 'lines' ? 'more lines' : 'more bytes')
    if (this.wrap) parts.push('wrap')
    return parts.join(' · ')
  }

  renderInto(buffer: ScreenBuffer, area: Rect, palette: Palette, focused: boolean): void {
    buffer.fill(area, ' ', palette.sidebar)
    const right = area.x + area.width
    const dim = palette.agent['idle'] ?? palette.sidebar
    const name = this.result?.path ?? this.pending ?? 'preview'

    buffer.writeString(
      area.x,
      area.y,
      truncate(`${focused ? '▸ ' : '  '}${tail(name, Math.max(0, area.width - 2))}`, area.width),
      focused ? palette.sidebarActive : palette.sidebar,
      right
    )
    buffer.writeString(area.x, area.y + 1, truncate(this.statusLine(), area.width), dim, right)

    if (this.error !== null) {
      // Wrapped, not truncated: the same argument the other views make. A message whose
      // first half is a path and whose second half is the reason loses the reason.
      let y = area.y + LIST_TOP
      for (const line of wrapWords(this.error, area.width)) {
        if (y >= area.y + area.height) break
        buffer.writeString(area.x, y, line, palette.agent['blocked'] ?? palette.sidebar, right)
        y += 1
      }
      return
    }

    const result = this.result
    if (result === null) return
    if (result.binary) {
      // Not rendered as noise, and not rendered at all. A terminal handed arbitrary
      // bytes does arbitrary things to its own state, which is a worse outcome than
      // showing nothing.
      let y = area.y + LIST_TOP
      for (const line of wrapWords(
        `${formatSize(result.size)} of binary data — nothing to show. ⏎ opens it in ${'$PAGER'}.`,
        area.width
      )) {
        if (y >= area.y + area.height) break
        buffer.writeString(area.x, y, line, dim, right)
        y += 1
      }
      return
    }

    const height = this.listHeight(area)
    if (height <= 0) return
    const width = this.textWidth(area)
    const rows = this.rows(width)
    if (rows.length === 0) {
      buffer.writeString(area.x, area.y + LIST_TOP, truncate('empty file', area.width), dim, right)
      return
    }

    const bar = needsScrollbar(rows.length, height)
    const room = area.width - (bar ? 1 : 0)
    const offset = this.view.clamp(rows.length, height)
    let y = area.y + LIST_TOP
    for (const line of this.rowsShown(area)) {
      buffer.writeString(area.x, y, truncate(line, room), palette.sidebar, area.x + room)
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

  hint(): string {
    return PREVIEW_HINT
  }
}

/**
 * Drop the first `columns` display columns of a line.
 *
 * By *column*, not by string index: a line of CJK scrolled by eight indices moves
 * sixteen columns, and the reader who pressed `→` twice would find the text had jumped
 * four characters further than the one before it did.
 */
export function sliceColumns(text: string, columns: number): string {
  if (columns <= 0) return text
  let used = 0
  for (let i = 0; i < text.length; i++) {
    if (used >= columns) return text.slice(i)
    used += stringWidth(text[i] as string)
  }
  return ''
}

/** `1.2 kB`, `340 B`. Short, because it shares a line with three other facts. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `…/deep/file.ts` says more than `packages/client/sr…`. */
function tail(path: string, width: number): string {
  if (width <= 0) return ''
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`
}

export const PREVIEW_HINT =
  '↑↓ scroll · PgUp/PgDn page · w wrap · ←→ pan · ⏎ open in $PAGER · esc back'
