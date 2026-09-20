/**
 * Encoder vectors, transliterated from herdr's `src/input/encode.rs` test module
 * (Apache-2.0, herdr 3f2a6e74), plus PHASE-3's criterion 4 round trip.
 */

import { describe, expect, it } from 'vitest'
import {
  KITTY_DISAMBIGUATE_ESCAPE_CODES,
  KITTY_REPORT_ALL_KEYS,
  KITTY_REPORT_ALTERNATE_KEYS,
  KITTY_REPORT_EVENT_TYPES,
  LEGACY_PROTOCOL,
  MOD_ALT,
  MOD_CTRL,
  MOD_NONE,
  MOD_SHIFT,
  MOD_SUPER,
  charKey,
  fnKey,
  key,
  type KeyboardProtocol
} from './model.js'
import { encodeKey, encodeMouse, kittyModifier, xtermModifier } from './encode.js'
import { parseKeySequence } from './parse-csi.js'
import { parseSgrMouse, parseX10Mouse } from './mouse.js'

const legacy = LEGACY_PROTOCOL
const kitty = (flags: number): KeyboardProtocol => ({ ...LEGACY_PROTOCOL, kittyFlags: flags })

/** Encoded bytes as a latin1 string, so a byte is one character in the assertion. */
function enc(k: Parameters<typeof encodeKey>[0], protocol: KeyboardProtocol = legacy): string {
  return encodeKey(k, protocol).toString('latin1')
}

describe('modifier parameters', () => {
  it('uses the 1 + mask encoding', () => {
    expect(xtermModifier(MOD_NONE)).toBe(1)
    expect(xtermModifier(MOD_SHIFT)).toBe(2)
    expect(xtermModifier(MOD_ALT)).toBe(3)
    expect(xtermModifier(MOD_CTRL)).toBe(5)
    expect(xtermModifier(MOD_SHIFT | MOD_ALT | MOD_CTRL)).toBe(8)
    // Super, hyper and meta exist only in kitty's superset.
    expect(xtermModifier(MOD_SUPER)).toBe(1)
    expect(kittyModifier(MOD_SUPER)).toBe(9)
  })
})

