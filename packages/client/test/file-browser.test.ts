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

async function start(cwd: string, dock: 'left' | 'right' = 'left'): Promise<TuiHarness> {
  tui = await TuiHarness.start({ cols: 160, rows: 30, cwd, command: '/bin/bash', args: ['--norc', '--noprofile'], config: `[sidebar]\npreview = true\ndock = "${dock}"\n` })
  await tui.waitForReady()
  ;({ client } = await DaemonClient.connect({ socketPath: tui.paths.socketPath, clientName: 'browser-test' }))
  tui.command('e')
  await tui.waitForText('src/')
  tui.write('\r')
  return tui
}

const mouse = (button: number, column: number, row: number, release = false) =>
  `\x1b[<${button};${column + 1};${row + 1}${release ? 'm' : 'M'}`

function dockEdge(screen: string, dock: 'left' | 'right'): number {
  const header = screen.split('\n')[1] ?? ''
  return dock === 'left' ? header.indexOf('╭') - 1 : header.indexOf('╮') + 1
}

function treeEdge(screen: string): number {
  return (screen.split('\n')[1] ?? '').indexOf('▸ src/a.ts') - 1
}

describe('the native browser in a real terminal', () => {
  it.each(['left', 'right'] as const)('resizes the preview dock on the %s without changing the file', async (dock) => {
    const harness = await start(folder('a.ts'), dock)
    await harness.waitForText('a.ts')
    harness.write('j\r')
    const initial = await harness.waitForText('export const original = 1')
    const edge = dockEdge(initial, dock)
    expect(edge).toBeGreaterThan(0)
    const target = edge + (dock === 'left' ? 20 : -20)
    harness.write(mouse(0, edge, 12))
    harness.write(mouse(35, target, 12))
    harness.write(mouse(32, target, 12))
    harness.write(mouse(0, target, 12, true))
    const widened = await harness.waitForScreen((screen) => dockEdge(screen, dock) === target, 'preview dock did not widen', 3_000)
    expect(widened).toContain('export const original = 1')
    const smaller = edge + (dock === 'left' ? -10 : 10)
    harness.write(mouse(0, target, 12))
    harness.write(mouse(32, smaller, 12))
    harness.write(mouse(0, smaller, 12, true))
    await harness.waitForScreen((screen) => dockEdge(screen, dock) === smaller, 'preview dock did not shrink')
    harness.write(mouse(35, target, 12))
    harness.write(mouse(32, target, 12))
    harness.write('w')
    const released = await harness.waitForText('wrap')
    expect(dockEdge(released, dock)).toBe(smaller)
    harness.write(mouse(0, smaller, 12))
    harness.write('1')
    await harness.waitForText('h/l fold')
    harness.write(mouse(32, target, 12))
    harness.write(mouse(0, target, 12, true))
    harness.write('a')
    const cancelled = await harness.waitForText('follow:on')
    expect(dockEdge(cancelled, dock)).toBe(dock === 'left' ? 33 : 126)
  })

  it.each(['left', 'right'] as const)('drags the tree/preview divider on the %s and keeps capture outside the dock', async (dock) => {
    const harness = await start(folder('a.ts'), dock)
    await harness.waitForText('a.ts')
    harness.write('j\r')
    const initial = await harness.waitForText('export const original = 1')
    const edge = treeEdge(initial)
    const outer = dockEdge(initial, dock)
    expect(edge).toBeGreaterThan(0)
    harness.write(mouse(0, edge, 5))
    harness.write(mouse(32, dock === 'left' ? 130 : 5, 5))
    harness.write(mouse(35, edge - 5, 5))
    harness.write(mouse(32, edge - 5, 5))
    harness.write(mouse(0, edge - 5, 5, true))
    const resized = await harness.waitForScreen((screen) => treeEdge(screen) === edge - 5, 'tree/preview divider did not move', 3_000)
    expect(dockEdge(resized, dock)).toBe(outer)
    expect(resized).toContain('export const original = 1')
    harness.write(mouse(32, edge + 5, 5))
    harness.write('w')
    expect(treeEdge(await harness.waitForText('wrap'))).toBe(edge - 5)
  })

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
