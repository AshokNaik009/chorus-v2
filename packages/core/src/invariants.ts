/**
 * What must always be true of an `AppState`.
 *
 * herdr has `AppState::assert_invariants_for_test()` and
 * `test_with_adversarial_identity_state()` because identity and state refactors break in
 * ways no single behavioural test notices: a pane that is in two layouts, a focus that
 * points at a pane that was closed three actions ago, a workspace whose active tab
 * belongs to a different workspace. Each of those renders fine until it doesn't.
 *
 * `checkInvariants` returns the violations; `assertInvariants` throws on the first set.
 * Both are pure and cheap enough to run after every action in a test, which is how they
 * are meant to be used.
 */

import { paneIds, type LayoutNode } from './layout-tree.js'
import { MAX_RATIO, MIN_RATIO } from './layout-tree.js'
import type { AppState } from './state.js'

export interface Violation {
  /** A stable machine-readable name, so a test can assert on the kind not the prose. */
  readonly code: string
  readonly message: string
}

const V = (code: string, message: string): Violation => ({ code, message })

export function checkInvariants(state: AppState): Violation[] {
  const problems: Violation[] = []

  // --- workspace order and identity ---------------------------------------
  const seenOrder = new Set<string>()
  for (const id of state.workspaceOrder) {
    if (seenOrder.has(id)) problems.push(V('workspace.duplicate_order', `workspace ${id} appears twice in the order`))
    seenOrder.add(id)
    if (!state.workspaces.has(id)) problems.push(V('workspace.order_dangling', `order names unknown workspace ${id}`))
  }
  for (const id of state.workspaces.keys()) {
    if (!seenOrder.has(id)) problems.push(V('workspace.unordered', `workspace ${id} is not in the display order`))
  }
  for (const [id, workspace] of state.workspaces) {
    if (workspace.id !== id) problems.push(V('workspace.key_mismatch', `workspace keyed ${id} calls itself ${workspace.id}`))
  }

  // --- active workspace ----------------------------------------------------
  if (state.workspaceOrder.length > 0) {
    if (state.activeWorkspaceId === null) {
      problems.push(V('focus.no_active_workspace', 'workspaces exist but none is active'))
    } else if (!state.workspaces.has(state.activeWorkspaceId)) {
      problems.push(V('focus.active_workspace_dangling', `active workspace ${state.activeWorkspaceId} does not exist`))
    }
  } else if (state.activeWorkspaceId !== null) {
    problems.push(V('focus.active_workspace_dangling', 'active workspace set with no workspaces'))
  }

  // --- tabs ----------------------------------------------------------------
  const tabOwner = new Map<string, string>()
  for (const workspace of state.workspaces.values()) {
    if (workspace.tabIds.length === 0) {
      problems.push(V('workspace.empty', `workspace ${workspace.id} has no tabs`))
    }
    const seenTabs = new Set<string>()
    for (const tabId of workspace.tabIds) {
      if (seenTabs.has(tabId)) problems.push(V('tab.duplicate_in_workspace', `tab ${tabId} listed twice in ${workspace.id}`))
      seenTabs.add(tabId)
      const previous = tabOwner.get(tabId)
      if (previous !== undefined) {
        problems.push(V('tab.shared', `tab ${tabId} is listed by ${previous} and ${workspace.id}`))
      }
      tabOwner.set(tabId, workspace.id)
      const tab = state.tabs.get(tabId)
      if (!tab) {
        problems.push(V('tab.dangling', `workspace ${workspace.id} names unknown tab ${tabId}`))
        continue
      }
      if (tab.workspaceId !== workspace.id) {
        problems.push(V('tab.wrong_workspace', `tab ${tabId} says it belongs to ${tab.workspaceId}`))
      }
    }
    if (!seenTabs.has(workspace.activeTabId)) {
      problems.push(V('tab.active_not_in_workspace', `workspace ${workspace.id} is active on ${workspace.activeTabId}`))
    }
  }
  for (const [id, tab] of state.tabs) {
    if (tab.id !== id) problems.push(V('tab.key_mismatch', `tab keyed ${id} calls itself ${tab.id}`))
    if (!tabOwner.has(id)) problems.push(V('tab.orphan', `tab ${id} is in no workspace`))
  }

  // --- panes and layouts ---------------------------------------------------
  const paneOwner = new Map<string, string>()
  for (const tab of state.tabs.values()) {
    const ids = paneIds(tab.layout)
    if (ids.length === 0) problems.push(V('tab.empty_layout', `tab ${tab.id} has no panes`))
    const seenPanes = new Set<string>()
    for (const paneId of ids) {
      if (seenPanes.has(paneId)) {
        problems.push(V('pane.duplicate_in_layout', `pane ${paneId} appears twice in tab ${tab.id}`))
      }
      seenPanes.add(paneId)
      const previous = paneOwner.get(paneId)
      if (previous !== undefined && previous !== tab.id) {
        problems.push(V('pane.shared', `pane ${paneId} is in tabs ${previous} and ${tab.id}`))
      }
      paneOwner.set(paneId, tab.id)
      if (!state.panes.has(paneId)) {
        problems.push(V('pane.dangling', `tab ${tab.id} lays out unknown pane ${paneId}`))
      }
    }
    if (!seenPanes.has(tab.focusedPaneId)) {
      problems.push(V('pane.focus_dangling', `tab ${tab.id} is focused on ${tab.focusedPaneId}, which it does not contain`))
    }
    problems.push(...checkLayout(tab.layout, tab.id))
  }
  for (const [id, pane] of state.panes) {
    if (pane.id !== id) problems.push(V('pane.key_mismatch', `pane keyed ${id} calls itself ${pane.id}`))
    if (!paneOwner.has(id)) problems.push(V('pane.orphan', `pane ${id} is in no layout`))
    if (pane.scrollOffset < 0 || !Number.isInteger(pane.scrollOffset)) {
      problems.push(V('pane.bad_scroll', `pane ${id} has scrollOffset ${pane.scrollOffset}`))
    }
  }

  // --- session bindings ----------------------------------------------------
  const sessions = new Map<string, string>()
  for (const pane of state.panes.values()) {
    if (pane.sessionId === null) continue
    const previous = sessions.get(pane.sessionId)
    if (previous !== undefined) {
      problems.push(V('pane.shared_session', `session ${pane.sessionId} is bound to panes ${previous} and ${pane.id}`))
    }
    sessions.set(pane.sessionId, pane.id)
  }

  // --- agent state ---------------------------------------------------------
  // `agent` and `agentStatus` are one fact in two fields, so every reader would
  // otherwise need its own rule for the half-set case. There isn't one: a pane with an
  // agent has a status, a pane without one has neither.
  for (const pane of state.panes.values()) {
    if (pane.agent === null && pane.agentStatus !== null) {
      problems.push(V('pane.agent_status_without_agent', `pane ${pane.id} has status ${pane.agentStatus} and no agent`))
    }
    if (pane.agent !== null && pane.agentStatus === null) {
      problems.push(V('pane.agent_without_status', `pane ${pane.id} has agent ${pane.agent} and no status`))
    }
    if (pane.agent === null && pane.agentSessionId !== null) {
      problems.push(V('pane.agent_session_without_agent', `pane ${pane.id} has an agent session and no agent`))
    }
  }

  // --- public numbers ------------------------------------------------------
  for (const workspace of state.workspaces.values()) {
    const tabNumbers = state.tabsOf(workspace.id).map((tab) => tab.number)
    if (!isOneToN(tabNumbers)) {
      problems.push(V('tab.bad_numbers', `workspace ${workspace.id} tab numbers are ${tabNumbers.join(',')}`))
    }
    const paneNumbers = state.panesOf(workspace.id).map((pane) => pane.number)
    if (!isOneToN(paneNumbers)) {
      problems.push(V('pane.bad_numbers', `workspace ${workspace.id} pane numbers are ${paneNumbers.join(',')}`))
    }
  }
  const workspaceNumbers = state.orderedWorkspaces().map((workspace) => workspace.number)
  if (!isOneToN(workspaceNumbers)) {
    problems.push(V('workspace.bad_numbers', `workspace numbers are ${workspaceNumbers.join(',')}`))
  }

  return problems
}

function checkLayout(node: LayoutNode, tabId: string): Violation[] {
  if (node.kind === 'pane') return []
  const problems: Violation[] = []
  if (!(node.ratio >= MIN_RATIO && node.ratio <= MAX_RATIO)) {
    problems.push(V('layout.bad_ratio', `tab ${tabId} has a split at ratio ${node.ratio}`))
  }
  problems.push(...checkLayout(node.first, tabId), ...checkLayout(node.second, tabId))
  return problems
}

/** Numbers must be exactly 1..n in the order they were collected. */
function isOneToN(numbers: readonly number[]): boolean {
  return numbers.every((value, index) => value === index + 1)
}

export class InvariantError extends Error {
  constructor(readonly violations: readonly Violation[]) {
    super(`AppState invariants violated:\n  ${violations.map((v) => `${v.code}: ${v.message}`).join('\n  ')}`)
    this.name = 'InvariantError'
  }
}

/** herdr's `assert_invariants_for_test()`. Throws with every violation, not just one. */
export function assertInvariants(state: AppState): void {
  const problems = checkInvariants(state)
  if (problems.length > 0) throw new InvariantError(problems)
}
