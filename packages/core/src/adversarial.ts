/**
 * Deliberately broken states, for testing the invariant checker.
 *
 * herdr's `AppState::test_with_adversarial_identity_state()`. The point is not that
 * these states can arise today — most cannot — but that a refactor which *makes* one
 * arise should be caught by `checkInvariants`, and the only way to know the checker
 * would catch it is to hand it one on purpose.
 *
 * Each builder returns a state with exactly one class of damage, named by the invariant
 * code it should trip. `ADVERSARIAL_CASES` enumerates them so a test can loop.
 */

import { applyAction } from './actions.js'
import { CounterIds } from './ids.js'
import { paneNode, splitNode } from './layout-tree.js'
import { createPane } from './pane.js'
import { createTab } from './tab.js'
import { AppState } from './state.js'

/** A healthy two-workspace state: workspace 1 has two tabs, one of them split. */
export function healthyState(): AppState {
  const state = AppState.testWithWorkspace({ ids: new CounterIds() })
  applyAction(state, { type: 'pane.split', direction: 'right' })
  applyAction(state, { type: 'tab.create' })
  applyAction(state, { type: 'workspace.create' })
  applyAction(state, { type: 'workspace.focus', workspaceId: 'w1' })
  return state
}

export interface AdversarialCase {
  readonly name: string
  /** The invariant code this damage must trip. */
  readonly code: string
  build(): AppState
}

export const ADVERSARIAL_CASES: readonly AdversarialCase[] = [
  {
    name: 'a pane laid out in two tabs',
    code: 'pane.shared',
    build() {
      const state = healthyState()
      const [a, b] = [...state.tabs.values()]
      if (a && b) b.layout = paneNode(a.focusedPaneId)
      return state
    }
  },
  {
    name: 'a pane record in no layout',
    code: 'pane.orphan',
    build() {
      const state = healthyState()
      state.panes.set('ghost', createPane({ id: 'ghost', cwd: '/tmp' }))
      return state
    }
  },
  {
    name: 'focus on a pane the tab does not contain',
    code: 'pane.focus_dangling',
    build() {
      const state = healthyState()
      const tab = [...state.tabs.values()][0]
      if (tab) tab.focusedPaneId = 'nope'
      return state
    }
  },
  {
    name: 'a layout naming a pane with no record',
    code: 'pane.dangling',
    build() {
      const state = healthyState()
      const tab = [...state.tabs.values()][0]
      if (tab) tab.layout = splitNode('horizontal', 0.5, paneNode(tab.focusedPaneId), paneNode('vanished'))
      return state
    }
  },
  {
    name: 'a workspace with no tabs',
    code: 'workspace.empty',
    build() {
      const state = healthyState()
      const workspace = [...state.workspaces.values()][0]
      if (workspace) workspace.tabIds = []
      return state
    }
  },
  {
    name: 'a workspace active on another workspace’s tab',
    code: 'tab.active_not_in_workspace',
    build() {
      const state = healthyState()
      const [first, second] = state.orderedWorkspaces()
      if (first && second) first.activeTabId = second.activeTabId
      return state
    }
  },
  {
    name: 'an active workspace id that does not exist',
    code: 'focus.active_workspace_dangling',
    build() {
      const state = healthyState()
      state.activeWorkspaceId = 'w999'
      return state
    }
  },
  {
    name: 'a workspace listed twice in the display order',
    code: 'workspace.duplicate_order',
    build() {
      const state = healthyState()
      const first = state.workspaceOrder[0]
      if (first !== undefined) state.workspaceOrder.push(first)
      return state
    }
  },
  {
    name: 'a workspace record missing from the display order',
    code: 'workspace.unordered',
    build() {
      const state = healthyState()
      state.workspaceOrder.pop()
      return state
    }
  },
  {
    name: 'a tab in no workspace',
    code: 'tab.orphan',
    build() {
      const state = healthyState()
      state.tabs.set(
        'stray',
        createTab({ id: 'stray', workspaceId: 'w1', layout: paneNode('p1'), focusedPaneId: 'p1' })
      )
      return state
    }
  },
  {
    name: 'two panes bound to one runtime session',
    code: 'pane.shared_session',
    build() {
      const state = healthyState()
      const panes = [...state.panes.values()]
      for (const pane of panes.slice(0, 2)) pane.sessionId = 's-same'
      return state
    }
  },
  {
    name: 'public pane numbers that skip',
    code: 'pane.bad_numbers',
    build() {
      const state = healthyState()
      const pane = [...state.panes.values()][0]
      if (pane) pane.number = 7
      return state
    }
  },
  {
    name: 'a split ratio outside its bounds',
    code: 'layout.bad_ratio',
    build() {
      const state = healthyState()
      for (const tab of state.tabs.values()) {
        if (tab.layout.kind === 'split') {
          tab.layout = splitNode(tab.layout.direction, 1.5, tab.layout.first, tab.layout.second)
          break
        }
      }
      return state
    }
  },
  {
    name: 'a pane with a status and no agent',
    code: 'pane.agent_status_without_agent',
    build() {
      const state = healthyState()
      const pane = [...state.panes.values()][0]
      // The shape a detector that cleared `agent` without clearing `status` leaves
      // behind. It renders as a badge for an agent that is not there.
      if (pane) pane.agentStatus = 'working'
      return state
    }
  },
  {
    name: 'a pane with an agent and no status',
    code: 'pane.agent_without_status',
    build() {
      const state = healthyState()
      const pane = [...state.panes.values()][0]
      if (pane) pane.agent = 'claude'
      return state
    }
  }
]

/** One state carrying every kind of damage at once, for the checker's "report all" path. */
export function adversarialIdentityState(): AppState {
  const state = healthyState()
  state.panes.set('ghost', createPane({ id: 'ghost', cwd: '/tmp' }))
  const tab = [...state.tabs.values()][0]
  if (tab) tab.focusedPaneId = 'nope'
  state.activeWorkspaceId = 'w999'
  const workspace = [...state.workspaces.values()][0]
  if (workspace) workspace.tabIds = [...workspace.tabIds, 'missing-tab']
  return state
}
