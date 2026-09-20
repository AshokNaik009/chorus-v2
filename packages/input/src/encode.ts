/**
 * Key -> bytes, for the pane's negotiated protocol.
 *
 * Ported from herdr's `src/input/encode.rs` (Apache-2.0, herdr 3f2a6e74): the CSI-u
 * decision tree, the xterm modified-special table, the control-byte arithmetic, the
 * shifted-punctuation set, and the release-event rule.
 *
 * `protocol` is a parameter, never ambient state. Two panes side by side can run
 * different keyboard protocols, and the only thing that makes that work is that this
 * function reads the protocol it is handed and keeps nothing.
 *
 * ## The order, which is not obvious
 *
 * 1. A release event produces nothing at all unless the pane asked for event types.
 *    Otherwise Enter would arrive twice: once on press, once on release.
 * 2. If the terminal told us what text the keystroke produced, that text wins — unless
 *    the pane asked for all keys, which means it wants the physical key, not its text.
 *    The layout knows things this code cannot: on AZERTY, Shift+& is `1`.
 * 3. CSI-u, when the pane speaks kitty and the key needs it.
 * 4. Legacy, which is what almost everything actually gets.
 */

import {
  KITTY_REPORT_ALL_KEYS,
  KITTY_REPORT_ALTERNATE_KEYS,
  KITTY_REPORT_ASSOCIATED_TEXT,
  KITTY_REPORT_EVENT_TYPES,
  MOD_ALT,
  MOD_CTRL,
  MOD_HYPER,
  MOD_META,
  MOD_NONE,
  MOD_SHIFT,
  MOD_SUPER,
  hasModifier,
  reportsAllKeys,
  reportsEventTypes,
  type Key,
  type KeyboardProtocol,
  type Modifiers,
  type MouseEncoding,
  type MouseEvent
} from './model.js'

const EMPTY = Buffer.alloc(0)

