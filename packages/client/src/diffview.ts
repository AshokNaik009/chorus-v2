/**
 * The Changes overlay: what the agent in this pane actually changed.
 *
 * The sidebar answers *which agent needs me*. Nothing answered *what did it do*, and
 * until now the only route was `o` in the Source Control view, which spawned `git diff`
 * into a new pane — collapsing the dock, changing the layout, and handing the reader a
 * pager to quit out of. That trade was defended three times (phases 7, 9 and 11) and it
 * was the right call **for the dock**: thirty-four columns cannot hold a diff. It is not
 * the right call for a surface that can take the whole terminal, which is what this is.
 *
 * ## State here, actions at the call site
 *
 * The same split as every other view in this client: this holds the patch, the scroll
 * offset and two flags, decides what a keystroke means, and performs nothing. `app.ts`
 * makes the RPC. That is what lets the whole thing be tested by driving keys at a plain
 * object and reading a `ScreenBuffer` back.
 *
 * ## Colour by role, not by a new theme key
 *
 * `scm.ts:letterStyle` already established this: an added line is `palette.agent.done`
 * and a removed one is `palette.agent.blocked`, because those are the theme's green and
 * red and they are already the colours this program uses for "finished" and "needs
 * you". Adding `diff-add-fg`/`diff-del-fg` would mean a `ThemeConfig` field, an entry in
 * every named theme and a config-schema change, to end up at the same two colours.
 *
 * ## Why the gutter is two numbers and not one
 *
 * A reviewer asking "what changed" is about to go and look at the file, and the number
 * they need is the one in the file *as it is now*. But a deletion has no such number,
 * and showing only the new side makes removed lines numberless — which reads as though
 * they were never anywhere. Both sides, narrow, dimmed.
 */

import { ScreenBuffer, truncate, type Rect, type Style } from '@leap-chorus/tui'
import type { DiffFile, DiffLine, GitDiffResult } from '@leap-chorus/protocol'
import { wrapWords, type Palette } from './chrome.js'
import { sliceColumns, tail } from './preview.js'
import { letterStyle } from './scm.js'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'

export type DiffOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'refresh' }
  /** Flip between the working tree and the index. The app re-fetches. */
  | { readonly kind: 'toggleStaged'; readonly staged: boolean }
  | { readonly kind: 'edit'; readonly path: string; readonly line: number }
  /** The old route, kept: `git diff` in a pane, in whatever pager the user chose. */
  | { readonly kind: 'pager'; readonly path: string; readonly staged: boolean }

const NOTHING: DiffOutcome = { kind: 'none' }

/**
 * Below this, side-by-side is two columns too narrow to read and the answer is no.
 *
 * Ninety rather than eighty: the gutters and the centre rule take eleven columns before
 * any code is drawn, so eighty would leave two thirty-four-column halves — exactly the
 * width this overlay exists to escape.
 */
export const MIN_SPLIT_WIDTH = 90

/**
 * Two right-aligned line numbers and the space that separates them from the sign.
 *
 * Ten, not nine: at nine the `+` sits flush against the new-side number and reads as
 * part of it — `11+const` — which is exactly the confusion the sign column exists to
 * prevent.
 */
const GUTTER = 10

/** One side's own gutter: a single line number, since a half shows one file's numbering. */
const SIDE_GUTTER = 5

/** Rows of chrome above the patch: the header, and a blank. */
const LIST_TOP = 2

/**
 * The file index down the left: every changed file, always visible.
 *
 * Narrower than the dock's 34 because it carries less — a letter and a path, with no
 * drawer rows, no branch line and no counts column to leave room for.
 */
const INDEX_WIDTH = 28

/** Below this the patch is not worth reading, so the index gives way to it entirely. */
const MIN_PATCH_WIDTH = 46

/** Rows above the index's list: its header, and a blank. */
const INDEX_TOP = 2

export const DIFF_HINT =
  '↑↓ scroll · ]/[ file · click a file to jump · i index · t split · w wrap · s staged · e edit · P pager · esc close'

