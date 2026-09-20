/**
 * The agent endpoint, against a real daemon over a real socket.
 *
 * `@leap-chorus/detect` already proves the engine; these prove the *plumbing*: that a
 * hook's report reaches the model, that a stale one does not, that a pane's agent
 * state crosses the wire, and that the explain/reload loop a human uses to fix a rule
 * actually works end to end.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_METHODS, ErrorCodes, type SessionStateSnapshot } from '@leap-chorus/protocol'
import { ManifestRegistry, ProcessTable, AgentDetector } from '@leap-chorus/detect'
import type { DaemonClient } from '../src/client.js'
import { DaemonServer } from '../src/socket.js'
import { cleanupDataRoots, connectTo, tempDataRoot, testPaths, waitUntil } from './harness.js'

let server: DaemonServer
let client: DaemonClient

beforeEach(async () => {
  server = await DaemonServer.start({ paths: testPaths(), ephemeral: true })
  ;({ client } = await connectTo(server.paths))
  await client.call('workspace.create', { focus: true })
})

afterEach(async () => {
  client.close()
  await server.close('test')
})

afterAll(() => {
  cleanupDataRoots()
})

async function firstPaneId(): Promise<string> {
  const { state } = await client.call('state.get', {})
  return (state as SessionStateSnapshot).panes[0]?.paneId as string
}

async function paneRecord(paneId: string) {
  const { state } = await client.call('state.get', {})
  return (state as SessionStateSnapshot).panes.find((pane) => pane.paneId === paneId)
}

describe('routing', () => {
  /**
   * Methods this test must not actually perform.
   *
   * `integration.install` writes files into the *agent's* configuration, not ours.
   * Calling it with empty params installs for every agent — and when this test did
   * exactly that it put seven hook entries into a real `~/.claude/settings.json`,
   * pointing at a temp directory that the test then deleted, so every subsequent
   * Claude Code session failed its SessionStart hook. `worktrees.test.ts` covers
   * install properly, against a temp home.
   *
   * The routing claim is still checked, just without the side effect: an unroutable
   * method answers `unknown_method` before any handler runs, so a params error is
   * proof enough that the route exists.
   */
  const SIDE_EFFECTS = new Set<string>(['integration.install'])

  it('routes every PHASE-5 method', async () => {
    for (const method of AGENT_METHODS) {
      if (SIDE_EFFECTS.has(method)) continue
      try {
        await client.call(method, {} as never)
      } catch (error) {
        expect(String(error), method).not.toContain(ErrorCodes.unknownMethod)
      }
    }
  })

  it('routes integration.install without performing it', async () => {
    // Named agents only, and `agents: []` asks for none, so nothing is written.
    const result = await client.call('integration.install', { agents: [] })
    expect(result.outcomes).toEqual([])
  })
})

describe('agent.report', () => {
  it('puts a hook state on the pane, and on the wire', async () => {
    const paneId = await firstPaneId()
    const result = await client.call('agent.report', {
      paneId,
      source: 'leap-chorus:claude',
      agent: 'claude',
      state: 'working',
      seq: 1
    })
    expect(result.accepted).toBe(true)

    const pane = await paneRecord(paneId)
    expect(pane?.agent).toBe('claude')
    expect(pane?.agentStatus).toBe('working')
  })

  it('drops a report that arrives out of order', async () => {
    // Hook processes are separate and short lived: a slow `working` can land after
    // the `idle` that followed it. Applying it would leave the pane wrong until the
    // next screen poll happened to disagree.
    const paneId = await firstPaneId()
    await client.call('agent.report', { paneId, source: 's', agent: 'claude', state: 'idle', seq: 20 })
    const late = await client.call('agent.report', { paneId, source: 's', agent: 'claude', state: 'working', seq: 10 })

    expect(late.accepted).toBe(false)
    expect((await paneRecord(paneId))?.agentStatus).toBe('idle')
  })

  it('drops a report for a pane that no longer exists', async () => {
    const result = await client.call('agent.report', { paneId: 'gone', source: 's', agent: 'claude', state: 'idle', seq: 1 })
    expect(result.accepted).toBe(false)
  })

  it('accepts a session-identity report that claims no state', async () => {
    // claude's SessionStart hook reports which conversation is in the pane without
    // saying anything about what it is doing.
    const paneId = await firstPaneId()
    const result = await client.call('agent.report', {
      paneId,
      source: 'leap-chorus:claude',
      agent: 'claude',
      seq: 1,
      agentSessionId: 'conv-7'
    })
    expect(result.accepted).toBe(true)
    expect((await paneRecord(paneId))?.agent).toBe('claude')
  })

  it('refuses a state that is not an integration\'s to claim', async () => {
    // `done` is a process fact — the agent exited — so a hook cannot assert it.
    const paneId = await firstPaneId()
    await expect(
      client.call('agent.report', { paneId, source: 's', agent: 'claude', state: 'done', seq: 1 })
    ).rejects.toThrow()
  })

  it('reaches a client that never asked about that pane', async () => {
    // Agent state is a shared runtime fact, so it goes out as `state.changed` to
    // everybody — the same rule phase 4 established for the session model.
    const { client: watcher } = await connectTo(server.paths, 'watcher')
    const revisions: number[] = []
    watcher.onEvent((event) => {
      if (event.event === 'state.changed') revisions.push(event.revision)
    })

    const paneId = await firstPaneId()
    await client.call('agent.report', { paneId, source: 's', agent: 'claude', state: 'blocked', seq: 1 })
    await waitUntil(() => revisions.length > 0, 'the second client never heard about the agent')
    watcher.close()
  })
})

