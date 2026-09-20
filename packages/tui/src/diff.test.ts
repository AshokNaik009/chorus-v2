import { describe, expect, it } from 'vitest'
import { ScreenBuffer } from './buffer.js'
import { style, ATTR_BOLD } from './cell.js'
import { JOIN_GAP, diffBuffers, fullSpans, spanCells } from './diff.js'
import { encodeFrame } from './ansi.js'

function pair(cols: number, rows: number): [ScreenBuffer, ScreenBuffer] {
  return [new ScreenBuffer(cols, rows), new ScreenBuffer(cols, rows)]
}

describe('diffBuffers', () => {
  it('finds nothing when the frames are identical', () => {
    const [prev, next] = pair(20, 5)
    expect(diffBuffers(prev, next)).toEqual([])
  })

  it('reports a full repaint when there is no previous frame', () => {
    const next = new ScreenBuffer(20, 5)
    expect(diffBuffers(null, next)).toEqual(fullSpans(next))
  })

  it('reports a full repaint when the geometry changed', () => {
    const prev = new ScreenBuffer(10, 5)
    const next = new ScreenBuffer(20, 5)
    expect(diffBuffers(prev, next)).toEqual(fullSpans(next))
  })

  it('covers exactly the changed cell', () => {
    const [prev, next] = pair(20, 3)
    next.setCell(7, 1, 'x', 1, -1, -1, 0)
    expect(diffBuffers(prev, next)).toEqual([{ y: 1, x: 7, end: 8 }])
  })

  it('notices a style-only change', () => {
    const [prev, next] = pair(10, 1)
    next.setStyle(3, 0, style({ attrs: ATTR_BOLD }))
    expect(diffBuffers(prev, next)).toEqual([{ y: 0, x: 3, end: 4 }])
  })

  it(`joins runs separated by at most ${JOIN_GAP} unchanged cells`, () => {
    const [prev, next] = pair(40, 1)
    next.setCell(0, 0, 'a', 1, -1, -1, 0)
    next.setCell(JOIN_GAP + 1, 0, 'b', 1, -1, -1, 0)
    expect(diffBuffers(prev, next)).toEqual([{ y: 0, x: 0, end: JOIN_GAP + 2 }])
  })

  it('splits runs separated by more than that', () => {
    const [prev, next] = pair(40, 1)
    next.setCell(0, 0, 'a', 1, -1, -1, 0)
    next.setCell(JOIN_GAP + 2, 0, 'b', 1, -1, -1, 0)
    expect(diffBuffers(prev, next)).toEqual([
      { y: 0, x: 0, end: 1 },
      { y: 0, x: JOIN_GAP + 2, end: JOIN_GAP + 3 }
    ])
  })

  it('never starts a span on the trailing half of a wide character', () => {
    const [prev, next] = pair(10, 1)
    prev.setCell(4, 0, '漢', 2, -1, -1, 0)
    next.setCell(4, 0, '漢', 2, -1, -1, 5)
    const spans = diffBuffers(prev, next)
    expect(spans).toHaveLength(1)
    expect(spans[0]?.x).toBe(4)
    // And it carries the trailing column with it.
    expect(spans[0]?.end).toBe(6)
  })

  it('extends left when only the trailing half differs', () => {
    const [prev, next] = pair(10, 1)
    next.setCell(4, 0, '漢', 2, -1, -1, 0)
    // Force a difference that shows up only on the continuation cell.
    prev.setCell(4, 0, '漢', 2, -1, -1, 0)
    prev.attrs[5] = ATTR_BOLD
    const spans = diffBuffers(prev, next)
    expect(spans[0]?.x).toBe(4)
  })
})

describe('the diff beats a full repaint', () => {
  // PHASE-2 acceptance criterion 5.
  it('writes strictly fewer bytes for a one-line change on a busy screen', () => {
    const [prev, next] = pair(200, 50)
    for (let y = 0; y < 50; y++) {
      prev.writeString(0, y, `line ${y} `.repeat(20), style({ fg: y % 8 }))
    }
    next.copyFrom(prev)
    next.writeString(0, 20, 'the only thing that changed', style({ fg: 3 }))

    const diffSpans = diffBuffers(prev, next)
    const diffBytes = Buffer.byteLength(encodeFrame(next, diffSpans), 'utf8')
    const fullBytes = Buffer.byteLength(encodeFrame(next, fullSpans(next)), 'utf8')

    expect(spanCells(diffSpans)).toBeLessThan(spanCells(fullSpans(next)))
    expect(diffBytes).toBeLessThan(fullBytes)
    // Not merely fewer: an order of magnitude, which is the point of having a diff.
    expect(diffBytes * 10).toBeLessThan(fullBytes)
  })

  it('writes nothing at all when nothing changed', () => {
    const [prev, next] = pair(200, 50)
    for (let y = 0; y < 50; y++) prev.writeString(0, y, 'x'.repeat(200), style())
    next.copyFrom(prev)
    const payload = encodeFrame(next, diffBuffers(prev, next), { manageCursorVisibility: false })
    expect(payload).toBe('')
  })

  it('is never worse than a full repaint, even when everything changed', () => {
    const [prev, next] = pair(200, 50)
    for (let y = 0; y < 50; y++) {
      prev.writeString(0, y, 'a'.repeat(200), style())
      next.writeString(0, y, 'b'.repeat(200), style())
    }
    const diffBytes = Buffer.byteLength(encodeFrame(next, diffBuffers(prev, next)), 'utf8')
    const fullBytes = Buffer.byteLength(encodeFrame(next, fullSpans(next)), 'utf8')
    expect(diffBytes).toBeLessThanOrEqual(fullBytes)
  })
})
