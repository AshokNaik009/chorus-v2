/**
 * A pane: the session-level facts about one terminal.
 *
 * This is deliberately *not* the terminal. There is no PTY here, no emulator, no cell
 * grid — a pane knows which runtime session it is bound to (`sessionId`) and nothing
 * about what that session is doing. That separation is what lets the whole workspace
 * model be tested without spawning anything, and it is herdr's `PaneState` /
 * `PaneRuntime` split.
 *
 * Presentation state (selection rectangles, hover, mouse drags) is not here either; it
 * belongs to the client. The two facts that look presentational and are not:
 *
 * - `scrollOffset` is how far back the *pane* is scrolled, which `pane.scroll` sets and
 *   which decides what a snapshot contains. Two clients attached to one pane see the
 *   same scrollback position, the way they see the same output.
 * - `rightClick` is what `pane.input.set` routes a right click to. It changes what the
 *   pane receives, so it is input routing rather than decoration.
 */

/** Where a right click in this pane goes. herdr's `PaneRightClickTarget`. */
export type RightClickTarget = 'app' | 'pane'

/**
 * What the agent in this pane is doing.
 *
 * Four of these come from the detection engine; `done` comes from the process table,
 * because an agent that has *exited* draws exactly the same transcript as one sitting
 * idle and no screen rule can tell them apart. Null means this pane is not running an
 * agent at all — a shell, an editor, a build.
 *
 * This lives on the pane, beside `title`, rather than in a client-side side table,
 * because it is a shared runtime fact: two clients attached to one daemon must agree
 * about it the way they agree about what the pane printed.
 */
export type AgentStatus = 'idle' | 'working' | 'blocked' | 'unknown' | 'done'

export interface Pane {
  readonly id: string
  /** The runtime session backing this pane; null before it is spawned or after restore. */
  sessionId: string | null
  /** A user-supplied name from `pane.rename`. Beats the program's own title. */
  label: string | null
  /** The program's OSC 0/2 title, as last reported by the runtime. */
  title: string | null
  readonly cwd: string
  readonly command: string | null
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /** Public number within the workspace. Reassigned on close; not an identity. */
  number: number
  exited: boolean
  rightClick: RightClickTarget
  /** Lines scrolled back from the bottom. 0 is live. */
  scrollOffset: number
  /** Which agent the detector last saw here, or null for a pane running anything else. */
  agent: string | null
  /** What that agent is doing. Null exactly when `agent` is null. */
  agentStatus: AgentStatus | null
  /**
   * The agent's own session id, when its integration reported one.
   *
   * Carried so a worktree or a resume can name the conversation, not just the pane.
   */
  agentSessionId: string | null
  readonly createdAt: number
}

export interface CreatePaneOptions {
  readonly id: string
  readonly cwd: string
  readonly command?: string | null
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly label?: string | null
  readonly number?: number
  readonly createdAt?: number
  readonly sessionId?: string | null
}

export function createPane(options: CreatePaneOptions): Pane {
  return {
    id: options.id,
    sessionId: options.sessionId ?? null,
    label: options.label ?? null,
    title: null,
    cwd: options.cwd,
    command: options.command ?? null,
    args: options.args ?? [],
    env: options.env ?? {},
    number: options.number ?? 1,
    exited: false,
    rightClick: 'app',
    scrollOffset: 0,
    agent: null,
    agentStatus: null,
    agentSessionId: null,
    createdAt: options.createdAt ?? 0
  }
}

/** A short badge for a pane's agent state, or null when there is nothing to show. */
export function agentBadge(pane: Pane): string | null {
  if (pane.agent === null || pane.agentStatus === null) return null
  return `${pane.agent} ${AGENT_STATUS_GLYPH[pane.agentStatus]}`
}

/**
 * One character per state.
 *
 * Text, not colour, and not an emoji: colour alone fails for a colour-blind user and
 * on a monochrome terminal, and an emoji is two columns wide in some terminals and one
 * in others, which would shift every sidebar row that carried one.
 */
export const AGENT_STATUS_GLYPH: Record<AgentStatus, string> = {
  idle: '·',
  working: '*',
  blocked: '!',
  unknown: '?',
  done: '✓'
}

/** What to show on this pane's border: the rename, else the title, else the command. */
export function paneDisplayName(pane: Pane): string {
  if (pane.label !== null && pane.label.length > 0) return pane.label
  if (pane.title !== null && pane.title.length > 0) return pane.title
  if (pane.command !== null && pane.command.length > 0) {
    const parts = pane.command.split('/')
    const last = parts[parts.length - 1]
    if (last !== undefined && last.length > 0) return last
  }
  return pane.id
}