/** Encode one key for a pane. An empty buffer means "send nothing", which is a real answer. */
export function encodeKey(key: Key, protocol: KeyboardProtocol): Buffer {
  // A release only produces bytes when the pane asked for event types. Without this,
  // every keystroke arrives twice in a pane that happens to receive release events.
  if (key.kind === 'release' && !reportsEventTypes(protocol)) return EMPTY

  const preferPhysical = reportsAllKeys(protocol)

  // REPORT_ALL_KEYS means the pane wants the key, not the text it produced.
  if (!preferPhysical && key.kind !== 'release' && key.text !== undefined) {
    return Buffer.from(key.text, 'utf8')
  }

  const kittyFirst = preferPhysical || (key.kind === 'release' && reportsEventTypes(protocol))
  if (kittyFirst && protocol.kittyFlags !== 0) {
    const bytes = tryEncodeCsiU(key, protocol.kittyFlags)
    if (bytes !== null) return bytes
  }

  const text = textForKey(key)
  if (text !== null) return Buffer.from(text, 'utf8')

  if (!kittyFirst && protocol.kittyFlags !== 0) {
    const bytes = tryEncodeCsiU(key, protocol.kittyFlags)
    if (bytes !== null) return bytes
  }

  // A release that got this far has nothing legacy to say.
  if (key.kind === 'release') return EMPTY

  // modifyOtherKeys level 2 asks for `CSI 27 ; mod ; codepoint ~` for anything a legacy
  // encoding would flatten. Level 1 only covers what legacy cannot express at all, which
  // the legacy encoder already falls through on, so it is left alone here.
  if (protocol.modifyOtherKeys === 2 && protocol.kittyFlags === 0) {
    const bytes = tryEncodeModifyOtherKeys(key)
    if (bytes !== null) return bytes
  }

  return encodeLegacy(key, protocol)
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** The character this key commits as text, or null when it commits none. */
function textForKey(key: Key): string | null {
  if (key.kind === 'release') return null
  if (key.name !== 'char' || key.char === undefined) return null
  const meaningful = key.modifiers & (MOD_CTRL | MOD_ALT | MOD_SUPER | MOD_HYPER | MOD_META)
  if (meaningful !== 0) return null
  if ((key.modifiers & MOD_SHIFT) === 0) return key.char
  return shiftedTextChar(key)
}

/**
 * What Shift+key commits.
 *
 * The terminal's own answer first: `shiftedChar` came from the layout, and no rule here
 * would know that Shift+2 is `"` on a German keyboard. Only when there is none does this
 * fall back to ASCII case folding, which is right for the layouts that have no opinion.
 */
function shiftedTextChar(key: Key): string | null {
  if (key.shiftedChar !== undefined) return key.shiftedChar
  const ch = key.char
  if (ch === undefined) return null
  if (ch >= 'A' && ch <= 'Z') return ch
  if (ch >= 'a' && ch <= 'z') return ch.toUpperCase()
  return SHIFTED_ASCII_PUNCTUATION.has(ch) ? ch : null
}

/** Characters that are already the shifted form of something on a US layout. */
const SHIFTED_ASCII_PUNCTUATION = new Set([
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '_', '+', '{', '}', '|', ':', '"', '<', '>', '?', '~'
])

// ---------------------------------------------------------------------------
// Modifier parameters
// ---------------------------------------------------------------------------

/** xterm's `1 + shift + alt*2 + ctrl*4`. */
export function xtermModifier(modifiers: Modifiers): number {
  let value = 1
  if (hasModifier(modifiers, MOD_SHIFT)) value += 1
  if (hasModifier(modifiers, MOD_ALT)) value += 2
  if (hasModifier(modifiers, MOD_CTRL)) value += 4
  return value
}

/** Kitty's, a superset: xterm's plus super, hyper and meta. */
export function kittyModifier(modifiers: Modifiers): number {
  let value = xtermModifier(modifiers)
  if (hasModifier(modifiers, MOD_SUPER)) value += 8
  if (hasModifier(modifiers, MOD_HYPER)) value += 16
  if (hasModifier(modifiers, MOD_META)) value += 32
  return value
}

// ---------------------------------------------------------------------------
// CSI u
// ---------------------------------------------------------------------------

/** Kitty codepoints for the functional keys that have one. */
const CSI_U_CODEPOINTS: Partial<Record<string, number>> = {
  enter: 13,
  tab: 9,
  backspace: 127,
  escape: 27,
  left: 57417,
  right: 57418,
  up: 57419,
  down: 57420,
  pageup: 57421,
  pagedown: 57422,
  home: 57423,
  end: 57424,
  insert: 57425,
  delete: 57426
}

/** Keys with a universally understood legacy modified form, so CSI-u is not needed. */
const HAS_LEGACY_MODIFIED_FORM = new Set([
  'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'insert', 'delete', 'f'
])

function tryEncodeCsiU(key: Key, flags: number): Buffer | null {
  const eventSuffix = kittyEventSuffix(key, flags)
  const reportAll = (flags & KITTY_REPORT_ALL_KEYS) !== 0
  const bare = key.modifiers === MOD_NONE

  // Enter, Tab and Backspace unmodified are a single byte everywhere; sending CSI-u for
  // them breaks programs that read one byte and expect a key.
  if (!reportAll && bare && (key.name === 'enter' || key.name === 'tab' || key.name === 'backspace')) {
    return null
  }
  if (bare && eventSuffix === null && !reportAll) return null

  // Arrows and function keys have legacy modified forms that every program understands —
  // Ghostty itself still sends those with kitty mode on. Only reach for CSI-u when the
  // pane asked for all keys or an event type has to ride along.
  if (HAS_LEGACY_MODIFIED_FORM.has(key.name) && eventSuffix === null && !reportAll) return null

  let codepoint: number
  let alternate: number | null = null
  if (key.name === 'char') {
    const ch = key.char
    if (ch === undefined) return null
    codepoint = canonicalKittyChar(ch, key.modifiers).codePointAt(0) as number
    alternate = alternateShiftedCodepoint(key, flags)
  } else {
    const mapped = CSI_U_CODEPOINTS[key.name]
    if (mapped === undefined) return null
    codepoint = mapped
  }

  let sequence = `\x1b[${codepoint}`
  if (alternate !== null) sequence += `:${alternate}`
  sequence += `;${kittyModifier(key.modifiers)}`
  if (eventSuffix !== null) sequence += `:${eventSuffix}`
  if ((flags & KITTY_REPORT_ASSOCIATED_TEXT) !== 0) {
    const text = textForKey(key)
    if (text !== null) {
      const code = text.codePointAt(0)
      // Control characters are forbidden in the associated-text field.
      if (code !== undefined && code >= 0x20 && !(code >= 0x7f && code < 0xa0)) {
        sequence += `;${code}`
      }
    }
  }
  return Buffer.from(`${sequence}u`, 'utf8')
}

/**
 * The codepoint kitty wants for a character key: the *unshifted* one.
 *
 * `Shift+L` is reported as `l` with the Shift bit, not as `L`. Sending `L` with a Shift
 * bit would be read as Shift+Shift+L.
 */
function canonicalKittyChar(ch: string, modifiers: Modifiers): string {
  if (hasModifier(modifiers, MOD_SHIFT) && ch >= 'A' && ch <= 'Z') return ch.toLowerCase()
  return ch
}

function alternateShiftedCodepoint(key: Key, flags: number): number | null {
  if ((flags & KITTY_REPORT_ALTERNATE_KEYS) === 0) return null
  if (key.shiftedChar !== undefined) return key.shiftedChar.codePointAt(0) ?? null
  const ch = key.char
  if (ch !== undefined && hasModifier(key.modifiers, MOD_SHIFT) && ch >= 'A' && ch <= 'Z') {
    return ch.codePointAt(0) ?? null
  }
  return null
}

function kittyEventSuffix(key: Key, flags: number): number | null {
  if ((flags & KITTY_REPORT_EVENT_TYPES) === 0) return null
  return key.kind === 'press' ? 1 : key.kind === 'repeat' ? 2 : 3
}

// ---------------------------------------------------------------------------
// modifyOtherKeys
// ---------------------------------------------------------------------------

function tryEncodeModifyOtherKeys(key: Key): Buffer | null {
  if (key.name !== 'char' || key.char === undefined) return null
  if (key.modifiers === MOD_NONE) return null
  // Shift alone is text, not a chord: it has a legacy encoding and should keep it.
  if ((key.modifiers & ~MOD_SHIFT) === 0) return null
  const codepoint = canonicalKittyChar(key.char, key.modifiers).codePointAt(0)
  if (codepoint === undefined) return null
  return Buffer.from(`\x1b[27;${kittyModifier(key.modifiers)};${codepoint}~`, 'utf8')
}

// ---------------------------------------------------------------------------
// Legacy
// ---------------------------------------------------------------------------

/** herdr's `encode_modified_special`: the xterm forms for modified navigation keys. */
function encodeModifiedSpecial(key: Key): Buffer | null {
  const modifier = xtermModifier(key.modifiers)
  if (modifier <= 1) return null

  const csiLetter: Partial<Record<string, string>> = {
    up: 'A',
    down: 'B',
    right: 'C',
    left: 'D',
    home: 'H',
    end: 'F'
  }
  const letter = csiLetter[key.name]
  if (letter !== undefined) return Buffer.from(`\x1b[1;${modifier}${letter}`, 'utf8')

  const tildeCode: Partial<Record<string, number>> = { insert: 2, delete: 3, pageup: 5, pagedown: 6 }
  const code = tildeCode[key.name]
  if (code !== undefined) return Buffer.from(`\x1b[${code};${modifier}~`, 'utf8')

  if (key.name === 'f' && key.fn !== undefined) {
    if (key.fn >= 1 && key.fn <= 4) {
      return Buffer.from(`\x1b[1;${modifier}${'PQRS'[key.fn - 1] as string}`, 'utf8')
    }
    const tilde = F_KEY_TILDE_CODES[key.fn]
    if (tilde !== undefined) return Buffer.from(`\x1b[${tilde};${modifier}~`, 'utf8')
  }
  return null
}

const F_KEY_TILDE_CODES: Partial<Record<number, number>> = {
  5: 15,
  6: 17,
  7: 18,
  8: 19,
  9: 20,
  10: 21,
  11: 23,
  12: 24
}

function encodeLegacy(key: Key, protocol: KeyboardProtocol): Buffer {
  if (key.modifiers !== MOD_NONE) {
    const special = encodeModifiedSpecial(key)
    if (special !== null) return special
  }

  // Alt on a character key is the ESC prefix. There is no other legacy encoding for it,
  // which is also why a lone ESC is ambiguous in the first place.
  if (hasModifier(key.modifiers, MOD_ALT)) {
    const inner = encodeLegacyInner({ ...key, modifiers: key.modifiers & ~MOD_ALT }, protocol)
    return Buffer.concat([Buffer.from([0x1b]), inner])
  }
  return encodeLegacyInner(key, protocol)
}

/** Ctrl chords that are not `letter - 64`. herdr's table, including the digit aliases. */
const CTRL_BYTES: Partial<Record<string, number>> = {
  ' ': 0,
  '@': 0,
  '2': 0,
  '[': 27,
  '3': 27,
  '\\': 28,
  '4': 28,
  ']': 29,
  '5': 29,
  '^': 30,
  '6': 30,
  _: 31,
  '/': 31,
  '7': 31,
  '-': 31
}

function encodeLegacyInner(key: Key, protocol: KeyboardProtocol): Buffer {
  switch (key.name) {
    case 'char': {
      const ch = key.char
      if (ch === undefined) return EMPTY
      if (hasModifier(key.modifiers, MOD_CTRL)) {
        const upper = ch.toUpperCase()
        if (upper >= 'A' && upper <= 'Z') return Buffer.from([(upper.codePointAt(0) as number) - 64])
        const mapped = CTRL_BYTES[upper]
        if (mapped !== undefined) return Buffer.from([mapped])
        return Buffer.from(ch, 'utf8')
      }
      const shifted = key.modifiers === MOD_SHIFT ? (shiftedTextChar(key) ?? ch) : ch
      return Buffer.from(shifted, 'utf8')
    }
    case 'enter':
      return Buffer.from([0x0d])
    case 'backspace':
      return Buffer.from([0x7f])
    case 'tab':
      return Buffer.from([0x09])
    case 'backtab':
      return Buffer.from('\x1b[Z', 'utf8')
    case 'escape':
      return Buffer.from([0x1b])
    // DECCKM: while the pane has application cursor keys on, arrows and Home/End are SS3.
    // This is pane state, which is why it rides in on the protocol rather than a global.
    case 'up':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOA' : '\x1b[A', 'utf8')
    case 'down':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOB' : '\x1b[B', 'utf8')
    case 'right':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOC' : '\x1b[C', 'utf8')
    case 'left':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOD' : '\x1b[D', 'utf8')
    case 'home':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOH' : '\x1b[H', 'utf8')
    case 'end':
      return Buffer.from(protocol.applicationCursorKeys ? '\x1bOF' : '\x1b[F', 'utf8')
    case 'pageup':
      return Buffer.from('\x1b[5~', 'utf8')
    case 'pagedown':
      return Buffer.from('\x1b[6~', 'utf8')
    case 'delete':
      return Buffer.from('\x1b[3~', 'utf8')
    case 'insert':
      return Buffer.from('\x1b[2~', 'utf8')
    case 'f':
      return key.fn === undefined ? EMPTY : encodeFKey(key.fn)
    default:
      // Media keys, modifier keys and anything this build does not model have no legacy
      // encoding. Sending nothing is correct; inventing bytes is not.
      return EMPTY
  }
}

function encodeFKey(n: number): Buffer {
  if (n >= 1 && n <= 4) return Buffer.from(`\x1bO${'PQRS'[n - 1] as string}`, 'utf8')
  const tilde = F_KEY_TILDE_CODES[n]
  if (tilde !== undefined) return Buffer.from(`\x1b[${tilde}~`, 'utf8')
  return EMPTY
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

/**
 * Re-encode a mouse event for a pane.
 *
 * The button byte is rebuilt rather than copied, because the coordinates change: a click
 * at screen column 40 is column 12 inside a pane whose border starts at 28.
 */
export function encodeMouse(event: MouseEvent, encoding: MouseEncoding = event.encoding): Buffer | null {
  let cb: number
  let release = false
  switch (event.kind) {
    case 'down':
      cb = buttonBase(event.button)
      break
    case 'up':
      cb = buttonBase(event.button)
      release = true
      break
    case 'drag':
      cb = buttonBase(event.button) + 32
      break
    case 'move':
      cb = 35 // button 3 with the drag bit: motion with nothing held
      break
    case 'scrollup':
      cb = 64
      break
    case 'scrolldown':
      cb = 65
      break
    case 'scrollleft':
      cb = 66
      break
    case 'scrollright':
      cb = 67
      break
    default:
      return null
  }
  if (cb < 0) return null

  if (hasModifier(event.modifiers, MOD_SHIFT)) cb += 4
  if (hasModifier(event.modifiers, MOD_ALT)) cb += 8
  if (hasModifier(event.modifiers, MOD_CTRL)) cb += 16

  const column = event.column + 1
  const row = event.row + 1

  if (encoding === 'sgr' || encoding === 'sgr-pixels') {
    // SGR states the button on release, so it does not need the `3` sentinel below.
    return Buffer.from(`\x1b[<${cb};${column};${row}${release ? 'm' : 'M'}`, 'utf8')
  }

  // X10 has no way to say which button was released, so every release is button 3.
  const legacyCb = release ? 3 + (cb & ~0b11) : cb
  const encodedCb = legacyCb + 32
  const encodedColumn = column + 32
  const encodedRow = row + 32
  // Each field is one byte, so the encoding simply cannot express a coordinate past 223.
  if (encodedCb > 0xff || encodedColumn > 0xff || encodedRow > 0xff) return null
  return Buffer.from([0x1b, 0x5b, 0x4d, encodedCb, encodedColumn, encodedRow])
}

function buttonBase(button: MouseEvent['button']): number {
  switch (button) {
    case 'left':
      return 0
    case 'middle':
      return 1
    case 'right':
      return 2
    default:
      return 3
  }
}

/** Wrap text as a bracketed paste, for a pane that turned the mode on. */
export function encodeBracketedPaste(data: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from('\x1b[200~', 'latin1'), Buffer.from(data), Buffer.from('\x1b[201~', 'latin1')])
}
