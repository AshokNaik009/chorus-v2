/**
 * Wire messages: requests, responses, events, and the snapshot they carry.
 *
 * Framing is newline-delimited JSON (see codec.ts). Every message is one of three
 * shapes, discriminated on `type`.
 */

import type {
  AgentExplainParams,
  AgentExplainResult,
  AgentReadParams,
  AgentReadResult,
  AgentReloadManifestsParams,
  AgentReloadManifestsResult,
  AgentReportParams,
  AgentReportResult,
  ConfigGetResult,
  ConfigSetParams,
  ConfigSetResult,
  ConfigSetThemeParams,
  ConfigSetThemeResult,
  IntegrationInstallParams,
  IntegrationInstallResult,
  IntegrationListResult,
  LayoutSetSplitRatioParams,
  MutationResult,
  PaneCopyMotionParams,
  PaneCopyMotionResult,
  PaneCopySearchParams,
  PaneCopySearchResult,
  PaneEditScrollbackResult,
  PaneFocusDirectionParams,
  PaneInputSetParams,
  PaneLinkActivateParams,
  PaneLinkActivateResult,
  PaneRenameParams,
  PaneResizeParams,
  PaneScrollParams,
  PaneSelectionReadParams,
  PaneSelectionReadResult,
  PaneSplitParams,
  PaneSwapParams,
  PaneTargetParams,
  PaneZoomParams,
  PluginActionInvokeParams,
  PluginActionInvokeResult,
  PluginListParams,
  PluginListResult,
  PluginPaneOpenParams,
  PluginPaneOpenResult,
  ServerReloadConfigParams,
  ServerReloadConfigResult,
  StateGetResult,
  TabCreateParams,
  TabMoveParams,
  TabRenameParams,
  TabTargetParams,
  WorkspaceCreateParams,
  WorkspaceMoveBlockParams,
  WorkspaceMoveParams,
  WorkspaceRenameParams,
  WorkspaceTargetParams,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListParams,
  FsListParams,
  FsListResult,
  SearchContentParams,
  SearchContentResult,
  SearchFilesParams,
  PreviewReadParams,
  PreviewResult,
  SearchFilesResult,
  GitBranchesResult,
  GitCheckoutParams,
  GitCommitParams,
  GitDrawerActionParams,
  GitDrawerActionResult,
  GitDrawerParams,
  GitDrawerResult,
  GitPathsParams,
  GitStatusParams,
  GitStatusResult,
  GitSummaryParams,
  GitSummaryResult,
  GitSuggestParams,
  GitSuggestResult,
  GitSyncResult,
  WorktreeListResult,
  WorktreeOpenParams,
  WorktreeOpenResult,
  WorktreeRemoveParams,
  WorktreeRemoveResult
} from './session-model.js'

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * A color, packed into one number so a snapshot stays cheap to encode.
 *
 *   -1                        default (the renderer's own foreground/background)
 *   0 .. 255                  palette index
 *   0x1000000 | (rgb & 0xffffff)  24-bit truecolor
 *
 * Palette indices and the truecolor tag cannot collide: palette never exceeds 255.
 */
export type SnapshotColor = number

export const COLOR_DEFAULT: SnapshotColor = -1
export const COLOR_RGB_FLAG = 0x1000000

export function rgbColor(rgb: number): SnapshotColor {
  return COLOR_RGB_FLAG | (rgb & 0xffffff)
}

export function isRgbColor(color: SnapshotColor): boolean {
  return color >= COLOR_RGB_FLAG
}

/** Cell attribute bitflags. */
export const ATTR_BOLD = 1 << 0
export const ATTR_DIM = 1 << 1
export const ATTR_ITALIC = 1 << 2
export const ATTR_UNDERLINE = 1 << 3
export const ATTR_BLINK = 1 << 4
export const ATTR_INVERSE = 1 << 5
export const ATTR_INVISIBLE = 1 << 6
export const ATTR_STRIKETHROUGH = 1 << 7

/**
 * A horizontal run of cells sharing one style.
 *
 * `text` holds the characters; `width` is how many *columns* they occupy. The two
 * differ when the run contains double-width characters (one char, two columns) or
 * combining marks (several code units, one column), so a renderer must advance by
 * `width`, never by `text.length`.
 */
export interface SnapshotRun {
  readonly text: string
  readonly width: number
  readonly fg: SnapshotColor
  readonly bg: SnapshotColor
  readonly attrs: number
}

/** One screen row, run-length encoded by style. */
export interface SnapshotRow {
  readonly runs: readonly SnapshotRun[]
}

export interface SnapshotCursor {
  readonly x: number
  readonly y: number
  readonly visible: boolean
}

/**
 * What a pane expects its keyboard input to look like.
 *
 * This is runtime state of the pane, not presentation: it is discovered by watching what
 * the program wrote to its terminal, so it is owned by the daemon and travels on the
 * snapshot. The client encodes keys against it and keeps no copy of its own — which is
 * also why it survives a client detaching and reattaching.
 *
 * `@xterm/headless` 6.0.0 exposes ten modes on `IModes` and neither the kitty keyboard
 * protocol nor modifyOtherKeys is among them, so the daemon observes both through the
 * emulator's CSI handlers. The type lives here, in the wire vocabulary, because that is
 * where a shared runtime fact belongs.
 */
export interface SnapshotKeyboard {
  /** Kitty protocol flags in force, or 0 when the stack is empty. */
  readonly kittyFlags: number
  /** xterm `CSI > 4 ; n m`. 0 is off. */
  readonly modifyOtherKeys: 0 | 1 | 2
  /** DECCKM: arrows are `SS3 A` rather than `CSI A`. */
  readonly applicationCursorKeys: boolean
  /** DECKPAM: the keypad sends `SS3 x` rather than digits. */
  readonly applicationKeypad: boolean
  /** DEC 2004: the pane wants pastes wrapped in `CSI 200 ~` / `CSI 201 ~`. */
  readonly bracketedPaste: boolean
  /** Which mouse reports the pane asked for, if any. */
  readonly mouseTracking: SnapshotMouseTracking
}

/** xterm mouse modes 1000/1002/1003, as the emulator reports them. */
export type SnapshotMouseTracking = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

export const DEFAULT_SNAPSHOT_KEYBOARD: SnapshotKeyboard = {
  kittyFlags: 0,
  modifyOtherKeys: 0,
  applicationCursorKeys: false,
  applicationKeypad: false,
  bracketedPaste: false,
  mouseTracking: 'none'
}

/** Which buffer a snapshot was taken from. */
export type SnapshotBufferKind = 'normal' | 'alternate'

/**
 * A full screen snapshot. `rows` always has exactly `rows.length === dimensions.rows`
 * entries, describing the visible screen only — scrollback is reported as a count and
 * is not transferred in phase 1.
 */
export interface TerminalSnapshot {
  readonly cols: number
  readonly rows: number
  /** Which buffer this snapshot came from. */
  readonly buffer: SnapshotBufferKind
  readonly cursor: SnapshotCursor
  readonly lines: readonly SnapshotRow[]
  /** Lines held above the screen in the normal buffer. */
  readonly scrollbackLines: number
  /**
   * How far back this capture is scrolled, in lines. 0 is live output.
   *
   * Absent means 0, so a phase-3 client still reads a phase-4 snapshot. It is on the
   * snapshot rather than only in the request because `pane.scroll` is session state:
   * two clients looking at one pane are looking at the same place in its history.
   */
  readonly scrollOffset?: number
  /**
   * The pane's input expectations.
   *
   * Optional on the wire so an older client that never reads it still parses a newer
   * daemon's snapshot; absent means `DEFAULT_SNAPSHOT_KEYBOARD`.
   */
  readonly keyboard?: SnapshotKeyboard
  readonly title: string | null
  /** Monotonic per-session output counter at the time of capture. */
  readonly sequence: number
}

// ---------------------------------------------------------------------------
// Session facts
// ---------------------------------------------------------------------------

export interface SessionExit {
  readonly exitCode: number
  readonly signal: number | null
}

export interface SessionInfo {
  readonly id: string
  /** PID of the process on the far side of the PTY. Null once it has exited. */
  readonly pid: number | null
  readonly cols: number
  readonly rows: number
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly createdAt: number
  readonly alive: boolean
  readonly exit: SessionExit | null
  /** Total bytes read from the PTY since creation. */
  readonly bytesRead: number
  /** Bytes dropped by the output backpressure policy, if any. Always 0 today; see sessions.ts. */
  readonly bytesDropped: number
}

export interface DaemonInfo {
  readonly protocolVersion: number
  readonly pid: number
  readonly dataRoot: string
  readonly socketPath: string
  readonly startedAt: number
  readonly nodeVersion: string
  readonly sessionCount: number
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

export interface HelloParams {
  readonly protocolVersion: number
  readonly clientName: string
}

export interface HelloResult {
  readonly daemon: DaemonInfo
}

export interface SessionCreateParams {
  readonly cols: number
  readonly rows: number
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** Explicit id, so a caller can make creation idempotent across client restarts. */
  readonly id?: string
}

export interface SessionIdParams {
  readonly id: string
}

/**
 * How `SessionWriteParams.data` is encoded.
 *
 * `utf8` is the string itself, encoded UTF-8 on the way to the PTY. `base64` carries
 * arbitrary bytes. Both exist because terminal input is *bytes*, not text: a legacy X10
 * mouse report (`CSI M Cb Cx Cy`) puts `32 + column` in one byte, so any column past 95
 * is a byte no valid UTF-8 string can hold, and a paste of Latin-1 text is not UTF-8
 * either. Sending those through a JSON string turns them into U+FFFD.
 *
 * The client picks per write: ASCII stays `utf8`, so an ordinary keystroke is still one
 * byte on the wire, and anything else goes `base64`. See `encodeWritePayload`.
 */
export type WriteEncoding = 'utf8' | 'base64'

export interface SessionWriteParams {
  readonly id: string
  /** The bytes to deliver to the PTY, encoded per `encoding`. */
  readonly data: string
  /** Defaults to `utf8` when absent, which is what a phase-2 caller sent. */
  readonly encoding?: WriteEncoding
}

export interface SessionResizeParams {
  readonly id: string
  readonly cols: number
  readonly rows: number
}

export interface SessionKillParams {
  readonly id: string
  readonly signal?: string
}

export interface SessionSnapshotParams {
  readonly id: string
  /**
   * Which buffer to capture. `active` follows the program (alternate while a
   * full-screen app is up); `normal` always reads the scrollback buffer, which is
   * how a caller inspects what an alternate-screen app is covering.
   */
  readonly buffer?: 'active' | 'normal'
}

export interface SessionSnapshotResult {
  readonly id: string
  readonly snapshot: TerminalSnapshot
}

export interface SessionListResult {
  readonly sessions: readonly SessionInfo[]
}

export interface SessionInfoResult {
  readonly session: SessionInfo
}

export interface OkResult {
  readonly ok: true
}

// ---------------------------------------------------------------------------
// The session model
// ---------------------------------------------------------------------------

/**
 * Phase 4's method set.
 *
 * The 27 workspace/tab/pane/layout methods of herdr's client-shell endpoint, plus
 * `server.reload_config`, plus the two reads a client needs to follow the model
 * (`state.get`, `config.get`) and the session teardown call phase 1 never had
 * (`session.destroy`). Names match herdr's endpoint so the feature target stays legible
 * against `tests/fixtures/endpoint-method-shapes-v1.json`; the shapes do not, because
 * this is JSON-RPC and has no deployed client to stay compatible with.
 */
export interface SessionModelMethodMap {
  'state.get': { params: Record<string, never>; result: StateGetResult }
  'config.get': { params: Record<string, never>; result: ConfigGetResult }

  'workspace.create': { params: WorkspaceCreateParams; result: MutationResult }
  'workspace.close': { params: WorkspaceTargetParams; result: MutationResult }
  'workspace.focus': { params: WorkspaceTargetParams; result: MutationResult }
  'workspace.rename': { params: WorkspaceRenameParams; result: MutationResult }
  'workspace.move': { params: WorkspaceMoveParams; result: MutationResult }
  'workspace.move_block': { params: WorkspaceMoveBlockParams; result: MutationResult }

  'tab.create': { params: TabCreateParams; result: MutationResult }
  'tab.close': { params: TabTargetParams; result: MutationResult }
  'tab.focus': { params: TabTargetParams; result: MutationResult }
  'tab.rename': { params: TabRenameParams; result: MutationResult }
  'tab.move': { params: TabMoveParams; result: MutationResult }

  'pane.split': { params: PaneSplitParams; result: MutationResult }
  'pane.close': { params: PaneTargetParams; result: MutationResult }
  'pane.focus': { params: PaneTargetParams; result: MutationResult }
  'pane.focus_direction': { params: PaneFocusDirectionParams; result: MutationResult }
  'pane.resize': { params: PaneResizeParams; result: MutationResult }
  'pane.swap': { params: PaneSwapParams; result: MutationResult }
  'pane.zoom': { params: PaneZoomParams; result: MutationResult }
  'pane.rename': { params: PaneRenameParams; result: MutationResult }

  'pane.scroll': { params: PaneScrollParams; result: MutationResult }
  'pane.input.set': { params: PaneInputSetParams; result: MutationResult }
  'pane.link.activate': { params: PaneLinkActivateParams; result: PaneLinkActivateResult }
  'pane.edit_scrollback': { params: PaneTargetParams; result: PaneEditScrollbackResult }

  'pane.copy_motion': { params: PaneCopyMotionParams; result: PaneCopyMotionResult }
  'pane.copy_search': { params: PaneCopySearchParams; result: PaneCopySearchResult }
  'pane.selection.read': { params: PaneSelectionReadParams; result: PaneSelectionReadResult }

  'layout.set_split_ratio': { params: LayoutSetSplitRatioParams; result: MutationResult }

  'server.reload_config': { params: ServerReloadConfigParams; result: ServerReloadConfigResult }
}

/**
 * PHASE-5's methods: agents, worktrees, integrations.
 *
 * Separate from the phase-4 map so `SESSION_MODEL_METHODS` keeps meaning "the 28 herdr
 * endpoint methods phase 4 committed to", and a phase-5 addition cannot quietly change
 * what that list asserts.
 *
 * All named for what the *server* owns, not for what a UI shows: `agent.report`, not
 * `sidebar.badge`. A worktree and an installed hook are facts about the machine, so
 * both belong on the API path and neither is reachable only through a private client
 * socket.
 */
export interface AgentMethodMap {
  'agent.report': { params: AgentReportParams; result: AgentReportResult }
  'agent.explain': { params: AgentExplainParams; result: AgentExplainResult }
  'agent.read': { params: AgentReadParams; result: AgentReadResult }
  'agent.reload_manifests': { params: AgentReloadManifestsParams; result: AgentReloadManifestsResult }

  'config.set_theme': { params: ConfigSetThemeParams; result: ConfigSetThemeResult }
  'config.set': { params: ConfigSetParams; result: ConfigSetResult }

  'fs.list': { params: FsListParams; result: FsListResult }

  'search.files': { params: SearchFilesParams; result: SearchFilesResult }
  'search.content': { params: SearchContentParams; result: SearchContentResult }

  'preview.read': { params: PreviewReadParams; result: PreviewResult }

  'git.status': { params: GitStatusParams; result: GitStatusResult }
  'git.stage': { params: GitPathsParams; result: GitStatusResult }
  'git.unstage': { params: GitPathsParams; result: GitStatusResult }
  'git.discard': { params: GitPathsParams; result: GitStatusResult }
  'git.commit': { params: GitCommitParams; result: GitStatusResult }
  'git.branches': { params: GitStatusParams; result: GitBranchesResult }
  'git.checkout': { params: GitCheckoutParams; result: GitStatusResult }
  'git.sync': { params: GitStatusParams; result: GitSyncResult }
  'git.suggest': { params: GitSuggestParams; result: GitSuggestResult }
  /** One drawer's rows, fetched when it is opened. See PHASE-11. */
  /** One header line per directory, for the workspace list. */
  'git.summary': { params: GitSummaryParams; result: GitSummaryResult }
  'git.drawer': { params: GitDrawerParams; result: GitDrawerResult }
  'git.drawerAction': { params: GitDrawerActionParams; result: GitDrawerActionResult }

  'worktree.list': { params: WorktreeListParams; result: WorktreeListResult }
  'worktree.create': { params: WorktreeCreateParams; result: WorktreeCreateResult }
  'worktree.open': { params: WorktreeOpenParams; result: WorktreeOpenResult }
  'worktree.remove': { params: WorktreeRemoveParams; result: WorktreeRemoveResult }

  'integration.list': { params: Record<string, never>; result: IntegrationListResult }
  'integration.install': { params: IntegrationInstallParams; result: IntegrationInstallResult }

  'plugin.list': { params: PluginListParams; result: PluginListResult }
  'plugin.pane.open': { params: PluginPaneOpenParams; result: PluginPaneOpenResult }
  'plugin.action.invoke': { params: PluginActionInvokeParams; result: PluginActionInvokeResult }
}

/** The PHASE-5 methods, as a value, so a test can assert none is missing. */
export const AGENT_METHODS = [
  'agent.report',
  'agent.explain',
  'agent.read',
  'agent.reload_manifests',
  'config.set_theme',
  'config.set',
  'fs.list',
  'search.files',
  'search.content',
  'preview.read',
  'git.status',
  'git.stage',
  'git.unstage',
  'git.discard',
  'git.commit',
  'git.branches',
  'git.checkout',
  'git.sync',
  'git.suggest',
  'git.summary',
  'git.drawer',
  'git.drawerAction',
  'worktree.list',
  'worktree.create',
  'worktree.open',
  'worktree.remove',
  'integration.list',
  'integration.install',
  'plugin.list',
  'plugin.pane.open',
  'plugin.action.invoke'
] as const satisfies readonly (keyof AgentMethodMap)[]

/** The 28 PHASE-4 methods, as a value, so a test can assert none is missing. */
export const SESSION_MODEL_METHODS = [
  'workspace.create',
  'workspace.close',
  'workspace.focus',
  'workspace.rename',
  'workspace.move',
  'workspace.move_block',
  'tab.create',
  'tab.close',
  'tab.focus',
  'tab.rename',
  'tab.move',
  'pane.split',
  'pane.close',
  'pane.focus',
  'pane.focus_direction',
  'pane.resize',
  'pane.swap',
  'pane.zoom',
  'pane.rename',
  'pane.scroll',
  'pane.input.set',
  'pane.link.activate',
  'pane.edit_scrollback',
  'pane.copy_motion',
  'pane.copy_search',
  'pane.selection.read',
  'layout.set_split_ratio',
  'server.reload_config'
] as const satisfies readonly (keyof SessionModelMethodMap)[]

/** Every method, with its params and result type. */
export interface MethodMap extends SessionModelMethodMap, AgentMethodMap {
  hello: { params: HelloParams; result: HelloResult }
  'daemon.info': { params: Record<string, never>; result: DaemonInfo }
  'daemon.shutdown': { params: Record<string, never>; result: OkResult }
  'session.create': { params: SessionCreateParams; result: SessionInfoResult }
  'session.list': { params: Record<string, never>; result: SessionListResult }
  'session.get': { params: SessionIdParams; result: SessionInfoResult }
  'session.write': { params: SessionWriteParams; result: OkResult }
  'session.resize': { params: SessionResizeParams; result: OkResult }
  'session.kill': { params: SessionKillParams; result: OkResult }
  'session.snapshot': { params: SessionSnapshotParams; result: SessionSnapshotResult }
  'session.subscribe': { params: SessionIdParams; result: OkResult }
  'session.unsubscribe': { params: SessionIdParams; result: OkResult }
  /**
   * Forget a session entirely.
   *
   * Phase 1 had no way to do this, so an exited session stayed in `session.list`
   * forever with its emulator and 5,000 lines of scrollback. Closing a pane now
   * destroys its session; nothing else does.
   */
  'session.destroy': { params: SessionIdParams; result: OkResult }
}

export type MethodName = keyof MethodMap
export type MethodParams<M extends MethodName> = MethodMap[M]['params']
export type MethodResult<M extends MethodName> = MethodMap[M]['result']

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

export interface RequestMessage<M extends MethodName = MethodName> {
  readonly type: 'req'
  readonly id: number
  readonly method: M
  readonly params: MethodParams<M>
}

export interface ErrorBody {
  readonly code: string
  readonly message: string
}

export type ResponseMessage<M extends MethodName = MethodName> =
  | { readonly type: 'res'; readonly id: number; readonly ok: true; readonly result: MethodResult<M> }
  | { readonly type: 'res'; readonly id: number; readonly ok: false; readonly error: ErrorBody }

export type EventMessage =
  /** The session produced output; `sequence` identifies how much. Pull a snapshot to see it. */
  | { readonly type: 'event'; readonly event: 'session.output'; readonly id: string; readonly sequence: number }
  | { readonly type: 'event'; readonly event: 'session.exit'; readonly id: string; readonly exit: SessionExit }
  | { readonly type: 'event'; readonly event: 'session.title'; readonly id: string; readonly title: string }
  | { readonly type: 'event'; readonly event: 'daemon.shutdown'; readonly reason: string }
  /**
   * The session model changed. Carries the revision, not the model: a client pulls
   * `state.get` when it cares, exactly as it pulls a snapshot after `session.output`.
   */
  | { readonly type: 'event'; readonly event: 'state.changed'; readonly revision: number }
  /** The config was reloaded, by `server.reload_config` or by another client. */
  | { readonly type: 'event'; readonly event: 'config.changed'; readonly path: string | null }

export type ClientMessage = RequestMessage
export type ServerMessage = ResponseMessage | EventMessage
export type AnyMessage = ClientMessage | ServerMessage

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ErrorCodes = {
  /** The request body did not parse as a known method/params shape. */
  badRequest: 'leap_chorus_bad_request',
  unknownMethod: 'leap_chorus_unknown_method',
  /** A request arrived before a successful `hello`. */
  notHandshaken: 'leap_chorus_not_handshaken',
  protocolMismatch: 'leap_chorus_protocol_mismatch',
  sessionNotFound: 'leap_chorus_session_not_found',
  sessionExited: 'leap_chorus_session_exited',
  /** A pane-content method named a pane the model does not have. */
  paneNotFound: 'leap_chorus_pane_not_found',
  /**
   * The action was understood but the model refused it.
   *
   * One code rather than one per subject, because the reason is in the message and a
   * client can do nothing different for a missing tab than for a missing workspace.
   */
  actionRejected: 'leap_chorus_action_rejected',
  spawnFailed: 'leap_chorus_spawn_failed',
  /** A worktree method was pointed at a path that is not inside a git repository. */
  notARepository: 'leap_chorus_not_a_repository',
  /** `git` refused. The message carries git's own stderr, which is the useful part. */
  gitFailed: 'leap_chorus_git_failed',
  /**
   * A search could not run at all: no ripgrep, or ripgrep would not start.
   *
   * Separate from `badRequest` because the message is advice rather than a complaint —
   * it names the install command for this platform, and the panel prints it verbatim.
   */
  searchUnavailable: 'leap_chorus_search_unavailable',
  /** An integration could not be written: no settings file, no permission, no agent. */
  integrationFailed: 'leap_chorus_integration_failed',
  internal: 'leap_chorus_internal_error'
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

// ---------------------------------------------------------------------------
// Write payload encoding
// ---------------------------------------------------------------------------

/**
 * Pack bytes for `session.write`, preferring the cheap encoding.
 *
 * Every byte below 0x80 is its own UTF-8 encoding and survives a JSON string intact, so
 * an all-ASCII chunk — which is every ordinary keystroke and every CSI sequence a
 * terminal sends — rides as a plain string with no expansion. Anything with a high byte
 * goes base64, at a third more bytes, because the alternative is losing it.
 */
export function encodeWritePayload(bytes: Uint8Array): { data: string; encoding?: WriteEncoding } {
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] as number
    if (byte >= 0x80) {
      return { data: Buffer.from(bytes).toString('base64'), encoding: 'base64' }
    }
  }
  // Latin-1 and UTF-8 agree below 0x80, and latin1 skips UTF-8 validation.
  return { data: Buffer.from(bytes).toString('latin1') }
}

/** Unpack what `encodeWritePayload` produced. An absent encoding means `utf8`. */
export function decodeWritePayload(data: string, encoding: WriteEncoding | undefined): Buffer {
  return Buffer.from(data, encoding === 'base64' ? 'base64' : 'utf8')
}

// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isRequestMessage(value: unknown): value is RequestMessage {
  return (
    isRecord(value) &&
    value['type'] === 'req' &&
    typeof value['id'] === 'number' &&
    typeof value['method'] === 'string' &&
    isRecord(value['params'])
  )
}

export function isResponseMessage(value: unknown): value is ResponseMessage {
  return isRecord(value) && value['type'] === 'res' && typeof value['id'] === 'number'
}

export function isEventMessage(value: unknown): value is EventMessage {
  return isRecord(value) && value['type'] === 'event' && typeof value['event'] === 'string'
}
