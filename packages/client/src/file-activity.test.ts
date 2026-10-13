import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@leap-chorus/daemon'
import type { AgentFileActivity } from '@leap-chorus/protocol'
import { FileBrowser } from './file-browser.js'
import { SidebarPanels } from './panel.js'

const browsers: FileBrowser[] = []
afterEach(() => {
  for (const browser of browsers.splice(0)) browser.dispose()
  vi.useRealTimers()
})

function setup() {
  vi.useFakeTimers()
  const browser = new FileBrowser()
  browsers.push(browser)
  const call = vi.fn(async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    if (method === 'git.status') throw new Error('no git')
    return { root: '/repo', path: params.path, entries: params.path ? [{ name: 'a.ts', kind: 'file', link: false }] : [{ name: 'src', kind: 'dir', link: false }] }
  })
  browser.connect('pane-a', { call } as unknown as Pick<DaemonClient, 'call'>, () => {})
  browser.explorer.adopt('/repo', '', [{ name: 'src', kind: 'dir', link: false }])
  browser.setVisible(true)
  return { browser, call }
}

function event(overrides: Partial<AgentFileActivity> = {}): AgentFileActivity {
  return { paneId: 'pane-a', agent: 'claude', kind: 'read', cwd: '/repo', path: '/repo/src/a.ts', seq: 1, at: Date.now(), ...overrides }
}

describe('pane-scoped file activity', () => {
  it('pauses follow as soon as the user navigates the tree', () => {
    const panels = new SidebarPanels('explorer')
    panels.browser.followActivity = true
    panels.handleKey({ name: 'down', ctrl: false, alt: false, shift: false })
    expect(panels.browser.followActivity).toBe(false)
  })

  it('does not replay stale hidden activity into the selection', async () => {
    const { browser } = setup()
    browser.setVisible(false)
    browser.followActivity = true
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(5_000)
    browser.setVisible(true)
    await vi.advanceTimersByTimeAsync(250)
    expect(browser.explorer.selected()?.path).toBe('src')
    expect(browser.explorer.activityNote).toBe('')
  })

  it('cancels a pending reveal when follow is turned off', async () => {
    const { browser, call } = setup()
    let complete!: (value: unknown) => void
    call.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    browser.followActivity = true
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(250)
    browser.followActivity = false
    complete({ root: '/repo', path: 'src', entries: [{ name: 'a.ts', kind: 'file', link: false }] })
    await vi.advanceTimersByTimeAsync(1)
    expect(browser.explorer.selected()?.path).toBe('src')
  })

  it('does not let an older reveal move selection after newer activity arrives', async () => {
    const { browser, call } = setup()
    let complete!: (value: unknown) => void
    call.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    browser.followActivity = true
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(250)
    browser.noteActivity(event({ path: '/repo/src/b.ts', seq: 2 }))
    complete({ root: '/repo', path: 'src', entries: [{ name: 'a.ts', kind: 'file', link: false }] })
    await vi.advanceTimersByTimeAsync(1)
    expect(browser.explorer.selected()?.path).toBe('src')
  })

  it('does not schedule expiry work after disposal during a reveal', async () => {
    const { browser, call } = setup()
    let complete!: (value: unknown) => void
    call.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    browser.followActivity = true
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(250)
    browser.dispose()
    complete({ root: '/repo', path: 'src', entries: [] })
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('restores recent activity once and tolerates an older daemon', async () => {
    const { browser, call } = setup()
    call.mockResolvedValueOnce({ events: [event()] } as never)
    await browser.restoreActivity()
    await browser.restoreActivity()
    await vi.advanceTimersByTimeAsync(250)
    expect(call).toHaveBeenCalledTimes(1)
    expect(browser.explorer.activity.get('src/a.ts')).toBe('read')
    const older = setup()
    older.call.mockRejectedValueOnce(new Error('unknown method'))
    await expect(older.browser.restoreActivity()).resolves.toBeUndefined()
  })

  it('does not move selection or fetch directories while follow is off', async () => {
    const { browser, call } = setup()
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(250)
    expect(call).not.toHaveBeenCalled()
    expect(browser.explorer.selected()?.path).toBe('src')
    expect(browser.explorer.activity.get('src/a.ts')).toBe('read')
    expect(browser.explorer.activityNote).toContain('claude read')
    await vi.advanceTimersByTimeAsync(4_000)
    expect(browser.explorer.activity.size).toBe(0)
  })

  it('reveals the active file only when follow is enabled', async () => {
    const { browser } = setup()
    browser.preview.request('manual.ts')
    browser.preview.adopt({ path: 'manual.ts', lines: ['my chosen file'], renderer: 'plain', binary: false, truncated: false, cap: null, size: 14 })
    browser.followActivity = true
    browser.noteActivity(event())
    await vi.advanceTimersByTimeAsync(250)
    expect(browser.explorer.selected()?.path).toBe('src/a.ts')
    expect(browser.preview.result?.path).toBe('manual.ts')
  })

  it('discovers a root-level file that was absent from the cached tree', async () => {
    const { browser, call } = setup()
    call.mockResolvedValueOnce({ root: '/repo', path: '', entries: [{ name: 'new.ts', kind: 'file', link: false }] })
    browser.followActivity = true
    browser.noteActivity(event({ path: '/repo/new.ts' }))
    await vi.advanceTimersByTimeAsync(250)
    expect(browser.explorer.selected()?.path).toBe('new.ts')
  })

  it('does not treat text input or unified source-control keys as tree follow controls', () => {
    const panels = new SidebarPanels('search')
    panels.handleKey({ name: 'char', char: 'a', ctrl: false, alt: false, shift: false })
    expect(panels.search.query).toBe('a')
    expect(panels.browser.followActivity).toBe(false)
    panels.show('scm')
    panels.applySettings({ layout: 'unified', icons: 'ascii', gitFooter: false, preview: true })
    panels.browser.followActivity = true
    expect(panels.handleKey({ name: 'char', char: 'a', ctrl: false, alt: false, shift: false }).view).toBe('scm')
    expect(panels.browser.followActivity).toBe(true)
  })

  it('ignores another pane and paths outside the root', async () => {
    const { browser, call } = setup()
    browser.noteActivity(event({ paneId: 'pane-b' }))
    browser.noteActivity(event({ path: '/repo-other/a.ts', seq: 2 }))
    await vi.advanceTimersByTimeAsync(250)
    expect(browser.explorer.activity.size).toBe(0)
    expect(call).not.toHaveBeenCalled()
  })

  it('coalesces a burst of writes into one refresh and rejects stale events', async () => {
    const { browser, call } = setup()
    browser.noteActivity(event({ kind: 'write', seq: 2 }))
    browser.noteActivity(event({ kind: 'read', seq: 1 }))
    browser.noteActivity(event({ kind: 'write', seq: 3 }))
    await vi.advanceTimersByTimeAsync(250)
    expect(call.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(1)
    expect(browser.explorer.activity.get('src/a.ts')).toBe('write')
  })

  it('does no filesystem work for a hidden dock and cancels work on dispose', async () => {
    const { browser, call } = setup()
    browser.setVisible(false)
    browser.noteActivity(event({ kind: 'write' }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(call).not.toHaveBeenCalled()
    browser.setVisible(true)
    browser.dispose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(call).not.toHaveBeenCalled()
  })
})
