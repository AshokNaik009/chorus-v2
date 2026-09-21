/**
 * A plugin's entrypoint, opened in a real daemon.
 *
 * PHASE-10 criteria 3, 4 and 7 live here: a declared entrypoint opens in a split pane
 * and in a tab, both idempotent; `plugin list --json` matches the shape a herdr
 * launcher parses; output over the cap is truncated and reported.
 *
 * The plugin is installed the way a user installs one — through `PluginInstaller`
 * against a local git fixture — rather than by writing `registry.json` by hand, so the
 * daemon reads what an install actually produces.
 */

import { realpathSync, rmSync } from 'node:fs'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_METHODS, type SessionStateSnapshot } from '@leap-chorus/protocol'
import type { DaemonClient } from '../src/client.js'
import { DaemonServer } from '../src/socket.js'
import { PluginInstaller, parsePluginSource } from '../src/plugins/install.js'
import { PluginStore } from '../src/plugins/registry.js'
import { cleanupDataRoots, connectTo, testPaths, waitUntil } from './harness.js'
import { createFixtureRepo, fixtureFiles, type FixtureRepo } from './plugin-fixture.js'

let server: DaemonServer
let client: DaemonClient
let store: PluginStore
let repo: FixtureRepo

const MANIFEST = `id = "fixture.viewer"
name = "Fixture Viewer"
version = "0.1.0"

[[panes]]
id = "viewer"
title = "Fixture Viewer"
placement = "split"
command = ["sh", "-c", "printf 'viewer ready'; cat"]

[[panes]]
id = "in-a-tab"
title = "Fixture Tab"
placement = "tab"
command = ["sh", "-c", "printf 'tab ready'; cat"]

[[actions]]
id = "echo-env"
title = "Echo the environment"
command = ["sh", "-c", "printf '%s\\n%s\\n' \\"$HERDR_PLUGIN_ID\\" \\"$HERDR_BIN_PATH\\""]

[[actions]]
id = "noisy"
title = "Print a lot"
command = ["sh", "-c", "i=0; while [ $i -lt 200 ]; do printf '%01000d' 0; i=$((i+1)); done"]

[[actions]]
id = "dump-env"
title = "Dump the environment"
command = ["sh", "-c", "env | grep '^HERDR_'"]

[[actions]]
id = "where"
title = "Where am I"
command = ["sh", "-c", "pwd"]

[[actions]]
id = "relative"
title = "A relative program, the way herdr-file-viewer declares one"
command = ["./run.sh"]

[[actions]]
id = "linux-only"
title = "Never here"
platforms = ["linux"]
command = ["true"]
`

beforeEach(async () => {
  const paths = testPaths()
  repo = createFixtureRepo(
    fixtureFiles({
      manifest: MANIFEST,
      extra: [{ path: 'run.sh', body: "#!/bin/sh\nprintf 'relative program ran'\n", executable: true }]
    })
  )
  store = new PluginStore(paths.dataRoot)
  await new PluginInstaller(store).install({ source: parsePluginSource(repo.path) })
  server = await DaemonServer.start({ paths, ephemeral: true })
  ;({ client } = await connectTo(server.paths))
  await client.call('workspace.create', { focus: true })
})

