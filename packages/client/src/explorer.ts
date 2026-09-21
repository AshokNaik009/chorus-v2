/**
 * The file explorer: a tree with git decorations.
 *
 * The shape is herdr-sidebar's Explorer (MIT); the implementation is this project's.
 * See `NOTICE`.
 *
 * ## Lazy, and flattened for drawing
 *
 * A node's children are `null` until it is expanded, because a checkout with a
 * `node_modules` is hundreds of thousands of entries and the ones on screen are the
 * few dozen someone opened. What is drawn is a flat list built from the expanded
 * nodes, so scrolling and cursor movement are index arithmetic rather than a walk.
 *
 * ## Glyphs are ASCII unless asked
 *
 * Nerd Font icons look better and cost correctness: they live in the Private Use Area,
 * `codePointWidth` measures them as one column, and a terminal or font that disagrees
 * shifts every column after them — which is the bug `pane-buttons = ascii` already
 * exists to escape. Phase 9 added the setting the previous note promised: `[sidebar]
 * icons` picks one of three themes, `ascii` is the default and draws no icon column at
 * all, and `icons.ts` holds the reason and the width check.
 *
 * ## Everything drawn is measured in columns, not characters
 *
 * Every string this file puts on screen goes through `truncate`, which counts display
 * columns. A `slice` counts UTF-16 code units, and the two disagree about every CJK
 * filename, every emoji and every combining mark — by a factor of two in the direction
 * that silently loses half a row.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { FsEntry, GitStatusResult } from '@leap-chorus/protocol'
import { wrapWords, type Palette } from './chrome.js'
import { ASCII_THEME, iconFor, type IconTheme } from './icons.js'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'

export interface TreeNode {
  /** Repo-relative. `''` is the root, which is never drawn as a row. */
  readonly path: string
  readonly name: string
  readonly kind: 'dir' | 'file' | 'other'
  expanded: boolean
  /** Null until listed. Empty means listed and empty. */
  children: TreeNode[] | null
  loading: boolean
}

/** A drawable line: a node plus how deep it sits. */
export interface TreeRow {
  readonly node: TreeNode
  readonly depth: number
}

export type ExplorerOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'refresh' }
  /** Load this directory's children; the app calls `adopt` when they arrive. */
  | { readonly kind: 'expand'; readonly path: string }
  | { readonly kind: 'open'; readonly path: string }
  /**
   * Show this file in the dock's preview, and open nothing.
   *
   * Distinct from `open` because a click and `⏎` are not the same request. `⏎` is
   * "open this", and `[sidebar] preview` decides whether that means the dock or a
   * `$PAGER` pane. A *click* is a glance — a mouse user clicking down a tree to see
   * what is in each file must not be spawning a pane per file, which is exactly what
   * happens when a click is treated as `⏎` with the setting off.
   */
  | { readonly kind: 'preview'; readonly path: string }
  /**
   * Stage this path. A directory stages the files beneath it — the daemon enumerates
   * them rather than handing the directory to `git add`, which is what keeps a nested
   * repository from being recorded as a gitlink. See `git.ts`.
   */
  | { readonly kind: 'stage'; readonly path: string }
  /**
   * Open the row menu for this path.
   *
   * herdr-sidebar's `m`, and the `ContextMenu` widget it needs already existed in
   * `prompt.ts` — this row was an orphan in `PARITY.md` only because nothing had
   * connected the two. The panel holds no menu state: it names the row and the app
   * builds the menu, the same split every other action here follows.
   */
  | { readonly kind: 'menu'; readonly path: string; readonly isDir: boolean }

/**
 * Keep the old node wherever the new listing has the same path and kind.
 *
 * Keeping the *node* is the point: it carries `expanded` and the children below it, so
 * a subtree three levels deep survives its parent being re-listed. A path whose kind
 * changed — a file replaced by a directory — is taken fresh, because its children are
 * no longer about the same thing.
 */
function merge(previous: TreeNode[] | null, fresh: TreeNode[]): TreeNode[] {
  if (previous === null) return fresh
  const byPath = new Map(previous.map((node) => [node.path, node]))
  return fresh.map((node) => {
    const old = byPath.get(node.path)
    return old !== undefined && old.kind === node.kind ? old : node
  })
}

