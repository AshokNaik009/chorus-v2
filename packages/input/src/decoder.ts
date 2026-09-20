/**
 * Bytes in, `InputEvent`s out. The front door of this package.
 *
 * The framer decides where a sequence ends; this decides what it was. Keeping those
 * apart is what makes the hard half testable: `InputFramer` never needs to know that
 * `CSI 57419 u` is the Up arrow, and the parsers never need to know that bytes arrive in
 * arbitrary chunks.
 *
 * A sequence that parses as nothing is emitted as `unknown` rather than dropped. That is
 * deliberate: a terminal feature this build has never heard of still reaches the pane,
 * because the client forwards those bytes verbatim.
 */

import { InputFramer, type Frame, type FramerOptions } from './framer.js'
import { parseSgrMouse, parseX10Mouse } from './mouse.js'
import { parseKeySequence } from './parse-csi.js'
import type { InputEvent } from './model.js'

const ESC = 0x1b

export interface DecoderOptions extends FramerOptions {
  /**
   * Cell size, for mode 1016 reports whose coordinates are pixels.
   *
   * Absent, a pixel report's cell coordinates come out as the pixel values, which is
   * wrong but bounded — and mode 1016 is only ever on because something asked for it.
   */
  readonly cellWidthPx?: number
  readonly cellHeightPx?: number
}

export class InputDecoder {
  private readonly framer: InputFramer
  private readonly options: DecoderOptions

  constructor(options: DecoderOptions = {}) {
    this.framer = new InputFramer(options)
    this.options = options
  }

  /** How long to wait with no input before calling `flushIdle`. */
  get idleTimeoutMs(): number {
    return this.framer.idleTimeoutMs
  }

  get hasPendingInput(): boolean {
    return this.framer.pendingBytes > 0 || this.framer.retainedMousePrefix !== null
  }

  push(bytes: Buffer): InputEvent[] {
    return this.framer.push(bytes).map((frame) => this.decode(frame))
  }

  /** No more bytes are coming right now: resolve a lone ESC, hold a truncated report. */
  flushIdle(): InputEvent[] {
    return this.framer.flushIdle().map((frame) => this.decode(frame))
  }

  reset(): void {
    this.framer.reset()
  }

  private decode(frame: Frame): InputEvent {
    if (frame.kind === 'paste') return { type: 'paste', data: frame.data }
    const bytes = frame.bytes

    if (bytes.length >= 3 && bytes[0] === ESC && bytes[1] === 0x5b) {
      // Mouse before keys: `CSI < ... M` would otherwise be read as a malformed CSI-u.
      if (bytes[2] === 0x3c) {
        const mouse = parseSgrMouse(bytes, {
          pixels: false,
          ...(this.options.cellWidthPx === undefined ? {} : { cellWidthPx: this.options.cellWidthPx }),
          ...(this.options.cellHeightPx === undefined ? {} : { cellHeightPx: this.options.cellHeightPx })
        })
        if (mouse) return { type: 'mouse', mouse, bytes }
        return { type: 'unknown', bytes }
      }
      if (bytes[2] === 0x4d) {
        const mouse = parseX10Mouse(bytes)
        if (mouse) return { type: 'mouse', mouse, bytes }
        return { type: 'unknown', bytes }
      }
      // Focus reporting, mode 1004. Not a key, and a pane that asked for it wants it.
      if (bytes.length === 3 && bytes[2] === 0x49) return { type: 'focus', focused: true }
      if (bytes.length === 3 && bytes[2] === 0x4f) return { type: 'focus', focused: false }
    }

    const key = parseKeySequence(bytes)
    if (key) return { type: 'key', key, bytes }
    return { type: 'unknown', bytes }
  }
}
