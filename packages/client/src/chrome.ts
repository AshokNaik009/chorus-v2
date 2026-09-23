/**
 * The client's own furniture: sidebar, tab bar, status bar.
 *
 * Everything here is presentation and none of it crosses the wire. The daemon knows
 * there are three workspaces; it does not know one of them is drawn on row 4 of a
 * 22-column strip down the left, and it must not, because the next client to attach
 * may be a 60-column phone-sized terminal or an SSH session with a different width.
 *
 * Each function returns the rects it consumed so the caller can lay out what is left,
 * and records where it drew clickable things so a mouse click can be resolved without
 * re-deriving the layout.
 */

import {
  ATTR_BOLD,
  ATTR_DIM,
  ATTR_INVERSE,
  COLOR_DEFAULT,
  DEFAULT_STYLE,
  ScreenBuffer,
  style,
  truncate,
  type Rect,
  type Style
} from '@leap-chorus/tui'
import { DEFAULT_CONFIG, resolveTheme, type Config } from '@leap-chorus/core'
import type { GitRepoSummary, SessionStateSnapshot, WorkspaceRecord } from '@leap-chorus/protocol'
import {
  agentEntries,
  agentGlyph,
  orderedWorkspaces,
  panesOf,
  tabTitle,
  tabsOf,
  workspaceAgentStatus,
  workspaceTitle,
  type AgentEntry
} from './model.js'
import { workspaceHues } from './palette.js'

/** Where a click lands. Filled while drawing, read when a click arrives. */
export interface HitRegions {
  /** Row -> workspace id, for the sidebar. */
  readonly workspaceRows: Map<number, string>
  /** Row -> tab id, for the sidebar's nested tabs. */
  readonly sidebarTabRows: Map<number, string>
  /** Column range -> tab id, for the tab bar. */
  readonly tabSpans: Array<{ readonly x: number; readonly end: number; readonly tabId: string }>
  /** Which row the tab bar occupies, or -1. */
  tabBarRow: number
  /** The sidebar's "new workspace" row, or -1. */
  newWorkspaceRow: number
  /**
   * The sidebar's action row: `new` on the left, `▤ files` in the middle, `menu` right.
   *
   * `files` is null when the strip is too narrow to hold it, which is why it is a span
   * rather than a pair of columns — the click handler must not guess at where it would
   * have been.
   */
  actionRow: {
    readonly row: number
    readonly newEnd: number
    readonly menuStart: number
    readonly files: { readonly x: number; readonly end: number } | null
  } | null
  /** The `«` that collapses the sidebar. */
  collapse: { readonly x: number; readonly end: number; readonly y: number } | null
  /**
   * The resize grips: the only places a drag may begin.
   *
   * Requiring a grip is not decoration. Starting a resize from anywhere on a border
   * means every click near one is a potential drag, and with motion reporting on, a
   * pointer that merely passes by keeps resizing — which is exactly the mess this
   * replaced. A grip is a small, visible, deliberate target.
   */
  readonly grips: Array<{
    readonly x: number
    readonly y: number
    readonly kind: 'sidebar' | 'divider'
    /** For a divider grip: which split, and which way it moves. */
    readonly path?: readonly boolean[]
    readonly direction?: 'horizontal' | 'vertical'
  }>
  /** Row -> the agent pane to jump to, for the sidebar's agents section. */
  readonly agentRows: Map<number, { readonly paneId: string; readonly workspaceId: string }>
  /** Column range on a workspace row that closes it. */
  readonly workspaceCloseSpans: Array<{
    readonly x: number
    readonly end: number
    readonly y: number
    readonly workspaceId: string
  }>
  /** The tab bar's "new tab" button, or null when the bar is hidden. */
  newTabSpan: { readonly x: number; readonly end: number } | null
  /** Buttons drawn on a pane's top border. */
  readonly paneButtons: Array<{
    readonly x: number
    readonly end: number
    readonly y: number
    readonly paneId: string
    readonly action: PaneButtonAction
  }>
}

/** What a pane's border buttons do. */
export type PaneButtonAction = 'split-right' | 'split-down' | 'close'

export function emptyHitRegions(): HitRegions {
  return {
    workspaceRows: new Map(),
    sidebarTabRows: new Map(),
    tabSpans: [],
    tabBarRow: -1,
    newWorkspaceRow: -1,
    actionRow: null,
    collapse: null,
    grips: [],
    agentRows: new Map(),
    workspaceCloseSpans: [],
    newTabSpan: null,
    paneButtons: []
  }
}

/**
 * Break `text` onto lines of at most `width`, on spaces where possible.
 *
 * A word longer than the whole width — a path, usually — is hard-split rather than
 * dropped, so the line count is bounded and nothing disappears.
 */
