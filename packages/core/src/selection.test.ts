import { describe, expect, it } from 'vitest'
import {
  applyMotion,
  clampPoint,
  linkAt,
  readSelection,
  searchContent,
  type TextPoint
} from './selection.js'

const LINES = [
  'the quick brown fox',
  '',
  'jumps over(the) lazy dog',
  'see https://example.com/a?b=1. done',
  'trailing'
]

describe('readSelection', () => {
  it('reads within one row, anchor inclusive and cursor exclusive', () => {
    expect(readSelection(LINES, { row: 0, col: 4 }, { row: 0, col: 9 })).toBe('quick')
  })

  it('reads the same range in either order', () => {
    expect(readSelection(LINES, { row: 0, col: 9 }, { row: 0, col: 4 })).toBe('quick')
  })

  it('joins rows with a newline and keeps the blank one', () => {
    expect(readSelection(LINES, { row: 0, col: 16 }, { row: 2, col: 5 })).toBe('fox\n\njumps')
  })

  it('clamps out-of-range points rather than throwing', () => {
    expect(readSelection(LINES, { row: -5, col: -5 }, { row: 99, col: 99 })).toContain('the quick')
  })

  it('an empty pane selects nothing', () => {
    expect(readSelection([], { row: 0, col: 0 }, { row: 3, col: 3 })).toBe('')
  })
})

describe('clampPoint', () => {
  it('allows a column one past the last character', () => {
    expect(clampPoint(LINES, { row: 0, col: 100 })).toEqual({ row: 0, col: 19 })
  })

  it('clamps a row into range', () => {
    expect(clampPoint(LINES, { row: 100, col: 0 }).row).toBe(LINES.length - 1)
  })
})

describe('motions', () => {
  const at = (row: number, col: number): TextPoint => ({ row, col })

  it('line_end goes to the last character of the row', () => {
    expect(applyMotion(LINES, at(0, 0), 'line_end')).toEqual(at(0, 18))
  })

  it('first_non_blank skips leading whitespace', () => {
    expect(applyMotion(['   indented'], at(0, 9), 'first_non_blank')).toEqual(at(0, 3))
  })

  it('first_non_blank on a blank row stays at column zero', () => {
    expect(applyMotion(['     '], at(0, 3), 'first_non_blank')).toEqual(at(0, 0))
  })

  it('next_word_start crosses the blanks', () => {
    expect(applyMotion(LINES, at(0, 0), 'next_word_start')).toEqual(at(0, 4))
    expect(applyMotion(LINES, at(0, 4), 'next_word_start')).toEqual(at(0, 10))
  })

  it('next_word_start stops at punctuation, next_big_word_start does not', () => {
    expect(applyMotion(LINES, at(2, 0), 'next_word_start')).toEqual(at(2, 6))
    // `over(the)` — a small word stops at the paren, a big word runs to `lazy`.
    expect(applyMotion(LINES, at(2, 6), 'next_word_start')).toEqual(at(2, 10))
    expect(applyMotion(LINES, at(2, 6), 'next_big_word_start')).toEqual(at(2, 16))
  })

  it('previous_word_start goes to the start of the run behind', () => {
    expect(applyMotion(LINES, at(0, 12), 'previous_word_start')).toEqual(at(0, 10))
    expect(applyMotion(LINES, at(0, 10), 'previous_word_start')).toEqual(at(0, 4))
  })

  it('next_word_end lands on the last character of the next word', () => {
    expect(applyMotion(LINES, at(0, 0), 'next_word_end')).toEqual(at(0, 2))
    expect(applyMotion(LINES, at(0, 2), 'next_word_end')).toEqual(at(0, 8))
  })

  it('motions wrap across rows', () => {
    expect(applyMotion(LINES, at(0, 18), 'next_word_start').row).toBe(2)
  })

  it('motions at the end of the content stay put rather than failing', () => {
    const last = at(LINES.length - 1, (LINES[LINES.length - 1] as string).length - 1)
    expect(applyMotion(LINES, last, 'next_word_start')).toEqual(last)
    expect(applyMotion(LINES, at(0, 0), 'previous_word_start')).toEqual(at(0, 0))
  })

  it('paragraph motions move between blank-line-separated blocks', () => {
    const text = ['one', 'two', '', '', 'three', 'four', '', 'five']
    expect(applyMotion(text, at(0, 0), 'next_paragraph')).toEqual(at(4, 0))
    expect(applyMotion(text, at(4, 0), 'next_paragraph')).toEqual(at(7, 0))
    expect(applyMotion(text, at(5, 0), 'previous_paragraph')).toEqual(at(1, 0))
  })

  it('an empty pane yields the origin', () => {
    expect(applyMotion([], at(3, 3), 'line_end')).toEqual(at(0, 0))
  })
})

