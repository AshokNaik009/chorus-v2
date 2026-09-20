import { describe, expect, it } from 'vitest'
import { DEFAULT_RESIZE_AMOUNT, applyAction, type Effect } from './actions.js'
import { CounterIds } from './ids.js'
import { assertInvariants } from './invariants.js'
import { paneIds } from './layout-tree.js'
import { AppState } from './state.js'
import { toLayoutRects } from './test-helpers.js'

/**
 * Every test here runs with no PTY, no socket and no clock. That is the point of the
 * split PHASE-4 asks for: if a workspace test needs a terminal, the model is wrong.
 *
 * `assertInvariants` after each mutation is deliberate belt and braces — the checker's
 * own tests prove it catches damage, and running it here proves the actions never
 * create any.
 */
function fresh(): AppState {
  return AppState.testWithWorkspace({ ids: new CounterIds() })
}

function apply(state: AppState, action: Parameters<typeof applyAction>[1]) {
  const result = applyAction(state, action)
  assertInvariants(state)
  return result
}

function spawned(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) => (effect.type === 'spawn' ? [effect.paneId] : []))
}

function killed(effects: readonly Effect[]): string[] {
  return effects.flatMap((effect) => (effect.type === 'kill' ? [effect.paneId] : []))
}

describe('bootstrap', () => {
  it('starts with one workspace, one tab, one pane, all focused', () => {
    const state = fresh()
    assertInvariants(state)
    expect(state.workspaceOrder).toEqual(['w1'])
    expect(state.activeWorkspaceId).toBe('w1')
    expect(state.activeTab?.id).toBe('t1')
    expect(state.focusedPaneId).toBe('p1')
  })
})