afterEach(async () => {
  client.close()
  await server.close('test')
  rmSync(repo.path, { recursive: true, force: true })
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

function open(params: Record<string, unknown>) {
  return client.call('plugin.pane.open', params as never)
}

describe('the method set', () => {
  it('declares the three plugin methods and no more', () => {
    // Deliberately three: PHASE-10 says no plugin-invoked RPCs beyond the five
    // commands, and none of these is reachable *by* a plugin.
    const plugin = AGENT_METHODS.filter((method) => method.startsWith('plugin.'))
    expect(plugin).toEqual(['plugin.list', 'plugin.pane.open', 'plugin.action.invoke'])
  })
})

describe('plugin.list', () => {
  it('reports what the install registered, with its pin', async () => {
    const result = await client.call('plugin.list', {})
    expect(result.plugins).toHaveLength(1)
    const plugin = result.plugins[0]
    expect(plugin?.id).toBe('fixture.viewer')
    expect(plugin?.pin.commit).toBe(repo.head())
    expect(plugin?.entrypoints.map((entry) => entry.id)).toEqual([
      'in-a-tab',
      'viewer',
      'dump-env',
      'echo-env',
      'linux-only',
      'noisy',
      'relative',
      'where'
    ])
  })

  it('names the shim $HERDR_BIN_PATH will point at', async () => {
    const result = await client.call('plugin.list', {})
    expect(result.shimPath).toBe(store.shimPath)
    expect(result.shimPath.endsWith('/herdr-compat')).toBe(true)
  })

  it('filters by id', async () => {
    expect((await client.call('plugin.list', { pluginId: 'nothing' })).plugins).toEqual([])
  })

  it('sees a plugin installed after the daemon started', async () => {
    // The registry is a file the CLI writes and the daemon re-reads; a cached store
    // would go stale the moment a user installed something.
    const second = createFixtureRepo(
      fixtureFiles({
        manifest: 'id = "second.tool"\nname = "Second"\nversion = "1"\n\n[[panes]]\nid = "p"\ntitle = "P"\ncommand = ["true"]\n'
      })
    )
    try {
      await new PluginInstaller(store).install({ source: parsePluginSource(second.path) })
      const ids = (await client.call('plugin.list', {})).plugins.map((plugin) => plugin.id)
      expect(ids).toEqual(['fixture.viewer', 'second.tool'])
    } finally {
      rmSync(second.path, { recursive: true, force: true })
    }
  })
})

describe('opening an entrypoint in a split pane', () => {
  it('splits, runs the argv, and names the pane after the entrypoint', async () => {
    const before = await settled()
    const result = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    expect(result.reused).toBe(false)
    expect(result.placement).toBe('split')
    const after = await settled()
    expect(after.panes).toHaveLength(before.panes.length + 1)
    expect(after.panes.find((pane) => pane.paneId === result.paneId)?.label).toBe('Fixture Viewer')
    // Same tab: a split is a split.
    expect(after.tabs).toHaveLength(before.tabs.length)
  })

  it('is idempotent: a second open focuses the first rather than splitting again', async () => {
    const first = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    const count = (await settled()).panes.length
    const second = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    expect(second.reused).toBe(true)
    expect(second.paneId).toBe(first.paneId)
    expect((await settled()).panes).toHaveLength(count)
    expect((await state()).focusedPaneId).toBe(first.paneId)
  })

  it('opens a new one after the old pane is gone', async () => {
    // Checked against live state on every open rather than tracked by an event: a pane
    // disappears when its program exits and nothing tells the index about that.
    const first = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    await client.call('pane.close', { paneId: first.paneId })
    const second = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    expect(second.reused).toBe(false)
    expect(second.paneId).not.toBe(first.paneId)
  })

  it('honours --direction and --no-focus', async () => {
    const before = (await state()).focusedPaneId
    const result = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer', direction: 'down', focus: false })
    expect((await state()).focusedPaneId).toBe(before)
    expect(result.paneId).not.toBe(before)
  })
})

describe('opening an entrypoint in a tab', () => {
  it('creates a tab whose first pane runs the argv', async () => {
    const before = await settled()
    const result = await open({ pluginId: 'fixture.viewer', entrypointId: 'in-a-tab' })
    expect(result.placement).toBe('tab')
    const after = await settled()
    expect(after.tabs).toHaveLength(before.tabs.length + 1)
    const tab = after.tabs.find((candidate) => candidate.tabId === result.tabId)
    expect(tab?.label).toBe('Fixture Tab')
    expect(tab?.focusedPaneId).toBe(result.paneId)
  })

  it('is idempotent too', async () => {
    const first = await open({ pluginId: 'fixture.viewer', entrypointId: 'in-a-tab' })
    const tabs = (await settled()).tabs.length
    const second = await open({ pluginId: 'fixture.viewer', entrypointId: 'in-a-tab' })
    expect(second.reused).toBe(true)
    expect(second.paneId).toBe(first.paneId)
    expect((await settled()).tabs).toHaveLength(tabs)
  })

  it('focuses the existing split when a tab is asked for and one is already open', async () => {
    // One entrypoint has one live pane, wherever it is. The thing the user wants is the
    // viewer, not a second copy of it in a different container.
    const first = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer' })
    const second = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer', placement: 'tab' })
    expect(second.paneId).toBe(first.paneId)
    expect(second.reused).toBe(true)
  })

  it('lets a caller override the manifest and put a split entrypoint in a tab', async () => {
    const before = await settled()
    const result = await open({ pluginId: 'fixture.viewer', entrypointId: 'viewer', placement: 'tab' })
    expect(result.placement).toBe('tab')
    expect((await settled()).tabs).toHaveLength(before.tabs.length + 1)
  })
})

describe('choosing an entrypoint', () => {
  it('refuses to guess when a plugin declares several', async () => {
    // A host that silently picked the first would open a different thing after the
    // plugin's next release added one above it alphabetically.
    await expect(open({ pluginId: 'fixture.viewer' })).rejects.toThrow(/several entrypoints/u)
  })

  it('takes the only one when there is only one', async () => {
    const single = createFixtureRepo(
      fixtureFiles({
        manifest: 'id = "only.one"\nname = "Only"\nversion = "1"\n\n[[panes]]\nid = "p"\ntitle = "P"\ncommand = ["sh", "-c", "cat"]\n'
      })
    )
    try {
      await new PluginInstaller(store).install({ source: parsePluginSource(single.path) })
      expect((await open({ pluginId: 'only.one' })).entrypointId).toBe('p')
    } finally {
      rmSync(single.path, { recursive: true, force: true })
    }
  })

  it('names the plugin when it is not installed', async () => {
    await expect(open({ pluginId: 'nope' })).rejects.toThrow(/no plugin 'nope'/u)
  })

  it('names the entrypoint when it does not exist', async () => {
    await expect(open({ pluginId: 'fixture.viewer', entrypointId: 'nope' })).rejects.toThrow(/no entrypoint 'nope'/u)
  })

  it('refuses an entrypoint that is not for this platform, and says which', async () => {
    await expect(
      client.call('plugin.action.invoke', { pluginId: 'fixture.viewer', actionId: 'linux-only' } as never)
    ).rejects.toThrow(/linux/u)
  })

  it('opens an action in a pane, which is what criterion 3 asks for', async () => {
    const result = await open({ pluginId: 'fixture.viewer', entrypointId: 'echo-env' })
    expect(result.entrypointId).toBe('echo-env')
    expect(result.placement).toBe('split')
  })
})

describe('plugin.action.invoke', () => {
  it('runs headless and hands back what the action printed', async () => {
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'echo-env'
    } as never)
    expect(result.code).toBe(0)
    const [pluginId, binPath] = result.stdout.trim().split('\n')
    expect(pluginId).toBe('fixture.viewer')
    // The shim, not a binary called `herdr`. PHASE-10 decision 4.
    expect(binPath).toBe(store.shimPath)
    expect(binPath?.endsWith('/herdr-compat')).toBe(true)
  })

  it('truncates output past the cap and reports it, rather than buffering it', async () => {
    // 200 KiB from a 64 KiB cap.
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'noisy'
    } as never)
    expect(result.truncated).toBe(true)
    expect(result.stdout.length).toBe(64 * 1024)
    expect(result.code).toBe(0)
  })

  it('names an action that does not exist', async () => {
    await expect(
      client.call('plugin.action.invoke', { pluginId: 'fixture.viewer', actionId: 'nope' } as never)
    ).rejects.toThrow(/no action 'nope'/u)
  })
})

