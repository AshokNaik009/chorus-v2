/**
 * The preview view: wrapping, scrolling, and saying what it is not showing.
 *
 * The daemon half of criteria 2-5 is in `packages/daemon/src/preview.test.ts`. This is
 * the half the user touches: a plain object that decides what a keystroke means and
 * performs nothing, driven directly — the same arrangement `search.test.ts` uses.
 */

import { describe, expect, it } from 'vitest'
import { ScreenBuffer, type Rect } from '@leap-chorus/tui'
import type { PreviewResult } from '@leap-chorus/protocol'
import type { Palette } from './chrome.js'
import { PreviewPanel, formatSize, sliceColumns } from './preview.js'
import { SidebarPanels } from './panel.js'
import type { PanelKey } from './search.js'

const area: Rect = { x: 0, y: 0, width: 34, height: 12 }

function key(name: string, char?: string, modifiers: Partial<PanelKey> = {}): PanelKey {
  return { name, char, alt: false, ctrl: false, shift: false, ...modifiers }
}

function result(overrides: Partial<PreviewResult> = {}): PreviewResult {
  return {
    path: 'src/app.ts',
    renderer: 'plain',
    lines: Array.from({ length: 40 }, (_, index) => `line ${index}`),
    binary: false,
    truncated: false,
    cap: null,
    size: 400,
    ...overrides
  }
}

const palette = {
  sidebar: { fg: 7, bg: -1, attrs: 0 },
  sidebarActive: { fg: 0, bg: 6, attrs: 0 },
  paneTitle: { fg: 7, bg: -1, attrs: 0 },
  agent: {
    idle: { fg: 8, bg: -1, attrs: 0 },
    working: { fg: 3, bg: -1, attrs: 0 },
    blocked: { fg: 1, bg: -1, attrs: 0 },
    done: { fg: 2, bg: -1, attrs: 0 }
  }
} as unknown as Palette

describe('taking a result', () => {
  it('shows the lines it was given', () => {
    const panel = new PreviewPanel()
    panel.request('src/app.ts')
    panel.adopt(result())
    expect(panel.rows(34)).toHaveLength(40)
    expect(panel.statusLine()).toContain('40 lines')
  })

  // The race a cursor moving faster than the daemon creates. Without this, holding
  // `down` through a tree leaves whichever read happened to finish last on screen.
  it('drops a reply for a file the cursor has already left', () => {
    const panel = new PreviewPanel()
    panel.request('src/app.ts')
    panel.request('src/other.ts')
    panel.adopt(result({ path: 'src/app.ts' }))
    // Still waiting for `other.ts`; the stale answer changed nothing.
    expect(panel.result).toBeNull()
    panel.adopt(result({ path: 'src/other.ts', lines: ['x'] }))
    expect(panel.result?.path).toBe('src/other.ts')
  })

  it('drops a failure for a file the cursor has left, too', () => {
    const panel = new PreviewPanel()
    panel.request('b.ts')
    panel.fail('a.ts', 'boom')
    expect(panel.error).toBeNull()
    panel.fail('b.ts', 'boom')
    expect(panel.error).toBe('boom')
  })
})

describe('scrolling', () => {
  it('moves a line at a time and stops at both ends', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a' }))
    for (let i = 0; i < 5; i++) panel.handleKey(key('down'), area)
    expect(panel.rowsShown(area)[0]).toBe('line 5')
    for (let i = 0; i < 50; i++) panel.handleKey(key('up'), area)
    expect(panel.rowsShown(area)[0]).toBe('line 0')
  })

  it('pages by a screen less one line, so a line of context carries over', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a' }))
    panel.handleKey(key('pagedown'), area)
    // The body is `height - 2` rows; a page is one less than that.
    expect(panel.rowsShown(area)[0]).toBe('line 9')
  })

  it('home and end go to the ends', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a' }))
    panel.handleKey(key('end'), area)
    expect(panel.rowsShown(area).at(-1)).toBe('line 39')
    panel.handleKey(key('home'), area)
    expect(panel.rowsShown(area)[0]).toBe('line 0')
  })

  it('never scrolls a file that fits', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', lines: ['one', 'two'] }))
    panel.handleKey(key('pagedown'), area)
    expect(panel.rowsShown(area)[0]).toBe('one')
  })
})

