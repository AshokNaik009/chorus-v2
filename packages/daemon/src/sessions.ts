/**
 * Session lifecycle: id -> { pty, emulator }.
 *
 * ## The flow-control answer
 *
 * A runaway agent flooding its pane is a real failure mode, and phase 1 needs an answer
 * that is not "hope". This is the one implemented here:
 *
 * - node-pty's `handleFlowControl` is **off**. It is not backpressure — it only rewires
 *   `pty.write('\x13'/'\x11')` into `pause()`/`resume()`, at the cost of no longer being
 *   able to send a bare ^S/^Q through to the program. See pty-host.ts.
 * - Instead the daemon drives `pause()`/`resume()` itself from the one place that can
 *   actually fall behind: the emulator's unparsed backlog. Above HIGH_WATER_BYTES the
 *   PTY is paused, so the kernel pipe fills and the *child* blocks; below
 *   LOW_WATER_BYTES it resumes.
 * - Nothing is dropped, and no per-client output queue exists to grow, because clients
 *   are never sent raw output. They get a tiny `session.output` event carrying a
 *   sequence number and pull a snapshot when they want one. Snapshot cost is bounded by
 *   the screen, and output events are coalesced per tick and skipped entirely while a
 *   client's socket is saturated.
 *
 * The result: steady-state memory for a flooding pane is the emulator's bounded
 * scrollback plus at most HIGH_WATER_BYTES of unparsed input, independent of how long
 * the flood runs or whether anyone is attached.
 */

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import type { SessionExit, SessionInfo } from '@leap-chorus/protocol'
import { PaneEmulator } from './emulator.js'
import { defaultShell, sanitizeEnv, spawnPty, type PtyBackend } from './pty-host.js'
import type { SnapshotBufferSelector } from './snapshot.js'

/** Pause the PTY once this many bytes are waiting to be parsed. */
export const HIGH_WATER_BYTES = 1024 * 1024
/** Resume once the backlog drains below this. */
export const LOW_WATER_BYTES = 256 * 1024
/** Minimum gap between `session.output` events for one session. */
export const OUTPUT_EVENT_INTERVAL_MS = 16

export interface CreateSessionOptions {
  readonly id?: string
  readonly cols: number
  readonly rows: number
  readonly command?: string
  readonly args?: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly scrollback?: number
}

export interface SessionEvents {
  output(id: string, sequence: number): void
  exit(id: string, exit: SessionExit): void
  title(id: string, title: string): void
}

function newSessionId(): string {
  return `s-${randomBytes(6).toString('hex')}`
}

export class Session {
  readonly createdAt = Date.now()
  readonly emulator: PaneEmulator

  private readonly pty: PtyBackend
  private readonly disposables: Array<() => void> = []
  private bytesReadTotal = 0
  private exitInfo: SessionExit | null = null
  private paused = false
  private disposed = false