describe('legacy encoding', () => {
  it('encodes the named keys', () => {
    expect(enc(key('enter'))).toBe('\r')
    expect(enc(key('tab'))).toBe('\t')
    expect(enc(key('backspace'))).toBe('\x7f')
    expect(enc(key('escape'))).toBe('\x1b')
    expect(enc(key('backtab', MOD_SHIFT))).toBe('\x1b[Z')
    expect(enc(key('up'))).toBe('\x1b[A')
    expect(enc(key('down'))).toBe('\x1b[B')
    expect(enc(key('right'))).toBe('\x1b[C')
    expect(enc(key('left'))).toBe('\x1b[D')
    expect(enc(key('home'))).toBe('\x1b[H')
    expect(enc(key('end'))).toBe('\x1b[F')
    expect(enc(key('pageup'))).toBe('\x1b[5~')
    expect(enc(key('pagedown'))).toBe('\x1b[6~')
    expect(enc(key('insert'))).toBe('\x1b[2~')
    expect(enc(key('delete'))).toBe('\x1b[3~')
  })

  it('switches arrows to SS3 under application cursor keys', () => {
    // DECCKM is pane state, so it arrives as part of the protocol rather than a global.
    const app: KeyboardProtocol = { ...LEGACY_PROTOCOL, applicationCursorKeys: true }
    expect(enc(key('up'), app)).toBe('\x1bOA')
    expect(enc(key('left'), app)).toBe('\x1bOD')
    expect(enc(key('home'), app)).toBe('\x1bOH')
    // A *modified* arrow stays in the CSI form even then; that is what xterm does.
    expect(enc(key('up', MOD_CTRL), app)).toBe('\x1b[1;5A')
  })

  it('encodes the function keys', () => {
    expect(enc(fnKey(1))).toBe('\x1bOP')
    expect(enc(fnKey(4))).toBe('\x1bOS')
    expect(enc(fnKey(5))).toBe('\x1b[15~')
    expect(enc(fnKey(12))).toBe('\x1b[24~')
  })

  it('encodes modified special keys in the xterm form', () => {
    expect(enc(key('up', MOD_ALT))).toBe('\x1b[1;3A')
    expect(enc(key('right', MOD_CTRL))).toBe('\x1b[1;5C')
    expect(enc(key('end', MOD_SHIFT))).toBe('\x1b[1;2F')
    expect(enc(key('delete', MOD_CTRL))).toBe('\x1b[3;5~')
    expect(enc(key('pageup', MOD_ALT))).toBe('\x1b[5;3~')
    expect(enc(fnKey(1, MOD_CTRL))).toBe('\x1b[1;5P')
    expect(enc(fnKey(5, MOD_SHIFT))).toBe('\x1b[15;2~')
  })

  it('encodes Ctrl chords as control bytes', () => {
    expect(enc(charKey('a', MOD_CTRL))).toBe('\x01')
    expect(enc(charKey('b', MOD_CTRL))).toBe('\x02')
    expect(enc(charKey('z', MOD_CTRL))).toBe('\x1a')
    expect(enc(charKey(' ', MOD_CTRL))).toBe('\x00')
    expect(enc(charKey('[', MOD_CTRL))).toBe('\x1b')
    expect(enc(charKey('\\', MOD_CTRL))).toBe('\x1c')
    expect(enc(charKey(']', MOD_CTRL))).toBe('\x1d')
    expect(enc(charKey('^', MOD_CTRL))).toBe('\x1e')
    expect(enc(charKey('_', MOD_CTRL))).toBe('\x1f')
    // herdr's digit aliases, which xterm has always accepted.
    expect(enc(charKey('2', MOD_CTRL))).toBe('\x00')
    expect(enc(charKey('3', MOD_CTRL))).toBe('\x1b')
    expect(enc(charKey('7', MOD_CTRL))).toBe('\x1f')
    expect(enc(charKey('-', MOD_CTRL))).toBe('\x1f')
  })

  it('prefixes Alt with ESC', () => {
    expect(enc(charKey('a', MOD_ALT))).toBe('\x1ba')
    expect(enc(charKey('b', MOD_ALT | MOD_CTRL))).toBe('\x1b\x02')
    expect(enc(key('backspace', MOD_ALT))).toBe('\x1b\x7f')
  })

  it('commits a shifted character as its shifted form', () => {
    expect(enc(charKey('a', MOD_SHIFT))).toBe('A')
    expect(enc(charKey('A', MOD_SHIFT))).toBe('A')
    // The layout's answer beats case folding.
    expect(enc(charKey('2', MOD_SHIFT, { shiftedChar: '"' }))).toBe('"')
  })

  it('sends nothing for a key with no legacy encoding', () => {
    expect(enc(key('media', MOD_NONE, { media: 'playpause' }))).toBe('')
    expect(enc(key('modifier', MOD_NONE, { modifierKey: 'leftshift' }))).toBe('')
  })
})

describe('release events', () => {
  it('produce nothing unless the pane asked for event types', () => {
    // Without this, every keystroke in such a pane arrives twice.
    const release = { ...key('enter'), kind: 'release' as const }
    expect(enc(release)).toBe('')
    expect(enc(release, kitty(KITTY_DISAMBIGUATE_ESCAPE_CODES))).toBe('')
    expect(enc({ ...charKey('a', MOD_CTRL), kind: 'release' }, kitty(KITTY_REPORT_EVENT_TYPES))).toBe('\x1b[97;5:3u')
  })

  it('still produce nothing for an unmodified Enter, Tab or Backspace', () => {
    // herdr's behaviour, matched deliberately rather than "improved". `try_encode_csi_u`
    // refuses bare Enter/Tab/Backspace outright so a program reading one byte still gets
    // one byte — and because that guard runs before the event-type check, the release of
    // a bare Enter encodes to nothing even in a pane that asked for event types.
    //
    // Arguably such a pane wants `CSI 13;1:3u`. Nothing here can settle that without a
    // real terminal and a real program to try it against, so this follows the reference
    // and records the question. See HANDOFF.
    const types = kitty(KITTY_REPORT_EVENT_TYPES)
    for (const name of ['enter', 'tab', 'backspace'] as const) {
      expect(enc({ ...key(name), kind: 'release' }, types), name).toBe('')
    }
    // The guard is narrow: a *modified* one does encode.
    expect(enc({ ...key('enter', MOD_CTRL), kind: 'release' }, types)).toBe('\x1b[13;5:3u')
    // And REPORT_ALL_KEYS lifts it entirely, which is what that flag is for.
    expect(enc({ ...key('enter'), kind: 'release' }, kitty(KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS))).toBe(
      '\x1b[13;1:3u'
    )
  })
})

