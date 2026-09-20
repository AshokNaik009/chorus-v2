/**
 * Arbitration: when the hook, the screen and the process table disagree.
 *
 * Uses the real bundled claude manifest for the screen half, but only through inputs
 * whose meaning is structural — an empty screen matches nothing, a screen carrying the
 * permission-prompt controls matches the blocker rule. The point under test is which
 * source wins, not whether claude still draws that prompt.
 */

import { describe, expect, it } from 'vitest'
import { AgentDetector, HOOK_AUTHORITY_MS, type HookReport, type PaneDetectionInput } from './detector.js'
import { buildProcessIndex, parseProcessRows } from './process-table.js'

const SHELL_PID = 900

const withAgent = buildProcessIndex(
  parseProcessRows(
    ['  900     1   900   950 -bash', '  950   900   950   950 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'].join('\n')
  )
)

const withoutAgent = buildProcessIndex(parseProcessRows('  900     1   900   900 -bash'))

/** A screen carrying claude's bash-permission controls: a visible blocker. */
const BLOCKED_SCREEN = [
  'Bash(rm -rf build)',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. Yes, and don\'t ask again',
  '  3. No',
  'esc to cancel'
].join('\n')

function detector(now = () => 10_000): AgentDetector {
  return new AgentDetector({ now })
}

function input(partial: Partial<PaneDetectionInput> = {}): PaneDetectionInput {
  return { shellPid: SHELL_PID, screen: '', ...partial }
}

const hook = (state: HookReport['state'], receivedAtMs: number): HookReport => ({
  agent: 'claude',
  state,
  seq: 1,
  receivedAtMs
})

describe('identifying the agent', () => {
  it('finds it through a generic runtime in the foreground group', () => {
    // `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js` is how it actually runs; argv[0] alone misses it.
    const result = detector().classify(withAgent, input())
    expect(result.agent).toBe('claude')
  })

  it('reports nothing for a pane sitting at a bare shell', () => {
    const result = detector().classify(withoutAgent, input())
    expect(result).toEqual({ agent: null, status: null, source: null, skipped: false })
  })

  it('has no verdict for a pane with no session', () => {
    expect(detector().classify(withAgent, input({ shellPid: null })).agent).toBeNull()
  })
})

describe('done', () => {
  it('is what an agent that exited looks like, and the pane keeps its name', () => {
    // No screen can express this: an exited agent and an idle one show the same
    // transcript. The process table is the only witness.
    const result = detector().classify(
      withoutAgent,
      input({ previousAgent: 'claude', previousStatus: 'working' })
    )
    expect(result).toEqual({ agent: 'claude', status: 'done', source: 'process', skipped: false })
  })

  it('is not claimed for a pane that never ran an agent', () => {
    expect(detector().classify(withoutAgent, input()).status).toBeNull()
  })
})

describe('hook authority', () => {
  it('beats the screen while it is current', () => {
    // The screen would say idle (nothing matches); the hook says working and wins.
    const result = detector().classify(withAgent, input({ hook: hook('working', 10_000) }))
    expect(result).toEqual({ agent: 'claude', status: 'working', source: 'hook', skipped: false })
  })

  it('lapses once it is stale, rather than pinning a crashed agent at working', () => {
    const now = 10_000 + HOOK_AUTHORITY_MS + 1
    const result = detector(() => now).classify(withAgent, input({ hook: hook('working', 10_000) }))
    expect(result.source).toBe('screen')
    expect(result.status).toBe('idle')
  })

  it('is ignored when it is about a different agent', () => {
    const stray: HookReport = { agent: 'codex', state: 'working', seq: 1, receivedAtMs: 10_000 }
    expect(detector().classify(withAgent, input({ hook: stray })).source).toBe('screen')
  })

  it('yields to a visible blocker on screen', () => {
    // The one case where the screen overrules a live hook: a missed permission-prompt
    // event leaves a pane shown as working while it silently waits for the user.
    const result = detector().classify(
      withAgent,
      input({ screen: BLOCKED_SCREEN, hook: hook('working', 10_000) })
    )
    expect(result).toEqual({ agent: 'claude', status: 'blocked', source: 'screen', skipped: false })
  })

  it('does not yield when the hook already agrees it is blocked', () => {
    const result = detector().classify(
      withAgent,
      input({ screen: BLOCKED_SCREEN, hook: hook('blocked', 10_000) })
    )
    expect(result.source).toBe('hook')
  })
})

describe('the screen', () => {
  it('reads a blocker out of the manifest when there is no hook', () => {
    const result = detector().classify(withAgent, input({ screen: BLOCKED_SCREEN }))
    expect(result).toEqual({ agent: 'claude', status: 'blocked', source: 'screen', skipped: false })
  })

  it('falls back to idle for a running agent whose screen matches nothing', () => {
    expect(detector().classify(withAgent, input({ screen: 'just a transcript' })).status).toBe('idle')
  })

  it('keeps the previous status while a viewer screen is up', () => {
    // claude's transcript viewer sets skip_state_update: the pane must not be
    // re-read from whatever the transcript happens to contain.
    const viewer = ['showing detailed transcript', 'ctrl+o to toggle'].join('\n')
    const result = detector().classify(
      withAgent,
      input({ screen: viewer, previousAgent: 'claude', previousStatus: 'working' })
    )
    expect(result).toEqual({ agent: 'claude', status: 'working', source: 'retained', skipped: true })
  })
})

describe('an unreadable process table', () => {
  it(`keeps every pane's last verdict instead of blanking it`, () => {
    // A slow or failed `ps` must not look like every agent exiting at once.
    const result = detector().classify(null, input({ previousAgent: 'claude', previousStatus: 'blocked' }))
    expect(result).toEqual({ agent: 'claude', status: 'blocked', source: 'retained', skipped: false })
  })
})

describe('detectAll', () => {
  it('classifies many panes off one capture', async () => {
    let captures = 0
    const shared = new AgentDetector({
      now: () => 10_000,
      processTable: new (await import('./process-table.js')).ProcessTable({
        capture: async () => {
          captures += 1
          return ['  900     1   900   950 -bash', '  950   900   950   950 node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'].join('\n')
        }
      })
    })

    const panes = new Map<string, PaneDetectionInput>()
    for (let i = 0; i < 15; i++) panes.set(`p${i}`, input())

    const results = await shared.detectAll(panes)
    expect(results.size).toBe(15)
    expect([...results.values()].every((entry) => entry.agent === 'claude')).toBe(true)
    expect(captures).toBe(1)
  })

  it('returns an empty map without capturing anything', async () => {
    let captures = 0
    const { ProcessTable } = await import('./process-table.js')
    const idle = new AgentDetector({
      processTable: new ProcessTable({
        capture: async () => {
          captures += 1
          return ''
        }
      })
    })
    expect((await idle.detectAll(new Map())).size).toBe(0)
    expect(captures).toBe(0)
  })
})
