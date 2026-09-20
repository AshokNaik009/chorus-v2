import { describe, expect, it } from 'vitest'
import { applyAction } from './actions.js'
import { CounterIds } from './ids.js'
import { assertInvariants, checkInvariants } from './invariants.js'
import { SNAPSHOT_VERSION, restoreState, serializeState } from './persist.js'
import { AppState } from './state.js'

/** A three-workspace, eight-pane arrangement — PHASE-4 criterion 3's shape. */
function bigState(): AppState {
  const state = AppState.testWithWorkspace({ ids: new CounterIds(), defaultCwd: '/work' })
  // workspace 1: two tabs, the first split three ways
  applyAction(state, { type: 'pane.split', direction: 'right' })
  applyAction(state, { type: 'pane.split', direction: 'down' })
  applyAction(state, { type: 'tab.create' })
  applyAction(state, { type: 'pane.rename', paneId: 'p1', label: 'server' })
  // workspace 2: one tab, two panes
  applyAction(state, { type: 'workspace.create', label: 'docs' })
  applyAction(state, { type: 'pane.split', direction: 'right', ratio: 0.3 })
  // workspace 3: one tab, two panes, zoomed
  applyAction(state, { type: 'workspace.create', cwd: '/elsewhere' })
  applyAction(state, { type: 'pane.split', direction: 'down' })
  applyAction(state, { type: 'pane.zoom', mode: 'on' })
  applyAction(state, { type: 'workspace.focus', workspaceId: 'w1' })
  assertInvariants(state)
  return state
}

