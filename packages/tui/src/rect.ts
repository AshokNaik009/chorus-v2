/**
 * Rectangles and how they split.
 *
 * Ported from herdr's `src/layout.rs` (Apache-2.0); `split` is `split_rect` with the same
 * rounding and the same saturating remainder, so a herdr layout and this one place their
 * dividers on identical columns.
 */

export type Direction = 'horizontal' | 'vertical'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height) }
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 }

export function isEmpty(r: Rect): boolean {
  return r.width === 0 || r.height === 0
}

export function area(r: Rect): number {
  return r.width * r.height
}

export function right(r: Rect): number {
  return r.x + r.width
}

export function bottom(r: Rect): number {
  return r.y + r.height
}

export function contains(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < right(r) && y >= r.y && y < bottom(r)
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < right(b) && b.x < right(a) && a.y < bottom(b) && b.y < bottom(a)
}

export function intersection(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const x2 = Math.min(right(a), right(b))
  const y2 = Math.min(bottom(a), bottom(b))
  if (x2 <= x || y2 <= y) return EMPTY_RECT
  return { x, y, width: x2 - x, height: y2 - y }
}

/** Shrink on every side. Returns an empty rect rather than a negative one. */
export function inset(r: Rect, horizontal: number, vertical: number = horizontal): Rect {
  const width = r.width - horizontal * 2
  const height = r.height - vertical * 2
  if (width <= 0 || height <= 0) return { x: r.x, y: r.y, width: 0, height: 0 }
  return { x: r.x + horizontal, y: r.y + vertical, width, height }
}

/**
 * Split by ratio. Horizontal splits side by side, vertical stacks.
 *
 * The first child is rounded and the second takes the remainder, so the two always sum to
 * the parent exactly — no off-by-one gap column at any ratio or width.
 */
export function split(r: Rect, direction: Direction, ratio: number): [Rect, Rect] {
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

/**
 * Divide into `count` parts along `direction`, distributing the remainder to the leading
 * parts so the parts sum to the parent exactly.
 */
export function splitEvenly(r: Rect, direction: Direction, count: number): Rect[] {
  if (count <= 0) return []
  const total = direction === 'horizontal' ? r.width : r.height
  const base = Math.floor(total / count)
  const extra = total - base * count
  const parts: Rect[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    const size = base + (i < extra ? 1 : 0)
    parts.push(
      direction === 'horizontal'
        ? { x: r.x + offset, y: r.y, width: size, height: r.height }
        : { x: r.x, y: r.y + offset, width: r.width, height: size }
    )
    offset += size
  }
  return parts
}
