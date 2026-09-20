/**
 * Sequence -> Key.
 *
 * Ported from herdr's `src/input/parse.rs` (Apache-2.0, herdr 3f2a6e74): the three
 * parsers and their order, the kitty codepoint table, the xterm `1;<mod><final>` and
 * `<code>;<mod>~` forms, the legacy control-byte arithmetic, and the two normalizations
 * commented below that exist because of specific terminals.
 *
 * Order matters and is kitty, then modifyOtherKeys, then legacy. They overlap: `CSI 27 ;
 * 5 ; 99 ~` is only modifyOtherKeys, but `CSI 99 ; 5 u` is only kitty, and a legacy
 * `CSI A` must not be read as a truncated kitty sequence. Most specific first.
 *
 * Input is bytes throughout. Every sequence this file recognizes is ASCII, so it decodes
 * latin1 — one byte, one character — rather than UTF-8: that keeps an offset in the
 * decoded string equal to an offset in the buffer, and means a stray high byte inside a
 * malformed sequence fails the parse instead of becoming U+FFFD and accidentally passing.
 */

import {
  MOD_ALT,
  MOD_CTRL,
  MOD_NONE,
  MOD_SHIFT,
  charKey,
  fnKey,
  key,
  modifiersFromParam,
  type Key,
  type KeyEventKind,
  type KeyName,
  type MediaKeyName,
  type Modifiers,
  type ModifierKeyName
} from './model.js'

const ESC = '\x1b'

/** Parse one complete sequence, or null when it is not a key. */
export function parseKeySequence(bytes: Uint8Array): Key | null {
  const data = Buffer.from(bytes).toString('latin1')
  return parseKitty(data) ?? parseModifyOtherKeys(data) ?? parseLegacy(data, bytes)
}

// ---------------------------------------------------------------------------
// Kitty keyboard protocol: CSI <code>[:<shifted>[:<base>]] [;<mod>[:<event>]] [;<text>] u
// ---------------------------------------------------------------------------

export function parseKitty(data: string): Key | null {
  if (!data.startsWith(`${ESC}[`) || !data.endsWith('u')) return null
  const body = data.slice(2, -1)
  if (body.length === 0) return null

  const fields = body.split(';')
  if (fields.length > 3) return null
  const keyPart = fields[0] as string
  const modifierPart = fields[1] !== undefined && fields[1].length > 0 ? fields[1] : '1'
  const textPart = fields[2]

  const [modifierText, eventType] = splitModifierAndEvent(modifierPart)
  const modifierValue = parseUint(modifierText)
  if (modifierValue === null) return null

  const keyFields = keyPart.split(':')
  const codepoint = parseUint(keyFields[0] as string)
  if (codepoint === null) return null
  const shiftedRaw = keyFields[1] !== undefined && keyFields[1].length > 0 ? parseUint(keyFields[1]) : null
  if (keyFields[1] !== undefined && keyFields[1].length > 0 && shiftedRaw === null) return null

  const base = kittyCodepointToKey(codepoint)
  if (base === null) return null

  const kind = parseKittyEventType(eventType)
  if (kind === null) return null

  let text: string | null = null
  if (textPart !== undefined) {
    text = parseKittyAssociatedText(textPart)
    // WezTerm attaches the matching legacy control code as "associated text" in
    // report-all mode, which the kitty spec forbids. Keep the key, drop the field.
    if (text === null && !matchingControlAssociatedText(textPart, base)) return null
  }

  let modifiers = modifiersFromParam(modifierValue)
  const shiftedChar =
    shiftedRaw !== null && shiftedRaw !== codepoint ? safeFromCodePoint(shiftedRaw) : undefined

  // A shifted alternate is only meaningful while Shift is held. A terminal that reports
  // one without the Shift bit is contradicting itself; normalize rather than let the
  // contradiction dispatch an unshifted binding.
  if (base.name === 'char' && shiftedChar !== undefined) modifiers |= MOD_SHIFT

  return {
    ...base,
    modifiers,
    kind,
    ...(shiftedChar === undefined ? {} : { shiftedChar }),
    ...(text === null ? {} : { text })
  }
}

