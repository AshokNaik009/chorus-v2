/**
 * The real terminal: raw mode, the alternate screen, resize, and teardown.
 *
 * ## Why DEC 2026 is probed rather than assumed
 *
 * Synchronized output (`CSI ? 2026 h` / `l`) makes a frame atomic, which removes tearing
 * on terminals that implement it. The usual advice is that unknown private modes are
 * ignored, so emitting it unconditionally is free — that advice is not reliably true. A
 * terminal that neither implements the mode nor swallows it prints the escape into the
 * user's scrollback *on every frame*. So the mode is queried with DECRQM
 * (`CSI ? 2026 $ p`) at startup and the brackets are emitted only on an affirmative
 * reply. No reply, or "not recognized", means those bytes are never written at all.
 *
 * ## Teardown
 *
 * Every exit path has to restore the terminal: a client that dies in raw mode on the
 * alternate screen leaves a shell the user cannot see what they are typing into. The
 * handlers below cover normal exit, SIGINT/SIGTERM/SIGHUP, and an uncaught throw.
 */

import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'
import { CSI, ENTER_ALT_SCREEN, HIDE_CURSOR, LEAVE_ALT_SCREEN, RESET_SGR, SHOW_CURSOR } from './ansi.js'

/** DECRQM reply values, from DEC STD 070 / xterm's implementation. */
export const DECRQM_NOT_RECOGNIZED = 0
export const DECRQM_SET = 1
export const DECRQM_RESET = 2
export const DECRQM_PERMANENTLY_SET = 3
export const DECRQM_PERMANENTLY_RESET = 4

export const SYNC_OUTPUT_MODE = 2026

/** Ask whether a private mode is supported. */
export function decrqmQuery(mode: number): string {
  return `\x1b[?${mode}$p`
}

/**
 * Find a DECRQM reply for `mode` in a byte soup.
 *
 * The reply can arrive interleaved with whatever the user typed while the probe was in
 * flight, so this scans rather than matching the whole buffer. Returns the reported value,
 * or null when no reply for this mode is present yet.
 */
export function parseDecrqmReply(data: string, mode: number): number | null {
  // CSI ? <mode> ; <value> $ y
  const pattern = new RegExp(`\\x1b\\[\\?${mode};(\\d+)\\$y`, 'u')
  const match = pattern.exec(data)
  if (!match) return null
  const value = Number.parseInt(match[1] as string, 10)
  return Number.isFinite(value) ? value : null
}

/**
 * Whether a DECRQM value means the mode exists.
 *
 * 1 (set), 2 (reset) and 3 (permanently set) all mean the terminal knows the mode.
 * 0 means it does not recognize it; 4 means it recognizes it but can never enable it.
 * A missing reply — `null` — is the same answer as 0, because a terminal that does not
 * respond to DECRQM cannot be trusted to swallow the mode either.
 */
export function decrqmIndicatesSupport(value: number | null): boolean {
  return value === DECRQM_SET || value === DECRQM_RESET || value === DECRQM_PERMANENTLY_SET
}

/** Strip a DECRQM reply out of a buffer, so it is not delivered as user input. */
export function stripDecrqmReply(data: string, mode: number): string {
  return data.replace(new RegExp(`\\x1b\\[\\?${mode};\\d+\\$y`, 'gu'), '')
}

/**
 * The same, over bytes.
 *
 * Latin-1 is the decoding to match against, not UTF-8: it maps every byte to exactly one
 * character, so a match offset in the decoded string is a byte offset in the buffer, and
 * a high byte the user pasted is still the same high byte when the surrounding reply is
 * cut out. Decoding as UTF-8 would replace it with U+FFFD before we ever got here.
 */
export function stripDecrqmReplyBytes(data: Buffer, mode: number): Buffer {
  const pattern = new RegExp(`\\x1b\\[\\?${mode};\\d+\\$y`, 'g')
  const text = data.toString('latin1')
  const keep: Buffer[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    keep.push(data.subarray(cursor, match.index))
    cursor = match.index + match[0].length
  }
  if (cursor === 0) return data
  keep.push(data.subarray(cursor))
  return Buffer.concat(keep)
}

export interface ProbeOptions {
  readonly input: Readable
  readonly output: Writable
  readonly mode?: number
  readonly timeoutMs?: number
}

export interface ProbeResult {
  readonly supported: boolean
  readonly value: number | null
  /**
   * Input that arrived during the probe and is not part of the reply. Replay it.
   *
   * Bytes, because it is the user's keystrokes and a keystroke is not necessarily text.
   */
  readonly leftover: Buffer
}

/**
 * Query a private mode and wait briefly for the answer.
 *
 * The timeout is the whole cost of being wrong in the safe direction: a terminal that
 * does support the mode but is slow to answer merely loses synchronized output.
 */