function makeNode(entry: FsEntry, parentPath: string): TreeNode {
  return {
    path: parentPath === '' ? entry.name : `${parentPath}/${entry.name}`,
    name: entry.name,
    kind: entry.kind,
    expanded: false,
    children: null,
    loading: false
  }
}

export class ExplorerPanel {
  /** The root's children, or null before the first listing arrives. */
  private roots: TreeNode[] | null = null
  root = ''
  error: string | null = null
  status: GitStatusResult | null = null
  showHidden = false
  /**
   * The glyph set, handed down by the container from `[sidebar] icons`.
   *
   * `ascii` — which draws no icon column at all — until told otherwise, so the tree is
   * byte-identical to what phases 7 and 8 shipped unless somebody asked for more. See
   * `icons.ts` for why that default is about column widths and not about taste.
   */
  icons: IconTheme = ASCII_THEME
  private cursor = 0
  private readonly view = new ScrollView()

  /**
   * Take a listing for `path`.
   *
   * Merged against what was there rather than replacing it, at every level including
   * the root, so a refresh keeps the open subtrees open. Folding the whole tree up on
   * every `r` — or on every git change, once this polls — would make the key useless.
   */
  adopt(root: string, path: string, entries: readonly FsEntry[]): void {
    this.root = root
    this.error = null
    const fresh = entries.map((entry) => makeNode(entry, path))

    if (path === '') {
      this.roots = merge(this.roots, fresh)
      this.clampCursor()
      return
    }
    const node = this.find(path)
    if (node === null) return
    node.children = merge(node.children, fresh)
    node.loading = false
    node.expanded = true
    this.clampCursor()
  }

  fail(message: string): void {
    this.error = message
    const node = this.selected()
    if (node !== null) node.loading = false
  }

  private find(path: string, nodes: TreeNode[] | null = this.roots): TreeNode | null {
    for (const node of nodes ?? []) {
      if (node.path === path) return node
      const found = this.find(path, node.children)
      if (found !== null) return found
    }
    return null
  }

  private visible(nodes: TreeNode[]): TreeNode[] {
    return this.showHidden ? nodes : nodes.filter((node) => !node.name.startsWith('.'))
  }

  /** The flattened, currently-drawable rows. */
  rows(): TreeRow[] {
    const out: TreeRow[] = []
    const walk = (nodes: TreeNode[], depth: number): void => {
      for (const node of this.visible(nodes)) {
        out.push({ node, depth })
        if (node.expanded && node.children !== null) walk(node.children, depth + 1)
      }
    }
    if (this.roots !== null) walk(this.roots, 0)
    return out
  }

  selected(): TreeNode | null {
    return this.rows()[this.cursor]?.node ?? null
  }

  private clampCursor(): void {
    const count = this.rows().length
    if (count === 0) {
      this.cursor = 0
      return
    }
    this.cursor = Math.min(Math.max(this.cursor, 0), count - 1)
  }


  handleKey(name: string, char: string | undefined): ExplorerOutcome {
    if (name === 'escape') return { kind: 'close' }
    if (name === 'up' || char === 'k') {
      this.cursor -= 1
      this.clampCursor()
      return { kind: 'none' }
    }
    if (name === 'down' || char === 'j') {
      this.cursor += 1
      this.clampCursor()
      return { kind: 'none' }
    }
    if (name === 'enter' || char === 'l' || name === 'right') return this.activate()
    if (char === 'h' || name === 'left') return this.collapse()

    switch (char) {
      case 'q':
      case 'b':
        return { kind: 'close' }
      case 'r':
        return { kind: 'refresh' }
      case 's': {
        // The Explorer's one write. It is here rather than only in the panel because
        // the tree is where a *directory* is a thing you can point at.
        const node = this.selected()
        return node === null ? { kind: 'none' } : { kind: 'stage', path: node.path }
      }
      case 'm': {
        const node = this.selected()
        return node === null ? { kind: 'none' } : { kind: 'menu', path: node.path, isDir: node.kind === 'dir' }
      }
      case '.':
        this.showHidden = !this.showHidden
        this.clampCursor()
        return { kind: 'none' }
      default:
        return { kind: 'none' }
    }
  }

