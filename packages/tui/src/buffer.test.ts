import { describe, expect, it } from 'vitest'
import { ScreenBuffer } from './buffer.js'
import { emptyCell, style, ATTR_BOLD } from './cell.js'
import { rect } from './rect.js'

describe('ScreenBuffer', () => {
  it('starts blank with default colors', () => {
    const buffer = new ScreenBuffer(4, 2)
    const cell = buffer.get(0, 0)
    expect(cell).toEqual({ char: ' ', width: 1, fg: -1, bg: -1, attrs: 0 })
    expect(buffer.toText({ trimRight: false })).toBe('    \n    ')
  })

  it('reads out of bounds as a blank cell instead of throwing', () => {
    const buffer = new ScreenBuffer(2, 2)
    expect(buffer.get(-1, 0).char).toBe(' ')
    expect(buffer.get(99, 99).char).toBe(' ')
    // Writing out of bounds is a no-op, not a corrupted neighbour.
    buffer.setCell(99, 0, 'x', 1, 1, 2, 3)
    expect(buffer.toText()).toBe('\n')
  })

  it('reuses a caller-supplied cell object', () => {
    const buffer = new ScreenBuffer(2, 1)
    buffer.setCell(0, 0, 'q', 1, 3, 4, ATTR_BOLD)
    const scratch = emptyCell()
    const returned = buffer.get(0, 0, scratch)
    expect(returned).toBe(scratch)
    expect(scratch).toEqual({ char: 'q', width: 1, fg: 3, bg: 4, attrs: ATTR_BOLD })
  })

  it('writeString clips at the limit and returns the next column', () => {
    const buffer = new ScreenBuffer(10, 1)
    const end = buffer.writeString(2, 0, 'hello world', style(), 7)
    expect(end).toBe(7)
    expect(buffer.rowText(0)).toBe('  hello')
  })

  it('fill paints a sub-rect only', () => {
    const buffer = new ScreenBuffer(5, 3)
    buffer.fill(rect(1, 1, 3, 1), '#')
    expect(buffer.toText({ trimRight: false })).toBe('     \n ### \n     ')
  })
})

describe('wide characters', () => {
  it('a wide char takes two columns and leaves a continuation cell', () => {
    const buffer = new ScreenBuffer(4, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    expect(buffer.get(0, 0).width).toBe(2)
    expect(buffer.get(1, 0)).toMatchObject({ char: '', width: 0 })
    expect(buffer.rowText(0)).toBe('漢')
  })

  it('overwriting the leading half blanks the trailing half', () => {
    const buffer = new ScreenBuffer(4, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    buffer.setCell(0, 0, 'a', 1, -1, -1, 0)
    expect(buffer.get(1, 0)).toMatchObject({ char: ' ', width: 1 })
    expect(buffer.rowText(0)).toBe('a')
  })

  it('overwriting the trailing half blanks the leading half', () => {
    const buffer = new ScreenBuffer(4, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    buffer.setCell(1, 0, 'b', 1, -1, -1, 0)
    expect(buffer.get(0, 0)).toMatchObject({ char: ' ', width: 1 })
    expect(buffer.rowText(0)).toBe(' b')
  })

  it('a wide char with one column left is replaced by a blank, not split', () => {
    const buffer = new ScreenBuffer(2, 1)
    buffer.setCell(1, 0, '漢', 2, -1, -1, 0)
    expect(buffer.get(1, 0)).toMatchObject({ char: ' ', width: 1 })
  })

  it('writeString measures in columns, not characters', () => {
    const buffer = new ScreenBuffer(8, 1)
    const end = buffer.writeString(0, 0, '漢字ab', style())
    expect(end).toBe(6)
    expect(buffer.rowText(0)).toBe('漢字ab')
  })

  it('a combining mark joins the cell to its left rather than taking a column', () => {
    const buffer = new ScreenBuffer(4, 1)
    // "e" + U+0301 COMBINING ACUTE, as a decomposed sequence.
    buffer.writeString(0, 0, 'éx', style())
    expect(buffer.get(0, 0).char).toBe('é')
    expect(buffer.get(1, 0).char).toBe('x')
  })
})

describe('resize', () => {
  it('keeps the overlapping region and blanks the rest', () => {
    const buffer = new ScreenBuffer(4, 2)
    buffer.writeString(0, 0, 'abcd', style())
    buffer.writeString(0, 1, 'efgh', style())
    buffer.resize(6, 3)
    expect(buffer.cols).toBe(6)
    expect(buffer.rows).toBe(3)
    expect(buffer.rowText(0)).toBe('abcd')
    expect(buffer.rowText(2)).toBe('')
  })

  it('truncates when shrinking', () => {
    const buffer = new ScreenBuffer(6, 2)
    buffer.writeString(0, 0, 'abcdef', style())
    buffer.resize(3, 1)
    expect(buffer.rows).toBe(1)
    expect(buffer.rowText(0)).toBe('abc')
  })

  it('a wide char straddling the new right edge is blanked, not orphaned', () => {
    const buffer = new ScreenBuffer(6, 1)
    buffer.setCell(2, 0, '漢', 2, -1, -1, 0)
    buffer.resize(3, 1)
    expect(buffer.get(2, 0)).toMatchObject({ char: ' ', width: 1 })
  })

  it('is a no-op at the same size', () => {
    const buffer = new ScreenBuffer(4, 2)
    buffer.writeString(0, 0, 'abcd', style())
    const chars = buffer.chars
    buffer.resize(4, 2)
    expect(buffer.chars).toBe(chars)
  })
})

describe('copyFrom', () => {
  it('reproduces every field', () => {
    const source = new ScreenBuffer(3, 2)
    source.setCell(1, 1, 'z', 1, 5, 6, ATTR_BOLD)
    source.setCell(0, 0, '漢', 2, -1, -1, 0)
    const target = new ScreenBuffer(3, 2)
    target.copyFrom(source)
    expect(target.get(1, 1)).toEqual({ char: 'z', width: 1, fg: 5, bg: 6, attrs: ATTR_BOLD })
    expect(target.get(1, 0)).toMatchObject({ width: 0 })
    expect(target.toText()).toBe(source.toText())
  })

  it('adopts the source geometry when it differs', () => {
    const source = new ScreenBuffer(5, 3)
    const target = new ScreenBuffer(2, 2)
    target.copyFrom(source)
    expect([target.cols, target.rows]).toEqual([5, 3])
  })
})
