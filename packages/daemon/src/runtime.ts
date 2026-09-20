/**
 * Where the pure session model meets real terminals.
 *
 * `@leap-chorus/core` decides *what* should happen — a pane appears here, that one is
 * gone — and says so in effects. This file is the only thing that carries them out: it
 * spawns PTYs, kills them, binds session ids back onto panes, and writes the model to
 * disk. Nothing above it knows about `node-pty`, and nothing below it knows about
 * workspaces.
 *
 * ## Why the daemon owns the model at all
 *
 * Workspaces, tabs and panes are shared session organization. Two clients attached to
 * one daemon have to agree about them the way they agree about what a pane printed, and
 * the model has to outlive any one client — which is the whole reason the daemon exists.
 * So the model is here, mutated through RPC, and broadcast as a revision number that
 * clients pull against.
 *
 * Presentation stays out. This file never learns a screen size; pane geometry is pushed
 * by whichever client is drawing, through the `session.resize` it already had.
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  AppState,
  RandomIds,
  applyAction,
  paneIds,
  restoreState,
  serializeState,
  type Action,
  type ActionResult,
  type AppStateOptions,
  type Effect,
  type LayoutNode,
  type Pane
} from '@leap-chorus/core'
import type {
  PaneRecord,
  SessionStateSnapshot,
  TabRecord,
  WireLayoutNode,
  WorkspaceRecord
} from '@leap-chorus/protocol'
import { AgentDetector, type HookReport, type PaneDetectionInput } from '@leap-chorus/detect'
import type { SessionManager } from './sessions.js'

/** Size a pane's PTY is created at, before a client tells us its real geometry. */
export const INITIAL_PANE_COLS = 80
export const INITIAL_PANE_ROWS = 24

/** How long to wait after a change before writing the session file. */
export const PERSIST_DEBOUNCE_MS = 250

/**
 * How often agent detection runs.
 *
 * 750 ms is orca's tracked-pane cadence, and it is a compromise between two costs a
 * faster poll would multiply: a `ps` capture per TTL window, and a region scan per
 * pane per tick. A state badge that lags a third of a second is not a badge anyone
 * notices lagging; a poll at 10 Hz on a 2,000-process host is.
 */
export const DETECT_INTERVAL_MS = 750

export const SESSION_FILE_NAME = 'session-v1.json'

export interface RuntimeOptions {
  readonly sessions: SessionManager
  /** Where the session file lives. Absent means nothing is persisted. */
  readonly sessionPath?: string
  /** Default cwd for the first workspace. */
  readonly defaultCwd?: string
  /** Program new panes run. Absent means the login shell, which `SessionManager` picks. */
  readonly shell?: string
  /** Lines of scrollback each pane keeps. */
  readonly scrollback?: number
  /** Called after every accepted mutation, with the new revision. */
  onChange?(revision: number): void
  /** Injected in tests so persistence can be observed without a timer. */
  readonly persistDebounceMs?: number
  /**
   * The endpoint panes report back to, exported into every pane's environment.
   *
   * Absent means hooks are disabled: an integration with nowhere to send a report
   * exits without sending one, which is the correct behaviour for a pane spawned by a
   * test and for any future runtime that has no socket.
   */
  readonly socketPath?: string
  /** Injected in tests. Absent means a real one over a real `ps`. */
  readonly detector?: AgentDetector
  /** 0 disables the poll entirely, which is what most tests want. */
  readonly detectIntervalMs?: number
  /** The config file a theme choice is written back to. Absent means none is. */
  readonly configPath?: string
}

export function sessionFilePath(daemonDir: string): string {
  return join(daemonDir, SESSION_FILE_NAME)
}

export class SessionRuntime {
  state: AppState
  private readonly sessions: SessionManager
  private readonly options: RuntimeOptions
  private persistTimer: NodeJS.Timeout | null = null
  private disposed = false
  readonly detector: AgentDetector
  private detectTimer: NodeJS.Timeout | null = null
  private detecting = false
  /** Set by `setConfigPath` when a reload names a file. See there. */
  private configPathOverride: string | null = null
  /** The newest hook report per pane, by pane id. See `noteAgentReport`. */
  private readonly hookReports = new Map<string, HookReport>()
  /** Repairs the last restore had to make, surfaced once so a client can show them. */
  readonly restoreRepairs: readonly string[]

