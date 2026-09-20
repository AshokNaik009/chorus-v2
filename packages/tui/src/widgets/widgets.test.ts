import { describe, expect, it } from 'vitest'
import { ScreenBuffer } from '../buffer.js'
import { ATTR_BOLD, style } from '../cell.js'
import { rect } from '../rect.js'
import { BORDER_ALL, BORDER_LEFT, BORDER_NONE, BORDER_TOP, renderBlock, truncate } from './block.js'
import { renderClear } from './clear.js'
import { lineWidth, renderParagraph, span, wrapLine } from './text.js'

describe('renderBlock', () => {
  it('draws a full border and returns the inside', () => {
    const buffer = new ScreenBuffer(6, 4)
    const inner = renderBlock(buffer, rect(0, 0, 6, 4))
    expect(inner).toEqual({ x: 1, y: 1, width: 4, height: 2 })
    expect(buffer.toText({ trimRight: false })).toBe(['┌────┐', '│    │', '│    │', '└────┘'].join('\n'))
  })

  it('shrinks the inner rect only for the borders it drew', () => {
    const buffer = new ScreenBuffer(6, 4)
    expect(renderBlock(buffer, rect(0, 0, 6, 4), { borders: BORDER_NONE })).toEqual({
      x: 0,
      y: 0,
      width: 6,
      height: 4
    })
    expect(renderBlock(buffer, rect(0, 0, 6, 4), { borders: BORDER_TOP | BORDER_LEFT })).toEqual({
      x: 1,
      y: 1,
      width: 5,
      height: 3
    })
  })

  it('puts the title on the top border', () => {
    const buffer = new ScreenBuffer(12, 3)
    renderBlock(buffer, rect(0, 0, 12, 3), { title: 'shell' })
    expect(buffer.rowText(0)).toBe('┌─shell────┐')
  })

  it('truncates a title that does not fit', () => {
    const buffer = new ScreenBuffer(10, 3)
    renderBlock(buffer, rect(0, 0, 10, 3), { title: 'a-very-long-title' })
    expect(buffer.rowText(0)).toBe('┌─a-ver…─┐')
  })

  it('places a right-hand title and keeps it when the left one is long', () => {
    const buffer = new ScreenBuffer(20, 3)
    renderBlock(buffer, rect(0, 0, 20, 3), { title: 'session-with-a-name', rightTitle: 'ZOOM' })
    const top = buffer.rowText(0)
    expect(top.endsWith('ZOOM─┐')).toBe(true)
    expect(top).toContain('…')
  })

  it('styles the border and the title separately', () => {
    const buffer = new ScreenBuffer(8, 3)
    renderBlock(buffer, rect(0, 0, 8, 3), {
      title: 'x',
      borderStyle: style({ fg: 4 }),
      titleStyle: style({ fg: 2, attrs: ATTR_BOLD })
    })
    expect(buffer.get(0, 0).fg).toBe(4)
    expect(buffer.get(2, 0)).toMatchObject({ char: 'x', fg: 2, attrs: ATTR_BOLD })
  })

  it('clips to the buffer instead of writing outside it', () => {
    const buffer = new ScreenBuffer(4, 2)
    const inner = renderBlock(buffer, rect(2, 0, 10, 10), { borders: BORDER_ALL })
    expect(inner.x + inner.width).toBeLessThanOrEqual(4)
    expect(inner.y + inner.height).toBeLessThanOrEqual(2)
  })

  it('degenerate areas produce an empty inner rect, not a negative one', () => {
    const buffer = new ScreenBuffer(10, 10)
    const inner = renderBlock(buffer, rect(0, 0, 1, 1))
    expect(inner.width).toBe(0)
    expect(inner.height).toBe(0)
  })
})

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    expect(truncate('abc', 3)).toBe('abc')
  })

  it('marks the cut', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abcdef', 1)).toBe('…')
    expect(truncate('abcdef', 0)).toBe('')
  })

  it('counts columns, not characters', () => {
    expect(truncate('漢字漢字', 5)).toBe('漢字…')
  })
})

