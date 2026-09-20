/**
 * Rectangles, and how a split divides one.
 *
 * Ported from herdr's `src/layout.rs` (Apache-2.0, herdr 3f2a6e74): `split` is
 * `split_rect`, with the same rounding and the same saturating remainder, so a herdr
 * layout and this one put their dividers on identical columns.
 *
 * ## Why this duplicates `@leap-chorus/tui`'s `rect.ts`
 *
 * PHASE-4 criterion 1 requires `core`'s `dependencies` to be empty, and a workspace
 * dependency is still a dependency. The layout tree lives here because it is session
 * state rather than presentation, and a layout tree cannot compute pane rects without
 * knowing what a rect is. So the ~40 lines of geometry the tree needs are restated
 * rather than imported. `tui/src/rect.ts` keeps the drawing-side helpers (insets,
 * intersections, even division) that nothing here wants.
 */

/** A split's axis. `horizontal` puts the children side by side. */
export type Direction = 'horizontal' | 'vertical'

/** A cardinal move, as `pane.focus_direction` and `pane.resize` name them. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

export function right(r: Rect): number {
  return r.x + r.width
}

export function bottom(r: Rect): number {
  return r.y + r.height
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < right(r) && y >= r.y && y < bottom(r)
}

/**
 * Split by ratio. The first child is rounded and the second takes the remainder, so the
 * two always sum to the parent exactly — no off-by-one gap column at any ratio or width.
 */
export function splitRect(r: Rect, direction: Direction, ratio: number): [Rect, Rect] {
  const clamped = Math.min(1, Math.max(0, ratio))
  if (direction === 'horizontal') {
    const firstWidth = Math.round(r.width * clamped)
    return [
      { x: r.x, y: r.y, width: firstWidth, height: r.height },
      { x: r.x + firstWidth, y: r.y, width: Math.max(0, r.width - firstWidth), height: r.height }
    ]
  }
  const firstHeight = Math.round(r.height * clamped)
  return [
    { x: r.x, y: r.y, width: r.width, height: firstHeight },
    { x: r.x, y: r.y + firstHeight, width: r.width, height: Math.max(0, r.height - firstHeight) }
  ]
}

/** The axis a cardinal direction moves along. */
export function axisOf(direction: PaneDirection): Direction {
  return direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical'
}
