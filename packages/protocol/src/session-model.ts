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
  /**
   * What the tab's first pane runs. Absent means the configured shell.
   *
   * `workspace.create` has had this since phase 4 and `pane.split` since before that;
   * `tab.create` did not, and a plugin whose manifest asks for `placement = "tab"` has
   * nowhere to put its argv without it. Same shape as the other two, deliberately.
   */
  readonly command?: string
  readonly args?: readonly string[]
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

/**
 * One entry in the branch picker.
 *
 * `name` is the short name git prints — `main` for a local branch, `origin/main` for a
 * remote-tracking one — and `remote` says which, because checking one out is a
 * different command: a remote name has to become a local tracking branch first.
 */
export interface GitBranch {
  readonly name: string
  readonly current: boolean
  readonly remote: boolean
}

export interface GitBranchesResult {
  readonly root: string
  /** Most recently committed first, with the current branch rotated to the front. */
  readonly branches: readonly GitBranch[]
}

export interface GitCheckoutParams extends GitTargetParams {
  /** The short name, exactly as `git.branches` gave it. */
  readonly branch: string
  /** True when `branch` is remote-tracking, so a local branch is created to track it. */
  readonly remote?: boolean
}

/**
 * What a sync did, plus the status it left behind.
 *
 * The message is git's own output rather than a phrase of ours: a rebase that stopped
 * on a conflict prints exactly which file and exactly which command continues it, and
 * nothing this project could write would be more useful than that.
 */
export interface GitSyncResult {
  readonly status: GitStatusResult
  readonly message: string
}

/**
 * One repository's headline, for a sidebar row.
 *
 * The sidebar lists workspaces, and a workspace is a directory; the two facts a person
 * scanning that list wants are which branch it is on and whether it is behind. That is
 * `git status -sb`'s header and nothing else, which is why this is its own small
 * result rather than a `GitStatusResult` per workspace — a status carries every
 * changed path, and the sidebar draws one line.
 */
export interface GitRepoSummary {
  /** The directory that was asked about, echoed back so the caller can match it up. */
  readonly path: string
  /** False when the directory is not inside a checkout; every other field is then empty. */
  readonly isRepo: boolean
  readonly branch: string
  readonly ahead: number
  readonly behind: number
  readonly hasUpstream: boolean
  /** Anything tracked is modified or staged. Untracked files do not count. */
  readonly dirty: boolean
}

export interface GitSummaryParams {
  /** Absolute directories. One `git` invocation each; the caller keeps the list short. */
  readonly paths: readonly string[]
}

export interface GitSummaryResult {
  readonly summaries: readonly GitRepoSummary[]
}

// ---------------------------------------------------------------------------
// The Source Control drawers (PHASE-11)
// ---------------------------------------------------------------------------

/**
 * The eight read-mostly lists under the changes list.
 *
 * herdr-sidebar's `Drawer` enum, name for name. Each one is a single `git` command's
 * output, fetched when the drawer is opened and never on a status refresh.
 */
export type GitDrawerId =
  | 'graph'
  | 'commits'
  | 'fileHistory'
  | 'branches'
  | 'worktrees'
  | 'remotes'
  | 'stashes'
  | 'tags'

/**
 * A commit, from `graph`, `commits` or `fileHistory`.
 *
 * `rail` is the `--graph` art that preceded it on the line — `* `, `| * ` — and is
 * empty for the drawers that do not draw one. It is carried rather than re-derived
 * because git is the only thing that knows where the rails go, and drawing our own DAG
 * is a project rather than a row.
 */
export interface GitCommitRow {
  readonly kind: 'commit'
  /** The full hash. Every commit action takes this, never an abbreviation. */
  readonly hash: string
  /** What is shown: git's own `--abbrev-commit` length. */
  readonly short: string
  readonly subject: string
  /** `%D` split up: branch and tag names pointing here, `HEAD` included. */
  readonly refs: readonly string[]
  /** `%ad` under `--date=short`, so `2026-09-21`. Empty when git printed none. */
  readonly date: string
  readonly rail: string
}

/**
 * A `--graph` line with no commit on it: `|\`, `|/`, `| |`.
 *
 * Its own row type rather than a commit with an empty hash, so nothing downstream can
 * offer a context menu for a piece of ASCII art.
 */
export interface GitRailRow {
  readonly kind: 'rail'
  readonly rail: string
}

export interface GitBranchRow {
  readonly kind: 'branch'
  readonly name: string
  readonly current: boolean
  readonly remote: boolean
}

