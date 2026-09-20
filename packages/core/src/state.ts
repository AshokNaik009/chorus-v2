/**
 * `AppState` — the whole session, as data.
 *
 * No PTYs, no sockets, no terminal. Everything a multiplexer knows about how its
 * workspaces, tabs and panes are arranged lives here, and every test of that knowledge
 * builds one with `AppState.testNew()` and never spawns a process. This is herdr's
 * `AppState` rule, and PHASE-4's first structural requirement.
 *
 * ## Mutation style
 *
 * The state is mutated in place, and the *actions* are the pure layer: `applyAction`
 * takes a state and an action, changes the state deterministically, and returns the
 * effects the runtime should carry out. It does not rebuild the state.
 *
 * That is a deliberate departure from a persistent-data-structure reducer, for one
 * measured reason: this object is read on the render path, once per frame per visible
 * pane, and is written by every keystroke that moves focus. Cloning three maps per
 * keystroke buys immutability nobody consumes — nothing here keeps an old state — at a
 * cost the render loop pays. What the reducer shape is actually for is testability and
 * determinism, and both survive: `applyAction` has no I/O, no clock, no randomness, and
 * no reference to anything outside the state it is handed.
 *
 * `revision` increments on every accepted mutation, so a client can tell whether the
 * snapshot it holds is current without comparing trees.
 */

import { CounterIds, type IdSource } from './ids.js'
import { createPane, type Pane } from './pane.js'
import { createTab, type Tab } from './tab.js'
import { createWorkspace, type Workspace } from './workspace.js'
import { paneIds, paneNode, type LayoutNode } from './layout-tree.js'

export interface AppStateOptions {
  readonly ids: IdSource
  /** Where a workspace with no explicit cwd starts. */
  readonly defaultCwd?: string
  /** Injected so state carries no clock of its own. */
  readonly now?: () => number
}

export class AppState {
  readonly workspaces = new Map<string, Workspace>()
  readonly tabs = new Map<string, Tab>()
  readonly panes = new Map<string, Pane>()
  /** Workspace display order. The sidebar reads this; nothing else may reorder it. */
  workspaceOrder: string[] = []
  activeWorkspaceId: string | null = null
  revision = 0

  readonly ids: IdSource
  readonly defaultCwd: string
  readonly now: () => number

  constructor(options: AppStateOptions) {
    this.ids = options.ids
    this.defaultCwd = options.defaultCwd ?? '/'
    this.now = options.now ?? (() => 0)
  }

  /**
   * An empty state with deterministic ids and a frozen clock.
   *
   * herdr's `AppState::test_new()`. Everything a test needs and nothing it does not:
   * no workspace exists yet, so a test that wants one says so.
   */
  static testNew(options: Partial<AppStateOptions> = {}): AppState {
    return new AppState({
      ids: options.ids ?? new CounterIds(),
      defaultCwd: options.defaultCwd ?? '/tmp',
      now: options.now ?? (() => 0)
    })
  }

