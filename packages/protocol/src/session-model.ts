/**
 * The workspace/tab/pane vocabulary on the wire.
 *
 * ## Why these are server-owned
 *
 * Workspaces, tabs and panes are *session organization*: two clients attached to the
 * same daemon must agree on how many panes there are and which one has focus, the same
 * way they agree on what a pane has printed. So the model lives in the daemon, is
 * mutated through these methods, and reaches every client as a snapshot plus a change
 * event.
 *
 * Presentation does not appear here, and that boundary is the point. Screen size,
 * sidebar width, which rows a pane is drawn on, hover, selection rectangles and mouse
 * drags are client-local and never cross this wire. Geometry appears only where the
 * *answer* depends on it — `pane.focus_direction` needs to know what "left" means — and
 * then it is an input the client supplies, not state the daemon keeps.
 *
 * Method names follow herdr's client-shell endpoint (`src/server/client_commands.rs`),
 * so the feature target is legible against
 * `tests/fixtures/endpoint-method-shapes-v1.json`. The wire format is not herdr's: we
 * speak JSON-RPC, not bincode, and are compatible with no deployed client.
 */

/** A new pane goes to the right of, or below, the pane it was split from. */
export type WireSplitDirection = 'right' | 'down'

/** A cardinal move. */
export type WirePaneDirection = 'left' | 'right' | 'up' | 'down'

export type WireZoomMode = 'toggle' | 'on' | 'off'

/** Where a right click inside a pane is delivered. */
export type WireRightClickTarget = 'app' | 'pane'

export type WireLayoutNode =
  | { readonly type: 'pane'; readonly paneId: string }
  | {
      readonly type: 'split'
      readonly direction: 'horizontal' | 'vertical'
      readonly ratio: number
      readonly first: WireLayoutNode
      readonly second: WireLayoutNode
    }

/**
 * What an agent in a pane is doing.
 *
 * On the wire as a string union with an explicit `unknown`, so a client that meets a
 * value it does not know can fall back rather than reject the snapshot — the same
 * reason herdr's endpoint contract asks for an `Unknown` variant on every enum an
 * older client might read.
 */
export type WireAgentStatus = 'idle' | 'working' | 'blocked' | 'unknown' | 'done'

export interface PaneRecord {
  readonly paneId: string
  /** The terminal session behind this pane, or null when it has none yet. */
  readonly sessionId: string | null
  readonly number: number
  /** A user rename, from `pane.rename`. */
  readonly label: string | null
  /** The program's own OSC title. */
  readonly title: string | null
  readonly cwd: string
  readonly exited: boolean
  readonly rightClick: WireRightClickTarget
  readonly scrollOffset: number
  /**
   * The agent running in this pane, and what it is doing.
   *
   * Optional on the wire, and absent together: a pane running a shell has neither.
   * They are here rather than in a client-side table because they are a shared runtime
   * fact — two clients attached to one daemon must agree about them, and a client that
   * reattaches must learn them in one round trip.
   */
  readonly agent?: string | null
  readonly agentStatus?: WireAgentStatus | null
}

export interface TabRecord {
  readonly tabId: string
  readonly workspaceId: string
  readonly number: number
  readonly label: string | null
  readonly layout: WireLayoutNode
  readonly focusedPaneId: string
  readonly zoomed: boolean
}

export interface WorkspaceRecord {
  readonly workspaceId: string
  readonly number: number
  readonly label: string | null
  readonly cwd: string
  readonly tabIds: readonly string[]
  readonly activeTabId: string
}

/**
 * The whole session model in one message.
 *
 * Sent whole rather than as a patch stream because it is small — tens of records, not
 * thousands of cells — and because a client that reconnects has to be able to catch up
 * in one round trip. `revision` increments on every accepted mutation, so a client can
 * drop a snapshot it has already seen without comparing trees.
 */
export interface SessionStateSnapshot {
  readonly revision: number
  readonly workspaces: readonly WorkspaceRecord[]
  /** Display order, which `workspace.move` and `workspace.move_block` change. */
  readonly workspaceOrder: readonly string[]
  readonly tabs: readonly TabRecord[]
  readonly panes: readonly PaneRecord[]
  readonly activeWorkspaceId: string | null
  readonly focusedPaneId: string | null
}

/** Reference geometry for the three methods whose answer depends on rectangles. */
export interface WireViewport {
  readonly cols: number
  readonly rows: number
}

export interface WireTextPoint {
  readonly row: number
  readonly col: number
}

export interface WireTextRange {
  readonly start: WireTextPoint
  readonly end: WireTextPoint
}

