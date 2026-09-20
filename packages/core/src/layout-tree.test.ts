import { describe, expect, it } from 'vitest'
import type { Rect } from './geometry.js'
import {
  canSplit,
  cyclePane,
  neighbor,
  paneCount,
  paneIds,
  paneNode,
  placements,
  removePane,
  resizeAlong,
  setSplitRatio,
  splitBorders,
  splitPane,
  swapPanes,
  type LayoutNode
} from './layout-tree.js'

const AREA: Rect = { x: 0, y: 0, width: 200, height: 50 }

/** Build a tree by splitting, the way the app does. */
function layoutOf(...splits: Array<['horizontal' | 'vertical', string, string]>): LayoutNode {
  let node = paneNode('a')
  for (const [direction, target, id] of splits) node = splitPane(node, target, direction, id)
  return node
}

describe('the layout tree', () => {
  it('starts as one pane covering everything', () => {
    const node = paneNode('a')
    expect(paneCount(node)).toBe(1)
    expect(placements(node, AREA)).toEqual([{ id: 'a', rect: AREA }])
  })

  it('splitting puts the new pane in the second half', () => {
    const panes = placements(layoutOf(['horizontal', 'a', 'b']), AREA)
    expect(panes.map((p) => p.id)).toEqual(['a', 'b'])
    expect(panes[0]?.rect).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(panes[1]?.rect).toEqual({ x: 100, y: 0, width: 100, height: 50 })
  })

  it('tiles the area with no overlap and no gap', () => {
    const node = layoutOf(
      ['horizontal', 'a', 'b'],
      ['vertical', 'b', 'c'],
      ['vertical', 'a', 'd'],
      ['horizontal', 'c', 'e']
    )
    const panes = placements(node, AREA)
    expect(panes).toHaveLength(5)

    const seen = new Set<string>()
    let covered = 0
    for (const pane of panes) {
      covered += pane.rect.width * pane.rect.height
      for (let y = pane.rect.y; y < pane.rect.y + pane.rect.height; y++) {
        for (let x = pane.rect.x; x < pane.rect.x + pane.rect.width; x++) {
          const key = `${x},${y}`
          expect(seen.has(key), `cell ${key} covered twice`).toBe(false)
          seen.add(key)
        }
      }
    }
    expect(covered).toBe(AREA.width * AREA.height)
    expect(seen.size).toBe(AREA.width * AREA.height)
  })

  it('splitting a pane that is not in the tree returns the tree unchanged', () => {
    const node = paneNode('a')
    expect(splitPane(node, 'nope', 'horizontal', 'b')).toBe(node)
  })

  it('closing collapses the parent split into the sibling', () => {
    const node = removePane(layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c']), 'c')
    expect(node).not.toBeNull()
    const panes = placements(node as LayoutNode, AREA)
    expect(panes.map((p) => p.id)).toEqual(['a', 'b'])
    expect(panes[1]?.rect).toEqual({ x: 100, y: 0, width: 100, height: 50 })
  })

  it('removing the only pane leaves nothing', () => {
    expect(removePane(paneNode('a'), 'a')).toBeNull()
  })

  it('swapping exchanges two panes without touching the ratios', () => {
    const before = layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c'])
    const after = swapPanes(before, 'a', 'c')
    expect(paneIds(after)).toEqual(['c', 'b', 'a'])
    expect(placements(after, AREA).map((p) => p.rect)).toEqual(placements(before, AREA).map((p) => p.rect))
  })

  it('swapping a pane that is not there is a no-op', () => {
    const node = layoutOf(['horizontal', 'a', 'b'])
    expect(swapPanes(node, 'a', 'zzz')).toBe(node)
  })
})

describe('neighbor', () => {
  //  +--------+--------+
  //  |   a    |   b    |
  //  |        +--------+
  //  |        |   c    |
  //  +--------+--------+
  const node = (): LayoutNode => layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c'])

  it('moves right into the neighbour that overlaps', () => {
    expect(neighbor(node(), 'a', 'right', AREA)).toBe('b')
  })

  it('moves down within a column', () => {
    expect(neighbor(node(), 'b', 'down', AREA)).toBe('c')
  })

  it('returns null at an edge', () => {
    expect(neighbor(node(), 'a', 'left', AREA)).toBeNull()
    expect(neighbor(node(), 'a', 'up', AREA)).toBeNull()
  })

  it('left from either right-hand pane lands on the tall one', () => {
    expect(neighbor(node(), 'c', 'left', AREA)).toBe('a')
  })

  it('cyclePane walks tree order and wraps in both directions', () => {
    expect(cyclePane(node(), 'a', 1)).toBe('b')
    expect(cyclePane(node(), 'c', 1)).toBe('a')
    expect(cyclePane(node(), 'a', -1)).toBe('c')
  })
})

describe('resizeAlong', () => {
  it('moves the nearest divider, and the sign follows the pane', () => {
    const grown = resizeAlong(layoutOf(['horizontal', 'a', 'b']), 'a', 'horizontal', 0.1)
    expect(placements(grown, AREA)[0]?.rect.width).toBe(120)

    // Growing b means shrinking a: the divider moved the other way.
    const other = resizeAlong(layoutOf(['horizontal', 'a', 'b']), 'b', 'horizontal', 0.1)
    expect(placements(other, AREA)[0]?.rect.width).toBe(80)
  })

  it('ignores a direction with no matching split', () => {
    const node = layoutOf(['horizontal', 'a', 'b'])
    expect(resizeAlong(node, 'a', 'vertical', 0.1)).toBe(node)
  })

  it('clamps rather than collapsing a pane to nothing', () => {
    let node = layoutOf(['horizontal', 'a', 'b'])
    for (let i = 0; i < 100; i++) node = resizeAlong(node, 'a', 'horizontal', -0.1)
    const width = placements(node, AREA)[0]?.rect.width ?? 0
    expect(width).toBeGreaterThan(0)
    expect(width).toBeLessThan(AREA.width)
  })

  it('moves the inner divider, not the outer one', () => {
    //  a | b
    //    | c        growing b downward must move the b/c divider.
    const node = resizeAlong(layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c']), 'b', 'vertical', 0.1)
    const panes = placements(node, AREA)
    expect(panes[0]?.rect.width).toBe(100)
    expect(panes[1]?.rect.height).toBe(30)
  })
})

describe('split paths', () => {
  it('reports each divider position and its path', () => {
    const borders = splitBorders(layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c']), AREA)
    expect(borders).toHaveLength(2)
    expect(borders[0]).toMatchObject({ pos: 100, direction: 'horizontal', path: [] })
    expect(borders[1]).toMatchObject({ pos: 25, direction: 'vertical', path: [true] })
  })

  it('setSplitRatio addresses a divider by path', () => {
    const node = layoutOf(['horizontal', 'a', 'b'], ['vertical', 'b', 'c'])
    const changed = setSplitRatio(node, [true], 0.25)
    expect(placements(changed, AREA)[1]?.rect.height).toBe(13)
    // The outer divider did not move.
    expect(placements(changed, AREA)[0]?.rect.width).toBe(100)
  })

  it('setSplitRatio clamps and rejects a path that names no split', () => {
    const node = layoutOf(['horizontal', 'a', 'b'])
    expect(setSplitRatio(node, [], 9)).not.toBe(node)
    expect(setSplitRatio(node, [false], 0.3)).toBe(node)
    expect(setSplitRatio(node, [true, true, false], 0.3)).toBe(node)
  })
})

describe('canSplit', () => {
  it('refuses a split that would leave an unusable half', () => {
    expect(canSplit({ x: 0, y: 0, width: 6, height: 10 }, 'horizontal')).toBe(false)
    expect(canSplit({ x: 0, y: 0, width: 8, height: 10 }, 'horizontal')).toBe(true)
    expect(canSplit({ x: 0, y: 0, width: 40, height: 3 }, 'vertical')).toBe(false)
    expect(canSplit({ x: 0, y: 0, width: 40, height: 4 }, 'vertical')).toBe(true)
  })
})