export function wrapWords(text: string, width: number): string[] {
  if (width <= 0) return []
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter((part) => part.length > 0)) {
    if (line.length === 0) {
      line = word
    } else if (line.length + 1 + word.length <= width) {
      line = `${line} ${word}`
    } else {
      lines.push(line)
      line = word
    }
    while (line.length > width) {
      lines.push(line.slice(0, width))
      line = line.slice(width)
    }
  }
  if (line.length > 0) lines.push(line)
  return lines
}

export interface Palette {
  readonly focusBorder: Style
  readonly idleBorder: Style
  readonly paneTitle: Style
  readonly status: Style
  readonly sidebar: Style
  readonly sidebarActive: Style
  readonly tabActive: Style
  readonly tabIdle: Style
  /**
   * The inset surface a sidebar section is drawn on.
   *
   * A section is a **card**, and a card is a background tint. Without it the workspace
   * list and the agents list are two headings in one undifferentiated column, and the
   * blank space under the last entry reads as the screen having run out of content
   * rather than as the end of the list.
   */
  readonly card: Style
  /** Keyed by agent status. An unknown status has no colour, only its glyph. */
  readonly agent: Readonly<Record<string, Style>>
}

/**
 * The card tint when the theme has no surface of its own.
 *
 * A named theme carries one — `tab-idle-bg` is its `surface` role, one step off its
 * base — so cards there are exactly the colour the theme author chose. The `terminal`
 * theme has no colours at all: every field is `-1`, the terminal's own. There is no way
 * to ask a terminal whether its background is light or dark, so this picks the dark
 * answer, which is the same assumption `sidebar-fg = 7` and `idle-border = 8` have made
 * since phase 4. Somebody on a light terminal sets `[theme] name` or `tab-idle-bg` and
 * gets a card that matches.
 */
export const CARD_SURFACE = 235

export function paletteOf(config: Config): Palette {
  // A named theme supplies the colours; explicit `[theme]` keys override it. Resolved
  // here, at the one place colours become styles, so nothing downstream has to know a
  // theme exists.
  const theme = resolveTheme(config.themeName, config.theme, DEFAULT_CONFIG.theme)
  return {
    focusBorder: style({ fg: theme.focusBorder }),
    idleBorder: style({ fg: theme.idleBorder }),
    paneTitle: style({ fg: theme.paneTitle }),
    status: style({ fg: theme.statusFg, bg: theme.statusBg }),
    sidebar: style({ fg: theme.sidebarFg, bg: theme.sidebarBg }),
    sidebarActive: style({ fg: theme.sidebarActiveFg, bg: theme.sidebarActiveBg }),
    tabActive: style({ fg: theme.tabActiveFg, bg: theme.tabActiveBg }),
    tabIdle: style({ fg: theme.tabIdleFg, bg: theme.tabIdleBg }),
    card: style({
      fg: theme.sidebarFg,
      bg: theme.tabIdleBg === COLOR_DEFAULT ? CARD_SURFACE : theme.tabIdleBg
    }),
    agent: {
      idle: style({ fg: theme.agentIdle }),
      working: style({ fg: theme.agentWorking }),
      blocked: style({ fg: theme.agentBlocked }),
      done: style({ fg: theme.agentDone }),
      unknown: style({ fg: theme.agentIdle })
    }
  }
}

/**
 * Invert a style when the pointer is over it.
 *
 * Reverse video rather than a configured colour, and applied *on top of* whatever the
 * row already is, so it reads correctly against every theme, against the card tint and
 * against both the active and the inactive row. One rule, three states, no new palette
 * entry.
 */
function hovered(base: Style, isHovered: boolean): Style {
  return isHovered ? { ...base, attrs: base.attrs | ATTR_INVERSE } : base
}

/** The same style with a different foreground: keeps the row's background and attributes. */
function tint(base: Style, fg: number): Style {
  return { ...base, fg }
}

/** The same style, one attribute louder. Weight composes with hover and with the card. */
function weight(base: Style, attrs: number): Style {
  return { ...base, attrs: base.attrs | attrs }
}

/** The style already on a cell, so something drawn over a card keeps the card's tint. */
function styleAt(buffer: ScreenBuffer, x: number, y: number): Style {
  const cell = buffer.get(x, y)
  return { fg: cell.fg, bg: cell.bg, attrs: cell.attrs }
}

// ---------------------------------------------------------------------------
// The workspace strip
// ---------------------------------------------------------------------------

/**
 * The grid every row of the strip is drawn on.
 *
 * Five phases each added a row to this strip and none of them agreed on a column, which
 * is most of why it read as a log rather than as a list. These are the columns, and
 * nothing in the strip is drawn anywhere else:
 *
 * ```
 *  ▌ 1 ● herdr                  2 x     0 mark · 1-2 index · 4 dot · 6 body
 *        main ↑1 *                      6, dimmed: everything subordinate
 *        › 1                            6, the active workspace's tabs
 * ```
 *
 * `MARK_X` doubles as the card's left padding: blank except on the **active** workspace,
 * whose whole entry carries a bar in its own hue. That bar is the selection. A
 * full-width accent background would have fought the card tint it sits on, and hue is
 * already identity, so putting the selection in that column costs nothing and says both
 * things at once.
 */