/** What the app knows about the pane and cannot be read off a patch. */
export interface DiffSubject {
  /** The agent running in the pane, when one is. */
  readonly agent: string | null
  readonly agentStatus: string | null
  /** `pane 2`, or a user's rename. Always something. */
  readonly pane: string
  /** The pane's repository differs from the workspace's — its own checkout. */
  readonly ownWorktree: boolean
}

type DiffRow =
  | { readonly kind: 'file'; readonly file: DiffFile }
  | { readonly kind: 'hunk'; readonly file: DiffFile; readonly text: string }
  | { readonly kind: 'line'; readonly file: DiffFile; readonly line: DiffLine }
  /** A wrapped continuation, which carries no line number of its own. */
  | { readonly kind: 'wrap'; readonly file: DiffFile; readonly line: DiffLine; readonly text: string }
  | { readonly kind: 'note'; readonly file: DiffFile; readonly text: string }
  /** Side-by-side: the old line on the left, the new one on the right; either may be absent. */
  | { readonly kind: 'pair'; readonly file: DiffFile; readonly left: DiffLine | null; readonly right: DiffLine | null }
  | { readonly kind: 'blank' }

export class DiffView {
  result: GitDiffResult | null = null
  error: string | null = null
  subject: DiffSubject | null = null
  /** Which side is being shown. `s` flips it and the app re-fetches. */
  staged = false
  /** Side-by-side. Off by default: unified is right at every width. */
  split = false
  /** Wrap long lines. Off by default — indentation carries meaning in code. */
  wrap = false
  /** What a refused key wanted to say. Cleared by the next keystroke. */
  note: string | null = null
  /**
   * Which file `]`, `[`, `e` and `P` are about.
   *
   * A cursor rather than "whatever is at the top of the viewport", which was the first
   * shape and was wrong twice over: on a patch that fits on one screen `]` moved the
   * offset to a row that was already visible and so appeared to do nothing at all, and
   * `e` acted on a file the reader had scrolled past rather than the one they had
   * chosen. The cursor is drawn — the current file's header is highlighted — so the key
   * has an effect at every size.
   */
  cursor = 0
  /**
   * Show the file index beside the patch.
   *
   * On by default, which is the whole request: a twenty-one file patch scrolls for
   * pages, and without a standing list of what is in it there is no way to see the
   * shape of a change or to reach its ninth file except by scrolling past eight.
   */
  showIndex = true
  private column = 0
  private readonly view = new ScrollView()
  /** The index scrolls independently: it is a list, and the patch is a document. */
  private readonly indexView = new ScrollView()
  private rowCache: {
    rows: readonly DiffRow[]
    width: number
    wrap: boolean
    split: boolean
    result: GitDiffResult | null
  } | null = null

  adopt(result: GitDiffResult): void {
    this.result = result
    this.error = null
    this.rowCache = null
    this.view.offset = 0
    this.indexView.offset = 0
    this.column = 0
    this.cursor = 0
  }

  fail(message: string): void {
    this.error = message
    this.result = null
    this.rowCache = null
  }

