/**
 * The multiplexer client: the render loop, the keymap, and the input router.
 *
 * ## What moved in phase 4
 *
 * Phase 2's `TuiApp` owned the panes and the layout. It does not any more. Workspaces,
 * tabs, panes, the layout tree and focus live in the daemon, because two clients
 * attached to one session have to agree about them; this client holds a
 * `SessionStateSnapshot` and changes it by calling the daemon. What stays here is
 * everything the daemon must not know: the screen size, the sidebar, the tab bar, the
 * cell buffers, the diff, and where on the screen a click landed.
 *
 * ## The render loop, and why it pulls
 *
 * Unchanged from phase 2, and still the reason a hidden pane is cheap. The daemon
 * sends `session.output { id, sequence }` — a notification — and the client decides
 * whether it cares. An output event for a pane that is not on screen sets one boolean
 * and stops: no snapshot is fetched, composed, diffed or encoded. `state.changed` is
 * the same idea for the model: it carries a revision, not the model.
 *
 * A frame is: fetch snapshots for dirty *visible* panes, compose them into the back
 * buffer, diff against the front buffer, encode the spans, write. Frames are coalesced
 * to FRAME_INTERVAL_MS and never overlap.
 *
 * ## Borders are the pane's size
 *
 * Each pane is drawn inside a block, so the session's geometry is the block's *inner*
 * rect. The client resizes a session when its inner rect changes, which is also the
 * only place SIGWINCH has to propagate to.
 */

import type { DaemonClient } from '@leap-chorus/daemon'
import type {
  EventMessage,
  IntegrationInstallResult,
  IntegrationListResult,
  PaneRecord,
  SessionStateSnapshot,
  TerminalSnapshot,
  WireLayoutNode
} from '@leap-chorus/protocol'
import {
  BORDER_ALL,
  DEFAULT_STYLE,
  PLAIN_BORDER,
  ScreenBuffer,
  contains,
  diffBuffers,
  encodeFrame,
  fullSpans,
  renderBlock,
  renderParagraph,
  span,
  type DiffSpan,
  type Rect,
  type Style
} from '@leap-chorus/tui'
import {
  COMMANDS,
  DEFAULT_CONFIG,
  splitBorders,
  type Config,
  type ConfigProblem
} from '@leap-chorus/core'
import {
  InputDecoder,
  LEGACY_PROTOCOL,
  MOD_ALT,
  MOD_CTRL,
  MOD_SHIFT,
  encodeBracketedPaste,
  encodeKey,
  encodeMouse,
  hasModifier,
  type InputEvent,
  type Key,
  type MouseEvent
} from '@leap-chorus/input'
import { encodeWritePayload } from '@leap-chorus/protocol'
import {
  EMPTY_STATE,
  activeTab,
  activeWorkspace,
  paneById,
  agentBadge,
  paneTitle,
  panesOf,
  tabTitle,
  toLayoutNode,
  workspaceById,
  workspaceTitle,
  tabsOf,
  visiblePanes,
  type VisiblePane
} from './model.js'
import { ConfirmDialog, confirmArea, type ConfirmOutcome } from './confirm.js'
import {
  ContextMenu,
  PromptDialog,
  promptArea,
  type MenuOutcome,
  type PromptOutcome
} from './prompt.js'
import { playSound, type SoundKind } from './sound.js'
import { SettingsDialog, describeChord, settingsArea, type SettingsOutcome } from './settings.js'
import { buildKeymap, isPrefix, type Keymap } from './keymap.js'
import {
  emptyHitRegions,
  paletteOf,
  renderSidebar,
  RAIL_WIDTH,
  renderDividerGrips,
  renderPaneButtons,
  renderSidebarRail,
  renderStatusBar,
  renderTabBar,
  type HitRegions,
  type Palette
} from './chrome.js'
import { blitSnapshot, snapshotCursor } from './frame.js'

/** Frame budget. 16 ms is one 60 Hz frame; PHASE-2's p99 target is the same number. */
export const FRAME_INTERVAL_MS = 16

/** Legacy names phase 2 exported. Kept so a caller that imported them still builds. */
export const PREFIX_BYTE = '\x02'
export const PREFIX_CODE = 0x02

const STATUS_ROWS = 1
const TAB_BAR_ROWS = 1
/** Below this width the sidebar is not drawn, whatever the config says. */
/** Narrower than this and the sidebar is a column of truncation, not a list. */
const MIN_SIDEBAR_WIDTH = 12

const MIN_COLS_FOR_SIDEBAR = 60

/** Per-pane render cache. Everything else about a pane comes off the model. */
interface PaneView {
  snapshot: TerminalSnapshot | null
  /** Set by an output event; cleared when a snapshot is fetched. */
  dirty: boolean
  /** Inner geometry last pushed to the daemon, so a resize is sent once per change. */
  cols: number
  rows: number
  fetching: boolean
  sessionId: string | null
}

export interface AppOptions {
  readonly client: DaemonClient
  readonly cols: number
  readonly rows: number
  /** Where encoded frames go. A Screen in production, a capture buffer in tests. */
  write(data: string): void
  readonly synchronizedOutput?: boolean
  /** The program the first pane of a new split runs. Absent means the config's shell. */
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  /** Called when the user quits, detaches, or the daemon goes away. */
  onExit?(reason: string): void
  /** Skip the status bar. The benchmark measures pane rendering, not chrome. */
  readonly statusBar?: boolean
  /**
   * Render on a timer in response to events. On by default.
   *
   * A driver that calls `render()` itself — a test counting frames, the benchmark
   * timing them — must turn this off, or the app's own scheduled frames consume the
   * dirty flags first and the driver measures the empty frames that follow.
   */
  readonly autoRender?: boolean
  /** Start from this config instead of asking the daemon. Tests only. */
  readonly config?: Config
}

export interface FrameStats {
  /** Whole frame: snapshot round trips plus paint. What a user actually waits for. */
  readonly durationMs: number
  /** Time spent waiting on the daemon for snapshots and resizes. */
  readonly fetchMs: number
  /** Compose, diff and encode: the part that is this client's own code. */
  readonly paintMs: number
  readonly bytes: number
  readonly spans: number
  readonly cells: number
  readonly panesComposed: number
  readonly snapshotsFetched: number
}

export class TuiApp {
  private state: SessionStateSnapshot = EMPTY_STATE
  private config: Config = DEFAULT_CONFIG
  private keymap: Keymap
  private palette: Palette
  private hits: HitRegions = emptyHitRegions()

  private readonly views = new Map<string, PaneView>()
  private front: ScreenBuffer
  private back: ScreenBuffer
  private cols: number
  private rows: number
  /**
   * How the sidebar is shown.
   *
   * Three states, not two. `hidden` is what `C-b s` has always meant — give the panes
   * every column. `rail` is what the `«` does: three columns that still say which
   * workspace has a blocked agent and still switch on a click. Collapsing used to
   * mean `hidden`, which threw that away along with the width.
   */
  private sidebarMode: 'full' | 'rail' | 'hidden' = 'full'
  /** A width set by dragging the sidebar edge, or null to follow the config. */
  private sidebarWidthOverride: number | null = null
  /** True while the sidebar edge is being dragged. */
  private draggingSidebar = false
  private prefixArmed = false
  /** Where the pointer is, or -1/-1. Only ever set when hover is enabled. */
  private hoverRow = -1
  private hoverColumn = -1
  /**
   * An open prompt, or null.
   *
   * A status-bar line rather than a modal, following tmux: `C-b ,` renames the tab and
   * `C-b $` the workspace, and the answer is typed where the status bar already is.
   * PHASE-4 deferred modals because the two obvious candidates "would both be guesses
   * at an interaction language phase 5's agent UI will set". Having now built that UI,
   * the answer is that a one-line prompt is enough for a one-line answer, and a modal
   * would be a box drawn around a text field.
   */
  private prompt: { dialog: PromptDialog; kind: 'workspace' | 'tab' | 'pane'; id: string } | null = null
  /**
   * An open popup menu, or null.
   *
   * The menu carries its own handler rather than a discriminator the app switches on,
   * so adding an entry is one array and one closure at the call site instead of a new
   * arm in a resolver that has to know about every menu in the program.
   */
  private menu: { menu: ContextMenu; choose(id: string): Promise<void> } | null = null
  /** The settings dialog, or null when it is closed. */
  private settings: SettingsDialog | null = null
  /** A pending destructive confirmation, or null. */
  private confirm: ConfirmDialog | null = null
  /** The divider being dragged, or null. See `handleDivider`. */
  private drag: {
    tabId: string
    path: readonly boolean[]
    direction: 'horizontal' | 'vertical'
    /** Set once the pointer actually moves, which is what separates a drag from a click. */
    moved: boolean
  } | null = null
  private status = ''
  private forceRepaint = true
  /** Where the last frame left the cursor, so an unchanged frame can write nothing. */
  private lastCursor: string | null = null
  private readonly decoder = new InputDecoder()
  private idleTimer: NodeJS.Timeout | null = null
  private renderScheduled: NodeJS.Timeout | null = null
  private rendering = false
  private renderPending = false
  private closed = false
  private unsubscribe: (() => void) | null = null
  private lastFrame: FrameStats | null = null
  /**
   * The in-flight `state.get`, or null.
   *
   * A burst of `state.changed` events must cost one round trip, not one each — but a
   * caller that joins an in-flight refresh still has to end up with state newer than
   * its own request, so joining returns the same promise *and* marks another pass.
   * Returning early instead was a real bug: `split()` would resolve holding the state
   * from before its own split, because the event the split caused had already started
   * a refresh.
   */
  private refreshPromise: Promise<void> | null = null
  private refreshPending = false
  /**
   * Input events are handled one at a time, in order.
   *
   * Phase 2 could dispatch a keystroke synchronously because focus was local. It is not
   * any more: `prefix h` is a round trip to the daemon, and anything typed while that
   * round trip is in flight would reach the pane that *had* focus. So each event waits
   * for the one before it to finish, which is also what a user means by typing.
   */
  private inputChain: Promise<void> = Promise.resolve()

