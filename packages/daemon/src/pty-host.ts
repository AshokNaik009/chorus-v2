/**
 * node-pty wrapper. The single boundary where node-pty's typing is laundered.
 *
 * node-pty declares `onData: IEvent<string>` and has no byte-typed event, but passing
 * `encoding: null` to `spawn()` makes the underlying stream emit `Buffer` on Unix. On
 * Windows the same option still yields a string (microsoft/node-pty#489). So the cast
 * lives here, exactly once, and `PtyBackend.onData` carries `Uint8Array` everywhere
 * else — which is what lets a multi-byte codepoint split across two reads reach the
 * emulator intact instead of being decoded twice into two replacement characters.
 */

import pty from 'node-pty'
import type { IPty } from 'node-pty'

export interface PtyExit {
  readonly exitCode: number
  readonly signal: number | null
}

export interface PtyDisposable {
  dispose(): void
}

export interface PtyBackend {
  readonly pid: number
  onData(listener: (bytes: Uint8Array) => void): PtyDisposable
  onExit(listener: (exit: PtyExit) => void): PtyDisposable
  /** Raw bytes in. See the note on the implementation for why this is not a string. */
  write(bytes: Uint8Array): void
  resize(cols: number, rows: number): void
  /** Stop reading from the pty fd. The child blocks once its pipe fills. */
  pause(): void
  resume(): void
  kill(signal?: string): void
}

export interface SpawnPtyOptions {
  readonly command: string
  readonly args?: readonly string[]
  readonly cols: number
  readonly rows: number
  readonly cwd: string
  readonly env: Record<string, string>
  readonly name?: string
}

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return env['COMSPEC'] ?? 'cmd.exe'
  return env['SHELL'] ?? '/bin/sh'
}

/** node-pty mutates the env object it is given, so hand it a copy of only strings. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

export function spawnPty(options: SpawnPtyOptions): PtyBackend {
  const term: IPty = pty.spawn(options.command, [...(options.args ?? [])], {
    name: options.name ?? 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd,
    env: options.env,
    // The lie. `encoding: null` is documented by node-pty as "no decoding" but is typed
    // as `string`. On Unix the stream then emits Buffer; onData below handles both so
    // the Windows behavior (still a string) is not a crash.
    encoding: null as unknown as string,
    // handleFlowControl deliberately OFF: node-pty's flow control is not backpressure.
    // Reading lib/terminal.js, the option does exactly one thing — it makes
    // pty.write('\x13') call pause() and pty.write('\x11') call resume() instead of
    // forwarding those bytes — i.e. a manual switch that also swallows ^S/^Q on the way
    // to the program. We drive pause()/resume() ourselves from real consumer pressure
    // (see sessions.ts) and leave ^S/^Q passing through to the child.
    handleFlowControl: false
  })

  const toBytes = (data: string | Buffer): Uint8Array => {
    // Unix with `encoding: null`.
    if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    // Windows, where `encoding: null` is ignored. Already decoded; re-encoding is the
    // best available, and no worse than what node-pty itself produced.
    return new Uint8Array(Buffer.from(data, 'utf8'))
  }

  return {
    pid: term.pid,
    onData(listener): PtyDisposable {
      return term.onData((data: string) => listener(toBytes(data as unknown as string | Buffer)))
    },
    onExit(listener): PtyDisposable {
      return term.onExit(({ exitCode, signal }) =>
        listener({ exitCode, signal: signal === undefined || signal === 0 ? null : signal })
      )
    },
    write(bytes: Uint8Array): void {
      // The second lie, and the reason this one is safe. node-pty types `write` as
      // `(data: string) => void`, but neither platform's implementation requires one:
      // on Unix `CustomWriteStream.write` does `typeof data === 'string' ? Buffer.from(
      // data, encoding) : Buffer.from(data)`, and on Windows `_doWrite` hands the value
      // to `agent.inSocket.write`, a net.Socket, which takes a Buffer natively.
      //
      // It has to be bytes. Terminal input is not text: a legacy X10 mouse report encodes
      // a column as `32 + column` in a single byte, so any column past 95 produces a byte
      // that is not valid UTF-8, and a paste of Latin-1 content is not valid UTF-8 either.
      // Routing those through a string turns each one into U+FFFD — measured, before this
      // changed: `1b 5b 4d 20 e8 28` arrived at the pane as `1b 5b 4d 20 ef bf bd 28`.
      term.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) as unknown as string)
    },
    resize(cols: number, rows: number): void {
      term.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    },
    pause(): void {
      term.pause()
    },
    resume(): void {
      term.resume()
    },
    kill(signal?: string): void {
      try {
        term.kill(signal)
      } catch {
        // Killing an already-dead pty throws on some platforms; the exit event is the
        // authority on liveness, not this call.
      }
    }
  }
}