  constructor(
    readonly id: string,
    readonly command: string,
    readonly args: readonly string[],
    readonly cwd: string,
    cols: number,
    rows: number,
    options: { scrollback?: number },
    env: Record<string, string>,
    private readonly events: SessionEvents
  ) {
    this.emulator = new PaneEmulator({
      cols,
      rows,
      ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback })
    })
    this.pty = spawnPty({ command, args, cols, rows, cwd, env })

    const data = this.pty.onData((bytes) => this.ingest(bytes))
    const exit = this.pty.onExit((exitEvent) => {
      this.exitInfo = exitEvent
      this.events.exit(this.id, exitEvent)
    })
    this.disposables.push(
      () => data.dispose(),
      () => exit.dispose(),
      this.emulator.onTitleChange((title) => this.events.title(this.id, title))
    )
  }

  get pid(): number | null {
    return this.alive ? this.pty.pid : null
  }

  get alive(): boolean {
    return this.exitInfo === null
  }

  get exit(): SessionExit | null {
    return this.exitInfo
  }

  /** Monotonic count of bytes read from the PTY; doubles as the snapshot sequence. */
  get sequence(): number {
    return this.bytesReadTotal
  }

  get isPaused(): boolean {
    return this.paused
  }

  private ingest(bytes: Uint8Array): void {
    if (this.disposed) return
    this.bytesReadTotal += bytes.byteLength

    // Every byte reaches the emulator: terminal state must stay current whether or not a
    // client is attached. Hidden panes cost parsing, not presentation.
    void this.emulator.write(bytes).then(() => this.maybeResume())

    if (!this.paused && this.emulator.pendingBytes >= HIGH_WATER_BYTES) {
      this.paused = true
      this.pty.pause()
    }
    this.events.output(this.id, this.bytesReadTotal)
  }

  private maybeResume(): void {
    if (this.disposed || !this.paused) return
    if (this.emulator.pendingBytes <= LOW_WATER_BYTES) {
      this.paused = false
      this.pty.resume()
    }
  }

  /** Deliver raw bytes to the PTY. Not a string: see pty-host.ts's `write`. */
  write(bytes: Uint8Array): void {
    if (!this.alive) return
    this.pty.write(bytes)
  }

  /** Convenience for callers that really do have text, such as tests. */
  writeText(text: string): void {
    this.write(Buffer.from(text, 'utf8'))
  }

  resize(cols: number, rows: number): void {
    const safeCols = Math.max(1, Math.floor(cols))
    const safeRows = Math.max(1, Math.floor(rows))
    this.emulator.resize(safeCols, safeRows)
    if (this.alive) this.pty.resize(safeCols, safeRows)
  }

  kill(signal?: string): void {
    if (!this.alive) return
    this.pty.kill(signal)
  }

  snapshot(buffer: SnapshotBufferSelector = 'active', scrollOffset = 0) {
    return this.emulator.snapshot(this.bytesReadTotal, buffer, scrollOffset)
  }

  /** The live screen, for detection. See `PaneEmulator.detectionScreen`. */
  detectionScreen(): string {
    return this.emulator.detectionScreen()
  }

  get oscTitle(): string {
    return this.emulator.currentTitle ?? ''
  }

  get oscProgress(): string {
    return this.emulator.currentProgress
  }

  /** Content rows as text, for copy mode. See `PaneEmulator.textLines`. */
  textLines(buffer: SnapshotBufferSelector = 'active'): string[] {
    return this.emulator.textLines(buffer)
  }

  /** Wait until every byte read so far has been parsed. Snapshots after this are settled. */
  async settle(): Promise<void> {
    await this.emulator.write(new Uint8Array(0))
  }

  info(): SessionInfo {
    return {
      id: this.id,
      pid: this.pid,
      cols: this.emulator.cols,
      rows: this.emulator.rows,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      createdAt: this.createdAt,
      alive: this.alive,
      exit: this.exitInfo,
      bytesRead: this.bytesReadTotal,
      // Nothing is dropped under the chosen flow-control policy; the field exists so a
      // future dropping policy has somewhere to report, not because this one drops.
      bytesDropped: 0
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const dispose of this.disposables) dispose()
    this.pty.kill()
    this.emulator.dispose()
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>()
  private readonly listeners = new Set<Partial<SessionEvents>>()
  private readonly outputTimers = new Map<string, NodeJS.Timeout>()
  private readonly pendingOutput = new Map<string, number>()

  subscribe(listener: Partial<SessionEvents>): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit<K extends keyof SessionEvents>(event: K, ...args: Parameters<SessionEvents[K]>): void {
    for (const listener of this.listeners) {
      const handler = listener[event] as SessionEvents[K] | undefined
      if (handler) (handler as (...a: Parameters<SessionEvents[K]>) => void)(...args)
    }
  }

  /**
   * Output events are coalesced: a pane producing a megabyte a second still wakes each
   * client at most once per OUTPUT_EVENT_INTERVAL_MS, carrying only the latest sequence.
   */
  private scheduleOutput(id: string, sequence: number): void {
    this.pendingOutput.set(id, sequence)
    if (this.outputTimers.has(id)) return
    const timer = setTimeout(() => {
      this.outputTimers.delete(id)
      const latest = this.pendingOutput.get(id)
      this.pendingOutput.delete(id)
      if (latest !== undefined) this.emit('output', id, latest)
    }, OUTPUT_EVENT_INTERVAL_MS)
    // Never hold the event loop open just to report output.
    timer.unref()
    this.outputTimers.set(id, timer)
  }

  create(options: CreateSessionOptions): Session {
    const id = options.id ?? newSessionId()
    if (this.sessions.has(id)) {
      throw new Error(`Session ${id} already exists`)
    }
    const command = options.command ?? defaultShell()
    const cwd = options.cwd ?? process.env['HOME'] ?? homedir()
    const env = { ...sanitizeEnv(process.env), ...(options.env ?? {}) }
    // TERM must describe what the emulator is, not what the daemon was launched under.
    env['TERM'] = env['TERM'] ?? 'xterm-256color'

    const session = new Session(
      id,
      command,
      options.args ?? [],
      cwd,
      options.cols,
      options.rows,
      { ...(options.scrollback === undefined ? {} : { scrollback: options.scrollback }) },
      env,
      {
        output: (sessionId, sequence) => this.scheduleOutput(sessionId, sequence),
        exit: (sessionId, exit) => this.emit('exit', sessionId, exit),
        title: (sessionId, title) => this.emit('title', sessionId, title)
      }
    )
    this.sessions.set(id, session)
    return session
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  list(): Session[] {
    return [...this.sessions.values()]
  }

  remove(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.dispose()
    this.sessions.delete(id)
    const timer = this.outputTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.outputTimers.delete(id)
    }
    this.pendingOutput.delete(id)
    return true
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.remove(id)
  }
}