function parseKittyAssociatedText(value: string): string | null {
  let text = ''
  for (const part of value.split(':')) {
    const codepoint = parseUint(part)
    if (codepoint === null) return null
    const ch = safeFromCodePoint(codepoint)
    if (ch === undefined) return null
    // The spec forbids control characters here; a terminal sending one means something
    // other than "this keystroke produced text".
    const code = ch.codePointAt(0) as number
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return null
    text += ch
  }
  return text.length > 0 ? text : null
}

function matchingControlAssociatedText(value: string, base: Key): boolean {
  return (
    (base.name === 'enter' && value === '13') ||
    (base.name === 'backspace' && value === '8') ||
    (base.name === 'tab' && value === '9') ||
    (base.name === 'escape' && value === '27')
  )
}

function parseKittyEventType(value: string | undefined): KeyEventKind | null {
  switch (value ?? '1') {
    case '1':
      return 'press'
    case '2':
      return 'repeat'
    case '3':
      return 'release'
    default:
      return null
  }
}

const KITTY_MEDIA: ReadonlyArray<readonly [number, MediaKeyName]> = [
  [57428, 'play'],
  [57429, 'pause'],
  [57430, 'playpause'],
  [57431, 'reverse'],
  [57432, 'stop'],
  [57433, 'fastforward'],
  [57434, 'rewind'],
  [57435, 'tracknext'],
  [57436, 'trackprevious'],
  [57437, 'record'],
  [57438, 'lowervolume'],
  [57439, 'raisevolume'],
  [57440, 'mutevolume']
]

const KITTY_MODIFIER_KEYS: ReadonlyArray<readonly [number, ModifierKeyName]> = [
  [57441, 'leftshift'],
  [57442, 'leftcontrol'],
  [57443, 'leftalt'],
  [57444, 'leftsuper'],
  [57445, 'lefthyper'],
  [57446, 'leftmeta'],
  [57447, 'rightshift'],
  [57448, 'rightcontrol'],
  [57449, 'rightalt'],
  [57450, 'rightsuper'],
  [57451, 'righthyper'],
  [57452, 'rightmeta'],
  [57453, 'isolevel3shift'],
  [57454, 'isolevel5shift']
]

/** The keypad block, 57399..57417, which reports digits as their own codepoints. */
const KITTY_KEYPAD: ReadonlyArray<readonly [number, string]> = [
  [57399, '0'],
  [57400, '1'],
  [57401, '2'],
  [57402, '3'],
  [57403, '4'],
  [57404, '5'],
  [57405, '6'],
  [57406, '7'],
  [57407, '8'],
  [57408, '9'],
  [57409, '.'],
  [57410, '/'],
  [57411, '*'],
  [57412, '-'],
  [57413, '+'],
  [57415, '='],
  [57416, ',']
]