describe('kitty encoding', () => {
  const flags = KITTY_DISAMBIGUATE_ESCAPE_CODES

  it('leaves unmodified basic keys in their legacy form', () => {
    // A program that reads one byte and expects Enter must still get one byte.
    expect(enc(key('enter'), kitty(flags))).toBe('\r')
    expect(enc(key('tab'), kitty(flags))).toBe('\t')
    expect(enc(key('backspace'), kitty(flags))).toBe('\x7f')
    expect(enc(charKey('a'), kitty(flags))).toBe('a')
  })

  it('leaves modified arrows and function keys in their legacy form', () => {
    // Ghostty does the same with kitty mode on: these legacy forms are universal.
    expect(enc(key('up', MOD_CTRL), kitty(flags))).toBe('\x1b[1;5A')
    expect(enc(fnKey(1, MOD_ALT), kitty(flags))).toBe('\x1b[1;3P')
  })

  it('uses CSI u for a modified character key', () => {
    expect(enc(charKey('a', MOD_CTRL), kitty(flags))).toBe('\x1b[97;5u')
    expect(enc(charKey('a', MOD_SUPER), kitty(flags))).toBe('\x1b[97;9u')
    expect(enc(charKey('l', MOD_CTRL | MOD_SHIFT), kitty(flags))).toBe('\x1b[108;6u')
  })

  it('reports the unshifted codepoint with the shift bit, not the shifted one', () => {
    // `L` with a Shift bit would read as Shift+Shift+L.
    expect(enc(charKey('L', MOD_SHIFT | MOD_CTRL), kitty(flags))).toBe('\x1b[108;6u')
  })

  it('adds the alternate key only when asked', () => {
    const k = charKey('1', MOD_SHIFT | MOD_CTRL, { shiftedChar: '!' })
    expect(enc(k, kitty(flags))).toBe('\x1b[49;6u')
    expect(enc(k, kitty(flags | KITTY_REPORT_ALTERNATE_KEYS))).toBe('\x1b[49:33;6u')
  })

  it('adds the event type only when asked', () => {
    expect(enc(charKey('a', MOD_CTRL), kitty(flags))).toBe('\x1b[97;5u')
    expect(enc(charKey('a', MOD_CTRL), kitty(flags | KITTY_REPORT_EVENT_TYPES))).toBe('\x1b[97;5:1u')
    expect(
      enc({ ...charKey('a', MOD_CTRL), kind: 'repeat' }, kitty(flags | KITTY_REPORT_EVENT_TYPES))
    ).toBe('\x1b[97;5:2u')
  })

  it('reports every key physically once REPORT_ALL_KEYS is on', () => {
    const all = kitty(flags | KITTY_REPORT_ALL_KEYS)
    expect(enc(charKey('a'), all)).toBe('\x1b[97;1u')
    expect(enc(key('enter'), all)).toBe('\x1b[13;1u')
    expect(enc(key('up'), all)).toBe('\x1b[57419;1u')
    // And the terminal's text no longer wins, because the pane asked for the key.
    expect(enc(charKey('a', MOD_NONE, { text: 'a' }), all)).toBe('\x1b[97;1u')
  })
})

describe('the terminal-reported text wins', () => {
  it('is sent verbatim in a pane that did not ask for physical keys', () => {
    // The layout knows things this code cannot: on AZERTY, Shift+& commits `1`.
    expect(enc(charKey('&', MOD_SHIFT, { text: '1' }))).toBe('1')
    expect(enc(charKey(' ', MOD_NONE, { text: '你好' }), legacy)).toBe(
      Buffer.from('你好', 'utf8').toString('latin1')
    )
  })
})