describe('agent.read', () => {
  it('returns the text detection runs against', async () => {
    const paneId = await firstPaneId()
    const pane = await paneRecord(paneId)
    const sessionId = pane?.sessionId as string
    server.sessions.get(sessionId)?.writeText('hello from the pane\r\n')
    await server.sessions.get(sessionId)?.settle()

    await waitUntil(async () => {
      const read = await client.call('agent.read', { paneId })
      return read.text.includes('hello from the pane')
    }, 'the pane text never reached agent.read')
  })

  it('answers for a pane with no session rather than failing', async () => {
    const paneId = await firstPaneId()
    const read = await client.call('agent.read', { paneId, source: 'viewport' })
    expect(typeof read.text).toBe('string')
  })

  it('refuses a pane that does not exist', async () => {
    await expect(client.call('agent.read', { paneId: 'nope' })).rejects.toThrow(/no pane nope/u)
  })
})

describe('agent.explain', () => {
  it('reports the screen it looked at, even when no agent is running', async () => {
    const paneId = await firstPaneId()
    const explained = await client.call('agent.explain', { paneId })
    // A shell is not an agent, so there is no manifest and no rules — but the screen
    // is still reported, because that is what a human writing a rule needs.
    expect(explained.paneId).toBe(paneId)
    expect(explained.agent).toBeNull()
    expect(typeof explained.screen).toBe('string')
  })
})

describe('agent.reload_manifests', () => {
  it('lists the bundled manifests and where they came from', async () => {
    const result = await client.call('agent.reload_manifests', {})
    const claude = result.manifests.find((entry) => entry.agent === 'claude')
    expect(claude?.source).toBe('bundled')
    expect(claude?.version).not.toBeNull()
  })

  it('picks up an override without restarting the daemon', async () => {
    // This is the whole development loop: edit a rule, reload, see it take effect,
    // all against a session that is still running.
    const overrideDir = join(tempDataRoot(), 'agent-detection')
    mkdirSync(overrideDir, { recursive: true })
    const detector = new AgentDetector({ registry: new ManifestRegistry({ overrideDir }) })

    expect(detector.registry.get('claude')?.source).toBe('bundled')
    writeFileSync(
      join(overrideDir, 'claude.toml'),
      'id = "claude"\nversion = "9999.1.1"\n[[rules]]\nid = "mine"\nstate = "working"\ncontains = ["my own signal"]\n'
    )
    // Still bundled: the registry caches, deliberately, so a poll does not stat a file
    // per pane per tick.
    expect(detector.registry.get('claude')?.source).toBe('bundled')

    detector.registry.reload(['claude'])
    const reloaded = detector.registry.get('claude')
    expect(reloaded?.source).toBe('override')
    expect(reloaded?.compiled.manifest.version).toBe('9999.1.1')
    rmSync(overrideDir, { recursive: true, force: true })
  })

  it('falls back to the bundled manifest when an override is broken, and says why', async () => {
    // A user mid-edit must not lose detection because their file has a typo in it.
    const overrideDir = join(tempDataRoot(), 'agent-detection')
    mkdirSync(overrideDir, { recursive: true })
    writeFileSync(join(overrideDir, 'claude.toml'), 'id = "claude"\n[[rules]]\ncontians = ["typo"]\n')

    const registry = new ManifestRegistry({ overrideDir })
    const loaded = registry.get('claude')
    expect(loaded?.source).toBe('bundled')
    expect(loaded?.warning).toMatch(/ignored override/u)
    rmSync(overrideDir, { recursive: true, force: true })
  })
})

describe('the detection poll', () => {
  it('classifies every pane from one process-table capture', async () => {
    // PHASE-5 criterion 3, at the runtime level rather than the unit level: the poll
    // the daemon actually runs must not fork `ps` per pane.
    let captures = 0
    const detector = new AgentDetector({
      processTable: new ProcessTable({
        capture: async () => {
          captures += 1
          // Every pane's shell, with nothing in front of it.
          return [...Array(20).keys()].map((i) => `  ${900 + i}     1   ${900 + i}   ${900 + i} -bash`).join('\n')
        }
      })
    })
    const runtimeServer = await DaemonServer.start({
      paths: testPaths(),
      ephemeral: true,
      detector,
      detectIntervalMs: 0
    })
    try {
      const { client: runtimeClient } = await connectTo(runtimeServer.paths)
      await runtimeClient.call('workspace.create', { focus: true })
      for (let i = 0; i < 14; i++) await runtimeClient.call('pane.split', { direction: 'right' })

      const { state } = await runtimeClient.call('state.get', {})
      expect((state as SessionStateSnapshot).panes).toHaveLength(15)

      await runtimeServer.runtime.detectOnce()
      expect(captures).toBe(1)
      runtimeClient.close()
    } finally {
      await runtimeServer.close('test')
    }
  })
})

describe('stopping the daemon', () => {
  /**
   * Detaching leaves the daemon running by design; until phase 5 there was no way to
   * stop one short of `pkill`. Found the obvious way — by leaving an orphan running
   * for 75 minutes, where it quietly competed with every benchmark on the machine.
   */
  it('shuts down on request, and the endpoint goes away with it', async () => {
    const own = await DaemonServer.start({ paths: testPaths(), ephemeral: true, detectIntervalMs: 0 })
    let stopped = false
    const { client: killer } = await connectTo(own.paths, 'killer')
    try {
      // The server reports the request rather than exiting the process itself: the
      // entrypoint owns the lifetime, which is what makes it testable in-process.
      const result = await killer.call('daemon.shutdown', {})
      expect(result.ok).toBe(true)
      stopped = true
    } finally {
      killer.close()
      if (!stopped) await own.close('test')
    }
    await own.close('shutdown-requested')
    // A second client cannot reach it any more.
    await expect(connectTo(own.paths, 'after')).rejects.toThrow()
  })
})