  /** Enter on a directory expands or folds it; on a file it opens it. */
  activate(): ExplorerOutcome {
    const node = this.selected()
    if (node === null) return { kind: 'none' }
    if (node.kind !== 'dir') return { kind: 'open', path: node.path }
    if (node.expanded) {
      node.expanded = false
      this.clampCursor()
      return { kind: 'none' }
    }
    if (node.children !== null) {
      node.expanded = true
      this.clampCursor()
      return { kind: 'none' }
    }
    node.loading = true
    return { kind: 'expand', path: node.path }
  }

  /**
   * Fold the selected directory, or jump to the parent of whatever is selected.
   *
   * Moving to the parent when there is nothing to fold is what makes `h` usable as
   * "out": pressing it repeatedly walks up the tree instead of doing nothing.
   */
  private collapse(): ExplorerOutcome {
    const node = this.selected()
    if (node === null) return { kind: 'none' }
    if (node.kind === 'dir' && node.expanded) {
      node.expanded = false
      return { kind: 'none' }
    }
    const parent = node.path.includes('/') ? node.path.slice(0, node.path.lastIndexOf('/')) : null
    if (parent === null) return { kind: 'none' }
    const index = this.rows().findIndex((row) => row.node.path === parent)
    if (index !== -1) this.cursor = index
    return { kind: 'none' }
  }

  /**
   * Put the cursor on a clicked row, then fold a directory or glance at a file.
   *
   * A click used to only move the cursor, which made a folder look inert: you clicked
   * it, the row highlighted, and nothing opened. Every file tree a person has used —
   * herdr-sidebar included — folds a directory on a single click.
   *
   * A file is deliberately **not** treated as `⏎`. That was tried and was worse: with
   * `[sidebar] preview` off, `⏎` hands the file to `$PAGER` in a new pane, so clicking
   * down a tree to see what is in each file left a pane behind per click — and the
   * keyboard stays with the dock, so none of those panes could even be scrolled. A
   * click previews in the dock and opens nothing.
   */
  clickRow(screenRow: number, area: Rect): ExplorerOutcome {
    const index = this.view.indexAt(screenRow, area.y + LIST_TOP, this.rows().length, area.height - LIST_TOP)
    if (index === null) return { kind: 'none' }
    this.cursor = index
    const node = this.selected()
    if (node === null) return { kind: 'none' }
    if (node.kind !== 'dir') return { kind: 'preview', path: node.path }
    return this.activate()
  }

  /** Scroll without moving the cursor. The next keystroke pulls the view back to it. */
  scrollBy(delta: number, area: Rect): void {
    this.view.by(delta, this.rows().length, Math.max(0, area.height - LIST_TOP))
  }

  /**
   * The git letter for a path: the file's own, or `·` for a directory containing one.
   *
   * The directory marker is what makes a folded tree worth looking at — it says there
   * is something under here without making you open every folder to find it.
   */
  decoration(path: string, kind: TreeNode['kind']): string | null {
    const index = this.decorations()
    if (index === null) return null
    if (kind === 'dir') return index.dirs.has(path) ? '·' : null
    return index.files.get(path) ?? null
  }

  /**
   * The status, turned inside out into two lookups, once per status rather than per row.
   *
   * This used to be three linear scans *per row, per frame*, one of them spreading both
   * sides of the status into a fresh array to do it. A tree of forty visible rows over a
   * status of two hundred changes did twenty-four thousand string comparisons and forty
   * array allocations every time the dock repainted — and the dock repaints on every
   * keystroke. Building the index once per status makes it two hash lookups per row.
   *
   * Cached against the status *object*, not a copy of it: `adopt` and the app both
   * replace `status` wholesale, so identity is exactly the right invalidation signal and
   * there is no second thing to remember to update.
   */
  private decorationCache: {
    readonly status: GitStatusResult
    readonly files: Map<string, string>
    readonly dirs: Set<string>
  } | null = null

  private decorations(): { files: Map<string, string>; dirs: Set<string> } | null {
    const status = this.status
    if (status === null) return null
    const cached = this.decorationCache
    if (cached !== null && cached.status === status) return cached
    const files = new Map<string, string>()
    const dirs = new Set<string>()
    // Staged first, then unstaged, so the unstaged letter wins where a path is on both
    // sides — which is what the old `unstaged ?? staged` ordering said.
    for (const side of [status.staged, status.unstaged]) {
      for (const entry of side) {
        files.set(entry.path, entry.letter)
        // Every ancestor directory of a touched path is itself touched. Walking up once
        // per change is what replaces the per-directory `startsWith` scan.
        let slash = entry.path.indexOf('/')
        while (slash !== -1) {
          dirs.add(entry.path.slice(0, slash))
          slash = entry.path.indexOf('/', slash + 1)
        }
      }
    }
    this.decorationCache = { status, files, dirs }
    return this.decorationCache
  }

