/**
 * The shared viewport.
 *
 * Unit tests rather than through a panel, because the arithmetic is the part that was
 * missing from the Source Control panel entirely and the part that is easy to get off
 * by one in either direction.
 */

import { ScreenBuffer } from '@leap-chorus/tui'
import { DEFAULT_CONFIG } from '@leap-chorus/core'
import { describe, expect, it } from 'vitest'
import { ScrollView, needsScrollbar, renderScrollbar } from './scrollview.js'
import { paletteOf } from './chrome.js'

const palette = paletteOf(DEFAULT_CONFIG)

describe('ScrollView.follow', () => {
  it('does not move while the cursor is already on screen', () => {
    const view = new ScrollView()
    expect(view.follow(0, 100, 10)).toBe(0)
    expect(view.follow(9, 100, 10)).toBe(0)
  })

  it('scrolls by one when the cursor steps off the bottom', () => {
    const view = new ScrollView()
    view.follow(9, 100, 10)
    expect(view.follow(10, 100, 10)).toBe(1)
    expect(view.follow(11, 100, 10)).toBe(2)
  })

  it('scrolls back up when the cursor steps off the top', () => {
    const view = new ScrollView()
    view.follow(50, 100, 10)
    expect(view.follow(41, 100, 10)).toBe(41)
  })

  it('jumps straight to a cursor that moved a long way', () => {
    const view = new ScrollView()
    expect(view.follow(99, 100, 10)).toBe(90)
  })

  it('never leaves blank rows below the last item', () => {
    const view = new ScrollView()
    view.follow(99, 100, 10)
    // The list shrank under a stationary offset — a stage that emptied a section.
    expect(view.follow(4, 5, 10)).toBe(0)
  })

  it('is zero for an empty list or a viewport with no height', () => {
    const view = new ScrollView()
    view.follow(50, 100, 10)
    expect(view.follow(0, 0, 10)).toBe(0)
    expect(view.follow(50, 100, 0)).toBe(0)
  })
})

describe('ScrollView.by', () => {
  it('scrolls without moving a cursor, and stops at both ends', () => {
    const view = new ScrollView()
    view.by(3, 100, 10)
    expect(view.offset).toBe(3)
    view.by(-10, 100, 10)
    expect(view.offset).toBe(0)
    view.by(1000, 100, 10)
    expect(view.offset).toBe(90)
  })

  it('does not scroll a list that fits', () => {
    const view = new ScrollView()
    view.by(5, 4, 10)
    expect(view.offset).toBe(0)
  })
})

describe('ScrollView.indexAt', () => {
  it('reads a row through the current offset', () => {
    const view = new ScrollView()
    view.follow(99, 100, 10)
    expect(view.indexAt(2, 2, 100, 10)).toBe(90)
    expect(view.indexAt(11, 2, 100, 10)).toBe(99)
  })

  it('rejects a row above the list, below the viewport, or past the end', () => {
    const view = new ScrollView()
    expect(view.indexAt(1, 2, 100, 10)).toBeNull()
    expect(view.indexAt(12, 2, 100, 10)).toBeNull()
    expect(view.indexAt(5, 2, 2, 10)).toBeNull()
  })
})

describe('the scrollbar', () => {
  function bar(offset: number, count: number, height: number): string {
    const buffer = new ScreenBuffer(1, height)
    renderScrollbar(buffer, { x: 0, y: 0, width: 1, height }, offset, count, palette)
    return buffer.toText().split('\n').map((line) => line.trim()).join('')
  }

  it('is not drawn at all when everything fits', () => {
    expect(needsScrollbar(5, 10)).toBe(false)
    expect(bar(0, 5, 10).replace(/\s/gu, '')).toBe('')
  })

  it('puts the thumb at the top, the bottom, and proportionally between', () => {
    expect(needsScrollbar(20, 10)).toBe(true)
    expect(bar(0, 20, 10)).toBe('█████│││││')
    expect(bar(10, 20, 10)).toBe('│││││█████')
    // A five-cell thumb, halfway down its five cells of travel.
    expect(bar(5, 20, 10)).toBe(`${'│'.repeat(3)}${'█'.repeat(5)}${'│'.repeat(2)}`)
  })

  it('keeps a visible thumb even for a very long list', () => {
    expect(bar(0, 10_000, 10)).toContain('█')
  })
})
