/**
 * The Search view: quick open, and content search.
 *
 * Both of herdr-sidebar's search surfaces (MIT), in one panel with two modes. See
 * `NOTICE`. Quick open is `Ctrl+P` and filters a cached file list as you type; content
 * search is `Ctrl+F` and runs once per submit. They share a panel because they share
 * everything else: the dock, the result list, the way a result opens.
 *
 * ## Why quick open filters here and content search does not
 *
 * The file list is one RPC when the mode opens, and every keystroke after that is a
 * string compare against an array already in memory. A round trip per keystroke over
 * twenty thousand paths would be a network call to answer a question the client can
 * answer. Content search is the opposite: it reads every file under the root, so it
 * runs when you press Enter and not before.
 *
 * ## State here, actions at the call site
 *
 * The same split as `ScmPanel` and `ExplorerPanel`: this decides what a keystroke
 * *means* and performs nothing. The app owns every RPC.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { SearchContentResult, SearchFilesResult } from '@leap-chorus/protocol'
import { wrapWords, type Palette } from './chrome.js'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'

/**
 * A keystroke, with the modifiers this view needs and the others already resolved.
 *
 * Richer than the `(name, char)` pair the tree and the changes list take, because this
 * is the one view with text fields *and* chorded toggles: `Alt-C` has to be told from
 * a typed `c`, and `Shift-Tab` from `Tab`.
 */
export interface PanelKey {
  readonly name: string
  /** The character typed, or undefined when the keystroke typed none. */
  readonly char: string | undefined
  readonly alt: boolean
  readonly ctrl: boolean
  readonly shift: boolean
}

export type SearchMode = 'quick' | 'content'

/** Which field has the caret. `results` is the list, where digits switch view again. */
export type SearchFocus = 'query' | 'include' | 'exclude' | 'results'

export type SearchOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  /** Load the file list for quick open. One per open, not one per keystroke. */
  | { readonly kind: 'files' }
  /** Run a content search with the current query and options. */
  | { readonly kind: 'search' }
  | { readonly kind: 'open'; readonly path: string; readonly line: number | null }

export interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

/** A drawable line: a file heading, or one match under it. */
interface ResultRow {
  readonly kind: 'file' | 'match'
  readonly path: string
  readonly line: number | null
  readonly text: string
  /** Where the match sits in `text`, for highlighting. */
  readonly start: number
  readonly length: number
}

/**
 * Score a candidate against a lowercased query, subsequence-style.
 *
 * Ported from herdr-sidebar's `fuzzy_score_lowercased`: ten points a character, eight
 * more for staying adjacent to the last one, six for landing on a word boundary, and
 * the candidate's length subtracted at the end so a short path beats a long one that
 * matched the same way. Null when the query is not a subsequence at all.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0
  let wanted = 0
  let score = 0
  let previousMatch = -2
  let previousChar = ''
  for (let index = 0; index < candidate.length; index++) {
    const character = candidate[index] as string
    if (character !== query[wanted]) {
      previousChar = character
      continue
    }
    score += 10
    if (previousMatch === index - 1) score += 8
    if (index === 0 || previousChar === '/' || previousChar === '-' || previousChar === '_' || previousChar === '.') {
      score += 6
    }
    previousMatch = index
    wanted += 1
    if (wanted === query.length) return score - candidate.length
    previousChar = character
  }
  return null
}

/** Rank `files` against `query`: best score first, then shortest, then alphabetical. */
export function rankFiles(files: readonly string[], query: string): string[] {
  if (query === '') return [...files]
  const lowered = query.toLowerCase()
  const ranked: { path: string; score: number }[] = []
  for (const path of files) {
    const score = fuzzyScore(lowered, path.toLowerCase())
    if (score !== null) ranked.push({ path, score })
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path)
  )
  return ranked.map((entry) => entry.path)
}

export class SearchPanel {
  mode: SearchMode = 'content'
  /** The content-search pattern. Separate from the quick-open filter, deliberately. */
  query = ''
  filter = ''
  include = ''
  exclude = ''
  focus: SearchFocus = 'query'
  readonly options: SearchOptions = { matchCase: false, wholeWord: false, regex: false }

  /**
   * The root results are relative to, as the daemon resolved it.
   *
   * Learned from a result rather than asked for: `search.files` and `search.content`
   * both report where they ran, so the panel never has to guess which directory a
   * relative path is relative to.
   */
  root: string | null = null