  /** Every file's counts, for the header. */
  totals(): { files: number; added: number; removed: number } {
    const files = this.result?.files ?? []
    return {
      files: files.length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0)
    }
  }

  /**
   * The patch as a flat list of rows, which is what a scroll offset indexes.
   *
   * Cached against the inputs that change it, because `handleKey` needs the count on
   * every keystroke and re-flattening a four-thousand-line patch to answer "how far can
   * I scroll" would be the one place this view could be made to feel slow.
   */
  rows(width: number): readonly DiffRow[] {
    const cached = this.rowCache
    if (
      cached !== null &&
      cached.width === width &&
      cached.wrap === this.wrap &&
      cached.split === this.split &&
      cached.result === this.result
    ) {
      return cached.rows
    }
    const rows = this.buildRows(width)
    this.rowCache = { rows, width, wrap: this.wrap, split: this.split, result: this.result }
    return rows
  }

  private buildRows(width: number): DiffRow[] {
    const rows: DiffRow[] = []
    const room = Math.max(1, width - GUTTER)
    for (const file of this.result?.files ?? []) {
      if (rows.length > 0) rows.push({ kind: 'blank' })
      rows.push({ kind: 'file', file })
      if (file.binary) {
        rows.push({ kind: 'note', file, text: 'binary file — not shown' })
        continue
      }
      for (const hunk of file.hunks) {
        rows.push({ kind: 'hunk', file, text: hunk.header })
        if (this.split) {
          rows.push(...pairLines(file, hunk.lines))
          continue
        }
        for (const line of hunk.lines) {
          rows.push({ kind: 'line', file, line })
          if (!this.wrap) continue
          // The first segment rides on the `line` row; the rest become `wrap` rows, so
          // a wrapped line's gutter is drawn once rather than repeated down the page.
          for (const segment of wrapWords(line.text, room).slice(1)) {
            rows.push({ kind: 'wrap', file, line, text: segment })
          }
        }
      }
      if (file.truncated) rows.push({ kind: 'note', file, text: 'truncated — the rest is not shown' })
    }
    return rows
  }

  /** The row index each file's header sits at, for `]` and `[`. */
  private fileStarts(width: number): number[] {
    const starts: number[] = []
    this.rows(width).forEach((row, index) => {
      if (row.kind === 'file') starts.push(index)
    })
    return starts
  }

  handleKey(name: string, char: string | undefined, area: Rect): DiffOutcome {
    this.note = null
    const height = Math.max(1, this.areas(this.bodyArea(area)).patch.height)
    const width = this.bodyWidth(area)
    const count = this.rows(width).length

    switch (name) {
      case 'escape':
      case 'q':
        return { kind: 'close' }
      case 'down':
        this.view.by(1, count, height)
        return NOTHING
      case 'up':
        this.view.by(-1, count, height)
        return NOTHING
      case 'pagedown':
        this.view.by(height, count, height)
        return NOTHING
      case 'pageup':
        this.view.by(-height, count, height)
        return NOTHING
      case 'home':
        this.view.offset = 0
        return NOTHING
      case 'end':
        this.view.by(count, count, height)
        return NOTHING
      case 'left':
        if (!this.wrap) this.column = Math.max(0, this.column - 8)
        return NOTHING
      case 'right':
        if (!this.wrap) this.column += 8
        return NOTHING
      default:
        break
    }

    switch (char) {
      case 'j':
        this.view.by(1, count, height)
        return NOTHING
      case 'k':
        this.view.by(-1, count, height)
        return NOTHING
      case ']':
        this.jump(1, width, height)
        return NOTHING
      case '[':
        this.jump(-1, width, height)
        return NOTHING
      case 'i':
        // A toggle as well as an auto-hide: on a wide terminal somebody reading one
        // long file wants the columns back without resizing the window.
        this.showIndex = !this.showIndex
        this.rowCache = null
        this.column = 0
        return NOTHING
      case 'w':
        this.wrap = !this.wrap
        this.column = 0
        this.rowCache = null
        return NOTHING
      case 't':
        // Refusing is the honest answer: two thirty-four-column halves is the geometry
        // this overlay exists to escape, and drawing it would look like a bug.
        if (!this.split && this.bodyWidth(area) < MIN_SPLIT_WIDTH) {
          this.note = `side-by-side needs ${MIN_SPLIT_WIDTH} columns`
          return NOTHING
        }
        this.split = !this.split
        this.rowCache = null
        this.column = 0
        return NOTHING
      case 's':
        this.staged = !this.staged
        return { kind: 'toggleStaged', staged: this.staged }
      case 'r':
        return { kind: 'refresh' }
      case 'e': {
        const file = this.currentFile()
        if (file === null) return NOTHING
        return { kind: 'edit', path: file.path, line: firstChangedLine(file) }
      }
      case 'P': {
        const file = this.currentFile()
        if (file === null) return NOTHING
        return { kind: 'pager', path: file.path, staged: this.staged }
      }
      default:
        return NOTHING
    }
  }

  /** The file the cursor is on. */
  currentFile(): DiffFile | null {
    const files = this.result?.files ?? []
    return files[Math.min(this.cursor, files.length - 1)] ?? null
  }

  /** Move the cursor one file, wrapping, and scroll only as far as it takes to see it. */
  private jump(delta: number, width: number, height: number): void {
    const starts = this.fileStarts(width)
    if (starts.length === 0) return
    this.cursor = (this.cursor + delta + starts.length) % starts.length
    this.scrollToCursor(width, height)
  }

  handleClick(column: number, row: number, area: Rect): DiffOutcome {
    const inside =
      column >= area.x && column < area.x + area.width && row >= area.y && row < area.y + area.height
    // A click outside a modal dismisses it, as the settings dialog already does.
    if (!inside) return { kind: 'close' }

    const body = this.bodyArea(area)
    const { index, patch } = this.areas(body)
    if (index === null || column < index.x || column >= index.x + index.width) return NOTHING

    // A click in the index scrolls the patch to that file. `indexAt` resolves through
    // the list's own offset, so what is clicked is what was drawn rather than the row
    // that would have been there with no scrolling.
    const files = this.result?.files ?? []
    const height = Math.max(0, index.height - INDEX_TOP)
    const at = this.indexView.indexAt(row, index.y + INDEX_TOP, files.length, height)
    if (at === null) return NOTHING
    this.cursor = at
    this.scrollToCursor(this.bodyWidth(area), patch.height)
    return NOTHING
  }

  /** Put the cursor's file at the top of the patch, or as near as the end allows. */
  private scrollToCursor(width: number, height: number): void {
    const starts = this.fileStarts(width)
    const start = starts[this.cursor]
    if (start === undefined) return
    // `offset` then `clamp`, not `follow`: clicking a file should put its header on the
    // first row, not merely somewhere on screen — which is what `follow` would do for a
    // file that is already visible, leaving the click looking like it did nothing.
    this.view.offset = start
    this.view.clamp(this.rows(width).length, height)
  }

  scrollBy(delta: number, area: Rect): void {
    const height = Math.max(1, this.areas(this.bodyArea(area)).patch.height)
    this.view.by(delta, this.rows(this.bodyWidth(area)).length, height)
  }

  /**
   * How the overlay divides: the file index on the left, the patch on the right.
   *
   * The same shape `panel.ts:previewAreas` uses for the tree beside the preview, and
   * for the same reason — a narrow list plus a wide viewer is what makes either one
   * useful. The index is dropped rather than squeezed when the terminal cannot hold
   * both: half an index next to half a patch is two things nobody can read.
   */
  areas(body: Rect): { index: Rect | null; patch: Rect } {
    if (!this.showIndex || body.width < INDEX_WIDTH + 1 + MIN_PATCH_WIDTH) {
      return { index: null, patch: body }
    }
    return {
      index: { x: body.x, y: body.y, width: INDEX_WIDTH, height: body.height },
      patch: {
        x: body.x + INDEX_WIDTH + 1,
        y: body.y,
        width: body.width - INDEX_WIDTH - 1,
        height: body.height
      }
    }
  }

  /** The body under the header: what `areas` divides. */
  private bodyArea(area: Rect): Rect {
    return { x: area.x, y: area.y + LIST_TOP, width: area.width, height: Math.max(0, area.height - LIST_TOP) }
  }

  /** Columns the patch itself gets, once the index and the scrollbar are reserved. */
  private bodyWidth(area: Rect): number {
    return Math.max(1, this.areas(this.bodyArea(area)).patch.width - 1)
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    buffer.fill(area, ' ', palette.sidebar)
    const right = area.x + area.width
    buffer.writeString(area.x, area.y, truncate(this.headline(), area.width), palette.sidebarActive, right)

    const said = this.note ?? this.error ?? this.result?.note ?? null
    if (said !== null) {
      buffer.writeString(area.x, area.y + 1, truncate(said, area.width), styleFor(palette, 'note'), right)
    }

    if (this.error !== null) return
    const body = this.bodyArea(area)
    const { index, patch } = this.areas(body)
    if (index !== null) {
      const scrolled = this.renderIndex(buffer, index, palette)
      // A rule between the two, in the same dim the hunk headers use. Without it the
      // index's longest path and the patch's leftmost gutter digit read as one column.
      //
      // Dropped when the index is showing a scrollbar: that bar's *track* is also a
      // `│`, one column to the left, and the pair reads as a double rule rather than as
      // a separator and a scrollbar. The bar separates the columns perfectly well alone.
      if (!scrolled) {
        for (let i = 0; i < body.height; i += 1) {
          buffer.writeString(index.x + index.width, body.y + i, '│', styleFor(palette, 'gutter'), patch.x)
        }
      }
    }
    const width = this.bodyWidth(area)
    const rows = this.rows(width)
    if (rows.length === 0) {
      buffer.writeString(patch.x, patch.y, truncate('no changes', patch.width), styleFor(palette, 'note'), right)
      return
    }
    const offset = this.view.clamp(rows.length, patch.height)
    for (let i = 0; i < patch.height; i += 1) {
      const row = rows[offset + i]
      if (row === undefined) break
      this.paintRow(buffer, { x: patch.x, y: patch.y + i, width, height: 1 }, row, palette)
    }
    if (needsScrollbar(rows.length, patch.height)) {
      renderScrollbar(
        buffer,
        { x: patch.x + patch.width - 1, y: patch.y, width: 1, height: patch.height },
        offset,
        rows.length,
        palette
      )
    }
  }

  /**
   * The standing list of what is in this patch.
   *
   * It is the answer to "what did this agent touch", which the patch itself only gives
   * you a page at a time. The cursor here and the `▸` in the patch are the same cursor,
   * so `]`, `[` and a click all move one thing.
   */
  /** Returns whether it drew a scrollbar, which decides who owns the dividing column. */
  private renderIndex(buffer: ScreenBuffer, area: Rect, palette: Palette): boolean {
    const right = area.x + area.width
    const files = this.result?.files ?? []
    buffer.writeString(
      area.x,
      area.y,
      truncate(`Changes (${files.length})`, area.width),
      styleFor(palette, 'file'),
      right
    )
    const height = Math.max(0, area.height - INDEX_TOP)
    if (height === 0) return false
    const offset = this.indexView.follow(this.cursor, files.length, height)
    const bar = needsScrollbar(files.length, height)
    // One column for the scrollbar when there is one, plus the letter and its space.
    const room = area.width - 2 - (bar ? 1 : 0)
    for (let i = 0; i < height; i += 1) {
      const file = files[offset + i]
      if (file === undefined) break
      const y = area.y + INDEX_TOP + i
      const selected = offset + i === this.cursor
      const rowStyle = selected ? palette.sidebarActive : palette.sidebar
      buffer.fill({ x: area.x, y, width: area.width, height: 1 }, ' ', rowStyle)
      // The letter keeps its own colour unless the row is selected, where the
      // selection's background owns the whole row — `scm.ts` makes the same call.
      buffer.writeString(area.x, y, file.letter, selected ? rowStyle : letterStyle(file.letter, palette), right)
      buffer.writeString(area.x + 2, y, tail(file.path, room), rowStyle, right)
    }
    if (bar) {
      renderScrollbar(
        buffer,
        { x: right - 1, y: area.y + INDEX_TOP, width: 1, height },
        offset,
        files.length,
        palette
      )
    }
    return bar
  }

  /**
   * The one line that answers the question the overlay exists for.
   *
   * `Changes — claude · working · pane 2 · main · 4 files  +87 −21`, degrading to
   * `Changes — pane 2 · …` in a pane with no agent. The agent comes first because it is
   * what the reader is asking about; the counts come last because they are a summary of
   * what is already drawn below.
   */
  private headline(): string {
    if (this.error !== null) return 'Changes'
    const subject = this.subject
    const parts: string[] = []
    if (subject !== null) {
      if (subject.agent !== null) parts.push(subject.agent)
      if (subject.agentStatus !== null) parts.push(subject.agentStatus)
      parts.push(subject.pane)
    }
    const branch = this.result?.branch ?? ''
    if (branch.length > 0) parts.push(branch)
    if (this.staged) parts.push('staged')
    const { files, added, removed } = this.totals()
    parts.push(files === 1 ? '1 file' : `${files} files`)
    const head = `Changes — ${parts.join(' · ')}  +${added} −${removed}`
    return subject?.ownWorktree === true ? `${head}  [worktree]` : head
  }

  private paintRow(buffer: ScreenBuffer, rect: Rect, row: DiffRow, palette: Palette): void {
    const right = rect.x + rect.width
    switch (row.kind) {
      case 'blank':
        return
      case 'file': {
        const origin = row.file.origin === null ? '' : `${row.file.origin} → `
        const marker = row.file === this.currentFile() ? '▸' : ' '
        const text = `${marker}${row.file.letter}  ${origin}${row.file.path}`
        const counts = `+${row.file.added} −${row.file.removed}`
        const style = styleFor(palette, 'file')
        buffer.fill(rect, ' ', style)
        buffer.writeString(rect.x, rect.y, truncate(text, Math.max(0, rect.width - counts.length - 1)), style, right)
        if (rect.width > counts.length) {
          buffer.writeString(right - counts.length, rect.y, counts, style, right)
        }
        return
      }
      case 'hunk':
        buffer.writeString(rect.x, rect.y, truncate(row.text, rect.width), styleFor(palette, 'hunk'), right)
        return
      case 'note':
        buffer.writeString(rect.x + GUTTER, rect.y, truncate(row.text, rect.width - GUTTER), styleFor(palette, 'note'), right)
        return
      case 'wrap':
        this.paintText(buffer, rect.y, rect.x + GUTTER, rect.width - GUTTER, row.line.kind, row.text, palette, false)
        return
      case 'line':
        this.paintGutter(buffer, rect, row.line, palette)
        this.paintText(
          buffer,
          rect.y,
          rect.x + GUTTER,
          rect.width - GUTTER,
          row.line.kind,
          row.line.text,
          palette,
          row.line.noNewline === true
        )
        return
      case 'pair': {
        // One column of rule between the halves, so a half is `(width - 1) / 2`.
        const half = Math.floor((rect.width - 1) / 2)
        const leftRect: Rect = { x: rect.x, y: rect.y, width: half, height: 1 }
        const rightRect: Rect = { x: rect.x + half + 1, y: rect.y, width: rect.width - half - 1, height: 1 }
        this.paintSide(buffer, leftRect, row.left, palette, 'old')
        buffer.writeString(rect.x + half, rect.y, '│', styleFor(palette, 'gutter'), rect.x + half + 1)
        this.paintSide(buffer, rightRect, row.right, palette, 'new')
        return
      }
    }
  }

  /** One half of a side-by-side row. A null line is an empty half, not a blank line. */
  private paintSide(
    buffer: ScreenBuffer,
    rect: Rect,
    line: DiffLine | null,
    palette: Palette,
    side: 'old' | 'new'
  ): void {
    if (line === null) return
    const number = side === 'old' ? line.old : line.new
    buffer.writeString(
      rect.x,
      rect.y,
      (number === null ? '' : String(number)).padStart(4),
      styleFor(palette, 'gutter'),
      rect.x + SIDE_GUTTER
    )
    this.paintText(buffer, rect.y, rect.x + SIDE_GUTTER, rect.width - SIDE_GUTTER, line.kind, line.text, palette, line.noNewline === true)
  }

  private paintGutter(buffer: ScreenBuffer, rect: Rect, line: DiffLine, palette: Palette): void {
    const old = line.old === null ? '' : String(line.old)
    const fresh = line.new === null ? '' : String(line.new)
    const text = `${old.padStart(4)} ${fresh.padStart(4)}`
    buffer.writeString(rect.x, rect.y, text, styleFor(palette, 'gutter'), rect.x + GUTTER)
  }

  /** `x` and `room` are the text's own bounds — the caller has already spent its gutter. */
  private paintText(
    buffer: ScreenBuffer,
    y: number,
    x: number,
    room: number,
    kind: DiffLine['kind'],
    text: string,
    palette: Palette,
    noNewline: boolean
  ): void {
    const style = styleFor(palette, kind)
    if (room <= 0) return
    // A sign column, so the diff still reads correctly in a terminal whose theme makes
    // the two colours hard to tell apart — and when it is copied out as plain text.
    const sign = kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
    const shown = this.wrap ? text : sliceColumns(text, this.column)
    const body = `${sign}${expandTabs(shown)}${noNewline ? ' ↵̸' : ''}`
    buffer.fill({ x, y, width: room, height: 1 }, ' ', style)
    buffer.writeString(x, y, truncate(body, room), style, x + room)
  }
}