describe('wrapping', () => {
  it('w toggles, and a long line becomes several rows', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', lines: ['word '.repeat(30).trim()] }))
    expect(panel.rows(34)).toHaveLength(1)
    panel.handleKey(key('char', 'w'), area)
    expect(panel.wrap).toBe(true)
    expect(panel.rows(34).length).toBeGreaterThan(1)
    expect(panel.statusLine()).toContain('wrap')
  })

  it('an empty line survives wrapping, because it is a paragraph break', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', lines: ['one', '', 'two'] }))
    panel.handleKey(key('char', 'w'), area)
    expect(panel.rows(34)).toEqual(['one', '', 'two'])
  })

  it('toggling wrap returns to the top rather than keeping a number that means something else', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a' }))
    panel.handleKey(key('pagedown'), area)
    expect(panel.rowsShown(area)[0]).not.toBe('line 0')
    panel.handleKey(key('char', 'w'), area)
    // The offset indexed the unwrapped list; after wrapping it would point at different
    // text. Going back to the top is honest, keeping the number is not.
    expect(panel.rowsShown(area)[0]).toBe('line 0')
  })

  it('left and right pan only while unwrapped', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', lines: ['x'.repeat(200)] }))
    panel.handleKey(key('right'), area)
    const panned = panel.rowsShown(area)[0] as string
    expect(panned.length).toBeLessThan(200)
    panel.handleKey(key('char', 'w'), area)
    // Wrapped, there is nothing to the right, so the key does nothing rather than
    // silently moving something invisible.
    panel.handleKey(key('right'), area)
    expect(panel.rowsShown(area)[0]).toBe('x'.repeat(34))
  })
})

describe('saying what it is not showing', () => {
  it('a binary file is refused with a message, not painted as noise', () => {
    const panel = new PreviewPanel()
    panel.request('a.png')
    panel.adopt(result({ path: 'a.png', binary: true, lines: [], size: 2048 }))
    expect(panel.statusLine()).toContain('binary')
    const buffer = new ScreenBuffer(area.width, area.height)
    panel.renderInto(buffer, area, palette, true)
    const text = renderToText(buffer, area)
    expect(text).toContain('binary data')
    // Nothing from the file itself reached the buffer, which is the point: a terminal
    // handed arbitrary bytes does arbitrary things to its own state.
    expect(text).toContain('2.0 kB')
  })

  it('a capped preview says which cap fired', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', truncated: true, cap: 'lines' }))
    expect(panel.statusLine()).toContain('more lines')
    panel.request('b')
    panel.adopt(result({ path: 'b', truncated: true, cap: 'bytes' }))
    expect(panel.statusLine()).toContain('more bytes')
  })

  it('names the renderer only when one was involved', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.adopt(result({ path: 'a', renderer: 'glow' }))
    expect(panel.statusLine()).toContain('glow')
    panel.request('b')
    panel.adopt(result({ path: 'b', renderer: 'plain' }))
    expect(panel.statusLine()).not.toContain('plain')
  })

  it('an error is wrapped rather than truncated, so the reason survives', () => {
    const panel = new PreviewPanel()
    panel.request('a')
    panel.fail('a', 'preview needs a path that is inside the repository root, and this one is not')
    const buffer = new ScreenBuffer(area.width, area.height)
    panel.renderInto(buffer, area, palette, true)
    expect(renderToText(buffer, area)).toContain('inside the repository root')
  })
})

describe('what the preview can ask for', () => {
  it('enter hands the file to $PAGER — reading still happens in a pane', () => {
    const panel = new PreviewPanel()
    panel.request('src/app.ts')
    panel.adopt(result())
    expect(panel.handleKey(key('enter'), area)).toEqual({ kind: 'open', path: 'src/app.ts' })
  })

  it('escape closes', () => {
    const panel = new PreviewPanel()
    expect(panel.handleKey(key('escape'), area)).toEqual({ kind: 'close' })
  })
})

