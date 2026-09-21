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
  ATTR_INVERSE,
  DEFAULT_STYLE,
  ScreenBuffer,
  style,
  truncate,
  type Rect,
  type Style
} from '@leap-chorus/tui'
import { DEFAULT_CONFIG, resolveTheme, type Config } from '@leap-chorus/core'
import type { GitRepoSummary, SessionStateSnapshot } from '@leap-chorus/protocol'
import {
  agentEntries,
  agentGlyph,
  orderedWorkspaces,
  panesOf,
  tabTitle,
  tabsOf,
  workspaceAgentStatus,
  workspaceTitle
} from './model.js'

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
  /** Keyed by agent status. An unknown status has no colour, only its glyph. */
  readonly agent: Readonly<Record<string, Style>>
}

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
 * row already is, so it reads correctly against every theme and against both the
 * active and inactive row. One rule, two states, no new palette entry.
 */
function hovered(base: Style, isHovered: boolean): Style {
  return isHovered ? { ...base, attrs: base.attrs | ATTR_INVERSE } : base
}

/**
 * Draw the workspace sidebar and return the rect left over.
 *
 * Workspaces are listed in display order with their tabs nested beneath the active one
 * only — listing every tab of every workspace turns the sidebar into an outline nobody
 * asked for, and the tabs of a workspace you are not in are not actionable in one
 * click anyway.
 */
