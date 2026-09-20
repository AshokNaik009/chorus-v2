/**
 * Parser vectors, transliterated from herdr's `src/input/parse.rs` test module
 * (Apache-2.0, herdr 3f2a6e74). Test names follow herdr's so a failure can be read
 * against the original.
 */

import { describe, expect, it } from 'vitest'
import {
  MOD_ALT,
  MOD_CTRL,
  MOD_NONE,
  MOD_SHIFT,
  MOD_SUPER,
  type Key
} from './model.js'
import { parseKeySequence } from './parse-csi.js'

/** Parse a sequence given as text. Bytes, because that is what the framer hands over. */
function parse(sequence: string): Key | null {
  return parseKeySequence(Buffer.from(sequence, 'utf8'))
}

function expectKey(sequence: string, expected: Partial<Key>): void {
  const actual = parse(sequence)
  expect(actual, `expected ${JSON.stringify(sequence)} to parse`).not.toBeNull()
  expect(actual).toMatchObject(expected)
}

describe('legacy special sequences', () => {
  it('parses the F1..F12 forms, in both encodings', () => {
    // herdr: parse_legacy_f_keys
    const cases: ReadonlyArray<readonly [string, number]> = [
      ['\x1bOP', 1],
      ['\x1b[11~', 1],
      ['\x1bOQ', 2],
      ['\x1b[12~', 2],
      ['\x1bOR', 3],
      ['\x1b[13~', 3],
      ['\x1bOS', 4],
      ['\x1b[14~', 4],
      ['\x1b[15~', 5],
      ['\x1b[17~', 6],
      ['\x1b[24~', 12]
    ]
    for (const [sequence, fn] of cases) {
      expectKey(sequence, { name: 'f', fn, modifiers: MOD_NONE, kind: 'press' })
    }
    // The gaps in the table are gaps, not off-by-ones: 16 and 22 are not function keys.
    expect(parse('\x1b[10~')).toBeNull()
    expect(parse('\x1b[16~')).toBeNull()
  })

  it('parses navigation keys', () => {
    expectKey('\x1b[1~', { name: 'home' })
    expectKey('\x1b[4~', { name: 'end' })
    expectKey('\x1b[5~', { name: 'pageup' })
    expectKey('\x1b[6~', { name: 'pagedown' })
    expectKey('\x1b[2~', { name: 'insert' })
    expectKey('\x1b[3~', { name: 'delete' })
  })

  it('parses arrows in both normal and application cursor mode', () => {
    // herdr: parse_legacy_up_arrow_sequence
    for (const [sequence, name] of [
      ['\x1b[A', 'up'],
      ['\x1bOA', 'up'],
      ['\x1b[B', 'down'],
      ['\x1bOB', 'down'],
      ['\x1b[C', 'right'],
      ['\x1bOC', 'right'],
      ['\x1b[D', 'left'],
      ['\x1bOD', 'left']
    ] as const) {
      expectKey(sequence, { name, modifiers: MOD_NONE })
    }
  })

  it('parses the application keypad', () => {
    // herdr: parse_legacy_application_keypad_sequences
    for (const [sequence, char] of [
      ['\x1bOp', '0'],
      ['\x1bOq', '1'],
      ['\x1bOy', '9'],
      ['\x1bOn', '.'],
      ['\x1bOl', ','],
      ['\x1bOm', '-'],
      ['\x1bOk', '+'],
      ['\x1bOj', '*'],
      ['\x1bOo', '/']
    ] as const) {
      expectKey(sequence, { name: 'char', char, modifiers: MOD_NONE })
    }
    expectKey('\x1bOM', { name: 'enter' })
  })

  it('leaves an unknown SS3 sequence unparsed', () => {
    // herdr: unknown_legacy_ss3_sequence_remains_unsupported
    expect(parse('\x1bOZ')).toBeNull()
  })

  it('parses backtab', () => {
    expectKey('\x1b[Z', { name: 'backtab', modifiers: MOD_SHIFT })
  })
})

