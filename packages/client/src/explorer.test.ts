/**
 * The tree model on its own: what a click means.
 *
 * `test/explorer.test.ts` drives a real client and daemon and covers fetching,
 * refreshing and decorations. This covers the one thing that needs no daemon and was
 * wrong for three phases.
 */

import { describe, expect, it } from 'vitest'
import type { Rect } from '@leap-chorus/tui'
import { ExplorerPanel } from './explorer.js'

const area: Rect = { x: 0, y: 0, width: 34, height: 12 }

/** The first list row sits two lines below the area's top: the header and the root. */
const FIRST_ROW = area.y + 2

describe('clicking a row', () => {
  it('expands a folder, which a click used only to highlight', () => {
    // The bug, reported from a screenshot of a tree where every folder sat collapsed:
    // clicking `phases/` moved the highlight and did nothing else, so folders looked
    // like they could not nest at all.
    const tree = new ExplorerPanel()
    tree.adopt('/repo', '', [
      { name: 'phases', kind: 'dir', link: false },
      { name: 'README.md', kind: 'file', link: false }
    ])
    expect(tree.clickRow(FIRST_ROW, area)).toEqual({ kind: 'expand', path: 'phases' })

    tree.adopt('/repo', 'phases', [{ name: 'PHASE-10.md', kind: 'file', link: false }])
    expect(tree.rows().map((row) => [row.node.path, row.depth])).toEqual([
      ['phases', 0],
      ['phases/PHASE-10.md', 1],
      ['README.md', 0]
    ])

    // And a second click folds it again.
    expect(tree.clickRow(FIRST_ROW, area)).toEqual({ kind: 'none' })
    expect(tree.rows()).toHaveLength(2)
  })

  it('previews a file rather than opening one, so a click never leaves a pane behind', () => {
    // Treating a click as `⏎` was tried and was worse. With `[sidebar] preview` off,
    // `⏎` hands the file to `$PAGER` in a new pane — so clicking down a tree to see
    // what is in each file left one pane per click, and since the keyboard stays with
    // the dock, none of them could be scrolled either.
    const tree = new ExplorerPanel()
    tree.adopt('/repo', '', [{ name: 'README.md', kind: 'file', link: false }])
    expect(tree.clickRow(FIRST_ROW, area)).toEqual({ kind: 'preview', path: 'README.md' })
    // `⏎` is unchanged, and still means "open this".
    expect(tree.activate()).toEqual({ kind: 'open', path: 'README.md' })
  })

  it('does nothing when the click lands past the last row', () => {
    const tree = new ExplorerPanel()
    tree.adopt('/repo', '', [{ name: 'README.md', kind: 'file', link: false }])
    expect(tree.clickRow(FIRST_ROW + 7, area)).toEqual({ kind: 'none' })
  })
})
