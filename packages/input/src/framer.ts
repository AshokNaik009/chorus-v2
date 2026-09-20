/**
 * Byte stream -> complete sequences.
 *
 * Ported from herdr's `src/raw_input.rs` (Apache-2.0, herdr 3f2a6e74): the sequence
 * lengths, the doubled-escape disambiguation, the orphaned-mouse-tail recovery and its
 * 32-byte cap, and the rule that idle is not evidence a report ended.
 *
 * ## The one hard problem
 *
 * A terminal hands us bytes with no framing. `ESC` may be the Escape key, or the first
 * byte of a sequence whose remainder has not arrived yet, and nothing in the stream says
 * which. Every other difficulty here is a variation on that.
 *
 * The framer therefore has two entry points, and the difference between them matters:
 *
 * - `push(bytes)` returns every sequence it can prove is complete, and holds the rest.
 * - `flushIdle()` says "no more bytes came". *That* is what resolves a lone `ESC` into
 *   the Escape key.
 *
 * Idle resolves an escape. Idle does **not** resolve a truncated mouse report: a
 * half-delivered `CSI < 0 ; 3 ; 4` flushed as text types `[<0;3;4` into the user's
 * shell. herdr keeps the prefix instead, caps recovery at 32 bytes, and drops it if the
 * rest never arrives — which is what `orphanedTail` below does.
 */

import {
  MAX_MOUSE_CONTINUATION_BYTES,
  classifySgrMouseContinuation,
  plausibleSgrMousePrefix
} from './mouse.js'

const ESC = 0x1b

/** `CSI 200 ~` .. `CSI 201 ~`. */
export const PASTE_START = Buffer.from('\x1b[200~', 'latin1')
export const PASTE_END = Buffer.from('\x1b[201~', 'latin1')

/**
 * How long to wait before deciding a lone `ESC` was the Escape key.
 *
 * herdr uses 10 ms. It is a trade in one direction only: too short and a slow terminal's
 * arrow key becomes Escape followed by `[A`; too long and Escape feels laggy. 10 ms is
 * far longer than a local terminal's inter-byte gap and far shorter than a human's.
 */
export const IDLE_FLUSH_TIMEOUT_MS = 10

/**
 * The longer window used while a mouse sequence is in flight.
 *
 * A drag generates reports back to back, and a report split across two reads is normal.
 * herdr's `MOUSE_ACTIVE_ESCAPE_SEQUENCE_FLUSH_TIMEOUT_MS`.
 */
export const MOUSE_ACTIVE_FLUSH_TIMEOUT_MS = 150

/** herdr's `MAX_ORPHANED_SGR_MOUSE_TAIL_BYTES`. Past this, the tail is not a report. */
export const MAX_ORPHANED_SGR_MOUSE_TAIL_BYTES = 32

/** CSI final bytes, per ECMA-48: 0x40..0x7E. */
const CSI_FINALS = '@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'

function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39
}

/** Bytes a UTF-8 character starting with `first` occupies, or null if it is not a lead. */
export function utf8CharWidth(first: number): number | null {
  if (first < 0x80) return 1
  if ((first & 0b1110_0000) === 0b1100_0000) return 2
  if ((first & 0b1111_0000) === 0b1110_0000) return 3
  if ((first & 0b1111_1000) === 0b1111_0000) return 4
  return null
}

/**
 * Length of the complete UTF-8 character at the head of `buffer`, or null.
 *
 * Null means two different things and the caller has to tell them apart: a truncated
 * character that more bytes would complete, and a byte that can never start one. The
 * second is not an error — a legacy mouse coordinate is exactly that — so the framer
 * emits it as a single byte rather than waiting forever.
 */
export function firstUtf8CharLen(buffer: Buffer): number | null {
  const first = buffer[0]
  if (first === undefined) return null
  const width = utf8CharWidth(first)
  if (width === null) return null
  if (buffer.length < width) return null
  // The continuation bytes have to actually be continuations, or this is not a character
  // however promising its lead byte looked.
  for (let i = 1; i < width; i++) {
    if (((buffer[i] as number) & 0b1100_0000) !== 0b1000_0000) return null
  }
  return width
}

/** True when `buffer` is the start of a UTF-8 character that more bytes would complete. */
export function startsWithIncompleteUtf8(buffer: Buffer): boolean {
  const first = buffer[0]
  if (first === undefined) return false
  const width = utf8CharWidth(first)
  if (width === null || width === 1) return false
  if (buffer.length >= width) return false
  for (let i = 1; i < buffer.length; i++) {
    if (((buffer[i] as number) & 0b1100_0000) !== 0b1000_0000) return false
  }
  return true
}