export function probeMode(options: ProbeOptions): Promise<ProbeResult> {
  const mode = options.mode ?? SYNC_OUTPUT_MODE
  const timeoutMs = options.timeoutMs ?? 100

  return new Promise<ProbeResult>((resolve) => {
    let buffer = Buffer.alloc(0)
    let settled = false

    const finish = (value: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.input.off('data', onData)
      resolve({
        supported: decrqmIndicatesSupport(value),
        value,
        leftover: stripDecrqmReplyBytes(buffer, mode)
      })
    }

    const onData = (chunk: Buffer | string): void => {
      // latin1 on the way in as well, so a chunk that is already a string (a test using a
      // PassThrough, a stream someone set an encoding on) is not re-encoded UTF-8.
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk])
      // The reply is pure ASCII, so matching the latin1 view finds it without decoding.
      const value = parseDecrqmReply(buffer.toString('latin1'), mode)
      if (value !== null) finish(value)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)
    timer.unref()
    options.input.on('data', onData)
    options.output.write(decrqmQuery(mode))
  })
}

export interface ScreenOptions {
  readonly input?: NodeJS.ReadStream
  readonly output?: NodeJS.WriteStream
  /** Skip the DECRQM probe and force a decision. Used by tests and the benchmark. */
  readonly synchronizedOutput?: boolean
  readonly probeTimeoutMs?: number
  /** Default geometry when the output stream is not a TTY. */
  readonly fallbackSize?: { readonly cols: number; readonly rows: number }
  /** Ask the terminal for mouse reports. Off by default so a test rig stays quiet. */
  readonly mouse?: boolean
  /**
   * Also ask for motion with no button held, so the UI can react to hover.
   *
   * Separate from `mouse`, and off by default, because it is not free: 1003 reports
   * every cell the pointer crosses, so a single sweep across a 200-column terminal is
   * ~200 input events, each of which wakes the input chain and can dirty a row. The
   * click path needs none of that.
   */
  readonly mouseMotion?: boolean
  /** Ask the terminal to bracket pastes, so a paste is not mistaken for typing. */
  readonly bracketedPaste?: boolean
}

/**
 * Turn on mouse reporting, in the encodings worth having.
 *
 * 1002 is button-and-drag tracking — press, release and motion while a button is held,
 * which is what a click-to-focus and a drag need, without the firehose of 1003's
 * every-pixel motion. 1006 is the SGR encoding, and it is the one that matters: without
 * it the terminal falls back to X10, which cannot express a column past 223 and puts a
 * byte above 0x7F in the middle of every report past column 95.
 *
 * 1006 is requested *after* 1002 because a terminal that does not know 1006 must still
 * end up with 1002 on rather than neither.
 */
export const ENABLE_MOUSE = `${CSI}?1002h${CSI}?1006h`
export const DISABLE_MOUSE = `${CSI}?1006l${CSI}?1002l`

/**
 * Any-event tracking: motion reported with no button held.
 *
 * Requested *in addition to* 1002, not instead of it, so a terminal that does not
 * implement 1003 still reports clicks. Turning it off restores 1002 alone, which is
 * why `DISABLE_MOUSE_MOTION` does not also drop 1002.
 */
export const ENABLE_MOUSE_MOTION = `${CSI}?1003h`
export const DISABLE_MOUSE_MOTION = `${CSI}?1003l`
export const ENABLE_BRACKETED_PASTE = `${CSI}?2004h`
export const DISABLE_BRACKETED_PASTE = `${CSI}?2004l`

export interface ScreenEvents {
  resize: [cols: number, rows: number]
  /**
   * Raw bytes from the terminal.
   *
   * Not a string. `setEncoding('utf8')` on stdin looks harmless and is not: it runs
   * every keystroke through a StringDecoder, and a legacy X10 mouse report encodes a
   * column as `32 + column` in one byte, so every column past 95 becomes U+FFFD. So does
   * a paste of Latin-1 content. The parser in @leap-chorus/input works on bytes for the
   * same reason herdr's `raw_input.rs` does.
   */
  input: [data: Buffer]
}

/**
 * A live terminal.
 *
 * `open()` is async only because of the DECRQM probe; everything after it is synchronous.
 */
export class Screen extends EventEmitter<ScreenEvents> {
  private closed = false
  private pending: string[] = []
  /**
   * Keystrokes that arrived before anything was listening.
   *
   * There is always a gap: `open()` spends up to the probe timeout waiting for DECRQM,
   * and the caller then has its own async setup before it attaches a handler. Anything
   * typed in that window is the user's and must not be swallowed.
   */
  private inputBacklog: Buffer[] = []
  private draining = false
  private readonly onSigwinch = (): void => this.handleResize()
  private readonly exitHandlers: Array<() => void> = []

