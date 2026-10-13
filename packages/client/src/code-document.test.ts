import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@leap-chorus/core'
import { ScreenBuffer, stringWidth } from '@leap-chorus/tui'
import { CodeDocument, drawCodeRow } from './code-document.js'
import { paletteOf } from './chrome.js'

const text = (row: { spans: readonly { text: string }[] }) => row.spans.map((span) => span.text).join('')

describe('native code rendering', () => {
  it('reuses wrapping results while checking whether a scrollbar is needed', () => {
    const doc = new CodeDocument('x.ts', ['const value = "long line"'])
    const withScrollbar = doc.rows(19, true)
    doc.rows(20, true)
    expect(doc.rows(19, true)).toBe(withScrollbar)
  })

  it('highlights TypeScript without changing its content', () => {
    const lines = ['const message: string = "hello"', '', '// a comment']
    const doc = new CodeDocument('app.ts', lines)
    expect(doc.highlighted).toBe(true)
    expect(doc.rows(80, false).map(text)).toEqual(lines)
    expect(doc.lines.flat().some((span) => span.token === 'hljs-keyword')).toBe(true)
    expect(doc.lines.flat().some((span) => span.token === 'hljs-string')).toBe(true)
  })

  it('preserves indentation, blank lines, and source numbers while wrapping', () => {
    const doc = new CodeDocument('unknown', ['\t  abcdefgh', '', 'next'])
    const rows = doc.rows(8, true)
    expect(rows.map(text)).toEqual(['      ab', 'cdefgh', '', 'next'])
    expect(rows.map((row) => [row.line, row.continuation])).toEqual([[1, false], [1, true], [2, false], [3, false]])
    expect(doc.rows(8, true)).toBe(rows)
  })

  it('wraps by terminal columns without splitting astral characters', () => {
    const doc = new CodeDocument('unknown', ['中文𐐀文字'])
    const rows = doc.rows(4, true)
    expect(rows.every((row) => stringWidth(text(row)) <= 4)).toBe(true)
    expect(rows.map(text).join('')).toBe('中文𐐀文字')
  })

  it('falls back to plain text for unknown types and large inputs', () => {
    expect(new CodeDocument('x.unknown', ['content']).highlighted).toBe(false)
    const source = 'x'.repeat(70_000)
    const doc = new CodeDocument('x.ts', [source])
    expect(doc.highlighted).toBe(false)
    expect(doc.rows(80, false).map(text)).toEqual([source])
  })

  it('draws syntax styles within its bounds', () => {
    const doc = new CodeDocument('x.ts', ['const x = "hello"'])
    const buffer = new ScreenBuffer(30, 1)
    const row = doc.rows(80, false)[0]!
    const palette = paletteOf(DEFAULT_CONFIG)
    drawCodeRow(buffer, 2, 0, 15, row, 0, palette)
    expect(buffer.get(2, 0).attrs).not.toBe(palette.sidebar.attrs)
    expect(buffer.get(0, 0).char).toBe(' ')
    expect(buffer.get(20, 0).char).toBe(' ')
  })
})