export type WireCopyMotion =
  | 'line_end'
  | 'first_non_blank'
  | 'next_word_start'
  | 'previous_word_start'
  | 'next_word_end'
  | 'next_big_word_start'
  | 'previous_big_word_start'
  | 'next_big_word_end'
  | 'previous_paragraph'
  | 'next_paragraph'

export type WireSearchDirection = 'forward' | 'backward'

// ---------------------------------------------------------------------------
// Params and results
// ---------------------------------------------------------------------------

export interface StateGetResult {
  readonly state: SessionStateSnapshot
}

/**
 * The common answer to a mutation: what changed, and what it created.
 *
 * Every mutating method returns this, so a client has one shape to handle and always
 * learns the new revision — which is how it knows whether the `state.changed` event it
 * is about to receive is its own doing.
 */
export interface MutationResult {
  readonly revision: number
  readonly changed: boolean
  readonly workspaceId?: string
  readonly tabId?: string
  readonly paneId?: string
}

export interface WorkspaceCreateParams {
  readonly cwd?: string
  readonly label?: string
  readonly focus?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly sourceWorkspaceId?: string
  /**
   * What the workspace's first pane runs. Absent means the configured shell.
   *
   * herdr's own `workspace.create` has no such field because herdr's server is the
   * process the user launched, so it already knows the argv. Here the daemon outlives
   * every client, and the client that creates the first workspace is the one holding
   * `leap-chorus -- vim`.
   */
  readonly command?: string
  readonly args?: readonly string[]
}
export interface WorkspaceTargetParams {
  readonly workspaceId: string
}
export interface WorkspaceRenameParams {
  readonly workspaceId: string
  readonly label: string
}
export interface WorkspaceMoveParams {
  readonly workspaceId: string
  readonly insertIndex: number
}
export interface WorkspaceMoveBlockParams {
  readonly workspaceIds: readonly string[]
  readonly beforeWorkspaceId?: string
}

export interface TabCreateParams {
  readonly workspaceId?: string
  readonly cwd?: string
  readonly label?: string
  readonly focus?: boolean
  readonly env?: Readonly<Record<string, string>>
}
export interface TabTargetParams {
  readonly tabId: string
}
export interface TabRenameParams {
  readonly tabId: string
  readonly label: string
}
export interface TabMoveParams {
  readonly tabId: string
  readonly insertIndex: number
}

export interface PaneSplitParams {
  readonly targetPaneId?: string
  readonly direction: WireSplitDirection
  readonly ratio?: number
  readonly cwd?: string
  readonly focus?: boolean
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
}
export interface PaneTargetParams {
  readonly paneId: string
}
export interface PaneFocusDirectionParams {
  readonly paneId?: string
  readonly direction: WirePaneDirection
  readonly viewport?: WireViewport
}
export interface PaneResizeParams {
  readonly paneId?: string
  readonly direction: WirePaneDirection
  readonly amount?: number
  readonly viewport?: WireViewport
}
export interface PaneSwapParams {
  readonly paneId?: string
  readonly direction?: WirePaneDirection
  readonly sourcePaneId?: string
  readonly targetPaneId?: string
  readonly viewport?: WireViewport
}
export interface PaneZoomParams {
  readonly paneId?: string
  readonly mode?: WireZoomMode
}
export interface PaneRenameParams {
  readonly paneId: string
  readonly label?: string | null
}
export interface PaneScrollParams {
  readonly paneId: string
  readonly offsetFromBottom: number
}
export interface PaneInputSetParams {
  readonly paneId: string
  readonly rightClick: WireRightClickTarget
}
export interface PaneLinkActivateParams {
  readonly paneId: string
  /** Row within the visible screen, not within the scrollback. */
  readonly viewportRow: number
  readonly col: number
}
export interface PaneLinkActivateResult {
  readonly url: string | null
  readonly range: WireTextRange | null
}
export interface PaneEditScrollbackResult {
  /** Where the scrollback was written, for an editor to open. */
  readonly path: string
  readonly lines: number
}
export interface PaneSelectionReadParams {
  readonly paneId: string
  readonly anchor: WireTextPoint
  readonly cursor: WireTextPoint
}
export interface PaneSelectionReadResult {
  readonly text: string
}
export interface PaneCopyMotionParams {
  readonly paneId: string
  readonly cursor: WireTextPoint
  readonly motion: WireCopyMotion
}
export interface PaneCopyMotionResult {
  readonly cursor: WireTextPoint
}
export interface PaneCopySearchParams {
  readonly paneId: string
  readonly query: string
  readonly direction: WireSearchDirection
  readonly cursor: WireTextPoint
  readonly previous?: WireTextRange
}
export interface PaneCopySearchResult {
  readonly match: WireTextRange | null
}
export interface LayoutSetSplitRatioParams {
  readonly tabId?: string
  readonly paneId?: string
  /** Path from the root: false takes the first child, true the second. */
  readonly path: readonly boolean[]
  readonly ratio: number
}

