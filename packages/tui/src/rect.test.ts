import { describe, expect, it } from 'vitest'
import { EMPTY_RECT, contains, inset, intersection, intersects, rect, split, splitEvenly } from './rect.js'

describe('split', () => {
  it('parts always sum to the parent, at every ratio and width', () => {
    // An off-by-one here is a permanently blank column on screen, so check exhaustively.
    for (let width = 0; width < 120; width++) {
      for (const ratio of [0, 0.1, 0.3, 0.333, 0.5, 0.618, 0.75, 0.99, 1]) {
        const [a, b] = split(rect(0, 0, width, 10), 'horizontal', ratio)
        expect(a.width + b.width, `width=${width} ratio=${ratio}`).toBe(width)
        expect(b.x).toBe(a.x + a.width)
      }
    }
  })

  it('stacks vertically without a gap row', () => {
    for (let height = 0; height < 120; height++) {
      const [a, b] = split(rect(0, 0, 10, height), 'vertical', 0.5)
      expect(a.height + b.height).toBe(height)
      expect(b.y).toBe(a.y + a.height)
    }
  })

  it('rounds the first child, as herdr does', () => {
    const [a, b] = split(rect(0, 0, 9, 1), 'horizontal', 0.5)
    expect(a.width).toBe(5)
    expect(b.width).toBe(4)
  })

  it('clamps ratios outside 0..1', () => {
    const [a, b] = split(rect(0, 0, 10, 1), 'horizontal', 2)
    expect(a.width).toBe(10)
    expect(b.width).toBe(0)
    const [c, d] = split(rect(0, 0, 10, 1), 'horizontal', -1)
    expect(c.width).toBe(0)
    expect(d.width).toBe(10)
  })
})

describe('splitEvenly', () => {
  it('distributes the remainder and covers the parent exactly', () => {
    const parts = splitEvenly(rect(0, 0, 10, 1), 'horizontal', 3)
    expect(parts.map((p) => p.width)).toEqual([4, 3, 3])
    expect(parts[0]?.x).toBe(0)
    expect(parts[1]?.x).toBe(4)
    expect(parts[2]?.x).toBe(7)
  })

  it('returns nothing for a non-positive count', () => {
    expect(splitEvenly(rect(0, 0, 10, 1), 'horizontal', 0)).toEqual([])
  })
})

describe('geometry helpers', () => {
  it('contains is half-open on the right and bottom', () => {
    const r = rect(2, 3, 4, 5)
    expect(contains(r, 2, 3)).toBe(true)
    expect(contains(r, 5, 7)).toBe(true)
    expect(contains(r, 6, 7)).toBe(false)
    expect(contains(r, 5, 8)).toBe(false)
  })

  it('intersection of disjoint rects is empty', () => {
    expect(intersection(rect(0, 0, 2, 2), rect(5, 5, 2, 2))).toEqual(EMPTY_RECT)
    expect(intersects(rect(0, 0, 2, 2), rect(5, 5, 2, 2))).toBe(false)
  })

  it('inset collapses rather than going negative', () => {
    expect(inset(rect(0, 0, 2, 2), 2).width).toBe(0)
    expect(inset(rect(0, 0, 10, 10), 1)).toEqual({ x: 1, y: 1, width: 8, height: 8 })
  })
})
