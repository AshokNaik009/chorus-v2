/**
 * Save and restore the session model.
 *
 * Ported in shape from herdr's `src/persist/snapshot.rs` (Apache-2.0, herdr 3f2a6e74):
 * a versioned document of workspaces, each holding tabs, each holding a layout tree and
 * a pane table.
 *
 * ## What is *not* saved
 *
 * Runtime session ids. A restored pane is deliberately unbound (`sessionId: null`) and
 * the caller rebinds it, because the daemon that wrote the file may be gone and its
 * session ids meaningless. `restoreState` reports every pane it restored, in order, so
 * a caller can rebind or respawn each one; PHASE-4 criterion 3's "live PTYs reattached"
 * is that rebinding step, and it belongs to the runtime, not to `core`.
 *
 * ## Tolerance
 *
 * Restore never throws on a damaged document. It repairs what it can — dropping a
 * layout entry with no pane record, re-pointing a dangling focus, dropping an empty
 * workspace — and returns what it repaired. A crash-truncated file should cost the user
 * the damaged tab, not their whole session, and a restored state must satisfy
 * `assertInvariants` or the repair was not a repair.
 */

import { paneIds, paneNode, splitNode, clampRatio, type LayoutNode } from './layout-tree.js'
import { CounterIds, type IdSource } from './ids.js'
import { createPane, type RightClickTarget } from './pane.js'
import { createTab } from './tab.js'
import { createWorkspace } from './workspace.js'
import { AppState } from './state.js'

export const SNAPSHOT_VERSION = 1

export interface PersistedPane {
  readonly id: string
  readonly cwd: string
  readonly label?: string | null
  readonly command?: string | null
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly rightClick?: RightClickTarget
  /**
   * Which agent last ran here.
   *
   * The *status* is deliberately not persisted. A daemon that restarted took every PTY
   * with it, so the agent that was `working` is not working now — writing that down
   * would restore a lie that stays on screen until the next poll. The agent's name is
   * worth keeping because it survives being true: this is the pane you were running
   * claude in, and the detector will confirm it within a tick.
   */
  readonly agent?: string | null
}

export type PersistedLayout =
  | { readonly type: 'pane'; readonly paneId: string }
  | {
      readonly type: 'split'
      readonly direction: 'horizontal' | 'vertical'
      readonly ratio: number
      readonly first: PersistedLayout
      readonly second: PersistedLayout
    }

export interface PersistedTab {
  readonly id: string
  readonly label?: string | null
  readonly layout: PersistedLayout
  readonly focusedPaneId: string
  readonly zoomed?: boolean
  readonly panes: readonly PersistedPane[]
}

export interface PersistedWorkspace {
  readonly id: string
  readonly label?: string | null
  readonly cwd: string
  readonly activeTabId: string
  readonly tabs: readonly PersistedTab[]
}

