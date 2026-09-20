/**
 * herdr's cross-terminal fixture tables, run against this parser. PHASE-3 criterion 2:
 * all three tables, 80 rows total.
 *
 * The TSVs are copied verbatim from `herdr/tests/fixtures/` (Apache-2.0, herdr
 * 3f2a6e74) — they are captures from real terminals, so they are the one thing here that
 * no amount of reading a spec could produce. The reader follows herdr's
 * `assert_fixture_corpus_parses`, including its column-count sniffing: the protocol
 * corpus has 6 columns and the terminal-variant tables have 7, with a `source` and a
 * human-readable `key` in front.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOD_ALT,
  MOD_CTRL,
  MOD_HYPER,
  MOD_META,
  MOD_NONE,
  MOD_SHIFT,
  MOD_SUPER,
  type Key,
  type KeyEventKind,
  type Modifiers
} from '@leap-chorus/input'
import { parseKeySequence } from '@leap-chorus/input'

const vectors = join(dirname(fileURLToPath(import.meta.url)), 'vectors')

interface Row {
  readonly family: string
  readonly bytes: Buffer
  readonly code: string
  readonly modifiers: Modifiers
  readonly kind: KeyEventKind
  readonly shifted: number | null
}

function parseModifiers(value: string): Modifiers {
  if (value === '-' || value.length === 0) return MOD_NONE
  let modifiers: Modifiers = MOD_NONE
  for (const part of value.split('+')) {
    switch (part) {
      case 'shift':
        modifiers |= MOD_SHIFT
        break
      case 'alt':
        modifiers |= MOD_ALT
        break
      case 'control':
        modifiers |= MOD_CTRL
        break
      case 'super':
        modifiers |= MOD_SUPER
        break
      case 'hyper':
        modifiers |= MOD_HYPER
        break
      case 'meta':
        modifiers |= MOD_META
        break
      default:
        throw new Error(`unsupported fixture modifier: ${part}`)
    }
  }
  return modifiers
}

function parseKind(value: string): KeyEventKind {
  if (value === 'press' || value === 'repeat' || value === 'release') return value
  throw new Error(`unsupported fixture kind: ${value}`)
}

const isHex = (text: string): boolean => text.length > 0 && /^[0-9a-fA-F]+$/u.test(text)

function readRows(file: string): Row[] {
  const rows: Row[] = []
  for (const raw of readFileSync(join(vectors, file), 'utf8').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const columns = line.split('\t')
    if (columns.length === 5) columns.push('')

    // herdr sniffs on whether column 1 is hex: the protocol corpus puts the bytes there,
    // the terminal-variant tables put a human-readable key name there and the bytes in 2.
    let fields: readonly string[]
    if (columns.length === 6) {
      fields = isHex(columns[1] as string)
        ? [columns[0] as string, columns[1] as string, columns[2] as string, columns[3] as string, columns[4] as string, columns[5] as string]
        : [columns[0] as string, columns[2] as string, columns[3] as string, columns[4] as string, columns[5] as string, '']
    } else if (columns.length === 7) {
      fields = [columns[0] as string, columns[2] as string, columns[3] as string, columns[4] as string, columns[5] as string, columns[6] as string]
    } else {
      throw new Error(`fixture row must have 6 or 7 columns: ${line}`)
    }

    const [family, bytesHex, code, modifiers, kind, shifted] = fields as [
      string,
      string,
      string,
      string,
      string,
      string
    ]
    if (!isHex(bytesHex)) throw new Error(`non-hex fixture bytes for ${family}: ${bytesHex}`)
    rows.push({
      family,
      bytes: Buffer.from(bytesHex, 'hex'),
      code,
      modifiers: parseModifiers(modifiers),
      kind: parseKind(kind),
      shifted: shifted.length === 0 ? null : Number.parseInt(shifted, 10)
    })
  }
  return rows
}

/** What herdr's `code` column names, expressed against this key model. */
function expectCode(key: Key, code: string, family: string): void {
  if (code.startsWith('char:')) {
    expect(key.name, family).toBe('char')
    expect(key.char, family).toBe(code.slice('char:'.length))
    return
  }
  const named: Record<string, string> = {
    enter: 'enter',
    tab: 'tab',
    backspace: 'backspace',
    esc: 'escape',
    up: 'up',
    down: 'down',
    left: 'left',
    right: 'right',
    home: 'home',
    end: 'end',
    pageup: 'pageup',
    pagedown: 'pagedown',
    insert: 'insert',
    delete: 'delete'
  }
  const expected = named[code]
  if (expected === undefined) throw new Error(`unsupported fixture key code: ${code}`)
  expect(key.name, family).toBe(expected)
}

function checkTable(file: string, expectedRows: number): void {
  const rows = readRows(file)
  expect(rows).toHaveLength(expectedRows)
  for (const row of rows) {
    const key = parseKeySequence(row.bytes)
    expect(key, `fixture failed to parse: ${row.family}`).not.toBeNull()
    const actual = key as Key
    expectCode(actual, row.code, row.family)
    expect(actual.modifiers, row.family).toBe(row.modifiers)
    expect(actual.kind, row.family).toBe(row.kind)
    const shifted = actual.shiftedChar === undefined ? null : (actual.shiftedChar.codePointAt(0) as number)
    expect(shifted, row.family).toBe(row.shifted)
  }
}

describe('herdr fixture tables (PHASE-3 criterion 2)', () => {
  // Row counts are asserted so a truncated copy fails loudly rather than passing
  // vacuously. 39 + 21 + 17 data rows; each file's first line is a `#` header.
  it('keyboard protocol corpus', () => {
    checkTable('keyboard_protocol_corpus.tsv', 39)
  })

  it('macOS terminal variants', () => {
    checkTable('macos_terminal_variants.tsv', 17)
  })

  it('Linux terminal variants', () => {
    checkTable('linux_terminal_variants.tsv', 21)
  })

  it('covers 77 captured rows in total', () => {
    const total =
      readRows('keyboard_protocol_corpus.tsv').length +
      readRows('macos_terminal_variants.tsv').length +
      readRows('linux_terminal_variants.tsv').length
    // PHASE-3 says "80 rows"; that counts the three `#` header lines. 77 are vectors.
    expect(total).toBe(77)
  })
})