describe('legacy control bytes', () => {
  it('parses Ctrl+letter', () => {
    // herdr: parse_legacy_ctrl_b_sequence, parse_legacy_ctrl_c_sequence
    expectKey('\x02', { name: 'char', char: 'b', modifiers: MOD_CTRL })
    expectKey('\x03', { name: 'char', char: 'c', modifiers: MOD_CTRL })
  })

  it('covers the whole control matrix', () => {
    // herdr: legacy_ctrl_byte_matrix_is_covered
    expectKey('\x00', { name: 'char', char: ' ', modifiers: MOD_CTRL })
    for (let code = 1; code <= 26; code++) {
      if (code === 9 || code === 13) continue // Tab and Enter are named keys, checked below
      expectKey(String.fromCharCode(code), {
        name: 'char',
        char: String.fromCharCode(code + 96),
        modifiers: MOD_CTRL
      })
    }
    expectKey('\x1c', { name: 'char', char: '\\', modifiers: MOD_CTRL })
    expectKey('\x1d', { name: 'char', char: ']', modifiers: MOD_CTRL })
    expectKey('\x1e', { name: 'char', char: '^', modifiers: MOD_CTRL })
    expectKey('\x1f', { name: 'char', char: '_', modifiers: MOD_CTRL })
  })

  it('names CR, Tab, Escape and DEL rather than treating them as control chords', () => {
    expectKey('\r', { name: 'enter', modifiers: MOD_NONE })
    expectKey('\t', { name: 'tab', modifiers: MOD_NONE })
    expectKey('\x1b', { name: 'escape', modifiers: MOD_NONE })
    expectKey('\x7f', { name: 'backspace', modifiers: MOD_NONE })
  })

  it('keeps a bare LF as Ctrl+J', () => {
    // herdr: parse_legacy_lf_sequence_as_ctrl_j. Deliberate: LF is what Ctrl+J sends and
    // what several Shift+Enter workarounds send, so it must not be folded into Enter.
    expectKey('\n', { name: 'char', char: 'j', modifiers: MOD_CTRL })
  })

  it('reads an uppercase letter as Shift plus the unshifted codepoint', () => {
    // herdr: parse_legacy_uppercase_letter_as_shifted_char.
    //
    // `char` is the *unshifted* codepoint, which is the contract `model.ts` states and
    // which the kitty path already honoured. Phase 4 made the legacy path agree: it
    // used to report `{char: 'L', shift}` while kitty reported
    // `{char: 'l', shift, shiftedChar: 'L'}`, so a binding on `L` fired under one
    // protocol and silently not the other.
    expectKey('L', { name: 'char', char: 'l', modifiers: MOD_SHIFT, shiftedChar: 'L' })
    expectKey('l', { name: 'char', char: 'l', modifiers: MOD_NONE })
  })

  it('reads ESC + one character as Alt + that character', () => {
    expectKey('\x1ba', { name: 'char', char: 'a', modifiers: MOD_ALT })
    // herdr: parse_legacy_alt_shift_letter_preserves_shift
    expectKey('\x1bL', { name: 'char', char: 'l', modifiers: MOD_ALT | MOD_SHIFT })
    // herdr: parse_legacy_alt_control_letter_composes_modifiers
    expectKey('\x1b\x02', { name: 'char', char: 'b', modifiers: MOD_ALT | MOD_CTRL })
    // herdr: parse_legacy_alt_backspace_sequence
    expectKey('\x1b\x7f', { name: 'backspace', modifiers: MOD_ALT })
  })

  it('reads a multi-byte character as one key', () => {
    expectKey('é', { name: 'char', char: 'é', modifiers: MOD_NONE })
    expectKey('世', { name: 'char', char: '世', modifiers: MOD_NONE })
  })
})

describe('xterm modified sequences', () => {
  it('parses CSI 1 ; mod <final>', () => {
    // herdr: parse_xterm_alt_up_arrow_sequence, parse_xterm_alt_down_arrow_sequence
    expectKey('\x1b[1;3A', { name: 'up', modifiers: MOD_ALT })
    expectKey('\x1b[1;3B', { name: 'down', modifiers: MOD_ALT })
    expectKey('\x1b[1;5C', { name: 'right', modifiers: MOD_CTRL })
    expectKey('\x1b[1;2D', { name: 'left', modifiers: MOD_SHIFT })
    expectKey('\x1b[1;5H', { name: 'home', modifiers: MOD_CTRL })
    expectKey('\x1b[1;5F', { name: 'end', modifiers: MOD_CTRL })
  })

  it('parses modified F1..F4 in the CSI 1 ; mod form', () => {
    // herdr: parse_modified_f_keys
    expectKey('\x1b[1;5P', { name: 'f', fn: 1, modifiers: MOD_CTRL })
    expectKey('\x1b[1;5Q', { name: 'f', fn: 2, modifiers: MOD_CTRL })
    expectKey('\x1b[1;2R', { name: 'f', fn: 3, modifiers: MOD_SHIFT })
    expectKey('\x1b[1;3S', { name: 'f', fn: 4, modifiers: MOD_ALT })
  })

  it('parses the parameterized tilde form', () => {
    // herdr: parse_parameterized_csi_tilde_f1_through_f4
    expectKey('\x1b[11;5~', { name: 'f', fn: 1, modifiers: MOD_CTRL })
    expectKey('\x1b[15;2~', { name: 'f', fn: 5, modifiers: MOD_SHIFT })
    expectKey('\x1b[3;5~', { name: 'delete', modifiers: MOD_CTRL })
    expectKey('\x1b[5;3~', { name: 'pageup', modifiers: MOD_ALT })
  })

  it('carries the kitty event type on an xterm sequence', () => {
    // Ghostty sends these once the kitty protocol is on.
    expectKey('\x1b[1;1:3A', { name: 'up', kind: 'release' })
    expectKey('\x1b[3;1:2~', { name: 'delete', kind: 'repeat' })
  })

  it('drops Alacritty macOS function-key markers but keeps the key', () => {
    // herdr: parse_xterm_special_sequences_with_associated_text. The final already says
    // which key it was; the trailing field is Cocoa noise.
    expect(parse('\x1b[1;1;63233;63234B')).toBeNull()
  })
})