describe('modifyOtherKeys', () => {
  it('encodes a chord as CSI 27 ; mod ; codepoint ~ at level 2', () => {
    const level2: KeyboardProtocol = { ...LEGACY_PROTOCOL, modifyOtherKeys: 2 }
    expect(enc(charKey('l', MOD_CTRL | MOD_SHIFT), level2)).toBe('\x1b[27;6;108~')
    expect(enc(charKey('c', MOD_CTRL), level2)).toBe('\x1b[27;5;99~')
    // Shift alone is text, and keeps its legacy encoding.
    expect(enc(charKey('a', MOD_SHIFT), level2)).toBe('A')
  })

  it('is left alone at level 0 and level 1', () => {
    expect(enc(charKey('c', MOD_CTRL), { ...LEGACY_PROTOCOL, modifyOtherKeys: 0 })).toBe('\x03')
    expect(enc(charKey('c', MOD_CTRL), { ...LEGACY_PROTOCOL, modifyOtherKeys: 1 })).toBe('\x03')
  })
})

describe('mouse encoding', () => {
  it('encodes SGR reports', () => {
    expect(
      encodeMouse({ kind: 'down', button: 'left', column: 19, row: 9, modifiers: MOD_NONE, encoding: 'sgr' })?.toString(
        'latin1'
      )
    ).toBe('\x1b[<0;20;10M')
    expect(
      encodeMouse({ kind: 'up', button: 'left', column: 19, row: 9, modifiers: MOD_NONE, encoding: 'sgr' })?.toString(
        'latin1'
      )
    ).toBe('\x1b[<0;20;10m')
    expect(
      encodeMouse({ kind: 'scrolldown', button: 'none', column: 0, row: 0, modifiers: MOD_NONE, encoding: 'sgr' })
        ?.toString('latin1')
    ).toBe('\x1b[<65;1;1M')
  })

  it('carries modifiers in the button byte', () => {
    const at = (modifiers: number): string | undefined =>
      encodeMouse({ kind: 'down', button: 'left', column: 0, row: 0, modifiers, encoding: 'sgr' })?.toString('latin1')
    expect(at(MOD_SHIFT)).toBe('\x1b[<4;1;1M')
    expect(at(MOD_ALT)).toBe('\x1b[<8;1;1M')
    expect(at(MOD_CTRL)).toBe('\x1b[<16;1;1M')
  })

  it('encodes X10 reports, and refuses coordinates it cannot express', () => {
    const near = encodeMouse({
      kind: 'down',
      button: 'left',
      column: 19,
      row: 9,
      modifiers: MOD_NONE,
      encoding: 'x10'
    })
    expect([...(near as Buffer)]).toEqual([0x1b, 0x5b, 0x4d, 32, 52, 42])
    // One byte per field means the encoding simply stops at 223.
    expect(
      encodeMouse({ kind: 'down', button: 'left', column: 400, row: 0, modifiers: MOD_NONE, encoding: 'x10' })
    ).toBeNull()
  })

  it('reports every X10 release as button 3, because the encoding cannot say which', () => {
    const up = encodeMouse({ kind: 'up', button: 'right', column: 0, row: 0, modifiers: MOD_NONE, encoding: 'x10' })
    expect((up as Buffer)[3]).toBe(3 + 32)
  })
})