  private constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
    /** True only when DECRQM said the terminal knows mode 2026. */
    readonly synchronizedOutput: boolean,
    private currentCols: number,
    private currentRows: number,
    private readonly modesToRestore: string
  ) {
    super()
  }

  static async open(options: ScreenOptions = {}): Promise<Screen> {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    const fallback = options.fallbackSize ?? { cols: 80, rows: 24 }

    if (input.isTTY) input.setRawMode(true)
    input.resume()
    // Deliberately no setEncoding: this stream carries bytes, and a StringDecoder on it
    // would turn every non-UTF-8 input byte — legacy mouse coordinates, a Latin-1 paste —
    // into U+FFFD before the parser ever sees it. See ScreenEvents.input.

    let synchronized = options.synchronizedOutput ?? false
    let leftover: Buffer = Buffer.alloc(0)
    if (options.synchronizedOutput === undefined && output.isTTY && input.isTTY) {
      const result = await probeMode({
        input,
        output,
        mode: SYNC_OUTPUT_MODE,
        ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs })
      })
      synchronized = result.supported
      leftover = result.leftover
    }

    // Whatever is turned on has to be turned off again on the way out, in reverse: a
    // terminal left in mouse-reporting mode makes every click look like garbage typed at
    // whatever shell the user lands back in.
    const restore =
      (options.bracketedPaste === true ? DISABLE_BRACKETED_PASTE : '') +
      (options.mouseMotion === true ? DISABLE_MOUSE_MOTION : '') +
      (options.mouse === true ? DISABLE_MOUSE : '')
    const screen = new Screen(
      input,
      output,
      synchronized,
      output.columns ?? fallback.cols,
      output.rows ?? fallback.rows,
      restore
    )

    output.write(ENTER_ALT_SCREEN + HIDE_CURSOR + RESET_SGR)
    if (options.mouse === true) output.write(ENABLE_MOUSE)
    // Only with `mouse`: 1003 without 1002 is a terminal reporting motion into a
    // client that never asked to know where the buttons are.
    if (options.mouse === true && options.mouseMotion === true) output.write(ENABLE_MOUSE_MOTION)
    if (options.bracketedPaste === true) output.write(ENABLE_BRACKETED_PASTE)

    input.on('data', (chunk: string | Buffer) => {
      // A string only reaches here when someone else set an encoding on the stream; decode
      // it latin1 so at least the byte values survive rather than being re-encoded UTF-8.
      screen.deliverInput(typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk)
    })
    // Keystrokes typed during the probe are the user's, not the terminal's answer.
    if (leftover.length > 0) screen.deliverInput(leftover)

    process.on('SIGWINCH', screen.onSigwinch)
    // `resize` fires on Windows, where there is no SIGWINCH.
    output.on('resize', screen.onSigwinch)

    const teardown = (): void => screen.close()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const handler = (): void => {
        teardown()
        process.exit(0)
      }
      process.on(signal, handler)
      screen.exitHandlers.push(() => process.off(signal, handler))
    }
    process.on('exit', teardown)
    screen.exitHandlers.push(() => process.off('exit', teardown))

    return screen
  }

  private deliverInput(data: Buffer): void {
    if (data.length === 0) return
    if (this.listenerCount('input') === 0) {
      this.inputBacklog.push(data)
      return
    }
    this.emit('input', data)
  }

  /**
   * Attach an input handler, and hand it anything typed before it existed.
   *
   * Prefer this to `on('input')`: a plain listener starts from now, and "now" is after
   * the DECRQM probe, so it silently drops the first keystrokes of the session.
   */
  onInput(listener: (data: Buffer) => void): () => void {
    this.on('input', listener)
    if (this.inputBacklog.length > 0) {
      const backlog = Buffer.concat(this.inputBacklog)
      this.inputBacklog = []
      queueMicrotask(() => this.emit('input', backlog))
    }
    return () => {
      this.off('input', listener)
    }
  }

  get cols(): number {
    return this.currentCols
  }

  get rows(): number {
    return this.currentRows
  }

  private handleResize(): void {
    if (this.closed) return
    const cols = this.output.columns ?? this.currentCols
    const rows = this.output.rows ?? this.currentRows
    if (cols === this.currentCols && rows === this.currentRows) return
    this.currentCols = cols
    this.currentRows = rows
    this.emit('resize', cols, rows)
  }

  /**
   * Queue bytes for the terminal.
   *
   * Writes are coalesced and paused on backpressure: a frame that cannot go out yet is
   * held rather than queued behind itself, because on a slow link the newest frame is
   * the only one worth sending.
   */
  write(data: string): void {
    if (this.closed || data.length === 0) return
    this.pending.push(data)
    if (!this.draining) this.flush()
  }

  /** True while the output stream has not drained; the caller should skip a frame. */
  get isSaturated(): boolean {
    return this.draining
  }

  flush(): void {
    if (this.closed || this.pending.length === 0) return
    const payload = this.pending.join('')
    this.pending = []
    const accepted = this.output.write(payload)
    if (!accepted) {
      this.draining = true
      this.output.once('drain', () => {
        this.draining = false
        this.flush()
      })
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    process.off('SIGWINCH', this.onSigwinch)
    this.output.off('resize', this.onSigwinch)
    for (const off of this.exitHandlers) off()
    try {
      this.output.write(this.modesToRestore + RESET_SGR + SHOW_CURSOR + LEAVE_ALT_SCREEN)
    } catch {
      // The terminal may already be gone; there is nothing to restore it to.
    }
    if (this.input.isTTY) {
      try {
        this.input.setRawMode(false)
      } catch {
        // Same.
      }
    }
    this.input.pause()
    this.removeAllListeners()
  }
}
