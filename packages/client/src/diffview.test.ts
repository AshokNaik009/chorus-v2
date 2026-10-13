/**
 * The Changes overlay: what it draws, and what it refuses.
 *
 * The daemon half — the patch itself — is in `packages/daemon/src/git-diff.test.ts`.
 * This is the half the user touches: a plain object driven by keys, rendered into a
 * buffer and read back, the arrangement `preview.test.ts` and `search.test.ts` use.
 */

import { describe, expect, it } from 'vitest'
import { ScreenBuffer, type Rect } from '@leap-chorus/tui'
import type { DiffFile, DiffLine, GitDiffResult } from '@leap-chorus/protocol'
import type { Palette } from './chrome.js'
import { DiffView, MIN_SPLIT_WIDTH, diffArea } from './diffview.js'

const wide: Rect = { x: 0, y: 0, width: 100, height: 20 }
const narrow: Rect = { x: 0, y: 0, width: 60, height: 20 }

const palette = {
  sidebar: { fg: 7, bg: -1, attrs: 0 },
  sidebarActive: { fg: 0, bg: 6, attrs: 0 },
  idleBorder: { fg: 8, bg: -1, attrs: 0 },
  agent: {
    idle: { fg: 8, bg: -1, attrs: 0 },
    working: { fg: 3, bg: -1, attrs: 0 },
    blocked: { fg: 1, bg: -1, attrs: 0 },
    done: { fg: 2, bg: -1, attrs: 0 }
  }
} as unknown as Palette

function line(kind: DiffLine['kind'], old: number | null, fresh: number | null, text: string): DiffLine {
  return { kind, old, new: fresh, text }
}

function file(overrides: Partial<DiffFile> = {}): DiffFile {
  return {
    path: 'src/app.ts',
    origin: null,
    letter: 'M',
    staged: false,
    binary: false,
    truncated: false,
    added: 1,
    removed: 1,
    hunks: [
      {
        header: '@@ -10,3 +10,3 @@',
        section: '',
        oldStart: 10,
        oldCount: 3,
        newStart: 10,
        newCount: 3,
        lines: [
          line('ctx', 10, 10, 'const before = 1'),
          line('del', 11, null, 'const gone = 2'),
          line('add', null, 11, 'const added = 2'),
          line('ctx', 12, 12, 'const after = 3')
        ]
      }
    ],
    ...overrides
  }
}

function result(overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return { root: '/repo', branch: 'main', files: [file()], note: null, ...overrides }
}

function draw(view: DiffView, area: Rect = wide): string[] {
  const buffer = new ScreenBuffer(area.width, area.height)
  view.render(buffer, area, palette)
  return Array.from({ length: area.height }, (_, y) => buffer.rowText(y, { trimRight: true }))
}

/**
 * Just the patch's columns, with the file index sliced off.
 *
 * The index draws paths too, so a plain `rows.find(r => r.includes('a.ts'))` would find
 * the list entry rather than the patch's own header and quietly assert nothing.
 */
function patchRows(view: DiffView, area: Rect = wide): string[] {
  const body = { x: area.x, y: area.y + 2, width: area.width, height: area.height - 2 }
  const from = view.areas(body).patch.x - area.x
  return draw(view, area).map((row) => row.slice(from).trimEnd())
}

/** Just the index's columns, for the same reason in reverse. */
function indexRows(view: DiffView, area: Rect = wide): string[] {
  const body = { x: area.x, y: area.y + 2, width: area.width, height: area.height - 2 }
  const index = view.areas(body).index
  if (index === null) return []
  return draw(view, area).map((row) => row.slice(index.x - area.x, index.x - area.x + index.width).trimEnd())
}

describe('the header, which is the point of the overlay', () => {
  it('names the agent, the pane, the branch and the totals', () => {
    const view = new DiffView()
    view.adopt(result())
    view.subject = { agent: 'claude', agentStatus: 'working', pane: 'pane 2', ownWorktree: false }
    expect(draw(view)[0]).toBe('Changes — claude · working · pane 2 · main · 1 file  +1 −1')
  })

  it('degrades to the pane when no agent is running there', () => {
    const view = new DiffView()
    view.adopt(result())
    view.subject = { agent: null, agentStatus: null, pane: 'pane 1', ownWorktree: false }
    expect(draw(view)[0]).toBe('Changes — pane 1 · main · 1 file  +1 −1')
  })

  it('says when the pane has a checkout of its own', () => {
    const view = new DiffView()
    view.adopt(result())
    view.subject = { agent: 'codex', agentStatus: 'idle', pane: 'pane 3', ownWorktree: true }
    expect(draw(view)[0]).toContain('[worktree]')
  })
})