export interface ServerReloadConfigParams {
  /** Read this file instead of searching. Used by tests and by `--config`. */
  readonly path?: string
}

export interface ConfigProblemWire {
  readonly kind: string
  readonly path: string
  readonly message: string
}

export interface ServerReloadConfigResult {
  /** The file that was read, or null when none was found and defaults are in force. */
  readonly path: string | null
  readonly problems: readonly ConfigProblemWire[]
  readonly errors: readonly string[]
  /** The config itself, so a client does not need filesystem access to honour it. */
  readonly config: unknown
  /** Panes still running after the reload. Criterion 5's "without dropping panes". */
  readonly paneCount: number
}

export interface ConfigGetResult {
  readonly path: string | null
  readonly config: unknown
  readonly problems: readonly ConfigProblemWire[]
  readonly errors: readonly string[]
}

// ---------------------------------------------------------------------------
// Agents (PHASE-5 Part A)
// ---------------------------------------------------------------------------

/**
 * A state report from an agent's own integration.
 *
 * Sent by the hook script the integration installer writes, over the same endpoint a
 * client uses, addressed by `paneId` from `$LEAP_CHORUS_PANE_ID`. It is a shared
 * runtime fact and so it is a server method, not a client-socket side channel.
 *
 * `seq` is the agent's own monotonic counter. Hook processes are separate and short
 * lived, so two can land out of order; the daemon drops a report older than the one it
 * has rather than letting a late `working` overwrite a current `idle`.
 */
export interface AgentReportParams {
  readonly paneId: string
  /** Which integration is speaking, e.g. `leap-chorus:claude`. */
  readonly source: string
  readonly agent: string
  readonly state?: WireAgentStatus
  readonly seq: number
  /** The agent's own session id, when its hook knows one. */
  readonly agentSessionId?: string
}

export interface AgentReportResult {
  /** False when the report was dropped as stale or for an unknown pane. */
  readonly accepted: boolean
  readonly revision: number
}

export interface AgentExplainParams {
  readonly paneId: string
}

export interface AgentExplainRuleWire {
  readonly id: string
  readonly priority: number
  readonly region: string
  readonly state: string
  readonly matched: boolean
  readonly regionBytes: number
  readonly regionPreview: string
}

/**
 * Why a pane reads the way it does.
 *
 * The development loop for a stale rule: capture the screen, see which rules fired and
 * what region text each one actually saw. herdr's `agent explain`, and the reason the
 * manifest design is worth having at all.
 */
export interface AgentExplainResult {
  readonly paneId: string
  readonly agent: string | null
  readonly status: WireAgentStatus | null
  /** Which evidence won: a hook, the screen, the process table, or nothing new. */
  readonly source: string | null
  readonly manifestSource: string | null
  readonly manifestVersion: string | null
  readonly matchedRule: { readonly id: string; readonly priority: number; readonly region: string } | null
  readonly fallbackReason: string | null
  readonly warning: string | null
  readonly evaluatedRules: readonly AgentExplainRuleWire[]
  /** The exact text detection ran against, so a rule can be written against it. */
  readonly screen: string
  readonly oscTitle: string
}

export interface AgentReadParams {
  readonly paneId: string
  /** `detection` is what the engine sees; `viewport` is what the user sees. */
  readonly source?: 'detection' | 'viewport'
}

export interface AgentReadResult {
  readonly paneId: string
  readonly text: string
  readonly oscTitle: string
  readonly oscProgress: string
}

export interface AgentReloadManifestsParams {
  /** Reload only these agents. Absent means all of them. */
  readonly agents?: readonly string[]
}

export interface AgentManifestSummaryWire {
  readonly agent: string
  readonly source: string
  readonly version: string | null
  readonly path: string | null
  readonly warning: string | null
}

export interface AgentReloadManifestsResult {
  readonly manifests: readonly AgentManifestSummaryWire[]
}

// ---------------------------------------------------------------------------
// Worktrees (PHASE-5 Part B)
// ---------------------------------------------------------------------------

export interface WorktreeRecord {
  /** Absolute path of the worktree. Its identity, because git's is. */
  readonly path: string
  readonly branch: string | null
  /** The commit it is checked out at, when git reports one. */
  readonly head: string | null
  /** True for the repository's own main working tree, which must never be removed. */
  readonly primary: boolean
  /** Panes currently sitting in this worktree. */
  readonly paneIds: readonly string[]
}

// ---------------------------------------------------------------------------
// Source control
// ---------------------------------------------------------------------------