const KITTY_NAMED: ReadonlyArray<readonly [number, KeyName]> = [
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

/** herdr's `kitty_codepoint_to_keycode`. */
export function kittyCodepointToKey(codepoint: number): Key | null {
  switch (codepoint) {
    case 8:
    case 127:
      return key('backspace')
    case 9:
      return key('tab')
    case 13:
    case 57414:
      return key('enter')
    case 27:
      return key('escape')
    default:
      break
  }
  if (codepoint >= 57364 && codepoint <= 57375) return fnKey(codepoint - 57364 + 1)
  if (codepoint >= 57376 && codepoint <= 57398) return fnKey(codepoint - 57376 + 13)
  for (const [value, name] of KITTY_NAMED) if (value === codepoint) return key(name)
  for (const [value, char] of KITTY_KEYPAD) if (value === codepoint) return charKey(char)
  for (const [value, media] of KITTY_MEDIA) if (value === codepoint) return key('media', MOD_NONE, { media })
  for (const [value, name] of KITTY_MODIFIER_KEYS) {
    if (value === codepoint) return key('modifier', MOD_NONE, { modifierKey: name })
  }
  const char = safeFromCodePoint(codepoint)
  return char === undefined ? null : charKey(char)
}

// ---------------------------------------------------------------------------
// xterm modifyOtherKeys: CSI 27 ; <mod> ; <codepoint> ~
// ---------------------------------------------------------------------------

export function parseModifyOtherKeys(data: string): Key | null {
  if (!data.startsWith(`${ESC}[27;`) || !data.endsWith('~')) return null
  const body = data.slice(5, -1)
  const separator = body.indexOf(';')
  if (separator === -1) return null
  const modifierValue = parseUint(body.slice(0, separator))
  const codepoint = parseUint(body.slice(separator + 1))
  if (modifierValue === null || codepoint === null) return null
  const base = kittyCodepointToKey(codepoint)
  if (base === null) return null
  return { ...base, modifiers: modifiersFromParam(modifierValue) }
}

// ---------------------------------------------------------------------------
// Legacy
// ---------------------------------------------------------------------------

/** `ESC [ <final>` and `SS3 <final>` with no parameters, plus the `~` forms. */
const LEGACY_SPECIAL: ReadonlyArray<readonly [string, Key]> = [
  [`${ESC}${ESC}[A`, key('up', MOD_ALT)],
  [`${ESC}${ESC}[B`, key('down', MOD_ALT)],
  [`${ESC}${ESC}[C`, key('right', MOD_ALT)],
  [`${ESC}${ESC}[D`, key('left', MOD_ALT)],
  [`${ESC}[A`, key('up')],
  [`${ESC}OA`, key('up')],
  [`${ESC}[B`, key('down')],
  [`${ESC}OB`, key('down')],
  [`${ESC}[C`, key('right')],
  [`${ESC}OC`, key('right')],
  [`${ESC}[D`, key('left')],
  [`${ESC}OD`, key('left')],
  [`${ESC}[H`, key('home')],
  [`${ESC}OH`, key('home')],
  [`${ESC}[1~`, key('home')],
  [`${ESC}[7~`, key('home')],
  [`${ESC}[F`, key('end')],
  [`${ESC}OF`, key('end')],
  [`${ESC}[4~`, key('end')],
  [`${ESC}[8~`, key('end')],
  [`${ESC}[5~`, key('pageup')],
  [`${ESC}[6~`, key('pagedown')],
  [`${ESC}[2~`, key('insert')],
  [`${ESC}[3~`, key('delete')],
  // The application keypad, which sends SS3 rather than digits.
  [`${ESC}Op`, charKey('0')],
  [`${ESC}Oq`, charKey('1')],
  [`${ESC}Or`, charKey('2')],
  [`${ESC}Os`, charKey('3')],
  [`${ESC}Ot`, charKey('4')],
  [`${ESC}Ou`, charKey('5')],
  [`${ESC}Ov`, charKey('6')],
  [`${ESC}Ow`, charKey('7')],
  [`${ESC}Ox`, charKey('8')],
  [`${ESC}Oy`, charKey('9')],
  [`${ESC}On`, charKey('.')],
  [`${ESC}Ol`, charKey(',')],
  [`${ESC}Om`, charKey('-')],
  [`${ESC}Ok`, charKey('+')],
  [`${ESC}Oj`, charKey('*')],
  [`${ESC}Oo`, charKey('/')],
  [`${ESC}OM`, key('enter')],
  [`${ESC}OP`, fnKey(1)],
  [`${ESC}[11~`, fnKey(1)],
  [`${ESC}OQ`, fnKey(2)],
  [`${ESC}[12~`, fnKey(2)],
  [`${ESC}OR`, fnKey(3)],
  [`${ESC}[13~`, fnKey(3)],
  [`${ESC}OS`, fnKey(4)],
  [`${ESC}[14~`, fnKey(4)],
  [`${ESC}[15~`, fnKey(5)],
  [`${ESC}[17~`, fnKey(6)],
  [`${ESC}[18~`, fnKey(7)],
  [`${ESC}[19~`, fnKey(8)],
  [`${ESC}[20~`, fnKey(9)],
  [`${ESC}[21~`, fnKey(10)],
  [`${ESC}[23~`, fnKey(11)],
  [`${ESC}[24~`, fnKey(12)],
  [`${ESC}[Z`, key('backtab', MOD_SHIFT)]
]

const LEGACY_SPECIAL_MAP = new Map(LEGACY_SPECIAL)

/** `CSI 1 ; <mod> <final>` finals. */
const XTERM_FINALS: ReadonlyArray<readonly [string, KeyName]> = [
  ['A', 'up'],
  ['B', 'down'],
  ['C', 'right'],
  ['D', 'left'],
  ['H', 'home'],
  ['F', 'end']
]

/** `CSI <code> ; <mod> ~` codes. */
const XTERM_TILDE: ReadonlyArray<readonly [string, KeyName | number]> = [
  ['2', 'insert'],
  ['3', 'delete'],
  ['5', 'pageup'],
  ['6', 'pagedown'],
  ['11', 1],
  ['12', 2],
  ['13', 3],
  ['14', 4],
  ['15', 5],
  ['17', 6],
  ['18', 7],
  ['19', 8],
  ['20', 9],
  ['21', 10],
  ['23', 11],
  ['24', 12]
]

export function parseLegacy(data: string, bytes?: Uint8Array): Key | null {
  const special = LEGACY_SPECIAL_MAP.get(data)
  if (special) return special

  const modified = parseXtermModified(data)
  if (modified) return modified

  switch (data) {
    // In raw mode Enter is CR. A bare LF is deliberately *not* Enter: it is what Ctrl-J
    // and several Shift-Enter workarounds send, and it falls through to the control-byte
    // table below so those keep working.
    case '\r':
      return key('enter')
    case '\t':
      return key('tab')
    case ESC:
      return key('escape')
    case `${ESC}\x7f`:
      return key('backspace', MOD_ALT)
    case '\x7f':
      return key('backspace')
    default:
      break
  }

  if (data.startsWith(ESC) && data.length > 1) {
    // ESC + exactly one character is Alt+that character.
    const rest = data.slice(1)
    const restBytes = bytes === undefined ? undefined : bytes.subarray(1)
    const inner = countCharacters(rest, restBytes) === 1 ? parseLegacy(rest, restBytes) : null
    if (inner === null) return null
    return { ...inner, modifiers: inner.modifiers | MOD_ALT }
  }

  // Bytes that are not valid UTF-8 are not a character and must not be made into one.
  // `Buffer.toString('utf8')` answers U+FFFD for them, and returning that as a key would
  // put the replacement character into the pane — which is the exact corruption the byte
  // path exists to prevent. Refusing here sends the caller down the `unknown` path, which
  // forwards the original bytes untouched.
  if (bytes !== undefined && !isValidUtf8(bytes)) return null

  if (countCharacters(data, bytes) !== 1) return null

  // A single byte below 0x20 is a control chord; the arithmetic is the terminal's, not a
  // convention we are choosing.
  const code = data.codePointAt(0) as number
  const ctrl = parseLegacyCtrl(code)
  if (ctrl !== null) return ctrl

  // Decode as UTF-8 when the original bytes are available, so a multi-byte character
  // arrives as itself rather than as its latin1 shadow.
  const char = bytes === undefined ? data : Buffer.from(bytes).toString('utf8')
  const first = [...char][0]
  if (first === undefined) return null
  // An uppercase letter is Shift plus the *unshifted* codepoint, which is what
  // `Key.char` promises and what the kitty path already reports. Before this, legacy
  // said `{char: 'H', shift}` and kitty said `{char: 'h', shift, shiftedChar: 'H'}`,
  // so a binding on `H` fired under one protocol and not the other.
  if (first >= 'A' && first <= 'Z') {
    return charKey(first.toLowerCase(), MOD_SHIFT, { shiftedChar: first })
  }
  return charKey(first, MOD_NONE)
}

/** Does this byte sequence decode as UTF-8 and re-encode to exactly itself? */
function isValidUtf8(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes)
  return Buffer.compare(Buffer.from(buffer.toString('utf8'), 'utf8'), buffer) === 0
}