  /** A state with one workspace, one tab, one pane — what a fresh daemon boots into. */
  static testWithWorkspace(options: Partial<AppStateOptions> = {}): AppState {
    const state = AppState.testNew(options)
    state.bootstrap()
    return state
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  get activeWorkspace(): Workspace | null {
    return this.activeWorkspaceId === null ? null : (this.workspaces.get(this.activeWorkspaceId) ?? null)
  }

  get activeTab(): Tab | null {
    const workspace = this.activeWorkspace
    if (!workspace) return null
    return this.tabs.get(workspace.activeTabId) ?? null
  }

  get focusedPane(): Pane | null {
    const tab = this.activeTab
    if (!tab) return null
    return this.panes.get(tab.focusedPaneId) ?? null
  }

  get focusedPaneId(): string | null {
    return this.activeTab?.focusedPaneId ?? null
  }

  /** The tab a pane belongs to, or null when the pane is not in any layout. */
  tabOfPane(paneId: string): Tab | null {
    for (const tab of this.tabs.values()) {
      if (paneIds(tab.layout).includes(paneId)) return tab
    }
    return null
  }

  workspaceOfPane(paneId: string): Workspace | null {
    const tab = this.tabOfPane(paneId)
    if (!tab) return null
    return this.workspaces.get(tab.workspaceId) ?? null
  }

  tabsOf(workspaceId: string): Tab[] {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return []
    const out: Tab[] = []
    for (const id of workspace.tabIds) {
      const tab = this.tabs.get(id)
      if (tab) out.push(tab)
    }
    return out
  }

  panesOf(workspaceId: string): Pane[] {
    const out: Pane[] = []
    for (const tab of this.tabsOf(workspaceId)) {
      for (const id of paneIds(tab.layout)) {
        const pane = this.panes.get(id)
        if (pane) out.push(pane)
      }
    }
    return out
  }

  orderedWorkspaces(): Workspace[] {
    const out: Workspace[] = []
    for (const id of this.workspaceOrder) {
      const workspace = this.workspaces.get(id)
      if (workspace) out.push(workspace)
    }
    return out
  }

  /** Every pane bound to a live runtime session, for the runtime to reconcile against. */
  sessionIds(): string[] {
    const out: string[] = []
    for (const pane of this.panes.values()) {
      if (pane.sessionId !== null) out.push(pane.sessionId)
    }
    return out
  }

  paneBySessionId(sessionId: string): Pane | null {
    for (const pane of this.panes.values()) {
      if (pane.sessionId === sessionId) return pane
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * Create the first workspace, tab and pane, and focus them.
   *
   * Used at boot and whenever the last workspace closes — a state with no workspace has
   * nothing to focus and nothing to draw, so it never persists past one action.
   */
  bootstrap(cwd?: string): { workspace: Workspace; tab: Tab; pane: Pane } {
    return this.insertWorkspace({ cwd: cwd ?? this.defaultCwd, focus: true, index: this.workspaceOrder.length })
  }

  /** Add a workspace with one tab and one pane. Low-level; `actions.ts` is the API. */
  insertWorkspace(options: {
    cwd: string
    focus: boolean
    index: number
    label?: string | null
    env?: Readonly<Record<string, string>>
    command?: string | null
    args?: readonly string[]
  }): { workspace: Workspace; tab: Tab; pane: Pane } {
    const workspaceId = this.ids.next('workspace')
    const tabId = this.ids.next('tab')
    const paneId = this.ids.next('pane')

    const pane = createPane({
      id: paneId,
      cwd: options.cwd,
      createdAt: this.now(),
      ...(options.command === undefined ? {} : { command: options.command }),
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.env === undefined ? {} : { env: options.env })
    })
    const tab = createTab({
      id: tabId,
      workspaceId,
      layout: paneNode(paneId),
      focusedPaneId: paneId,
      createdAt: this.now()
    })
    const workspace = createWorkspace({
      id: workspaceId,
      cwd: options.cwd,
      activeTabId: tabId,
      createdAt: this.now(),
      ...(options.label === undefined ? {} : { label: options.label })
    })

    this.panes.set(paneId, pane)
    this.tabs.set(tabId, tab)
    this.workspaces.set(workspaceId, workspace)
    const index = Math.min(Math.max(0, Math.floor(options.index)), this.workspaceOrder.length)
    this.workspaceOrder.splice(index, 0, workspaceId)
    this.renumberWorkspaces()
    this.renumberWorkspace(workspaceId)
    if (options.focus || this.activeWorkspaceId === null) this.activeWorkspaceId = workspaceId
    return { workspace, tab, pane }
  }

  /** Public workspace numbers follow display order; ids never move. */
  renumberWorkspaces(): void {
    let n = 1
    for (const id of this.workspaceOrder) {
      const workspace = this.workspaces.get(id)
      if (workspace) workspace.number = n++
    }
  }

  /**
   * Public tab and pane numbers within one workspace.
   *
   * Recomputed from position rather than handed out from a counter: a counter drifts
   * once anything is closed, and then `prefix 3` selects a pane that is fourth on
   * screen. Tabs number in tab order; panes number across tabs in layout-tree order,
   * which is the order they are drawn.
   */
  renumberWorkspace(workspaceId: string): void {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return
    let tabNumber = 1
    let paneNumber = 1
    for (const tabId of workspace.tabIds) {
      const tab = this.tabs.get(tabId)
      if (!tab) continue
      tab.number = tabNumber++
      for (const id of paneIds(tab.layout)) {
        const pane = this.panes.get(id)
        if (pane) pane.number = paneNumber++
      }
    }
  }

  /**
   * Remove a pane from every index that mentions it.
   *
   * The layout tree is the caller's problem: this drops the record, not the position,
   * because collapsing a split is a tree operation with its own rules.
   */
  dropPane(paneId: string): Pane | null {
    const pane = this.panes.get(paneId)
    if (!pane) return null
    this.panes.delete(paneId)
    return pane
  }

  touch(): number {
    this.revision += 1
    return this.revision
  }
}
