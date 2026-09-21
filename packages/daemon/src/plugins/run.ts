/**
 * Running someone else's program.
 *
 * Every number in here exists because a plugin is code this project did not write and
 * cannot review. herdr caps a plugin command at 64 KiB of output and 32 in flight
 * (`PLUGIN_COMMAND_OUTPUT_MAX_BYTES`, `MAX_PLUGIN_COMMANDS_IN_FLIGHT` in
 * `src/app/api/plugins/runtime.rs`), and orca arrived at the same shape independently
 * with `plugin-worker-output-buffer.ts` and friends. Two projects agreeing on a number
 * nobody can derive is the strongest evidence available for it, so both are kept.
 *
 * ## Truncated, not buffered
 *
 * Past the cap the bytes are **dropped as they arrive** and the stream keeps draining.
 * Not buffered-then-trimmed, which would let a plugin printing a gigabyte take the
 * daemon's heap on the way to being trimmed; and not killed either, because a build
 * that is chatty is not a build that is wrong. The caller is told `truncated`.
 *
 * ## Why this is not `execFile`
 *
 * Phase 8 wrote the reason down and phase 9 repeated it: `execFile` buffers internally
 * and kills the child at `maxBuffer` with an error a caller can easily read as success.
 * The bound here is explicit, and the outcome says what was lost.
 *
 * ## What this is not
 *
 * It is not a sandbox. The child runs as the user, with the user's filesystem and
 * network. PHASE-10: "Bounding output is not a security boundary, and the handoff must
 * not imply it is."
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

/** herdr's `PLUGIN_COMMAND_OUTPUT_MAX_BYTES`. */
export const PLUGIN_OUTPUT_MAX_BYTES = 64 * 1024

/** herdr's `MAX_PLUGIN_COMMANDS_IN_FLIGHT`. */
export const MAX_PLUGIN_COMMANDS_IN_FLIGHT = 32

/** An action is something a user is waiting for. */
export const PLUGIN_ACTION_TIMEOUT_MS = 30_000

/**
 * A build is not.
 *
 * `scripts/fetch-or-build.sh` in herdr-file-viewer falls back to `cargo build`, which on
 * a cold registry is minutes. Ten of them is long enough to be a real build and short
 * enough that a hung install is still an install that ends.
 */
export const PLUGIN_BUILD_TIMEOUT_MS = 10 * 60_000

export class PluginBusyError extends Error {
  constructor(readonly inFlight: number) {
    super(`maximum concurrent plugin commands reached (${inFlight})`)
    this.name = 'PluginBusyError'
  }
}

export interface PluginRunOutcome {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** Output passed the cap; the rest was dropped, not kept. */
  readonly truncated: boolean
  readonly timedOut: boolean
  /** The spawn itself failed: `absent` for ENOENT, `unavailable` for anything else. */
  readonly failure: 'absent' | 'unavailable' | null
}

export interface PluginRunRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /**
   * Called with each complete line of combined output as it arrives, so `plugin install`
   * can show a build working rather than going quiet for four minutes. Lines past the
   * cap are not reported, because past the cap they do not exist.
   */
  readonly onLine?: (line: string) => void
}

export type PluginSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcess

export interface PluginRunnerOptions {
  readonly maxBytes?: number
  readonly maxInFlight?: number
  readonly spawnFn?: PluginSpawn
}

export class PluginRunner {
  private readonly maxBytes: number
  private readonly maxInFlight: number
  private readonly spawnFn: PluginSpawn
  private running = 0

  constructor(options: PluginRunnerOptions = {}) {
    this.maxBytes = options.maxBytes ?? PLUGIN_OUTPUT_MAX_BYTES
    this.maxInFlight = options.maxInFlight ?? MAX_PLUGIN_COMMANDS_IN_FLIGHT
    this.spawnFn =
      options.spawnFn ??
      ((command, args, spawnOptions) =>
        spawn(command, [...args], { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }))
  }

  get inFlight(): number {
    return this.running
  }

  /**
   * Run one argv to completion.
   *
   * Rejects only for the in-flight cap. A program that is missing, that crashed, or
   * that ran for too long is an *outcome* — the caller has something to report either
   * way, and a plugin's failure is not this host's exception.
   */
  async run(request: PluginRunRequest): Promise<PluginRunOutcome> {
    if (this.running >= this.maxInFlight) throw new PluginBusyError(this.maxInFlight)
    this.running += 1
    try {
      return await this.spawnBounded(request)
    } finally {
      this.running -= 1
    }
  }