export interface PersistedState {
  readonly version: number
  readonly workspaces: readonly PersistedWorkspace[]
  readonly activeWorkspaceId: string | null
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export function serializeState(state: AppState): PersistedState {
  return {
    version: SNAPSHOT_VERSION,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.orderedWorkspaces().map((workspace) => ({
      id: workspace.id,
      label: workspace.label,
      cwd: workspace.cwd,
      activeTabId: workspace.activeTabId,
      tabs: state.tabsOf(workspace.id).map((tab) => ({
        id: tab.id,
        label: tab.label,
        layout: serializeLayout(tab.layout),
        focusedPaneId: tab.focusedPaneId,
        zoomed: tab.zoomed,
        panes: paneIds(tab.layout).flatMap((paneId) => {
          const pane = state.panes.get(paneId)
          if (!pane) return []
          return [
            {
              id: pane.id,
              cwd: pane.cwd,
              label: pane.label,
              command: pane.command,
              args: pane.args,
              env: pane.env,
              rightClick: pane.rightClick,
              agent: pane.agent
            } satisfies PersistedPane
          ]
        })
      }))
    }))
  }
}

function serializeLayout(node: LayoutNode): PersistedLayout {
  if (node.kind === 'pane') return { type: 'pane', paneId: node.id }
  return {
    type: 'split',
    direction: node.direction,
    ratio: node.ratio,
    first: serializeLayout(node.first),
    second: serializeLayout(node.second)
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** A restored pane, with everything the runtime needs to bring it back to life. */
export interface RestoredPane {
  readonly paneId: string
  readonly cwd: string
  readonly command: string | null
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

export interface RestoreResult {
  readonly state: AppState
  /** Panes to rebind or respawn, in the order they were restored. */
  readonly panes: readonly RestoredPane[]
  /** What had to be repaired. Empty when the document was intact. */
  readonly repairs: readonly string[]
}

export interface RestoreOptions {
  readonly ids?: IdSource
  readonly defaultCwd?: string
  readonly now?: () => number
}

export interface RestoreBehaviour {
  /**
   * Create a workspace when the document yields none.
   *
   * On by default, because a caller that asked to restore a session usually wants one.
   * The daemon turns it off: a daemon with no session file has no session, and the
   * first client decides what its first pane runs.
   */
  readonly bootstrapWhenEmpty?: boolean
}

/**
 * Rebuild an `AppState` from a document.
 *
 * Ids are preserved, so a pane that was `p7` is `p7` again and a client's saved focus
 * still resolves. The `CounterIds` default is bumped past every id it sees, so the next
 * pane created after a restore cannot collide with a restored one.
 */
export function restoreState(
  document: unknown,
  options: RestoreOptions = {},
  behaviour: RestoreBehaviour = {}
): RestoreResult {
  const bootstrapWhenEmpty = behaviour.bootstrapWhenEmpty ?? true
  const repairs: string[] = []
  const ids = options.ids ?? new CounterIds()
  const state = new AppState({
    ids,
    ...(options.defaultCwd === undefined ? {} : { defaultCwd: options.defaultCwd }),
    ...(options.now === undefined ? {} : { now: options.now })
  })
  const spawn: RestoredPane[] = []

  const parsed = parseDocument(document, repairs)
  if (parsed === null) {
    repairs.push('document unreadable; started a fresh session')
    if (!bootstrapWhenEmpty) return { state, panes: [], repairs }
    const created = state.bootstrap()
    return {
      state,
      panes: [{ paneId: created.pane.id, cwd: created.pane.cwd, command: null, args: [], env: {} }],
      repairs
    }
  }

  for (const workspaceDoc of parsed.workspaces) {
    const tabs: string[] = []
    for (const tabDoc of workspaceDoc.tabs) {
      const paneRecords = new Map<string, PersistedPane>()
      for (const paneDoc of tabDoc.panes) paneRecords.set(paneDoc.id, paneDoc)

      const layout = reviveLayout(tabDoc.layout, paneRecords, repairs, tabDoc.id)
      if (layout === null) {
        repairs.push(`tab ${tabDoc.id} had no restorable pane and was dropped`)
        continue
      }
      const present = paneIds(layout)
      for (const paneId of present) {
        const doc = paneRecords.get(paneId)
        if (!doc) continue
        if (state.panes.has(paneId)) {
          repairs.push(`pane ${paneId} appeared twice and the later copy was dropped`)
          continue
        }
        const pane = createPane({
          id: paneId,
          cwd: doc.cwd,
          createdAt: state.now(),
          label: doc.label ?? null,
          command: doc.command ?? null,
          args: doc.args ?? [],
          env: doc.env ?? {}
        })
        pane.rightClick = doc.rightClick ?? 'app'
        // The name comes back; the status does not. A restored pane has a brand new
        // PTY, so `unknown` is the only honest status until the detector polls.
        pane.agent = doc.agent ?? null
        pane.agentStatus = pane.agent === null ? null : 'unknown'
        state.panes.set(paneId, pane)
        spawn.push({ paneId, cwd: pane.cwd, command: pane.command, args: pane.args, env: pane.env })
        if (ids instanceof CounterIds) ids.reserve(paneId)
      }
      // Drop layout entries whose pane record is gone, rather than keeping a tree that
      // points at nothing.
      const pruned = pruneLayout(layout, (id) => state.panes.has(id))
      if (pruned === null) {
        repairs.push(`tab ${tabDoc.id} lost every pane and was dropped`)
        continue
      }

      let focus = tabDoc.focusedPaneId
      if (!paneIds(pruned).includes(focus)) {
        focus = paneIds(pruned)[0] as string
        repairs.push(`tab ${tabDoc.id} had a dangling focus, moved to ${focus}`)
      }
      const tab = createTab({
        id: tabDoc.id,
        workspaceId: workspaceDoc.id,
        layout: pruned,
        focusedPaneId: focus,
        createdAt: state.now(),
        label: tabDoc.label ?? null
      })
      tab.zoomed = (tabDoc.zoomed ?? false) && paneIds(pruned).length > 1
      state.tabs.set(tab.id, tab)
      tabs.push(tab.id)
      if (ids instanceof CounterIds) ids.reserve(tab.id)
    }

    if (tabs.length === 0) {
      repairs.push(`workspace ${workspaceDoc.id} had no restorable tab and was dropped`)
      continue
    }
    let activeTabId = workspaceDoc.activeTabId
    if (!tabs.includes(activeTabId)) {
      activeTabId = tabs[0] as string
      repairs.push(`workspace ${workspaceDoc.id} pointed at a missing active tab, moved to ${activeTabId}`)
    }
    const workspace = createWorkspace({
      id: workspaceDoc.id,
      cwd: workspaceDoc.cwd,
      activeTabId,
      tabIds: tabs,
      createdAt: state.now(),
      label: workspaceDoc.label ?? null
    })
    state.workspaces.set(workspace.id, workspace)
    state.workspaceOrder.push(workspace.id)
    if (ids instanceof CounterIds) ids.reserve(workspace.id)
  }

  if (state.workspaceOrder.length === 0) {
    if (bootstrapWhenEmpty) {
      repairs.push('no workspace survived restore; started a fresh session')
      const created = state.bootstrap()
      spawn.push({ paneId: created.pane.id, cwd: created.pane.cwd, command: null, args: [], env: {} })
    }
  } else {
    state.activeWorkspaceId =
      parsed.activeWorkspaceId !== null && state.workspaces.has(parsed.activeWorkspaceId)
        ? parsed.activeWorkspaceId
        : (state.workspaceOrder[0] as string)
  }

  state.renumberWorkspaces()
  for (const id of state.workspaceOrder) state.renumberWorkspace(id)
  return { state, panes: spawn, repairs }
}

function reviveLayout(
  doc: PersistedLayout,
  panes: Map<string, PersistedPane>,
  repairs: string[],
  tabId: string
): LayoutNode | null {
  if (doc.type === 'pane') {
    if (!panes.has(doc.paneId)) {
      repairs.push(`tab ${tabId} laid out pane ${doc.paneId}, which has no record`)
      return null
    }
    return paneNode(doc.paneId)
  }
  const first = reviveLayout(doc.first, panes, repairs, tabId)
  const second = reviveLayout(doc.second, panes, repairs, tabId)
  if (first === null) return second
  if (second === null) return first
  return splitNode(doc.direction, clampRatio(doc.ratio), first, second)
}

function pruneLayout(node: LayoutNode, keep: (id: string) => boolean): LayoutNode | null {
  if (node.kind === 'pane') return keep(node.id) ? node : null
  const first = pruneLayout(node.first, keep)
  const second = pruneLayout(node.second, keep)
  if (first === null) return second
  if (second === null) return first
  return splitNode(node.direction, node.ratio, first, second)
}

// ---------------------------------------------------------------------------
// Parsing an untrusted document
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDocument(value: unknown, repairs: string[]): PersistedState | null {
  if (!isRecord(value)) return null
  const version = typeof value['version'] === 'number' ? value['version'] : 0
  if (version !== SNAPSHOT_VERSION) {
    repairs.push(`snapshot version ${version} is not ${SNAPSHOT_VERSION}; read as best effort`)
  }
  const rawWorkspaces = Array.isArray(value['workspaces']) ? value['workspaces'] : []
  const workspaces: PersistedWorkspace[] = []
  for (const raw of rawWorkspaces) {
    const workspace = parseWorkspace(raw, repairs)
    if (workspace) workspaces.push(workspace)
  }
  return {
    version: SNAPSHOT_VERSION,
    workspaces,
    activeWorkspaceId: typeof value['activeWorkspaceId'] === 'string' ? value['activeWorkspaceId'] : null
  }
}

function parseWorkspace(value: unknown, repairs: string[]): PersistedWorkspace | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    repairs.push('a workspace entry had no id and was dropped')
    return null
  }
  const rawTabs = Array.isArray(value['tabs']) ? value['tabs'] : []
  const tabs: PersistedTab[] = []
  for (const raw of rawTabs) {
    const tab = parseTab(raw, repairs)
    if (tab) tabs.push(tab)
  }
  return {
    id: value['id'],
    label: typeof value['label'] === 'string' ? value['label'] : null,
    cwd: typeof value['cwd'] === 'string' ? value['cwd'] : '/',
    activeTabId: typeof value['activeTabId'] === 'string' ? value['activeTabId'] : (tabs[0]?.id ?? ''),
    tabs
  }
}

function parseTab(value: unknown, repairs: string[]): PersistedTab | null {
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    repairs.push('a tab entry had no id and was dropped')
    return null
  }
  const layout = parseLayout(value['layout'])
  if (layout === null) {
    repairs.push(`tab ${value['id']} had an unreadable layout and was dropped`)
    return null
  }
  const panes: PersistedPane[] = []
  for (const raw of Array.isArray(value['panes']) ? value['panes'] : []) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') continue
    panes.push({
      id: raw['id'],
      cwd: typeof raw['cwd'] === 'string' ? raw['cwd'] : '/',
      label: typeof raw['label'] === 'string' ? raw['label'] : null,
      command: typeof raw['command'] === 'string' ? raw['command'] : null,
      args: Array.isArray(raw['args']) ? raw['args'].map((arg) => String(arg)) : [],
      env: isRecord(raw['env']) ? (Object.fromEntries(Object.entries(raw['env']).map(([k, v]) => [k, String(v)])) as Record<string, string>) : {},
      rightClick: raw['rightClick'] === 'pane' ? 'pane' : 'app',
      agent: typeof raw['agent'] === 'string' && raw['agent'].length > 0 ? raw['agent'] : null
    })
  }
  return {
    id: value['id'],
    label: typeof value['label'] === 'string' ? value['label'] : null,
    layout,
    focusedPaneId: typeof value['focusedPaneId'] === 'string' ? value['focusedPaneId'] : '',
    zoomed: value['zoomed'] === true,
    panes
  }
}

function parseLayout(value: unknown): PersistedLayout | null {
  if (!isRecord(value)) return null
  if (value['type'] === 'pane') {
    return typeof value['paneId'] === 'string' ? { type: 'pane', paneId: value['paneId'] } : null
  }
  if (value['type'] !== 'split') return null
  const first = parseLayout(value['first'])
  const second = parseLayout(value['second'])
  if (first === null || second === null) return null
  return {
    type: 'split',
    direction: value['direction'] === 'vertical' ? 'vertical' : 'horizontal',
    ratio: typeof value['ratio'] === 'number' ? value['ratio'] : 0.5,
    first,
    second
  }
}
