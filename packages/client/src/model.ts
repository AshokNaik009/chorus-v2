/**
 * Reading the daemon's session model.
 *
 * The client holds one `SessionStateSnapshot` and derives everything it draws from it.
 * These are the derivations: which workspace is active, which tab, where each pane
 * goes. Nothing here mutates — a change is an RPC call followed by a new snapshot.
 *
 * Geometry is computed *here*, not in the daemon, because the screen is the client's.
 * The daemon owns the tree and the ratios; turning those into rectangles needs a width
 * and a height, and a headless daemon serving two clients at different sizes has
 * neither.
 */

import { placements, type LayoutNode, type Rect } from '@leap-chorus/core'
import type {
  PaneRecord,
  SessionStateSnapshot,
  TabRecord,
  WireLayoutNode,
  WorkspaceRecord
} from '@leap-chorus/protocol'

export const EMPTY_STATE: SessionStateSnapshot = {
  revision: 0,
  workspaces: [],
  workspaceOrder: [],
  tabs: [],
  panes: [],
  activeWorkspaceId: null,
  focusedPaneId: null
}

/** The wire layout as `core`'s tree, so `core`'s geometry can place it. */
export function toLayoutNode(node: WireLayoutNode): LayoutNode {
  if (node.type === 'pane') return { kind: 'pane', id: node.paneId }
  return {
    kind: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: toLayoutNode(node.first),
    second: toLayoutNode(node.second)
  }
}

export function workspaceById(state: SessionStateSnapshot, id: string | null): WorkspaceRecord | null {
  if (id === null) return null
  return state.workspaces.find((workspace) => workspace.workspaceId === id) ?? null
}

export function tabById(state: SessionStateSnapshot, id: string | null): TabRecord | null {
  if (id === null) return null
  return state.tabs.find((tab) => tab.tabId === id) ?? null
}

export function paneById(state: SessionStateSnapshot, id: string | null): PaneRecord | null {
  if (id === null) return null
  return state.panes.find((pane) => pane.paneId === id) ?? null
}

export function activeWorkspace(state: SessionStateSnapshot): WorkspaceRecord | null {
  return workspaceById(state, state.activeWorkspaceId)
}

export function activeTab(state: SessionStateSnapshot): TabRecord | null {
  const workspace = activeWorkspace(state)
  return workspace === null ? null : tabById(state, workspace.activeTabId)
}

export function tabsOf(state: SessionStateSnapshot, workspaceId: string): TabRecord[] {
  const workspace = workspaceById(state, workspaceId)
  if (!workspace) return []
  return workspace.tabIds.flatMap((id) => {
    const tab = tabById(state, id)
    return tab === null ? [] : [tab]
  })
}

export function orderedWorkspaces(state: SessionStateSnapshot): WorkspaceRecord[] {
  return state.workspaceOrder.flatMap((id) => {
    const workspace = workspaceById(state, id)
    return workspace === null ? [] : [workspace]
  })
}

export interface VisiblePane {
  readonly paneId: string
  /** Outer rect, borders included. */
  readonly rect: Rect
  readonly focused: boolean
}

/**
 * Which panes are on screen and where.
 *
 * A zoomed tab shows exactly one pane filling the whole area — which is what makes a
 * hidden pane cheap, because the render loop never asks for a snapshot of a pane that
 * is not in this list.
 */
export function visiblePanes(state: SessionStateSnapshot, area: Rect): VisiblePane[] {
  const tab = activeTab(state)
  if (!tab) return []
  if (tab.zoomed) return [{ paneId: tab.focusedPaneId, rect: area, focused: true }]
  return placements(toLayoutNode(tab.layout), area).map((entry) => ({
    paneId: entry.id,
    rect: entry.rect,
    focused: entry.id === tab.focusedPaneId
  }))
}

/** What to draw on a pane's border: the rename, else the program's title, else the id. */
export function paneTitle(pane: PaneRecord): string {
  const name =
    pane.label !== null && pane.label.length > 0
      ? pane.label
      : pane.title !== null && pane.title.length > 0
        ? pane.title
        : `pane ${pane.number}`
  return pane.exited ? `${name} (exited)` : name
}