/** Index just past the first CSI final byte in `finals`, or null. */
function findCsiFinal(buffer: Buffer, finals: string, from = 2): number | null {
  for (let i = from; i < buffer.length; i++) {
    if (finals.includes(String.fromCharCode(buffer[i] as number))) return i + 1
  }
  return null
}

type ControlStringFamily = 'osc' | 'st'

function controlStringFamily(buffer: Buffer): ControlStringFamily | null {
  if (buffer.length < 2 || buffer[0] !== ESC) return null
  switch (buffer[1]) {
    case 0x5d: // ESC ]  OSC
      return 'osc'
    case 0x50: // ESC P  DCS
    case 0x5f: // ESC _  APC
    case 0x5e: // ESC ^  PM
    case 0x58: // ESC X  SOS
      return 'st'
    default:
      return null
  }
}

/**
 * Where a control string ends, or null while it is still open.
 *
 * OSC accepts BEL as well as ST, because xterm always has and half the world's terminals
 * rely on it. ST is `ESC \`.
 */
function controlStringLen(buffer: Buffer, family: ControlStringFamily): number | null {
  for (let i = 2; i < buffer.length; i++) {
    const byte = buffer[i] as number
    if (family === 'osc' && byte === 0x07) return i + 1
    if (byte === ESC && buffer[i + 1] === 0x5c) return i + 2
  }
  return null
}

const PREFIX_SGR = Buffer.from('\x1b[<', 'latin1')
const PREFIX_X10 = Buffer.from('\x1b[M', 'latin1')

/**
 * True when `buffer` is a truncated SGR mouse report that more bytes could complete.
 *
 * The whole three-byte introducer has to be present, exactly as in herdr. Accepting a
 * prefix of it instead looks more thorough and is wrong: a bare `ESC` is a prefix of
 * `ESC [ <`, so a lone Escape keypress would be mistaken for a mouse report in flight and
 * retained forever instead of being flushed as the Escape key.
 */
export function startsWithIncompleteSgrMouse(buffer: Buffer): boolean {
  if (buffer.length < 3 || !buffer.subarray(0, 3).equals(PREFIX_SGR)) return false
  for (let i = 3; i < buffer.length; i++) {
    const byte = buffer[i] as number
    if (!isDigit(byte) && byte !== 0x3b) return false
  }
  return true
}

/** True when `buffer` is a truncated legacy `CSI M Cb Cx Cy` report. Same rule as above. */
export function startsWithIncompleteX10Mouse(buffer: Buffer): boolean {
  return buffer.length >= 3 && buffer.length < 6 && buffer.subarray(0, 3).equals(PREFIX_X10)
}

/**
 * Length of the complete escape sequence at the head of `buffer`, or null if it is not
 * complete yet.
 *
 * herdr's `complete_escape_sequence_len`, including the two doubled-escape cases at the
 * top — those exist because `ESC ESC [ < ...` is Alt pressed *during* a mouse report, and
 * the right answer is to emit the bare `ESC` and let the mouse report frame itself on the
 * next pass rather than swallow it into an eight-byte "Alt+something".
 */
export function completeEscapeSequenceLen(buffer: Buffer): number | null {
  if (buffer.length <= 1) return null

  if (buffer.length >= 4 && buffer[0] === ESC && buffer.subarray(1, 4).equals(PREFIX_SGR)) {
    // A doubled escape in front of an SGR mouse report: yield just the ESC.
    if (findCsiFinal(buffer.subarray(1), 'Mm') !== null) return 1
  }
  if (buffer.length >= 7 && buffer[0] === ESC && buffer.subarray(1, 4).equals(PREFIX_X10)) {
    return 1
  }
  if (buffer[1] === ESC) {
    const inner = completeEscapeSequenceLen(buffer.subarray(1))
    return inner === null ? null : inner + 1
  }

  if (buffer[1] === 0x5b) {
    // ESC [
    if (buffer[2] === 0x3c) return findCsiFinal(buffer, 'Mm', 3)
    if (buffer[2] === 0x4d) return buffer.length >= 6 ? 6 : null
    return findCsiFinal(buffer, CSI_FINALS)
  }

  const family = controlStringFamily(buffer)
  if (family !== null) return controlStringLen(buffer, family)

  if (buffer[1] === 0x4f) return buffer.length >= 3 ? 3 : null // ESC O, SS3

  // ESC + one character: Alt+key in the legacy encoding.
  const width = utf8CharWidth(buffer[1] as number)
  if (width === null) return 2 // not a UTF-8 lead; hand it over as two bytes rather than stall
  if (buffer.length < 1 + width) return null
  const charLen = firstUtf8CharLen(buffer.subarray(1))
  return charLen === null ? 2 : 1 + charLen
}

