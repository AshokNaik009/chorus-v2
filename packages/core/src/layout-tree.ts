/**
 * The BSP layout tree.
 *
 * Ported from herdr's `src/layout.rs` (Apache-2.0, herdr 3f2a6e74). The tree shape,
 * `split_pane` / `close_pane` collapse semantics, `set_split_ratio`'s path addressing,
 * and `split_rect`'s rounding come from there.
 *
 * Two deliberate differences from herdr, both carried over from phase 2's `TileLayout`:
 *
 * - Pane ids are strings, not a global `u32` counter, so a pane has one identity from
 *   the layout tree through the API to the daemon's PTY session.
 * - `neighbor` is geometric — the nearest overlapping pane in the given direction —
 *   rather than herdr's split-walk. Same answers on ordinary layouts, a third of the
 *   code, and it does not need the split-path bookkeeping that herdr's mouse-drag resize
 *   requires. `resizeAlong` *does* walk the tree, because "grow this pane" has to know
 *   which divider the pane touches.
 *
 * Nodes are immutable: every operation returns a new tree and leaves the old one intact.
 * The trees are tiny (one node per pane plus one per split), so structural sharing is
 * enough and there is never a half-mutated tree to reason about.
 */

import { axisOf, splitRect, type Direction, type PaneDirection, type Rect } from './geometry.js'

export type PaneId = string

export type LayoutNode =
  | { readonly kind: 'pane'; readonly id: PaneId }
  | {
      readonly kind: 'split'
      readonly direction: Direction
      readonly ratio: number
      readonly first: LayoutNode
      readonly second: LayoutNode
    }

/** Smallest a pane may be squeezed to before `canSplit` refuses. */
export const MIN_PANE_COLS = 4
export const MIN_PANE_ROWS = 2

/** Ratio bounds. A divider never reaches an edge, so no pane is ever zero-sized. */
export const MIN_RATIO = 0.05
export const MAX_RATIO = 0.95

export function paneNode(id: PaneId): LayoutNode {
  return { kind: 'pane', id }
}

export function splitNode(
  direction: Direction,
  ratio: number,
  first: LayoutNode,
  second: LayoutNode
): LayoutNode {
  return { kind: 'split', direction, ratio, first, second }
}

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

export interface PanePlacement {
  readonly id: PaneId
  /** Outer rect, borders included. */
  readonly rect: Rect
}

/**
 * A divider, addressed the way `layout.set_split_ratio` addresses it: by the path from
 * the root, where false takes the first child and true the second.
 */
export interface SplitBorder {
  /** Column (horizontal split) or row (vertical split) the divider sits on. */
  readonly pos: number
  readonly direction: Direction
  readonly ratio: number
  readonly area: Rect
  readonly path: readonly boolean[]
}

export function paneIds(node: LayoutNode): PaneId[] {
  const out: PaneId[] = []
  collectIds(node, out)
  return out
}

function collectIds(node: LayoutNode, out: PaneId[]): void {
  if (node.kind === 'pane') {
    out.push(node.id)
    return
  }
  collectIds(node.first, out)
  collectIds(node.second, out)
}

export function paneCount(node: LayoutNode): number {
  return node.kind === 'pane' ? 1 : paneCount(node.first) + paneCount(node.second)
}

export function hasPane(node: LayoutNode, id: PaneId): boolean {
  if (node.kind === 'pane') return node.id === id
  return hasPane(node.first, id) || hasPane(node.second, id)
}

/** Rects for every pane, in tree order (left/top first). */
export function placements(node: LayoutNode, area: Rect): PanePlacement[] {
  const out: PanePlacement[] = []
  collectPlacements(node, area, out)
  return out
}

function collectPlacements(node: LayoutNode, area: Rect, out: PanePlacement[]): void {
  if (node.kind === 'pane') {
    out.push({ id: node.id, rect: area })
    return
  }
  const [a, b] = splitRect(area, node.direction, node.ratio)
  collectPlacements(node.first, a, out)
  collectPlacements(node.second, b, out)
}