describe('drawing a patch', () => {
  it('puts both line numbers in the gutter and a sign on the text', () => {
    const view = new DiffView()
    view.adopt(result())
    const rows = patchRows(view)
    // The path on the left, the counts flush right, the cursor marker in column 0.
    expect(rows[2]).toMatch(/^▸M {2}src\/app\.ts +\+1 −1$/u)
    expect(rows[3]).toBe('@@ -10,3 +10,3 @@')
    expect(rows[4]).toBe('  10   10  const before = 1')
    expect(rows[5]).toBe('  11      -const gone = 2')
    // The sign is its own column: `11 +` never reads as the number `11+`.
    expect(rows[6]).toBe('       11 +const added = 2')
  })

  it('shows a rename as origin → path', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ path: 'new.ts', origin: 'old.ts', letter: 'R' })] }))
    expect(patchRows(view)[2]).toContain('old.ts → new.ts')
  })

  it('says a binary file is not shown rather than drawing its bytes', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ binary: true, hunks: [], added: 0, removed: 0 })] }))
    expect(draw(view).join('\n')).toContain('binary file — not shown')
  })

  it('says so when a file was truncated', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ truncated: true })] }))
    expect(draw(view).join('\n')).toContain('truncated')
  })

  it('has an empty state that is a sentence, not a blank box', () => {
    const view = new DiffView()
    view.adopt(result({ files: [] }))
    expect(patchRows(view)[2]).toBe('no changes')
  })

  it('shows the daemon note when the diff was capped', () => {
    const view = new DiffView()
    view.adopt(result({ note: '5 more untracked files not shown' }))
    expect(draw(view)[1]).toBe('5 more untracked files not shown')
  })

  it('expands a tab rather than emitting one', () => {
    // A tab byte moves the terminal's cursor to its own next stop, which is not where
    // this buffer thinks it is, and every cell after it on the row would be wrong.
    const view = new DiffView()
    view.adopt(result({ files: [file({ hunks: [{ ...(file().hunks[0] as never), lines: [line('ctx', 1, 1, '\tx')] }] })] }))
    expect(draw(view).join('')).not.toContain('\t')
  })
})

describe('side by side', () => {
  it('refuses below the minimum rather than drawing two useless columns', () => {
    const view = new DiffView()
    view.adopt(result())
    expect(view.handleKey('', 't', narrow)).toEqual({ kind: 'none' })
    expect(view.split).toBe(false)
    expect(view.note).toContain(String(MIN_SPLIT_WIDTH))
  })

  it('splits when there is room, and pairs the deletion with its addition', () => {
    const view = new DiffView()
    view.adopt(result())
    view.showIndex = false
    view.handleKey('', 't', wide)
    expect(view.split).toBe(true)
    const rows = draw(view)
    const changed = rows.find((row) => row.includes('const gone'))
    // The two halves of one edit are the same row, which is the whole point.
    expect(changed).toContain('const gone = 2')
    expect(changed).toContain('const added = 2')
  })

  it('pads the shorter side when a run of additions has no counterpart', () => {
    const view = new DiffView()
    view.adopt(
      result({
        files: [
          file({
            hunks: [
              {
                ...(file().hunks[0] as never),
                lines: [line('add', null, 1, 'only one'), line('add', null, 2, 'and two')]
              }
            ]
          })
        ]
      })
    )
    view.showIndex = false
    view.handleKey('', 't', wide)
    const rows = draw(view).join('\n')
    expect(rows).toContain('only one')
    expect(rows).toContain('and two')
  })

  it('can always be turned back off, even at a width that would refuse to turn it on', () => {
    const view = new DiffView()
    view.adopt(result())
    view.showIndex = false
    view.handleKey('', 't', wide)
    expect(view.handleKey('', 't', narrow)).toEqual({ kind: 'none' })
    expect(view.split).toBe(false)
  })
})

