import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient } from '@leap-chorus/daemon'
import { TuiHarness, waitUntil } from './harness.js'

let tui: TuiHarness | null = null
let client: DaemonClient | null = null
const dirs: string[] = []

afterEach(async () => {
  client?.close()
  client = null
  await tui?.stop()
  tui = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function folder(name: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lc-tree-')))
  dirs.push(dir)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', name), 'export const original = 1\n')
  return dir
}

async function start(cwd: string): Promise<TuiHarness> {
  tui = await TuiHarness.start({ cols: 160, rows: 30, cwd, command: '/bin/bash', args: ['--norc', '--noprofile'], config: '[sidebar]\npreview = true\n' })
  await tui.waitForReady()
  ;({ client } = await DaemonClient.connect({ socketPath: tui.paths.socketPath, clientName: 'browser-test' }))
  tui.command('e')
  await tui.waitForText('src/')
  tui.write('\r')
  return tui
}

describe('the native browser in a real terminal', () => {
  it('stages in the pinned tree even when the same shell changes repository', async () => {
    const a = folder('a.ts')
    const b = folder('a.ts')
    for (const root of [a, b]) execFileSync('git', ['init', '--quiet', root])
    const harness = await start(a)
    await harness.waitForText('a.ts')
    harness.write('p')
    await harness.waitForText('p pinned')
    const state = (await client!.call('state.get', {})).state
    const pane = state.panes.find((pane) => pane.paneId === state.focusedPaneId)!
    await client!.call('session.write', { id: pane.sessionId!, data: `cd '${b}'\r` })
    await waitUntil(async () => (await client!.call('git.status', { paneId: pane.paneId })).root === b, () => 'shell cwd did not change')
    harness.write('js')
    await waitUntil(async () => {
      const statuses = await Promise.all([a, b].map((cwd) => client!.call('git.status', { cwd })))
      return statuses.some((status) => status.staged.length > 0)
    }, () => 'stage never completed')
    expect((await client!.call('git.status', { cwd: a })).staged.map((entry) => entry.path)).toEqual(['src/a.ts'])
    expect((await client!.call('git.status', { cwd: b })).staged).toEqual([])
  })

  it('applies follow-pane changes to an already open browser', async () => {
    const a = folder('only-a.ts')
    const b = folder('only-b.ts')
    const harness = await start(a)
    await harness.waitForText('only-a.ts')
    harness.rewriteConfig('[sidebar]\npreview = true\nfollow-pane = false\n')
    harness.command('R')
    await harness.waitForText('p pinned')
    await client!.call('pane.split', { direction: 'right', cwd: b, command: '/bin/bash', args: ['--norc', '--noprofile'], focus: true })
    expect(await harness.screen()).toContain('only-a.ts')
    harness.rewriteConfig('[sidebar]\npreview = true\nfollow-pane = true\n')
    harness.command('R')
    await harness.waitForScreen((screen) => !screen.includes('only-a.ts') && screen.includes('src/'), 'follow-pane did not resume')
  })

  it('refreshes agent-created files and the open preview without following another file', async () => {
    const root = folder('a.ts')
    const harness = await start(root)
    await harness.waitForText('a.ts')
    const paneId = (await client!.call('state.get', {})).state.focusedPaneId!
    harness.write('j\r')
    await harness.waitForText('export const original = 1')
    expect(await harness.screen()).toContain('syntax')
    expect(await harness.screen()).toContain('src/')
    writeFileSync(join(root, 'src', 'b.ts'), 'const otherFile = 2\n')
    await client!.call('agent.report', { paneId, agent: 'claude', source: 'test', state: 'working', seq: 1,
      activity: { kind: 'write', cwd: root, path: 'src/b.ts' } })
    await harness.waitForText('b.ts')
    expect(await harness.screen()).toContain('export const original = 1')
    expect(await harness.screen()).not.toContain('const otherFile = 2')
    writeFileSync(join(root, 'src', 'a.ts'), 'export const updated = 3\n')
    await client!.call('agent.report', { paneId, agent: 'claude', source: 'test', state: 'working', seq: 2,
      activity: { kind: 'write', cwd: root, path: 'src/a.ts' } })
    await harness.waitForText('export const updated = 3')
  })

  it('isolates pane roots and lets the browser stay pinned while focus moves', async () => {
    const a = folder('only-a.ts')
    const b = folder('only-b.ts')
    const harness = await start(a)
    await harness.waitForText('only-a.ts')
    const paneA = (await client!.call('state.get', {})).state.focusedPaneId!
    await client!.call('pane.split', { direction: 'right', cwd: b, command: '/bin/bash', args: ['--norc', '--noprofile'], focus: true })
    await harness.waitForScreen((screen) => !screen.includes('only-a.ts') && screen.includes('src/'), 'the old root survived a pane switch')
    harness.write('\r')
    await harness.waitForText('only-b.ts')
    harness.write('p')
    await harness.waitForText('p pinned')
    await client!.call('pane.focus', { paneId: paneA })
    await client!.call('agent.report', { paneId: paneA, agent: 'claude', source: 'test', state: 'working', seq: 1,
      activity: { kind: 'write', cwd: a, path: 'src/only-a.ts' } })
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(await harness.screen()).toContain('only-b.ts')
    expect(await harness.screen()).not.toContain('only-a.ts')
    harness.write('p')
    await harness.waitForText('only-a.ts')
    expect(await harness.screen()).not.toContain('only-b.ts')
  })
})