describe('workspaces', () => {
  it('creating one spawns a pane and focuses it', () => {
    const state = fresh()
    const result = apply(state, { type: 'workspace.create' })
    expect(result.ok).toBe(true)
    expect(spawned(result.effects)).toEqual(['p2'])
    expect(state.activeWorkspaceId).toBe('w2')
    expect(state.workspaceOrder).toEqual(['w1', 'w2'])
  })

  it('a new workspace inherits the active one’s cwd unless told otherwise', () => {
    const state = AppState.testWithWorkspace({ ids: new CounterIds(), defaultCwd: '/start' })
    apply(state, { type: 'workspace.create' })
    expect(state.workspaces.get('w2')?.cwd).toBe('/start')
    apply(state, { type: 'workspace.create', cwd: '/elsewhere' })
    expect(state.workspaces.get('w3')?.cwd).toBe('/elsewhere')
  })

  it('closing kills every pane it held', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'workspace.create' })
    const result = apply(state, { type: 'workspace.close', workspaceId: 'w1' })
    expect(killed(result.effects).sort()).toEqual(['p1', 'p2'])
    expect(state.workspaceOrder).toEqual(['w2'])
    expect(state.panes.size).toBe(1)
  })

  /**
   * Closing the last workspace empties the session rather than conjuring another one.
   *
   * That is what makes "close the last pane" and "quit" the same gesture: the client
   * sees a model with no panes and exits, the way tmux's last window does. It is also
   * why a daemon starts empty — a session comes from a client asking for one.
   */
  it('closing the last workspace leaves the session empty', () => {
    const state = fresh()
    const result = apply(state, { type: 'workspace.close', workspaceId: 'w1' })
    expect(killed(result.effects)).toEqual(['p1'])
    expect(spawned(result.effects)).toEqual([])
    expect(state.workspaceOrder).toEqual([])
    expect(state.activeWorkspaceId).toBeNull()
    expect(state.panes.size).toBe(0)
  })

  it('an empty session accepts a new workspace and is whole again', () => {
    const state = fresh()
    apply(state, { type: 'workspace.close', workspaceId: 'w1' })
    const result = apply(state, { type: 'workspace.create' })
    expect(spawned(result.effects)).toHaveLength(1)
    expect(state.activeWorkspaceId).not.toBeNull()
    expect(state.focusedPaneId).not.toBeNull()
  })

  it('closing the active workspace focuses the one that took its place', () => {
    const state = fresh()
    apply(state, { type: 'workspace.create' })
    apply(state, { type: 'workspace.create' })
    apply(state, { type: 'workspace.focus', workspaceId: 'w2' })
    apply(state, { type: 'workspace.close', workspaceId: 'w2' })
    expect(state.activeWorkspaceId).toBe('w3')
  })

  it('renaming and clearing a name', () => {
    const state = fresh()
    apply(state, { type: 'workspace.rename', workspaceId: 'w1', label: 'api' })
    expect(state.workspaces.get('w1')?.label).toBe('api')
    apply(state, { type: 'workspace.rename', workspaceId: 'w1', label: '' })
    expect(state.workspaces.get('w1')?.label).toBeNull()
  })

  it('moving renumbers without changing ids', () => {
    const state = fresh()
    apply(state, { type: 'workspace.create' })
    apply(state, { type: 'workspace.create' })
    apply(state, { type: 'workspace.move', workspaceId: 'w3', insertIndex: 0 })
    expect(state.workspaceOrder).toEqual(['w3', 'w1', 'w2'])
    expect(state.workspaces.get('w3')?.number).toBe(1)
    expect(state.workspaces.get('w1')?.number).toBe(2)
  })

  it('move_block keeps the block’s internal order', () => {
    const state = fresh()
    for (let i = 0; i < 3; i++) apply(state, { type: 'workspace.create' })
    expect(state.workspaceOrder).toEqual(['w1', 'w2', 'w3', 'w4'])
    apply(state, { type: 'workspace.move_block', workspaceIds: ['w2', 'w4'], beforeWorkspaceId: 'w1' })
    expect(state.workspaceOrder).toEqual(['w2', 'w4', 'w1', 'w3'])
  })

  it('move_block with no anchor moves the block to the end', () => {
    const state = fresh()
    for (let i = 0; i < 2; i++) apply(state, { type: 'workspace.create' })
    apply(state, { type: 'workspace.move_block', workspaceIds: ['w1'] })
    expect(state.workspaceOrder).toEqual(['w2', 'w3', 'w1'])
  })

  it('move_block refuses an anchor inside the block', () => {
    const state = fresh()
    apply(state, { type: 'workspace.create' })
    const result = applyAction(state, {
      type: 'workspace.move_block',
      workspaceIds: ['w1', 'w2'],
      beforeWorkspaceId: 'w2'
    })
    expect(result.ok).toBe(false)
  })

  it('reports an unknown workspace rather than doing nothing quietly', () => {
    const state = fresh()
    expect(applyAction(state, { type: 'workspace.focus', workspaceId: 'nope' }).ok).toBe(false)
  })
})

describe('tabs', () => {
  it('creating a tab spawns one pane and focuses it', () => {
    const state = fresh()
    const result = apply(state, { type: 'tab.create' })
    expect(spawned(result.effects)).toEqual(['p2'])
    expect(state.workspaces.get('w1')?.tabIds).toEqual(['t1', 't2'])
    expect(state.activeTab?.id).toBe('t2')
  })

  it('a tab created with focus: false leaves focus alone', () => {
    const state = fresh()
    apply(state, { type: 'tab.create', focus: false })
    expect(state.activeTab?.id).toBe('t1')
  })

  it('closing a tab kills its panes and focuses the next one', () => {
    const state = fresh()
    apply(state, { type: 'tab.create' })
    apply(state, { type: 'pane.split', direction: 'down' })
    const result = apply(state, { type: 'tab.close', tabId: 't2' })
    expect(killed(result.effects).sort()).toEqual(['p2', 'p3'])
    expect(state.activeTab?.id).toBe('t1')
  })

  it('closing the last tab of a workspace closes the workspace', () => {
    const state = fresh()
    apply(state, { type: 'workspace.create' })
    apply(state, { type: 'tab.close', tabId: 't2' })
    expect(state.workspaces.has('w2')).toBe(false)
    expect(state.workspaceOrder).toEqual(['w1'])
  })

  it('moving a tab renumbers it', () => {
    const state = fresh()
    apply(state, { type: 'tab.create' })
    apply(state, { type: 'tab.create' })
    apply(state, { type: 'tab.move', tabId: 't3', insertIndex: 0 })
    expect(state.workspaces.get('w1')?.tabIds).toEqual(['t3', 't1', 't2'])
    expect(state.tabs.get('t3')?.number).toBe(1)
  })
})