describe('keys', () => {
  it('closes on escape and on q', () => {
    const view = new DiffView()
    view.adopt(result())
    expect(view.handleKey('escape', undefined, wide)).toEqual({ kind: 'close' })
    expect(view.handleKey('q', 'q', wide)).toEqual({ kind: 'close' })
  })

  it('asks the app to re-fetch when the staged side is toggled', () => {
    const view = new DiffView()
    view.adopt(result())
    expect(view.handleKey('', 's', wide)).toEqual({ kind: 'toggleStaged', staged: true })
    expect(view.handleKey('', 's', wide)).toEqual({ kind: 'toggleStaged', staged: false })
  })

  it('opens the cursor\'s file at its first changed line, on the new side', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })] }))
    expect(view.handleKey('', 'e', wide)).toEqual({ kind: 'edit', path: 'a.ts', line: 11 })
    view.handleKey('', ']', wide)
    // Scrolling does not change what `e` opens: the cursor does.
    view.handleKey('pagedown', undefined, wide)
    expect(view.handleKey('', 'e', wide)).toMatchObject({ kind: 'edit', path: 'b.ts' })
  })

  it('keeps the pager route, which is what the dock used to do', () => {
    const view = new DiffView()
    view.adopt(result())
    expect(view.handleKey('', 'P', wide)).toMatchObject({ kind: 'pager', path: 'src/app.ts' })
  })

  it('walks files with ] and [ and wraps', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ path: 'a.ts' }), file({ path: 'b.ts' })] }))
    expect(view.currentFile()?.path).toBe('a.ts')
    view.handleKey('', ']', wide)
    expect(view.currentFile()?.path).toBe('b.ts')
    // The marker moves, so the key has an effect even when the whole patch fits.
    expect(patchRows(view).find((row) => row.includes('b.ts'))).toContain('▸')
    view.handleKey('', ']', wide)
    expect(view.currentFile()?.path).toBe('a.ts')
  })

  it('wraps long lines only when asked, and pans instead when not', () => {
    const long = 'x'.repeat(400)
    const view = new DiffView()
    view.adopt(result({ files: [file({ hunks: [{ ...(file().hunks[0] as never), lines: [line('ctx', 1, 1, long)] }] })] }))
    const before = patchRows(view).filter((row) => row.includes('xxx')).length
    view.handleKey('', 'w', wide)
    expect(view.wrap).toBe(true)
    expect(patchRows(view).filter((row) => row.includes('xxx')).length).toBeGreaterThan(before)
  })

  it('reports an error instead of a patch', () => {
    const view = new DiffView()
    view.fail('not inside a git repository')
    expect(draw(view)[1]).toBe('not inside a git repository')
  })
})

describe('the area it takes', () => {
  it('is nearly the whole screen', () => {
    expect(diffArea(120, 40)).toEqual({ x: 2, y: 2, width: 116, height: 36 })
  })

  it('never goes negative on a tiny terminal', () => {
    const area = diffArea(10, 4)
    expect(area.width).toBeGreaterThan(0)
    expect(area.height).toBeGreaterThan(0)
  })

  it('dismisses on a click outside itself, as every other dialog does', () => {
    const view = new DiffView()
    view.adopt(result())
    expect(view.handleClick(1, 1, { x: 10, y: 10, width: 10, height: 10 })).toEqual({ kind: 'close' })
    expect(view.handleClick(12, 12, { x: 10, y: 10, width: 10, height: 10 })).toEqual({ kind: 'none' })
  })
})

/**
 * The file index: the standing list of what is in this patch.
 *
 * The patch itself only shows a page at a time, so a twenty-file change has no shape
 * without this. What the tests pin is the thing that silently breaks: that a click on a
 * row moves the patch to *that* file, and that the index gives way rather than being
 * squeezed when the terminal cannot hold both columns.
 */
