/**
 * One pane, one verdict: which agent, and what it is doing.
 *
 * This is the only place the three evidence sources meet, and the arbitration between
 * them is the whole content of the file:
 *
 * | Source | Costs | Authority |
 * |---|---|---|
 * | an installed hook | nothing per byte — the agent tells us | highest |
 * | the screen, through a manifest | a region scan per poll | fallback |
 * | the process table | one shared `ps` per TTL | says *which* agent, and when it is gone |
 *
 * PHASE-5: "Prefer hooks over screen-scraping where the agent supports it. Treat hook
 * signals as authoritative and screen matching as the fallback, not the reverse."
 *
 * ## The two places the screen still overrules a hook
 *
 * - **A visible blocker.** A hook that last said `working` and an agent drawing "Do you
 *   want to proceed?" disagree, and the screen is right: the hook event for a
 *   permission prompt is the one most likely to be missing, and a pane wrongly shown as
 *   working is a user who never notices it is waiting for them. herdr's rule, ported:
 *   `visible_blocker` "may override a non-blocked integration state".
 * - **A stale hook.** A hook report is a fact about the moment it was sent. After
 *   {@link HOOK_AUTHORITY_MS} without one, an agent that crashed mid-turn would be
 *   `working` forever, so authority lapses back to the screen.
 *
 * ## `done` is a process fact, not a screen fact
 *
 * The four manifest states describe an agent that is running. A pane whose agent has
 * *exited* — back at a shell prompt, transcript still on screen — is the state a user
 * most wants the sidebar to show, and no amount of screen matching can distinguish it
 * from an agent sitting idle at the same transcript. The process table can, so `done`
 * comes from there.
 */

import { identifyAgent, identifyAgentInCommand, type PaneAgentStatus } from './agents.js'
import { detect, explain, type AgentState, type DetectionExplain } from './manifest.js'
import { detectionInput } from './regions.js'
import { foregroundCandidates, type ProcessIndex, ProcessTable } from './process-table.js'
import { ManifestRegistry } from './registry.js'

/** How long a hook report stays authoritative without a newer one. */
export const HOOK_AUTHORITY_MS = 30_000

/** What an agent's own integration reported. See `integration/`. */
export interface HookReport {
  readonly agent: string
  readonly state: AgentState
  /** The agent's monotonic counter, so an out-of-order delivery is dropped. */
  readonly seq: number
  readonly receivedAtMs: number
  /** The agent's own session id, when its hook knows one. */
  readonly agentSessionId?: string
}

export interface PaneDetectionInput {
  /** The pane's shell pid. Null when the pane has no live session. */
  readonly shellPid: number | null
  /** The live screen, as text. Not the user's scrolled viewport — see `detectionScreen`. */
  readonly screen: string
  readonly oscTitle?: string
  readonly oscProgress?: string
  readonly hook?: HookReport | null
  /** What this pane reported last tick, so `skip_state_update` has something to keep. */
  readonly previousAgent?: string | null
  readonly previousStatus?: PaneAgentStatus | null
}

export type DetectionSource = 'hook' | 'screen' | 'process' | 'retained'

export interface PaneDetection {
  readonly agent: string | null
  readonly status: PaneAgentStatus | null
  readonly source: DetectionSource | null
  /** Set when the screen is a viewer and the previous status was kept. */
  readonly skipped: boolean
}

export interface AgentDetectorOptions {
  readonly registry?: ManifestRegistry
  readonly processTable?: ProcessTable
  readonly now?: () => number
}

export class AgentDetector {
  readonly registry: ManifestRegistry
  readonly processTable: ProcessTable
  private readonly now: () => number

