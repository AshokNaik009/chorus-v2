/**
 * `leap-chorus pane …` — pane control without a terminal attached.
 *
 * Run as a real child process against a real daemon, because the promise these make is
 * to a *script*: exit codes, stdout that parses, and never starting a daemon just to
 * answer a question about one. Calling the functions directly would test none of that.
 *
 * The verbs and flags mirror herdr's CLI, which is what tools written against herdr —
 * its plugin launchers among them — actually invoke.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CLIENT_ENTRY, TuiHarness } from './harness.js'

const run = promisify(execFile)

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function start(): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 100,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile']
  })
  await harness.waitForReady()
  return harness
}

/** Invoke the CLI against this harness's daemon. Returns stdout and the exit code. */
async function cli(tui: TuiHarness, ...args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await run(process.execPath, [CLIENT_ENTRY, '--data-root', tui.root, ...args])
    return { stdout, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; code?: number }
    return { stdout: failure.stdout ?? '', code: failure.code ?? 1 }
  }
}

interface ListedPane {
  paneId: string
  focused: boolean
  exited: boolean
  cwd: string
}

async function list(tui: TuiHarness): Promise<ListedPane[]> {
  const { stdout, code } = await cli(tui, 'pane', 'list')
  expect(code).toBe(0)
  return JSON.parse(stdout) as ListedPane[]
}

describe('leap-chorus pane', () => {
  it('lists the session as JSON, marking the focused pane', async () => {
    const tui = await start()
    const panes = await list(tui)
    expect(panes).toHaveLength(1)
    expect(panes[0]?.paneId).toBeTruthy()
    expect(panes[0]?.focused).toBe(true)
    expect(panes[0]?.exited).toBe(false)
  })

  it('opens a pane and prints the new id', async () => {
    const tui = await start()
    const { stdout, code } = await cli(tui, 'pane', 'open', '--right')
    expect(code).toBe(0)
    const created = stdout.trim()
    expect(created).toBeTruthy()

    await tui.waitForText('2 panes')
    const panes = await list(tui)
    expect(panes).toHaveLength(2)
    expect(panes.map((pane) => pane.paneId)).toContain(created)
    // `--no-focus` was not passed, so the new pane took focus.
    expect(panes.find((pane) => pane.paneId === created)?.focused).toBe(true)
  })

  it('leaves focus alone with --no-focus', async () => {
    const tui = await start()
    const before = (await list(tui))[0]?.paneId
    const { stdout } = await cli(tui, 'pane', 'open', '--down', '--no-focus')
    await tui.waitForText('2 panes')

    const panes = await list(tui)
    expect(panes.find((pane) => pane.focused)?.paneId).toBe(before)
    expect(stdout.trim()).not.toBe(before)
  })

  it('closes a pane by id', async () => {
    const tui = await start()
    const { stdout } = await cli(tui, 'pane', 'open')
    const created = stdout.trim()
    await tui.waitForText('2 panes')

    const { code } = await cli(tui, 'pane', 'close', created)
    expect(code).toBe(0)
    await tui.waitForText('1 pane')
    expect(await list(tui)).toHaveLength(1)
  })

  it('focuses a pane by id', async () => {
    const tui = await start()
    const first = (await list(tui))[0]?.paneId as string
    await cli(tui, 'pane', 'open')
    await tui.waitForText('2 panes')

    expect((await cli(tui, 'pane', 'focus', first)).code).toBe(0)
    const panes = await list(tui)
    expect(panes.find((pane) => pane.focused)?.paneId).toBe(first)
  })

  it('zooms explicitly with --on and --off', async () => {
    const tui = await start()
    await cli(tui, 'pane', 'open')
    await tui.waitForText('2 panes')

    expect((await cli(tui, 'pane', 'zoom', '--on')).code).toBe(0)
    await tui.waitForText('zoom')
    // Asking for `--on` twice must leave it on, not toggle it back off.
    expect((await cli(tui, 'pane', 'zoom', '--on')).code).toBe(0)
    expect(await tui.screen()).toContain('zoom')

    expect((await cli(tui, 'pane', 'zoom', '--off')).code).toBe(0)
    await tui.waitForScreen((s) => !s.includes('zoom'), 'the pane never unzoomed')
  })

  it('reports a missing id rather than guessing', async () => {
    const tui = await start()
    const { code } = await cli(tui, 'pane', 'close')
    expect(code).toBe(2)
  })

  it('rejects an unknown verb', async () => {
    const tui = await start()
    const { code } = await cli(tui, 'pane', 'teleport')
    expect(code).toBe(2)
  })
})