describe('renderClear', () => {
  it('blanks only the given rect', () => {
    const buffer = new ScreenBuffer(5, 2)
    buffer.writeString(0, 0, 'abcde', style())
    buffer.writeString(0, 1, 'fghij', style())
    renderClear(buffer, rect(1, 0, 3, 1))
    expect(buffer.rowText(0)).toBe('a   e')
    expect(buffer.rowText(1)).toBe('fghij')
  })
})

describe('wrapLine', () => {
  it('leaves a short line alone', () => {
    const l = { spans: [span('hello')] }
    expect(wrapLine(l, 20)).toEqual([l])
  })

  it('breaks on spaces', () => {
    const wrapped = wrapLine({ spans: [span('the quick brown fox')] }, 10)
    expect(wrapped.map((w) => w.spans.map((s) => s.text).join(''))).toEqual(['the quick', 'brown fox'])
  })

  it('hard-breaks a word longer than the line', () => {
    const wrapped = wrapLine({ spans: [span('abcdefghij')] }, 4)
    expect(wrapped.map((w) => w.spans.map((s) => s.text).join(''))).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('keeps each span style across the break', () => {
    const highlighted = style({ fg: 2 })
    const wrapped = wrapLine({ spans: [span('aaa bbb ccc', highlighted)] }, 7)
    expect(wrapped).toHaveLength(2)
    for (const l of wrapped) for (const s of l.spans) expect(s.style).toBe(highlighted)
  })

  it('measures in columns', () => {
    const wrapped = wrapLine({ spans: [span('漢字 漢字')] }, 5)
    expect(wrapped.map((w) => w.spans.map((s) => s.text).join(''))).toEqual(['漢字', '漢字'])
  })

  it('returns nothing for a zero-width area', () => {
    expect(wrapLine({ spans: [span('x')] }, 0)).toEqual([])
  })
})

describe('renderParagraph', () => {
  it('writes lines and reports how many rows it used', () => {
    const buffer = new ScreenBuffer(10, 3)
    const used = renderParagraph(buffer, rect(0, 0, 10, 3), [{ spans: [span('one')] }, { spans: [span('two')] }])
    expect(used).toBe(2)
    expect(buffer.rowText(0)).toBe('one')
    expect(buffer.rowText(1)).toBe('two')
  })

  it('aligns', () => {
    const buffer = new ScreenBuffer(9, 1)
    renderParagraph(buffer, rect(0, 0, 9, 1), [{ spans: [span('abc')] }], { align: 'center' })
    expect(buffer.rowText(0, { trimRight: false })).toBe('   abc   ')

    const right = new ScreenBuffer(9, 1)
    renderParagraph(right, rect(0, 0, 9, 1), [{ spans: [span('abc')] }], { align: 'right' })
    expect(right.rowText(0, { trimRight: false })).toBe('      abc')
  })

  it('wraps when asked and stops at the bottom of the area', () => {
    const buffer = new ScreenBuffer(6, 2)
    const used = renderParagraph(buffer, rect(0, 0, 6, 2), [{ spans: [span('aaa bbb ccc ddd')] }], { wrap: true })
    expect(used).toBe(2)
    expect(buffer.rowText(0)).toBe('aaa')
    expect(buffer.rowText(1)).toBe('bbb')
  })

  it('scrolls past the first lines', () => {
    const buffer = new ScreenBuffer(6, 1)
    renderParagraph(buffer, rect(0, 0, 6, 1), [{ spans: [span('one')] }, { spans: [span('two')] }], { scroll: 1 })
    expect(buffer.rowText(0)).toBe('two')
  })

  it('lineWidth counts every span in columns', () => {
    expect(lineWidth({ spans: [span('ab'), span('漢')] })).toBe(4)
  })
})
