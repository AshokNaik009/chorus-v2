/**
 * Agent-state notifications.
 *
 * Drives the real app through a fake daemon, because the question these answer is
 * whether a transition produces a notification at all — reading the reducer cannot
 * tell you that, and nothing else in the suite covers it.
 *
 * `LEAP_CHORUS_DISABLE_SOUND` is set for the whole file: a test suite must not spawn
 * `afplay`, and with playback off the app falls back to the bell, which is assertable
 * through `options.write`. The fallback itself is therefore under test too.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@leap-chorus/core'
import type { DaemonClient } from '@leap-chorus/daemon'
import type { PaneRecord, SessionStateSnapshot, WireAgentStatus } from '@leap-chorus/protocol'
import { TuiApp } from './app.js'
import { canPlay, soundPath } from './sound.js'

const BEL = '\u0007'

process.env['LEAP_CHORUS_DISABLE_SOUND'] = '1'

function pane(paneId: string, status: WireAgentStatus | null): PaneRecord {
  return {
    paneId,
    sessionId: null,
    number: 1,
    label: null,
    title: null,
    cwd: '/',
    exited: false,
    rightClick: 'app',
    scrollOffset: 0,
    agent: 'claude',
    agentStatus: status
  }
}

function snapshot(revision: number, panes: readonly PaneRecord[]): SessionStateSnapshot {
  return {
    revision,
    workspaces: [{ workspaceId: 'w1', number: 1, label: null, cwd: '/', tabIds: ['t1'], activeTabId: 't1' }],
    workspaceOrder: ['w1'],
    tabs: [
      {
        tabId: 't1',
        workspaceId: 'w1',
        number: 1,
        label: null,
        layout: { type: 'pane', paneId: panes[0]!.paneId },
        focusedPaneId: panes[0]!.paneId,
        zoomed: false
      }
    ],
    panes,
    activeWorkspaceId: 'w1',
    focusedPaneId: panes[0]!.paneId
  }
}

/** Start the app on `first`, then hand it `second`, and return everything written. */
async function transition(from: WireAgentStatus, to: WireAgentStatus, config: Config = DEFAULT_CONFIG) {
  let state = snapshot(1, [pane('p1', from)])
  const written: string[] = []
  const client = {
    call: async (method: string) => {
      if (method === 'state.get') return { state }
      return {}
    },
    onEvent: () => () => {}
  } as unknown as DaemonClient

  const app = await TuiApp.start({
    client,
    cols: 80,
    rows: 24,
    write: (data) => written.push(data),
    config,
    autoRender: false
  })
  written.length = 0
  state = snapshot(2, [pane('p1', to)])
  await (app as unknown as { refreshState(): Promise<void> }).refreshState()
  return written.join('')
}

describe('the notification sounds', () => {
  it('ships an audio file for each kind', () => {
    expect(soundPath('done')).not.toBeNull()
    expect(soundPath('blocked')).not.toBeNull()
  })

  it('falls back to a bundled file when a configured path does not exist', () => {
    expect(soundPath('done', '/nope/missing.mp3')).toBe(soundPath('done'))
  })

  it('expands a leading ~ in a configured path', () => {
    // Not a real file, so it falls back — the point is that it did not resolve to a
    // directory literally named `~`, which is what `resolve` alone would have done.
    expect(soundPath('done', '~/definitely-not-here.mp3')).toBe(soundPath('done'))
  })

  it('is disabled by the environment variable', () => {
    expect(canPlay('darwin')).toBe(false)
  })
})

describe('the agent bell', () => {
  it('rings when an agent becomes blocked', async () => {
    expect(await transition('working', 'blocked')).toContain(BEL)
  })

  it('rings when an agent finishes a turn', async () => {
    expect(await transition('working', 'idle')).toContain(BEL)
  })

  it('rings when an agent goes straight from idle to blocked', async () => {
    // One 750 ms detection tick can swallow the `working` in between.
    expect(await transition('idle', 'blocked')).toContain(BEL)
  })

  it('rings when an agent exits after a turn', async () => {
    expect(await transition('working', 'done')).toContain(BEL)
  })

  it('stays silent when an idle agent exits', async () => {
    // Deliberate: idle -> done is the user quitting the agent, not news to them.
    expect(await transition('idle', 'done')).not.toContain(BEL)
  })

  it('stays silent when the toggles are off', async () => {
    const muted: Config = { ...DEFAULT_CONFIG, sound: { agentDone: false, agentBlocked: false } }
    expect(await transition('working', 'blocked', muted)).not.toContain(BEL)
  })
})
