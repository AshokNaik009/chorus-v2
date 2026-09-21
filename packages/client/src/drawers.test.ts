/**
 * The drawers, as a panel and as a menu table.
 *
 * Three things are being pinned down here, and only one of them is rendering:
 *
 * 1. **A row's action comes from a field, never from the text drawn for it** —
 *    PHASE-11's criterion 3, tested with a commit whose *subject* is full of
 *    hash-shaped decoys.
 * 2. **Every `…` entry asks first** — criterion 6's first half, read straight off
 *    `drawerCommand` rather than by driving a dialog.
 * 3. **34 columns keeps the identifying part** — criterion 8.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GitCommitRow, GitDrawerRow, GitWorktreeRow } from '@leap-chorus/protocol'
import {
  DRAWER_ORDER,
  DrawersPanel,
  drawerCommand,
  drawerMenu,
  drawerTitle,
  prettyRemoteUrl,
  fitRowText,
  prettyWorktree,
  rowText
} from './drawers.js'
import { ScmPanel } from './scm.js'

const HASH = '1e7f2c90c03d868dd4e33eeee05e6d3d4c042f03'

function commit(overrides: Partial<GitCommitRow> = {}): GitCommitRow {
  return {
    kind: 'commit',
    hash: HASH,
    short: '1e7f2c9',
    subject: 'merge feat',
    refs: [],
    date: '2026-09-21',
    rail: '',
    ...overrides
  }
}

describe('a row points at a field, not at its own text', () => {
  it('copies the full hash even when the subject is full of hash-shaped words', () => {
    // herdr-sidebar's `parse_drawer_ref` takes "the first whitespace token of at least
    // seven lowercase hex characters" out of the rendered line. On this row that rule
    // returns `deadbeef`, which is a commit in nobody's repository.
    const row = commit({ subject: 'deadbeef cafebabe revert of 0badf00d' })
    expect(rowText(row)).toContain('deadbeef')
    expect(drawerCommand(row, 'copy')).toEqual({ kind: 'copy', text: HASH, what: 'hash' })
    expect(drawerCommand(row, 'show')).toEqual({ kind: 'show', args: ['show', HASH] })
    expect(drawerCommand(row, 'cherry-pick')).toMatchObject({ action: 'commit.cherryPick', ref: HASH })
  })

  it('never scans its own display text for a hash, in source', () => {
    // A source check, because the failure this guards against is somebody putting the
    // convenient thing back: a regex over a rendered row. Comments are stripped first
    // — this file and `drawers.ts` both *discuss* the hex rule at length, and the
    // point is that neither one runs it.
    const here = new URL('.', import.meta.url).pathname
    for (const file of ['drawers.ts', 'scm.ts']) {
      const source = readFileSync(join(here, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/^\s*\/\/.*$/gmu, '')
      expect(source, file).not.toMatch(/\[0-9a-f\]|\[a-f0-9\]|\[0-9A-Fa-f\]/u)
    }
  })

  it('acts on the stash ref git printed, not on the row it drew', () => {
    const row: GitDrawerRow = {
      kind: 'stash',
      index: 1,
      ref: 'stash@{1}',
      hash: HASH,
      subject: 'WIP on main: 1e7f2c9 merge feat'
    }
    expect(drawerCommand(row, 'drop')).toMatchObject({ action: 'stash.drop', ref: 'stash@{1}' })
    expect(drawerCommand(row, 'show')).toEqual({ kind: 'show', args: ['stash', 'show', '-p', 'stash@{1}'] })
  })
})

describe('the menus', () => {
  it('is PHASE-11 table, entry for entry', () => {
    expect(drawerMenu(commit()).map((item) => item.label)).toEqual([
      'Show Changes',
      'Checkout (Detached)',
      'Cherry-Pick',
      'Revert',
      'Reset Current Branch Here…',
      'Copy Hash'
    ])
    expect(drawerMenu({ kind: 'branch', name: 'main', current: true, remote: false }).map((i) => i.label)).toEqual([
      'Show Tip Commit',
      'Copy Branch Name'
    ])
    expect(drawerMenu({ kind: 'branch', name: 'feat', current: false, remote: false }).map((i) => i.label)).toEqual([
      'Checkout Branch',
      'Merge into Current Branch',
      'Delete Branch…',
      'Copy Branch Name'
    ])
    expect(drawerMenu({ kind: 'remote', name: 'origin', url: 'x' }).map((i) => i.label)).toEqual([
      'Fetch',
      'Copy URL'
    ])
    expect(drawerMenu({ kind: 'tag', name: 'v1' }).map((i) => i.label)).toEqual([
      'Show Changes',
      'Checkout Tag',
      'Delete Tag…',
      'Copy Tag Name'
    ])
  })

  it('offers nothing on a piece of graph art', () => {
    expect(drawerMenu({ kind: 'rail', rail: '|\\' })).toEqual([])
    expect(drawerCommand({ kind: 'rail', rail: '|\\' }, 'show')).toBeNull()
  })

  it('asks first for every entry that ends in an ellipsis, and only those', () => {
    const rows: GitDrawerRow[] = [
      commit(),
      { kind: 'branch', name: 'feat', current: false, remote: false },
      { kind: 'branch', name: 'main', current: true, remote: false },
      { kind: 'stash', index: 0, ref: 'stash@{0}', hash: HASH, subject: 'WIP' },
      { kind: 'remote', name: 'origin', url: 'git@github.com:o/r.git' },
      { kind: 'tag', name: 'v1' },
      { kind: 'worktree', path: '/tmp/r-wt', name: 'r-wt', branch: 'wtb', head: null, primary: false }
    ]
    let destructive = 0
    for (const row of rows) {
      for (const item of drawerMenu(row)) {
        const command = drawerCommand(row, item.id)
        expect(command, `${row.kind}/${item.id}`).not.toBeNull()
        const asks =
          command !== null &&
          ((command.kind === 'action' && command.confirm !== null) || command.kind === 'worktree-remove')
        expect(asks, `${row.kind}/${item.label}`).toBe(item.label.endsWith('…'))
        if (asks) destructive += 1
      }
    }
    // Reset, Delete Branch, Drop Stash, Delete Tag, Remove Worktree.
    expect(destructive).toBe(5)
  })

  it('reuses the branch picker RPC rather than adding a second checkout', () => {
    expect(drawerCommand({ kind: 'branch', name: 'origin/x', current: false, remote: true }, 'checkout')).toEqual({
      kind: 'checkout',
      branch: 'origin/x',
      remote: true
    })
  })

  it('reuses worktree.open and worktree.remove', () => {
    const row: GitWorktreeRow = {
      kind: 'worktree',
      path: '/tmp/r-wt dir',
      name: 'r-wt dir',
      branch: 'wtb',
      head: null,
      primary: false
    }
    expect(drawerCommand(row, 'open')).toEqual({ kind: 'worktree-open', path: '/tmp/r-wt dir' })
    expect(drawerCommand(row, 'remove')).toMatchObject({ kind: 'worktree-remove', path: '/tmp/r-wt dir' })
  })
})

describe('34 columns', () => {
  it('keeps owner/repo out of every spelling of a remote URL', () => {
    expect(prettyRemoteUrl('git@github.com:owner/repo.git')).toBe('owner/repo')
    expect(prettyRemoteUrl('https://github.com/owner/repo.git')).toBe('owner/repo')
    expect(prettyRemoteUrl('https://gitlab.example.com/group/sub/repo')).toBe('sub/repo')
    expect(prettyRemoteUrl('ssh://git@host:2222/owner/repo.git')).toBe('owner/repo')
    // A local path renders as its folder, which is how a fixture spells its origin.
    expect(prettyRemoteUrl('/srv/git/repo')).toBe('git/repo')
    expect(prettyRemoteUrl('repo.git')).toBe('repo')
  })

  it('renders a remote row inside the dock without losing the identifying part', () => {
    const row: GitDrawerRow = { kind: 'remote', name: 'origin', url: 'git@github.com:owner/repo.git' }
    // Two columns of indent, so a 34-column dock gives a row 32.
    expect(fitRowText(row, 32)).toBe('origin  owner/repo')

    // A remote too long for the dock drops its name — which is `origin` in nearly every
    // repository — and keeps the end of the URL, which is the part that identifies it.
    const long: GitDrawerRow = {
      kind: 'remote',
      name: 'origin',
      url: 'git@github.com:some-long-organisation/some-long-repository-name.git'
    }
    const fitted = fitRowText(long, 32)
    expect(fitted.length).toBeLessThanOrEqual(32)
    expect(fitted).toContain('some-long-repository-name')
    expect(fitted.startsWith('…')).toBe(true)
  })

  it('renders a worktree as a folder and a branch, never as a path', () => {
    const row: GitWorktreeRow = {
      kind: 'worktree',
      path: '/Users/someone/very/deep/checkouts/leap-chorus-feature',
      name: 'leap-chorus-feature',
      branch: 'feature',
      head: 'abc1234',
      primary: false
    }
    expect(prettyWorktree(row)).toBe('  leap-chorus-feature ⎇ feature')
    // And in the dock's own width the path is still nowhere near it: what goes first
    // is the branch, never the folder name.
    const fitted = fitRowText(row, 24)
    expect(fitted).toBe('  leap-chorus-feature')
    expect(fitted).not.toContain('/Users')
  })

  it('shows a detached worktree by its head', () => {
    expect(
      prettyWorktree({ kind: 'worktree', path: '/a/b', name: 'b', branch: null, head: HASH, primary: false })
    ).toBe('  b @ 1e7f2c9')
  })
})

describe('the panel', () => {
  it('starts with eight collapsed drawers and no rows', () => {
    const panel = new DrawersPanel()
    const lines = panel.lines()
    expect(lines.length).toBe(8)
    expect(lines.map((line) => line.id)).toEqual(DRAWER_ORDER)
    expect(lines.every((line) => line.kind === 'drawer')).toBe(true)
    expect(lines[0]?.text).toBe(`▸ ${drawerTitle('graph')}`)
    expect(panel.expandedIds()).toEqual([])
  })

  it('asks for a fetch on expand and throws the rows away on collapse', () => {
    const panel = new DrawersPanel()
    expect(panel.toggle('commits')).toBe(true)
    expect(panel.expandedIds()).toEqual(['commits'])
    panel.adopt({ drawer: 'commits', rows: [commit()], note: null })
    expect(panel.lines().some((line) => line.kind === 'drawer-row')).toBe(true)

    expect(panel.toggle('commits')).toBe(false)
    expect(panel.expandedIds()).toEqual([])
    // Nothing kept: re-opening asks git again, which is `git.ts`'s standing rule.
    expect(panel.toggle('commits')).toBe(true)
    expect(panel.lines().filter((line) => line.kind === 'drawer-row')).toEqual([])
  })

  it('says loading, then empty, and never leaves a header with nothing under it', () => {
    const panel = new DrawersPanel()
    panel.toggle('tags')
    expect(panel.lines().some((line) => line.text === 'loading…')).toBe(true)
    panel.adopt({ drawer: 'tags', rows: [], note: null })
    expect(panel.lines().some((line) => line.kind === 'drawer-note' && line.text === 'empty')).toBe(true)
  })

  it('shows a reason instead of an empty list when no file is selected', () => {
    const panel = new DrawersPanel()
    panel.toggle('fileHistory')
    panel.adopt({ drawer: 'fileHistory', rows: [], note: 'select a file to see its history' })
    const notes = panel.lines().filter((line) => line.kind === 'drawer-note')
    expect(notes.map((line) => line.text)).toEqual(['select a file to see its history'])
  })

  it('drops a reply for a drawer that was closed while it was in flight', () => {
    const panel = new DrawersPanel()
    panel.toggle('commits')
    panel.toggle('commits')
    panel.adopt({ drawer: 'commits', rows: [commit()], note: null })
    expect(panel.lines().filter((line) => line.kind === 'drawer-row')).toEqual([])
  })

  it('counts rows without counting graph art', () => {
    const panel = new DrawersPanel()
    panel.toggle('graph')
    panel.adopt({
      drawer: 'graph',
      rows: [commit({ rail: '* ' }), { kind: 'rail', rail: '|\\' }, commit({ rail: '| * ' })],
      note: null
    })
    const header = panel.lines().find((line) => line.kind === 'drawer')
    expect(header?.text).toBe('▾ Graph (2)')
  })

  it('reports a failure on the drawer that failed, and leaves the others alone', () => {
    const panel = new DrawersPanel()
    panel.toggle('stashes')
    panel.fail('stashes', 'fatal: not a git repository')
    expect(panel.lines().some((line) => line.text === 'fatal: not a git repository')).toBe(true)
    expect(panel.lines().filter((line) => line.kind === 'drawer').length).toBe(8)
  })
})

describe('under the changes list', () => {
  /** A panel with one changed file and a status, which is what hosts the drawers. */
  function panelWithChange(): ScmPanel {
    const panel = new ScmPanel()
    panel.adopt({
      root: '/repo',
      branch: 'main',
      staged: [],
      unstaged: [{ path: 'src/widget.ts', origin: null, letter: 'M' }],
      ahead: 0,
      behind: 0,
      hasUpstream: false
    })
    return panel
  }

  it('draws the eight headers under the changes, collapsed', () => {
    const rows = panelWithChange().rows()
    expect(rows.map((row) => row.kind)).toEqual([
      'header',
      'file',
      ...DRAWER_ORDER.map(() => 'drawer')
    ])
  })

  it('opens one with enter, and asks the app to fetch exactly it', () => {
    const panel = panelWithChange()
    // Down once from the file row lands on the first drawer.
    panel.handleKey('down', undefined)
    const outcome = panel.handleKey('enter', undefined)
    expect(outcome).toEqual({ kind: 'drawer', id: 'graph', fetch: true })
    expect(panel.drawers.expandedIds()).toEqual(['graph'])

    // And closing it asks for nothing.
    expect(panel.handleKey('enter', undefined)).toEqual({ kind: 'drawer', id: 'graph', fetch: false })
    expect(panel.drawers.expandedIds()).toEqual([])
  })

  it('opens and closes with the arrows too', () => {
    const panel = panelWithChange()
    panel.handleKey('down', undefined)
    expect(panel.handleKey('right', undefined)).toMatchObject({ fetch: true })
    // A second `→` on an open drawer is not a second fetch.
    expect(panel.handleKey('right', undefined)).toMatchObject({ fetch: false })
    panel.handleKey('left', undefined)
    expect(panel.drawers.expandedIds()).toEqual([])
  })

  it('steps over a drawer note, which is a label and not a destination', () => {
    const panel = panelWithChange()
    panel.handleKey('down', undefined)
    panel.handleKey('enter', undefined)
    panel.drawers.adopt({ drawer: 'graph', rows: [], note: 'no commits yet' })
    // Down from the Graph header skips its note and lands on the next header.
    panel.handleKey('down', undefined)
    expect(panel.selected()?.text).toBe('▸ Commits')
  })

  it('opens a row menu on `m` and on enter, and never on a file row', () => {
    const panel = panelWithChange()
    panel.handleKey('down', undefined)
    panel.handleKey('enter', undefined)
    panel.drawers.adopt({ drawer: 'graph', rows: [commit()], note: null })
    panel.handleKey('down', undefined)
    const expected = { kind: 'drawerMenu', drawer: 'graph', row: commit() }
    expect(panel.handleKey('enter', undefined)).toEqual(expected)
    expect(panel.handleKey(' ', 'm')).toEqual(expected)

    // Back up on the file row, `m` means nothing: the changes list has its own keys.
    panel.handleKey('up', undefined)
    panel.handleKey('up', undefined)
    expect(panel.selected()?.kind).toBe('file')
    expect(panel.handleKey(' ', 'm')).toEqual({ kind: 'none' })
  })

  it('still stages with enter on a file, with drawers below it', () => {
    const panel = panelWithChange()
    expect(panel.handleKey('enter', undefined)).toEqual({ kind: 'stage', paths: ['src/widget.ts'] })
  })

  it('keeps the cursor on something real when a drawer closes under it', () => {
    const panel = panelWithChange()
    panel.handleKey('down', undefined)
    panel.handleKey('enter', undefined)
    panel.drawers.adopt({ drawer: 'graph', rows: [commit(), commit(), commit()], note: null })
    panel.handleKey('down', undefined)
    panel.handleKey('down', undefined)
    expect(panel.selected()?.kind).toBe('drawer-row')
    // Collapsing from a row inside the drawer: the cursor must not be left past the end.
    panel.drawers.collapse('graph')
    expect(panel.selected()).not.toBeNull()
  })
})