describe('search', () => {
  it('finds the next match forward from the cursor', () => {
    expect(searchContent(LINES, 'the', { direction: 'forward', cursor: { row: 0, col: 0 } })).toEqual({
      start: { row: 0, col: 0 },
      end: { row: 0, col: 3 }
    })
  })

  it('a previous match makes the next search advance', () => {
    const first = searchContent(LINES, 'the', { direction: 'forward', cursor: { row: 0, col: 0 } })
    const second = searchContent(LINES, 'the', {
      direction: 'forward',
      cursor: { row: 0, col: 0 },
      ...(first === null ? {} : { previous: first })
    })
    expect(second).toEqual({ start: { row: 2, col: 11 }, end: { row: 2, col: 14 } })
  })

  it('wraps around the end of the content', () => {
    const match = searchContent(LINES, 'quick', { direction: 'forward', cursor: { row: 4, col: 0 } })
    expect(match).toEqual({ start: { row: 0, col: 4 }, end: { row: 0, col: 9 } })
  })

  it('searches backward', () => {
    expect(searchContent(LINES, 'the', { direction: 'backward', cursor: { row: 2, col: 20 } })).toEqual({
      start: { row: 2, col: 11 },
      end: { row: 2, col: 14 }
    })
  })

  it('is case-insensitive for a lowercase query and exact for a mixed one', () => {
    const text = ['Error: nope', 'error: also']
    expect(searchContent(text, 'error', { direction: 'forward', cursor: { row: 0, col: 0 } })?.start.row).toBe(0)
    expect(searchContent(text, 'Error', { direction: 'forward', cursor: { row: 1, col: 0 } })?.start.row).toBe(0)
  })

  it('an empty query and an empty pane find nothing', () => {
    expect(searchContent(LINES, '', { direction: 'forward', cursor: { row: 0, col: 0 } })).toBeNull()
    expect(searchContent([], 'x', { direction: 'forward', cursor: { row: 0, col: 0 } })).toBeNull()
  })

  it('returns null when the query is not there at all', () => {
    expect(searchContent(LINES, 'zebra', { direction: 'forward', cursor: { row: 0, col: 0 } })).toBeNull()
  })
})

describe('links', () => {
  it('finds a URL under the cell and trims sentence punctuation', () => {
    const hit = linkAt(LINES, { row: 3, col: 10 })
    expect(hit?.url).toBe('https://example.com/a?b=1')
  })

  it('returns null away from the URL', () => {
    expect(linkAt(LINES, { row: 3, col: 1 })).toBeNull()
    expect(linkAt(LINES, { row: 0, col: 3 })).toBeNull()
  })

  it('finds the second URL on a row', () => {
    const line = ['http://a.example http://b.example']
    expect(linkAt(line, { row: 0, col: 20 })?.url).toBe('http://b.example')
  })

  it('ignores a bare scheme with nothing after it', () => {
    expect(linkAt(['see http:// only'], { row: 0, col: 5 })).toBeNull()
  })
})