/**
 * A worktree, with the parts a 34-column dock can show.
 *
 * `name` is the folder's own name, which is what `pretty_worktree_line` exists for
 * upstream: an absolute path "clipped uselessly in a narrow pane". The full `path`
 * travels too, because that is what `worktree.remove` and `Copy Path` need.
 */
export interface GitWorktreeRow {
  readonly kind: 'worktree'
  readonly path: string
  readonly name: string
  readonly branch: string | null
  readonly head: string | null
  readonly primary: boolean
}

export interface GitRemoteRow {
  readonly kind: 'remote'
  readonly name: string
  /** The fetch URL. `git remote -v`'s push line is dropped; it is the same URL. */
  readonly url: string
}

export interface GitStashRow {
  readonly kind: 'stash'
  /** Position in `git stash list`, which is the `N` in `stash@{N}`. */
  readonly index: number
  /** `%gd`, as git spelled it: `stash@{0}`. Every stash action takes this. */
  readonly ref: string
  readonly hash: string
  /** `%gs`: `WIP on main: 1e7f2c9 merge feat`. */
  readonly subject: string
}

export interface GitTagRow {
  readonly kind: 'tag'
  readonly name: string
}

export type GitDrawerRow =
  | GitCommitRow
  | GitRailRow
  | GitBranchRow
  | GitWorktreeRow
  | GitRemoteRow
  | GitStashRow
  | GitTagRow

export interface GitDrawerParams extends GitTargetParams {
  readonly drawer: GitDrawerId
  /** Repo-relative, and required by `fileHistory` alone. */
  readonly path?: string
  /** Rows at most. Defaults to `DRAWER_LIMIT`, which is herdr-sidebar's 30. */
  readonly limit?: number
}

/**
 * What a drawer holds.
 *
 * `note` is how a drawer says something other than "here are rows": no commits yet, no
 * file selected. An empty list with no note is an empty drawer, which is the normal
 * state of Stashes and Tags and must not read as a failure.
 */
export interface GitDrawerResult {
  readonly drawer: GitDrawerId
  readonly rows: readonly GitDrawerRow[]
  readonly note: string | null
}

/**
 * A drawer row's menu entry that reaches git.
 *
 * Only the ones with no home already: `Checkout Branch` is `git.checkout`, removing a
 * worktree is `worktree.remove`, and every `Show Changes` is a pager pane the client
 * opens. Adding those here would be a second way to do each.
 */
export type GitDrawerActionId =
  | 'commit.checkout'
  | 'commit.cherryPick'
  | 'commit.revert'
  | 'commit.reset'
  | 'branch.merge'
  | 'branch.delete'
  | 'stash.apply'
  | 'stash.pop'
  | 'stash.drop'
  | 'remote.fetch'
  | 'tag.checkout'
  | 'tag.delete'

export interface GitDrawerActionParams extends GitTargetParams {
  readonly action: GitDrawerActionId
  /** A hash, a branch name, `stash@{N}`, a remote name or a tag — per action. */
  readonly ref: string
}

/** git's own last line, and the status the action left behind. */
export interface GitDrawerActionResult {
  readonly message: string
  readonly status: GitStatusResult
}

// ---------------------------------------------------------------------------
// Filesystem (the explorer)
// ---------------------------------------------------------------------------

export interface FsEntry {
  readonly name: string
  readonly kind: 'dir' | 'file' | 'other'
  readonly link: boolean
}

export interface FsListParams extends GitTargetParams {
  /** Directory to list, relative to the resolved root. `''` or absent is the root. */
  readonly path?: string
}