/**
 * One glyph per agent state.
 *
 * Duplicated from `core`'s `AGENT_STATUS_GLYPH` rather than imported, because this
 * reads a `PaneRecord` off the wire and `core` reads a `Pane` — and the wire type
 * deliberately allows a status this build has never heard of. An unknown value falls
 * back to `?` instead of drawing nothing, which is what the optional-enum rule in the
 * protocol asks of a client.
 */
const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  idle: '·',
  working: '*',
  blocked: '!',
  unknown: '?',
  done: '✓'
}

export function agentGlyph(status: string | null | undefined): string | null {
  if (status === null || status === undefined) return null
  return STATUS_GLYPHS[status] ?? '?'
}

/** `claude *`, or null when the pane is not running an agent. */
export function agentBadge(pane: PaneRecord): string | null {
  const glyph = agentGlyph(pane.agentStatus)
  if (glyph === null || pane.agent === null || pane.agent === undefined) return null
  return `${pane.agent} ${glyph}`
}

/**
 * The state a whole workspace is in, for its one sidebar row.
 *
 * Worst-first: `blocked` beats `working` beats everything else, because the row exists
 * to answer "does anything in there need me?" across a workspace the user cannot see.
 * A workspace of fifteen idle panes and one blocked one is a blocked workspace.
 */
export function workspaceAgentStatus(state: SessionStateSnapshot, workspaceId: string): string | null {
  const panes = panesOf(state, workspaceId)
  let seen: string | null = null
  for (const pane of panes) {
    const status = pane.agentStatus
    if (status === null || status === undefined) continue
    if (status === 'blocked') return 'blocked'
    if (status === 'working') seen = 'working'
    else if (seen === null) seen = status
  }
  return seen
}

/** A pane running an agent, wherever it is. */
export interface AgentEntry {
  readonly paneId: string
  readonly agent: string
  readonly status: string
  readonly workspaceId: string
  readonly workspaceNumber: number
  /** The pane's own title, for the second line. */
  readonly title: string
}

/**
 * Every agent in the session, across every workspace.
 *
 * The point of the list is the agents you *cannot* see: a blocked agent three
 * workspaces away is the one you need to be told about, and the per-workspace rows
 * only summarize. Ordered worst-state first for the same reason — `blocked` before
 * `working` before the rest — so the thing waiting on you is at the top.
 */
const STATUS_RANK: Readonly<Record<string, number>> = { blocked: 0, working: 1, idle: 2, unknown: 3, done: 4 }

export function agentEntries(state: SessionStateSnapshot): AgentEntry[] {
  const entries: AgentEntry[] = []
  for (const workspace of orderedWorkspaces(state)) {
    for (const pane of panesOf(state, workspace.workspaceId)) {
      if (pane.agent === null || pane.agent === undefined) continue
      if (pane.agentStatus === null || pane.agentStatus === undefined) continue
      entries.push({
        paneId: pane.paneId,
        agent: pane.agent,
        status: pane.agentStatus,
        workspaceId: workspace.workspaceId,
        workspaceNumber: workspace.number,
        title: paneTitle(pane)
      })
    }
  }
  return entries.sort((a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9))
}

/** Every pane of a workspace, across all its tabs. */
export function panesOf(state: SessionStateSnapshot, workspaceId: string): PaneRecord[] {
  const ids = new Set<string>()
  for (const tab of tabsOf(state, workspaceId)) collectPaneIds(tab.layout, ids)
  return state.panes.filter((pane) => ids.has(pane.paneId))
}

function collectPaneIds(node: WireLayoutNode, into: Set<string>): void {
  if (node.type === 'pane') {
    into.add(node.paneId)
    return
  }
  collectPaneIds(node.first, into)
  collectPaneIds(node.second, into)
}

export function workspaceTitle(workspace: WorkspaceRecord): string {
  return workspace.label !== null && workspace.label.length > 0
    ? workspace.label
    : `workspace ${workspace.number}`
}

export function tabTitle(tab: TabRecord): string {
  return tab.label !== null && tab.label.length > 0 ? tab.label : `${tab.number}`
}