describe('the container routes the preview', () => {
  it('escape from a preview opened over the tree goes back to the tree', () => {
    const panels = new SidebarPanels('explorer')
    panels.showPreview('src/app.ts')
    expect(panels.active()).toBe('preview')
    panels.handleKey(key('escape'))
    // A glance you cannot back out of is a detour, so `Esc` returns rather than closing.
    expect(panels.active()).toBe('explorer')
  })

  it('`4` and the chip both reach it directly, and escape from there closes the dock', () => {
    const panels = new SidebarPanels('explorer')
    panels.handleKey(key('char', '4'))
    expect(panels.active()).toBe('preview')
    // Arrived at deliberately rather than as a peek, so there is nowhere to go back to.
    expect(panels.handleKey(key('escape'))).toEqual({ view: 'preview', outcome: { kind: 'close' } })
  })

  it('`[sidebar] preview` is off unless asked', () => {
    expect(new SidebarPanels('explorer').previewOnEnter()).toBe(false)
    const on = new SidebarPanels('explorer', {
      layout: 'separate',
      icons: 'ascii',
      gitFooter: false,
      preview: true
    })
    expect(on.previewOnEnter()).toBe(true)
  })
})

describe('helpers', () => {
  it('sliceColumns drops display columns, not string indices', () => {
    // Eight indices of CJK is sixteen columns. Panning by index would move twice as far
    // on a line of Japanese as on a line of English, which is not what `→` means.
    expect(sliceColumns('日本語abc', 4)).toBe('語abc')
    expect(sliceColumns('abcdef', 2)).toBe('cdef')
    expect(sliceColumns('abc', 0)).toBe('abc')
    expect(sliceColumns('abc', 99)).toBe('')
  })

  it('formatSize is short, because it shares a line with three other facts', () => {
    expect(formatSize(400)).toBe('400 B')
    expect(formatSize(2048)).toBe('2.0 kB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})

/** The visible rows of a rendered buffer, as one string. */
function renderToText(buffer: ScreenBuffer, rect: Rect): string {
  const lines: string[] = []
  for (let y = 0; y < rect.height; y++) {
    let line = ''
    for (let x = 0; x < rect.width; x++) line += buffer.chars[y * rect.width + x] ?? ' '
    lines.push(line)
  }
  return lines.join('\n')
}

describe('switching to an empty preview', () => {
  it('offers the file the tree’s cursor is on', () => {
    // The bug: `4` or the activity bar's `view` chip on a highlighted file said
    // "nothing selected", because only `⏎` and the row menu ever handed the preview a
    // path. A view with a cursor on a file that claims nothing is selected is wrong
    // about its own state.
    const panels = new SidebarPanels('explorer')
    panels.explorer.adopt('/repo', '', [
      { name: 'src', kind: 'dir', link: false },
      { name: 'README.md', kind: 'file', link: false }
    ])
    panels.explorer.handleKey('down', undefined)
    expect(panels.previewTarget()).toBe('README.md')
  })

  it('offers nothing when the cursor is on a directory', () => {
    const panels = new SidebarPanels('explorer')
    panels.explorer.adopt('/repo', '', [{ name: 'src', kind: 'dir', link: false }])
    expect(panels.previewTarget()).toBeNull()
  })

  it('leaves a preview that already has something alone', () => {
    // The last thing the user chose to look at outranks wherever the tree's cursor
    // happens to be sitting.
    const panels = new SidebarPanels('explorer')
    panels.explorer.adopt('/repo', '', [{ name: 'README.md', kind: 'file', link: false }])
    panels.showPreview('src/app.ts')
    expect(panels.previewTarget()).toBeNull()
  })

  it('offers nothing before the tree has been listed', () => {
    expect(new SidebarPanels('preview').previewTarget()).toBeNull()
  })
})