const MARK_X = 0
const INDEX_X = 1
const INDEX_WIDTH = 2
const DOT_X = 4
const BODY_X = 6
/** One column kept clear down the right, mirroring `MARK_X`. The grip lives in it. */
const RIGHT_PAD = 1

/** The bar down the left of the active workspace's entry. */
const ACTIVE_MARK = '▌'

/**
 * A working tree with tracked changes in it.
 *
 * `*` and not `●`: the filled circle means "an agent is working" two columns to the left
 * on that row's neighbour, and two glyphs that differ only in meaning is how a
 * vocabulary stops being one. `*` is what a shell prompt has marked a dirty tree with
 * for twenty years.
 */
const DIRTY_MARK = '*'

/** Nothing known about any workspace's git state. Shared, so the common case allocates nothing. */
const NO_SUMMARIES: ReadonlyMap<string, GitRepoSummary> = new Map()

export interface SidebarOptions {
  /** Screen row the pointer is over, or -1. */
  readonly hoverRow?: number
  /**
   * Whether hover is reported at all — `[general] mouse-hover`.
   *
   * It decides *where* the per-row chrome goes, not merely whether it lights up. With
   * hover on, the pane count and the `x` belong to the row under the pointer. With it
   * off there is no such row, ever, so they fall back to the **active** workspace —
   * which keeps a visible close target on screen instead of silently deleting one.
   */
  readonly hoverEnabled?: boolean
  /**
   * The sidebar is docked on the right, so its *inner* edge is its first column.
   *
   * The grip and the collapse arrow both live on the inner edge — the one the sidebar
   * resizes and collapses towards. Hard-coding them to the last column was correct for
   * as long as `x` was always 0, and became a grip on the screen's outer edge the moment
   * `[sidebar] dock = "right"` existed.
   */
  readonly dockRight?: boolean
  /**
   * One git headline per workspace id, when the client has fetched them.
   *
   * Empty is a normal state, not a failure: the map is filled by `git.summary` after the
   * first render, and a workspace outside a checkout is simply absent from it. A row
   * with no entry draws no branch line, so the list degrades to names.
   */
  readonly summaries?: ReadonlyMap<string, GitRepoSummary>
}

/** Everything the row drawers need, gathered once so none of them takes nine arguments. */
interface Strip {
  readonly buffer: ScreenBuffer
  readonly area: Rect
  readonly palette: Palette
  readonly hits: HitRegions
  readonly hoverRow: number
  /** First row past the bottom of the strip. */
  readonly limit: number
  readonly width: number
  /** Workspace id -> its colour. See `palette.ts`. */
  readonly hues: ReadonlyMap<string, number>
}

/** Paint one row edge to edge in `base`, so a card's tint covers its gaps too. */
function paintRow(strip: Strip, y: number, base: Style): void {
  strip.buffer.writeString(strip.area.x, y, ' '.repeat(strip.width), base, strip.area.x + strip.width)
}

/** Write inside the strip, clipped to it. `column` is relative to the strip's left edge. */
function put(strip: Strip, column: number, y: number, text: string, base: Style): void {
  strip.buffer.writeString(strip.area.x + column, y, text, base, strip.area.x + strip.width)
}

/** Columns a body line has, after the gutter on its left and the padding on its right. */
function bodyRoom(strip: Strip, reserved = 0): number {
  return Math.max(0, strip.width - BODY_X - RIGHT_PAD - reserved)
}

/**
 * Draw the workspace sidebar.
 *
 * ## What this is, now that it is not a list
 *
 * Two **cards**, each on its own background tint with one column of padding a side,
 * separated by a blank gutter row. `spaces` holds the workspaces, their branches, the
 * active one's tabs and the action row; `agents` holds every agent in the session,
 * worst state first. The untinted blank below the last card is what says *the list
 * ended* rather than *the screen ran out of content*.
 *
 * ## The rhythm
 *
 * **The spacing unit is one row.** One blank row between entries, one above a section
 * header, none below it. The header at the very top of the strip is the only row with
 * no blank above it, because there is nothing above it to be separated from.
 *
 * ## What carries what
 *
 * - **Hue is identity**: a workspace's colour from `workspaceHues`, on its name, its
 *   status dot, its selection bar, and on its agents' dots in the card below.
 * - **Fill and weight are state**: the dot's shape is idle / working / blocked, and the
 *   state *word* in the agents card is the colour of that state. Bold is a thing's own
 *   name; dim is everything subordinate to it; nothing else is coloured at all.
 * - **Chrome appears when it is relevant**: the pane count and the close `x` are drawn
 *   on one row — the hovered one — rather than on every row all of the time. The
 *   workspace *number* is not chrome and stays, dimmed, in its gutter: it is a key you
 *   can press.
 */
