/**
 * The 28 session-model methods, against a real daemon over a real socket.
 *
 * `core`'s own tests already prove the model behaves; these prove the *endpoint* does:
 * that every method is routed, validated, answered in the shape the wire declares, and
 * that the effects reach real PTYs. So the assertions here are about plumbing —
 * a pane gained a session id, a `state.changed` event arrived, a bad param produced an
 * error code — rather than about layout semantics.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SESSION_MODEL_METHODS, type SessionStateSnapshot } from '@leap-chorus/protocol'
import type { DaemonClient } from '../src/client.js'
import { DaemonServer } from '../src/socket.js'
import { cleanupDataRoots, connectTo, testPaths, waitUntil } from './harness.js'

let server: DaemonServer
let client: DaemonClient

beforeEach(async () => {
  // In-process: what is under test is the dispatch table, not process lifetime.
  server = await DaemonServer.start({ paths: testPaths(), ephemeral: true })
  ;({ client } = await connectTo(server.paths))
})

/**
 * Give the daemon a session to work on.
 *
 * A fresh daemon has none — see `SessionRuntime.create`. The client is what brings one
 * into being, so every test below that acts on panes starts by doing what a client
 * does on first run.
 */
async function withWorkspace(): Promise<void> {
  await client.call('workspace.create', { focus: true })
}

afterEach(async () => {
  client.close()
  await server.close('test')
})

afterAll(() => {
  cleanupDataRoots()
})

async function state(): Promise<SessionStateSnapshot> {
  return (await client.call('state.get', {})).state
}

/** Wait until every pane has a live session, which is a spawn round trip behind. */
async function settled(): Promise<SessionStateSnapshot> {
  let snapshot = await state()
  await waitUntil(async () => {
    snapshot = await state()
    return snapshot.panes.every((pane) => pane.sessionId !== null)
  }, 'panes never got sessions')
  return snapshot
}

describe('the method set', () => {
  it('routes every method PHASE-4 names', async () => {
    // A method that is not routed answers `leap_chorus_unknown_method`; every other error is
    // this test calling it wrong, which is fine — it proves the route exists.
    for (const method of SESSION_MODEL_METHODS) {
      const error = await client
        .call(method as 'state.get', {} as never)
        .then(() => null)
        .catch((problem: { code?: string }) => problem.code ?? null)
      expect(error, `${method} is not routed`).not.toBe('leap_chorus_unknown_method')
    }
  })

  it('counts 28', () => {
    expect(SESSION_MODEL_METHODS).toHaveLength(28)
  })
})

describe('boot', () => {
  it('starts empty: a daemon is not a session', async () => {
    const snapshot = await state()
    expect(snapshot.workspaces).toEqual([])
    expect(snapshot.panes).toEqual([])
    expect(snapshot.activeWorkspaceId).toBeNull()
    expect(server.sessions.list()).toEqual([])
  })

  it('the first workspace.create gives one workspace, one tab, one live pane', async () => {
    await withWorkspace()
    const snapshot = await settled()
    expect(snapshot.workspaces).toHaveLength(1)
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.panes).toHaveLength(1)
    expect(snapshot.focusedPaneId).toBe(snapshot.panes[0]?.paneId)
    expect(snapshot.panes[0]?.sessionId).not.toBeNull()
  })

  it('binds each pane to exactly one session', async () => {
    await withWorkspace()
    await client.call('pane.split', { direction: 'right' })
    await client.call('pane.split', { direction: 'down' })
    const snapshot = await settled()
    const sessions = snapshot.panes.map((pane) => pane.sessionId)
    expect(new Set(sessions).size).toBe(sessions.length)
    expect(server.sessions.list()).toHaveLength(3)
  })
})