// ---------------------------------------------------------------------------
// The framer
// ---------------------------------------------------------------------------

/** One framed unit: a complete sequence, a character, or a whole bracketed paste. */
export type Frame =
  | { readonly kind: 'bytes'; readonly bytes: Buffer }
  | { readonly kind: 'paste'; readonly data: Buffer }

export interface FramerOptions {
  /** Cap on a single bracketed paste. Past it, the paste is emitted and framing resumes. */
  readonly maxPasteBytes?: number
}

/** 64 MiB. A paste is bounded because a terminal that never sends `CSI 201 ~` exists. */
export const MAX_PASTE_BYTES = 64 * 1024 * 1024

export class InputFramer {
  private pending: Buffer = Buffer.alloc(0)
  private pasting = false
  private pasteChunks: Buffer[] = []
  private pasteBytes = 0
  /**
   * A truncated SGR mouse report kept across an idle window.
   *
   * It is never flushed as text, which is the entire point: the alternative types
   * `[<0;3;4` at the user's shell. What happens instead, following herdr:
   *
   * - The prefix is *retained*, not emitted, and the pending buffer is cleared.
   * - If the continuation completes a valid report, those bytes are **discarded**. The
   *   click is stale by now; what matters is that it does not become text.
   * - If the continuation proves it was never a report, the prefix is forgotten and the
   *   continuation is released as ordinary input — the bytes the user actually typed.
   * - The prefix itself is never released either way. It was a mouse report's opening,
   *   and re-delivering `ESC [ <` as three keystrokes is the bug being avoided.
   */
  private orphanedPrefix: Buffer | null = null
  private readonly maxPasteBytes: number

  constructor(options: FramerOptions = {}) {
    this.maxPasteBytes = options.maxPasteBytes ?? MAX_PASTE_BYTES
  }

  /** Bytes held back, waiting for more. */
  get pendingBytes(): number {
    return this.pending.length
  }

  get isPasting(): boolean {
    return this.pasting
  }

  /** True while the only thing held is a bare `ESC`, which idle will resolve. */
  get hasPendingLoneEscape(): boolean {
    return this.pending.length === 1 && this.pending[0] === ESC
  }

  /** True while a mouse report is mid-flight, which is why idle must not flush. */
  get hasPendingMouseSequence(): boolean {
    return (
      this.orphanedPrefix !== null ||
      startsWithIncompleteSgrMouse(this.pending) ||
      startsWithIncompleteX10Mouse(this.pending)
    )
  }

  /** The retained prefix, for tests and diagnostics. Null when nothing is held. */
  get retainedMousePrefix(): Buffer | null {
    return this.orphanedPrefix
  }

  /** How long the caller should wait before calling `flushIdle`. */
  get idleTimeoutMs(): number {
    return this.hasPendingMouseSequence ? MOUSE_ACTIVE_FLUSH_TIMEOUT_MS : IDLE_FLUSH_TIMEOUT_MS
  }

  push(chunk: Buffer): Frame[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    return this.drain()
  }

  /**
   * No more bytes are coming right now.
   *
   * This resolves a lone `ESC` into the Escape key and gives up on anything else that
   * cannot be a sequence — except a truncated mouse report, which is retained instead.
   */
  flushIdle(): Frame[] {
    const frames = this.drain()
    if (this.pending.length === 0) return frames

    // Idle says nothing about a paste or a retained report; only a terminator does.
    if (this.pasting || this.orphanedPrefix !== null) return frames

    // A truncated mouse report survives the idle window rather than becoming text.
    if (startsWithIncompleteSgrMouse(this.pending)) {
      // herdr's `retain_timed_out_mouse_prefix`: only worth keeping if it is short enough
      // and still looks like a report.
      if (this.pending.length < MAX_MOUSE_CONTINUATION_BYTES && plausibleSgrMousePrefix(this.pending)) {
        this.orphanedPrefix = this.pending
      }
      this.pending = Buffer.alloc(0)
      return frames
    }
    // The legacy encoding has no digits to inspect, so the only defence is its fixed
    // length: hold a short prefix, drop it rather than typing `[M` at a shell.
    if (startsWithIncompleteX10Mouse(this.pending)) {
      this.pending = Buffer.alloc(0)
      return frames
    }

    // An incomplete UTF-8 character is also worth waiting for; a byte that can never
    // start one is not, and is emitted as itself.
    if (startsWithIncompleteUtf8(this.pending)) return frames

    frames.push({ kind: 'bytes', bytes: this.pending })
    this.pending = Buffer.alloc(0)
    return frames
  }

