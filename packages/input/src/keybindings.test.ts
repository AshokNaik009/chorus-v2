/**
 * The binding table. The mechanism from herdr's `src/input/keybindings.rs`; its action
 * enum is phase 4's, deliberately not ported.
 */

import { describe, expect, it } from 'vitest'
import { MOD_ALT, MOD_CTRL, MOD_NONE, MOD_SHIFT, charKey, fnKey, key } from './model.js'
import { KeybindingTable, chordMatches, formatChord, parseChord } from './keybindings.js'

describe('parseChord', () => {
  it('reads a bare character', () => {
    expect(parseChord('x')).toEqual({ name: 'char', char: 'x', modifiers: MOD_NONE })
  })

  it('reads modifiers', () => {
    expect(parseChord('C-b')).toEqual({ name: 'char', char: 'b', modifiers: MOD_CTRL })
    expect(parseChord('A-x')).toEqual({ name: 'char', char: 'x', modifiers: MOD_ALT })
    expect(parseChord('M-x')).toEqual({ name: 'char', char: 'x', modifiers: MOD_ALT })
    expect(parseChord('C-A-x')).toEqual({ name: 'char', char: 'x', modifiers: MOD_CTRL | MOD_ALT })
  })

  it('treats an uppercase letter as Shift plus the unshifted codepoint', () => {
    // Which is how the parser reports it, so a binding written `H` matches what arrives.
    expect(parseChord('H')).toEqual({ name: 'char', char: 'h', modifiers: MOD_SHIFT })
  })

  it('reads named keys and function keys', () => {
    expect(parseChord('Tab')).toEqual({ name: 'tab', modifiers: MOD_NONE })
    expect(parseChord('S-Tab')).toEqual({ name: 'tab', modifiers: MOD_SHIFT })
    expect(parseChord('Escape')).toEqual({ name: 'escape', modifiers: MOD_NONE })
    expect(parseChord('esc')).toEqual({ name: 'escape', modifiers: MOD_NONE })
    expect(parseChord('C-Left')).toEqual({ name: 'left', modifiers: MOD_CTRL })
    expect(parseChord('F5')).toEqual({ name: 'f', fn: 5, modifiers: MOD_NONE })
    expect(parseChord('C-F12')).toEqual({ name: 'f', fn: 12, modifiers: MOD_CTRL })
  })

  it('reads the minus key, which is also the separator', () => {
    expect(parseChord('-')).toEqual({ name: 'char', char: '-', modifiers: MOD_NONE })
    expect(parseChord('C--')).toEqual({ name: 'char', char: '-', modifiers: MOD_CTRL })
  })

  it('refuses what it cannot read', () => {
    expect(parseChord('')).toBeNull()
    expect(parseChord('Q-x')).toBeNull()
    expect(parseChord('nosuchkey')).toBeNull()
    expect(parseChord('F99')).toBeNull()
  })
})

describe('chordMatches', () => {
  it('matches on identity and meaning-bearing modifiers', () => {
    const chord = parseChord('C-b')
    expect(chord).not.toBeNull()
    expect(chordMatches(chord!, charKey('b', MOD_CTRL))).toBe(true)
    expect(chordMatches(chord!, charKey('b', MOD_NONE))).toBe(false)
    expect(chordMatches(chord!, charKey('c', MOD_CTRL))).toBe(false)
  })

  it('ignores Caps Lock and Num Lock', () => {
    // A binding for `h` must still fire when Caps Lock happens to be on.
    const chord = parseChord('h')
    expect(chordMatches(chord!, charKey('h', 1 << 6))).toBe(true)
    expect(chordMatches(chord!, charKey('h', 1 << 7))).toBe(true)
  })

  it('distinguishes a shifted binding from an unshifted one', () => {
    expect(chordMatches(parseChord('H')!, charKey('h', MOD_SHIFT))).toBe(true)
    expect(chordMatches(parseChord('h')!, charKey('h', MOD_SHIFT))).toBe(false)
  })

  /**
   * A symbol nobody can resolve to an unshifted key without a layout table.
   *
   * Legacy terminals send `%` and report it unmodified; a kitty-protocol terminal sends
   * the key that produced it — `5` on a US layout — with Shift and `shiftedChar: '%'`.
   * A config that says `%` means the key that types `%`, so both must match.
   */
  it('matches a symbol chord against a shifted alternate', () => {
    const chord = parseChord('%')!
    expect(chordMatches(chord, charKey('%'))).toBe(true)
    expect(chordMatches(chord, charKey('5', MOD_SHIFT, { shiftedChar: '%' }))).toBe(true)
    expect(chordMatches(chord, charKey('5'))).toBe(false)
  })
})

describe('the table', () => {
  it('resolves by dispatch mode', () => {
    const table = new KeybindingTable<string>()
    expect(table.bind('C-b', 'direct', 'prefix')).toBe(true)
    expect(table.bind('%', 'prefix', 'split-horizontal')).toBe(true)

    expect(table.resolve(charKey('b', MOD_CTRL), 'direct')).toBe('prefix')
    // The same key resolves to nothing in the other mode.
    expect(table.resolve(charKey('b', MOD_CTRL), 'prefix')).toBeNull()
    expect(table.resolve(charKey('%'), 'prefix')).toBe('split-horizontal')
    expect(table.resolve(charKey('%'), 'direct')).toBeNull()
  })

  it('lets a later binding override an earlier one for the same chord', () => {
    const table = new KeybindingTable<string>()
    table.bind('z', 'prefix', 'zoom')
    table.bind('z', 'prefix', 'something-else')
    expect(table.size).toBe(1)
    expect(table.resolve(charKey('z'), 'prefix')).toBe('something-else')
  })

  it('never fires on a release', () => {
    // A binding that fired twice per keystroke would be the obvious bug here.
    const table = new KeybindingTable<string>()
    table.bind('x', 'prefix', 'kill')
    expect(table.resolve({ ...charKey('x'), kind: 'release' }, 'prefix')).toBeNull()
    expect(table.resolve({ ...charKey('x'), kind: 'repeat' }, 'prefix')).toBe('kill')
  })

  it('refuses an unparseable chord rather than binding nothing', () => {
    const table = new KeybindingTable<string>()
    expect(table.bind('Q-x', 'prefix', 'nope')).toBe(false)
    expect(table.size).toBe(0)
  })

  it('binds named and function keys', () => {
    const table = new KeybindingTable<string>()
    table.bind('Tab', 'prefix', 'next-pane')
    table.bind('F5', 'direct', 'reload')
    expect(table.resolve(key('tab'), 'prefix')).toBe('next-pane')
    expect(table.resolve(fnKey(5), 'direct')).toBe('reload')
  })
})

describe('formatChord', () => {
  it('round-trips through parseChord', () => {
    for (const text of ['C-b', 'A-x', 'C-A-x', 'H', 'Tab', 'S-Tab', 'F5', 'C-Left', '%']) {
      const chord = parseChord(text)
      expect(chord, text).not.toBeNull()
      expect(parseChord(formatChord(chord!)), text).toEqual(chord)
    }
  })
})