describe('workspaces, tabs and panes over the wire', () => {
  it('workspace.create spawns a pane and returns its ids', async () => {
    await withWorkspace()
    const result = await client.call('workspace.create', { label: 'api' })
    expect(result.workspaceId).toBeDefined()
    expect(result.paneId).toBeDefined()
    const snapshot = await settled()
    expect(snapshot.workspaces).toHaveLength(2)
    expect(snapshot.workspaces[1]?.label).toBe('api')
    expect(snapshot.activeWorkspaceId).toBe(result.workspaceId)
  })

  it('workspace.create runs a named command in the first pane', async () => {
    await client.call('workspace.create', { command: '/bin/cat', focus: true })
    await settled()
    expect((await client.call('session.list', {})).sessions[0]?.command).toBe('/bin/cat')
  })

  it('workspace.rename, move and move_block reach the model', async () => {
    await withWorkspace()
    const a = (await client.call('workspace.create', {})).workspaceId as string
    const b = (await client.call('workspace.create', {})).workspaceId as string
    await client.call('workspace.rename', { workspaceId: a, label: 'renamed' })
    await client.call('workspace.move', { workspaceId: a, insertIndex: 0 })
    let snapshot = await state()
    expect(snapshot.workspaceOrder[0]).toBe(a)
    expect(snapshot.workspaces[0]?.label).toBe('renamed')

    // Order is [a, first, b]; move the pair in front of the workspace between them.
    await client.call('workspace.move_block', { workspaceIds: [a, b], beforeWorkspaceId: snapshot.workspaceOrder[1] })
    snapshot = await state()
    expect(snapshot.workspaceOrder.slice(0, 2)).toEqual([a, b])
  })

  it('workspace.close kills the sessions it held', async () => {
    await withWorkspace()
    const created = await client.call('workspace.create', {})
    await settled()
    const before = server.sessions.list().length
    await client.call('workspace.close', { workspaceId: created.workspaceId as string })
    expect(server.sessions.list()).toHaveLength(before - 1)
  })

  it('tab.create, focus, rename, move, close', async () => {
    await withWorkspace()
    const tabId = (await client.call('tab.create', { label: 'logs' })).tabId as string
    let snapshot = await state()
    expect(snapshot.tabs).toHaveLength(2)
    expect(snapshot.workspaces[0]?.activeTabId).toBe(tabId)

    await client.call('tab.rename', { tabId, label: 'output' })
    await client.call('tab.move', { tabId, insertIndex: 0 })
    snapshot = await state()
    expect(snapshot.tabs.find((tab) => tab.tabId === tabId)?.label).toBe('output')
    expect(snapshot.workspaces[0]?.tabIds[0]).toBe(tabId)

    const other = snapshot.workspaces[0]?.tabIds[1] as string
    await client.call('tab.focus', { tabId: other })
    expect((await state()).workspaces[0]?.activeTabId).toBe(other)

    await client.call('tab.close', { tabId })
    expect((await state()).tabs).toHaveLength(1)
  })

  it('pane.split, focus, focus_direction, swap, resize, zoom, rename, close', async () => {
    await withWorkspace()
    const first = (await state()).focusedPaneId as string
    const second = (await client.call('pane.split', { direction: 'right' })).paneId as string
    await settled()

    await client.call('pane.focus', { paneId: first })
    expect((await state()).focusedPaneId).toBe(first)

    await client.call('pane.focus_direction', { direction: 'right', viewport: { cols: 120, rows: 40 } })
    expect((await state()).focusedPaneId).toBe(second)

    await client.call('pane.resize', { direction: 'left', amount: 0.1, viewport: { cols: 120, rows: 40 } })
    const layout = (await state()).tabs[0]?.layout
    expect(layout?.type).toBe('split')
    if (layout?.type === 'split') expect(layout.ratio).toBeCloseTo(0.6, 5)

    await client.call('pane.swap', { direction: 'left', viewport: { cols: 120, rows: 40 } })
    const swapped = (await state()).tabs[0]?.layout
    if (swapped?.type === 'split') expect(swapped.first).toEqual({ type: 'pane', paneId: second })

    await client.call('pane.zoom', { mode: 'on' })
    expect((await state()).tabs[0]?.zoomed).toBe(true)

    await client.call('pane.rename', { paneId: second, label: 'build' })
    expect((await state()).panes.find((pane) => pane.paneId === second)?.label).toBe('build')

    await client.call('pane.close', { paneId: second })
    const after = await state()
    expect(after.panes).toHaveLength(1)
    expect(after.tabs[0]?.zoomed).toBe(false)
  })

  it('closing a pane destroys its session rather than leaking it', async () => {
    await withWorkspace()
    const paneId = (await client.call('pane.split', { direction: 'right' })).paneId as string
    await settled()
    const sessionId = (await state()).panes.find((pane) => pane.paneId === paneId)?.sessionId
    expect(server.sessions.get(sessionId as string)).toBeDefined()
    await client.call('pane.close', { paneId })
    expect(server.sessions.get(sessionId as string)).toBeUndefined()
  })

  it('layout.set_split_ratio addresses a divider by path', async () => {
    await withWorkspace()
    await client.call('pane.split', { direction: 'right' })
    await client.call('layout.set_split_ratio', { path: [], ratio: 0.2 })
    const layout = (await state()).tabs[0]?.layout
    if (layout?.type === 'split') expect(layout.ratio).toBe(0.2)
  })
})

