import { describe, expect, it } from 'vitest'
import { ADVERSARIAL_CASES, adversarialIdentityState, healthyState } from './adversarial.js'
import { applyAction } from './actions.js'
import { CounterIds } from './ids.js'
import { InvariantError, assertInvariants, checkInvariants } from './invariants.js'
import { AppState } from './state.js'

describe('the invariant checker', () => {
  it('passes a healthy state', () => {
    expect(checkInvariants(healthyState())).toEqual([])
  })

  it('passes a freshly bootstrapped state', () => {
    expect(checkInvariants(AppState.testWithWorkspace({ ids: new CounterIds() }))).toEqual([])
  })

  /**
   * herdr's `test_with_adversarial_identity_state()`, one case at a time. The point is
   * not that these states arise today — most cannot — but that a refactor which makes
   * one arise is caught here rather than three actions later as a missing pane.
   */
  it.each(ADVERSARIAL_CASES.map((entry) => [entry.name, entry] as const))('catches %s', (_name, entry) => {
    const problems = checkInvariants(entry.build())
    expect(problems.map((problem) => problem.code)).toContain(entry.code)
  })

  it('reports every violation at once rather than the first', () => {
    const problems = checkInvariants(adversarialIdentityState())
    const codes = new Set(problems.map((problem) => problem.code))
    expect(codes.has('pane.orphan')).toBe(true)
    expect(codes.has('pane.focus_dangling')).toBe(true)
    expect(codes.has('focus.active_workspace_dangling')).toBe(true)
    expect(codes.has('tab.dangling')).toBe(true)
  })

  it('assertInvariants throws with all of them in the message', () => {
    let thrown: unknown
    try {
      assertInvariants(adversarialIdentityState())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(InvariantError)
    expect((thrown as InvariantError).violations.length).toBeGreaterThan(1)
    expect((thrown as InvariantError).message).toContain('pane.orphan')
  })

  /**
   * The real regression guard: a long random walk of actions, checked after every step.
   * Any sequence that can corrupt identity shows up here without anyone predicting it.
   */
  it('survives a thousand random actions', () => {
    const state = AppState.testWithWorkspace({ ids: new CounterIds() })
    let seed = 12345
    const random = (): number => {
      // xorshift, so the walk is reproducible and this test never flakes.
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      return Math.abs(seed) / 0x7fffffff
    }
    const pick = <T,>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(random() * items.length) % items.length]

    for (let step = 0; step < 1000; step++) {
      const panes = [...state.panes.keys()]
      const tabs = [...state.tabs.keys()]
      const workspaces = [...state.workspaces.keys()]
      // An emptied session is a legal state — closing the last workspace ends it — but
      // a walk that stays empty proves nothing, so refill it and carry on.
      if (state.workspaceOrder.length === 0) {
        applyAction(state, { type: 'workspace.create' })
        expect(checkInvariants(state), `after refilling at step ${step}`).toEqual([])
        continue
      }
      const roll = Math.floor(random() * 14)
      const paneId = pick(panes)
      const tabId = pick(tabs)
      const workspaceId = pick(workspaces)

      switch (roll) {
        case 0:
          applyAction(state, { type: 'pane.split', direction: random() < 0.5 ? 'right' : 'down' })
          break
        case 1:
          if (paneId) applyAction(state, { type: 'pane.close', paneId })
          break
        case 2:
          if (paneId) applyAction(state, { type: 'pane.focus', paneId })
          break
        case 3:
          applyAction(state, { type: 'pane.focus_direction', direction: 'left' })
          break
        case 4:
          applyAction(state, { type: 'pane.zoom' })
          break
        case 5:
          applyAction(state, { type: 'pane.resize', direction: 'right' })
          break
        case 6:
          applyAction(state, { type: 'pane.swap', direction: 'down' })
          break
        case 7:
          applyAction(state, { type: 'tab.create' })
          break
        case 8:
          if (tabId) applyAction(state, { type: 'tab.close', tabId })
          break
        case 9:
          if (tabId) applyAction(state, { type: 'tab.focus', tabId })
          break
        case 10:
          applyAction(state, { type: 'workspace.create' })
          break
        case 11:
          if (workspaceId) applyAction(state, { type: 'workspace.close', workspaceId })
          break
        case 12:
          if (workspaceId) {
            applyAction(state, { type: 'workspace.move', workspaceId, insertIndex: Math.floor(random() * 4) })
          }
          break
        default:
          if (tabId) applyAction(state, { type: 'tab.move', tabId, insertIndex: Math.floor(random() * 4) })
      }

      const problems = checkInvariants(state)
      expect(problems, `after step ${step} (roll ${roll})`).toEqual([])
    }
    // The walk must actually have built something, or it proved nothing.
    expect(state.revision).toBeGreaterThan(100)
  })
})