/** One changed path on one side of the index. */
export interface GitFileEntry {
  /** Repo-relative, as git prints it. */
  readonly path: string
  /** The rename or copy source, when there is one. */
  readonly origin: string | null
  /** `M`, `A`, `D`, `R`, `C`, `U` for untracked, or `!` for a conflict. */
  readonly letter: string
}

/**
 * A repository's working-tree state.
 *
 * Every source-control method returns this, not an acknowledgement: staging changes
 * both lists at once, so a caller that had to re-read would always re-read.
 */
export interface GitStatusResult {
  readonly root: string
  readonly branch: string
  readonly staged: readonly GitFileEntry[]
  readonly unstaged: readonly GitFileEntry[]
  readonly ahead: number
  readonly behind: number
  readonly hasUpstream: boolean
}

/**
 * Where to look.
 *
 * `paneId` is the one to send: the daemon reads that pane's shell's *live* directory,
 * which is the only thing that reflects a `cd`. `cwd` is the escape hatch for a caller
 * with no pane, and is used as given.
 */
export interface GitTargetParams {
  readonly paneId?: string
  readonly cwd?: string
}

export type GitStatusParams = GitTargetParams

export interface GitPathsParams extends GitTargetParams {
  /** Repo-relative paths. Empty means every changed path, except for `git.discard`. */
  readonly paths?: readonly string[]
}

export interface GitCommitParams extends GitTargetParams {
  readonly message: string
}

export interface WorktreeListParams {
  /** Any path inside the repository. Defaults to the focused pane's cwd. */
  readonly repo?: string
}

export interface WorktreeListResult {
  readonly repo: string | null
  readonly worktrees: readonly WorktreeRecord[]
}

export interface WorktreeCreateParams {
  readonly repo?: string
  /** Branch to create or check out. Required: an unnamed worktree is unfindable. */
  readonly branch: string
  /** Where to put it. Defaults to a sibling directory named after the branch. */
  readonly path?: string
  /** What to branch from. Defaults to the repository's current HEAD. */
  readonly base?: string
}

export interface WorktreeCreateResult {
  readonly worktree: WorktreeRecord
  readonly created: boolean
}

export interface WorktreeOpenParams {
  readonly path: string
  /** Open in a new workspace (the default) or a new tab in this one. */
  readonly target?: 'workspace' | 'tab'
  /** What the first pane runs. Absent means the configured shell. */
  readonly command?: string
  readonly args?: readonly string[]
}

export interface WorktreeOpenResult {
  readonly worktree: WorktreeRecord
  readonly workspaceId: string | null
  readonly tabId: string | null
  readonly paneId: string | null
}

export interface WorktreeRemoveParams {
  readonly path: string
  /** Remove it even with uncommitted changes. Off by default, deliberately. */
  readonly force?: boolean
  /** Also delete the branch it was on. */
  readonly deleteBranch?: boolean
}

export interface WorktreeRemoveResult {
  readonly removed: boolean
  /** Why not, when `removed` is false. */
  readonly reason: string | null
  readonly branchDeleted: boolean
}

// ---------------------------------------------------------------------------
// Integrations (PHASE-5 Part B)
// ---------------------------------------------------------------------------

export interface IntegrationRecord {
  readonly agent: string
  /** Whether this agent's hooks are installed, and at which asset version. */
  readonly installed: boolean
  readonly installedVersion: number | null
  /** The version this build ships. A lower `installedVersion` needs a reinstall. */
  readonly availableVersion: number
  readonly hookPath: string
  /** The agent's own settings file this touches, when it has one. */
  readonly settingsPath: string | null
}

export interface IntegrationListResult {
  readonly integrations: readonly IntegrationRecord[]
}

export interface IntegrationInstallParams {
  /** Install for these agents. Absent means every agent with an integration. */
  readonly agents?: readonly string[]
  /** Rewrite the assets even when the installed version already matches. */
  readonly force?: boolean
}

export interface IntegrationInstallOutcome {
  readonly agent: string
  readonly installed: boolean
  /** `installed`, `updated`, `unchanged`, or why it was skipped. */
  readonly result: string
  readonly hookPath: string
  readonly warning: string | null
}

export interface IntegrationInstallResult {
  readonly outcomes: readonly IntegrationInstallOutcome[]
}

export interface ConfigSetThemeParams {
  /** A built-in theme name, or '' to go back to the explicit `[theme]` colours. */
  readonly theme: string
}

export interface ConfigSetThemeResult {
  /** The file that was written, or null when there was nowhere to write one. */
  readonly path: string | null
  readonly theme: string
  readonly config: unknown
}

export interface ConfigSetParams {
  /** A dotted config path, e.g. `sound.agent-done`. Only known keys are accepted. */
  readonly path: string
  readonly value: boolean | number | string
}

export interface ConfigSetResult {
  readonly path: string | null
  readonly config: unknown
}