  private constructor(options: RuntimeOptions, state: AppState, repairs: readonly string[]) {
    this.options = options
    this.sessions = options.sessions
    this.state = state
    this.restoreRepairs = repairs
    this.detector = options.detector ?? new AgentDetector()
    this.startDetectionPoll()
  }

  /**
   * Build the runtime, restoring the previous session when there is one.
   *
   * ## The daemon starts empty
   *
   * With no session file there are no workspaces, no tabs and no panes, and the daemon
   * spawns nothing. A daemon is not a session: `leap-chorus daemon.info` from a script
   * must not leave a shell running, and the first client is the one that knows what its
   * first pane should be — `leap-chorus -- vim` means vim, not a shell it then has to
   * replace. So `workspace.create` from the client is what brings a session into being.
   *
   * ## A restored pane gets a new PTY
   *
   * The daemon owns its PTYs as children, so a daemon that exited took them with it;
   * "restore" means the arrangement comes back with live terminals in it, not that the
   * old processes are still running. Phase 1's survival guarantee is the other half of
   * this — a daemon that does *not* exit keeps every PTY through any number of client
   * restarts.
   */
  static create(options: RuntimeOptions): SessionRuntime {
    const ids = new RandomIds(() => randomBytes(5).toString('hex'))
    const base: AppStateOptions = {
      ids,
      now: () => Date.now(),
      ...(options.defaultCwd === undefined ? {} : { defaultCwd: options.defaultCwd })
    }

    const document = options.sessionPath === undefined ? null : readDocument(options.sessionPath)
    if (document === null) return new SessionRuntime(options, new AppState(base), [])

    const restored = restoreState(document, base, { bootstrapWhenEmpty: false })
    const runtime = new SessionRuntime(options, restored.state, restored.repairs)
    for (const pane of restored.panes) {
      const record = restored.state.panes.get(pane.paneId)
      if (record) runtime.spawnFor(record)
    }
    runtime.schedulePersist()
    return runtime
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  /**
   * Apply an action and carry out whatever it implies.
   *
   * Effects run *after* the state has changed, in the order the reducer produced them,
   * so a kill never races the removal that caused it. A spawn failure is reported on
   * the pane rather than unwinding the action: the pane exists, its shell did not
   * start, and that is a state the user can see and close.
   */
  dispatch(action: Action): ActionResult {
    const result = applyAction(this.state, action)
    if (result.effects.length > 0) this.runEffects(result.effects)
    if (result.changed) {
      this.schedulePersist()
      this.options.onChange?.(this.state.revision)
    }
    return result
  }

  private runEffects(effects: readonly Effect[]): void {
    for (const effect of effects) {
      if (effect.type === 'kill') {
        if (effect.sessionId !== null) this.sessions.remove(effect.sessionId)
        continue
      }
      const pane = this.state.panes.get(effect.paneId)
      if (pane) this.spawnFor(pane)
    }
  }

  /** Give a pane a PTY and bind it. Never throws: a pane with no shell is still a pane. */
  private spawnFor(pane: Pane): void {
    if (this.disposed) return
    try {
      const session = this.sessions.create({
        cols: INITIAL_PANE_COLS,
        rows: INITIAL_PANE_ROWS,
        cwd: pane.cwd,
        ...(pane.command === null
          ? this.options.shell === undefined || this.options.shell.length === 0
            ? {}
            : { command: this.options.shell }
          : { command: pane.command }),
        ...(pane.args.length === 0 ? {} : { args: pane.args }),
        env: { ...this.paneEnv(pane), ...pane.env },
        ...(this.options.scrollback === undefined ? {} : { scrollback: this.options.scrollback })
      })
      // Bound directly rather than through `dispatch`, because this runs *inside* an
      // action's effects and re-entering the reducer there would interleave revisions.
      pane.sessionId = session.id
      pane.exited = false
    } catch {
      pane.sessionId = null
      pane.exited = true
    }
  }

  /**
   * What every pane learns about the multiplexer it is running inside.
   *
   * Three variables, and the pane's own `env` overrides all of them — an explicitly
   * requested environment is the caller's, not ours to shadow.
   *
   * `LEAP_CHORUS_PANE_ID` is the address a hook reports to, and it is why a hook needs
   * no discovery: the agent's process tree inherits the id of the pane it is in.
   * `LEAP_CHORUS` is the flag a shell profile or an agent config can test without
   * having to know about either of the others.
   */
  private paneEnv(pane: Pane): Record<string, string> {
    return {
      LEAP_CHORUS: '1',
      LEAP_CHORUS_PANE_ID: pane.id,
      ...(this.options.socketPath === undefined ? {} : { LEAP_CHORUS_SOCKET_PATH: this.options.socketPath })
    }
  }

  /**
   * A runtime session ended: close its pane.
   *
   * A pane whose program exited is gone, the way a tmux pane is — and closing it here
   * rather than in a client is what makes it gone for *every* client, and what finally
   * disposes the session. A pane that never got a program (a spawn that failed) is the
   * other case and is left in place, marked exited, for the user to see and close.
   */
  noteSessionExit(sessionId: string): void {
    const pane = this.state.paneBySessionId(sessionId)
    if (!pane) return
    this.dispatch({ type: 'runtime.pane_exited', paneId: pane.id })
    this.dispatch({ type: 'pane.close', paneId: pane.id })
  }

  /** A program set its terminal title. */
  noteSessionTitle(sessionId: string, title: string): void {
    const pane = this.state.paneBySessionId(sessionId)
    if (!pane) return
    this.dispatch({ type: 'runtime.pane_title', paneId: pane.id, title })
  }

  paneForSession(sessionId: string): Pane | null {
    return this.state.paneBySessionId(sessionId)
  }

  // -------------------------------------------------------------------------
  // Agent detection
  // -------------------------------------------------------------------------

  /**
   * A report from an agent's own integration.
   *
   * Returns false when the report is dropped, which happens for two reasons. An
   * unknown pane is a hook that outlived the pane it was installed for. A `seq` at or
   * below the one already held is an out-of-order delivery — hook processes are
   * separate and short lived, so a slow `working` can land after the `idle` that
   * followed it, and applying it would leave the pane wrong until the next screen poll
   * disagreed.
   */
  noteAgentReport(report: {
    paneId: string
    agent: string
    state: HookReport['state'] | undefined
    seq: number
    agentSessionId?: string
  }): boolean {
    const pane = this.state.panes.get(report.paneId)
    if (!pane) return false
    const previous = this.hookReports.get(report.paneId)
    if (previous !== undefined && previous.agent === report.agent && report.seq <= previous.seq) return false

    // A report with no state is a session-identity report: it says which conversation
    // is in this pane without claiming anything about what it is doing.
    if (report.state !== undefined) {
      this.hookReports.set(report.paneId, {
        agent: report.agent,
        state: report.state,
        seq: report.seq,
        receivedAtMs: Date.now(),
        ...(report.agentSessionId === undefined ? {} : { agentSessionId: report.agentSessionId })
      })
    }

    this.dispatch({
      type: 'runtime.pane_agent',
      paneId: report.paneId,
      agent: report.agent,
      status: report.state ?? pane.agentStatus ?? 'unknown',
      ...(report.agentSessionId === undefined ? {} : { agentSessionId: report.agentSessionId })
    })
    return true
  }

  /**
   * The pane's shell pid and its recorded cwd, or null when it has no live session.
   *
   * Both, because the live lookup can fail — a process that just exited — and the
   * recorded directory is the right thing to fall back to.
   */
  paneCwdInput(paneId: string): { shellPid: number | null; recorded: string } | null {
    const pane = this.state.panes.get(paneId)
    if (!pane) return null
    const session = pane.sessionId === null ? null : this.sessions.get(pane.sessionId)
    return { shellPid: session?.pid ?? null, recorded: pane.cwd }
  }

  /** What the detector needs to know about one pane, or null if it has no session. */
  detectionInputFor(paneId: string): PaneDetectionInput | null {
    const pane = this.state.panes.get(paneId)
    if (!pane || pane.sessionId === null) return null
    const session = this.sessions.get(pane.sessionId)
    if (!session || session.pid === null) return null
    return {
      shellPid: session.pid,
      screen: session.detectionScreen(),
      oscTitle: session.oscTitle,
      oscProgress: session.oscProgress,
      hook: this.hookReports.get(paneId) ?? null,
      previousAgent: pane.agent,
      previousStatus: pane.agentStatus
    }
  }

  /**
   * Classify every pane, off one process-table capture.
   *
   * Public because the poll is a timer and a test should not have to wait for one.
   * Returns how many panes changed, which is also what makes it assertable.
   */
  async detectOnce(): Promise<number> {
    if (this.disposed) return 0
    const inputs = new Map<string, PaneDetectionInput>()
    for (const paneId of this.state.panes.keys()) {
      const input = this.detectionInputFor(paneId)
      if (input !== null) inputs.set(paneId, input)
    }
    if (inputs.size === 0) return 0

    const results = await this.detector.detectAll(inputs)
    if (this.disposed) return 0

    let changed = 0
    for (const [paneId, result] of results) {
      // `runtime.pane_agent` is a no-op when the verdict is unchanged, so the common
      // case — nothing happened this tick — costs no revision and no broadcast.
      const outcome = this.dispatch({ type: 'runtime.pane_agent', paneId, agent: result.agent, status: result.status })
      if (outcome.changed) changed += 1
    }
    return changed
  }

  private startDetectionPoll(): void {
    const interval = this.options.detectIntervalMs ?? DETECT_INTERVAL_MS
    if (interval <= 0) return
    const timer = setInterval(() => {
      // One poll at a time: a slow `ps` on a loaded host must not stack ticks.
      if (this.detecting) return
      this.detecting = true
      void this.detectOnce()
        .catch(() => {
          // A failed poll is the next poll's problem. Panes keep what they had.
        })
        .finally(() => {
          this.detecting = false
        })
    }, interval)
    // Never hold the event loop open just to poll for agent state.
    timer.unref()
    this.detectTimer = timer
  }

  // -------------------------------------------------------------------------
  // Wire projection
  // -------------------------------------------------------------------------

  snapshot(): SessionStateSnapshot {
    const workspaces: WorkspaceRecord[] = []
    const tabs: TabRecord[] = []
    const panes: PaneRecord[] = []

    for (const workspace of this.state.orderedWorkspaces()) {
      workspaces.push({
        workspaceId: workspace.id,
        number: workspace.number,
        label: workspace.label,
        cwd: workspace.cwd,
        tabIds: [...workspace.tabIds],
        activeTabId: workspace.activeTabId
      })
      for (const tab of this.state.tabsOf(workspace.id)) {
        tabs.push({
          tabId: tab.id,
          workspaceId: tab.workspaceId,
          number: tab.number,
          label: tab.label,
          layout: wireLayout(tab.layout),
          focusedPaneId: tab.focusedPaneId,
          zoomed: tab.zoomed
        })
        for (const paneId of paneIds(tab.layout)) {
          const pane = this.state.panes.get(paneId)
          if (!pane) continue
          panes.push({
            paneId: pane.id,
            sessionId: pane.sessionId,
            number: pane.number,
            label: pane.label,
            title: pane.title,
            cwd: pane.cwd,
            exited: pane.exited,
            rightClick: pane.rightClick,
            scrollOffset: pane.scrollOffset,
            agent: pane.agent,
            agentStatus: pane.agentStatus
          })
        }
      }
    }

    return {
      revision: this.state.revision,
      workspaces,
      workspaceOrder: [...this.state.workspaceOrder],
      tabs,
      panes,
      activeWorkspaceId: this.state.activeWorkspaceId,
      focusedPaneId: this.state.focusedPaneId
    }
  }

  /**
   * Write `[theme] name` into the user's config file.
   *
   * See `configSetTheme` for why this edits bytes rather than reserializing. The path
   * is the one the loader found; when it found none, the default location is created,
   * because "apply this theme" has to survive a restart to mean anything.
   */
  /**
   * Point later writes at a different config file.
   *
   * `--config` reaches the daemon as a `server.reload_config` *after* it has started,
   * so the path it was constructed with is the search default and not the file the
   * user actually asked for. Without this, applying a theme wrote to the wrong place —
   * or to nowhere — while the client read from the right one.
   */
  setConfigPath(path: string | null): void {
    this.configPathOverride = path
  }

  writeThemeName(theme: string): { path: string | null; theme: string; config: unknown } {
    const path = this.writeConfigValue('theme', 'name', `"${theme}"`)
    return { path, theme, config: null }
  }

  /** Write one `key = value` into one `[section]`. See `writeThemeName`'s note. */
  writeSetting(section: string, key: string, literal: string): string | null {
    return this.writeConfigValue(section, key, literal)
  }

  private writeConfigValue(section: string, key: string, literal: string): string | null {
    const path = this.configPathOverride ?? this.options.configPath ?? null
    if (path === null) return null

    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // No file yet: the first setting written creates one.
    }

    const line = `${key} = ${literal}`
    const keyPattern = new RegExp(`^\\s*${key}\\s*=`, 'mu')
    const headPattern = new RegExp(`^\\s*\\[${section}\\]`, 'mu')
    if (keyPattern.test(sectionText(text, section))) {
      text = replaceInSection(text, section, key, line)
    } else if (headPattern.test(text)) {
      text = text.replace(new RegExp(`^(\\s*\\[${section}\\][^\\n]*\\n)`, 'mu'), `$1${line}\n`)
    } else {
      text = `${text.length === 0 || text.endsWith('\n') ? text : `${text}\n`}\n[${section}]\n${line}\n`
    }

    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    } catch {
      return null
    }
    return path
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private schedulePersist(): void {
    if (this.options.sessionPath === undefined || this.disposed) return
    if (this.persistTimer !== null) return
    const delay = this.options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS
    if (delay <= 0) {
      this.persistNow()
      return
    }
    const timer = setTimeout(() => {
      this.persistTimer = null
      this.persistNow()
    }, delay)
    // Never hold the event loop open just to write a session file.
    timer.unref()
    this.persistTimer = timer
  }