  /** Null until the file list arrives; the panel shows "listing…" until it does. */
  private files: readonly string[] | null = null
  private filesNote: string | null = null
  private ranked: readonly string[] = []

  private results: SearchContentResult | null = null
  /** The submitted query, so the status line does not describe an edited one. */
  private searched: string | null = null
  busy = false
  error: string | null = null

  private cursor = 0
  private readonly view = new ScrollView()

  // -------------------------------------------------------------------------
  // Mode
  // -------------------------------------------------------------------------

  /** Switch to quick open. Returns the outcome that fetches the list if it is stale. */
  openQuick(): SearchOutcome {
    this.mode = 'quick'
    this.error = null
    this.cursor = 0
    this.view.offset = 0
    this.rerank()
    return this.files === null ? { kind: 'files' } : { kind: 'none' }
  }

  /** Switch to content search, with the caret in the query box. This is `Ctrl+F`. */
  openContent(): SearchOutcome {
    this.mode = 'content'
    this.focus = 'query'
    this.error = null
    this.clampCursor()
    return { kind: 'none' }
  }

  /**
   * Show the view with no box focused, which is where the activity bar lands you.
   *
   * herdr-sidebar is deliberate about this and it is worth keeping: arriving at Search
   * by pressing `2` leaves the digits working as a switcher, so `2` then `1` goes back
   * where you came from. You focus the box on purpose — `Ctrl+F`, Tab, or a click —
   * and from then on `3` is a character you can search for.
   */
  blur(): void {
    this.mode = 'content'
    this.focus = 'results'
    this.clampCursor()
  }

  /**
   * Is a text box focused?
   *
   * The container asks, because a bare `3` must switch view when it is a command and
   * be typed when it is part of a query. herdr-sidebar draws the line in the same
   * place: digits switch only while the search box is *not* focused.
   */
  textFocused(): boolean {
    return this.mode === 'quick' || this.focus !== 'results'
  }

  // -------------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------------

  adoptFiles(result: SearchFilesResult): void {
    this.files = result.files
    this.error = null
    this.filesNote =
      result.cap === null
        ? null
        : result.cap === 'time'
          ? 'listing stopped at the time limit'
          : `only the first ${result.files.length} files are listed`
    this.rerank()
  }

  adoptResults(result: SearchContentResult, query: string): void {
    this.results = result
    this.searched = query
    this.busy = false
    this.error = null
    this.cursor = 0
    this.view.offset = 0
    this.clampCursor()
  }

  fail(message: string): void {
    this.error = message
    this.busy = false
  }

  private rerank(): void {
    this.ranked = rankFiles(this.files ?? [], this.filter)
    this.clampCursor()
  }

  /** Editing anything that feeds a search invalidates the results it produced. */
  private invalidate(): void {
    this.results = null
    this.searched = null
    this.error = null
    this.cursor = 0
    this.view.offset = 0
  }

  // -------------------------------------------------------------------------
  // Rows
  // -------------------------------------------------------------------------

  /** The flattened content-search list: a heading per file, a row per match. */
  rows(): ResultRow[] {
    const results = this.results
    if (results === null) return []
    const rows: ResultRow[] = []
    for (const file of results.files) {
      rows.push({
        kind: 'file',
        path: file.path,
        line: null,
        text: `${file.path} (${file.matches.length})`,
        start: 0,
        length: 0
      })
      for (const match of file.matches) {
        rows.push({
          kind: 'match',
          path: file.path,
          line: match.line,
          text: match.text,
          start: Math.max(0, match.displayColumn - 1),
          length: match.displayMatchLength
        })
      }
    }
    return rows
  }

  /** How many rows the current mode's list has. */
  private count(): number {
    return this.mode === 'quick' ? this.ranked.length : this.rows().length
  }

  selectedPath(): string | null {
    if (this.mode === 'quick') return this.ranked[this.cursor] ?? null
    return this.rows()[this.cursor]?.path ?? null
  }

  private clampCursor(): void {
    const count = this.count()
    if (count === 0) {
      this.cursor = 0
      return
    }
    this.cursor = Math.min(Math.max(this.cursor, 0), count - 1)
    if (this.mode === 'content') {
      // A heading is a label for the rows under it, never a destination.
      const rows = this.rows()
      if (rows[this.cursor]?.kind !== 'match') {
        const next = rows.findIndex((row, index) => index >= this.cursor && row.kind === 'match')
        const previous = rows.findLastIndex((row, index) => index <= this.cursor && row.kind === 'match')
        this.cursor = next !== -1 ? next : previous !== -1 ? previous : 0
      }
    }
  }