describe('panes', () => {
  it('splitting right puts the new pane on the right and focuses it', () => {
    const state = fresh()
    const result = apply(state, { type: 'pane.split', direction: 'right' })
    expect(result.created?.paneId).toBe('p2')
    expect(state.focusedPaneId).toBe('p2')
    const rects = toLayoutRects(state)
    expect(rects.map((entry) => entry.id)).toEqual(['p1', 'p2'])
    expect(rects[1]?.rect.x).toBeGreaterThan(0)
  })

  it('splitting down stacks', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'down' })
    const rects = toLayoutRects(state)
    expect(rects[1]?.rect.y).toBeGreaterThan(0)
    expect(rects[1]?.rect.x).toBe(0)
  })

  it('a new pane inherits its source pane’s cwd', () => {
    const state = AppState.testWithWorkspace({ ids: new CounterIds(), defaultCwd: '/src' })
    apply(state, { type: 'pane.split', direction: 'right', cwd: '/other' })
    expect(state.panes.get('p2')?.cwd).toBe('/other')
    apply(state, { type: 'pane.split', direction: 'right' })
    expect(state.panes.get('p3')?.cwd).toBe('/other')
  })

  it('splitting clears zoom, so the new pane is visible', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.zoom', mode: 'on' })
    expect(state.activeTab?.zoomed).toBe(true)
    apply(state, { type: 'pane.split', direction: 'down' })
    expect(state.activeTab?.zoomed).toBe(false)
  })

  it('closing a pane returns focus to where the user was', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.split', direction: 'down' })
    // p1 -> p2 -> p3; focus is on p3, previous is p2.
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    apply(state, { type: 'pane.focus', paneId: 'p3' })
    apply(state, { type: 'pane.close', paneId: 'p3' })
    expect(state.focusedPaneId).toBe('p1')
  })

  it('closing the last pane of a tab closes the tab', () => {
    const state = fresh()
    apply(state, { type: 'tab.create' })
    apply(state, { type: 'pane.close', paneId: 'p2' })
    expect(state.tabs.has('t2')).toBe(false)
    expect(state.activeTab?.id).toBe('t1')
  })

  it('focus_direction walks the geometry', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.split', direction: 'down' })
    // p1 | p2
    //    | p3
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    apply(state, { type: 'pane.focus_direction', direction: 'right' })
    expect(state.focusedPaneId).toBe('p2')
    apply(state, { type: 'pane.focus_direction', direction: 'down' })
    expect(state.focusedPaneId).toBe('p3')
    apply(state, { type: 'pane.focus_direction', direction: 'left' })
    expect(state.focusedPaneId).toBe('p1')
  })

  it('focus_next cycles in tree order and wraps both ways', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.split', direction: 'down' })
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    apply(state, { type: 'pane.focus_next' })
    expect(state.focusedPaneId).toBe('p2')
    apply(state, { type: 'pane.focus_next' })
    expect(state.focusedPaneId).toBe('p3')
    apply(state, { type: 'pane.focus_next' })
    expect(state.focusedPaneId).toBe('p1')
    apply(state, { type: 'pane.focus_next', step: -1 })
    expect(state.focusedPaneId).toBe('p3')
  })

  it('focus_direction at an edge changes nothing', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    const result = apply(state, { type: 'pane.focus_direction', direction: 'left' })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
    expect(state.focusedPaneId).toBe('p1')
  })

  it('focus_direction does nothing while zoomed', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.zoom', mode: 'on' })
    const result = apply(state, { type: 'pane.focus_direction', direction: 'left' })
    expect(result.changed).toBe(false)
  })

  it('resize moves the divider by the default step', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    apply(state, { type: 'pane.resize', direction: 'right' })
    const layout = state.activeTab?.layout
    expect(layout?.kind).toBe('split')
    if (layout?.kind === 'split') expect(layout.ratio).toBeCloseTo(0.5 + DEFAULT_RESIZE_AMOUNT, 5)
  })

  it('swap by direction exchanges positions and keeps focus on the pane', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.focus', paneId: 'p1' })
    apply(state, { type: 'pane.swap', direction: 'right' })
    expect(paneIds(state.activeTab?.layout ?? { kind: 'pane', id: 'x' })).toEqual(['p2', 'p1'])
    expect(state.focusedPaneId).toBe('p1')
  })

  it('zoom toggles, and refuses when there is only one pane', () => {
    const state = fresh()
    expect(apply(state, { type: 'pane.zoom' }).changed).toBe(false)
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.zoom' })
    expect(state.activeTab?.zoomed).toBe(true)
    apply(state, { type: 'pane.zoom' })
    expect(state.activeTab?.zoomed).toBe(false)
  })

  it('closing a zoomed tab’s pane leaves zoom on a pane that exists', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'pane.zoom', mode: 'on' })
    apply(state, { type: 'pane.close', paneId: 'p2' })
    expect(state.activeTab?.zoomed).toBe(false)
    expect(state.focusedPaneId).toBe('p1')
  })

  it('rename, scroll and input.set record on the pane', () => {
    const state = fresh()
    apply(state, { type: 'pane.rename', paneId: 'p1', label: 'build' })
    apply(state, { type: 'pane.scroll', paneId: 'p1', offsetFromBottom: 12 })
    apply(state, { type: 'pane.input.set', paneId: 'p1', rightClick: 'pane' })
    const pane = state.panes.get('p1')
    expect(pane?.label).toBe('build')
    expect(pane?.scrollOffset).toBe(12)
    expect(pane?.rightClick).toBe('pane')
    apply(state, { type: 'pane.rename', paneId: 'p1', label: null })
    expect(state.panes.get('p1')?.label).toBeNull()
  })

  it('pane numbers stay 1..n across a workspace as panes come and go', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'tab.create' })
    apply(state, { type: 'pane.split', direction: 'right' })
    expect(state.panesOf('w1').map((pane) => pane.number)).toEqual([1, 2, 3, 4])
    apply(state, { type: 'pane.close', paneId: 'p1' })
    expect(state.panesOf('w1').map((pane) => pane.number)).toEqual([1, 2, 3])
  })
})