describe('the file index', () => {
  const many = (count: number): GitDiffResult =>
    result({
      files: Array.from({ length: count }, (_, index) => file({ path: `src/file-${index}.ts` }))
    })

  it('lists every file with its status letter, beside the patch', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ path: 'a.ts' }), file({ path: 'b.ts', letter: 'U' })] }))
    const list = indexRows(view)
    expect(list[2]).toContain('Changes (2)')
    expect(list.join('\n')).toContain('M a.ts')
    expect(list.join('\n')).toContain('U b.ts')
    // The patch is still drawn, to the right of it.
    expect(patchRows(view).join('\n')).toContain('@@ -10,3 +10,3 @@')
  })

  it('elides a long path from the left, where the filename survives', () => {
    const view = new DiffView()
    view.adopt(result({ files: [file({ path: 'packages/client/src/deeply/nested/module.ts' })] }))
    const listed = indexRows(view).find((row) => row.includes('module.ts'))
    expect(listed).toContain('…')
    expect(listed).toContain('module.ts')
    // The patch's own header keeps the whole path; only the narrow column elides.
    expect(patchRows(view)[2]).toContain('packages/client/src/deeply/nested/module.ts')
  })

  it('a click on a row scrolls the patch to that file', () => {
    const view = new DiffView()
    view.adopt(many(6))
    const area = wide
    // Row 0 of the list sits INDEX_TOP rows below the body, which starts LIST_TOP down.
    const firstRow = area.y + 2 + 2
    view.handleClick(area.x + 3, firstRow + 2, area)
    expect(view.currentFile()?.path).toBe('src/file-2.ts')
    // Its header is now the top row of the patch, not merely somewhere on screen.
    expect(patchRows(view)[2]).toContain('src/file-2.ts')
  })

  it('a click outside the index does not move the patch', () => {
    const view = new DiffView()
    view.adopt(many(6))
    view.handleClick(wide.x + 60, wide.y + 5, wide)
    expect(view.currentFile()?.path).toBe('src/file-0.ts')
  })

  it('`]` and a click agree: both put the file at the top', () => {
    const view = new DiffView()
    view.adopt(many(6))
    view.handleKey('', ']', wide)
    const afterKey = patchRows(view)[2]
    view.handleKey('', '[', wide)
    view.handleClick(wide.x + 3, wide.y + 2 + 2 + 1, wide)
    expect(patchRows(view)[2]).toBe(afterKey)
  })

  it('a file near the end is reached even though it cannot scroll to the top', () => {
    // The list stops at its end, so the last file's header lands mid-screen rather
    // than on the first row. It still has to be *visible*, and the cursor still moves.
    const view = new DiffView()
    view.adopt(many(6))
    view.handleClick(wide.x + 3, wide.y + 2 + 2 + 5, wide)
    expect(view.currentFile()?.path).toBe('src/file-5.ts')
    expect(patchRows(view).join('\n')).toContain('src/file-5.ts')
  })

  it('gives way entirely rather than being squeezed', () => {
    const view = new DiffView()
    view.adopt(many(3))
    // Half an index beside half a patch is two things nobody can read.
    expect(view.areas(narrow).index).toBeNull()
    expect(view.areas(narrow).patch.width).toBe(narrow.width)
    expect(view.areas(wide).index).not.toBeNull()
  })

  it('`i` hides it, which is how you get the columns back for side-by-side', () => {
    const view = new DiffView()
    view.adopt(many(3))
    // 110 is the window where it matters: 109 columns of patch clears the split
    // minimum, and 80 does not once the index has taken its 29.
    const area: Rect = { x: 0, y: 0, width: 110, height: 24 }
    // With the index taking 29 columns the patch is under the split minimum.
    expect(view.handleKey('', 't', area)).toEqual({ kind: 'none' })
    expect(view.split).toBe(false)
    view.handleKey('', 'i', area)
    expect(view.showIndex).toBe(false)
    view.handleKey('', 't', area)
    expect(view.split).toBe(true)
  })

  it('scrolls itself when there are more files than rows, following the cursor', () => {
    const view = new DiffView()
    view.adopt(many(60))
    expect(indexRows(view).join('\n')).not.toContain('file-59.ts')
    for (let i = 0; i < 59; i += 1) view.handleKey('', ']', wide)
    expect(view.currentFile()?.path).toBe('src/file-59.ts')
    expect(indexRows(view).join('\n')).toContain('file-59.ts')
  })
})
