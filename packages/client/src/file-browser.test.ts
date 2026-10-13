import { describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '@leap-chorus/daemon'
import type { FsListResult, PreviewResult } from '@leap-chorus/protocol'
import { FileBrowser } from './file-browser.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function listing(root: string, path = '', names = ['src/']): FsListResult {
  return { root, path, entries: names.map((name) => ({
    name: name.replace(/\/$/u, ''), kind: name.endsWith('/') ? 'dir' : 'file', link: false
  })) }
}

function preview(lines: string[]): PreviewResult {
  return { path: 'a.ts', lines, renderer: 'plain', binary: false, truncated: false, cap: null, size: 20 }
}

function setup(handler: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const call = vi.fn(handler)
  const browser = new FileBrowser()
  browser.connect('pane-a', { call } as unknown as Pick<DaemonClient, 'call'>, () => {})
  return { browser, call }
}

describe('file browser requests', () => {
  it('refreshes expanded folders, not just the root', async () => {
    let names = ['old.ts']
    const { browser, call } = setup(async (method, params) => {
      if (method === 'git.status') throw new Error('no git')
      return listing('/a', String(params.path), params.path ? names : ['src/'])
    })
    await browser.list('')
    await browser.list('src')
    names = ['old.ts', 'new.ts']
    await browser.refresh()
    expect(browser.explorer.rows().map((row) => row.node.path)).toContain('src/new.ts')
    expect(call).toHaveBeenCalledWith('fs.list', { paneId: 'pane-a', root: '/a', path: 'src' })
  })

  it('ignores an older directory listing that completes last', async () => {
    const old = deferred<FsListResult>()
    const { browser } = setup(async () => old.promise)
    browser.explorer.adopt('/a', '', [])
    const first = browser.list('')
    const second = browser.list('')
    old.resolve(listing('/a', '', ['fresh.ts']))
    await Promise.all([first, second])
    expect(browser.explorer.rows().map((row) => row.node.path)).toEqual(['fresh.ts'])
  })

  it('does not mix a late child listing into another root', async () => {
    const child = deferred<FsListResult>()
    const { browser } = setup(async (_method, params) => params.path ? child.promise : listing('/b'))
    browser.explorer.adopt('/a', '', listing('/a').entries)
    const pending = browser.list('src')
    await browser.list('', true)
    child.resolve(listing('/a', 'src', ['only-a.ts']))
    await pending
    expect(browser.explorer.root).toBe('/b')
    expect(browser.explorer.rows().map((row) => row.node.path)).toEqual(['src'])
  })

  it('pins listing requests to the displayed root', async () => {
    const { browser, call } = setup(async (method) => {
      if (method === 'git.status') throw new Error('no git')
      return listing('/a')
    })
    browser.explorer.adopt('/a', '', [])
    browser.pinned = true
    await browser.refresh()
    expect(call).toHaveBeenCalledWith('fs.list', { paneId: 'pane-a', root: '/a', path: '' })
  })

  it('coalesces simultaneous refreshes', async () => {
    const root = deferred<FsListResult>()
    const { browser, call } = setup(async (method) => {
      if (method === 'git.status') throw new Error('no git')
      return root.promise
    })
    const first = browser.refresh()
    const second = browser.refresh()
    root.resolve(listing('/a', '', []))
    await Promise.all([first, second])
    expect(call.mock.calls.filter(([method]) => method === 'fs.list')).toHaveLength(1)
  })

  it('rejects same-path preview replies from older requests', async () => {
    const old = deferred<PreviewResult>()
    let reads = 0
    const { browser } = setup(async () => ++reads === 1 ? old.promise : preview(['new']))
    browser.explorer.adopt('/a', '', [])
    const first = browser.read('a.ts', 80)
    await browser.read('a.ts', 80)
    old.resolve(preview(['old']))
    await first
    expect(browser.preview.result?.lines).toEqual(['new'])
  })

  it('invalidates an in-flight preview when the root changes', async () => {
    const old = deferred<PreviewResult>()
    const { browser } = setup(async (method) => method === 'preview.read' ? old.promise : listing('/b'))
    browser.explorer.adopt('/a', '', [])
    const read = browser.read('a.ts', 80)
    await browser.list('', true)
    old.resolve(preview(['wrong repository']))
    await read
    expect(browser.preview.result).toBeNull()
  })
})