export function renderSidebar(
  buffer: ScreenBuffer,
  area: Rect,
  state: SessionStateSnapshot,
  palette: Palette,
  hits: HitRegions,
  options: SidebarOptions = {}
): void {
  if (area.width <= 0 || area.height <= 0) return
  buffer.fill(area, ' ', palette.sidebar)

  const hoverEnabled = options.hoverEnabled ?? true
  const workspaces = orderedWorkspaces(state)
  const strip: Strip = {
    buffer,
    area,
    palette,
    hits,
    hoverRow: hoverEnabled ? (options.hoverRow ?? -1) : -1,
    limit: area.y + area.height,
    width: area.width,
    hues: workspaceHues(workspaces.map((workspace) => workspace.workspaceId))
  }
  const summaries = options.summaries ?? NO_SUMMARIES

  let y = sectionHeader(strip, area.y, 'spaces')
  let first = true
  for (const workspace of workspaces) {
    if (y >= strip.limit) break
    if (!first) y = blankRow(strip, y, palette.card)
    first = false
    y = workspaceEntry(strip, state, workspace, y, summaries, hoverEnabled)
  }
  // The action row is an entry in the rhythm like any other, so it takes a blank above
  // it — including when the list above it is empty and that blank is the card's floor.
  y = blankRow(strip, y, palette.card)
  y = actionRow(strip, y)
  y = agentsCard(strip, state, y)

  // The `«` sits at the bottom, on the edge it collapses towards, where herdr puts it:
  // out of the way of the list. It and the grip both read the style already on the cell,
  // so neither punches a hole in a card that happens to reach the bottom of the strip.
  const collapseY = area.y + area.height - 1
  const collapseX = options.dockRight === true ? area.x : area.x + area.width - 2
  if (collapseY > area.y) {
    const arrow = options.dockRight === true ? '» ' : ' «'
    const base = weight(styleAt(buffer, collapseX, collapseY), ATTR_DIM)
    buffer.writeString(collapseX, collapseY, arrow, hovered(base, collapseY === strip.hoverRow), area.x + area.width)
    hits.collapse = { x: collapseX, end: collapseX + 2, y: collapseY }
  }
  // The grip: three cells at the vertical middle of the sidebar's inner column. Short
  // enough to be a target rather than an edge, long enough to find.
  //
  // Docked left it lands in `RIGHT_PAD`, which is kept clear for exactly this. Docked
  // right the inner edge is `MARK_X`, so for three rows the grip replaces the active
  // workspace's selection bar — the drag target wins, because the bar is repeated on
  // every row of its entry and the grip exists only there.
  const gripX = options.dockRight === true ? area.x : area.x + area.width - 1
  const gripTop = area.y + Math.floor(area.height / 2) - 1
  for (let i = 0; i < 3; i++) {
    const gy = gripTop + i
    if (gy < area.y || gy >= area.y + area.height) continue
    buffer.writeString(gripX, gy, GRIP_VERTICAL, tint(styleAt(buffer, gripX, gy), palette.idleBorder.fg), gripX + 1)
    hits.grips.push({ x: gripX, y: gy, kind: 'sidebar' })
  }
}

/**
 * A card's section header: dim, on the card's tint, with no blank row under it.
 *
 * The blank row *above* is the caller's, because between two cards it is the gutter and
 * belongs to neither.
 */
function sectionHeader(strip: Strip, y: number, label: string): number {
  if (y >= strip.limit) return y
  const base = hovered(strip.palette.card, y === strip.hoverRow)
  paintRow(strip, y, base)
  put(strip, INDEX_X, y, truncate(label, Math.max(0, strip.width - INDEX_X - RIGHT_PAD)), weight(base, ATTR_DIM))
  return y + 1
}

/** One row of the rhythm. Tinted, so a blank inside a card is still card. */
function blankRow(strip: Strip, y: number, base: Style): number {
  if (y >= strip.limit) return y
  paintRow(strip, y, hovered(base, y === strip.hoverRow))
  return y + 1
}

/**
 * One workspace: its name, its branch, and — when it is the active one — its tabs.
 *
 * Every row of the entry resolves to a click on that workspace, and every row of the
 * active entry carries the selection bar, so a four-row entry still reads as one thing
 * rather than as four neighbours.
 */