describe('layout.set_split_ratio', () => {
  it('addresses the divider by path', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    apply(state, { type: 'layout.set_split_ratio', path: [], ratio: 0.25 })
    const layout = state.activeTab?.layout
    if (layout?.kind === 'split') expect(layout.ratio).toBe(0.25)
  })

  it('rejects a path with no split at the end', () => {
    const state = fresh()
    expect(applyAction(state, { type: 'layout.set_split_ratio', path: [], ratio: 0.25 }).ok).toBe(false)
  })

  it('an unchanged ratio is a no-op, not a failure', () => {
    const state = fresh()
    apply(state, { type: 'pane.split', direction: 'right' })
    const result = apply(state, { type: 'layout.set_split_ratio', path: [], ratio: 0.5 })
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(false)
  })
})

describe('runtime facts', () => {
  it('binding, exiting and titling a pane', () => {
    const state = fresh()
    apply(state, { type: 'runtime.pane_bound', paneId: 'p1', sessionId: 's-1' })
    expect(state.paneBySessionId('s-1')?.id).toBe('p1')
    apply(state, { type: 'runtime.pane_title', paneId: 'p1', title: 'vim' })
    expect(state.panes.get('p1')?.title).toBe('vim')
    apply(state, { type: 'runtime.pane_exited', paneId: 'p1' })
    expect(state.panes.get('p1')?.exited).toBe(true)
  })
})

