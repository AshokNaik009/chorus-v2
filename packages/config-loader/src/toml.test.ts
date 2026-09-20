import { describe, expect, it } from 'vitest'
import { TomlError, parseToml } from './toml.js'

describe('scalars', () => {
  it('reads strings, numbers and booleans', () => {
    expect(
      parseToml(`
        name = "leap-chorus"
        literal = 'no \\escapes'
        count = 42
        negative = -7
        ratio = 0.25
        exponent = 1e3
        yes = true
        no = false
      `)
    ).toEqual({
      name: 'leap-chorus',
      literal: 'no \\escapes',
      count: 42,
      negative: -7,
      ratio: 0.25,
      exponent: 1000,
      yes: true,
      no: false
    })
  })

  it('reads every integer base, with underscores', () => {
    expect(parseToml('a = 1_000\nb = 0xff\nc = 0o17\nd = 0b1010')).toEqual({ a: 1000, b: 255, c: 15, d: 10 })
  })

  it('reads inf and nan', () => {
    const result = parseToml('a = inf\nb = -inf\nc = nan')
    expect(result['a']).toBe(Infinity)
    expect(result['b']).toBe(-Infinity)
    expect(Number.isNaN(result['c'])).toBe(true)
  })

  it('reads string escapes', () => {
    expect(parseToml('a = "tab\\there"')).toEqual({ a: 'tab\there' })
    expect(parseToml('a = "\\u0041\\U0001F600"')).toEqual({ a: 'A\u{1F600}' })
  })

  it('rejects an unknown escape', () => {
    expect(() => parseToml('a = "\\q"')).toThrow(TomlError)
  })
})

describe('tables', () => {
  it('reads a table header', () => {
    expect(parseToml('[ui]\nsidebar = true')).toEqual({ ui: { sidebar: true } })
  })

  it('reads a nested table header', () => {
    expect(parseToml('[a.b.c]\nx = 1')).toEqual({ a: { b: { c: { x: 1 } } } })
  })

  it('reads dotted keys', () => {
    expect(parseToml('a.b.c = 1')).toEqual({ a: { b: { c: 1 } } })
  })

  it('reads an inline table', () => {
    expect(parseToml('a = { b = 1, c = "two" }')).toEqual({ a: { b: 1, c: 'two' } })
  })

  it('reads an array of tables', () => {
    expect(parseToml('[[bind]]\nkey = "a"\n[[bind]]\nkey = "b"')).toEqual({
      bind: [{ key: 'a' }, { key: 'b' }]
    })
  })

  it('rejects a table defined twice', () => {
    expect(() => parseToml('[a]\nx = 1\n[a]\ny = 2')).toThrow(/defined twice/u)
  })

  it('rejects a key defined twice', () => {
    expect(() => parseToml('a = 1\na = 2')).toThrow(/defined twice/u)
  })

  it('a quoted key may hold anything', () => {
    expect(parseToml('[keys.bindings]\n"%" = "pane.split-right"\n"C-b" = "x"')).toEqual({
      keys: { bindings: { '%': 'pane.split-right', 'C-b': 'x' } }
    })
  })
})

describe('arrays', () => {
  it('reads a flat array', () => {
    expect(parseToml('a = [1, 2, 3]')).toEqual({ a: [1, 2, 3] })
  })

  it('reads an array spanning lines, with a trailing comma and comments', () => {
    expect(
      parseToml(`a = [
        1, # one
        2,
      ]`)
    ).toEqual({ a: [1, 2] })
  })

  it('reads nested arrays and arrays of inline tables', () => {
    expect(parseToml('a = [[1, 2], [3]]\nb = [{ x = 1 }]')).toEqual({ a: [[1, 2], [3]], b: [{ x: 1 }] })
  })
})

describe('multi-line strings', () => {
  it('drops the newline immediately after the opening delimiter', () => {
    expect(parseToml('a = """\nline one\nline two"""')).toEqual({ a: 'line one\nline two' })
  })

  it('a line-ending backslash swallows the newline and the indent', () => {
    expect(parseToml('a = """\\\n   one \\\n   two"""')).toEqual({ a: 'one two' })
  })

  it('keeps quotes that belong to the content', () => {
    expect(parseToml('a = """say ""hi"""')).toEqual({ a: 'say ""hi' })
  })

  it('reads a multi-line literal string verbatim', () => {
    expect(parseToml("a = '''\nkeep \\n as-is'''")).toEqual({ a: 'keep \\n as-is' })
  })
})

describe('comments and whitespace', () => {
  it('ignores full-line and trailing comments', () => {
    expect(parseToml('# lead\n\n  a = 1 # trailing\n# tail\n')).toEqual({ a: 1 })
  })

  it('accepts CRLF line endings and a BOM', () => {
    expect(parseToml('﻿[ui]\r\nsidebar = true\r\n')).toEqual({ ui: { sidebar: true } })
  })

  it('an empty document is an empty table', () => {
    expect(parseToml('')).toEqual({})
    expect(parseToml('\n\n# nothing\n')).toEqual({})
  })
})

describe('errors', () => {
  it('names the line and column', () => {
    let thrown: unknown
    try {
      parseToml('a = 1\nb = 2\nc = @')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TomlError)
    expect((thrown as TomlError).line).toBe(3)
    expect((thrown as TomlError).message).toContain('line 3')
  })

  it('rejects a date-time by name rather than reading it as a string', () => {
    expect(() => parseToml('a = 2026-09-19T10:00:00Z')).toThrow(/date-times are not supported/u)
  })

  it('rejects an unterminated string', () => {
    expect(() => parseToml('a = "open')).toThrow(/unterminated/u)
  })

  it('rejects trailing junk after a value', () => {
    expect(() => parseToml('a = 1 2')).toThrow(TomlError)
  })

  it('rejects an unterminated array and inline table', () => {
    expect(() => parseToml('a = [1, 2')).toThrow(TomlError)
    expect(() => parseToml('a = { b = 1')).toThrow(TomlError)
  })
})

describe('a realistic leap-chorus config', () => {
  it('parses whole', () => {
    const document = parseToml(`
# leap-chorus
[general]
shell = "/bin/zsh"
scrollback = 20_000
mouse = true

[ui]
sidebar = true
sidebar-width = 26

[theme]
focus-border = 5

[keys]
prefix = "C-a"

[keys.bindings]
"|" = "pane.split-right"
"-" = "pane.split-down"
"%" = ""
`)
    expect(document).toEqual({
      general: { shell: '/bin/zsh', scrollback: 20000, mouse: true },
      ui: { sidebar: true, 'sidebar-width': 26 },
      theme: { 'focus-border': 5 },
      keys: { prefix: 'C-a', bindings: { '|': 'pane.split-right', '-': 'pane.split-down', '%': '' } }
    })
  })
})
