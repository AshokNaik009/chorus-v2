import { describe, expect, it } from 'vitest'
import { compileRustRegex, RegexTranslationError, translateRustRegex } from './regex.js'

describe('inline flags', () => {
  it('lifts a leading flag group to RegExp flags', () => {
    expect(translateRustRegex('(?i)^yes\\b')).toEqual({ source: '^yes\\b', flags: 'i' })
    expect(translateRustRegex('(?m)^a$')).toEqual({ source: '^a$', flags: 'm' })
    expect(translateRustRegex('(?s)a.b')).toEqual({ source: 'a.b', flags: 's' })
  })

  it('merges repeated and combined groups, in a stable order', () => {
    expect(translateRustRegex('(?i)(?m)x').flags).toBe('im')
    expect(translateRustRegex('(?mi)x').flags).toBe('im')
  })

  it('refuses a flag group that is not at the front', () => {
    // Rust scopes it; we would not. Erroring is the only reading that cannot be wrong.
    expect(() => translateRustRegex('a(?i)b')).toThrow(RegexTranslationError)
    expect(() => translateRustRegex('(a)(?i)b')).toThrow(/only supported at the start/u)
  })

  it('does not mistake an escaped paren for a flag group', () => {
    expect(() => translateRustRegex('\\(?i\\)')).not.toThrow()
  })

  it('refuses a flag with no JavaScript equivalent', () => {
    expect(() => translateRustRegex('(?x) a b')).toThrow(/no JavaScript equivalent/u)
  })
})

describe('code point escapes', () => {
  it('rewrites \\x{...} to a form that needs no u flag', () => {
    expect(translateRustRegex('^[\\x{2800}-\\x{28FF}] ')).toEqual({
      source: '^[\\u2800-\\u28ff] ',
      flags: ''
    })
  })

  it('matches the character the manifest meant', () => {
    expect(compileRustRegex('^\\x{2733} ').test('\u2733 done')).toBe(true)
    expect(compileRustRegex('^\\x{2733} ').test('x done')).toBe(false)
  })

  it('leaves a literal backslash-x alone', () => {
    // `\\x{41}` is a backslash then `x{41}`, not a code point. A regex-based pass
    // over the pattern string cannot see that; the walker can.
    expect(translateRustRegex('\\\\x{41}').source).toBe('\\\\x{41}')
  })

  it('switches to \\u{...} when \\p forces the u flag', () => {
    const translated = translateRustRegex('\\p{L}\\x{2733}')
    expect(translated.flags).toBe('u')
    expect(translated.source).toBe('\\p{L}\\u{2733}')
  })

  it('refuses an astral escape that cannot use the u flag', () => {
    expect(() => translateRustRegex('\\x{1F600}')).toThrow(/above the BMP/u)
  })
})

describe('anchors', () => {
  it('translates \\A and \\z to lookarounds, not to ^ and $', () => {
    // `^`/`$` would change meaning under a lifted `(?m)`; `\A`/`\z` never do.
    const pattern = compileRustRegex('(?m)\\Aone\\z')
    expect(pattern.test('one')).toBe(true)
    expect(pattern.test('one\ntwo')).toBe(false)
    expect(pattern.test('zero\none')).toBe(false)
  })

  it('anchors $ at the very end without the m flag, as Rust does', () => {
    expect(compileRustRegex('a$').test('a\nb')).toBe(false)
    expect(compileRustRegex('(?m)a$').test('a\nb')).toBe(true)
  })
})

describe('real manifest patterns', () => {
  it('compiles the claude working spinner', () => {
    const pattern = compileRustRegex('^[\\x{2800}-\\x{28FF}\\x{25D0}-\\x{25D3}] ')
    expect(pattern.test('\u2801 Thinking')).toBe(true)
    expect(pattern.test('\u25d0 Thinking')).toBe(true)
    expect(pattern.test('* Thinking')).toBe(false)
  })

  it('compiles the codex braille title spinner', () => {
    const pattern = compileRustRegex('(?:^| )[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?: |$)')
    expect(pattern.test('⠙ working')).toBe(true)
    expect(pattern.test('codex')).toBe(false)
  })

  it('compiles the claude permission prompt option matcher', () => {
    const pattern = compileRustRegex('(?i)^\\s*❯?\\s*1\\.\\s*yes\\b')
    expect(pattern.test(' ❯ 1. Yes')).toBe(true)
    expect(pattern.test('  1. yes, and do not ask again')).toBe(true)
    expect(pattern.test('  2. No')).toBe(false)
  })
})