  private move(delta: number): void {
    const count = this.count()
    if (count === 0) return
    let next = this.cursor
    for (let step = 0; step < count; step++) {
      next += delta
      if (next < 0 || next >= count) return
      if (this.mode === 'quick' || this.rows()[next]?.kind === 'match') {
        this.cursor = next
        return
      }
    }
  }

  // -------------------------------------------------------------------------
  // Keys
  // -------------------------------------------------------------------------

  handleKey(key: PanelKey): SearchOutcome {
    // Toggles first: `Alt-C` must never reach the query box as a typed `c`.
    if (key.alt && !key.ctrl) {
      const letter = key.char?.toLowerCase()
      if (letter === 'c' || letter === 'w' || letter === 'r') {
        if (letter === 'c') this.options.matchCase = !this.options.matchCase
        if (letter === 'w') this.options.wholeWord = !this.options.wholeWord
        if (letter === 'r') this.options.regex = !this.options.regex
        // A toggle changes what the results *would* be, so the ones on screen are no
        // longer an answer to anything. Dropping them beats leaving a stale set that
        // silently disagrees with the toggle row above it.
        this.invalidate()
        return this.query.trim() === '' ? { kind: 'none' } : { kind: 'search' }
      }
      return { kind: 'none' }
    }
    return this.mode === 'quick' ? this.quickKey(key) : this.contentKey(key)
  }

  private quickKey(key: PanelKey): SearchOutcome {
    if (key.name === 'escape') return { kind: 'close' }
    if (key.name === 'up') {
      this.move(-1)
      return { kind: 'none' }
    }
    if (key.name === 'down') {
      this.move(1)
      return { kind: 'none' }
    }
    if (key.name === 'enter') {
      const path = this.ranked[this.cursor]
      return path === undefined ? { kind: 'none' } : { kind: 'open', path, line: null }
    }
    if (key.name === 'backspace') {
      this.filter = this.filter.slice(0, -1)
      this.cursor = 0
      this.rerank()
      return { kind: 'none' }
    }
    if (key.char !== undefined && !key.ctrl && key.char.length === 1 && key.char >= ' ') {
      this.filter += key.char
      this.cursor = 0
      this.rerank()
      return { kind: 'none' }
    }
    return { kind: 'none' }
  }

  private contentKey(key: PanelKey): SearchOutcome {
    if (key.name === 'escape') return { kind: 'close' }
    if (key.name === 'tab') {
      this.focus = key.shift ? BACKWARD[this.focus] : FORWARD[this.focus]
      return { kind: 'none' }
    }
    if (key.name === 'up' || key.name === 'down') {
      const delta = key.name === 'up' ? -1 : 1
      if (this.focus !== 'results') {
        // Down out of a field lands on the results, which is where the arrows mean
        // something. Up does not, because there is nothing above the query box.
        if (delta === 1 && this.rows().length > 0) this.focus = 'results'
        return { kind: 'none' }
      }
      this.move(delta)
      return { kind: 'none' }
    }
    if (key.name === 'enter') {
      if (this.focus === 'results') {
        const row = this.rows()[this.cursor]
        return row === undefined || row.line === null
          ? { kind: 'none' }
          : { kind: 'open', path: row.path, line: row.line }
      }
      if (this.query.trim() === '' || this.busy) return { kind: 'none' }
      this.busy = true
      this.error = null
      return { kind: 'search' }
    }
    if (key.name === 'backspace') {
      this.edit((value) => value.slice(0, -1))
      return { kind: 'none' }
    }
    if (key.char !== undefined && !key.ctrl && key.char.length === 1 && key.char >= ' ' && this.focus !== 'results') {
      const character = key.char
      this.edit((value) => value + character)
      return { kind: 'none' }
    }
    return { kind: 'none' }
  }

