/**
 * Every mutation, in one place.
 *
 * `applyAction(state, action)` is the only thing that changes an `AppState`. It has no
 * I/O, no clock, no randomness, and no knowledge of PTYs. When a mutation implies work
 * in the outside world — a shell to spawn, a session to kill — it says so by returning
 * an *effect*, which is data. The runtime executes effects; `core` never does.
 *
 * That is the whole reason the workspace model is testable without a terminal: a test
 * applies actions, asserts on the state and on the effects, and never waits for
 * anything.
 *
 * ## Geometry
 *
 * Three actions are geometric — `pane.focus_direction`, `pane.swap` by direction, and
 * `pane.resize` — because "the pane to the left" is a question about rectangles. The
 * client owns the real screen size, so it passes its content area as `viewport`.
 * Without one they fall back to `DEFAULT_VIEWPORT`, which is fine: ratios are relative,
 * so neighbour relations are the same at any size a terminal actually has.
 */

import type { Rect } from './geometry.js'
import type { PaneDirection } from './geometry.js'
import {
  canSplit,
  clampRatio,
  cyclePane,
  hasPane,
  neighbor,
  paneCount,
  paneIds,
  placementOf,
  removePane,
  resizeDirection,
  setSplitRatio,
  splitPane,
  swapPanes,
  type LayoutNode
} from './layout-tree.js'
import { createPane } from './pane.js'
import type { AgentStatus, RightClickTarget } from './pane.js'
import { createTab, focusPaneInTab } from './tab.js'
import type { AppState } from './state.js'

/** The reference area used when a caller supplies none. A generous terminal. */
export const DEFAULT_VIEWPORT: Rect = { x: 0, y: 0, width: 200, height: 50 }

/** herdr's `SplitDirection`: a new pane goes to the right of, or below, its source. */
export type SplitDirection = 'right' | 'down'

export type ZoomMode = 'toggle' | 'on' | 'off'

export type Action =
  | { readonly type: 'workspace.create'; readonly cwd?: string; readonly label?: string; readonly focus?: boolean; readonly env?: Readonly<Record<string, string>>; readonly sourceWorkspaceId?: string; readonly command?: string; readonly args?: readonly string[] }
  | { readonly type: 'workspace.close'; readonly workspaceId: string }
  | { readonly type: 'workspace.focus'; readonly workspaceId: string }
  | { readonly type: 'workspace.rename'; readonly workspaceId: string; readonly label: string }
  | { readonly type: 'workspace.move'; readonly workspaceId: string; readonly insertIndex: number }
  | { readonly type: 'workspace.move_block'; readonly workspaceIds: readonly string[]; readonly beforeWorkspaceId?: string }
  | { readonly type: 'tab.create'; readonly workspaceId?: string; readonly cwd?: string; readonly label?: string; readonly focus?: boolean; readonly env?: Readonly<Record<string, string>> }
  | { readonly type: 'tab.close'; readonly tabId: string }
  | { readonly type: 'tab.focus'; readonly tabId: string }
  | { readonly type: 'tab.rename'; readonly tabId: string; readonly label: string }
  | { readonly type: 'tab.move'; readonly tabId: string; readonly insertIndex: number }
  | { readonly type: 'pane.split'; readonly targetPaneId?: string; readonly direction: SplitDirection; readonly ratio?: number; readonly cwd?: string; readonly focus?: boolean; readonly env?: Readonly<Record<string, string>>; readonly command?: string; readonly args?: readonly string[] }
  | { readonly type: 'pane.close'; readonly paneId: string }
  | { readonly type: 'pane.focus'; readonly paneId: string }
  | { readonly type: 'pane.focus_direction'; readonly paneId?: string; readonly direction: PaneDirection; readonly viewport?: Rect }
  | { readonly type: 'pane.focus_next'; readonly step?: number }
  | { readonly type: 'pane.resize'; readonly paneId?: string; readonly direction: PaneDirection; readonly amount?: number; readonly viewport?: Rect }
  | { readonly type: 'pane.swap'; readonly paneId?: string; readonly direction?: PaneDirection; readonly sourcePaneId?: string; readonly targetPaneId?: string; readonly viewport?: Rect }
  | { readonly type: 'pane.zoom'; readonly paneId?: string; readonly mode?: ZoomMode }
  | { readonly type: 'pane.rename'; readonly paneId: string; readonly label?: string | null }
  | { readonly type: 'pane.scroll'; readonly paneId: string; readonly offsetFromBottom: number }
  | { readonly type: 'pane.input.set'; readonly paneId: string; readonly rightClick: RightClickTarget }
  | { readonly type: 'layout.set_split_ratio'; readonly tabId?: string; readonly paneId?: string; readonly path: readonly boolean[]; readonly ratio: number }
  // Runtime-originated facts. The runtime owns them; the state records them.
  | { readonly type: 'runtime.pane_bound'; readonly paneId: string; readonly sessionId: string }
  | { readonly type: 'runtime.pane_exited'; readonly paneId: string }
  | { readonly type: 'runtime.pane_title'; readonly paneId: string; readonly title: string }
  | {
      readonly type: 'runtime.pane_agent'
      readonly paneId: string
      readonly agent: string | null
      readonly status: AgentStatus | null
      readonly agentSessionId?: string | null
    }

