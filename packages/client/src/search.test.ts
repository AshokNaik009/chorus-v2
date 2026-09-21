/**
 * The Search view and the panel container, driven by keystrokes.
 *
 * Both are plain objects that decide what a keystroke *means* and perform nothing, so
 * a test can drive them directly — the same arrangement `branch.test.ts` already uses.
 * What needs a real client and a real daemon is in `test/search.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { SearchContentResult, SearchFilesResult } from '@leap-chorus/protocol'
import { SidebarPanels, activityZones } from './panel.js'
import { SearchPanel, fuzzyScore, pagerArgs, rankFiles, type PanelKey } from './search.js'

function key(name: string, char?: string, modifiers: Partial<PanelKey> = {}): PanelKey {
  return { name, char, alt: false, ctrl: false, shift: false, ...modifiers }
}

function type(panel: SearchPanel, text: string): void {
  for (const character of text) panel.handleKey(key('char', character))
}

function fileList(files: readonly string[], cap: SearchFilesResult['cap'] = null): SearchFilesResult {
  return { root: '/repo', files, truncated: cap !== null, cap, engine: 'ripgrep' }
}

function results(): SearchContentResult {
  return {
    root: '/repo',
    files: [
      {
        path: 'src/app.ts',
        matches: [
          { line: 12, column: 5, matchLength: 6, text: 'const needle = 1', displayColumn: 5, displayMatchLength: 6 },
          { line: 40, column: 1, matchLength: 6, text: 'needle again', displayColumn: 1, displayMatchLength: 6 }
        ]
      },
      {
        path: 'docs/readme.md',
        matches: [
          { line: 3, column: 9, matchLength: 6, text: 'the needle', displayColumn: 9, displayMatchLength: 6 }
        ]
      }
    ],
    totalMatches: 3,
    truncated: false,
    cap: null
  }
}

describe('fuzzy ranking', () => {
  it('matches a subsequence and refuses anything else', () => {
    expect(fuzzyScore('abc', 'axbxc')).not.toBeNull()
    expect(fuzzyScore('abc', 'acb')).toBeNull()
    expect(fuzzyScore('', 'anything')).toBe(0)
  })

  it('prefers adjacency and word boundaries', () => {
    // `app` as a whole word after a slash beats the same letters scattered about.
    const boundary = fuzzyScore('app', 'src/app.ts') as number
    const scattered = fuzzyScore('app', 'a-p-p-lication.ts') as number
    expect(boundary).toBeGreaterThan(scattered)
  })

  it('ranks the shorter path first when the scores tie', () => {
    expect(rankFiles(['deep/nested/a.ts', 'a.ts'], 'ats')).toEqual(['a.ts', 'deep/nested/a.ts'])
  })

  it('an empty query keeps the list as it came', () => {
    expect(rankFiles(['b.ts', 'a.ts'], '')).toEqual(['b.ts', 'a.ts'])
  })
})

describe('quick open', () => {
  it('asks for the file list the first time and not the second', () => {
    const panel = new SearchPanel()
    expect(panel.openQuick()).toEqual({ kind: 'files' })
    panel.adoptFiles(fileList(['a.ts', 'b.ts']))
    expect(panel.openQuick()).toEqual({ kind: 'none' })
  })

  it('filters as you type, without asking the daemon again', () => {
    const panel = new SearchPanel()
    panel.openQuick()
    panel.adoptFiles(fileList(['src/app.ts', 'src/panel.ts', 'docs/readme.md']))
    type(panel, 'app')
    expect(panel.statusLine()).toBe('1/3 files')
    expect(panel.selectedPath()).toBe('src/app.ts')
    // Every one of those keystrokes returned `none`: no round trip, just a compare.
    expect(panel.handleKey(key('char', 'x'))).toEqual({ kind: 'none' })
    expect(panel.statusLine()).toBe('0/3 files')
  })

  it('backspace puts the filtered-out files back', () => {
    const panel = new SearchPanel()
    panel.openQuick()
    panel.adoptFiles(fileList(['a.ts', 'b.ts']))
    type(panel, 'a')
    expect(panel.statusLine()).toBe('1/2 files')
    panel.handleKey(key('backspace'))
    expect(panel.statusLine()).toBe('2/2 files')
  })

  it('opens the selection', () => {
    const panel = new SearchPanel()
    panel.openQuick()
    panel.adoptFiles(fileList(['a.ts', 'b.ts']))
    panel.handleKey(key('down'))
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'open', path: 'b.ts', line: null })
  })

  it('says when the listing was capped rather than pretending it is whole', () => {
    const panel = new SearchPanel()
    panel.openQuick()
    panel.adoptFiles(fileList(['a.ts', 'b.ts'], 'files'))
    expect(panel.statusLine()).toContain('only the first 2 files')
  })

  it('a capped listing by time says so too', () => {
    const panel = new SearchPanel()
    panel.openQuick()
    panel.adoptFiles(fileList(['a.ts'], 'time'))
    expect(panel.statusLine()).toContain('time limit')
  })
})

describe('content search', () => {
  it('submits on enter and does nothing on an empty query', () => {
    const panel = new SearchPanel()
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'none' })
    type(panel, 'needle')
    expect(panel.query).toBe('needle')
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'search' })
  })

  it('groups results by file, with the line and the matching text', () => {
    const panel = new SearchPanel()
    panel.adoptResults(results(), 'needle')
    const rows = panel.rows()
    expect(rows.map((row) => row.kind)).toEqual(['file', 'match', 'match', 'file', 'match'])
    expect(rows[1]).toMatchObject({ path: 'src/app.ts', line: 12, text: 'const needle = 1' })
    expect(panel.statusLine()).toBe('3 in 2 files')
  })

  it('opens a result at its line, never a heading', () => {
    const panel = new SearchPanel()
    panel.adoptResults(results(), 'needle')
    panel.focus = 'results'
    // The cursor starts on the first *match*, because a heading is a label.
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'open', path: 'src/app.ts', line: 12 })
    panel.handleKey(key('down'))
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'open', path: 'src/app.ts', line: 40 })
    // Down again skips the `docs/readme.md` heading and lands on its match.
    panel.handleKey(key('down'))
    expect(panel.handleKey(key('enter'))).toEqual({ kind: 'open', path: 'docs/readme.md', line: 3 })
  })

  it('reports a capped result set', () => {
    const panel = new SearchPanel()
    panel.adoptResults({ ...results(), truncated: true, cap: 'matches' }, 'needle')
    expect(panel.statusLine()).toContain('capped (matches)')
  })

  it('tab walks the fields and back to the results', () => {
    const panel = new SearchPanel()
    expect(panel.focus).toBe('query')
    panel.handleKey(key('tab'))
    expect(panel.focus).toBe('include')
    panel.handleKey(key('tab'))
    expect(panel.focus).toBe('exclude')
    panel.handleKey(key('tab'))
    expect(panel.focus).toBe('results')
    panel.handleKey(key('tab', undefined, { shift: true }))
    expect(panel.focus).toBe('exclude')
  })

  it('types into whichever field has the caret', () => {
    const panel = new SearchPanel()
    type(panel, 'needle')
    panel.handleKey(key('tab'))
    type(panel, '*.ts')
    panel.handleKey(key('tab'))
    type(panel, 'dist')
    expect({ query: panel.query, include: panel.include, exclude: panel.exclude }).toEqual({
      query: 'needle',
      include: '*.ts',
      exclude: 'dist'
    })
  })

  it('alt-c, alt-w and alt-r toggle, and re-run rather than leaving a stale answer', () => {
    const panel = new SearchPanel()
    type(panel, 'needle')
    panel.adoptResults(results(), 'needle')
    expect(panel.handleKey(key('char', 'c', { alt: true }))).toEqual({ kind: 'search' })
    expect(panel.options.matchCase).toBe(true)
    // The old results are gone in the same keystroke: a toggle row that disagrees with
    // the list under it is worse than an empty list.
    expect(panel.rows()).toEqual([])
    panel.handleKey(key('char', 'w', { alt: true }))
    panel.handleKey(key('char', 'r', { alt: true }))
    expect(panel.options).toEqual({ matchCase: true, wholeWord: true, regex: true })
  })

  it('an alt toggle is never typed into the query', () => {
    const panel = new SearchPanel()
    type(panel, 'ab')
    panel.handleKey(key('char', 'c', { alt: true }))
    expect(panel.query).toBe('ab')
  })

  it('editing the query invalidates the results it produced', () => {
    const panel = new SearchPanel()
    type(panel, 'needle')
    panel.adoptResults(results(), 'needle')
    panel.handleKey(key('backspace'))
    expect(panel.rows()).toEqual([])
    expect(panel.statusLine()).toBe('⏎ to search')
  })

  it('down out of the query box lands on the results', () => {
    const panel = new SearchPanel()
    panel.adoptResults(results(), 'needle')
    panel.handleKey(key('down'))
    expect(panel.focus).toBe('results')
  })
})

describe('opening at a line', () => {
  it('tells a pager that understands +N where to start', () => {
    expect(pagerArgs('less', '/repo/a.ts', 12)).toEqual(['+12', '/repo/a.ts'])
    expect(pagerArgs('/usr/bin/less', '/repo/a.ts', 12)).toEqual(['+12', '/repo/a.ts'])
    expect(pagerArgs('most', '/repo/a.ts', 3)).toEqual(['+3', '/repo/a.ts'])
  })

  it('opens at the top when there is no line, or no pager that takes one', () => {
    expect(pagerArgs('less', '/repo/a.ts', null)).toEqual(['/repo/a.ts'])
    // `bat` would read `+12` as a second filename and print "no such file".
    expect(pagerArgs('bat', '/repo/a.ts', 12)).toEqual(['/repo/a.ts'])
  })
})

describe('the panel container', () => {
  const area = { x: 0, y: 0, width: 34, height: 20 }

  it('1, 2 and 3 switch in the activity bar order', () => {
    const panels = new SidebarPanels('explorer')
    expect(panels.active()).toBe('explorer')
    panels.handleKey(key('char', '2'))
    expect(panels.active()).toBe('search')
    panels.handleKey(key('char', '3'))
    expect(panels.active()).toBe('scm')
    panels.handleKey(key('char', '1'))
    expect(panels.active()).toBe('explorer')
  })

  it('the activity bar chips switch the same views', () => {
    const panels = new SidebarPanels('explorer')
    const zones = activityZones(area)
    // Phase 9 added the preview as a fourth view, which is the shape the container's
    // contract predicted a fourth view would take: a chip, a field, and one arm.
    expect(zones.map((zone) => zone.id)).toEqual(['explorer', 'search', 'scm', 'preview'])
    panels.handleClick(area.y, zones[2]?.x as number, area)
    expect(panels.active()).toBe('scm')
    panels.handleClick(area.y, zones[1]?.x as number, area)
    expect(panels.active()).toBe('search')
    panels.handleClick(area.y, zones[3]?.x as number, area)
    expect(panels.active()).toBe('preview')
  })

  // In `unified` layout the tree and the changes list share one view, so `git` has no
  // chip of its own — a chip that switched to the half already on screen would do
  // nothing and read as broken.
  it('drops the git chip in unified layout, where it is not a view', () => {
    expect(activityZones(area, 'unified').map((zone) => zone.id)).toEqual([
      'explorer',
      'search',
      'preview'
    ])
  })

  it('a click below the activity bar is the view’s, not the bar’s', () => {
    const panels = new SidebarPanels('scm')
    panels.handleClick(area.y + 5, 2, area)
    expect(panels.active()).toBe('scm')
  })

  // Criterion 9: each view keeps its cursor across a switch.
  it('keeps each view’s cursor and scroll across a switch', () => {
    const panels = new SidebarPanels('explorer')
    panels.explorer.adopt('/repo', '', [
      { name: 'a.ts', kind: 'file', link: false },
      { name: 'b.ts', kind: 'file', link: false },
      { name: 'c.ts', kind: 'file', link: false }
    ])
    panels.explorer.handleKey('down', undefined)
    panels.explorer.handleKey('down', undefined)
    expect(panels.explorer.selected()?.name).toBe('c.ts')

    panels.search.adoptResults(results(), 'needle')
    panels.handleKey(key('char', '2'))
    panels.handleKey(key('down'))
    panels.handleKey(key('down'))
    expect(panels.search.selectedPath()).toBe('docs/readme.md')

    panels.handleKey(key('char', '3'))
    panels.handleKey(key('char', '1'))
    // Nothing was rebuilt, so nothing was reset.
    expect(panels.explorer.selected()?.name).toBe('c.ts')
    panels.handleKey(key('char', '2'))
    expect(panels.search.selectedPath()).toBe('docs/readme.md')
  })

  it('a digit inside quick open is part of the filter, and ctrl still leaves', () => {
    const panels = new SidebarPanels('explorer')
    panels.search.adoptFiles(fileList(['a1.ts', 'a2.ts']))
    panels.quickOpen()
    panels.handleKey(key('char', '2'))
    expect(panels.active()).toBe('search')
    expect(panels.search.selectedPath()).toBe('a2.ts')
    panels.handleKey(key('char', '3', { ctrl: true }))
    expect(panels.active()).toBe('scm')
  })

  it('a focused search box types a digit instead of switching view', () => {
    const panels = new SidebarPanels('search')
    panels.contentSearch()
    panels.handleKey(key('char', '3'))
    expect(panels.active()).toBe('search')
    expect(panels.search.query).toBe('3')
    // Ctrl still switches, the way an editor's group-focus chord does.
    panels.handleKey(key('char', '3', { ctrl: true }))
    expect(panels.active()).toBe('scm')
  })

  it('arriving at search from the activity bar leaves the digits a switcher', () => {
    const panels = new SidebarPanels('explorer')
    panels.handleKey(key('char', '2'))
    expect(panels.search.textFocused()).toBe(false)
    panels.handleKey(key('char', '1'))
    expect(panels.active()).toBe('explorer')
    expect(panels.search.query).toBe('')
  })

  it('ctrl-p opens quick open from any view, and escape goes back where it came from', () => {
    const panels = new SidebarPanels('scm')
    const opened = panels.handleKey(key('char', 'p', { ctrl: true }))
    expect(panels.active()).toBe('search')
    expect(opened).toEqual({ view: 'search', outcome: { kind: 'files' } })
    const escaped = panels.handleKey(key('escape'))
    // Not a close: quick open is a peek, and dropping the dock would be a one-way door.
    expect(escaped).toEqual({ view: 'panel', outcome: 'switched' })
    expect(panels.active()).toBe('scm')
  })

  it('escape from the search view itself closes the dock', () => {
    const panels = new SidebarPanels('search')
    expect(panels.handleKey(key('escape'))).toEqual({ view: 'search', outcome: { kind: 'close' } })
  })

  it('ctrl-f opens the search view with the caret in the query box', () => {
    const panels = new SidebarPanels('explorer')
    panels.handleKey(key('char', 'f', { ctrl: true }))
    expect(panels.active()).toBe('search')
    expect(panels.search.textFocused()).toBe(true)
  })

  it('routes an ordinary key to whichever view is showing', () => {
    const panels = new SidebarPanels('scm')
    expect(panels.handleKey(key('char', 'b'))).toEqual({ view: 'scm', outcome: { kind: 'branches' } })
    panels.handleKey(key('char', '1'))
    expect(panels.handleKey(key('char', 'r'))).toEqual({ view: 'explorer', outcome: { kind: 'refresh' } })
  })

  it('the hint follows the view, and the search view’s follows its focus', () => {
    const panels = new SidebarPanels('explorer')
    expect(panels.hint()).toContain('stage')
    panels.handleKey(key('char', '3'))
    expect(panels.hint()).toContain('commit')
    panels.handleKey(key('char', '2'))
    expect(panels.hint()).toContain('edit query')
    panels.contentSearch()
    expect(panels.hint()).toContain('next field')
    panels.quickOpen()
    expect(panels.hint()).toContain('filter')
  })

  it('leaves the activity bar a row of its own', () => {
    const panels = new SidebarPanels()
    expect(panels.bodyArea(area)).toEqual({ x: 0, y: 1, width: 34, height: 19 })
  })

  it('drops chips that do not fit rather than drawing half of one', () => {
    expect(activityZones({ x: 0, y: 0, width: 10, height: 5 }).map((zone) => zone.id)).toEqual(['explorer'])
  })
})
