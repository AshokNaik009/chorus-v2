/**
 * Newline-delimited JSON framing over a stream.
 *
 * The decoder is incremental and bounded: a peer that never sends a newline cannot
 * make us buffer without limit. Approach follows orca's main-process NDJSON framer
 * (MIT, Lovecast Inc. 2026), reduced to what phase 1 needs.
 */

import type { Socket } from 'node:net'
import type { AnyMessage } from './messages.js'

/** A single frame may not exceed this. A 200x50 snapshot is ~50 KiB; 8 MiB is slack, not a budget. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024

export class FrameTooLongError extends Error {
  constructor(
    readonly observedBytes: number,
    readonly maxBytes: number
  ) {
    super(`NDJSON frame exceeds ${maxBytes} bytes (saw ${observedBytes})`)
    this.name = 'FrameTooLongError'
  }
}

export class FrameParseError extends Error {
  constructor(cause: unknown) {
    super(`NDJSON frame is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'FrameParseError'
  }
}

export function encodeFrame(message: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
}

export interface DecoderOptions {
  readonly maxFrameBytes?: number
  onMessage(message: unknown): void
  /**
   * Called for a frame that could not be delivered. Framing continues from the next
   * newline: one bad frame is not a dead connection.
   */
  onError?(error: FrameTooLongError | FrameParseError): void
}

export interface FrameDecoder {
  push(chunk: Buffer): void
  /** Bytes currently held for an unterminated frame. */
  readonly pendingBytes: number
  reset(): void
}

export function createFrameDecoder(options: DecoderOptions): FrameDecoder {
  const maxFrameBytes = Math.max(1, options.maxFrameBytes ?? MAX_FRAME_BYTES)
  let pending: Buffer = Buffer.alloc(0)
  // Set once a frame blows the cap: bytes are discarded until the next newline, so the
  // stream resynchronizes instead of the connection dying on one oversized message.
  let discardingUntilNewline = false

  const deliver = (frame: Buffer): void => {
    if (frame.length === 0) return
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.toString('utf8'))
    } catch (cause) {
      options.onError?.(new FrameParseError(cause))
      return
    }
    options.onMessage(parsed)
  }

  return {
    push(chunk: Buffer): void {
      let cursor = 0
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(0x0a, cursor)
        if (newline === -1) {
          const tail = chunk.subarray(cursor)
          if (discardingUntilNewline) return
          if (pending.length + tail.length > maxFrameBytes) {
            options.onError?.(new FrameTooLongError(pending.length + tail.length, maxFrameBytes))
            pending = Buffer.alloc(0)
            discardingUntilNewline = true
            return
          }
          pending = pending.length === 0 ? Buffer.from(tail) : Buffer.concat([pending, tail])
          return
        }

        const segment = chunk.subarray(cursor, newline)
        cursor = newline + 1

        if (discardingUntilNewline) {
          discardingUntilNewline = false
          pending = Buffer.alloc(0)
          continue
        }
        if (pending.length + segment.length > maxFrameBytes) {
          options.onError?.(new FrameTooLongError(pending.length + segment.length, maxFrameBytes))
          pending = Buffer.alloc(0)
          continue
        }
        const frame = pending.length === 0 ? segment : Buffer.concat([pending, segment])
        pending = Buffer.alloc(0)
        deliver(frame)
      }
    },
    get pendingBytes(): number {
      return pending.length
    },
    reset(): void {
      pending = Buffer.alloc(0)
      discardingUntilNewline = false
    }
  }
}

export interface FramedConnectionOptions {
  readonly maxFrameBytes?: number
  onMessage(message: unknown): void
  onError?(error: FrameTooLongError | FrameParseError): void
  onClose?(): void
}

/**
 * A socket carrying NDJSON frames, with the writer's backpressure exposed.
 *
 * `saturated` is the phase-1 answer to a flooding pane: a producer checks it and stops
 * producing rather than queueing into the kernel forever. See daemon/sessions.ts.
 */
export class FramedConnection {
  private readonly decoder: FrameDecoder
  private readonly drainWaiters: Array<() => void> = []
  private closed = false
  private writable = true
  // Wire volume, for diagnostics and for PHASE-2's daemon->client bytes/sec figure.
  private received = 0
  private sent = 0

  constructor(
    readonly socket: Socket,
    options: FramedConnectionOptions
  ) {
    this.decoder = createFrameDecoder({
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
      onMessage: options.onMessage,
      ...(options.onError ? { onError: options.onError } : {})
    })

    socket.on('data', (chunk: Buffer) => {
      this.received += chunk.length
      this.decoder.push(chunk)
    })
    socket.on('drain', () => {
      this.writable = true
      const waiters = this.drainWaiters.splice(0, this.drainWaiters.length)
      for (const resolve of waiters) resolve()
    })
    const finish = (): void => {
      if (this.closed) return
      this.closed = true
      this.writable = false
      const waiters = this.drainWaiters.splice(0, this.drainWaiters.length)
      for (const resolve of waiters) resolve()
      options.onClose?.()
    }
    socket.on('close', finish)
    socket.on('end', finish)
    // A peer that dies mid-write surfaces as an error; treat it as a close, not a throw.
    socket.on('error', finish)
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Bytes read off this socket since it was opened. */
  get bytesReceived(): number {
    return this.received
  }

  /** Bytes handed to this socket since it was opened. */
  get bytesSent(): number {
    return this.sent
  }

  /** True when the kernel buffer is full and the peer is not draining it. */
  get saturated(): boolean {
    return !this.writable
  }

  send(message: AnyMessage): boolean {
    if (this.closed) return false
    const frame = encodeFrame(message)
    this.sent += frame.length
    this.writable = this.socket.write(frame)
    return this.writable
  }

  /** Resolves when the socket accepts writes again (or is closed). */
  waitForDrain(): Promise<void> {
    if (this.writable || this.closed) return Promise.resolve()
    return new Promise<void>((resolve) => this.drainWaiters.push(resolve))
  }

  close(): void {
    if (this.closed) return
    this.socket.end()
    this.socket.destroy()
  }
}
