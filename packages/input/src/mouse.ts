/**
 * Mouse reports: SGR, SGR-pixel, and the original X10 encoding.
 *
 * Ported from herdr's `src/raw_input.rs` — `parse_mouse_cb`, `parse_sgr_mouse`,
 * `parse_default_mouse`, `plausible_sgr_mouse_prefix` and
 * `classify_sgr_mouse_continuation` (Apache-2.0, herdr 3f2a6e74). The button-bit
 * arithmetic and the extended-button-drag rule are herdr's; so is the 128-byte
 * continuation budget.
 *
 * Everything here takes bytes. The X10 encoding is why: it writes each coordinate as
 * `32 + value` in one byte, so a click in column 96 or beyond puts a byte above 0x7F in
 * the middle of the report. Decoding that as text destroys it.
 */

import {
  MOD_ALT,
  MOD_CTRL,
  MOD_NONE,
  MOD_SHIFT,
  type Modifiers,
  type MouseButton,
  type MouseEncoding,
  type MouseEvent,
  type MouseEventKind
} from './model.js'

/** herdr's `MAX_DISCARDED_CONTROL_TAIL_BYTES`. The budget for reassembling a split report. */
export const MAX_MOUSE_CONTINUATION_BYTES = 128

const ESC = 0x1b

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

/**
 * Decode a mouse button byte.
 *
 * The button number is bits 0-1 plus bits 6-7 shifted down, which is how the encoding
 * found room for buttons 8-11 without a new sequence. Bit 5 is "drag".
 */
export function parseMouseCb(cb: number): { kind: MouseEventKind; button: MouseButton; modifiers: Modifiers } | null {
  if (cb < 0 || cb > 0xff) return null
  const buttonNumber = (cb & 0b0000_0011) | ((cb & 0b1100_0000) >> 4)
  const dragging = (cb & 0b0010_0000) === 0b0010_0000

  let kind: MouseEventKind
  let button: MouseButton = 'none'
  switch (buttonNumber) {
    case 0:
      kind = dragging ? 'drag' : 'down'
      button = 'left'
      break
    case 1:
      kind = dragging ? 'drag' : 'down'
      button = 'middle'
      break
    case 2:
      kind = dragging ? 'drag' : 'down'
      button = 'right'
      break
    case 3:
      // Button 3 with no drag bit is the X10 "some button released" report, which does
      // not say which. Bare motion — the mouse moving with nothing held — is button 3
      // *with* the drag bit, and so are the extended buttons: herdr reports all of those
      // as motion rather than inventing a button, so a stuck one cannot suppress hover.
      if (dragging) {
        kind = 'move'
      } else {
        kind = 'up'
        button = 'left'
      }
      break
    case 4:
      if (dragging) {
        kind = 'move'
      } else {
        kind = 'scrollup'
      }
      break
    case 5:
      if (dragging) {
        kind = 'move'
      } else {
        kind = 'scrolldown'
      }
      break
    case 6:
      if (dragging) return null
      kind = 'scrollleft'
      break
    case 7:
      if (dragging) return null
      kind = 'scrollright'
      break
    case 8:
    case 9:
      if (!dragging) return null
      kind = 'move'
      break
    default:
      return null
  }

  let modifiers: Modifiers = MOD_NONE
  if ((cb & 0b0000_0100) !== 0) modifiers |= MOD_SHIFT
  if ((cb & 0b0000_1000) !== 0) modifiers |= MOD_ALT
  if ((cb & 0b0001_0000) !== 0) modifiers |= MOD_CTRL
  return { kind, button, modifiers }
}

/**
 * Parse `CSI < cb ; x ; y M|m`.
 *
 * A lowercase final means release, and it turns a `down` into an `up` — the SGR encoding
 * is the only one that says *which* button was released, which is why herdr prefers it
 * and why the X10 path below cannot do the same.
 *
 * `pixels` selects mode 1016, where x and y are pixels rather than cells. The caller
 * supplies the cell size, because only it knows the terminal's geometry.
 */
export function parseSgrMouse(
  bytes: Uint8Array,
  options: { readonly pixels?: boolean; readonly cellWidthPx?: number; readonly cellHeightPx?: number } = {}
): MouseEvent | null {
  if (bytes.length < 4 || bytes[0] !== ESC || bytes[1] !== 0x5b || bytes[2] !== 0x3c) return null
  const final = bytes[bytes.length - 1] as number
  if (final !== 0x4d && final !== 0x6d) return null

  const body = Buffer.from(bytes.subarray(3, bytes.length - 1)).toString('latin1')
  const parts = body.split(';')
  if (parts.length !== 3) return null
  const cb = parseUint(parts[0] as string, 0xff)
  const x = parseUint(parts[1] as string, 0xffff)
  const y = parseUint(parts[2] as string, 0xffff)
  if (cb === null || x === null || y === null || x < 1 || y < 1) return null

  const decoded = parseMouseCb(cb)
  if (decoded === null) return null

  let { kind } = decoded
  if (final === 0x6d && kind === 'down') kind = 'up'

  const pixels = options.pixels === true
  const cellWidth = Math.max(1, options.cellWidthPx ?? 1)
  const cellHeight = Math.max(1, options.cellHeightPx ?? 1)
  const column = pixels ? Math.floor((x - 1) / cellWidth) : x - 1
  const row = pixels ? Math.floor((y - 1) / cellHeight) : y - 1

  const encoding: MouseEncoding = pixels ? 'sgr-pixels' : 'sgr'
  return {
    kind,
    button: decoded.button,
    column,
    row,
    modifiers: decoded.modifiers,
    encoding,
    ...(pixels ? { pixel: { x, y } } : {})
  }
}

