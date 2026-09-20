/**
 * PHASE-4 criterion 5: config loads from TOML, validates, reports unknown keys, and
 * hot-reloads through `server.reload_config` without dropping panes.
 *
 * The "without dropping panes" half is the one worth a test: a reload is a re-read of a
 * file, and nothing about a running terminal depends on that file, so nothing should be
 * torn down. The check is a pane that has *printed something* before the reload and can
 * still be read after it — a pane that survived as a record but lost its terminal would
 * pass a mere count.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@leap-chorus/core'
import type { DaemonClient } from '../src/client.js'
import { DaemonServer } from '../src/socket.js'
import { snapshotToText } from '../src/snapshot.js'
import { cleanupDataRoots, connectTo, tempDataRoot, testPaths, waitUntil } from './harness.js'

const servers: DaemonServer[] = []
const clients: DaemonClient[] = []

async function start(configPath?: string): Promise<{ server: DaemonServer; client: DaemonClient }> {
  const server = await DaemonServer.start({
    paths: testPaths(),
    ephemeral: true,
    ...(configPath === undefined ? {} : { configPath })
  })
  servers.push(server)
  const { client } = await connectTo(server.paths, 'config-test')
  clients.push(client)
  return { server, client }
}

afterEach(async () => {
  while (clients.length > 0) clients.pop()?.close()
  while (servers.length > 0) await servers.pop()?.close('test')
})

afterAll(() => {
  cleanupDataRoots()
})

function writeConfig(body: string): string {
  const path = join(tempDataRoot(), 'config.toml')
  writeFileSync(path, body)
  return path
}

describe('config.get', () => {
  it('reports the defaults when there is no file', async () => {
    const { client } = await start(join(tempDataRoot(), 'absent.toml'))
    const result = await client.call('config.get', {})
    expect(result.path).toBeNull()
    expect(result.errors).toEqual([])
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })

  it('reads a TOML file and reports where it came from', async () => {
    const path = writeConfig('[ui]\nsidebar-width = 31\n[keys]\nprefix = "C-a"\n')
    const { client } = await start(path)
    const result = await client.call('config.get', {})
    expect(result.path).toBe(path)
    expect((result.config as Config).ui.sidebarWidth).toBe(31)
    expect((result.config as Config).keys.prefix).toBe('C-a')
  })

  it('reports unknown keys without refusing the rest of the file', async () => {
    const path = writeConfig('[ui]\nsidebar = false\nsidebar-colour = 3\n\n[nonsense]\nx = 1\n')
    const { client } = await start(path)
    const result = await client.call('config.get', {})
    expect(result.problems.map((problem) => problem.path).sort()).toEqual(['nonsense', 'ui.sidebar-colour'])
    expect((result.config as Config).ui.sidebar).toBe(false)
  })

  it('reports a parse error with the line and keeps the defaults', async () => {
    const path = writeConfig('[ui]\nsidebar = true\noops = @\n')
    const { client } = await start(path)
    const result = await client.call('config.get', {})
    expect(result.errors[0]).toContain('line 3')
    expect(result.config).toEqual(DEFAULT_CONFIG)
  })
})

describe('server.reload_config', () => {
  it('picks up an edit without dropping panes', async () => {
    const path = writeConfig('[ui]\nsidebar-width = 20\n')
    const { server, client } = await start(path)

    await client.call('workspace.create', { focus: true })
    await client.call('pane.split', { direction: 'right' })
    await client.call('pane.split', { direction: 'down' })
    let state = (await client.call('state.get', {})).state
    await waitUntil(async () => {
      state = (await client.call('state.get', {})).state
      return state.panes.length === 3 && state.panes.every((pane) => pane.sessionId !== null)
    }, 'panes never got sessions')

    // Put something on screen, so "the pane survived" means its terminal did too.
    const marker = 'config-reload-marker'
    const sessionId = state.panes[0]?.sessionId as string
    const session = server.sessions.get(sessionId)
    if (!session) throw new Error('no session')
    await session.emulator.writeText(`${marker}\r\n`)
    const pidsBefore = (await client.call('session.list', {})).sessions.map((entry) => entry.pid)

    writeFileSync(path, '[ui]\nsidebar-width = 40\n[general]\nscrollback = 1234\n')
    const reloaded = await client.call('server.reload_config', {})

    expect((reloaded.config as Config).ui.sidebarWidth).toBe(40)
    expect((reloaded.config as Config).general.scrollback).toBe(1234)
    expect(reloaded.problems).toEqual([])
    expect(reloaded.paneCount).toBe(3)

    const after = (await client.call('state.get', {})).state
    expect(after.panes.map((pane) => pane.paneId)).toEqual(state.panes.map((pane) => pane.paneId))
    expect(after.panes.map((pane) => pane.sessionId)).toEqual(state.panes.map((pane) => pane.sessionId))
    expect((await client.call('session.list', {})).sessions.map((entry) => entry.pid)).toEqual(pidsBefore)

    const shot = await client.call('session.snapshot', { id: sessionId })
    expect(snapshotToText(shot.snapshot)).toContain(marker)
  })

  it('tells every attached client the config changed', async () => {
    const path = writeConfig('[ui]\nsidebar = true\n')
    const { server, client } = await start(path)
    const { client: watcher } = await connectTo(server.paths, 'watcher')
    clients.push(watcher)

    const seen: Array<string | null> = []
    watcher.onEvent((event) => {
      if (event.event === 'config.changed') seen.push(event.path)
    })
    writeFileSync(path, '[ui]\nsidebar = false\n')
    await client.call('server.reload_config', {})
    await waitUntil(() => seen.length > 0, 'no config.changed reached the second client')
    expect(seen[0]).toBe(path)
  })

  it('a reload that now fails to parse falls back to the defaults and says why', async () => {
    const path = writeConfig('[ui]\nsidebar-width = 30\n')
    const { client } = await start(path)
    await client.call('workspace.create', { focus: true })
    expect(((await client.call('config.get', {})).config as Config).ui.sidebarWidth).toBe(30)

    writeFileSync(path, '[ui\nbroken')
    const reloaded = await client.call('server.reload_config', {})
    expect(reloaded.errors).toHaveLength(1)
    expect((reloaded.config as Config).ui.sidebarWidth).toBe(DEFAULT_CONFIG.ui.sidebarWidth)
    expect(reloaded.paneCount).toBeGreaterThan(0)
  })

  it('an explicit path on the call overrides the one the daemon started with', async () => {
    const first = writeConfig('[ui]\nsidebar-width = 20\n')
    const second = writeConfig('[ui]\nsidebar-width = 44\n')
    const { client } = await start(first)
    const reloaded = await client.call('server.reload_config', { path: second })
    expect(reloaded.path).toBe(second)
    expect((reloaded.config as Config).ui.sidebarWidth).toBe(44)
  })
})

describe('the config reaches the runtime', () => {
  it('a configured shell is what a new pane runs', async () => {
    const path = writeConfig(`[general]\nshell = "/bin/sh"\n`)
    const { client } = await start(path)
    await client.call('workspace.create', { focus: true })
    await waitUntil(async () => (await client.call('session.list', {})).sessions.length > 0, 'no session')
    const sessions = (await client.call('session.list', {})).sessions
    expect(sessions[0]?.command).toBe('/bin/sh')
  })

  it('a configured cwd is where the first workspace starts', async () => {
    const root = tempDataRoot()
    const path = writeConfig(`[general]\ncwd = ${JSON.stringify(root)}\n`)
    const { client } = await start(path)
    await client.call('workspace.create', { focus: true })
    const state = (await client.call('state.get', {})).state
    expect(state.workspaces[0]?.cwd).toBe(root)
  })
})
