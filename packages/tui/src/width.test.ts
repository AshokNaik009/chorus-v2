import { describe, expect, it } from 'vitest'
import { clusterWidth, codePointWidth, graphemes, isPlainAscii, stringWidth } from './width.js'

describe('codePointWidth', () => {
  it('ASCII is one column', () => {
    for (let code = 0x20; code < 0x7f; code++) expect(codePointWidth(code)).toBe(1)
  })

  it('control characters draw nothing', () => {
    expect(codePointWidth(0)).toBe(0)
    expect(codePointWidth(0x07)).toBe(0)
    expect(codePointWidth(0x1b)).toBe(0)
    expect(codePointWidth(0x7f)).toBe(0)
  })

  it('CJK and fullwidth forms are two columns', () => {
    expect(codePointWidth(0x6f22)).toBe(2) // 漢
    expect(codePointWidth(0xff21)).toBe(2) // fullwidth A
    expect(codePointWidth(0xac00)).toBe(2) // Hangul 가
  })

  it('combining marks and joiners are zero columns', () => {
    expect(codePointWidth(0x0301)).toBe(0) // combining acute
    expect(codePointWidth(0x200d)).toBe(0) // ZWJ
    expect(codePointWidth(0xfe0f)).toBe(0) // variation selector 16
  })

  it('Latin-1 and other narrow scripts stay one column', () => {
    expect(codePointWidth(0xe9)).toBe(1) // é
    expect(codePointWidth(0x03b1)).toBe(1) // α
    expect(codePointWidth(0x2500)).toBe(1) // ─ box drawing
  })
})

describe('clusterWidth', () => {
  it('is the width of the base character, not the sum', () => {
    expect(clusterWidth('é')).toBe(1)
    expect(clusterWidth('漢')).toBe(2)
    expect(clusterWidth('')).toBe(0)
  })
})

describe('stringWidth', () => {
  it('counts columns', () => {
    expect(stringWidth('hello')).toBe(5)
    expect(stringWidth('漢字')).toBe(4)
    expect(stringWidth('ábc')).toBe(3)
    expect(stringWidth('')).toBe(0)
  })
})

describe('isPlainAscii', () => {
  it('is the fast-path guard for the render loop', () => {
    expect(isPlainAscii('hello world')).toBe(true)
    expect(isPlainAscii('')).toBe(true)
    expect(isPlainAscii('漢')).toBe(false)
    expect(isPlainAscii('é')).toBe(false)
    // Control characters are excluded: they are one code unit but zero columns, so the
    // "one char is one column" assumption the fast path makes would be wrong.
    expect(isPlainAscii('a\x07b')).toBe(false)
  })
})

describe('graphemes', () => {
  it('keeps a base character and its combining marks together', () => {
    expect(graphemes('éx')).toEqual(['é', 'x'])
  })

  it('keeps an emoji ZWJ sequence together', () => {
    expect(graphemes('\u{1f468}‍\u{1f4bb}')).toHaveLength(1)
  })
})