/** herdr's `parse_legacy_ctrl_char`. */
export function parseLegacyCtrl(code: number): Key | null {
  if (code === 0) return charKey(' ', MOD_CTRL)
  if (code >= 1 && code <= 26) return charKey(String.fromCharCode(code + 96), MOD_CTRL)
  switch (code) {
    case 27:
      return charKey('[', MOD_CTRL)
    case 28:
      return charKey('\\', MOD_CTRL)
    case 29:
      return charKey(']', MOD_CTRL)
    case 30:
      return charKey('^', MOD_CTRL)
    case 31:
      return charKey('_', MOD_CTRL)
    default:
      return null
  }
}

function parseXtermModified(data: string): Key | null {
  if (!data.startsWith(`${ESC}[`)) return null
  const body = data.slice(2)

  if (body.startsWith('1;')) {
    const final = body[body.length - 1]
    if (final !== undefined && /^[A-Za-z]$/u.test(final)) {
      const split = splitXtermModifierAndEvent(body.slice(2, -1))
      if (split === null) return null
      const [modifierText, eventType] = split
      const modifierValue = parseUint(modifierText)
      if (modifierValue === null) return null
      const kind = parseKittyEventType(eventType)
      if (kind === null) return null
      const named = XTERM_FINALS.find(([char]) => char === final)
      if (named) return { ...key(named[1]), modifiers: modifiersFromParam(modifierValue), kind }
      const fn = { P: 1, Q: 2, R: 3, S: 4 }[final]
      if (fn !== undefined) return { ...fnKey(fn), modifiers: modifiersFromParam(modifierValue), kind }
      return null
    }
  }

  if (!body.endsWith('~')) return null
  const tilde = body.slice(0, -1)
  const separator = tilde.indexOf(';')
  if (separator === -1) return null
  const split = splitXtermModifierAndEvent(tilde.slice(separator + 1))
  if (split === null) return null
  const [modifierText, eventType] = split
  const modifierValue = parseUint(modifierText)
  if (modifierValue === null) return null
  const kind = parseKittyEventType(eventType)
  if (kind === null) return null
  const entry = XTERM_TILDE.find(([code]) => code === tilde.slice(0, separator))
  if (!entry) return null
  const base = typeof entry[1] === 'number' ? fnKey(entry[1]) : key(entry[1])
  return { ...base, modifiers: modifiersFromParam(modifierValue), kind }
}