/**
 * Lay a hunk's lines out in two columns.
 *
 * A change is a run of deletions immediately followed by a run of additions, and the
 * two runs are the *same* edit seen from either side — so they are zipped row for row
 * and the shorter one is padded with blanks. Context lines appear on both sides, which
 * is what keeps the two columns vertically aligned: without that, one extra addition
 * near the top would slide every later line on the right out of step with its
 * counterpart and the layout would stop meaning anything.
 */
function pairLines(file: DiffFile, lines: readonly DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] as DiffLine
    if (line.kind === 'ctx') {
      rows.push({ kind: 'pair', file, left: line, right: line })
      index += 1
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (index < lines.length && (lines[index] as DiffLine).kind === 'del') {
      dels.push(lines[index] as DiffLine)
      index += 1
    }
    while (index < lines.length && (lines[index] as DiffLine).kind === 'add') {
      adds.push(lines[index] as DiffLine)
      index += 1
    }
    for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
      rows.push({ kind: 'pair', file, left: dels[i] ?? null, right: adds[i] ?? null })
    }
  }
  return rows
}

/**
 * The line an editor should open this file at.
 *
 * The first hunk's first added line, falling back to its new-side start. `git.ts`
 * already computes exactly this server-side for the Source Control view's `e`; here the
 * patch is already in hand, so asking the daemon again would be a round trip for an
 * answer we are holding.
 */
