/**
 * `leap-chorus plugin …` and the `$HERDR_BIN_PATH` shim, as real child processes.
 *
 * PHASE-10 criteria 2, 4 and 5. Run through the built binary rather than by calling the
 * functions, because the promise these make is to a *script*: an exit code, stdout that
 * parses, and — for the shim — a plugin's launcher invoking it the way herdr's does,
 * with nothing of ours on the path.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFixtureRepo, fixtureFiles, type FixtureRepo } from '../../daemon/test/plugin-fixture.js'
import { CLIENT_ENTRY, TuiHarness } from './harness.js'

const run = promisify(execFile)

let harness: TuiHarness | null = null
let repo: FixtureRepo
let dataRoot: string

const MANIFEST = `id = "fixture.viewer"
name = "Fixture Viewer"
version = "0.1.0"
description = "A plugin that exists to be installed"

[[build]]
command = ["sh", "-c", "printf built > built-marker"]

[[panes]]
id = "viewer"
title = "Fixture Viewer"
placement = "split"
command = ["sh", "-c", "printf 'viewer ready'; cat"]

[[actions]]
id = "hello"
title = "Say hello"
command = ["sh", "-c", "printf hello"]

[[events]]
on = "pane.exit"
command = ["true"]
`

beforeEach(() => {
  repo = createFixtureRepo(fixtureFiles({ manifest: MANIFEST }))
  dataRoot = mkdtempSync(join(tmpdir(), 'hrd-cli-'))
})

afterEach(async () => {
  await harness?.stop()
  harness = null
  rmSync(repo.path, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
})

interface Ran {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

async function cli(root: string, ...args: string[]): Promise<Ran> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLIENT_ENTRY, '--data-root', root, ...args], {
      // A plugin install must not inherit the outer test's data root by accident.
      env: { ...process.env, LEAP_CHORUS_DATA_DIR: root }
    })
    return { stdout, stderr, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
  }
}

// ---------------------------------------------------------------------------
// Criterion 2 — install through the CLI, against a local fixture
// ---------------------------------------------------------------------------

describe('plugin install', () => {
  it('installs and reports the pin it recorded', async () => {
    const result = await cli(dataRoot, 'plugin', 'install', repo.path, '--yes')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Installed fixture.viewer 0.1.0')
    expect(result.stdout).toMatch(/pinned {2}sha256:[0-9a-f]{64}/u)
    expect(readFileSync(join(dataRoot, 'plugins', 'store', 'fixture.viewer', 'built-marker'), 'utf8')).toBe('built')
  })

  it('shows what it will run, and names what it will not honour', async () => {
    // The `[[events]]` in the fixture manifest never fires here. A plugin that appears
    // installed and quietly does nothing is the failure this line exists to prevent.
    const result = await cli(dataRoot, 'plugin', 'install', repo.path, '--yes')
    expect(result.stdout).toContain('printf built > built-marker')
    expect(result.stdout).toContain('[[events]]')
    expect(result.stdout).toContain('this host does not run those')
  })

  it('refuses a non-interactive install that did not say --yes', async () => {
    // herdr's rule, and the one that stops `plugin install` being something a script
    // can do to a user.
    const result = await cli(dataRoot, 'plugin', 'install', repo.path)
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--yes')
    expect(existsSync(join(dataRoot, 'plugins', 'registry.json'))).toBe(false)
  })

  it('reports a bad source with a code and a sentence, not a stack', async () => {
    const result = await cli(dataRoot, 'plugin', 'install', 'not-a-source', '--yes')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('invalid_plugin_source')
    expect(result.stderr).not.toContain('at Object.')
  })
})

// ---------------------------------------------------------------------------
// Criterion 4 — the JSON a launcher parses
// ---------------------------------------------------------------------------

describe('plugin list --json', () => {
  interface ListedPlugin {
    plugin_id: string
    name: string
    version: string
    plugin_root: string
    manifest_path: string
    config_dir: string
    enabled: boolean
    panes: { id: string; title: string; placement: string; command: string[] }[]
    actions: { action_id: string; title: string; command: string[] }[]
    source: { kind: string; ref: string | null; commit: string; content_hash: string }
    installed_hash: string
  }

  async function listed(): Promise<{ shim_path: string; plugins: ListedPlugin[] }> {
    await cli(dataRoot, 'plugin', 'install', repo.path, '--yes')
    const result = await cli(dataRoot, 'plugin', 'list', '--json')
    expect(result.code).toBe(0)
    return JSON.parse(result.stdout) as { shim_path: string; plugins: ListedPlugin[] }
  }

  it('uses herdr’s field names, in herdr’s snake_case', async () => {
    // A script written against herdr reads `plugin_id`, `plugin_root`, `panes[].id`
    // and `actions[].action_id`. Renaming one of our own protocol fields must not
    // quietly break it, which is why this is pinned rather than inferred.
    const { plugins } = await listed()
    const plugin = plugins[0] as ListedPlugin
    expect(Object.keys(plugin)).toEqual(
      expect.arrayContaining([
        'plugin_id',
        'name',
        'version',
        'description',
        'plugin_root',
        'manifest_path',
        'config_dir',
        'state_dir',
        'enabled',
        'platforms',
        'panes',
        'actions',
        'source'
      ])
    )
    expect(plugin.plugin_id).toBe('fixture.viewer')
    expect(plugin.panes[0]).toMatchObject({ id: 'viewer', title: 'Fixture Viewer', placement: 'split' })
    expect(plugin.actions[0]).toMatchObject({ action_id: 'hello', title: 'Say hello' })
    expect(plugin.actions[0]?.command).toEqual(['sh', '-c', 'printf hello'])
  })

  it('reports enabled, which this host always is, so a filtering script sees the plugin', async () => {
    const { plugins } = await listed()
    expect(plugins[0]?.enabled).toBe(true)
  })

  it('adds the pin and the shim path, which herdr has no counterpart for', async () => {
    const result = await listed()
    expect(result.shim_path.endsWith('/herdr-compat')).toBe(true)
    expect(result.plugins[0]?.source.commit).toBe(repo.head())
    expect(result.plugins[0]?.source.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(result.plugins[0]?.installed_hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('answers with an empty list rather than an error when nothing is installed', async () => {
    const result = await cli(dataRoot, 'plugin', 'list', '--json')
    expect(result.code).toBe(0)
    expect((JSON.parse(result.stdout) as { plugins: unknown[] }).plugins).toEqual([])
  })

  it('works with no daemon running', async () => {
    // The registry is a file. The first install happens before anyone opens the TUI.
    const result = await cli(dataRoot, 'plugin', 'list')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no plugins installed')
  })
})

describe('plugin verify and remove', () => {
  it('verifies a fresh install, then reports a file changed underneath it', async () => {
    await cli(dataRoot, 'plugin', 'install', repo.path, '--yes')
    expect((await cli(dataRoot, 'plugin', 'verify')).stdout).toContain('ok')

    writeFileSync(join(dataRoot, 'plugins', 'store', 'fixture.viewer', 'built-marker'), 'tampered')
    const changed = await cli(dataRoot, 'plugin', 'verify')
    expect(changed.code).toBe(1)
    expect(changed.stdout).toContain('CHANGED')
  })

  it('removes a plugin and keeps its config, saying where it is', async () => {
    await cli(dataRoot, 'plugin', 'install', repo.path, '--yes')
    const removed = await cli(dataRoot, 'plugin', 'remove', 'fixture.viewer')
    expect(removed.code).toBe(0)
    expect(removed.stdout).toContain('config is still at')
    expect(existsSync(join(dataRoot, 'plugins', 'config', 'fixture.viewer'))).toBe(true)
    expect(existsSync(join(dataRoot, 'plugins', 'store', 'fixture.viewer'))).toBe(false)
  })

  it('reports removing something that was never installed', async () => {
    const result = await cli(dataRoot, 'plugin', 'remove', 'nothing')
    expect(result.code).toBe(1)
  })
})

describe('plugin config-dir', () => {
  it('prints the directory and creates it, because a launcher writes into it next', async () => {
    const result = await cli(dataRoot, 'plugin', 'config-dir', 'fixture.viewer')
    expect(result.code).toBe(0)
    const printed = result.stdout.trim()
    expect(printed).toBe(join(dataRoot, 'plugins', 'config', 'fixture.viewer'))
    expect(existsSync(printed)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Criterion 5 — the shim, invoked the way a plugin's launcher invokes it
// ---------------------------------------------------------------------------

describe('the $HERDR_BIN_PATH shim', () => {
  async function shimPath(root: string): Promise<string> {
    const result = await cli(root, 'plugin', 'shim')
    return result.stdout.trim()
  }

  /** Run the shim as a plugin would: through `$HERDR_BIN_PATH`, with herdr's argv. */
  async function viaShim(root: string, shim: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Ran> {
    try {
      const { stdout, stderr } = await run(shim, [...args], {
        env: { ...process.env, LEAP_CHORUS_DATA_DIR: root, HERDR_BIN_PATH: shim, ...env }
      })
      return { stdout, stderr, code: 0 }
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', code: failure.code ?? 1 }
    }
  }

  it('is written as an executable wrapper that says it is not herdr', async () => {
    const shim = await shimPath(dataRoot)
    expect(shim.endsWith('/herdr-compat')).toBe(true)
    const body = readFileSync(shim, 'utf8')
    expect(body).toContain('NOT herdr')
    expect(body).toContain('--compat herdr')
  })

  it('answers `pane list --json` in the shape herdr-file-viewer deserializes', async () => {
    // Not our own shape. `open-file-viewer.sh` pipes this straight into the viewer
    // binary's `launch_decision`, which reads `result.panes[].{pane_id,label,focused,
    // tab_id}` and answers OPEN for anything it cannot parse — so a bare camelCase
    // array would leave the plugin working and permanently unable to focus or close
    // its own pane.
    const tui = (harness = await TuiHarness.start({ cols: 100, rows: 30, command: '/bin/bash', args: ['--norc', '--noprofile'] }))
    await tui.waitForReady()
    const shim = await shimPath(tui.root)

    const shimmed = await viaShim(tui.root, shim, ['pane', 'list', '--json'])
    expect(shimmed.code).toBe(0)
    const parsed = JSON.parse(shimmed.stdout) as { result: { panes: Record<string, unknown>[] } }
    expect(parsed.result.panes.length).toBeGreaterThan(0)
    const pane = parsed.result.panes[0] as Record<string, unknown>
    expect(Object.keys(pane)).toEqual(
      expect.arrayContaining(['pane_id', 'label', 'focused', 'tab_id', 'workspace_id'])
    )
    expect(typeof pane['pane_id']).toBe('string')
    expect(typeof pane['tab_id']).toBe('string')
    expect(parsed.result.panes.some((candidate) => candidate['focused'] === true)).toBe(true)
  })

  it('answers `tab focus`, the sixth command the launchers use', async () => {
    const tui = (harness = await TuiHarness.start({ cols: 100, rows: 30, command: '/bin/bash', args: ['--norc', '--noprofile'] }))
    await tui.waitForReady()
    const shim = await shimPath(tui.root)
    const tabs = JSON.parse((await cli(tui.root, 'tab', 'list')).stdout) as { tabId: string }[]
    expect(tabs.length).toBeGreaterThan(0)
    expect((await viaShim(tui.root, shim, ['tab', 'focus', tabs[0]?.tabId as string])).code).toBe(0)
  })

  it('answers `plugin config-dir`, defaulting the id from $HERDR_PLUGIN_ID', async () => {
    const shim = await shimPath(dataRoot)
    const result = await viaShim(dataRoot, shim, ['plugin', 'config-dir'], { HERDR_PLUGIN_ID: 'fixture.viewer' })
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe(join(dataRoot, 'plugins', 'config', 'fixture.viewer'))
  })

  it('opens, zooms and closes a plugin pane — the rest of the five', async () => {
    const tui = (harness = await TuiHarness.start({ cols: 100, rows: 30, command: '/bin/bash', args: ['--norc', '--noprofile'] }))
    await tui.waitForReady()
    await cli(tui.root, 'plugin', 'install', repo.path, '--yes')
    const shim = await shimPath(tui.root)

    // `herdr plugin pane open --placement split`, with the ids from the environment,
    // which is how a launcher script written against herdr actually calls it.
    const opened = await viaShim(tui.root, shim, ['plugin', 'pane', 'open', '--placement', 'split'], {
      HERDR_PLUGIN_ID: 'fixture.viewer',
      HERDR_PLUGIN_ENTRYPOINT_ID: 'viewer'
    })
    expect(opened.code).toBe(0)
    const paneId = opened.stdout.trim()
    expect(paneId.length).toBeGreaterThan(0)

    expect((await viaShim(tui.root, shim, ['pane', 'zoom', paneId, '--on'])).code).toBe(0)
    expect((await viaShim(tui.root, shim, ['pane', 'zoom', paneId, '--off'])).code).toBe(0)
    expect((await viaShim(tui.root, shim, ['pane', 'close', paneId])).code).toBe(0)

    const after = JSON.parse((await cli(tui.root, 'pane', 'list')).stdout) as { paneId: string }[]
    expect(after.some((pane) => pane.paneId === paneId)).toBe(false)
  })

  it('tells a plugin plainly when it asks for something this host has no answer to', async () => {
    const shim = await shimPath(dataRoot)
    const result = await viaShim(dataRoot, shim, ['plugin', 'install', 'acme/tool'])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unsupported')
    expect(result.stderr).toContain('NOT herdr')
  })
})