describe('revision', () => {
  it('advances only when something changed', () => {
    const state = fresh()
    const before = state.revision
    applyAction(state, { type: 'pane.focus', paneId: 'p1' })
    expect(state.revision).toBe(before)
    applyAction(state, { type: 'pane.split', direction: 'right' })
    expect(state.revision).toBe(before + 1)
  })

  it('a rejected action does not advance it', () => {
    const state = fresh()
    const before = state.revision
    applyAction(state, { type: 'pane.close', paneId: 'ghost' })
    expect(state.revision).toBe(before)
  })
})

describe('geometry is an input, not state', () => {
  /**
   * Direction-sensitive actions take a viewport because "the pane to the left" is a
   * question about rectangles, and the daemon has no screen. This pins down *why* it is
   * safe for the daemon to default one: a BSP tree's neighbour relations are the same at
   * every size a terminal has, because every split divides proportionally.
   *
   * If that ever stops being true, the default is wrong and the client must pass its
   * real area on every call rather than only where it already does.
   */
  it('gives the same neighbour at wildly different viewports', () => {
    const sizes = [
      { x: 0, y: 0, width: 20, height: 6 },
      { x: 0, y: 0, width: 200, height: 50 },
      { x: 0, y: 0, width: 400, height: 120 }
    ]
    for (const viewport of sizes) {
      const state = fresh()
      apply(state, { type: 'pane.split', direction: 'right' })
      apply(state, { type: 'pane.split', direction: 'down' })
      apply(state, { type: 'pane.focus', paneId: 'p1' })
      apply(state, { type: 'pane.focus_direction', direction: 'right', viewport })
      expect(state.focusedPaneId, `at ${viewport.width}x${viewport.height}`).toBe('p2')
      apply(state, { type: 'pane.focus_direction', direction: 'down', viewport })
      expect(state.focusedPaneId, `at ${viewport.width}x${viewport.height}`).toBe('p3')
    }
  })
})

describe('runtime.pane_agent', () => {
  it('records the agent and its status together', () => {
    const state = fresh()
    const result = apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: 'claude', status: 'working' })
    expect(result.changed).toBe(true)
    const pane = state.panes.get('p1')
    expect(pane?.agent).toBe('claude')
    expect(pane?.agentStatus).toBe('working')
  })

  /**
   * The cost that makes a poll affordable.
   *
   * This runs for every pane on every tick. If an unchanged verdict bumped the
   * revision, fifteen panes at 2 Hz would broadcast thirty `state.changed` events a
   * second, each of which every attached client answers with a `state.get` — for a
   * session in which nothing happened.
   */
  it('does not change the state when the verdict is the same', () => {
    const state = fresh()
    apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: 'claude', status: 'idle' })
    const revision = state.revision
    const again = apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: 'claude', status: 'idle' })
    expect(again.changed).toBe(false)
    expect(state.revision).toBe(revision)
  })

  it('clears the status and the session id when the agent goes away', () => {
    const state = fresh()
    apply(state, {
      type: 'runtime.pane_agent',
      paneId: 'p1',
      agent: 'claude',
      status: 'working',
      agentSessionId: 'sess-1'
    })
    apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: null, status: null })
    const pane = state.panes.get('p1')
    expect(pane?.agent).toBeNull()
    expect(pane?.agentStatus).toBeNull()
    expect(pane?.agentSessionId).toBeNull()
  })

  it('keeps the agent session id across a status change', () => {
    const state = fresh()
    apply(state, {
      type: 'runtime.pane_agent',
      paneId: 'p1',
      agent: 'claude',
      status: 'idle',
      agentSessionId: 'sess-1'
    })
    apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: 'claude', status: 'working' })
    expect(state.panes.get('p1')?.agentSessionId).toBe('sess-1')
  })

  it('never leaves an agent without a status, whatever it is told', () => {
    const state = fresh()
    apply(state, { type: 'runtime.pane_agent', paneId: 'p1', agent: 'claude', status: null })
    expect(state.panes.get('p1')?.agentStatus).toBe('unknown')
  })

  it('rejects a pane it does not have', () => {
    const state = fresh()
    const result = applyAction(state, { type: 'runtime.pane_agent', paneId: 'nope', agent: 'claude', status: 'idle' })
    expect(result.ok).toBe(false)
  })
})