  /**
   * The client is going away or the user interrupted: forget everything held.
   *
   * herdr's `flush_interrupted`. A retained mouse prefix must not survive into the next
   * session, where its tail would arrive as a report for a pane that no longer exists.
   */
  reset(): void {
    this.pending = Buffer.alloc(0)
    this.orphanedPrefix = null
    this.pasting = false
    this.pasteChunks = []
    this.pasteBytes = 0
  }

  private drain(): Frame[] {
    const frames: Frame[] = []
    for (;;) {
      if (this.orphanedPrefix !== null) {
        const verdict = classifySgrMouseContinuation(this.orphanedPrefix, this.pending)
        if (verdict.kind === 'incomplete') return frames
        if (verdict.kind === 'complete') {
          // The late report's bytes are consumed and thrown away, never delivered.
          this.pending = Buffer.from(this.pending.subarray(verdict.length))
        }
        // 'invalid' leaves `pending` alone: those bytes were the user's after all.
        this.orphanedPrefix = null
      }

      if (this.pending.length === 0) return frames

      if (this.pasting) {
        const end = this.pending.indexOf(PASTE_END)
        if (end === -1) {
          // Keep the last few bytes: the terminator may straddle this read.
          const keep = Math.min(this.pending.length, PASTE_END.length - 1)
          const consumed = this.pending.subarray(0, this.pending.length - keep)
          if (consumed.length > 0) {
            this.pasteChunks.push(Buffer.from(consumed))
            this.pasteBytes += consumed.length
            this.pending = Buffer.from(this.pending.subarray(this.pending.length - keep))
          }
          if (this.pasteBytes >= this.maxPasteBytes) {
            // Over the cap. Emit what has accumulated and *stay* in paste mode: the rest
            // of the block is still paste, and letting it fall through to key framing
            // would type a few megabytes of someone's clipboard at their shell.
            frames.push(this.finishPaste({ keepPasting: true }))
          }
          return frames
        }
        this.pasteChunks.push(Buffer.from(this.pending.subarray(0, end)))
        this.pasteBytes += end
        this.pending = Buffer.from(this.pending.subarray(end + PASTE_END.length))
        frames.push(this.finishPaste())
        continue
      }

      if (this.pending.length >= PASTE_START.length && this.pending.subarray(0, PASTE_START.length).equals(PASTE_START)) {
        this.pasting = true
        this.pending = Buffer.from(this.pending.subarray(PASTE_START.length))
        continue
      }
      // A partial `CSI 200 ~` at the end of a read must not be framed as an ordinary CSI
      // sequence, or the paste's opening bracket is consumed as a key.
      if (this.pending.length < PASTE_START.length && PASTE_START.subarray(0, this.pending.length).equals(this.pending)) {
        return frames
      }

      if (this.pending[0] === ESC) {
        const len = completeEscapeSequenceLen(this.pending)
        if (len === null) return frames
        frames.push({ kind: 'bytes', bytes: Buffer.from(this.pending.subarray(0, len)) })
        this.pending = Buffer.from(this.pending.subarray(len))
        continue
      }

      const charLen = firstUtf8CharLen(this.pending)
      if (charLen === null) {
        if (startsWithIncompleteUtf8(this.pending)) return frames
        // A byte that cannot begin a UTF-8 character. Pass it through rather than stall:
        // it is a legacy mouse coordinate, or a paste of non-UTF-8 content.
        frames.push({ kind: 'bytes', bytes: Buffer.from(this.pending.subarray(0, 1)) })
        this.pending = Buffer.from(this.pending.subarray(1))
        continue
      }
      frames.push({ kind: 'bytes', bytes: Buffer.from(this.pending.subarray(0, charLen)) })
      this.pending = Buffer.from(this.pending.subarray(charLen))
    }
  }

  private finishPaste(options: { keepPasting?: boolean } = {}): Frame {
    const data = this.pasteChunks.length === 1 ? (this.pasteChunks[0] as Buffer) : Buffer.concat(this.pasteChunks)
    this.pasting = options.keepPasting === true
    this.pasteChunks = []
    this.pasteBytes = 0
    return { kind: 'paste', data }
  }
}