export interface FsListResult {
  /** The root the listing is relative to, absolute and real. */
  readonly root: string
  readonly path: string
  readonly entries: readonly FsEntry[]
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

// ---------------------------------------------------------------------------
// Search (quick open and content search)
// ---------------------------------------------------------------------------

/**
 * Which cap stopped a search, or null when nothing did.
 *
 * Reported rather than inferred. A client cannot tell a complete result from a capped
 * one by counting — 1,000 matches is a plausible honest answer — so the daemon says
 * which bound it hit, and the panel says so on screen.
 */
export type SearchCap = 'matches' | 'files' | 'time'

/** Where a file list came from. `git` is the no-ripgrep fallback; see `search.ts`. */
export type SearchEngine = 'ripgrep' | 'git'

export type SearchFilesParams = GitTargetParams

export interface SearchFilesResult {
  /** The root the paths are relative to, absolute and real. */
  readonly root: string
  /** Repo-relative, `/`-separated, sorted case-insensitively. */
  readonly files: readonly string[]
  readonly truncated: boolean
  readonly cap: SearchCap | null
  readonly engine: SearchEngine
}

export interface SearchContentParams extends GitTargetParams {
  readonly query: string
  /** Default false: a search nobody configured is case-insensitive, as in VS Code. */
  readonly matchCase?: boolean
  readonly wholeWord?: boolean
  readonly regex?: boolean
  /** Comma-separated globs. Empty means no restriction. */
  readonly include?: string
  readonly exclude?: string
}

/**
 * One matching line.
 *
 * `column` and `matchLength` are the **true** position in the file's line;
 * `displayColumn` and `displayMatchLength` index into `text`, which may be a window
 * clipped around the match. Keeping the two apart is what lets a 200 KB minified line
 * show something useful and still open at the right place.
 */
export interface SearchMatch {
  /** 1-based, as every editor and pager counts them. */
  readonly line: number
  /** 1-based column in the untruncated line. */
  readonly column: number
  readonly matchLength: number
  /** The line, possibly windowed around the match and marked with `…`. */
  readonly text: string
  readonly displayColumn: number
  readonly displayMatchLength: number
}

export interface SearchFileMatches {
  /** Repo-relative, `/`-separated. */
  readonly path: string
  readonly matches: readonly SearchMatch[]
}

export interface SearchContentResult {
  readonly root: string
  /** Grouped by file, in the order ripgrep reported them. */
  readonly files: readonly SearchFileMatches[]
  readonly totalMatches: number
  readonly truncated: boolean
  readonly cap: SearchCap | null
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/**
 * What produced a preview's lines.
 *
 * `plain` is the daemon's own decoding, and is always available. The other three are
 * programs the user installed; the panel names whichever ran, because "this is glow's
 * idea of the file" and "these are the bytes" are different claims about what is on
 * screen.
 */
export type PreviewRenderer = 'plain' | 'bat' | 'glow' | 'delta'

/** Which bound stopped a preview, or null when nothing did. */
export type PreviewCap = 'bytes' | 'lines'

export interface PreviewReadParams extends GitTargetParams {
  /** Root-relative, `/`-separated — the same path the explorer and search hand around. */
  readonly path: string
  /** The dock's width, so a renderer that reflows reflows to the right number. */
  readonly width?: number
}

export interface PreviewResult {
  /** Echoed back, so a late reply for a file the cursor has left can be discarded. */
  readonly path: string
  readonly renderer: PreviewRenderer
  /** Already split; no line ends with a newline. Empty when `binary`. */
  readonly lines: readonly string[]
  /**
   * The file is binary and was not rendered.
   *
   * Decided from a bounded prefix, never from the whole file — see `preview.ts`. The
   * panel says so rather than painting the bytes, because a terminal handed arbitrary
   * bytes does arbitrary things to its own state.
   */
  readonly binary: boolean
  readonly truncated: boolean
  readonly cap: PreviewCap | null
  /** The file's size in bytes, so the panel can say how much it is not showing. */
  readonly size: number
}

// ---------------------------------------------------------------------------
// Commit-message drafting
// ---------------------------------------------------------------------------

/** Where a draft came from. `filenames` is the offline fallback and needs no model. */
export type SuggestSource = 'claude' | 'filenames'

export interface GitSuggestParams extends GitTargetParams {
  /**
   * Try the local `claude` CLI.
   *
   * Sent only when `[sidebar] ai-commit` is on, which is off by default. Absent or
   * false means the daemon starts no subprocess and reads nothing but the status — the
   * draft is written from the staged filenames, offline.
   */
  readonly ai?: boolean
}

export interface GitSuggestResult {
  readonly message: string
  readonly source: SuggestSource
  /**
   * Why the model was not used, when it was asked for and did not run.
   *
   * A draft that fell back is still a draft, so this travels beside a usable message
   * rather than in place of one.
   */
  readonly note: string | null
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

/**
 * The platform names a `herdr-plugin.toml` may use.
 *
 * `windows` is accepted because herdr manifests write it and refusing to *parse* a
 * manifest over a platform we do not run on would make every cross-platform plugin
 * uninstallable here. Nothing declared `windows`-only is ever offered; see
 * `plugins/manifest.ts`.
 */
export type PluginPlatform = 'linux' | 'macos' | 'windows'

/** The placements this host can actually produce. */
export type PluginPlacement = 'split' | 'tab'

/**
 * Every placement herdr's manifest can name.
 *
 * `overlay`, `popup` and `zoomed` have no counterpart here — this multiplexer has one
 * kind of pane, and PHASE-10 says not to grow a second. They parse, they fall back to
 * `split`, and the fallback is reported rather than hidden.
 */
export type PluginDeclaredPlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed'

/** Where an entrypoint came from in the manifest. */
export type PluginEntrypointKind = 'pane' | 'action'

export interface PluginEntrypointInfo {
  readonly id: string
  readonly title: string
  readonly description: string | null
  readonly kind: PluginEntrypointKind
  /** What we will do. */
  readonly placement: PluginPlacement
  /** What the manifest asked for, when that is not what we will do. */
  readonly placementFallbackFrom: PluginDeclaredPlacement | null
  /** argv. Never run through a shell. */
  readonly command: readonly string[]
  /** Empty means every platform. */
  readonly platforms: readonly PluginPlatform[]
}

/**
 * What an install was pinned to.
 *
 * `contentHash` is over the fetched source tree, before the build ran — build output is
 * machine-specific and hashing it would make every re-install look tampered with. It is
 * the answer to "are these the same bytes I approved?", and `plugin verify` re-computes
 * it against what is on disk now.
 */
export interface PluginPin {
  /** `owner/repo[/subdir]`, or a local path, as the user typed it. */
  readonly source: string
  /** The ref asked for, or null when the remote's default HEAD was taken. */
  readonly ref: string | null
  /** The commit that ref resolved to. */
  readonly commit: string
  /** `sha256:<hex>` over the source tree, `.git` excluded. */
  readonly contentHash: string
}

export interface InstalledPluginInfo {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string | null
  /** The directory the manifest sits in; `HERDR_PLUGIN_ROOT`. */
  readonly root: string
  readonly manifestPath: string
  readonly configDir: string
  readonly stateDir: string
  readonly platforms: readonly PluginPlatform[]
  readonly entrypoints: readonly PluginEntrypointInfo[]
  /** Manifest keys that parsed and are deliberately not honoured, named one by one. */
  readonly ignored: readonly string[]
  readonly pin: PluginPin
  /**
   * `sha256:<hex>` over the store directory as it stood the moment the install finished.
   *
   * Distinct from `pin.contentHash`, and the difference matters: the pin is over the
   * *fetched source*, so it answers "did the remote hand me the same bytes as last
   * time?", while this is over the *built tree*, so it answers "has anything changed
   * under my feet since?". Hashing one thing for both questions would make every
   * plugin with a build step look tampered with the instant it was installed.
   */
  readonly installedHash: string
  readonly installedAt: number
  /** The recorded root is gone from disk. The entry is still listed, and says so. */
  readonly missing: boolean
}

export interface PluginListParams {
  readonly pluginId?: string
}

export interface PluginListResult {
  readonly plugins: readonly InstalledPluginInfo[]
  /** What `$HERDR_BIN_PATH` is set to for a plugin's own children. */
  readonly shimPath: string
}

export interface PluginPaneOpenParams {
  readonly pluginId: string
  /** Absent means the plugin's only entrypoint, and is an error when it has several. */
  readonly entrypointId?: string
  /** Overrides the manifest's placement. */
  readonly placement?: PluginPlacement
  readonly targetPaneId?: string
  readonly direction?: WireSplitDirection
  readonly cwd?: string
  readonly focus?: boolean
  readonly env?: Readonly<Record<string, string>>
}

export interface PluginPaneOpenResult {
  readonly pluginId: string
  readonly entrypointId: string
  readonly paneId: string
  readonly tabId: string | null
  readonly placement: PluginPlacement
  /**
   * The pane was already open and was focused instead of opened again.
   *
   * One entrypoint has one live pane, wherever it is — a second open focuses it rather
   * than splitting a second copy of the same viewer next to the first.
   */
  readonly reused: boolean
  readonly placementFallbackFrom: PluginDeclaredPlacement | null
}

export interface PluginActionInvokeParams {
  readonly pluginId: string
  readonly actionId: string
  readonly cwd?: string
}

export interface PluginActionInvokeResult {
  readonly pluginId: string
  readonly actionId: string
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** Output passed the cap and the rest was dropped. It was never buffered. */
  readonly truncated: boolean
  readonly timedOut: boolean
}