function workspaceEntry(
  strip: Strip,
  state: SessionStateSnapshot,
  workspace: WorkspaceRecord,
  startY: number,
  summaries: ReadonlyMap<string, GitRepoSummary>,
  hoverEnabled: boolean
): number {
  const { palette, hits } = strip
  let y = startY
  if (y >= strip.limit) return y

  const active = workspace.workspaceId === state.activeWorkspaceId
  const hue = strip.hues.get(workspace.workspaceId) ?? palette.sidebar.fg
  const markRow = (row: number, base: Style): void => {
    if (active) put(strip, MARK_X, row, ACTIVE_MARK, tint(base, hue))
  }

  // Hover *composes* with selection rather than losing to it. Letting active win meant
  // a session with one workspace — the common first-run case — had a single row that
  // was always active and therefore never showed hover, so the pointer appeared to do
  // nothing at all and the mouse looked broken.
  const base = hovered(palette.card, y === strip.hoverRow)
  paintRow(strip, y, base)
  markRow(y, base)
  put(strip, INDEX_X, y, truncate(String(workspace.number), INDEX_WIDTH).padStart(INDEX_WIDTH, ' '), weight(base, ATTR_DIM))

  // The dot leads the name, in the workspace's own hue. Its *shape* is the state; the
  // colour is whose state it is. A blocked workspace is also the top row of the agents
  // card below, where the word `blocked` is red — so the colour that means urgency is
  // spent once, in the place that exists to answer "what needs me".
  const dot = agentGlyph(workspaceAgentStatus(state, workspace.workspaceId))
  if (dot !== null) put(strip, DOT_X, y, dot, tint(base, hue))

  // The pane count and the `x` are the chrome nobody looks at and everybody pays for:
  // occasionally useful and permanently present is the worst trade in a narrow strip.
  // They appear on one row, and the name's room shrinks by exactly what they take.
  const chromeHere = hoverEnabled ? y === strip.hoverRow : active
  let reserved = 0
  if (chromeHere) {
    // Closing the last workspace empties the session and quits, which is `C-b q`'s job
    // and not something a stray click on a sidebar row should do.
    const closable = state.workspaceOrder.length > 1
    const chrome = `${countPanes(state, workspace.workspaceId)}${closable ? ' x' : ''}`
    // One column of gap before it, and `RIGHT_PAD` after it, like every other row.
    reserved = chrome.length + 1
    put(strip, strip.width - RIGHT_PAD - chrome.length, y, chrome, weight(base, ATTR_DIM))
    if (closable) {
      const closeX = strip.area.x + strip.width - RIGHT_PAD - 2
      hits.workspaceCloseSpans.push({ x: closeX, end: closeX + 2, y, workspaceId: workspace.workspaceId })
    }
  }
  put(
    strip,
    BODY_X,
    y,
    truncate(workspaceTitle(workspace), bodyRoom(strip, reserved)),
    weight(tint(base, hue), ATTR_BOLD)
  )
  hits.workspaceRows.set(y, workspace.workspaceId)
  y += 1

  // The branch, dimmed, under the name — the one fact about a workspace you cannot get
  // from its title, and the reason a workspace list beats a list of directories. Only
  // when it is known: no row is invented for a directory that is not a checkout.
  const summary = summaries.get(workspace.workspaceId)
  if (summary !== undefined && summary.isRepo && summary.branch.length > 0 && y < strip.limit) {
    const counts = !summary.hasUpstream
      ? ''
      : `${summary.ahead > 0 ? ` ↑${summary.ahead}` : ''}${summary.behind > 0 ? ` ↓${summary.behind}` : ''}`
    const line = `${summary.branch}${counts}${summary.dirty ? ` ${DIRTY_MARK}` : ''}`
    const row = hovered(palette.card, y === strip.hoverRow)
    paintRow(strip, y, row)
    markRow(y, row)
    put(strip, BODY_X, y, truncate(line, bodyRoom(strip)), weight(row, ATTR_DIM))
    // The same click target as the name above it: two rows, one workspace.
    hits.workspaceRows.set(y, workspace.workspaceId)
    y += 1
  }

  // Tabs are nested under the active workspace only. Listing every tab of every
  // workspace turns the strip into an outline nobody asked for, and the tabs of a
  // workspace you are not in are not reachable in one click anyway.
  if (!active) return y
  for (const tab of tabsOf(state, workspace.workspaceId)) {
    if (y >= strip.limit) return y
    const selected = tab.tabId === workspace.activeTabId
    const row = hovered(palette.card, y === strip.hoverRow)
    paintRow(strip, y, row)
    markRow(y, row)
    put(strip, BODY_X, y, selected ? '›' : ' ', weight(row, ATTR_DIM))
    // Weight, not colour: the tab bar across the top already says which tab is showing
    // in the accent, and a second accent down here would be two answers to one question.
    put(strip, BODY_X + 2, y, truncate(tabTitle(tab), bodyRoom(strip, 2)), weight(row, selected ? ATTR_BOLD : ATTR_DIM))
    hits.sidebarTabRows.set(y, tab.tabId)
    y += 1
  }
  return y
}

/**
 * The `spaces` card's last row: `new` on the left, `menu` on the right, `▤ files` between.
 *
 * Three targets on one row, following herdr. Two separate rows would cost two lines of a
 * thirty-column strip to say what fits on one, and the trio reads as a toolbar rather
 * than as two more list entries you might have missed.
 *
 * `▤ files` opens the docked file sidebar. It is there because the dock had no visible
 * way in at all: `C-b e` opens it and nothing on screen said so, which makes a whole
 * half of the program invisible to anyone who has not read the keys. The label degrades
 * to `▤` alone before it is dropped, so a narrow strip loses the word and not the button.
 */