export function renderSidebar(
  buffer: ScreenBuffer,
  area: Rect,
  state: SessionStateSnapshot,
  palette: Palette,
  hits: HitRegions,
  /** Screen row the pointer is over, or -1. Only ever set when hover is enabled. */
  hoverRow = -1,
  /**
   * The sidebar is docked on the right, so its *inner* edge is its first column.
   *
   * The grip and the collapse arrow both live on the inner edge — the one the sidebar
   * resizes and collapses towards. Hard-coding them to the last column was correct for
   * as long as `x` was always 0, and became a grip on the screen's outer edge the moment
   * `[sidebar] dock = "right"` existed.
   */
  dockRight = false,
  /**
   * One git headline per workspace id, when the client has fetched them.
   *
   * Empty is a normal state, not a failure: the map is filled by `git.summary` after
   * the first render, and a workspace outside a checkout is simply absent from it. A
   * row with no entry draws no second line, so the list degrades to what it was.
   */
  summaries: ReadonlyMap<string, GitRepoSummary> = new Map()
): void {
  buffer.fill(area, ' ', palette.sidebar)
  let y = area.y
  const limit = area.y + area.height
  const width = area.width

  // A section header, as in herdr-sidebar. One row, and it earns it: without it the
  // workspace list and the agents list below run together into one list of names with
  // a blank line in the middle.
  if (y < limit) {
    buffer.writeString(area.x, y, truncate('spaces', width).padEnd(width, ' '), palette.idleBorder, area.x + width)
    y += 1
  }

  for (const workspace of orderedWorkspaces(state)) {
    if (y >= limit) return
    const active = workspace.workspaceId === state.activeWorkspaceId
    // Hover *composes* with selection rather than losing to it. Letting active win
    // meant a session with one workspace — the common first-run case — had a single
    // row that was always active and therefore never showed hover, so the pointer
    // appeared to do nothing at all and the mouse looked broken.
    const rowStyle = hovered(active ? palette.sidebarActive : palette.sidebar, y === hoverRow)
    const paneCount = countPanes(state, workspace.workspaceId)

    // The agent glyph **leads** the row, beside the number.
    //
    // It used to sit on the right, between the name and the pane count, where it read
    // as part of the numbers rather than as a property of the workspace. Leading is
    // where every list of this shape puts a status light, and it gives the eye one
    // column to scan instead of a ragged right edge — which matters most in the state
    // this exists for: four workspaces down the list, one of them blocked.
    const status = workspaceAgentStatus(state, workspace.workspaceId)
    const glyph = agentGlyph(status)
    // `x` closes the workspace. Only drawn when there is more than one: closing the
    // last workspace empties the session and quits, which is `C-b q`'s job and not
    // something a stray click on a sidebar row should do.
    const closable = state.workspaceOrder.length > 1
    const suffix = ` ${paneCount}${closable ? ' x' : ''}`
    const prefix = `${workspace.number} ${glyph === null ? ' ' : glyph} `

    // The suffix is pinned right, so a long workspace name truncates rather than
    // pushing the count off the edge.
    const room = Math.max(0, width - suffix.length)
    buffer.writeString(
      area.x,
      y,
      truncate(`${prefix}${workspaceTitle(workspace)}`, room).padEnd(room, ' '),
      rowStyle,
      area.x + width
    )
    if (glyph !== null) {
      // The glyph keeps the row's background but takes the state's foreground, so it
      // reads on the active row too.
      const agentStyle = palette.agent[status as string]
      buffer.writeString(
        area.x + `${workspace.number} `.length,
        y,
        glyph,
        agentStyle === undefined ? rowStyle : { ...rowStyle, fg: agentStyle.fg },
        area.x + width
      )
    }
    buffer.writeString(area.x + room, y, ` ${paneCount}`, rowStyle, area.x + width)
    if (closable) {
      const closeX = area.x + room + ` ${paneCount}`.length
      buffer.writeString(closeX, y, ' x', rowStyle, area.x + width)
      hits.workspaceCloseSpans.push({ x: closeX, end: closeX + 2, y, workspaceId: workspace.workspaceId })
    }
    hits.workspaceRows.set(y, workspace.workspaceId)
    y += 1

    // The branch, dimmed, under the name — the one fact about a workspace you cannot
    // get from its title, and the reason a workspace list beats a list of directories.
    // Only when it is known: no row is invented for a directory that is not a checkout.
    const summary = summaries.get(workspace.workspaceId)
    if (summary !== undefined && summary.isRepo && summary.branch.length > 0 && y < limit) {
      const counts = !summary.hasUpstream
        ? ''
        : `${summary.ahead > 0 ? ` ↑${summary.ahead}` : ''}${summary.behind > 0 ? ` ↓${summary.behind}` : ''}`
      // Indented to the name's own column, so the two rows read as one entry.
      const line = `    ${summary.branch}${counts}${summary.dirty ? ' ●' : ''}`
      buffer.writeString(
        area.x,
        y,
        truncate(line, width).padEnd(width, ' '),
        hovered(palette.idleBorder, y === hoverRow),
        area.x + width
      )
      // The same click target as the name above it: two rows, one workspace.
      hits.workspaceRows.set(y, workspace.workspaceId)
      y += 1
    }

    if (!active) continue
    for (const tab of tabsOf(state, workspace.workspaceId)) {
      if (y >= limit) return
      const selected = tab.tabId === workspace.activeTabId
      const text = `  ${selected ? '›' : ' '} ${tabTitle(tab)}`
      buffer.writeString(
        area.x,
        y,
        truncate(text, width).padEnd(width, ' '),
        hovered(selected ? palette.tabActive : palette.sidebar, y === hoverRow),
        area.x + width
      )
      hits.sidebarTabRows.set(y, tab.tabId)
      y += 1
    }
  }

  // One action row, `new` left and `menu` right, following herdr. Two separate rows
  // cost two lines of a 22-column strip to say what fits on one, and the pair reads
  // as a toolbar rather than as two more list entries you might have missed.
  //
  // Between them sits `▤ files`, which opens the docked file sidebar. It is there
  // because the dock had no visible way in at all: `C-b e` opens it and nothing on
  // screen says so, which makes a whole half of the program invisible to anyone who
  // has not read the keys. The glyph degrades to `▤` alone before it is dropped, so a
  // narrow strip loses the word rather than the button.
  if (y < limit) {
    const row = hovered(palette.sidebar, y === hoverRow)
    buffer.writeString(area.x, y, ' '.repeat(width), row, area.x + width)
    buffer.writeString(area.x, y, truncate(' new', width), row, area.x + width)
    const menu = 'menu '
    const menuStart = area.x + Math.max(0, width - menu.length)
    buffer.writeString(menuStart, y, menu, row, area.x + width)

    // Centred in what is left between `new` and `menu`, and only if it fits whole:
    // a half-drawn label would be a target whose edge nobody can find.
    const gap = { start: area.x + 5, end: menuStart - 1 }
    const label = gap.end - gap.start >= FILES_LABEL.length ? FILES_LABEL : FILES_GLYPH
    let files: { x: number; end: number } | null = null
    if (gap.end - gap.start >= label.length) {
      const x = gap.start + Math.floor((gap.end - gap.start - label.length) / 2)
      buffer.writeString(x, y, label, row, area.x + width)
      files = { x, end: x + label.length }
    }
    hits.actionRow = { row: y, newEnd: area.x + 4, menuStart, files }
    // Kept so a click anywhere else on the row still makes a workspace, which is the
    // more likely intent on a row whose left half says `new`.
    hits.newWorkspaceRow = y
    y += 1
  }

  renderAgentSection(buffer, area, state, palette, hits, hoverRow, y)

  // The `«` sits at the bottom right, where herdr puts it: out of the way of the
  // list, and on the edge it collapses towards.
  const collapseY = area.y + area.height - 1
  const collapseX = dockRight ? area.x : area.x + width - 2
  if (collapseY > area.y) {
    // The arrow points at the edge it collapses towards, which is the opposite one on
    // each side.
    const arrow = dockRight ? '» ' : ' «'
    buffer.writeString(collapseX, collapseY, arrow, hovered(palette.sidebar, collapseY === hoverRow), area.x + width)
    hits.collapse = { x: collapseX, end: collapseX + 2, y: collapseY }
  }
  // The grip: three cells at the vertical middle of the sidebar's inner column. Short
  // enough to be a target rather than an edge, long enough to find.
  const gripX = dockRight ? area.x : area.x + width - 1
  const gripTop = area.y + Math.floor(area.height / 2) - 1
  for (let i = 0; i < 3; i++) {
    const gy = gripTop + i
    if (gy < area.y || gy >= area.y + area.height) continue
    buffer.writeString(gripX, gy, GRIP_VERTICAL, palette.idleBorder, gripX + 1)
    hits.grips.push({ x: gripX, y: gy, kind: 'sidebar' })
  }
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

/** A workspace's display name, for the agents list's second line. */
function workspaceNameOf(state: SessionStateSnapshot, workspaceId: string, number: number): string {
  const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId)
  return workspace === undefined ? `workspace ${number}` : workspaceTitle(workspace)
}