  private constructor(private readonly options: AppOptions) {
    this.cols = options.cols
    this.rows = options.rows
    this.front = new ScreenBuffer(this.cols, this.rows)
    this.back = new ScreenBuffer(this.cols, this.rows)
    this.config = options.config ?? DEFAULT_CONFIG
    this.keymap = buildKeymap(this.config)
    this.palette = paletteOf(this.config)
    this.sidebarMode = this.config.ui.sidebar ? 'full' : 'hidden'
  }

  static async start(options: AppOptions): Promise<TuiApp> {
    const app = new TuiApp(options)
    if (options.config === undefined) await app.loadConfig()
    await app.refreshState()
    // A daemon with no session yet is the normal first-run case, and this client is the
    // one that knows what the first pane should run — `leap-chorus -- vim` means vim.
    if (app.state.workspaces.length === 0) await app.createFirstWorkspace()
    // Every pane's output matters to this client, because any of them may become
    // visible; subscription is per session and costs one notification per 16 ms.
    await app.subscribeAll()
    app.unsubscribe = options.client.onEvent((event) => app.handleEvent(event))
    await app.render()
    return app
  }

  /** Bring a session into being, running whatever this client was told to run. */
  private async createFirstWorkspace(): Promise<void> {
    await this.options.client.call('workspace.create', {
      focus: true,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
      ...(this.options.command === undefined ? {} : { command: this.options.command }),
      ...(this.options.args === undefined ? {} : { args: this.options.args })
    })
    await this.refreshState()
  }

  // -------------------------------------------------------------------------
  // Model
  // -------------------------------------------------------------------------

  private async loadConfig(): Promise<void> {
    try {
      const result = await this.options.client.call('config.get', {})
      this.applyConfig(result.config as Config, result.problems as readonly ConfigProblem[], result.errors)
    } catch {
      // A daemon too old to answer `config.get` is still a daemon worth attaching to.
    }
  }

  private applyConfig(config: Config, problems: readonly ConfigProblem[], errors: readonly string[]): void {
    this.config = config
    this.keymap = buildKeymap(config)
    this.palette = paletteOf(config)
    this.sidebarMode = config.ui.sidebar ? 'full' : 'hidden'
    const complaints = [...errors, ...problems.map((problem) => problem.message)]
    if (complaints.length > 0) {
      this.status = complaints.length === 1 ? (complaints[0] as string) : `${complaints[0] as string} (+${complaints.length - 1})`
    }
    this.invalidate()
  }

  /** Pull the session model. Coalesced: a burst of `state.changed` costs one round trip. */
  private refreshState(): Promise<void> {
    if (this.refreshPromise !== null) {
      this.refreshPending = true
      return this.refreshPromise
    }
    const run = async (): Promise<void> => {
      try {
        for (;;) {
          this.refreshPending = false
          const { state } = await this.options.client.call('state.get', {})
          this.adoptState(state)
          if (!this.refreshPending) return
        }
      } catch {
        // A failed refresh leaves the last known model on screen, which is the right
        // thing to show while a daemon is busy or a socket is draining.
      } finally {
        this.refreshPromise = null
      }
    }
    this.refreshPromise = run()
    return this.refreshPromise
  }

  private adoptState(state: SessionStateSnapshot): void {
    const previous = this.state
    this.ringForAgentChanges(previous, state)
    this.state = state

    // Retire views for panes that are gone, and make views for panes that are new.
    const live = new Set(state.panes.map((pane) => pane.paneId))
    for (const paneId of [...this.views.keys()]) {
      if (!live.has(paneId)) this.views.delete(paneId)
    }
    for (const pane of state.panes) {
      const view = this.views.get(pane.paneId)
      if (view === undefined) {
        this.views.set(pane.paneId, {
          snapshot: null,
          dirty: true,
          cols: 0,
          rows: 0,
          fetching: false,
          sessionId: pane.sessionId
        })
        if (pane.sessionId !== null) void this.subscribe(pane.sessionId)
        continue
      }
      if (view.sessionId !== pane.sessionId) {
        // The pane was rebound to a different terminal; everything cached is stale.
        view.sessionId = pane.sessionId
        view.snapshot = null
        view.dirty = true
        view.cols = 0
        view.rows = 0
        if (pane.sessionId !== null) void this.subscribe(pane.sessionId)
      }
    }

    // An empty model means the session ended — closing the last pane closes its tab,
    // then its workspace, then the session, and the client's job is over. Empty on the
    // *first* refresh is a different thing entirely: a daemon that has no session yet,
    // which is the normal first run, and `createFirstWorkspace` is about to fix it.
    if (state.panes.length === 0 && previous.panes.length > 0) {
      this.options.onExit?.('no panes left')
      return
    }
    if (previous.revision !== state.revision) this.invalidate()
  }

  private async subscribeAll(): Promise<void> {
    await Promise.all(
      this.state.panes.flatMap((pane) => (pane.sessionId === null ? [] : [this.subscribe(pane.sessionId)]))
    )
  }

  private async subscribe(sessionId: string): Promise<void> {
    try {
      await this.options.client.call('session.subscribe', { id: sessionId })
    } catch {
      // A session that vanished between the model and the subscribe will come back as
      // an exit event; there is nothing to recover here.
    }
  }