function actionRow(strip: Strip, y: number): number {
  if (y >= strip.limit) return y
  const { hits } = strip
  const base = hovered(strip.palette.card, y === strip.hoverRow)
  paintRow(strip, y, base)
  const dim = weight(base, ATTR_DIM)

  const add = ' + new'
  put(strip, MARK_X, y, truncate(add, strip.width), dim)
  const menu = 'menu'
  const menuColumn = Math.max(0, strip.width - RIGHT_PAD - menu.length)
  put(strip, menuColumn, y, menu, dim)

  // Centred in what is left between the two, and only if it fits whole: a half-drawn
  // label is a target whose edge nobody can find.
  const gapStart = Math.min(strip.width, add.length + 1)
  const gapEnd = menuColumn - 1
  const label = gapEnd - gapStart >= FILES_LABEL.length ? FILES_LABEL : FILES_GLYPH
  let files: { x: number; end: number } | null = null
  if (gapEnd - gapStart >= label.length) {
    const column = gapStart + Math.floor((gapEnd - gapStart - label.length) / 2)
    put(strip, column, y, label, dim)
    files = { x: strip.area.x + column, end: strip.area.x + column + label.length }
  }
  hits.actionRow = { row: y, newEnd: strip.area.x + add.length, menuStart: strip.area.x + menuColumn, files }
  // Kept so a click anywhere else on the row still makes a workspace, which is the more
  // likely intent on a row whose left half says `new`.
  hits.newWorkspaceRow = y
  return y + 1
}

/**
 * The `agents` card: every agent in the session, wherever it is.
 *
 * Separate from the workspace list because it answers a different question. The
 * workspace rows say "is anything in there waiting on me"; this says *which* agent, in
 * one click's reach, including the ones three workspaces away that you cannot see.
 * Worst state first, so a blocked agent is at the top of the list rather than wherever
 * it happens to live.
 */
function agentsCard(strip: Strip, state: SessionStateSnapshot, startY: number): number {
  const entries = agentEntries(state)
  if (entries.length === 0) return startY
  // The gutter between the two cards, in the sidebar's own background rather than in
  // either card's tint — which is what makes them read as two panels and not as one
  // list with a gap in it. It is also the blank row a section header takes above it.
  let y = blankRow(strip, startY, strip.palette.sidebar)
  y = sectionHeader(strip, y, 'agents')
  let first = true
  for (const entry of entries) {
    if (y >= strip.limit) break
    if (!first) y = blankRow(strip, y, strip.palette.card)
    first = false
    y = agentEntry(strip, state, entry, y)
  }
  return y
}

/**
 * One agent: the workspace it belongs to, then how it is going and what is running it.
 *
 * **The workspace is the identity, not the pane title.** The old row put the window
 * title Claude Code sets on the first line, so four Claude panes drew four identical
 * rows and the thing that distinguished them — which project they were in — was a
 * right-aligned number. Here the first line is the project, in the project's hue, and
 * the tool is on the dim line where it belongs.
 *
 * The pane's own title is not drawn at all. There is no column for a third fact at
 * thirty columns, and it was never an identity: two agents in one workspace are two
 * adjacent rows that differ only in order, and each still clicks through to its own pane.
 */
function agentEntry(strip: Strip, state: SessionStateSnapshot, entry: AgentEntry, startY: number): number {
  const { palette, hits } = strip
  let y = startY
  const hue = strip.hues.get(entry.workspaceId) ?? palette.sidebar.fg

  const base = hovered(palette.card, y === strip.hoverRow)
  paintRow(strip, y, base)
  put(strip, DOT_X, y, agentGlyph(entry.status) ?? '?', tint(base, hue))
  const place = workspaceNameOf(state, entry.workspaceId, entry.workspaceNumber)
  put(strip, BODY_X, y, truncate(place, bodyRoom(strip)), weight(tint(base, hue), ATTR_BOLD))
  hits.agentRows.set(y, { paneId: entry.paneId, workspaceId: entry.workspaceId })
  y += 1
  if (y >= strip.limit) return y

  // `working · claude`: the state in the state's own colour — the one thing colour is
  // still allowed to mean besides identity — then, dimmed, what is running.
  const second = hovered(palette.card, y === strip.hoverRow)
  paintRow(strip, y, second)
  const dim = weight(second, ATTR_DIM)
  const agentStyle = palette.agent[entry.status]
  const room = bodyRoom(strip)
  const word = truncate(entry.status, room)
  put(strip, BODY_X, y, word, agentStyle === undefined ? dim : tint(second, agentStyle.fg))
  put(strip, BODY_X + word.length, y, truncate(` · ${entry.agent}`, Math.max(0, room - word.length)), dim)
  hits.agentRows.set(y, { paneId: entry.paneId, workspaceId: entry.workspaceId })
  return y + 1
}