  private edit(change: (value: string) => string): void {
    if (this.focus === 'query') this.query = change(this.query)
    else if (this.focus === 'include') this.include = change(this.include)
    else if (this.focus === 'exclude') this.exclude = change(this.exclude)
    else return
    this.invalidate()
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  /** Put the cursor on a clicked row, and say whether it landed on one. */
  clickRow(screenRow: number, area: Rect): boolean {
    const top = area.y + this.listTop()
    const index = this.view.indexAt(screenRow, top, this.count(), Math.max(0, area.height - this.listTop()))
    if (index === null) return false
    this.cursor = index
    if (this.mode === 'content') this.focus = 'results'
    this.clampCursor()
    return true
  }

  scrollBy(delta: number, area: Rect): void {
    this.view.by(delta, this.count(), Math.max(0, area.height - this.listTop()))
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** What the status bar shows while this view has the keyboard. */
  hint(): string {
    if (this.mode === 'quick') return QUICK_OPEN_HINT
    return this.focus === 'results' ? SEARCH_RESULTS_HINT : SEARCH_TYPING_HINT
  }

  /** Rows of chrome above the list, which differs by mode. */
  private listTop(): number {
    return this.mode === 'quick' ? QUICK_LIST_TOP : CONTENT_LIST_TOP
  }

  /**
   * What the status line says.
   *
   * Never silent about a cap: "1000 matches" and "1000 matches, and there were more"
   * are different facts and a user acting on the first when the second is true will
   * conclude the file they are looking for does not exist.
   */
  statusLine(): string {
    if (this.busy) return 'searching…'
    if (this.mode === 'quick') {
      if (this.files === null) return 'listing…'
      const shown = this.ranked.length
      const note = this.filesNote === null ? '' : ` · ${this.filesNote}`
      return `${shown}/${this.files.length} files${note}`
    }
    const results = this.results
    if (results === null) {
      if (this.query.trim() !== '') return '⏎ to search'
      return this.focus === 'query' ? 'type a query, ⏎ to search' : '^f or tab to type a query'
    }
    if (results.totalMatches === 0) return `no matches for ${this.searched ?? ''}`
    const files = `${results.files.length} file${results.files.length === 1 ? '' : 's'}`
    const capped = results.cap === null ? '' : ` · capped (${results.cap})`
    return `${results.totalMatches} in ${files}${capped}`
  }

  renderInto(buffer: ScreenBuffer, area: Rect, palette: Palette, focused: boolean): void {
    buffer.fill(area, ' ', palette.sidebar)
    const right = area.x + area.width
    const dim = palette.agent['idle'] ?? palette.sidebar

    const field = (y: number, label: string, value: string, active: boolean): void => {
      const style = active && focused ? palette.sidebarActive : palette.sidebar
      const caret = active ? '_' : ''
      // Tail-first, so a long pattern shows the end you are typing rather than its start.
      const room = area.width - label.length - 1
      const shown = `${value}${caret}`
      const text = shown.length > room ? `…${shown.slice(shown.length - room + 1)}` : shown
      buffer.fill({ x: area.x, y, width: area.width, height: 1 }, ' ', style)
      buffer.writeString(area.x, y, truncate(`${active ? '▸' : ' '}${label}${text}`, area.width), style, right)
    }

    if (this.mode === 'quick') {
      field(area.y, '', this.filter, true)
    } else {
      field(area.y, '', this.query, this.focus === 'query')
      this.renderToggles(buffer, area, palette, area.y + 1)
      field(area.y + 2, 'inc ', this.include, this.focus === 'include')
      field(area.y + 3, 'exc ', this.exclude, this.focus === 'exclude')
    }

    const statusY = area.y + this.listTop() - 1
    buffer.writeString(area.x, statusY, truncate(this.statusLine(), area.width), dim, right)

    if (this.error !== null) {
      // Wrapped, not clipped: the no-ripgrep message is a sentence whose second half
      // is the install command, and the half that fits is the half that helps least.
      let y = area.y + this.listTop()
      for (const line of wrapWords(this.error, area.width)) {
        if (y >= area.y + area.height) break
        buffer.writeString(area.x, y, line, palette.agent['blocked'] ?? palette.sidebar, right)
        y += 1
      }
      return
    }

    const height = Math.max(0, area.height - this.listTop())
    const count = this.count()
    if (count === 0 || height === 0) return
    const bar = needsScrollbar(count, height)
    const room = area.width - (bar ? 1 : 0)
    const offset = this.view.follow(this.cursor, count, height)
    const listY = area.y + this.listTop()

    if (this.mode === 'quick') {
      for (const [index, path] of this.ranked.slice(offset, offset + height).entries()) {
        const selected = offset + index === this.cursor
        const style = selected && focused ? palette.sidebarActive : palette.sidebar
        buffer.fill({ x: area.x, y: listY + index, width: room, height: 1 }, ' ', style)
        buffer.writeString(area.x, listY + index, tail(path, room), style, right)
      }
    } else {
      const rows = this.rows()
      for (const [index, row] of rows.slice(offset, offset + height).entries()) {
        const y = listY + index
        if (row.kind === 'file') {
          buffer.writeString(area.x, y, tail(row.path, room), palette.paneTitle, right)
          continue
        }
        const selected = offset + index === this.cursor
        const style = selected && focused ? palette.sidebarActive : palette.sidebar
        buffer.fill({ x: area.x, y, width: room, height: 1 }, ' ', style)
        const gutter = `${row.line ?? ''}`.padStart(4, ' ')
        buffer.writeString(area.x, y, gutter, selected && focused ? style : dim, right)
        const text = row.text.replace(/\t/gu, ' ').trimEnd()
        buffer.writeString(area.x + 5, y, truncate(text, Math.max(0, room - 5)), style, area.x + room)
      }
    }
    if (bar) {
      renderScrollbar(buffer, { x: area.x + area.width - 1, y: listY, width: 1, height }, offset, count, palette)
    }
  }

  /**
   * The three option chips.
   *
   * `Aa` case, `ab` whole word, `.*` regex — VS Code's glyphs, because they are the
   * ones a person has already learned, and ASCII so no font has to cooperate.
   */
  private renderToggles(buffer: ScreenBuffer, area: Rect, palette: Palette, y: number): void {
    const right = area.x + area.width
    const chips: [string, boolean][] = [
      ['Aa', this.options.matchCase],
      ['ab', this.options.wholeWord],
      ['.*', this.options.regex]
    ]
    let x = area.x + 1
    for (const [label, on] of chips) {
      if (x + 4 > right) break
      buffer.writeString(x, y, `[${label}]`, on ? palette.sidebarActive : (palette.agent['idle'] ?? palette.sidebar), right)
      x += 5
    }
    if (x + 12 <= right) {
      buffer.writeString(x, y, 'alt-c/w/r', palette.agent['idle'] ?? palette.sidebar, right)
    }
  }
}

/** Rows above the list: the query box, the toggles, include, exclude, the status. */
const CONTENT_LIST_TOP = 5
/** Quick open has only the filter box and the count. */
const QUICK_LIST_TOP = 2

const FORWARD: Readonly<Record<SearchFocus, SearchFocus>> = {
  query: 'include',
  include: 'exclude',
  exclude: 'results',
  results: 'query'
}

const BACKWARD: Readonly<Record<SearchFocus, SearchFocus>> = {
  query: 'results',
  include: 'query',
  exclude: 'include',
  results: 'exclude'
}

/**
 * How to tell a pager to start at a line.
 *
 * `+N` is what `less`, `more` and `most` take, and all three are already installed and
 * already configured the way their owner likes — which is the same argument the
 * Explorer makes for opening a file in `$PAGER` at all. A pager nobody here has heard
 * of is opened at the top rather than handed an argument it might read as a filename.
 */
export function pagerArgs(pager: string, file: string, line: number | null): string[] {
  const program = pager.split('/').pop() ?? pager
  const jumps = program === 'less' || program === 'more' || program === 'most'
  return line !== null && line > 0 && jumps ? [`+${line}`, file] : [file]
}

/** `…/deep/file.ts` says more than `packages/client/sr…`. */
function tail(path: string, width: number): string {
  if (width <= 0) return ''
  return path.length <= width ? path : `…${path.slice(path.length - width + 1)}`
}

/** The hint while a text box has the caret: digits are characters, not commands. */
export const SEARCH_TYPING_HINT =
  '⏎ search · tab next field · alt-c/w/r case/word/regex · ^p quick open · esc close'

/** The hint on the results list, where the digits are a view switcher again. */
export const SEARCH_RESULTS_HINT =
  '↑↓ move · ⏎ open at line · ^f edit query · ^p quick open · 1 files · 3 git · esc close'

export const QUICK_OPEN_HINT = 'type to filter · ↑↓ move · ⏎ open · ^f search · esc back'