describe('round trip (PHASE-3 criterion 4)', () => {
  /**
   * `encode(parse(bytes)) === bytes` for every sequence where a round trip is defined.
   *
   * It is not defined everywhere, and the exclusions are the interesting part: `ESC O A`
   * and `ESC [ A` parse to the same key, so only one can come back; `CSI 1 ~` and
   * `CSI 7 ~` are both Home. A round trip is defined for the form this encoder chooses,
   * which is the one the tables above pin down.
   */
  const protocols: ReadonlyArray<readonly [string, KeyboardProtocol]> = [
    ['legacy', legacy],
    ['kitty disambiguate', kitty(KITTY_DISAMBIGUATE_ESCAPE_CODES)],
    ['kitty all keys', kitty(KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_ALL_KEYS)]
  ]

  const legacyCorpus = [
    '\r', '\t', '\x1b', '\x7f', 'a', 'Z', '1',
    '\x01', '\x02', '\x1a', '\x1c', '\x1d', '\x1e', '\x1f',
    '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F',
    '\x1b[2~', '\x1b[3~', '\x1b[5~', '\x1b[6~',
    '\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS',
    '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~',
    '\x1b[1;3A', '\x1b[1;5C', '\x1b[1;2F', '\x1b[3;5~', '\x1b[5;3~', '\x1b[1;5P', '\x1b[15;2~',
    '\x1b[Z', '\x1ba', '\x1b\x7f', 'é', '世'
  ]

  it('round-trips the legacy corpus', () => {
    for (const sequence of legacyCorpus) {
      const parsed = parseKeySequence(Buffer.from(sequence, 'utf8'))
      expect(parsed, `parse ${JSON.stringify(sequence)}`).not.toBeNull()
      expect(encodeKey(parsed as NonNullable<typeof parsed>, legacy).toString('utf8'), sequence).toBe(sequence)
    }
  })

  it('round-trips CSI u under the flags that produce it', () => {
    const flags = KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_ALL_KEYS
    for (const sequence of ['\x1b[97;5u', '\x1b[108;6u', '\x1b[13;1u', '\x1b[57419;1u', '\x1b[97;1u']) {
      const parsed = parseKeySequence(Buffer.from(sequence, 'utf8'))
      expect(parsed, sequence).not.toBeNull()
      expect(encodeKey(parsed as NonNullable<typeof parsed>, kitty(flags)).toString('utf8'), sequence).toBe(sequence)
    }
  })

  it('round-trips an alternate-key report', () => {
    const flags = KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_ALTERNATE_KEYS | KITTY_REPORT_ALL_KEYS
    const sequence = '\x1b[49:33;2u'
    const parsed = parseKeySequence(Buffer.from(sequence, 'utf8'))
    expect(encodeKey(parsed as NonNullable<typeof parsed>, kitty(flags)).toString('utf8')).toBe(sequence)
  })

  it('round-trips every event type', () => {
    const flags = KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALL_KEYS
    for (const sequence of ['\x1b[97;1:1u', '\x1b[97;1:2u', '\x1b[97;1:3u']) {
      const parsed = parseKeySequence(Buffer.from(sequence, 'utf8'))
      expect(parsed, sequence).not.toBeNull()
      expect(encodeKey(parsed as NonNullable<typeof parsed>, kitty(flags)).toString('utf8'), sequence).toBe(sequence)
    }
  })

  it('round-trips modifyOtherKeys at level 2', () => {
    const level2: KeyboardProtocol = { ...LEGACY_PROTOCOL, modifyOtherKeys: 2 }
    for (const sequence of ['\x1b[27;5;99~', '\x1b[27;6;108~']) {
      const parsed = parseKeySequence(Buffer.from(sequence, 'utf8'))
      expect(parsed, sequence).not.toBeNull()
      expect(encodeKey(parsed as NonNullable<typeof parsed>, level2).toString('utf8'), sequence).toBe(sequence)
    }
  })

  it('round-trips SGR mouse reports', () => {
    for (const sequence of ['\x1b[<0;20;10M', '\x1b[<0;20;10m', '\x1b[<65;1;1M', '\x1b[<16;5;5M']) {
      const parsed = parseSgrMouse(Buffer.from(sequence, 'latin1'))
      expect(parsed, sequence).not.toBeNull()
      expect(encodeMouse(parsed as NonNullable<typeof parsed>)?.toString('latin1'), sequence).toBe(sequence)
    }
  })

  it('round-trips an X10 mouse report, high bytes included', () => {
    // Column 200 puts 0xE8 in the report. This is the case the byte path exists for.
    const original = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 200 + 33, 10 + 33])
    const parsed = parseX10Mouse(original)
    expect(parsed?.column).toBe(200)
    expect([...(encodeMouse(parsed as NonNullable<typeof parsed>) as Buffer)]).toEqual([...original])
  })

  it('names the sequences whose round trip is deliberately not defined', () => {
    // Two spellings, one key: the parser accepts both and the encoder picks one. Asserting
    // that here keeps a future "fix" from quietly changing which.
    for (const [alias, canonical] of [
      ['\x1bOA', '\x1b[A'],
      ['\x1b[1~', '\x1b[H'],
      ['\x1b[7~', '\x1b[H'],
      ['\x1b[4~', '\x1b[F'],
      ['\x1b[8~', '\x1b[F'],
      ['\x1b[11~', '\x1bOP']
    ] as const) {
      const parsed = parseKeySequence(Buffer.from(alias, 'utf8'))
      expect(encodeKey(parsed as NonNullable<typeof parsed>, legacy).toString('utf8'), alias).toBe(canonical)
    }
  })
})