/**
 * The action row's file-sidebar button, and its narrow form.
 *
 * `▤` is Geometric Shapes, the same block as the pane buttons this file already draws,
 * so it is measured the same way by `stringWidth` and by every terminal that agrees
 * with it. Not a Nerd Font glyph, for `icons.ts`'s reason: a Private Use Area code
 * point has no assigned width, and one column of disagreement moves every hit region
 * on the row.
 */
const FILES_GLYPH = '▤'
const FILES_LABEL = '▤ files'

/** A grip on a vertical edge, and on a horizontal one. */
export const GRIP_VERTICAL = '⋮'
export const GRIP_HORIZONTAL = '⋯'

/**
 * Draw a grip at the middle of each split divider.
 *
 * Same reasoning as the sidebar's: the drag has to start somewhere deliberate. The
 * midpoint is where a divider is least likely to be crowded by a pane title.
 */
export function renderDividerGrips(
  buffer: ScreenBuffer,
  borders: readonly { pos: number; direction: 'horizontal' | 'vertical'; area: Rect; path: readonly boolean[] }[],
  palette: Palette,
  hits: HitRegions
): void {
  for (const border of borders) {
    if (border.direction === 'horizontal') {
      const y = border.area.y + Math.floor(border.area.height / 2)
      buffer.writeString(border.pos, y, GRIP_VERTICAL, palette.idleBorder, border.pos + 1)
      hits.grips.push({ x: border.pos, y, kind: 'divider', path: border.path, direction: 'horizontal' })
    } else {
      const x = border.area.x + Math.floor(border.area.width / 2)
      buffer.writeString(x, border.pos, GRIP_HORIZONTAL, palette.idleBorder, x + 1)
      hits.grips.push({ x, y: border.pos, kind: 'divider', path: border.path, direction: 'vertical' })
    }
  }
}

/** A workspace's display name, for the agents card's first line. */
function workspaceNameOf(state: SessionStateSnapshot, workspaceId: string, number: number): string {
  const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId)
  return workspace === undefined ? `workspace ${number}` : workspaceTitle(workspace)
}

/**
 * Buttons on a pane's top border: split right, split down, close.
 *
 * ## The glyphs
 *
 * `|` and `-` were the first attempt and said nothing: a vertical bar does not tell
 * you whether you are about to get a pane beside this one or a divider drawn on it.
 * The half-filled squares are literal — the filled half is *where the new pane lands*:
 *
 * ```
 *   ◨   a pane appears on the right     ⬓   a pane appears below     ✕   close
 * ```
 *
 * `✕` (U+2715) is East Asian Neutral and always one cell. `◨` and `⬓` are
 * **Ambiguous**, so a terminal running a CJK locale may draw them two cells wide and
 * push every hit region one column right. That is what `[ui] pane-buttons = "ascii"`
 * is for, and why the ASCII set is kept rather than deleted.
 *
 * Drawn over the border after the block rather than passed to `renderBlock`, because
 * their *columns* have to be recorded for a click to resolve and the block renderer
 * only takes a string.
 */
export const PANE_BUTTON_SETS: Readonly<Record<'icons' | 'ascii', readonly { label: string; action: PaneButtonAction }[]>> = {
  icons: [
    { label: '◨', action: 'split-right' },
    { label: '⬓', action: 'split-down' },
    { label: '✕', action: 'close' }
  ],
  ascii: [
    { label: '|', action: 'split-right' },
    { label: '_', action: 'split-down' },
    { label: 'x', action: 'close' }
  ]
}

/** Kept for callers that want the default set without consulting the config. */
export const PANE_BUTTONS = PANE_BUTTON_SETS.icons

export function renderPaneButtons(
  buffer: ScreenBuffer,
  rect: Rect,
  paneId: string,
  palette: Palette,
  hits: HitRegions,
  focused: boolean,
  style: 'icons' | 'ascii' | 'off' = 'icons',
  /** Where the pointer is, so the button under it can light up. */
  hover: { column: number; row: number } = { column: -1, row: -1 }
): void {
  if (style === 'off') return
  const buttons = PANE_BUTTON_SETS[style]
  const width = buttons.length * 2 + 1
  // A pane too narrow would have its own title eaten by the buttons.
  if (rect.width < width + 10) return

  const base = focused ? palette.focusBorder : palette.idleBorder
  let x = rect.x + rect.width - width
  for (const button of buttons) {
    const over = hover.row === rect.y && hover.column >= x && hover.column < x + 2
    // Inverse on hover: these sit on a border line with no box of their own, so
    // without it there is nothing to say they are targets rather than decoration.
    buffer.writeString(x, rect.y, ` ${button.label}`, hovered(base, over), rect.x + rect.width)
    hits.paneButtons.push({ x, end: x + 2, y: rect.y, paneId, action: button.action })
    x += 2
  }
}

