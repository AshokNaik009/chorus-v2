/**
 * PHASE-4 criterion 3, end to end: build an arrangement, restart the daemon, get it back.
 *
 * This runs against the *built* detached daemon, not an in-process server, because the
 * thing being proved is what survives a process ending. A daemon killed with SIGTERM
 * writes its session file on the way out; the next one reads it, rebuilds the model with
 * the same ids, and gives every pane a live terminal again.
 *
 * "Live PTYs reattached" means exactly that: each restored pane is bound to a session
 * with a running process. It does not mean the *old* processes survived — the daemon
 * owns its PTYs as children, so a daemon that exits takes them with it. Phase 1 proves
 * the other half of the guarantee, which is the one that matters day to day: a daemon
 * that does *not* exit keeps every PTY through any number of client restarts.
 */

import { existsSync, readFileSync } from 'node:fs'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import type { SessionStateSnapshot } from '@leap-chorus/protocol'
import { sessionFilePath } from '../src/runtime.js'
import { isProcessAlive } from '../src/lock.js'
import {
  cleanupDataRoots,
  connectTo,
  startDetachedDaemon,
  testPaths,
  waitUntil,
  type DaemonHandle
} from './harness.js'

const running: DaemonHandle[] = []

afterEach(async () => {
  while (running.length > 0) await running.pop()?.stop()
})

afterAll(() => {
  cleanupDataRoots()
})

async function start(paths = testPaths()): Promise<DaemonHandle> {
  const handle = await startDetachedDaemon(paths)
  running.push(handle)
  return handle
}

/** Everything a restore must preserve, as one comparable value. */
function structure(state: SessionStateSnapshot) {
  return {
    order: state.workspaceOrder,
    active: state.activeWorkspaceId,
    focused: state.focusedPaneId,
    workspaces: state.workspaces.map((workspace) => ({
      id: workspace.workspaceId,
      number: workspace.number,
      label: workspace.label,
      cwd: workspace.cwd,
      tabIds: workspace.tabIds,
      activeTabId: workspace.activeTabId
    })),
    tabs: state.tabs.map((tab) => ({
      id: tab.tabId,
      workspaceId: tab.workspaceId,
      number: tab.number,
      label: tab.label,
      layout: tab.layout,
      focusedPaneId: tab.focusedPaneId,
      zoomed: tab.zoomed
    })),
    panes: state.panes.map((pane) => ({
      id: pane.paneId,
      number: pane.number,
      label: pane.label,
      cwd: pane.cwd,
      rightClick: pane.rightClick
    }))
  }
}

describe('a session survives a daemon restart', () => {
  it('restores three workspaces and eight panes, with live terminals', async () => {
    const paths = testPaths()
    const first = await start(paths)
    const { client } = await connectTo(paths, 'builder')

    // Workspace 1: two tabs, the first split three ways.
    await client.call('workspace.create', { focus: true })
    await client.call('pane.split', { direction: 'right' })
    await client.call('pane.split', { direction: 'down' })
    await client.call('tab.create', { label: 'logs' })
    // Workspace 2: one tab, two panes, one renamed, one scrolled.
    await client.call('workspace.create', { label: 'docs' })
    await client.call('pane.split', { direction: 'right', ratio: 0.3 })
    // Workspace 3: one tab, two panes, zoomed.
    await client.call('workspace.create', {})
    await client.call('pane.split', { direction: 'down' })
    await client.call('pane.zoom', { mode: 'on' })

    let before = (await client.call('state.get', {})).state
    const focusedPane = before.panes.find((pane) => pane.paneId === before.focusedPaneId)
    await client.call('pane.rename', { paneId: focusedPane?.paneId as string, label: 'notes' })
    await client.call('workspace.focus', { workspaceId: before.workspaceOrder[0] as string })
    before = (await client.call('state.get', {})).state

    expect(before.workspaces).toHaveLength(3)
    expect(before.panes).toHaveLength(8)
    expect(before.panes.every((pane) => pane.sessionId !== null)).toBe(true)
    const oldPids = (await client.call('session.list', {})).sessions.map((session) => session.pid)
    expect(oldPids.every((pid) => pid !== null && isProcessAlive(pid))).toBe(true)

    client.close()
    await first.stop()
    running.pop()

    // The session file is on disk, written on the way out.
    expect(existsSync(sessionFilePath(paths.daemonDir))).toBe(true)
    const document = JSON.parse(readFileSync(sessionFilePath(paths.daemonDir), 'utf8')) as { workspaces: unknown[] }
    expect(document.workspaces).toHaveLength(3)

    await start(paths)
    const { client: second } = await connectTo(paths, 'restorer')
    try {
      let after = (await second.call('state.get', {})).state
      await waitUntil(async () => {
        after = (await second.call('state.get', {})).state
        return after.panes.length === 8 && after.panes.every((pane) => pane.sessionId !== null)
      }, 'restored panes never got sessions')

      // Structural equality: same ids, same tree, same labels, same focus.
      expect(structure(after)).toEqual(structure(before))

      // And every one of them has a running process behind it.
      const sessions = (await second.call('session.list', {})).sessions
      expect(sessions).toHaveLength(8)
      for (const session of sessions) {
        expect(session.alive, `${session.id} is not alive`).toBe(true)
        expect(session.pid).not.toBeNull()
        expect(isProcessAlive(session.pid as number)).toBe(true)
      }
      // New terminals, not the old ones: the daemon owns its PTYs as children.
      const newPids = sessions.map((session) => session.pid)
      expect(newPids.some((pid) => oldPids.includes(pid))).toBe(false)
    } finally {
      second.close()
    }
  }, 60_000)

  it('starts empty when the file is corrupt, rather than refusing to boot', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    const paths = testPaths()
    mkdirSync(paths.daemonDir, { recursive: true })
    writeFileSync(sessionFilePath(paths.daemonDir), '{"workspaces": [ this is not json')

    await start(paths)
    const { client } = await connectTo(paths, 'recovery')
    try {
      // Empty, not a guessed-at session: the next client decides what to create.
      let state = (await client.call('state.get', {})).state
      expect(state.workspaces).toEqual([])
      state = (await client.call('workspace.create', { focus: true }).then(() => client.call('state.get', {}))).state
      expect(state.panes).toHaveLength(1)
    } finally {
      client.close()
    }
  }, 30_000)

  it('a pane closed before the restart does not come back', async () => {
    const paths = testPaths()
    const first = await start(paths)
    const { client } = await connectTo(paths, 'builder')
    await client.call('workspace.create', { focus: true })
    const paneId = (await client.call('pane.split', { direction: 'right' })).paneId as string
    await client.call('pane.split', { direction: 'down' })
    await client.call('pane.close', { paneId })
    const before = (await client.call('state.get', {})).state
    expect(before.panes).toHaveLength(2)
    client.close()
    await first.stop()
    running.pop()

    await start(paths)
    const { client: second } = await connectTo(paths, 'restorer')
    try {
      const after = (await second.call('state.get', {})).state
      expect(after.panes).toHaveLength(2)
      expect(after.panes.map((pane) => pane.paneId)).not.toContain(paneId)
    } finally {
      second.close()
    }
  }, 30_000)
})