  /** Write the session file immediately. Used on shutdown and by tests. */
  persistNow(): void {
    const path = this.options.sessionPath
    if (path === undefined) return
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const body = `${JSON.stringify(serializeState(this.state), null, 2)}\n`
      // Written to a sibling and renamed: a daemon killed mid-write must not leave a
      // half-document where the session file was.
      const temporary = `${path}.${process.pid}.tmp`
      writeFileSync(temporary, body, { mode: 0o600 })
      renameSync(temporary, path)
    } catch {
      // Losing the session file costs the next restore, not this session.
    }
  }

  dispose(): void {
    if (this.disposed) return
    if (this.detectTimer !== null) {
      clearInterval(this.detectTimer)
      this.detectTimer = null
    }
    this.hookReports.clear()
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persistNow()
    this.disposed = true
  }
}

function wireLayout(node: LayoutNode): WireLayoutNode {
  if (node.kind === 'pane') return { type: 'pane', paneId: node.id }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: wireLayout(node.first),
    second: wireLayout(node.second)
  }
}

function readDocument(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** The text of one `[section]`, or '' when there is none. */
function sectionText(text: string, section: string): string {
  const start = new RegExp(`^\\s*\\[${section}\\][^\\n]*\\n`, 'mu').exec(text)
  if (start === null) return ''
  const rest = text.slice(start.index + start[0].length)
  const next = /^\s*\[/mu.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/** Replace one `key =` line inside one section, leaving every other byte alone. */
function replaceInSection(text: string, section: string, key: string, line: string): string {
  const start = new RegExp(`^\\s*\\[${section}\\][^\\n]*\\n`, 'mu').exec(text)
  if (start === null) return text
  const head = text.slice(0, start.index + start[0].length)
  const body = text.slice(head.length)
  const next = /^\s*\[/mu.exec(body)
  const inner = next === null ? body : body.slice(0, next.index)
  const tail = next === null ? '' : body.slice(next.index)
  return head + inner.replace(new RegExp(`^\\s*${key}\\s*=[^\\n]*$`, 'mu'), line) + tail
}