function firstChangedLine(file: DiffFile): number {
  const hunk = file.hunks[0]
  if (hunk === undefined) return 1
  for (const line of hunk.lines) {
    if (line.kind === 'add' && line.new !== null) return line.new
    if (line.kind === 'del' && line.old !== null) return Math.max(1, line.old)
  }
  return Math.max(1, hunk.newStart)
}

/**
 * A tab is eight columns of nothing, and a terminal handed one moves the cursor.
 *
 * `writeString` would emit the byte and the terminal would advance to its own next tab
 * stop, which is not where this buffer thinks the cursor is — so every cell after it on
 * the row would be wrong. Four, not eight: indentation is what tabs are for here and a
 * deep nest at eight would spend the whole width on whitespace.
 */
function expandTabs(text: string): string {
  return text.includes('\t') ? text.replace(/\t/gu, '    ') : text
}

type Role = 'add' | 'del' | 'ctx' | 'file' | 'hunk' | 'gutter' | 'note'

/**
 * Colour by role, borrowing the theme's green and red from the agent palette.
 *
 * `scm.ts:letterStyle` does exactly this for the status letters, and for the same
 * reason: those *are* the theme's green and red, chosen by whoever wrote the theme, and
 * a second pair of keys would be a second place to get them wrong.
 */
function styleFor(palette: Palette, role: Role): Style {
  switch (role) {
    case 'add':
      return palette.agent['done'] ?? palette.sidebar
    case 'del':
      return palette.agent['blocked'] ?? palette.sidebar
    case 'file':
      return palette.sidebarActive
    case 'hunk':
    case 'gutter':
    case 'note':
      return palette.idleBorder
    case 'ctx':
      return palette.sidebar
  }
}

/**
 * Nearly the whole screen, with a margin that proves it is a window over something.
 *
 * Two columns rather than the settings dialog's wider inset: this is the one overlay
 * whose content is wide by nature, and every column given back to the margin is a
 * column of code that has to be scrolled to instead.
 */
export function diffArea(cols: number, rows: number): Rect {
  const width = Math.max(20, cols - 4)
  const height = Math.max(6, rows - 4)
  return {
    x: Math.max(0, Math.floor((cols - width) / 2)),
    y: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height
  }
}