  renderInto(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    const right = area.x + area.width
    const height = area.height - LIST_TOP
    buffer.writeString(
      area.x,
      area.y,
      truncate(this.root === '' ? 'explorer' : basename(this.root), area.width),
      palette.sidebarActive,
      right
    )

    if (this.error !== null) {
      // Wrapped, not clipped: a stage that stopped at a nested repository says so in a
      // sentence, and thirty-four columns of it is the half that names no reason.
      let y = area.y + LIST_TOP
      for (const line of wrapWords(this.error, area.width)) {
        if (y >= area.y + area.height) break
        buffer.writeString(area.x, y, line, palette.agent['blocked'] ?? palette.sidebar, right)
        y += 1
      }
      return
    }
    const rows = this.rows()
    if (this.roots === null) {
      buffer.writeString(area.x, area.y + LIST_TOP, truncate('loading…', area.width), palette.sidebar, right)
      return
    }
    if (rows.length === 0) {
      buffer.writeString(area.x, area.y + LIST_TOP, truncate('empty', area.width), palette.sidebar, right)
      return
    }

    const bar = needsScrollbar(rows.length, height)
    const room = area.width - (bar ? 1 : 0)
    const offset = this.view.follow(this.cursor, rows.length, height)
    let y = area.y + LIST_TOP
    for (const row of rows.slice(offset, offset + height)) {
      const isSelected = rows[this.cursor]?.node === row.node
      const rowStyle = isSelected ? palette.sidebarActive : palette.sidebar
      buffer.fill({ x: area.x, y, width: room, height: 1 }, ' ', rowStyle)

      // `>` folded, `v` open, two spaces for a file: the marker column is always there
      // so names line up whatever a row happens to be.
      const marker = row.node.kind !== 'dir' ? '  ' : row.node.loading ? '· ' : row.node.expanded ? 'v ' : '> '
      const indent = '  '.repeat(row.depth)
      const icon = iconFor(this.icons, row.node.name, row.node.kind, row.node.expanded)
      const name = row.node.kind === 'dir' ? `${row.node.name}/` : row.node.name
      const letter = this.decoration(row.node.path, row.node.kind)
      // The letter is pinned to the right edge, so the eye reads one column of them.
      const space = room - (letter === null ? 0 : 2)
      // `truncate`, not a `slice`: this used to clip by **character count** while every
      // other panel in the dock measured columns, so a CJK filename was cut at half the
      // width it had been given and the row ended in a blank column with no `…` to say
      // anything had been dropped. The limit passed to `writeString` is the reserved
      // width too, not the dock's right edge, so a wide glyph can never be drawn into
      // the column the status letter is about to take.
      buffer.writeString(
        area.x,
        y,
        truncate(`${indent}${marker}${icon}${name}`, Math.max(0, space)),
        rowStyle,
        area.x + Math.max(0, space)
      )
      if (letter !== null) {
        buffer.writeString(
          area.x + room - 1,
          y,
          letter,
          isSelected ? rowStyle : letterStyle(letter, palette),
          right
        )
      }
      y += 1
    }
    if (bar) {
      renderScrollbar(
        buffer,
        { x: area.x + area.width - 1, y: area.y + LIST_TOP, width: 1, height },
        offset,
        rows.length,
        palette
      )
    }
  }
}

/** Rows above the list: the root name and a blank. */
const LIST_TOP = 2

function basename(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

function letterStyle(letter: string, palette: Palette) {
  if (letter === '!' || letter === 'D') return palette.agent['blocked'] ?? palette.sidebar
  if (letter === 'U' || letter === 'A') return palette.agent['done'] ?? palette.sidebar
  return palette.agent['working'] ?? palette.sidebar
}

export const EXPLORER_HINT =
  '↑↓ move · ⏎ open · h/l fold · s stage · m menu · . hidden · r refresh · ^p quick open · 2 search · 3 git · esc close'