  private viewForSession(sessionId: string): { paneId: string; view: PaneView } | null {
    for (const [paneId, view] of this.views) {
      if (view.sessionId === sessionId) return { paneId, view }
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Public surface (tests and the benchmark drive the app through this)
  // -------------------------------------------------------------------------

  get paneCount(): number {
    return this.state.panes.length
  }

  get focusedPaneId(): string {
    return this.state.focusedPaneId ?? ''
  }

  get isZoomed(): boolean {
    return activeTab(this.state)?.zoomed ?? false
  }

  get lastFrameStats(): FrameStats | null {
    return this.lastFrame
  }

  get sessionState(): SessionStateSnapshot {
    return this.state
  }

  get activeConfig(): Config {
    return this.config
  }

  /** Panes of the active tab, in layout order. */
  paneIds(): string[] {
    const tab = activeTab(this.state)
    if (!tab) return []
    return visiblePanes({ ...this.state, tabs: this.state.tabs.map((entry) => (entry.tabId === tab.tabId ? { ...entry, zoomed: false } : entry)) }, this.contentArea()).map(
      (pane) => pane.paneId
    )
  }

  /**
   * Move focus.
   *
   * Returns a promise because focus lives in the daemon now: a caller that wants to
   * observe the new focus has to wait for the round trip. Phase 2's version was
   * synchronous because the layout was local.
   */
  setFocus(id: string): Promise<unknown> {
    return this.call('pane.focus', { paneId: id })
  }

  setZoom(zoomed: boolean): Promise<unknown> {
    return this.call('pane.zoom', { mode: zoomed ? 'on' : 'off' })
  }

  /** The runtime session behind a pane, for a caller that needs to write to it. */
  sessionIdOf(paneId: string): string | null {
    return paneById(this.state, paneId)?.sessionId ?? null
  }

  /** The session behind the focused pane. */
  get focusedSessionId(): string | null {
    return this.state.focusedPaneId === null ? null : this.sessionIdOf(this.state.focusedPaneId)
  }

  /** Layout rect of a pane, borders included. Null when it is not on screen. */
  rectOf(id: string): Rect | null {
    return this.visiblePanes().find((pane) => pane.paneId === id)?.rect ?? null
  }

  visiblePanes(): VisiblePane[] {
    return visiblePanes(this.state, this.contentArea())
  }

  /** Split the focused pane. Returns the new pane id, or null when the daemon refused. */
  async split(direction: 'horizontal' | 'vertical'): Promise<string | null> {
    try {
      const result = await this.options.client.call('pane.split', {
        direction: direction === 'horizontal' ? 'right' : 'down',
        ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
        ...(this.options.command === undefined ? {} : { command: this.options.command }),
        ...(this.options.args === undefined ? {} : { args: this.options.args })
      })
      await this.refreshState()
      return result.paneId ?? null
    } catch (error) {
      this.setStatus(`split failed: ${messageOf(error)}`)
      this.requestRender()
      return null
    }
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private showSidebar(): boolean {
    return this.sidebarMode !== 'hidden' && this.cols >= MIN_COLS_FOR_SIDEBAR
  }

  private sidebarArea(): Rect | null {
    if (!this.showSidebar()) return null
    // A drag overrides the configured width for this client only. Sidebar geometry is
    // presentation: the daemon must never learn it, because the next client to attach
    // may be a different size. See `packages/protocol/src/session-model.ts`.
    if (this.sidebarMode === 'rail') {
      return { x: 0, y: 0, width: RAIL_WIDTH, height: Math.max(0, this.rows - this.statusRows()) }
    }
    const wanted = this.sidebarWidthOverride ?? this.config.ui.sidebarWidth
    const width = Math.max(MIN_SIDEBAR_WIDTH, Math.min(wanted, Math.floor(this.cols / 3)))
    return { x: 0, y: 0, width, height: Math.max(0, this.rows - this.statusRows()) }
  }

  private statusRows(): number {
    return this.options.statusBar === false || !this.config.ui.statusBar ? 0 : STATUS_ROWS
  }

  private tabBarRows(): number {
    return this.config.ui.tabBar ? TAB_BAR_ROWS : 0
  }

  private tabBarArea(): Rect | null {
    if (this.tabBarRows() === 0) return null
    const sidebar = this.sidebarArea()
    const x = sidebar === null ? 0 : sidebar.width
    return { x, y: 0, width: Math.max(0, this.cols - x), height: TAB_BAR_ROWS }
  }

  /** Where panes go: the screen minus sidebar, tab bar and status bar. */
  private contentArea(): Rect {
    const sidebar = this.sidebarArea()
    const x = sidebar === null ? 0 : sidebar.width
    const y = this.tabBarRows()
    return {
      x,
      y,
      width: Math.max(1, this.cols - x),
      height: Math.max(1, this.rows - y - this.statusRows())
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private handleEvent(event: EventMessage): void {
    switch (event.event) {
      case 'session.output': {
        const found = this.viewForSession(event.id)
        if (!found) return
        // The whole hidden-pane saving is here: mark, and do nothing else.
        found.view.dirty = true
        if (this.isVisible(found.paneId)) this.requestRender()
        return
      }
      case 'session.exit': {
        const found = this.viewForSession(event.id)
        if (found) found.view.dirty = true
        // The model, not this client, decides what an exit means for the layout.
        void this.refreshState()
        return
      }
      case 'session.title':
        // The daemon records the title on the pane and bumps the revision; the
        // `state.changed` that follows is what redraws the border.
        return
      case 'state.changed':
        if (event.revision === this.state.revision) return
        void this.refreshState()
        return
      case 'config.changed':
        void this.loadConfig()
        return
      case 'daemon.shutdown':
        this.options.onExit?.('daemon shut down')
        return
    }
  }

  private isVisible(paneId: string): boolean {
    return this.visiblePanes().some((pane) => pane.paneId === paneId)
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /**
   * Route a chunk of raw terminal input.
   *
   * Bytes go to the decoder, which frames them and says what each one was; this decides
   * where each event goes. Keys are either a command (after the prefix, or bound
   * directly) or encoded for the focused pane against *that pane's* keyboard protocol.
   */
  handleInput(data: Buffer | string): void {
    if (this.closed) return
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.dispatchEvents(this.decoder.push(bytes))
    this.scheduleIdleFlush()
  }

  /**
   * Tell the decoder no more bytes are coming.
   *
   * This is what turns a held `ESC` into the Escape key. It is a timer rather than a
   * heuristic because nothing in the byte stream distinguishes "Escape" from "the first
   * byte of an arrow key that has not finished arriving".
   */
  flushInput(): void {
    if (this.closed) return
    this.idleTimer = null
    this.dispatchEvents(this.decoder.flushIdle())
  }

  private scheduleIdleFlush(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (!this.decoder.hasPendingInput) return
    const timer = setTimeout(() => this.flushInput(), this.decoder.idleTimeoutMs)
    timer.unref()
    this.idleTimer = timer
  }

  private dispatchEvents(events: readonly InputEvent[]): void {
    if (events.length === 0) return
    this.inputChain = this.inputChain.then(
      () => this.dispatchInOrder(events),
      () => this.dispatchInOrder(events)
    )
  }

  private async dispatchInOrder(events: readonly InputEvent[]): Promise<void> {
    for (const event of events) {
      switch (event.type) {
        case 'key':
          await this.handleKey(event.key, event.bytes)
          break
        case 'mouse':
          await this.handleMouse(event.mouse)
          break
        case 'paste':
          this.handlePaste(event.data)
          break
        case 'focus':
          // Nothing uses outer focus yet. It is decoded rather than forwarded because a
          // pane that never asked for mode 1004 must not receive focus reports.
          break
        case 'unknown':
          // A sequence this build does not model still reaches the pane verbatim, which
          // is how a terminal feature nobody here has heard of keeps working.
          this.sendToFocused(event.bytes)
          break
      }
    }
  }

  private async handleKey(key: Key, bytes: Uint8Array): Promise<void> {
    // A prompt owns the keyboard while it is open: the point of typing a name is that
    // the letters do not also run commands or reach the pane.
    if (this.prompt !== null) {
      await this.handlePromptKey(key)
      return
    }
    if (this.menu !== null) {
      await this.resolveMenu(this.menu.menu.handleKey(key.name))
      return
    }
    // A confirmation is the most modal thing on screen: it is asked *over* whatever
    // else is open, and it answers first.
    if (this.confirm !== null) {
      await this.resolveConfirm(this.confirm.handleKey(key.name))
      return
    }
    // A modal owns the keyboard, including the prefix: `C-b` inside settings should
    // not arm a command that acts on the session behind the dialog.
    if (this.settings !== null) {
      await this.applySettingsOutcome(this.settings.handleKey(key.name, key.char))
      return
    }
    if (this.prefixArmed) {
      this.prefixArmed = false
      const command = this.keymap.table.resolve(key, 'prefix')
      // Clear the hint before the command runs, so one that sets its own status wins.
      this.status = ''
      if (command === null) {
        this.setStatus(`no binding for ${describeKey(key)}`)
        this.requestRender()
        return
      }
      if (command === 'client.send-prefix') {
        this.sendToFocused(bytes)
        return
      }
      await this.runCommand(command)
      return
    }
    const direct = this.keymap.table.resolve(key, 'direct')
    if (direct !== null) {
      await this.runCommand(direct)
      return
    }
    if (isPrefix(this.keymap, key)) {
      this.prefixArmed = true
      this.requestRender()
      return
    }
    this.sendKeyToFocused(key)
  }

  /**
   * Encode a key for the focused pane, using that pane's protocol.
   *
   * The protocol comes off the pane's own snapshot, so two panes running different
   * programs get different bytes for the same keystroke. A pane with no snapshot yet
   * gets the legacy encoding, which is what it would have negotiated away from anyway.
   */
  private sendKeyToFocused(key: Key): void {
    const target = this.focusedView()
    if (!target) return
    const bytes = encodeKey(key, target.view.snapshot?.keyboard ?? LEGACY_PROTOCOL)
    if (bytes.length === 0) return
    this.writeToSession(target.view.sessionId, bytes)
  }

  private focusedView(): { paneId: string; view: PaneView } | null {
    const paneId = this.state.focusedPaneId
    if (paneId === null) return null
    const view = this.views.get(paneId)
    if (!view || view.sessionId === null) return null
    const record = paneById(this.state, paneId)
    if (record?.exited === true) return null
    return { paneId, view }
  }

  /**
   * Click to focus; forward to the pane when it asked for mouse reports.
   *
   * A click outside the panes is chrome: the sidebar selects a workspace or a tab, the
   * tab bar selects a tab. A wheel event in a pane that never enabled mouse tracking
   * scrolls that pane's history instead of being dropped, which is what a user expects
   * from a multiplexer and what `pane.scroll` is for.
   */
  private async handleMouse(mouse: MouseEvent): Promise<void> {
    if (this.prompt !== null) {
      if (mouse.kind !== 'down') return
      const area = promptArea(this.cols, this.rows)
      if (!contains(area, mouse.column, mouse.row)) {
        // Outside cancels, matching the confirm dialog: a click elsewhere on the
        // screen is not an edit anyone meant to commit.
        await this.resolvePrompt({ kind: 'cancelled' })
        return
      }
      await this.resolvePrompt(this.prompt.dialog.handleClick(mouse.column, mouse.row, area))
      return
    }
    if (this.menu !== null) {
      if (mouse.kind !== 'down') return
      const area = this.menu.menu.area(this.cols, this.rows)
      await this.resolveMenu(
        contains(area, mouse.column, mouse.row)
          ? this.menu.menu.handleClick(mouse.column, mouse.row, area)
          : { kind: 'cancelled' }
      )
      return
    }
    if (this.confirm !== null) {
      if (mouse.kind !== 'down') return
      const area = confirmArea(this.cols, this.rows)
      // Outside cancels. For a destructive question the safe answer is the one a
      // stray click should give.
      if (!contains(area, mouse.column, mouse.row)) {
        await this.resolveConfirm('cancelled')
        return
      }
      await this.resolveConfirm(this.confirm.handleClick(mouse.column, mouse.row, area))
      return
    }
    // The dialog swallows every mouse event while it is open, inside its bounds or
    // not: a click that fell through to a pane behind a modal is a click nobody meant.
    if (this.settings !== null) {
      if (mouse.kind !== 'down') return
      const area = settingsArea(this.cols, this.rows)
      if (!contains(area, mouse.column, mouse.row)) {
        this.settings = null
        this.requestRender()
        return
      }
      await this.applySettingsOutcome(
        this.settings.handleClick(mouse.column, mouse.row, {
          x: area.x + 1,
          y: area.y + 1,
          width: area.width - 2,
          height: area.height - 2
        })
      )
      return
    }
    if (this.handleSidebarDrag(mouse)) return
    if (await this.handleDivider(mouse)) return
    if (this.trackHover(mouse)) return
    if (await this.handlePaneButton(mouse)) return
    if (await this.handleStatusClick(mouse)) return
    if (await this.handleChromeClick(mouse)) return

    const target = this.visiblePanes().find((entry) => contains(innerOf(entry.rect), mouse.column, mouse.row))
    if (!target) return
    const view = this.views.get(target.paneId)
    if (!view) return
    const record = paneById(this.state, target.paneId)
    if (record === null || record.exited) return

    if (mouse.kind === 'down' && target.paneId !== this.state.focusedPaneId) {
      await this.call('pane.focus', { paneId: target.paneId })
    }

    const tracking = view.snapshot?.keyboard?.mouseTracking ?? 'none'
    if (tracking === 'none') {
      if (mouse.kind === 'scrollup' || mouse.kind === 'scrolldown') this.scrollPane(target.paneId, mouse.kind)
      return
    }
    // x10 tracking is press-only; anything else would be reports the program cannot read.
    if (tracking === 'x10' && mouse.kind !== 'down') return
    // vt200 reports presses and releases but not motion.
    if (tracking === 'vt200' && (mouse.kind === 'drag' || mouse.kind === 'move')) return
    // Only mode 1003 asks for motion with no button held.
    if (tracking === 'drag' && mouse.kind === 'move') return

    const inner = innerOf(target.rect)
    const encoded = encodeMouse({ ...mouse, column: mouse.column - inner.x, row: mouse.row - inner.y })
    if (!encoded) return
    // To the pane the coordinates were translated for, not to whichever pane has focus:
    // a drag that wanders out of the pane it started in would otherwise deliver another
    // pane's coordinates to the focused one.
    this.writeToSession(view.sessionId, encoded)
  }

  /**
   * Follow the pointer over the sidebar, and redraw only when the row changes.
   *
   * Returns true for a bare motion event, which ends the event's journey here: a move
   * with no button held is not a click and must never reach a pane, or every pointer
   * sweep across the window would be typed at whatever program is under it.
   *
   * The `hoverRow !== row` guard is the whole reason this is affordable. Mode 1003
   * reports every *cell* the pointer crosses, so a sweep down the sidebar is dozens of
   * events for a handful of row changes; redrawing per event would spend a frame on
   * each one.
   */
  private trackHover(mouse: MouseEvent): boolean {
    if (mouse.kind !== 'move') return false
    if (!this.config.general.mouseHover) return true
    // The raw pointer, because two different things read it: the sidebar wants the
    // row (and only when the pointer is actually over the sidebar), and the pane
    // buttons want the exact cell.
    const before = { sidebar: this.sidebarHoverRow(), button: this.hoveredButtonKey() }
    this.hoverRow = mouse.row
    this.hoverColumn = mouse.column

    // Mode 1003 reports every cell the pointer crosses, so the guard is on what would
    // actually be drawn differently — not on the pointer having moved. A sweep along
    // one sidebar row, or across a pane's middle, redraws nothing.
    const after = { sidebar: this.sidebarHoverRow(), button: this.hoveredButtonKey() }
    if (before.sidebar !== after.sidebar || before.button !== after.button) this.requestRender()
    return true
  }

  /** The sidebar's hovered row, or -1 when the pointer is elsewhere. */
  private sidebarHoverRow(): number {
    const sidebar = this.sidebarArea()
    if (sidebar === null || this.hoverRow < 0 || this.hoverColumn < 0) return -1
    return contains(sidebar, this.hoverColumn, this.hoverRow) ? this.hoverRow : -1
  }

  /** Identifies the pane button under the pointer, for change detection. */
  private hoveredButtonKey(): string | null {
    const button = this.hits.paneButtons.find(
      (entry) => this.hoverRow === entry.y && this.hoverColumn >= entry.x && this.hoverColumn < entry.end
    )
    return button === null || button === undefined ? null : `${button.paneId}:${button.action}`
  }

  /**
   * Every binding, spelled for a human.
   *
   * Built from the live config rather than a hardcoded list, so a user who rebound
   * their prefix sees *their* keys. Prefix bindings are shown as "Ctrl+B then %",
   * because that two-step is the thing newcomers do not know and a list that wrote
   * `C-b %` would assume they already did.
   */
  private keyReference(): { chord: string; summary: string }[] {
    const summaries = new Map(COMMANDS.map((command) => [command.name, command.summary]))
    const prefix = describeChord(this.config.keys.prefix)
    const rows: { chord: string; summary: string }[] = [
      { chord: prefix, summary: 'the prefix: press it, let go, then the key below' }
    ]
    for (const [chord, command] of Object.entries(this.config.keys.prefixBindings)) {
      if (command.length === 0) continue
      rows.push({ chord: `${prefix} then ${describeChord(chord)}`, summary: summaries.get(command) ?? command })
    }
    for (const [chord, command] of Object.entries(this.config.keys.directBindings)) {
      if (command.length === 0) continue
      rows.push({ chord: describeChord(chord), summary: summaries.get(command) ?? command })
    }
    rows.push({ chord: 'click / drag', summary: 'focus a pane, use the sidebar, drag a divider to resize' })
    return rows
  }

  /** Ask before something destructive, then do it. */
  private askConfirm(title: string, detail: string, confirm: () => Promise<void>): void {
    this.confirm = new ConfirmDialog({ title, detail, confirm })
    this.requestRender()
  }

  private async resolveConfirm(outcome: ConfirmOutcome): Promise<void> {
    if (outcome === 'pending') return
    const dialog = this.confirm
    this.confirm = null
    this.requestRender()
    if (outcome === 'confirmed' && dialog !== null) await dialog.request.confirm()
  }

  /** How many panes a workspace holds, for the confirmation's detail line. */
  private paneCountOf(workspaceId: string): number {
    return panesOf(this.state, workspaceId).length
  }

  /** Carry out what the settings dialog asked for. */
  private async applySettingsOutcome(outcome: SettingsOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'none':
        return
      case 'close':
        this.settings = null
        this.requestRender()
        return
      case 'redraw':
        this.requestRender()
        return
      case 'apply-theme': {
        // Written to the config file and reloaded, so the choice survives a restart.
        // The daemon owns the file; the client only asks.
        const result = (await this.call('config.set_theme', { theme: outcome.theme })) as {
          config?: Config
        } | null
        if (result?.config !== undefined) this.applyConfig(result.config, [], [])
        this.settings = null
        this.setStatus(`theme: ${outcome.theme}`)
        this.requestRender()
        return
      }
      case 'toggle-sound': {
        const result = (await this.call('config.set', { path: outcome.path, value: outcome.value })) as {
          config?: Config
        } | null
        if (result?.config !== undefined) {
          this.applyConfig(result.config, [], [])
          if (this.settings !== null) this.settings.sound = { ...result.config.sound }
        }
        this.requestRender()
        return
      }
      case 'install-integration': {
        const installed = (await this.call('integration.install', {
          agents: [outcome.agent]
        })) as IntegrationInstallResult | null
        const first = installed?.outcomes[0]
        this.setStatus(first === undefined ? 'nothing installed' : `${first.agent}: ${first.result}`)
        // Re-read rather than assume: install reports what it did, `list` reports
        // what is now true, and the dialog shows the latter.
        const listed = (await this.call('integration.list', {})) as IntegrationListResult | null
        if (listed !== null && this.settings !== null) this.settings.integrations = listed.integrations
        this.requestRender()
        return
      }
    }
  }

  /** Open the rename dialog for a workspace or a tab. */
  /**
   * Rename the focused pane.
   *
   * The focused one rather than a neighbour of whatever was clicked, because a divider
   * grip sits *between* two panes and belongs to neither. herdr makes the same choice
   * for `prefix+shift+p`, and the focused pane is the one the border already highlights.
   */
  private renameFocusedPane(): void {
    const pane = paneById(this.state, this.state.focusedPaneId)
    if (pane === null) return
    // The placeholder, not `paneTitle`: seeding the field with the program's own OSC
    // title would make every rename start by deleting text the user never typed.
    const current = pane.label !== null && pane.label.length > 0 ? pane.label : ''
    this.openRename('pane', pane.paneId, current)
  }

  private openRename(kind: 'workspace' | 'tab' | 'pane', id: string, current: string): void {
    this.prompt = { dialog: new PromptDialog(`rename ${kind}`, current), kind, id }
    this.requestRender()
  }

  /**
   * Keys while the rename dialog is open.
   *
   * The text a keystroke produced is the layout's answer and beats anything
   * reconstructed here — on a French layout `Shift+2` is `é`. Failing that, `char` is
   * the *unshifted* codepoint (phase 3's `parseChord` note), so a held Shift needs
   * `shiftedChar`.
   */
  private async handlePromptKey(key: Key): Promise<void> {
    const prompt = this.prompt
    if (prompt === null) return
    const typed =
      key.text ??
      (hasModifier(key.modifiers, MOD_SHIFT) && key.shiftedChar !== undefined ? key.shiftedChar : key.char)
    const outcome = prompt.dialog.handleKey(
      key.name,
      hasModifier(key.modifiers, MOD_ALT) ? undefined : typed,
      hasModifier(key.modifiers, MOD_CTRL)
    )
    await this.resolvePrompt(outcome)
  }

  private async resolvePrompt(outcome: PromptOutcome): Promise<void> {
    const prompt = this.prompt
    if (prompt === null || outcome.kind === 'pending') {
      this.requestRender()
      return
    }
    this.prompt = null
    this.requestRender()
    if (outcome.kind === 'cancelled') return
    // An empty name *clears* it rather than setting an empty one, which is how the
    // default numbering comes back.
    if (prompt.kind === 'workspace') {
      await this.call('workspace.rename', { workspaceId: prompt.id, label: outcome.value })
    } else if (prompt.kind === 'pane') {
      await this.call('pane.rename', { paneId: prompt.id, label: outcome.value })
    } else {
      await this.call('tab.rename', { tabId: prompt.id, label: outcome.value })
    }
  }

  /** Carry out a popup-menu choice. */
  private async resolveMenu(result: MenuOutcome): Promise<void> {
    if (result.kind === 'pending') {
      this.requestRender()
      return
    }
    const open = this.menu
    this.menu = null
    this.requestRender()
    if (result.kind === 'cancelled' || open === null) return
    await open.choose(result.id)
  }

  /**
   * The `menu` entry in the sidebar: everything that acts on the *session* rather
   * than on one workspace.
   *
   * `stop server` is here because there was no way to do it from inside the program
   * at all — detaching leaves the daemon running by design, and the only cure was
   * `leap-chorus kill-server` from another shell. A thing you can start from the UI
   * should be stoppable from the UI.
   */
  private openAppMenu(column: number, row: number): void {
    this.menu = {
      menu: new ContextMenu(
        [
          { label: 'settings', id: 'settings' },
          { label: 'keybinds', id: 'keybinds' },
          { label: 'reload config', id: 'reload' },
          { label: 'detach', id: 'detach' },
          { label: 'stop server', id: 'stop' }
        ],
        { column, row }
      ),
      choose: async (id) => {
        switch (id) {
          case 'settings':
            await this.runCommand('client.settings')
            if (this.settings !== null) this.settings.section = 'theme'
            this.requestRender()
            return
          case 'keybinds':
            await this.runCommand('client.settings')
            return
          case 'reload':
            await this.runCommand('client.reload-config')
            return
          case 'detach':
            await this.runCommand('client.detach')
            return
          case 'stop': {
            const panes = this.state.panes.length
            this.askConfirm(
              'Stop the server?',
              `${panes} pane${panes === 1 ? '' : 's'} in ${this.state.workspaces.length} workspace${this.state.workspaces.length === 1 ? '' : 's'} — everything running in them ends`,
              async () => {
                // The daemon shuts itself down; the client then has nothing to attach
                // to, so it quits too rather than sitting on a dead socket.
                await this.call('daemon.shutdown', {})
                this.options.onExit?.('server stopped')
              }
            )
            return
          }
        }
      }
    }
    this.requestRender()
  }

  /**
   * Drag a split divider to resize.
   *
   * The API half of this has existed since phase 4 — `splitBorders()` reports every
   * divider with the path that names it, and `layout.set_split_ratio` takes exactly
   * that path — but nothing turned a drag into the call. This is that.
   *
   * Three events make a drag: a press on a divider starts one, drags move it, and a
   * release ends it. The press is claimed here so it never reaches "focus the pane
   * under the cursor" — a divider belongs to the split, not to either neighbour.
   *
   * The ratio is recomputed from the pointer's absolute position rather than
   * accumulated from deltas, so a drag that outruns the render loop lands where the
   * pointer actually is instead of drifting behind it.
   */
  /**
   * Drag the sidebar's right edge to resize it.
   *
   * Separate from `handleDivider` because it is not a split: there is no tree path and
   * no `layout.set_split_ratio` at the other end. The width stays in the client, which
   * is the rule for anything that depends on *this* terminal's size.
   */
  private handleSidebarDrag(mouse: MouseEvent): boolean {
    if (this.draggingSidebar) {
      // ONLY `drag` continues a drag. `move` is motion with no button held, and
      // accepting it meant that once a drag had started, merely moving the pointer
      // anywhere kept resizing — the button release was never required. With motion
      // reporting on by default that turned every near-miss into a runaway resize.
      if (mouse.kind === 'drag') {
        this.sidebarWidthOverride = Math.max(MIN_SIDEBAR_WIDTH, mouse.column + 1)
        this.invalidate()
        return true
      }
      // Ignored, for the reason spelled out in `handleDivider`: with motion reporting
      // on, `move` interleaves with a real drag and cannot be read as the end of one.
      if (mouse.kind === 'move') return true
      // Anything else ends it, not just `up`: a drag that loses its release — a
      // pointer leaving the window, a report the terminal never sent — must not stay
      // armed forever. A stray press clears it and is then handled normally.
      this.draggingSidebar = false
      return mouse.kind === 'up'
    }
    if (mouse.kind !== 'down') return false
    // A grip, not the whole edge. See `HitRegions.grips`.
    const grip = this.hits.grips.find(
      (entry) => entry.kind === 'sidebar' && entry.y === mouse.row && Math.abs(entry.x - mouse.column) <= 1
    )
    if (grip === undefined) return false
    this.draggingSidebar = true
    return true
  }

  private async handleDivider(mouse: MouseEvent): Promise<boolean> {
    if (this.drag !== null) {
      // As with the sidebar: only `drag` continues. `move` is the pointer travelling
      // with no button down, and treating it as a drag made a divider follow the
      // pointer around the screen long after the click that started it.
      if (mouse.kind === 'drag') {
        this.drag.moved = true
        await this.resizeDivider(this.drag, mouse)
        return true
      }
      // A `move` does not end a drag, it is just ignored. Motion reporting is on by
      // default, so the terminal emits `move` for the same pointer travel that
      // produces `drag`, and one arriving mid-drag — or one sent just before the
      // press and decoded just after it — used to cancel the resize outright. That is
      // what made dragging a divider stop working, intermittently and then for good.
      // Not resizing on `move` is what keeps the old bug fixed: a released button
      // cannot keep dragging, because only `drag` moves anything.
      if (mouse.kind === 'move') return true
      const wasUp = mouse.kind === 'up'
      const clicked = wasUp && !this.drag.moved
      this.drag = null
      // A press and release on the grip with no movement in between is a click, not a
      // resize of zero columns. That is the gesture that names the pane.
      if (clicked) this.renameFocusedPane()
      return wasUp
    }
    if (mouse.kind !== 'down') return false

    const tab = activeTab(this.state)
    if (tab === null || tab.zoomed) return false
    // A grip, not anywhere along the divider. A border is a long target that a click
    // meant for a pane lands on constantly.
    const grip = this.hits.grips.find(
      (entry) =>
        entry.kind === 'divider' &&
        Math.abs(entry.x - mouse.column) <= 1 &&
        Math.abs(entry.y - mouse.row) <= 1
    )
    if (grip?.path === undefined || grip.direction === undefined) return false

    this.drag = { tabId: tab.tabId, path: grip.path, direction: grip.direction, moved: false }
    return true
  }

  private async resizeDivider(
    drag: { tabId: string; path: readonly boolean[]; direction: 'horizontal' | 'vertical' },
    mouse: MouseEvent
  ): Promise<void> {
    const tab = activeTab(this.state)
    if (tab === null || tab.tabId !== drag.tabId) return
    const border = splitBorders(toLayoutNode(tab.layout), this.contentArea()).find(
      (entry) => entry.path.length === drag.path.length && entry.path.every((step, i) => step === drag.path[i])
    )
    if (border === undefined) return

    const span = drag.direction === 'horizontal' ? border.area.width : border.area.height
    if (span <= 1) return
    const offset =
      drag.direction === 'horizontal' ? mouse.column - border.area.x : mouse.row - border.area.y
    const ratio = offset / span
    // Clamped by the daemon too; clamping here stops a drag off the edge from
    // sending a stream of identical rejected calls.
    if (!(ratio > 0.02 && ratio < 0.98)) return
    if (Math.abs(ratio - border.ratio) < 0.005) return

    await this.call('layout.set_split_ratio', { tabId: tab.tabId, path: [...drag.path], ratio })
  }

  /**
   * A click on a pane's border buttons.
   *
   * Checked before the pane hit test, because the buttons sit *on* the border and the
   * border belongs to the pane: without this the click would fall through to
   * "focus that pane" and the button would do nothing.
   */
  private async handlePaneButton(mouse: MouseEvent): Promise<boolean> {
    if (mouse.kind !== 'down') {
      // Swallow the matching release too, or it reaches the pane underneath.
      return this.hits.paneButtons.some(
        (button) => mouse.row === button.y && mouse.column >= button.x && mouse.column < button.end
      )
    }
    const button = this.hits.paneButtons.find(
      (entry) => mouse.row === entry.y && mouse.column >= entry.x && mouse.column < entry.end
    )
    if (button === undefined) return false

    switch (button.action) {
      case 'split-right':
        await this.call('pane.split', { targetPaneId: button.paneId, direction: 'right', focus: true })
        return true
      case 'split-down':
        await this.call('pane.split', { targetPaneId: button.paneId, direction: 'down', focus: true })
        return true
      case 'close':
        await this.call('pane.close', { paneId: button.paneId })
        return true
    }
  }

  /**
   * Notify when an agent's state changes to one worth interrupting for.
   *
   * On the *transition*, not the state: a pane that has been blocked for a minute
   * must not ring on every poll. Each pane's previous status comes from the snapshot
   * we are replacing, which is the only place it is recorded — the client keeps no
   * side table, because agent state is the daemon's to own.
   *
   * One notification per refresh however many panes changed, since the point is to get
   * the user's attention once, not to count events at them. `blocked` wins a tie: it
   * is the state that is waiting on the human.
   */
  private ringForAgentChanges(previous: SessionStateSnapshot, next: SessionStateSnapshot): void {
    const { agentDone, agentBlocked } = this.config.sound
    if (!agentDone && !agentBlocked) return
    const before = new Map(previous.panes.map((pane) => [pane.paneId, pane.agentStatus ?? null]))

    let kind: SoundKind | null = null
    for (const pane of next.panes) {
      const now = pane.agentStatus ?? null
      if (now === null) continue
      const was = before.get(pane.paneId)
      // A pane the previous snapshot did not have is not a transition: attaching to a
      // session full of blocked agents should not play a fanfare.
      if (was === undefined || was === now) continue
      const blocked = now === 'blocked' && agentBlocked
      const done = (now === 'idle' || now === 'done') && agentDone
      // Only from `working`: idle -> done is the agent exiting, which the user did.
      const fromWork = was === 'working' || (now === 'blocked' && was !== 'blocked')
      if (!fromWork) continue
      if (blocked) {
        kind = 'blocked'
        break
      }
      if (done) kind = 'done'
    }
    if (kind === null) return

    const custom = kind === 'blocked' ? this.config.sound.blockedPath : this.config.sound.donePath
    // The bell is the fallback, not the mechanism: a machine with no audio player at
    // all still gets whatever its terminal does with `\x07`.
    if (!playSound(kind, custom)) this.options.write('\u0007')
  }

  /** The `»` in the status bar brings a collapsed sidebar back. */
  private async handleStatusClick(mouse: MouseEvent): Promise<boolean> {
    if (mouse.kind !== 'down' || this.statusRows() === 0) return false
    if (mouse.row !== this.rows - 1 || mouse.column > 2) return false
    if (this.showSidebar()) return false
    this.sidebarMode = 'full'
    this.invalidate()
    return true
  }

  private async handleChromeClick(mouse: MouseEvent): Promise<boolean> {
    // Only a press acts; a release or a drag over the chrome is swallowed so it does
    // not reach a pane whose coordinates it is not in.
    const sidebar = this.sidebarArea()
    const inSidebar = sidebar !== null && contains(sidebar, mouse.column, mouse.row)
    const inTabBar = this.hits.tabBarRow >= 0 && mouse.row === this.hits.tabBarRow
    if (!inSidebar && !inTabBar) return false
    // Right-click is a context menu, not a selection. Checked before the left-click
    // handling below so the two gestures never both fire on one row.
    if (inSidebar && mouse.button === 'right' && mouse.kind === 'down') {
      const workspaceId = this.hits.workspaceRows.get(mouse.row)
      if (workspaceId !== undefined) {
        this.menu = {
          menu: new ContextMenu(
            [
              { label: 'Rename', id: 'rename' },
              { label: 'Close', id: 'close' }
            ],
            { column: mouse.column, row: mouse.row }
          ),
          choose: async (id) => {
            const workspace = workspaceById(this.state, workspaceId)
            if (workspace === null) return
            if (id === 'rename') {
              this.openRename('workspace', workspace.workspaceId, workspaceTitle(workspace))
              return
            }
            const count = this.paneCountOf(workspace.workspaceId)
            this.askConfirm(
              'Close workspace?',
              `${workspaceTitle(workspace)} — ${count} pane${count === 1 ? '' : 's'}`,
              async () => {
                await this.call('workspace.close', { workspaceId: workspace.workspaceId })
              }
            )
          }
        }
        this.requestRender()
      }
      return true
    }
    if (mouse.kind !== 'down') return true

    if (inSidebar) {
      // Checked before the row itself: the `x` sits on the row, and falling through
      // would focus the workspace instead of closing it.
      const close = this.hits.workspaceCloseSpans.find(
        (entry) => mouse.row === entry.y && mouse.column >= entry.x && mouse.column < entry.end
      )
      if (close !== undefined) {
        const target = workspaceById(this.state, close.workspaceId)
        const count = this.paneCountOf(close.workspaceId)
        this.askConfirm(
          'Close workspace?',
          `${target === null ? 'workspace' : workspaceTitle(target)} — ${count} pane${count === 1 ? '' : 's'}`,
          async () => {
            await this.call('workspace.close', { workspaceId: close.workspaceId })
          }
        )
        return true
      }
      // Clicking an agent jumps to it wherever it is: switch workspace, then focus
      // the pane. That is the whole point of listing agents you cannot currently see.
      const agent = this.hits.agentRows.get(mouse.row)
      if (agent !== undefined) {
        if (agent.workspaceId !== this.state.activeWorkspaceId) {
          await this.call('workspace.focus', { workspaceId: agent.workspaceId })
        }
        await this.call('pane.focus', { paneId: agent.paneId })
        return true
      }
      const tabId = this.hits.sidebarTabRows.get(mouse.row)
      if (tabId !== undefined) {
        await this.call('tab.focus', { tabId })
        return true
      }
      // `«` collapses the sidebar. Checked first: it sits on a row that may also be
      // part of the agents list.
      const collapse = this.hits.collapse
      if (collapse !== null && mouse.row === collapse.y && mouse.column >= collapse.x && mouse.column < collapse.end) {
        // `«` collapses to the rail, `»` on the rail expands again. The same corner,
        // the same click, reversible without hunting for a key.
        this.sidebarMode = this.sidebarMode === 'rail' ? 'full' : 'rail'
        this.invalidate()
        return true
      }
      const actions = this.hits.actionRow
      if (actions !== null && mouse.row === actions.row) {
        // Right half opens the menu, anything else on the row makes a workspace: on a
        // row labelled `new`, that is the likelier intent for a stray click.
        if (mouse.column >= actions.menuStart) this.openAppMenu(mouse.column, mouse.row)
        else await this.call('workspace.create', { focus: true })
        return true
      }
      if (mouse.row === this.hits.newWorkspaceRow) {
        await this.call('workspace.create', { focus: true })
        return true
      }
      const workspaceId = this.hits.workspaceRows.get(mouse.row)
      if (workspaceId !== undefined) await this.call('workspace.focus', { workspaceId })
      return true
    }
    if (this.hits.newTabSpan !== null && inTabBar) {
      const span = this.hits.newTabSpan
      if (mouse.column >= span.x && mouse.column < span.end) {
        await this.call('tab.create', { focus: true })
        return true
      }
    }
    const hit = this.hits.tabSpans.find((entry) => mouse.column >= entry.x && mouse.column < entry.end)
    if (hit) await this.call('tab.focus', { tabId: hit.tabId })
    return true
  }

  private scrollPane(paneId: string, kind: 'scrollup' | 'scrolldown'): void {
    const record = paneById(this.state, paneId)
    if (!record) return
    const step = this.config.general.scrollStep > 0 ? this.config.general.scrollStep : 3
    const offset = kind === 'scrollup' ? record.scrollOffset + step : Math.max(0, record.scrollOffset - step)
    void this.call('pane.scroll', { paneId, offsetFromBottom: offset })
  }

  /**
   * Deliver a paste as one write.
   *
   * A pane that turned on mode 2004 gets it bracketed, so its editor can tell a paste
   * from a very fast typist and skip auto-indent. A pane that did not gets the bytes
   * bare — sending brackets it never asked for would put `[200~` in its buffer.
   */
  private handlePaste(data: Uint8Array): void {
    const target = this.focusedView()
    if (!target) return
    const bracketed = target.view.snapshot?.keyboard?.bracketedPaste ?? false
    this.writeToSession(target.view.sessionId, bracketed ? encodeBracketedPaste(data) : data)
  }

  private sendToFocused(bytes: Uint8Array): void {
    const target = this.focusedView()
    if (!target) return
    this.writeToSession(target.view.sessionId, bytes)
  }

  private writeToSession(sessionId: string | null, bytes: Uint8Array): void {
    if (sessionId === null) return
    void this.options.client
      .call('session.write', { id: sessionId, ...encodeWritePayload(bytes) })
      .catch(() => {
        // A session that died between the keystroke and the write is not an error here;
        // its exit event is already on the way.
      })
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** The reference geometry the daemon needs for direction-sensitive actions. */
  private viewport(): { cols: number; rows: number } {
    const area = this.contentArea()
    return { cols: Math.max(1, area.width), rows: Math.max(1, area.height) }
  }

  private async call<M extends Parameters<DaemonClient['call']>[0]>(
    method: M,
    params: Parameters<DaemonClient['call']>[1]
  ): Promise<unknown> {
    try {
      const result = await this.options.client.call(method, params as never)
      await this.refreshState()
      return result
    } catch (error) {
      this.setStatus(messageOf(error))
      this.requestRender()
      return null
    }
  }

  /** Run a command by name. Public so a test can drive the app without synthesising keys. */
  async runCommand(command: string): Promise<void> {
    const viewport = this.viewport()
    const workspace = activeWorkspace(this.state)
    const tab = activeTab(this.state)

    switch (command) {
      case 'pane.split-right':
        await this.split('horizontal')
        return
      case 'pane.split-down':
        await this.split('vertical')
        return
      case 'pane.close':
        if (this.state.focusedPaneId !== null) await this.call('pane.close', { paneId: this.state.focusedPaneId })
        return
      case 'pane.zoom':
        await this.call('pane.zoom', { mode: 'toggle' })
        return
      case 'pane.focus-left':
      case 'pane.focus-right':
      case 'pane.focus-up':
      case 'pane.focus-down':
        await this.call('pane.focus_direction', { direction: directionOf(command), viewport })
        return
      case 'pane.focus-next':
      case 'pane.focus-previous': {
        const ids = this.paneIds()
        if (ids.length === 0) return
        const index = ids.indexOf(this.state.focusedPaneId ?? '')
        const step = command === 'pane.focus-next' ? 1 : -1
        const next = ids[(((index < 0 ? 0 : index) + step + ids.length) % ids.length)]
        if (next !== undefined) await this.call('pane.focus', { paneId: next })
        return
      }
      case 'pane.resize-left':
      case 'pane.resize-right':
      case 'pane.resize-up':
      case 'pane.resize-down':
        await this.call('pane.resize', { direction: directionOf(command), viewport })
        return
      case 'pane.swap-left':
      case 'pane.swap-right':
      case 'pane.swap-up':
      case 'pane.swap-down':
        await this.call('pane.swap', { direction: directionOf(command), viewport })
        return
      case 'pane.scroll-up':
      case 'pane.scroll-down':
      case 'pane.scroll-bottom': {
        const paneId = this.state.focusedPaneId
        if (paneId === null) return
        const record = paneById(this.state, paneId)
        if (!record) return
        const page = Math.max(1, this.contentArea().height - 2)
        const step = this.config.general.scrollStep > 0 ? this.config.general.scrollStep : page
        const offset =
          command === 'pane.scroll-bottom'
            ? 0
            : command === 'pane.scroll-up'
              ? record.scrollOffset + step
              : Math.max(0, record.scrollOffset - step)
        await this.call('pane.scroll', { paneId, offsetFromBottom: offset })
        return
      }
      case 'tab.create':
        await this.call('tab.create', {})
        return
      case 'tab.close':
        if (tab) await this.call('tab.close', { tabId: tab.tabId })
        return
      case 'tab.next':
      case 'tab.previous': {
        if (!workspace) return
        const tabs = tabsOf(this.state, workspace.workspaceId)
        if (tabs.length === 0) return
        const index = tabs.findIndex((entry) => entry.tabId === workspace.activeTabId)
        const step = command === 'tab.next' ? 1 : -1
        const next = tabs[(((index < 0 ? 0 : index) + step + tabs.length) % tabs.length)]
        if (next) await this.call('tab.focus', { tabId: next.tabId })
        return
      }
      case 'workspace.create':
        await this.call('workspace.create', { focus: true })
        return
      case 'client.settings': {
        const dialog = new SettingsDialog(this.config.themeName, this.keyReference())
        dialog.sound = { ...this.config.sound }
        this.settings = dialog
        this.requestRender()
        // Ask the daemon what is installed; the dialog draws a placeholder until it
        // answers, rather than blocking the keystroke that opened it.
        void this.options.client
          .call('integration.list', {})
          .then((result: IntegrationListResult) => {
            dialog.integrations = result.integrations
            if (this.settings === dialog) this.requestRender()
          })
          .catch(() => undefined)
        return
      }
      case 'workspace.rename': {
        if (workspace === null) return
        this.openRename('workspace', workspace.workspaceId, workspaceTitle(workspace))
        return
      }
      case 'tab.rename': {
        const active = activeTab(this.state)
        if (active === null) return
        this.openRename('tab', active.tabId, tabTitle(active))
        return
      }
      case 'pane.rename': {
        this.renameFocusedPane()
        return
      }
      case 'workspace.close': {
        if (workspace === null) return
        const count = this.paneCountOf(workspace.workspaceId)
        this.askConfirm(
          'Close workspace?',
          `${workspaceTitle(workspace)} — ${count} pane${count === 1 ? '' : 's'}`,
          async () => {
            await this.call('workspace.close', { workspaceId: workspace.workspaceId })
          }
        )
        return
      }
      case 'workspace.next':
      case 'workspace.previous': {
        const order = this.state.workspaceOrder
        if (order.length === 0) return
        const index = order.indexOf(this.state.activeWorkspaceId ?? '')
        const step = command === 'workspace.next' ? 1 : -1
        const next = order[(((index < 0 ? 0 : index) + step + order.length) % order.length)]
        if (next !== undefined) await this.call('workspace.focus', { workspaceId: next })
        return
      }
      case 'client.detach':
        this.options.onExit?.('detached')
        return
      case 'client.quit':
        this.options.onExit?.('quit')
        return
      case 'client.repaint':
        this.invalidate()
        this.setStatus('repaint')
        return
      case 'client.reload-config': {
        const result = await this.options.client.call('server.reload_config', {}).catch(() => null)
        if (result !== null) {
          this.applyConfig(result.config as Config, result.problems as readonly ConfigProblem[], result.errors)
          if (result.problems.length === 0 && result.errors.length === 0) {
            this.setStatus(`config reloaded (${result.paneCount} panes kept)`)
          }
        }
        this.requestRender()
        return
      }
      case 'client.toggle-sidebar':
        // The key still means "all the columns, or none" — the rail is the `«`'s job.
        this.sidebarMode = this.sidebarMode === 'hidden' ? 'full' : 'hidden'
        this.invalidate()
        return
      case 'client.send-prefix':
        // Handled where the prefix is consumed; reaching here means it was bound
        // directly, which would send the prefix to a pane that never saw one.
        return
      default:
        this.setStatus(`unknown command: ${command}`)
        this.requestRender()
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) return
    this.cols = Math.max(1, cols)
    this.rows = Math.max(1, rows)
    this.front.resize(this.cols, this.rows)
    this.back.resize(this.cols, this.rows)
    // The terminal cleared its own screen on resize; nothing in `front` is trustworthy.
    this.invalidate()
  }

  /** Force the next frame to be a full repaint and schedule it. */
  invalidate(): void {
    this.forceRepaint = true
    // The terminal's cursor is wherever the resize or the repaint left it; re-state it.
    this.lastCursor = null
    for (const view of this.views.values()) view.dirty = true
    this.requestRender()
  }

  requestRender(): void {
    if (this.closed || this.options.autoRender === false) return
    if (this.renderScheduled !== null) return
    if (this.rendering) {
      this.renderPending = true
      return
    }
    const timer = setTimeout(() => {
      this.renderScheduled = null
      void this.render()
    }, FRAME_INTERVAL_MS)
    timer.unref()
    this.renderScheduled = timer
  }

  private setStatus(text: string): void {
    this.status = text
  }

  /** Compose, diff, encode, write. Returns what the frame cost. */
  async render(): Promise<FrameStats> {
    if (this.closed) return emptyStats()
    if (this.rendering) {
      this.renderPending = true
      return this.lastFrame ?? emptyStats()
    }
    this.rendering = true
    const started = performance.now()

    try {
      const visible = this.visiblePanes()
      const fetched = await this.syncVisiblePanes(visible)
      const fetchMs = performance.now() - started

      const paintStarted = performance.now()
      this.back.clear()
      this.hits = emptyHitRegions()
      let composed = 0
      let cursor: { x: number; y: number; visible: boolean } | null = null

      const zoomed = activeTab(this.state)?.zoomed ?? false
      for (const entry of visible) {
        const view = this.views.get(entry.paneId)
        const record = paneById(this.state, entry.paneId)
        if (!view || !record) continue
        const inner = this.config.ui.paneBorders
          ? renderBlock(this.back, entry.rect, {
              borders: BORDER_ALL,
              // Focus is signalled by color alone, not by a different glyph set: a
              // style-only change diffs to the same cells with new SGR, where swapping
              // box-drawing characters would repaint every border cell on every move.
              chars: PLAIN_BORDER,
              borderStyle: entry.focused ? this.palette.focusBorder : this.palette.idleBorder,
              title: paneTitle(record),
              titleStyle: this.palette.paneTitle,
              // The agent badge goes on the right of the border, where ZOOM goes —
              // and ZOOM wins when both apply, because a zoomed pane is a layout
              // state the user needs to know how to undo.
              ...this.paneRightTitle(record, zoomed && entry.focused)
            })
          : entry.rect
        if (this.config.ui.paneBorders) {
          renderPaneButtons(
            this.back,
            entry.rect,
            entry.paneId,
            this.palette,
            this.hits,
            entry.focused,
            this.config.ui.paneButtons,
            { column: this.hoverColumn, row: this.hoverRow }
          )
        }
        if (inner.width <= 0 || inner.height <= 0) continue
        if (view.snapshot) {
          blitSnapshot(this.back, inner, view.snapshot)
          if (entry.focused) cursor = snapshotCursor(inner, view.snapshot)
        } else {
          renderParagraph(this.back, inner, [{ spans: [span('…', DEFAULT_STYLE)] }])
        }
        composed++
      }

      const sidebar = this.sidebarArea()
      if (sidebar !== null) {
        if (this.sidebarMode === 'rail') {
          renderSidebarRail(this.back, sidebar, this.state, this.palette, this.hits, this.sidebarHoverRow())
        } else {
          renderSidebar(this.back, sidebar, this.state, this.palette, this.hits, this.sidebarHoverRow())
        }
      }
      // Grips last among the pane chrome, so they sit on top of the borders they
      // belong to rather than being overwritten by the next pane's block.
      const activeForGrips = activeTab(this.state)
      if (activeForGrips !== null && !activeForGrips.zoomed) {
        renderDividerGrips(
          this.back,
          splitBorders(toLayoutNode(activeForGrips.layout), this.contentArea()),
          this.palette,
          this.hits
        )
      }
      const tabBar = this.tabBarArea()
      if (tabBar !== null) renderTabBar(this.back, tabBar, this.state, this.palette, this.hits)
      // The dialog draws last, over everything: that is what makes it modal on a
      // screen that has no z-order of its own.
      if (this.settings !== null) {
        const area = settingsArea(this.cols, this.rows)
        renderBlock(this.back, area, {
          borders: BORDER_ALL,
          chars: PLAIN_BORDER,
          borderStyle: this.palette.focusBorder
        })
        this.settings.render(this.back, { x: area.x + 1, y: area.y + 1, width: area.width - 2, height: area.height - 2 }, this.palette)
      }
      if (this.prompt !== null) {
        const area = promptArea(this.cols, this.rows)
        renderBlock(this.back, area, {
          borders: BORDER_ALL,
          chars: PLAIN_BORDER,
          borderStyle: this.palette.focusBorder
        })
        this.prompt.dialog.render(this.back, area, this.palette)
      }
      if (this.menu !== null) {
        const area = this.menu.menu.area(this.cols, this.rows)
        renderBlock(this.back, area, {
          borders: BORDER_ALL,
          chars: PLAIN_BORDER,
          borderStyle: this.palette.focusBorder
        })
        this.menu.menu.render(this.back, area, this.palette)
      }
      if (this.confirm !== null) {
        const area = confirmArea(this.cols, this.rows)
        renderBlock(this.back, area, {
          borders: BORDER_ALL,
          chars: PLAIN_BORDER,
          borderStyle: this.palette.agent['blocked'] ?? this.palette.focusBorder
        })
        this.confirm.render(this.back, area, this.palette)
      }
      if (this.statusRows() > 0) {
        renderStatusBar(
          this.back,
          { x: 0, y: this.rows - 1, width: this.cols, height: 1 },
          this.statusContent(),
          this.palette
        )
      }

      const spans: DiffSpan[] = this.forceRepaint ? fullSpans(this.back) : diffBuffers(this.front, this.back)
      const placed = cursor ?? { x: 0, y: Math.max(0, this.rows - 1), visible: false }
      const cursorKey = `${placed.x},${placed.y},${placed.visible ? 1 : 0}`

      // Nothing changed and the cursor has not moved: write nothing at all. Without
      // this an idle client still emits a hide/move/show bracket sixty times a second.
      let payload = ''
      if (spans.length > 0 || cursorKey !== this.lastCursor) {
        payload = encodeFrame(this.back, spans, {
          ...(this.options.synchronizedOutput === true ? { synchronizedOutput: true } : {}),
          cursor: placed
        })
        this.options.write(payload)
      }
      this.lastCursor = cursorKey

      this.front.copyFrom(this.back)
      this.forceRepaint = false

      const stats: FrameStats = {
        durationMs: performance.now() - started,
        fetchMs,
        paintMs: performance.now() - paintStarted,
        bytes: Buffer.byteLength(payload, 'utf8'),
        spans: spans.length,
        cells: spans.reduce((total, s) => total + (s.end - s.x), 0),
        panesComposed: composed,
        snapshotsFetched: fetched
      }
      this.lastFrame = stats
      return stats
    } finally {
      this.rendering = false
      if (this.renderPending) {
        this.renderPending = false
        this.requestRender()
      }
    }
  }

  /**
   * What sits on the right of a pane's border.
   *
   * ZOOM beats the agent badge deliberately: a zoomed pane hides its siblings, and a
   * user who cannot see why needs the word more than they need the agent's state,
   * which the sidebar is showing them anyway.
   */
  private paneRightTitle(
    record: PaneRecord,
    zoomed: boolean
  ): { rightTitle?: string; rightTitleStyle?: Style } {
    if (zoomed) return { rightTitle: 'ZOOM', rightTitleStyle: this.palette.focusBorder }
    const badge = agentBadge(record)
    if (badge === null) return {}
    const style = this.palette.agent[record.agentStatus as string]
    return { rightTitle: badge, ...(style === undefined ? {} : { rightTitleStyle: style }) }
  }

  private statusContent(): { left: string; right: string } {
    const workspace = activeWorkspace(this.state)
    const tab = activeTab(this.state)
    const panes = tab === null ? 0 : countLayout(tab.layout)
    // The focused pane's agent, spelled out rather than glyphed: there is room here,
    // and the status bar is where a user looks to find out what a glyph meant.
    const focused = paneById(this.state, this.state.focusedPaneId)
    const agent =
      focused === null || focused.agent === null || focused.agent === undefined || focused.agentStatus == null
        ? ''
        : `${focused.agent}: ${focused.agentStatus}`
    const left = [
      this.showSidebar() ? 'leap-chorus' : '» leap-chorus',
      workspace === null ? '' : `[${workspace.number}]`,
      tab === null ? '' : `${tab.number}`,
      `${panes} pane${panes === 1 ? '' : 's'}`,
      tab?.zoomed === true ? '[zoom]' : '',
      agent
    ]
      .filter((part) => part.length > 0)
      .join('  ')
    const right = this.prefixArmed
      ? 'PREFIX'
      : this.status.length > 0
        ? this.status
        : `${describeChord(this.config.keys.prefix)} ? · menu for keys`
    return { left, right }
  }

  /**
   * Bring visible panes up to date: push geometry changes, pull snapshots.
   *
   * Only visible panes. This is the early exit PHASE-2 criterion 8 measures — a hidden
   * pane is never resized to a layout it is not in and never snapshotted.
   */
  private async syncVisiblePanes(visible: readonly VisiblePane[]): Promise<number> {
    const work: Array<Promise<void>> = []
    for (const entry of visible) {
      const view = this.views.get(entry.paneId)
      if (!view || view.sessionId === null) continue
      const record = paneById(this.state, entry.paneId)
      if (record?.exited === true) continue
      const inner = this.config.ui.paneBorders ? innerOf(entry.rect) : entry.rect
      const cols = Math.max(1, inner.width)
      const rows = Math.max(1, inner.height)
      if (cols !== view.cols || rows !== view.rows) {
        view.cols = cols
        view.rows = rows
        view.dirty = true
        const sessionId = view.sessionId
        work.push(
          this.options.client.call('session.resize', { id: sessionId, cols, rows }).then(
            () => undefined,
            () => undefined
          )
        )
      }
    }
    if (work.length > 0) await Promise.all(work)

    const fetches: Array<Promise<void>> = []
    for (const entry of visible) {
      const view = this.views.get(entry.paneId)
      if (!view || !view.dirty || view.fetching || view.sessionId === null) continue
      const sessionId = view.sessionId
      view.fetching = true
      fetches.push(
        this.options.client.call('session.snapshot', { id: sessionId }).then(
          (result) => {
            view.snapshot = result.snapshot
            view.dirty = false
            view.fetching = false
          },
          () => {
            // A failed fetch leaves the pane dirty, so the next frame tries again
            // rather than showing stale cells until the pane happens to print.
            view.fetching = false
          }
        )
      )
    }
    if (fetches.length > 0) await Promise.all(fetches)
    return fetches.length
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.renderScheduled) clearTimeout(this.renderScheduled)
    this.renderScheduled = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    // A retained mouse prefix must not outlive the session that saw it.
    this.decoder.reset()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Kill every pane in the session. Used by an explicit quit and by tests. */
  async killAll(): Promise<void> {
    const sessions = this.state.panes.flatMap((pane) => (pane.sessionId === null ? [] : [pane.sessionId]))
    await Promise.all(
      sessions.map((id) => this.options.client.call('session.kill', { id }).catch(() => undefined))
    )
  }
}

function countLayout(node: WireLayoutNode): number {
  return node.type === 'pane' ? 1 : countLayout(node.first) + countLayout(node.second)
}

function directionOf(command: string): 'left' | 'right' | 'up' | 'down' {
  if (command.endsWith('-left')) return 'left'
  if (command.endsWith('-right')) return 'right'
  if (command.endsWith('-up')) return 'up'
  return 'down'
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function emptyStats(): FrameStats {
  return { durationMs: 0, fetchMs: 0, paintMs: 0, bytes: 0, spans: 0, cells: 0, panesComposed: 0, snapshotsFetched: 0 }
}

/** The content rect inside a pane's single-cell border. */
export function innerOf(paneRect: Rect): Rect {
  return {
    x: paneRect.x + 1,
    y: paneRect.y + 1,
    width: Math.max(0, paneRect.width - 2),
    height: Math.max(0, paneRect.height - 2)
  }
}

function describeKey(key: Key): string {
  if (key.name === 'char' && key.char !== undefined) return key.char
  if (key.name === 'f') return `F${key.fn ?? 0}`
  return key.name
}