/**
 * Split `<mod>[:<event>][;<text>]`.
 *
 * The trailing text field is Alacritty on macOS reporting Cocoa function-key markers. The
 * sequence's final already says which key it was, so the field is validated and dropped
 * rather than trusted.
 */
function splitXtermModifierAndEvent(input: string): readonly [string, string | undefined] | null {
  const separator = input.indexOf(';')
  if (separator === -1) return splitModifierAndEvent(input)
  if (parseKittyAssociatedText(input.slice(separator + 1)) === null) return null
  return splitModifierAndEvent(input.slice(0, separator))
}

function splitModifierAndEvent(input: string): readonly [string, string | undefined] {
  const colon = input.indexOf(':')
  if (colon <= 0) return [input, undefined]
  return [input.slice(0, colon), input.slice(colon + 1)]
}

function parseUint(text: string): number | null {
  if (text.length === 0) return null
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x30 || code > 0x39) return null
  }
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) ? value : null
}

function safeFromCodePoint(codepoint: number): string | undefined {
  // Surrogates are not characters, and anything past the last plane is not a codepoint.
  if (codepoint < 0 || codepoint > 0x10ffff) return undefined
  if (codepoint >= 0xd800 && codepoint <= 0xdfff) return undefined
  return String.fromCodePoint(codepoint)
}

/** Characters (not code units) in `data`, decoding UTF-8 when the bytes are available. */
function countCharacters(data: string, bytes?: Uint8Array): number {
  if (bytes === undefined) return [...data].length
  return [...Buffer.from(bytes).toString('utf8')].length
}