  constructor(options: AgentDetectorOptions = {}) {
    this.registry = options.registry ?? new ManifestRegistry()
    this.processTable = options.processTable ?? new ProcessTable()
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Read the shared process table once, then classify every pane against it.
   *
   * Batched deliberately: this is the call the poll makes, and taking the table here
   * rather than inside `detectPane` is what makes fifteen panes cost one capture. A
   * table that cannot be read is not an answer — every pane keeps what it had, rather
   * than being told its agent vanished.
   */
  async detectAll<K>(panes: ReadonlyMap<K, PaneDetectionInput>): Promise<Map<K, PaneDetection>> {
    const out = new Map<K, PaneDetection>()
    if (panes.size === 0) return out
    let index: ProcessIndex | null = null
    try {
      index = await this.processTable.get()
    } catch {
      index = null
    }
    for (const [key, input] of panes) out.set(key, this.classify(index, input))
    return out
  }

  /** One pane against an already-captured table. Synchronous, and the tested path. */
  classify(index: ProcessIndex | null, input: PaneDetectionInput): PaneDetection {
    const previousAgent = input.previousAgent ?? null
    const previousStatus = input.previousStatus ?? null

    if (index === null) {
      // No table: keep what we knew. Reporting `null` here would blank every badge on
      // the machine each time `ps` was slow.
      return { agent: previousAgent, status: previousStatus, source: 'retained', skipped: false }
    }

    const agent = this.agentOf(index, input)
    if (agent === null) {
      // The agent is gone but the pane is not. That is `done`, and it is sticky: the
      // pane keeps the name of the agent that ran in it until something else does.
      if (previousAgent !== null && previousStatus !== null) {
        return { agent: previousAgent, status: 'done', source: 'process', skipped: false }
      }
      return { agent: null, status: null, source: null, skipped: false }
    }

    const loaded = this.registry.get(agent)
    const screen =
      loaded === null
        ? null
        : detect(
            loaded.compiled,
            detectionInput({
              screen: input.screen,
              oscTitle: input.oscTitle ?? '',
              oscProgress: input.oscProgress ?? ''
            })
          )

    // A viewer screen (a transcript, a model picker) says nothing about the agent's
    // state, so the pane keeps what it had rather than reading the transcript's text.
    if (screen?.skipStateUpdate === true) {
      const kept = previousAgent === agent ? previousStatus : null
      return { agent, status: kept ?? 'unknown', source: 'retained', skipped: true }
    }

    const hook = input.hook ?? null
    const hookIsCurrent =
      hook !== null && hook.agent === agent && this.now() - hook.receivedAtMs < HOOK_AUTHORITY_MS
    if (hookIsCurrent) {
      if (screen?.visibleBlocker === true && hook.state !== 'blocked') {
        return { agent, status: 'blocked', source: 'screen', skipped: false }
      }
      return { agent, status: hook.state, source: 'hook', skipped: false }
    }

    if (screen === null) {
      // A known agent with no manifest: we can say it is running, not what it is doing.
      return { agent, status: 'unknown', source: 'process', skipped: false }
    }
    return { agent, status: screen.state, source: 'screen', skipped: false }
  }

  /** The full rule trace for one pane. `agent.explain`, and the development loop. */
  explainPane(index: ProcessIndex | null, input: PaneDetectionInput): DetectionExplain | null {
    if (index === null) return null
    const agent = this.agentOf(index, input)
    if (agent === null) return null
    const loaded = this.registry.get(agent)
    if (loaded === null) return null
    return explain(
      loaded.compiled,
      detectionInput({
        screen: input.screen,
        oscTitle: input.oscTitle ?? '',
        oscProgress: input.oscProgress ?? ''
      })
    )
  }

  /**
   * Which agent, if any, is running under this pane.
   *
   * Walks every candidate the process table offers rather than trusting one, and takes
   * the first that names an agent. A pane launched straight into `claude` is its own
   * foreground group leader *and* has children (an MCP server), so no single rule
   * picks it out — see `foregroundCandidates`.
   */
  private agentOf(index: ProcessIndex, input: PaneDetectionInput): string | null {
    if (input.shellPid === null) return null
    for (const command of foregroundCandidates(index, input.shellPid)) {
      // The whole command line, not just argv[0]: `node .../claude-code/cli.js` is how
      // several of these actually run.
      const agent = identifyAgent(command.split(/\s+/u)[0] ?? '') ?? identifyAgentInCommand(command)
      if (agent !== null) return agent.id
    }
    return null
  }
}