export type ActionType = Action['type']

/** Work for the runtime. Effects are data, in the order they should be carried out. */
export type Effect =
  | {
      readonly type: 'spawn'
      readonly paneId: string
      readonly cwd: string
      readonly command: string | null
      readonly args: readonly string[]
      readonly env: Readonly<Record<string, string>>
    }
  /** Tear down the runtime session behind a pane that no longer exists. */
  | { readonly type: 'kill'; readonly paneId: string; readonly sessionId: string | null }

export interface ActionResult {
  readonly ok: boolean
  /** Why the action did nothing. Present exactly when `ok` is false. */
  readonly error?: string
  /** True when the state actually changed, so a no-op focus does not bump `revision`. */
  readonly changed: boolean
  readonly effects: readonly Effect[]
  /** Ids the action produced, so a caller can report them without guessing. */
  readonly created?: { readonly workspaceId?: string; readonly tabId?: string; readonly paneId?: string }
  readonly revision: number
}

function fail(state: AppState, error: string): ActionResult {
  return { ok: false, error, changed: false, effects: [], revision: state.revision }
}

function noop(state: AppState): ActionResult {
  return { ok: true, changed: false, effects: [], revision: state.revision }
}

function done(
  state: AppState,
  effects: readonly Effect[] = [],
  created?: ActionResult['created']
): ActionResult {
  state.touch()
  return {
    ok: true,
    changed: true,
    effects,
    ...(created === undefined ? {} : { created }),
    revision: state.revision
  }
}

