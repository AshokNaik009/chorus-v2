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
 * ## Glyphs are ASCII
 *
 * Nerd Font icons would look better and cost correctness: they live in the Private Use
 * Area, `codePointWidth` measures them as one column, and a terminal or font that
 * disagrees shifts every column after them — which is the bug `pane-buttons = ascii`
 * already exists to escape. Working everywhere comes first; an icon theme can be added
 * behind a setting later.
 */

import { ScreenBuffer, type Rect } from '@leap-chorus/tui'
import type { FsEntry, GitStatusResult } from '@leap-chorus/protocol'
import type { Palette } from './chrome.js'

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
  private cursor = 0
  private scroll = 0

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

  /**
   * Scroll so the cursor is on screen, moving as little as possible.
   *
   * Called at render rather than on each keystroke, because the height is the renderer's
   * to know and a panel that has not been drawn yet has none.
   */
  private syncScroll(height: number): void {
    const count = this.rows().length
    if (height <= 0 || count === 0) {
      this.scroll = 0
      return
    }
    if (this.cursor < this.scroll) this.scroll = this.cursor
    if (this.cursor >= this.scroll + height) this.scroll = this.cursor - height + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, count - height)))
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
      case '.':
        this.showHidden = !this.showHidden
        this.clampCursor()
        return { kind: 'none' }
      default:
        return { kind: 'none' }
    }
  }

  /** Enter on a directory expands or folds it; on a file it opens it. */
  private activate(): ExplorerOutcome {
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

  /** Put the cursor on a clicked row. Returns whether it landed on one. */
  clickRow(screenRow: number, area: Rect): boolean {
    const index = this.scroll + (screenRow - (area.y + LIST_TOP))
    if (index < 0 || index >= this.rows().length) return false
    this.cursor = index
    return true
  }

  /**
   * The git letter for a path: the file's own, or `·` for a directory containing one.
   *
   * The directory marker is what makes a folded tree worth looking at — it says there
   * is something under here without making you open every folder to find it.
   */
  decoration(path: string, kind: TreeNode['kind']): string | null {
    const status = this.status
    if (status === null) return null
    if (kind === 'dir') {
      const prefix = `${path}/`
      const touched = [...status.staged, ...status.unstaged].some((entry) => entry.path.startsWith(prefix))
      return touched ? '·' : null
    }
    const staged = status.staged.find((entry) => entry.path === path)
    const unstaged = status.unstaged.find((entry) => entry.path === path)
    return unstaged?.letter ?? staged?.letter ?? null
  }

  renderInto(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    const right = area.x + area.width
    const height = area.height - LIST_TOP
    buffer.writeString(
      area.x,
      area.y,
      clip(this.root === '' ? 'explorer' : basename(this.root), area.width),
      palette.sidebarActive,
      right
    )

    if (this.error !== null) {
      buffer.writeString(area.x, area.y + LIST_TOP, clip(this.error, area.width), palette.agent['blocked'] ?? palette.sidebar, right)
      return
    }
    const rows = this.rows()
    if (this.roots === null) {
      buffer.writeString(area.x, area.y + LIST_TOP, clip('loading…', area.width), palette.sidebar, right)
      return
    }
    if (rows.length === 0) {
      buffer.writeString(area.x, area.y + LIST_TOP, clip('empty', area.width), palette.sidebar, right)
      return
    }

    this.syncScroll(height)
    let y = area.y + LIST_TOP
    for (const row of rows.slice(this.scroll, this.scroll + height)) {
      const isSelected = rows[this.cursor]?.node === row.node
      const rowStyle = isSelected ? palette.sidebarActive : palette.sidebar
      buffer.fill({ x: area.x, y, width: area.width, height: 1 }, ' ', rowStyle)

      // `>` folded, `v` open, two spaces for a file: the marker column is always there
      // so names line up whatever a row happens to be.
      const marker = row.node.kind !== 'dir' ? '  ' : row.node.loading ? '· ' : row.node.expanded ? 'v ' : '> '
      const indent = '  '.repeat(row.depth)
      const name = row.node.kind === 'dir' ? `${row.node.name}/` : row.node.name
      const letter = this.decoration(row.node.path, row.node.kind)
      // The letter is pinned to the right edge, so the eye reads one column of them.
      const room = area.width - (letter === null ? 0 : 2)
      buffer.writeString(area.x, y, clip(`${indent}${marker}${name}`, room), rowStyle, right)
      if (letter !== null) {
        buffer.writeString(
          area.x + area.width - 1,
          y,
          letter,
          isSelected ? rowStyle : letterStyle(letter, palette),
          right
        )
      }
      y += 1
    }
  }
}

/** Rows above the list: the root name and a blank. */
const LIST_TOP = 2

function basename(path: string): string {
  const parts = path.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

function clip(text: string, width: number): string {
  return text.length <= width ? text : text.slice(0, Math.max(0, width))
}

function letterStyle(letter: string, palette: Palette) {
  if (letter === '!' || letter === 'D') return palette.agent['blocked'] ?? palette.sidebar
  if (letter === 'U' || letter === 'A') return palette.agent['done'] ?? palette.sidebar
  return palette.agent['working'] ?? palette.sidebar
}

export const EXPLORER_HINT = '↑↓ move · ⏎ open · h/l fold · . hidden · r refresh · 2 source control · esc close'