function countPanes(state: SessionStateSnapshot, workspaceId: string): number {
  return tabsOf(state, workspaceId).reduce((total, tab) => total + countLayoutPanes(tab.layout), 0)
}

function countLayoutPanes(node: SessionStateSnapshot['tabs'][number]['layout']): number {
  return node.type === 'pane' ? 1 : countLayoutPanes(node.first) + countLayoutPanes(node.second)
}

/** Draw the tab bar across the top of the content area. */
export function renderTabBar(
  buffer: ScreenBuffer,
  area: Rect,
  state: SessionStateSnapshot,
  palette: Palette,
  hits: HitRegions
): void {
  buffer.fill(area, ' ', palette.tabIdle)
  hits.tabBarRow = area.y
  const workspace = state.workspaces.find((entry) => entry.workspaceId === state.activeWorkspaceId)
  if (!workspace) return

  let x = area.x
  for (const tab of tabsOf(state, workspace.workspaceId)) {
    const selected = tab.tabId === workspace.activeTabId
    const text = ` ${tabTitle(tab)} `
    if (x + text.length > area.x + area.width) break
    buffer.writeString(x, area.y, text, selected ? palette.tabActive : palette.tabIdle, area.x + area.width)
    hits.tabSpans.push({ x, end: x + text.length, tabId: tab.tabId })
    x += text.length
  }

  const plus = ' + '
  if (x + plus.length <= area.x + area.width) {
    buffer.writeString(x, area.y, plus, palette.tabIdle, area.x + area.width)
    hits.newTabSpan = { x, end: x + plus.length }
  }
}

export interface StatusContent {
  readonly left: string
  readonly right: string
}

export function renderStatusBar(
  buffer: ScreenBuffer,
  area: Rect,
  content: StatusContent,
  palette: Palette
): void {
  buffer.fill(area, ' ', palette.status)
  const room = Math.max(0, area.width - 2)
  buffer.writeString(area.x + 1, area.y, truncate(content.left, room), palette.status, area.x + area.width)
  const rightWidth = Math.min(content.right.length, Math.max(0, room - content.left.length - 1))
  if (rightWidth > 0) {
    buffer.writeString(
      area.x + area.width - 1 - rightWidth,
      area.y,
      truncate(content.right, rightWidth),
      palette.status,
      area.x + area.width
    )
  }
}

/** A placeholder for a pane with nothing to show yet. */
export const PLACEHOLDER_STYLE = DEFAULT_STYLE


/** How wide the collapsed rail is: a number, a status glyph, and a space. */
export const RAIL_WIDTH = 3

/**
 * The collapsed sidebar: a rail of workspace numbers.
 *
 * Collapsing used to remove the sidebar outright, which answered "give me my columns
 * back" and nothing else — with it gone there was no way to see that workspace 3 had
 * a blocked agent, and no way to switch without the keyboard. Three columns keeps
 * both: the number you press, and the glyph that says whether it wants you.
 *
 * `»` at the bottom mirrors the `«` that collapsed it, in the same corner.
 */
export function renderSidebarRail(
  buffer: ScreenBuffer,
  area: Rect,
  state: SessionStateSnapshot,
  palette: Palette,
  hits: HitRegions,
  hoverRow = -1
): void {
  buffer.fill(area, ' ', palette.sidebar)
  let y = area.y
  const limit = area.y + area.height

  for (const workspace of orderedWorkspaces(state)) {
    if (y >= limit - 1) break
    const active = workspace.workspaceId === state.activeWorkspaceId
    const rowStyle = hovered(active ? palette.sidebarActive : palette.sidebar, y === hoverRow)
    const status = workspaceAgentStatus(state, workspace.workspaceId)
    const glyph = agentGlyph(status)

    buffer.writeString(area.x, y, truncate(`${workspace.number}`, 2).padEnd(2, ' '), rowStyle, area.x + area.width)
    if (glyph !== null) {
      // **The one place status keeps a hue.** Three columns hold a number and a dot:
      // there is no name to colour, so identity has nowhere to go, and no state word,
      // so state has nothing else to ride on. The rail is what you look at when you
      // have given the strip's columns back and still want to know if something is
      // waiting — which is a question about state.
      const agentStyle = palette.agent[status as string]
      buffer.writeString(area.x + 2, y, glyph, agentStyle === undefined ? rowStyle : { ...rowStyle, fg: agentStyle.fg }, area.x + area.width)
    }
    hits.workspaceRows.set(y, workspace.workspaceId)
    y += 1
  }

  const expandY = area.y + area.height - 1
  buffer.writeString(area.x, expandY, ' »', hovered(palette.sidebar, expandY === hoverRow), area.x + area.width)
  hits.collapse = { x: area.x, end: area.x + 2, y: expandY }
}