describe('kitty keyboard protocol', () => {
  it('parses a plain functional key', () => {
    // herdr: parse_kitty_functional_up_arrow_sequence
    expectKey('\x1b[57419u', { name: 'up', modifiers: MOD_NONE, kind: 'press' })
  })

  it('maps F1..F12 and F13..F35', () => {
    // herdr: kitty_f1_through_f12_codepoints_are_recognized
    for (let i = 0; i < 12; i++) expectKey(`\x1b[${57364 + i}u`, { name: 'f', fn: i + 1 })
    for (let i = 0; i < 23; i++) expectKey(`\x1b[${57376 + i}u`, { name: 'f', fn: i + 13 })
  })

  it('maps the named functional block', () => {
    // herdr: kitty_functional_key_matrix_is_covered
    const cases: ReadonlyArray<readonly [number, string]> = [
      [57358, 'capslock'],
      [57359, 'scrolllock'],
      [57360, 'numlock'],
      [57361, 'printscreen'],
      [57362, 'pause'],
      [57363, 'menu'],
      [57417, 'left'],
      [57418, 'right'],
      [57419, 'up'],
      [57420, 'down'],
      [57421, 'pageup'],
      [57422, 'pagedown'],
      [57423, 'home'],
      [57424, 'end'],
      [57425, 'insert'],
      [57426, 'delete'],
      [57427, 'keypadbegin']
    ]
    for (const [codepoint, name] of cases) expectKey(`\x1b[${codepoint}u`, { name })
    // Enter has two codepoints: the ASCII one and the keypad one.
    expectKey('\x1b[13u', { name: 'enter' })
    expectKey('\x1b[57414u', { name: 'enter' })
    // Backspace has two as well, and 127 is the common one.
    expectKey('\x1b[8u', { name: 'backspace' })
    expectKey('\x1b[127u', { name: 'backspace' })
  })

  it('maps media and modifier keys', () => {
    expectKey('\x1b[57430u', { name: 'media', media: 'playpause' })
    expectKey('\x1b[57440u', { name: 'media', media: 'mutevolume' })
    expectKey('\x1b[57441u', { name: 'modifier', modifierKey: 'leftshift' })
    expectKey('\x1b[57454u', { name: 'modifier', modifierKey: 'isolevel5shift' })
  })

  it('decodes every modifier bit', () => {
    // herdr: parse_kitty_modifier_sequence
    expectKey('\x1b[97;2u', { char: 'a', modifiers: MOD_SHIFT })
    expectKey('\x1b[97;3u', { char: 'a', modifiers: MOD_ALT })
    expectKey('\x1b[97;5u', { char: 'a', modifiers: MOD_CTRL })
    expectKey('\x1b[97;9u', { char: 'a', modifiers: MOD_SUPER })
    expectKey('\x1b[97;8u', { char: 'a', modifiers: MOD_SHIFT | MOD_ALT | MOD_CTRL })
  })

  it('carries the event type', () => {
    // herdr: parse_ghostty_enhanced_* — press, repeat and release all round-trip.
    expectKey('\x1b[57419;1u', { name: 'up', kind: 'press' })
    expectKey('\x1b[57426;1:2u', { name: 'delete', kind: 'repeat' })
    expectKey('\x1b[57422;1:3u', { name: 'pagedown', kind: 'release' })
    // 4 is not an event type.
    expect(parse('\x1b[97;1:4u')).toBeNull()
  })

  it('preserves a shifted alternate', () => {
    // herdr: parse_kitty_sequence_preserves_shifted_symbol_pair / _letter_pair_and_release
    expectKey('\x1b[49:33;2:1u', { char: '1', modifiers: MOD_SHIFT, kind: 'press', shiftedChar: '!' })
    expectKey('\x1b[108:76;2:3u', { char: 'l', modifiers: MOD_SHIFT, kind: 'release', shiftedChar: 'L' })
  })

  it('preserves non-US shifted pairs', () => {
    // herdr: parse_kitty_sequence_preserves_non_us_shift_pairs. The layout's answer wins;
    // no amount of codepoint arithmetic here would know that Shift+& is 1 on AZERTY.
    for (const [sequence, base, shifted] of [
      ['\x1b[50:34;2:1u', '2', '"'],
      ['\x1b[38:49;2:1u', '&', '1'],
      ['\x1b[305:73;2:1u', 'ı', 'I'],
      ['\x1b[287:286;2:1u', 'ğ', 'Ğ']
    ] as const) {
      expectKey(sequence, { char: base, modifiers: MOD_SHIFT, kind: 'press', shiftedChar: shifted })
    }
  })

  it('recovers a Shift modifier the terminal forgot to report', () => {
    // herdr: parse_kitty_sequence_recovers_omitted_shift_modifier
    for (const [sequence, kind] of [
      ['\x1b[114:82;1u', 'press'],
      ['\x1b[114:82;1:2u', 'repeat'],
      ['\x1b[114:82;1:3u', 'release']
    ] as const) {
      expectKey(sequence, { char: 'r', modifiers: MOD_SHIFT, kind, shiftedChar: 'R' })
    }
  })

  it('does not infer Shift without a distinct alternate', () => {
    // herdr: parse_kitty_sequence_does_not_infer_shift_without_distinct_shifted_alternate
    for (const sequence of ['\x1b[114;1u', '\x1b[114:114;1u', '\x1b[114::113;1u']) {
      expectKey(sequence, { char: 'r', modifiers: MOD_NONE })
    }
  })

  it('carries associated text, including IME output', () => {
    // herdr: parse_kitty_sequence_with_associated_emoji_text / _with_multicodepoint_ime_text
    expectKey('\x1b[128512;1;128512u', { char: '😀', modifiers: MOD_NONE, text: '😀' })
    expectKey('\x1b[32;;20320:22909u', { char: ' ', modifiers: MOD_NONE, text: '你好' })
  })

  it("keeps WezTerm's control associated text as a key with no text", () => {
    // herdr: parse_wezterm_control_associated_text_keeps_report_all_key_events
    for (const [sequence, name] of [
      ['\x1b[13;1;13u', 'enter'],
      ['\x1b[9;1;9u', 'tab'],
      ['\x1b[27;1;27u', 'escape'],
      ['\x1b[8;1;8u', 'backspace']
    ] as const) {
      const key = parse(sequence)
      expect(key, sequence).not.toBeNull()
      expect(key?.name).toBe(name)
      expect(key?.modifiers).toBe(MOD_NONE)
      expect(key?.text).toBeUndefined()
    }
  })

  it('rejects malformed associated text', () => {
    // herdr: reject_malformed_kitty_associated_text, verbatim.
    for (const sequence of [
      '\x1b[32;;1114112u',
      '\x1b[32;;20320:bad:u',
      '\x1b[32;;27u',
      '\x1b[32;;133u',
      '\x1b[13;1;8u',
      '\x1b[127::8;1;13u',
      '\x1b[13;1;13:10u',
      '\x1b[9;1;27u',
      '\x1b[27;1;9u',
      '\x1b[9;1;9:97u',
      '\x1b[27;1;27:27u'
    ]) {
      expect(parse(sequence), sequence).toBeNull()
    }
  })

  it('parses Alt+Backspace', () => {
    // herdr: parse_kitty_alt_backspace_sequence
    expectKey('\x1b[127;3u', { name: 'backspace', modifiers: MOD_ALT, kind: 'press' })
  })
})

describe('modifyOtherKeys', () => {
  it('parses CSI 27 ; mod ; codepoint ~', () => {
    // herdr: parse_modify_other_keys_sequence
    expectKey('\x1b[27;6;108~', { name: 'char', char: 'l', modifiers: MOD_CTRL | MOD_SHIFT, kind: 'press' })
    expectKey('\x1b[27;5;99~', { name: 'char', char: 'c', modifiers: MOD_CTRL })
    // The named codepoints go through the same table as kitty's.
    expectKey('\x1b[27;3;13~', { name: 'enter', modifiers: MOD_ALT })
  })

  it('rejects a malformed one', () => {
    expect(parse('\x1b[27;6~')).toBeNull()
    expect(parse('\x1b[27;x;108~')).toBeNull()
  })
})