/**
 * The agents section: every agent in the session, wherever it is.
 *
 * Separate from the workspace list because it answers a different question. The
 * workspace rows say "is anything in there waiting on me"; this says *which* agent,
 * in one click's reach, including the ones three workspaces away that you cannot see.
 * Worst state first, so a blocked agent is at the top of the list rather than wherever
 * it happens to live.
 *
 * Two lines each, following herdr: the agent and its state, then a dimmed second line
 * with the pane's own title. The title is what distinguishes four panes all running
 * `claude`, which is the normal case this is for.
 */
function renderAgentSection(
  buffer: ScreenBuffer,
  area: Rect,
  state: SessionStateSnapshot,
  palette: Palette,
  hits: HitRegions,
  hoverRow: number,
  startY: number
): void {
  const entries = agentEntries(state)
  if (entries.length === 0) return
  const limit = area.y + area.height
  const width = area.width
  let y = startY + 1
  if (y >= limit) return

  buffer.writeString(area.x, y, truncate('agents', width).padEnd(width, ' '), palette.sidebar, area.x + width)
  y += 1

  for (const entry of entries) {
    if (y >= limit) return
    const glyph = agentGlyph(entry.status) ?? '?'
    const rowStyle = hovered(palette.sidebar, y === hoverRow)

    // Line one is **what is running**, line two is **how it is going and where**.
    // It used to be the tool on one line and the pane title on the other, which put
    // the word `claude` four times down a list of four agents and made the one thing
    // that distinguishes them — their task — the dim half. A pane whose title is still
    // the tool's own name falls back to the tool, so nothing renders as `claude ·
    // claude`.
    const task = entry.title.trim()
    const named = task.length > 0 && task.toLowerCase() !== entry.agent.toLowerCase()
    const label = ` ${glyph} ${named ? task : entry.agent}`
    const tool = named ? ` ${entry.agent}` : ''
    const room = Math.max(0, width - tool.length)
    buffer.writeString(area.x, y, truncate(label, room).padEnd(room, ' '), rowStyle, area.x + width)
    if (tool.length > 0) {
      buffer.writeString(area.x + room, y, tool, hovered(palette.idleBorder, y === hoverRow), area.x + width)
    }

    // The glyph carries the state's colour; the rest of the row does not, so a list of
    // eight agents reads as one list with one thing standing out.
    const agentStyle = palette.agent[entry.status]
    if (agentStyle !== undefined) {
      buffer.writeString(area.x + 1, y, glyph, { ...rowStyle, fg: agentStyle.fg }, area.x + width)
    }
    hits.agentRows.set(y, { paneId: entry.paneId, workspaceId: entry.workspaceId })
    y += 1

    if (y >= limit) return
    // `idle · acme-app`: the state in its own colour, then the workspace it is in.
    // The workspace by *name*, not by number — a number is a keystroke, and this line
    // is answering "which project is that".
    const place = workspaceNameOf(state, entry.workspaceId, entry.workspaceNumber)
    const dim = hovered(palette.idleBorder, y === hoverRow)
    buffer.writeString(area.x, y, ' '.repeat(width), dim, area.x + width)
    buffer.writeString(area.x, y, truncate(`   ${entry.status}`, width), agentStyle ?? dim, area.x + width)
    const after = area.x + Math.min(width, 3 + entry.status.length)
    buffer.writeString(after, y, truncate(` · ${place}`, Math.max(0, area.x + width - after)), dim, area.x + width)
    hits.agentRows.set(y, { paneId: entry.paneId, workspaceId: entry.workspaceId })
    y += 1
  }
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