export function placementOf(node: LayoutNode, id: PaneId, area: Rect): Rect | null {
  return placements(node, area).find((entry) => entry.id === id)?.rect ?? null
}

/** Every divider, for mouse drag-resize and for `layout.set_split_ratio`. */
export function splitBorders(node: LayoutNode, area: Rect): SplitBorder[] {
  const out: SplitBorder[] = []
  collectSplits(node, area, [], out)
  return out
}

function collectSplits(node: LayoutNode, area: Rect, path: boolean[], out: SplitBorder[]): void {
  if (node.kind !== 'split') return
  const [a, b] = splitRect(area, node.direction, node.ratio)
  out.push({
    pos: node.direction === 'horizontal' ? a.x + a.width : a.y + a.height,
    direction: node.direction,
    ratio: node.ratio,
    area,
    path: [...path]
  })
  collectSplits(node.first, a, [...path, false], out)
  collectSplits(node.second, b, [...path, true], out)
}

/** True when a pane of this size still yields two usable halves. */
export function canSplit(paneRect: Rect, direction: Direction): boolean {
  return direction === 'horizontal'
    ? paneRect.width >= MIN_PANE_COLS * 2
    : paneRect.height >= MIN_PANE_ROWS * 2
}

/**
 * Split `target`, putting `newId` in the second half.
 *
 * Returns the original tree when `target` is not present, so a caller can compare by
 * identity to learn whether anything happened.
 */
export function splitPane(
  node: LayoutNode,
  target: PaneId,
  direction: Direction,
  newId: PaneId,
  ratio = 0.5
): LayoutNode {
  if (node.kind === 'pane') {
    return node.id === target
      ? splitNode(direction, clampRatio(ratio), paneNode(node.id), paneNode(newId))
      : node
  }
  const first = splitPane(node.first, target, direction, newId, ratio)
  const second = first === node.first ? splitPane(node.second, target, direction, newId, ratio) : node.second
  if (first === node.first && second === node.second) return node
  return splitNode(node.direction, node.ratio, first, second)
}

/**
 * Remove a pane, collapsing its parent split into the surviving sibling.
 *
 * Returns null when the tree held only that pane: a layout with no panes has no focus
 * and nothing to draw, so the caller closes the tab instead.
 */
export function removePane(node: LayoutNode, target: PaneId): LayoutNode | null {
  if (node.kind === 'pane') return node.id === target ? null : node
  const first = removePane(node.first, target)
  if (first === null) return node.second
  const second = removePane(node.second, target)
  if (second === null) return node.first
  if (first === node.first && second === node.second) return node
  return splitNode(node.direction, node.ratio, first, second)
}

/** Exchange two panes' positions in the tree. Both must be present. */
export function swapPanes(node: LayoutNode, a: PaneId, b: PaneId): LayoutNode {
  if (a === b) return node
  if (!hasPane(node, a) || !hasPane(node, b)) return node
  return rename(node)

  function rename(current: LayoutNode): LayoutNode {
    if (current.kind === 'pane') {
      if (current.id === a) return paneNode(b)
      if (current.id === b) return paneNode(a)
      return current
    }
    return splitNode(current.direction, current.ratio, rename(current.first), rename(current.second))
  }
}

/** Replace one pane id with another, keeping its position. Used by restore. */
export function replacePane(node: LayoutNode, from: PaneId, to: PaneId): LayoutNode {
  if (node.kind === 'pane') return node.id === from ? paneNode(to) : node
  const first = replacePane(node.first, from, to)
  const second = replacePane(node.second, from, to)
  if (first === node.first && second === node.second) return node
  return splitNode(node.direction, node.ratio, first, second)
}

/** Set the ratio of the split at `path`. Returns the original tree if the path misses. */
export function setSplitRatio(node: LayoutNode, path: readonly boolean[], ratio: number): LayoutNode {
  if (path.length === 0) {
    if (node.kind !== 'split') return node
    const next = clampRatio(ratio)
    if (next === node.ratio) return node
    return splitNode(node.direction, next, node.first, node.second)
  }
  if (node.kind !== 'split') return node
  const [head, ...rest] = path
  if (head === true) {
    const second = setSplitRatio(node.second, rest, ratio)
    return second === node.second ? node : splitNode(node.direction, node.ratio, node.first, second)
  }
  const first = setSplitRatio(node.first, rest, ratio)
  return first === node.first ? node : splitNode(node.direction, node.ratio, first, node.second)
}