export function applyAction(state: AppState, action: Action): ActionResult {
  switch (action.type) {
    case 'workspace.create':
      return workspaceCreate(state, action)
    case 'workspace.close':
      return workspaceClose(state, action)
    case 'workspace.focus':
      return workspaceFocus(state, action)
    case 'workspace.rename':
      return workspaceRename(state, action)
    case 'workspace.move':
      return workspaceMove(state, action)
    case 'workspace.move_block':
      return workspaceMoveBlock(state, action)
    case 'tab.create':
      return tabCreate(state, action)
    case 'tab.close':
      return tabClose(state, action)
    case 'tab.focus':
      return tabFocus(state, action)
    case 'tab.rename':
      return tabRename(state, action)
    case 'tab.move':
      return tabMove(state, action)
    case 'pane.split':
      return paneSplit(state, action)
    case 'pane.close':
      return paneClose(state, action)
    case 'pane.focus':
      return paneFocus(state, action)
    case 'pane.focus_direction':
      return paneFocusDirection(state, action)
    case 'pane.focus_next':
      return paneFocusNext(state, action)
    case 'pane.resize':
      return paneResize(state, action)
    case 'pane.swap':
      return paneSwap(state, action)
    case 'pane.zoom':
      return paneZoom(state, action)
    case 'pane.rename':
      return paneRename(state, action)
    case 'pane.scroll':
      return paneScroll(state, action)
    case 'pane.input.set':
      return paneInputSet(state, action)
    case 'layout.set_split_ratio':
      return layoutSetSplitRatio(state, action)
    case 'runtime.pane_bound':
      return runtimePaneBound(state, action)
    case 'runtime.pane_exited':
      return runtimePaneExited(state, action)
    case 'runtime.pane_title':
      return runtimePaneTitle(state, action)
    case 'runtime.pane_agent':
      return runtimePaneAgent(state, action)
  }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function workspaceCreate(state: AppState, action: Extract<Action, { type: 'workspace.create' }>): ActionResult {
  const source = action.sourceWorkspaceId ?? state.activeWorkspaceId
  const inherited = source === null ? null : (state.workspaces.get(source)?.cwd ?? null)
  const cwd = action.cwd ?? inherited ?? state.defaultCwd
  const created = state.insertWorkspace({
    cwd,
    focus: action.focus ?? true,
    index: state.workspaceOrder.length,
    ...(action.label === undefined ? {} : { label: action.label }),
    ...(action.env === undefined ? {} : { env: action.env }),
    ...(action.command === undefined ? {} : { command: action.command }),
    ...(action.args === undefined ? {} : { args: action.args })
  })
  return done(
    state,
    [
      {
        type: 'spawn',
        paneId: created.pane.id,
        cwd: created.pane.cwd,
        command: created.pane.command,
        args: created.pane.args,
        env: created.pane.env
      }
    ],
    { workspaceId: created.workspace.id, tabId: created.tab.id, paneId: created.pane.id }
  )
}

function workspaceClose(state: AppState, action: Extract<Action, { type: 'workspace.close' }>): ActionResult {
  const workspace = state.workspaces.get(action.workspaceId)
  if (!workspace) return fail(state, `no workspace ${action.workspaceId}`)

  const effects: Effect[] = []
  for (const tabId of [...workspace.tabIds]) {
    const tab = state.tabs.get(tabId)
    if (!tab) continue
    for (const paneId of paneIds(tab.layout)) {
      const pane = state.dropPane(paneId)
      if (pane) effects.push({ type: 'kill', paneId, sessionId: pane.sessionId })
    }
    state.tabs.delete(tabId)
  }
  state.workspaces.delete(workspace.id)
  const index = state.workspaceOrder.indexOf(workspace.id)
  if (index >= 0) state.workspaceOrder.splice(index, 1)
  state.renumberWorkspaces()

  if (state.activeWorkspaceId === workspace.id) {
    // Focus the workspace that slid into the closed one's place, else the last.
    const next = state.workspaceOrder[Math.min(index, state.workspaceOrder.length - 1)]
    state.activeWorkspaceId = next ?? null
  }
  // Closing the last workspace empties the session rather than conjuring a new one.
  // That is what makes `prefix q` and "close the last pane" the same gesture: the
  // client sees a model with no panes and exits, the way tmux's last window does.
  return done(state, effects)
}

function workspaceFocus(state: AppState, action: Extract<Action, { type: 'workspace.focus' }>): ActionResult {
  if (!state.workspaces.has(action.workspaceId)) return fail(state, `no workspace ${action.workspaceId}`)
  if (state.activeWorkspaceId === action.workspaceId) return noop(state)
  state.activeWorkspaceId = action.workspaceId
  return done(state)
}

function workspaceRename(state: AppState, action: Extract<Action, { type: 'workspace.rename' }>): ActionResult {
  const workspace = state.workspaces.get(action.workspaceId)
  if (!workspace) return fail(state, `no workspace ${action.workspaceId}`)
  const label = action.label.length === 0 ? null : action.label
  if (workspace.label === label) return noop(state)
  workspace.label = label
  return done(state)
}

function workspaceMove(state: AppState, action: Extract<Action, { type: 'workspace.move' }>): ActionResult {
  const index = state.workspaceOrder.indexOf(action.workspaceId)
  if (index < 0) return fail(state, `no workspace ${action.workspaceId}`)
  const target = Math.min(Math.max(0, Math.floor(action.insertIndex)), state.workspaceOrder.length - 1)
  if (target === index) return noop(state)
  state.workspaceOrder.splice(index, 1)
  state.workspaceOrder.splice(target, 0, action.workspaceId)
  state.renumberWorkspaces()
  return done(state)
}

/**
 * Move several workspaces at once, keeping their relative order.
 *
 * herdr's `workspace.move_block` exists because dragging a worktree group has to move
 * its members together; splitting it into N `workspace.move` calls would interleave
 * them with whatever sat between. `beforeWorkspaceId` names the workspace the block
 * lands in front of; absent, the block goes to the end.
 */
function workspaceMoveBlock(
  state: AppState,
  action: Extract<Action, { type: 'workspace.move_block' }>
): ActionResult {
  const moving = action.workspaceIds.filter((id) => state.workspaceOrder.includes(id))
  if (moving.length === 0) return fail(state, 'no known workspace in block')
  if (action.beforeWorkspaceId !== undefined && moving.includes(action.beforeWorkspaceId)) {
    return fail(state, 'anchor is inside the moving block')
  }
  const rest = state.workspaceOrder.filter((id) => !moving.includes(id))
  const anchor = action.beforeWorkspaceId === undefined ? -1 : rest.indexOf(action.beforeWorkspaceId)
  if (action.beforeWorkspaceId !== undefined && anchor < 0) {
    return fail(state, `no workspace ${action.beforeWorkspaceId}`)
  }
  const next = anchor < 0 ? [...rest, ...moving] : [...rest.slice(0, anchor), ...moving, ...rest.slice(anchor)]
  if (next.every((id, i) => state.workspaceOrder[i] === id)) return noop(state)
  state.workspaceOrder = next
  state.renumberWorkspaces()
  return done(state)
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function tabCreate(state: AppState, action: Extract<Action, { type: 'tab.create' }>): ActionResult {
  const workspaceId = action.workspaceId ?? state.activeWorkspaceId
  if (workspaceId === null) return fail(state, 'no active workspace')
  const workspace = state.workspaces.get(workspaceId)
  if (!workspace) return fail(state, `no workspace ${workspaceId}`)

  const cwd = action.cwd ?? state.panes.get(state.tabs.get(workspace.activeTabId)?.focusedPaneId ?? '')?.cwd ?? workspace.cwd
  const tabId = state.ids.next('tab')
  const paneId = state.ids.next('pane')
  const pane = createPane({
    id: paneId,
    cwd,
    createdAt: state.now(),
    ...(action.env === undefined ? {} : { env: action.env })
  })
  const tab = createTab({
    id: tabId,
    workspaceId,
    layout: { kind: 'pane', id: paneId },
    focusedPaneId: paneId,
    createdAt: state.now(),
    ...(action.label === undefined ? {} : { label: action.label })
  })
  state.panes.set(paneId, pane)
  state.tabs.set(tabId, tab)
  workspace.tabIds.push(tabId)
  if (action.focus ?? true) {
    workspace.activeTabId = tabId
    state.activeWorkspaceId = workspaceId
  }
  state.renumberWorkspace(workspaceId)
  return done(
    state,
    [{ type: 'spawn', paneId, cwd, command: pane.command, args: pane.args, env: pane.env }],
    { workspaceId, tabId, paneId }
  )
}

function tabClose(state: AppState, action: Extract<Action, { type: 'tab.close' }>): ActionResult {
  const tab = state.tabs.get(action.tabId)
  if (!tab) return fail(state, `no tab ${action.tabId}`)
  const workspace = state.workspaces.get(tab.workspaceId)
  if (!workspace) return fail(state, `tab ${action.tabId} has no workspace`)

  // The last tab of a workspace closes the workspace: a workspace with no tab has no
  // active tab, which is the one thing the invariants will not allow.
  if (workspace.tabIds.length <= 1) {
    return workspaceClose(state, { type: 'workspace.close', workspaceId: workspace.id })
  }

  const effects: Effect[] = []
  for (const paneId of paneIds(tab.layout)) {
    const pane = state.dropPane(paneId)
    if (pane) effects.push({ type: 'kill', paneId, sessionId: pane.sessionId })
  }
  const index = workspace.tabIds.indexOf(tab.id)
  workspace.tabIds.splice(index, 1)
  state.tabs.delete(tab.id)
  if (workspace.activeTabId === tab.id) {
    const next = workspace.tabIds[Math.min(index, workspace.tabIds.length - 1)]
    if (next !== undefined) workspace.activeTabId = next
  }
  state.renumberWorkspace(workspace.id)
  return done(state, effects)
}

function tabFocus(state: AppState, action: Extract<Action, { type: 'tab.focus' }>): ActionResult {
  const tab = state.tabs.get(action.tabId)
  if (!tab) return fail(state, `no tab ${action.tabId}`)
  const workspace = state.workspaces.get(tab.workspaceId)
  if (!workspace) return fail(state, `tab ${action.tabId} has no workspace`)
  if (workspace.activeTabId === tab.id && state.activeWorkspaceId === workspace.id) return noop(state)
  workspace.activeTabId = tab.id
  state.activeWorkspaceId = workspace.id
  return done(state)
}

function tabRename(state: AppState, action: Extract<Action, { type: 'tab.rename' }>): ActionResult {
  const tab = state.tabs.get(action.tabId)
  if (!tab) return fail(state, `no tab ${action.tabId}`)
  const label = action.label.length === 0 ? null : action.label
  if (tab.label === label) return noop(state)
  tab.label = label
  return done(state)
}

function tabMove(state: AppState, action: Extract<Action, { type: 'tab.move' }>): ActionResult {
  const tab = state.tabs.get(action.tabId)
  if (!tab) return fail(state, `no tab ${action.tabId}`)
  const workspace = state.workspaces.get(tab.workspaceId)
  if (!workspace) return fail(state, `tab ${action.tabId} has no workspace`)
  const index = workspace.tabIds.indexOf(tab.id)
  const target = Math.min(Math.max(0, Math.floor(action.insertIndex)), workspace.tabIds.length - 1)
  if (index < 0 || target === index) return noop(state)
  workspace.tabIds.splice(index, 1)
  workspace.tabIds.splice(target, 0, tab.id)
  state.renumberWorkspace(workspace.id)
  return done(state)
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function resolvePane(state: AppState, paneId: string | undefined): string | null {
  if (paneId !== undefined) return state.panes.has(paneId) ? paneId : null
  return state.focusedPaneId
}

function paneSplit(state: AppState, action: Extract<Action, { type: 'pane.split' }>): ActionResult {
  const targetId = resolvePane(state, action.targetPaneId)
  if (targetId === null) return fail(state, 'no pane to split')
  const tab = state.tabOfPane(targetId)
  if (!tab) return fail(state, `pane ${targetId} is not in a layout`)
  const workspace = state.workspaces.get(tab.workspaceId)
  if (!workspace) return fail(state, `tab ${tab.id} has no workspace`)

  const direction = action.direction === 'right' ? 'horizontal' : 'vertical'
  const source = state.panes.get(targetId)
  const cwd = action.cwd ?? source?.cwd ?? workspace.cwd
  const paneId = state.ids.next('pane')
  const pane = createPane({
    id: paneId,
    cwd,
    createdAt: state.now(),
    ...(action.command === undefined ? {} : { command: action.command }),
    ...(action.args === undefined ? {} : { args: action.args }),
    ...(action.env === undefined ? {} : { env: action.env })
  })

  const next = splitPane(tab.layout, targetId, direction, paneId, action.ratio ?? 0.5)
  if (next === tab.layout) return fail(state, `pane ${targetId} is not in tab ${tab.id}`)
  tab.layout = next
  state.panes.set(paneId, pane)
  // A split is a layout change, and a zoom hides every pane but one; keeping the zoom
  // would put the new pane somewhere the user cannot see it.
  tab.zoomed = false
  if (action.focus ?? true) {
    focusPaneInTab(tab, paneId)
    workspace.activeTabId = tab.id
    state.activeWorkspaceId = workspace.id
  }
  state.renumberWorkspace(workspace.id)
  return done(
    state,
    [{ type: 'spawn', paneId, cwd, command: pane.command, args: pane.args, env: pane.env }],
    { workspaceId: workspace.id, tabId: tab.id, paneId }
  )
}

/** True when the pane is big enough to divide at all, given a reference area. */
export function canSplitPane(state: AppState, paneId: string, direction: SplitDirection, viewport: Rect = DEFAULT_VIEWPORT): boolean {
  const tab = state.tabOfPane(paneId)
  if (!tab) return false
  const area = placementOf(tab.layout, paneId, viewport)
  if (!area) return false
  return canSplit(area, direction === 'right' ? 'horizontal' : 'vertical')
}

function paneClose(state: AppState, action: Extract<Action, { type: 'pane.close' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  const tab = state.tabOfPane(action.paneId)
  if (!tab) return fail(state, `pane ${action.paneId} is not in a layout`)

  // The last pane of a tab closes the tab, which may in turn close the workspace.
  if (paneCount(tab.layout) <= 1) {
    return tabClose(state, { type: 'tab.close', tabId: tab.id })
  }

  const next = removePane(tab.layout, action.paneId)
  if (next === null) return fail(state, 'refusing to empty a layout')
  tab.layout = next
  state.dropPane(action.paneId)
  if (tab.focusedPaneId === action.paneId) {
    // Back where the user was, not to whichever pane happens to be first in the tree.
    const remembered = tab.previousFocusedPaneId
    tab.focusedPaneId =
      remembered !== null && hasPane(next, remembered) ? remembered : (paneIds(next)[0] as string)
    tab.previousFocusedPaneId = null
  }
  if (tab.previousFocusedPaneId !== null && !hasPane(next, tab.previousFocusedPaneId)) {
    tab.previousFocusedPaneId = null
  }
  // Zoom is a claim that other panes are hidden. With the focus gone from the tree, or
  // with one pane left, it is no longer true and a client would draw a ZOOM badge over
  // a pane that fills the tab anyway.
  if (tab.zoomed && (paneCount(next) <= 1 || !hasPane(next, tab.focusedPaneId))) tab.zoomed = false
  state.renumberWorkspace(tab.workspaceId)
  return done(state, [{ type: 'kill', paneId: action.paneId, sessionId: pane.sessionId }])
}

function paneFocus(state: AppState, action: Extract<Action, { type: 'pane.focus' }>): ActionResult {
  const tab = state.tabOfPane(action.paneId)
  if (!tab) return fail(state, `no pane ${action.paneId}`)
  const workspace = state.workspaces.get(tab.workspaceId)
  if (!workspace) return fail(state, `tab ${tab.id} has no workspace`)
  if (
    tab.focusedPaneId === action.paneId &&
    workspace.activeTabId === tab.id &&
    state.activeWorkspaceId === workspace.id
  ) {
    return noop(state)
  }
  focusPaneInTab(tab, action.paneId)
  workspace.activeTabId = tab.id
  state.activeWorkspaceId = workspace.id
  return done(state)
}

function paneFocusDirection(
  state: AppState,
  action: Extract<Action, { type: 'pane.focus_direction' }>
): ActionResult {
  const from = resolvePane(state, action.paneId)
  if (from === null) return fail(state, 'no pane to move from')
  const tab = state.tabOfPane(from)
  if (!tab) return fail(state, `pane ${from} is not in a layout`)
  // A zoomed tab shows one pane; moving focus to a pane nobody can see is not a move.
  if (tab.zoomed) return noop(state)
  const target = neighbor(tab.layout, from, action.direction, action.viewport ?? DEFAULT_VIEWPORT)
  if (target === null) return noop(state)
  return paneFocus(state, { type: 'pane.focus', paneId: target })
}

function paneFocusNext(state: AppState, action: Extract<Action, { type: 'pane.focus_next' }>): ActionResult {
  const tab = state.activeTab
  if (!tab) return fail(state, 'no active tab')
  const target = cyclePane(tab.layout, tab.focusedPaneId, action.step ?? 1)
  if (target === null || target === tab.focusedPaneId) return noop(state)
  return paneFocus(state, { type: 'pane.focus', paneId: target })
}

/** How much one `pane.resize` step moves a divider when the caller names no amount. */
export const DEFAULT_RESIZE_AMOUNT = 0.05

function paneResize(state: AppState, action: Extract<Action, { type: 'pane.resize' }>): ActionResult {
  const target = resolvePane(state, action.paneId)
  if (target === null) return fail(state, 'no pane to resize')
  const tab = state.tabOfPane(target)
  if (!tab) return fail(state, `pane ${target} is not in a layout`)
  const amount = action.amount ?? DEFAULT_RESIZE_AMOUNT
  const next = resizeDirection(tab.layout, target, action.direction, amount)
  if (next === tab.layout) return noop(state)
  tab.layout = next
  return done(state)
}

function paneSwap(state: AppState, action: Extract<Action, { type: 'pane.swap' }>): ActionResult {
  const source = resolvePane(state, action.sourcePaneId ?? action.paneId)
  if (source === null) return fail(state, 'no pane to swap')
  const tab = state.tabOfPane(source)
  if (!tab) return fail(state, `pane ${source} is not in a layout`)

  let target = action.targetPaneId ?? null
  if (target === null && action.direction !== undefined) {
    target = neighbor(tab.layout, source, action.direction, action.viewport ?? DEFAULT_VIEWPORT)
  }
  if (target === null) return noop(state)
  if (!hasPane(tab.layout, target)) return fail(state, `pane ${target} is not in tab ${tab.id}`)
  if (target === source) return noop(state)

  const next = swapPanes(tab.layout, source, target)
  if (next === tab.layout) return noop(state)
  tab.layout = next
  state.renumberWorkspace(tab.workspaceId)
  // Focus follows the pane, not the position: the user swapped a pane, not their gaze.
  focusPaneInTab(tab, source)
  return done(state)
}

function paneZoom(state: AppState, action: Extract<Action, { type: 'pane.zoom' }>): ActionResult {
  const target = resolvePane(state, action.paneId)
  if (target === null) return fail(state, 'no pane to zoom')
  const tab = state.tabOfPane(target)
  if (!tab) return fail(state, `pane ${target} is not in a layout`)
  const mode = action.mode ?? 'toggle'
  const wantZoom = mode === 'toggle' ? !(tab.zoomed && tab.focusedPaneId === target) : mode === 'on'
  // One pane fills the tab whether or not it is zoomed; saying so would be a lie a
  // client then has to draw a ZOOM badge for.
  if (wantZoom && paneCount(tab.layout) <= 1) return noop(state)
  if (tab.zoomed === wantZoom && tab.focusedPaneId === target) return noop(state)
  tab.zoomed = wantZoom
  if (wantZoom) focusPaneInTab(tab, target)
  return done(state)
}

function paneRename(state: AppState, action: Extract<Action, { type: 'pane.rename' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  const label = action.label === undefined || action.label === null || action.label.length === 0 ? null : action.label
  if (pane.label === label) return noop(state)
  pane.label = label
  return done(state)
}

function paneScroll(state: AppState, action: Extract<Action, { type: 'pane.scroll' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  const offset = Math.max(0, Math.floor(action.offsetFromBottom))
  if (pane.scrollOffset === offset) return noop(state)
  pane.scrollOffset = offset
  return done(state)
}

function paneInputSet(state: AppState, action: Extract<Action, { type: 'pane.input.set' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  if (pane.rightClick === action.rightClick) return noop(state)
  pane.rightClick = action.rightClick
  return done(state)
}

function layoutSetSplitRatio(
  state: AppState,
  action: Extract<Action, { type: 'layout.set_split_ratio' }>
): ActionResult {
  const tab =
    action.tabId !== undefined
      ? (state.tabs.get(action.tabId) ?? null)
      : action.paneId !== undefined
        ? state.tabOfPane(action.paneId)
        : state.activeTab
  if (!tab) return fail(state, 'no tab')
  const next = setSplitRatio(tab.layout, action.path, action.ratio)
  if (next === tab.layout) {
    // Distinguish "already at that ratio" from "there is no split there": the first is
    // a no-op, the second is a caller bug worth reporting.
    return splitExistsAt(tab.layout, action.path) ? noop(state) : fail(state, 'no split at that path')
  }
  tab.layout = next
  return done(state)
}

function splitExistsAt(node: LayoutNode, path: readonly boolean[]): boolean {
  let current = node
  for (const step of path) {
    if (current.kind !== 'split') return false
    current = step ? current.second : current.first
  }
  return current.kind === 'split'
}

// ---------------------------------------------------------------------------
// Runtime facts
// ---------------------------------------------------------------------------

function runtimePaneBound(state: AppState, action: Extract<Action, { type: 'runtime.pane_bound' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  if (pane.sessionId === action.sessionId) return noop(state)
  pane.sessionId = action.sessionId
  pane.exited = false
  return done(state)
}

function runtimePaneExited(state: AppState, action: Extract<Action, { type: 'runtime.pane_exited' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  if (pane.exited) return noop(state)
  pane.exited = true
  return done(state)
}

function runtimePaneTitle(state: AppState, action: Extract<Action, { type: 'runtime.pane_title' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)
  if (pane.title === action.title) return noop(state)
  pane.title = action.title
  return done(state)
}

/**
 * Record what the detector saw.
 *
 * Runs on a poll for every pane, so the no-change path matters: an unchanged verdict
 * returns `noop` and does *not* bump the revision. Otherwise fifteen panes polling
 * twice a second would broadcast thirty `state.changed` events a second to every
 * attached client, each of which answers with a `state.get`, for a session where
 * nothing happened.
 *
 * `agent` and `agentStatus` move together: a pane with an agent always has a status,
 * and a pane without one never does. `assertInvariants` checks it.
 */
function runtimePaneAgent(state: AppState, action: Extract<Action, { type: 'runtime.pane_agent' }>): ActionResult {
  const pane = state.panes.get(action.paneId)
  if (!pane) return fail(state, `no pane ${action.paneId}`)

  const agent = action.agent
  const status = agent === null ? null : (action.status ?? 'unknown')
  const sessionId = action.agentSessionId === undefined ? pane.agentSessionId : action.agentSessionId
  if (pane.agent === agent && pane.agentStatus === status && pane.agentSessionId === sessionId) {
    return noop(state)
  }

  pane.agent = agent
  pane.agentStatus = status
  pane.agentSessionId = agent === null ? null : sessionId
  return done(state)
}

/** Clamp a ratio the way the layout tree does. Re-exported for callers validating input. */
export { clampRatio }