describe('pane content methods', () => {
  /** Put known text in a pane and wait for the emulator to have parsed it. */
  beforeEach(withWorkspace)

  async function fill(sessionId: string, text: string): Promise<void> {
    const session = server.sessions.get(sessionId)
    if (!session) throw new Error('no session')
    await session.emulator.writeText(text)
  }

  it('pane.selection.read returns the text between two points', async () => {
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    await fill(pane?.sessionId as string, 'hello world\r\nsecond line\r\n')
    const result = await client.call('pane.selection.read', {
      paneId: pane?.paneId as string,
      anchor: { row: 0, col: 6 },
      cursor: { row: 0, col: 11 }
    })
    expect(result.text).toBe('world')
  })

  it('pane.copy_motion moves a cursor by a vi motion', async () => {
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    await fill(pane?.sessionId as string, 'alpha beta gamma\r\n')
    const result = await client.call('pane.copy_motion', {
      paneId: pane?.paneId as string,
      cursor: { row: 0, col: 0 },
      motion: 'next_word_start'
    })
    expect(result.cursor).toEqual({ row: 0, col: 6 })
  })

  it('pane.copy_search finds a match and steps past it', async () => {
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    await fill(pane?.sessionId as string, 'needle one\r\nneedle two\r\n')
    const first = await client.call('pane.copy_search', {
      paneId: pane?.paneId as string,
      query: 'needle',
      direction: 'forward',
      cursor: { row: 0, col: 0 }
    })
    expect(first.match?.start).toEqual({ row: 0, col: 0 })
    const second = await client.call('pane.copy_search', {
      paneId: pane?.paneId as string,
      query: 'needle',
      direction: 'forward',
      cursor: { row: 0, col: 0 },
      ...(first.match === null ? {} : { previous: first.match })
    })
    expect(second.match?.start).toEqual({ row: 1, col: 0 })
  })

  it('pane.link.activate returns the URL under a screen cell', async () => {
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    await fill(pane?.sessionId as string, 'see https://example.com/x for more\r\n')
    const result = await client.call('pane.link.activate', {
      paneId: pane?.paneId as string,
      viewportRow: 0,
      col: 10
    })
    expect(result.url).toBe('https://example.com/x')
    const miss = await client.call('pane.link.activate', {
      paneId: pane?.paneId as string,
      viewportRow: 0,
      col: 1
    })
    expect(miss.url).toBeNull()
  })

  it('pane.edit_scrollback writes the content somewhere an editor can open it', async () => {
    const { readFileSync, rmSync } = await import('node:fs')
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    await fill(pane?.sessionId as string, 'first\r\nsecond\r\n')
    const result = await client.call('pane.edit_scrollback', { paneId: pane?.paneId as string })
    const body = readFileSync(result.path, 'utf8')
    expect(body).toContain('first')
    expect(body).toContain('second')
    expect(result.lines).toBeGreaterThan(0)
    rmSync(result.path, { force: true })
  })

  it('pane.scroll clamps to the scrollback that exists and reaches the snapshot', async () => {
    const snapshot = await settled()
    const pane = snapshot.panes[0]
    const sessionId = pane?.sessionId as string
    const session = server.sessions.get(sessionId)
    if (!session) throw new Error('no session')
    for (let i = 0; i < 80; i++) await session.emulator.writeText(`line ${i}\r\n`)

    // Asking to scroll a thousand lines back in eighty lines of history lands at the top.
    await client.call('pane.scroll', { paneId: pane?.paneId as string, offsetFromBottom: 1000 })
    const scrolled = (await state()).panes[0]?.scrollOffset ?? 0
    expect(scrolled).toBeGreaterThan(0)
    expect(scrolled).toBeLessThan(1000)

    const shot = await client.call('session.snapshot', { id: sessionId })
    expect(shot.snapshot.scrollOffset).toBe(scrolled)

    await client.call('pane.scroll', { paneId: pane?.paneId as string, offsetFromBottom: 0 })
    expect((await state()).panes[0]?.scrollOffset).toBe(0)
  })

  it('pane.input.set records where a right click goes', async () => {
    const snapshot = await settled()
    const paneId = snapshot.panes[0]?.paneId as string
    await client.call('pane.input.set', { paneId, rightClick: 'pane' })
    expect((await state()).panes[0]?.rightClick).toBe('pane')
  })
})

describe('errors', () => {
  it('an unknown pane is `leap_chorus_action_rejected`, not a silent success', async () => {
    const error = await client
      .call('pane.close', { paneId: 'nope' })
      .then(() => null)
      .catch((problem: { code?: string }) => problem.code)
    expect(error).toBe('leap_chorus_action_rejected')
  })

  it('a missing required param is `leap_chorus_bad_request`', async () => {
    const error = await client
      .call('pane.split', {} as never)
      .then(() => null)
      .catch((problem: { code?: string }) => problem.code)
    expect(error).toBe('leap_chorus_bad_request')
  })

  it('an out-of-vocabulary enum is rejected by name', async () => {
    const error = await client
      .call('pane.split', { direction: 'sideways' } as never)
      .then(() => null)
      .catch((problem: { message?: string }) => problem.message ?? '')
    expect(error).toContain('direction')
  })
})

describe('state.changed', () => {
  beforeEach(withWorkspace)

  it('reaches a client that never asked for the session', async () => {
    const { client: watcher } = await connectTo(server.paths, 'watcher')
    try {
      const seen: number[] = []
      watcher.onEvent((event) => {
        if (event.event === 'state.changed') seen.push(event.revision)
      })
      const before = (await state()).revision
      await client.call('pane.split', { direction: 'right' })
      await waitUntil(() => seen.length > 0, 'no state.changed reached the second client')
      expect(seen[seen.length - 1]).toBeGreaterThan(before)
    } finally {
      watcher.close()
    }
  })

  it('a no-op action changes no revision and emits nothing', async () => {
    const paneId = (await state()).focusedPaneId as string
    const before = (await state()).revision
    const result = await client.call('pane.focus', { paneId })
    expect(result.changed).toBe(false)
    expect((await state()).revision).toBe(before)
  })
})