/**
 * Nudge the divider nearest to `target` along `direction`.
 *
 * Nearest, not outermost: growing a pane should move the divider it actually touches.
 * The sign flips when the pane lives in the second half, so `amount > 0` always means
 * "give this pane more room".
 */
export function resizeAlong(
  node: LayoutNode,
  target: PaneId,
  direction: Direction,
  amount: number
): LayoutNode {
  return walk(node).node

  function walk(current: LayoutNode): { node: LayoutNode; changed: boolean; contains: boolean } {
    if (current.kind === 'pane') {
      return { node: current, changed: false, contains: current.id === target }
    }
    const first = walk(current.first)
    const second = walk(current.second)
    const contains = first.contains || second.contains

    if (first.changed || second.changed) {
      return {
        node: splitNode(current.direction, current.ratio, first.node, second.node),
        changed: true,
        contains
      }
    }
    if (contains && current.direction === direction) {
      const signed = first.contains ? amount : -amount
      const ratio = clampRatio(current.ratio + signed)
      if (ratio === current.ratio) return { node: current, changed: false, contains }
      return {
        node: splitNode(current.direction, ratio, current.first, current.second),
        changed: true,
        contains
      }
    }
    return { node: current, changed: false, contains }
  }
}

/** `resizeAlong`, addressed by a cardinal direction. Right/down grow, left/up shrink. */
export function resizeDirection(
  node: LayoutNode,
  target: PaneId,
  direction: PaneDirection,
  amount: number
): LayoutNode {
  const signed = direction === 'right' || direction === 'down' ? amount : -amount
  return resizeAlong(node, target, axisOf(direction), signed)
}

/**
 * The nearest pane in a cardinal direction: the closest candidate whose edge lies beyond
 * the source pane's, among those overlapping it on the perpendicular axis. Overlap
 * breaks distance ties, so a column of small panes beside one tall pane picks the one
 * the source is actually next to.
 */
export function neighbor(
  node: LayoutNode,
  from: PaneId,
  direction: PaneDirection,
  area: Rect
): PaneId | null {
  const all = placements(node, area)
  const current = all.find((entry) => entry.id === from)
  if (!current) return null

  const horizontal = direction === 'left' || direction === 'right'
  let best: { id: PaneId; distance: number; overlap: number } | null = null

  for (const candidate of all) {
    if (candidate.id === current.id) continue
    const c = candidate.rect
    const f = current.rect

    const beyond = horizontal
      ? direction === 'right'
        ? c.x >= f.x + f.width
        : c.x + c.width <= f.x
      : direction === 'down'
        ? c.y >= f.y + f.height
        : c.y + c.height <= f.y
    if (!beyond) continue

    const overlap = horizontal
      ? Math.min(f.y + f.height, c.y + c.height) - Math.max(f.y, c.y)
      : Math.min(f.x + f.width, c.x + c.width) - Math.max(f.x, c.x)
    if (overlap <= 0) continue

    const distance = horizontal
      ? direction === 'right'
        ? c.x - (f.x + f.width)
        : f.x - (c.x + c.width)
      : direction === 'down'
        ? c.y - (f.y + f.height)
        : f.y - (c.y + c.height)

    if (best === null || distance < best.distance || (distance === best.distance && overlap > best.overlap)) {
      best = { id: candidate.id, distance, overlap }
    }
  }
  return best?.id ?? null
}

/** Cycle through panes in tree order. */
export function cyclePane(node: LayoutNode, from: PaneId, step: number): PaneId | null {
  const ids = paneIds(node)
  if (ids.length === 0) return null
  const index = ids.indexOf(from)
  if (index < 0) return ids[0] ?? null
  const size = ids.length
  const next = (((index + step) % size) + size) % size
  return ids[next] ?? null
}