describe('where a plugin starts', () => {
  it('runs from its own root, not from the user\u2019s directory', async () => {
    // herdr's `plugin_pane_cwd` and its action runner both default to `plugin_root`.
    // This host copied the obvious-looking thing instead — the focused pane's cwd — and
    // it survived every fixture, because a fixture declares an absolute `sh`.
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'where'
    } as never)
    // `realpathSync` because macOS resolves the temp root through /private, and `pwd`
    // in a shell reports the resolved form.
    expect(result.stdout.trim()).toBe(realpathSync(store.rootFor('fixture.viewer')))
  })

  it('can therefore spawn a relative program, which is how a real plugin declares one', async () => {
    // `herdr-file-viewer`'s manifest is `command = ["./target/release/herdr-file-viewer"]`.
    // Started anywhere else that program is not there: the pane's process dies at once
    // and the pane closes itself a frame later, which looks exactly like a plugin that
    // opened and instantly crashed with nothing on screen to read. Found by installing
    // the real thing, not by a fixture.
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'relative'
    } as never)
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('relative program ran')
  })

  it('still tells the plugin where the user actually is', async () => {
    // The viewer opens on the *user's* repository while running from its own directory,
    // and this is the field it reads to do that.
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'dump-env'
    } as never)
    const line = result.stdout.split('\n').find((candidate) => candidate.startsWith('HERDR_PLUGIN_CONTEXT_JSON='))
    const context = JSON.parse(line?.slice('HERDR_PLUGIN_CONTEXT_JSON='.length) ?? '{}') as Record<string, unknown>
    expect(context['focused_pane_cwd']).not.toBe(store.rootFor('fixture.viewer'))
  })

  it('lets an explicit --cwd win', async () => {
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'where',
      cwd: '/tmp'
    } as never)
    expect(result.stdout.trim().endsWith('/tmp')).toBe(true)
  })
})