  private spawnBounded(request: PluginRunRequest): Promise<PluginRunOutcome> {
    const [command, ...args] = request.argv
    if (command === undefined) {
      return Promise.resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        truncated: false,
        timedOut: false,
        failure: 'unavailable'
      })
    }
    const timeoutMs = request.timeoutMs ?? PLUGIN_ACTION_TIMEOUT_MS

    return new Promise<PluginRunOutcome>((resolve) => {
      let child: ChildProcess
      try {
        child = this.spawnFn(command, args, { cwd: request.cwd, env: request.env })
      } catch (error) {
        resolve(spawnFailure(error))
        return
      }

      // One budget across both streams, so a plugin cannot double it by splitting its
      // noise between stdout and stderr.
      let budget = this.maxBytes
      let truncated = false
      let timedOut = false
      let settled = false
      let stdout = ''
      let stderr = ''
      let pending = ''

      const timer = setTimeout(() => {
        timedOut = true
        // Never `kill()` a handle with no pid: that signals *our own* process group,
        // which on the daemon is every pane it owns. Phase 9's capture learned this.
        if (child.pid !== undefined) child.kill()
      }, timeoutMs)
      timer.unref?.()

      const emitLines = (text: string): void => {
        if (request.onLine === undefined) return
        pending += text
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          request.onLine(pending.slice(0, newline))
          pending = pending.slice(newline + 1)
          newline = pending.indexOf('\n')
        }
      }

      // Stateful decoders: a UTF-8 sequence can straddle a chunk boundary, and
      // `chunk.toString()` puts U+FFFD where it does.
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')

      const take = (chunk: Buffer, decoder: StringDecoder, onText: (text: string) => void): void => {
        if (budget <= 0) {
          // Drained and dropped. The stream keeps flowing so the child is not blocked
          // on a full pipe forever, and nothing is retained.
          truncated = true
          return
        }
        const slice = chunk.length > budget ? chunk.subarray(0, budget) : chunk
        if (slice.length < chunk.length) truncated = true
        budget -= slice.length
        const text = decoder.write(slice)
        onText(text)
        emitLines(text)
      }

      child.stdout?.on('data', (chunk: Buffer) => take(chunk, outDecoder, (text) => (stdout += text)))
      child.stderr?.on('data', (chunk: Buffer) => take(chunk, errDecoder, (text) => (stderr += text)))

      const settle = (outcome: PluginRunOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // A queued spawn `error` can still arrive; an unhandled one on a ChildProcess
        // takes the whole daemon down.
        child.on('error', () => {})
        if (pending.length > 0) request.onLine?.(pending)
        resolve(outcome)
      }

      child.once('error', (error) => settle({ ...spawnFailure(error), timedOut }))
      child.once('close', (code, signal) =>
        settle({
          code,
          signal: signal ?? null,
          stdout: stdout + outDecoder.end(),
          stderr: stderr + errDecoder.end(),
          truncated,
          timedOut,
          failure: null
        })
      )
    })
  }
}

function spawnFailure(error: unknown): PluginRunOutcome {
  const code = (error as { code?: unknown } | null)?.code
  return {
    code: null,
    signal: null,
    stdout: '',
    stderr: String((error as Error | null)?.message ?? error),
    truncated: false,
    timedOut: false,
    failure: code === 'ENOENT' ? 'absent' : 'unavailable'
  }
}

/** A one-line description of a non-zero outcome, for a message a user reads. */
export function describeFailure(argv: readonly string[], outcome: PluginRunOutcome): string {
  const program = argv[0] ?? '(nothing)'
  if (outcome.failure === 'absent') return `${program}: no such program`
  if (outcome.failure === 'unavailable') return `${program} could not be started: ${outcome.stderr.trim()}`
  if (outcome.timedOut) return `${program} was killed after taking too long`
  if (outcome.signal !== null) return `${program} was killed by ${outcome.signal}`
  const stderr = outcome.stderr.trim()
  const tail = stderr.length === 0 ? '' : `: ${stderr.split('\n').slice(-5).join('\n')}`
  return `${program} exited with status ${String(outcome.code)}${tail}`
}