/** Everything a restore is supposed to preserve, as one comparable value. */
function structure(state: AppState) {
  return {
    order: state.workspaceOrder,
    active: state.activeWorkspaceId,
    workspaces: state.orderedWorkspaces().map((workspace) => ({
      id: workspace.id,
      label: workspace.label,
      cwd: workspace.cwd,
      number: workspace.number,
      activeTabId: workspace.activeTabId,
      tabs: state.tabsOf(workspace.id).map((tab) => ({
        id: tab.id,
        label: tab.label,
        number: tab.number,
        zoomed: tab.zoomed,
        focusedPaneId: tab.focusedPaneId,
        layout: tab.layout
      }))
    })),
    panes: [...state.panes.values()]
      .map((pane) => ({ id: pane.id, cwd: pane.cwd, label: pane.label, number: pane.number, rightClick: pane.rightClick }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }
}

describe('round trip', () => {
  it('restores a 3-workspace, 8-pane arrangement exactly', () => {
    const before = bigState()
    expect(before.workspaces.size).toBe(3)
    expect(before.panes.size).toBe(8)

    const document = JSON.parse(JSON.stringify(serializeState(before))) as unknown
    const { state: after, repairs } = restoreState(document, { defaultCwd: '/work' })

    expect(repairs).toEqual([])
    expect(structure(after)).toEqual(structure(before))
    assertInvariants(after)
  })

  it('reports every pane so the runtime can rebind it', () => {
    const before = bigState()
    const { panes } = restoreState(serializeState(before))
    expect(panes.map((pane) => pane.paneId).sort()).toEqual([...before.panes.keys()].sort())
  })

  it('does not carry runtime session ids across', () => {
    const before = bigState()
    for (const pane of before.panes.values()) pane.sessionId = `s-${pane.id}`
    const { state: after } = restoreState(serializeState(before))
    expect([...after.panes.values()].every((pane) => pane.sessionId === null)).toBe(true)
  })

  it('writes a version so a future format can tell', () => {
    expect(serializeState(bigState()).version).toBe(SNAPSHOT_VERSION)
  })

  it('bumps the id counter past restored ids, so the next pane cannot collide', () => {
    const before = bigState()
    const ids = new CounterIds()
    const { state: after } = restoreState(serializeState(before), { ids })
    applyAction(after, { type: 'pane.split', direction: 'right' })
    const created = [...after.panes.keys()].filter((id) => !before.panes.has(id))
    expect(created).toHaveLength(1)
    expect(before.panes.has(created[0] as string)).toBe(false)
    assertInvariants(after)
  })
})

describe('damaged documents', () => {
  it('starts fresh from nothing at all', () => {
    const { state, repairs, panes } = restoreState(null)
    expect(repairs[0]).toContain('unreadable')
    expect(state.workspaces.size).toBe(1)
    expect(panes).toHaveLength(1)
    assertInvariants(state)
  })

  it('drops a layout entry whose pane record is gone', () => {
    const document = JSON.parse(JSON.stringify(serializeState(bigState()))) as {
      workspaces: Array<{ tabs: Array<{ panes: unknown[] }> }>
    }
    const tab = document.workspaces[0]?.tabs[0]
    if (tab) tab.panes = tab.panes.slice(0, 1)
    const { state, repairs } = restoreState(document)
    expect(repairs.some((repair) => repair.includes('has no record'))).toBe(true)
    assertInvariants(state)
  })

  it('re-points a dangling focus', () => {
    const document = JSON.parse(JSON.stringify(serializeState(bigState()))) as {
      workspaces: Array<{ tabs: Array<{ focusedPaneId: string }> }>
    }
    const tab = document.workspaces[0]?.tabs[0]
    if (tab) tab.focusedPaneId = 'gone'
    const { state, repairs } = restoreState(document)
    expect(repairs.some((repair) => repair.includes('dangling focus'))).toBe(true)
    assertInvariants(state)
  })

  it('re-points a workspace whose active tab is missing', () => {
    const document = JSON.parse(JSON.stringify(serializeState(bigState()))) as {
      workspaces: Array<{ activeTabId: string }>
    }
    const workspace = document.workspaces[0]
    if (workspace) workspace.activeTabId = 'nope'
    const { state, repairs } = restoreState(document)
    expect(repairs.some((repair) => repair.includes('missing active tab'))).toBe(true)
    assertInvariants(state)
  })

  it('drops a workspace with no restorable tab and keeps the rest', () => {
    const document = JSON.parse(JSON.stringify(serializeState(bigState()))) as {
      workspaces: Array<{ tabs: unknown[] }>
    }
    const workspace = document.workspaces[1]
    if (workspace) workspace.tabs = []
    const { state } = restoreState(document)
    expect(state.workspaces.size).toBe(2)
    assertInvariants(state)
  })

  it('tolerates truncation at any byte of the document', () => {
    // A crash mid-write is the realistic damage, and the rule is that it costs the
    // damaged part and nothing else. Every prefix must restore to a valid state.
    const text = JSON.stringify(serializeState(bigState()))
    for (let cut = 0; cut < text.length; cut += 37) {
      let document: unknown = null
      try {
        document = JSON.parse(text.slice(0, cut)) as unknown
      } catch {
        document = null
      }
      const { state } = restoreState(document)
      expect(checkInvariants(state), `truncated at ${cut}`).toEqual([])
    }
  })

  it('drops the later copy of a pane that appears twice', () => {
    const document = JSON.parse(JSON.stringify(serializeState(bigState()))) as {
      workspaces: Array<{ tabs: Array<{ panes: Array<{ id: string }> }> }>
    }
    const tab = document.workspaces[0]?.tabs[0]
    const first = tab?.panes[0]
    if (tab && first) tab.panes.push({ ...first })
    const { state } = restoreState(document)
    assertInvariants(state)
  })

  it('reads an unknown version as best effort and says so', () => {
    const document = { ...serializeState(bigState()), version: 99 }
    const { repairs, state } = restoreState(document)
    expect(repairs[0]).toContain('99')
    expect(state.panes.size).toBe(8)
  })
})

describe('agent state across a restart', () => {
  it('brings the agent name back and refuses to bring its status back', () => {
    const state = AppState.testWithWorkspace({ ids: new CounterIds() })
    applyAction(state, {
      type: 'runtime.pane_agent',
      paneId: 'p1',
      agent: 'claude',
      status: 'working',
      agentSessionId: 'sess-1'
    })

    const restored = restoreState(serializeState(state), { ids: new CounterIds() })
    const pane = restored.state.panes.get('p1')

    // The daemon that restarted took the PTY with it, so nothing is working now.
    // Restoring `working` would put a lie on screen until the next poll corrected it.
    expect(pane?.agent).toBe('claude')
    expect(pane?.agentStatus).toBe('unknown')
    expect(pane?.agentSessionId).toBeNull()
    assertInvariants(restored.state)
  })

  it('leaves a pane that never ran an agent alone', () => {
    const state = AppState.testWithWorkspace({ ids: new CounterIds() })
    const restored = restoreState(serializeState(state), { ids: new CounterIds() })
    const pane = restored.state.panes.get('p1')
    expect(pane?.agent).toBeNull()
    expect(pane?.agentStatus).toBeNull()
  })

  it('tolerates a document written before panes had agents', () => {
    const document = serializeState(AppState.testWithWorkspace({ ids: new CounterIds() })) as unknown as {
      workspaces: { tabs: { panes: Record<string, unknown>[] }[] }[]
    }
    for (const workspace of document.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) delete pane['agent']
      }
    }
    const restored = restoreState(document, { ids: new CounterIds() })
    expect(restored.repairs).toEqual([])
    expect(restored.state.panes.get('p1')?.agent).toBeNull()
  })
})