describe('what a plugin learns about the host', () => {
  async function herdrEnv(): Promise<Record<string, string>> {
    const result = await client.call('plugin.action.invoke', {
      pluginId: 'fixture.viewer',
      actionId: 'dump-env'
    } as never)
    const env: Record<string, string> = {}
    for (const line of result.stdout.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
    }
    return env
  }

  it('gets herdr\u2019s environment variable names', async () => {
    // A launcher script reads `$HERDR_PLUGIN_ROOT` and does not care which program set
    // it, so the names are herdr's from `env.rs` and `panes.rs`.
    const env = await herdrEnv()
    expect(env['HERDR_PLUGIN_ID']).toBe('fixture.viewer')
    expect(env['HERDR_PLUGIN_ROOT']).toBe(store.rootFor('fixture.viewer'))
    expect(env['HERDR_PLUGIN_CONFIG_DIR']).toBe(store.configDirFor('fixture.viewer'))
    expect(env['HERDR_PLUGIN_STATE_DIR']).toBe(store.stateDirFor('fixture.viewer'))
    expect(env['HERDR_PLUGIN_ENTRYPOINT_ID']).toBe('dump-env')
  })

  it('points HERDR_BIN_PATH at the shim, not at anything called herdr', async () => {
    // PHASE-10 decision 4: the mechanism is herdr's, the impersonation is not.
    const env = await herdrEnv()
    expect(env['HERDR_BIN_PATH']).toBe(store.shimPath)
    expect(env['HERDR_BIN_PATH']?.endsWith('/herdr-compat')).toBe(true)
  })

  it('carries a context JSON naming the pane it was launched from', async () => {
    const env = await herdrEnv()
    const context = JSON.parse(env['HERDR_PLUGIN_CONTEXT_JSON'] ?? '{}') as Record<string, unknown>
    expect(context['invocation_source']).toBe('leap-chorus')
    expect(context['focused_pane_id']).toBe((await state()).focusedPaneId)
    expect(typeof context['focused_pane_cwd']).toBe('string')
  })
})