/**
 * Parse the original `CSI M Cb Cx Cy`.
 *
 * Each field is `32 + value`, and the coordinates are additionally one-based, hence the
 * 33. The encoding cannot express a coordinate past 223 — the byte would exceed 255 —
 * which is why SGR exists; a terminal that still sends this simply cannot report a click
 * in column 224.
 */
export function parseX10Mouse(bytes: Uint8Array): MouseEvent | null {
  if (bytes.length !== 6) return null
  if (bytes[0] !== ESC || bytes[1] !== 0x5b || bytes[2] !== 0x4d) return null
  const cb = (bytes[3] as number) - 32
  const column = (bytes[4] as number) - 33
  const row = (bytes[5] as number) - 33
  if (cb < 0 || column < 0 || row < 0) return null
  const decoded = parseMouseCb(cb)
  if (decoded === null) return null
  return {
    kind: decoded.kind,
    button: decoded.button,
    column,
    row,
    modifiers: decoded.modifiers,
    encoding: 'x10'
  }
}

function parseUint(text: string, max: number): number | null {
  if (text.length === 0) return null
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x30 || code > 0x39) return null
  }
  const value = Number.parseInt(text, 10)
  return Number.isFinite(value) && value <= max ? value : null
}

/**
 * Could these bytes still become a valid SGR report?
 *
 * herdr's `plausible_sgr_mouse_prefix`. It rejects impossible continuations early without
 * loosening the real parser: at most three fields, digits only, a button that decodes,
 * and a non-zero coordinate once the field is closed. A *partial* last field — including
 * a bare `0` that will become `10` — is still plausible, which is the subtle half.
 */
export function plausibleSgrMousePrefix(report: Uint8Array): boolean {
  if (report.length < 3 || report[0] !== ESC || report[1] !== 0x5b || report[2] !== 0x3c) return false
  const body = report.subarray(3)

  const fields: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x3b) {
      fields.push(body.subarray(start, i))
      start = i + 1
    }
  }
  fields.push(body.subarray(start))

  for (let index = 0; index < fields.length; index++) {
    if (index > 2) return false
    const digits = fields[index] as Uint8Array
    const isLast = index === fields.length - 1
    // An empty field is only plausible as the one still being typed.
    if (digits.length === 0) return isLast
    for (let i = 0; i < digits.length; i++) {
      if (!isDigit(digits[i] as number)) return false
    }
    const value = Number.parseInt(Buffer.from(digits).toString('latin1'), 10)
    if (!Number.isFinite(value) || value > 0xffff) return false
    if (index === 0 && value > 0xff) return false
    if (!isLast) {
      if (index === 0 && parseMouseCb(value) === null) return false
      if (index === 1 && value === 0) return false
    }
  }
  return true
}

export type SgrMouseContinuation =
  /** More bytes could still complete it. Keep holding. */
  | { readonly kind: 'incomplete' }
  /** It completed. `length` bytes of the tail belong to the report — and are discarded. */
  | { readonly kind: 'complete'; readonly length: number }
  /** It cannot be a report. Release the tail as ordinary input. */
  | { readonly kind: 'invalid' }

/**
 * Decide what a retained mouse prefix's continuation turned out to be.
 *
 * herdr's `classify_sgr_mouse_continuation`, and the reason a truncated report is never
 * typed into the user's shell. Note that a *completed* late report is discarded rather
 * than delivered: by the time the tail arrives the click is stale, and a stale click at
 * whatever coordinates the report happens to name is worse than no click at all. What
 * matters is that the bytes do not become text.
 */
export function classifySgrMouseContinuation(prefix: Uint8Array, tail: Uint8Array): SgrMouseContinuation {
  const remaining = Math.max(0, MAX_MOUSE_CONTINUATION_BYTES - prefix.length)
  const limited = tail.subarray(0, Math.min(tail.length, remaining))

  let finalIndex = -1
  for (let i = 0; i < limited.length; i++) {
    const byte = limited[i] as number
    if (!isDigit(byte) && byte !== 0x3b) {
      finalIndex = i
      break
    }
  }
  const payloadLen = finalIndex === -1 ? limited.length : finalIndex
  const report = Buffer.concat([Buffer.from(prefix), Buffer.from(limited.subarray(0, payloadLen))])
  if (!plausibleSgrMousePrefix(report)) return { kind: 'invalid' }

  if (finalIndex !== -1) {
    const whole = Buffer.concat([report, Buffer.from([limited[finalIndex] as number])])
    return parseSgrMouse(whole) !== null ? { kind: 'complete', length: finalIndex + 1 } : { kind: 'invalid' }
  }
  return report.length >= MAX_MOUSE_CONTINUATION_BYTES ? { kind: 'invalid' } : { kind: 'incomplete' }
}
