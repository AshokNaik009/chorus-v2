/**
 * Drive the real TUI inside a real PTY, and read back what it drew.
 *
 * PHASE-2's criterion 2 is "a visible, working multiplexer ... rendered correctly in a
 * real terminal". A human in iTerm2 is the final word on that and is recorded in
 * HANDOFF.md, but a human is not a regression test. This harness is the mechanical half:
 *
 *   node dist/main.js  ->  node-pty  ->  @xterm/headless  ->  assertions
 *
 * The client believes it is attached to a terminal, because it is: node-pty gives it a
 * TTY with a real winsize, so `isTTY`, raw mode, and SIGWINCH all behave. Its output is
 * parsed by the same emulator the daemon uses, so what the assertions see is what a
 * terminal would have shown — including the alternate screen and the cursor position.
 *
 * Two things this cannot prove, and which the handoff states plainly instead: that a
 * specific terminal's font renders a box-drawing character the way we expect, and that
 * synchronized output actually suppresses tearing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pty from 'node-pty'
import { PaneEmulator, resolveDaemonPaths, snapshotToText, spawnDetachedDaemon, probeDaemon, isProcessAlive, type DaemonPaths } from '@leap-chorus/daemon'

const here = dirname(fileURLToPath(import.meta.url))
/** The tests run the *built* client, because what they exercise is a real process. */
export const CLIENT_ENTRY = join(here, '..', 'dist', 'main.js')

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  describeFailure: () => string,
  timeoutMs = 15_000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = false
  while (Date.now() < deadline) {
    last = await check()
    if (last) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out: ${describeFailure()}`)
}

export interface HarnessOptions {
  readonly cols?: number
  readonly rows?: number
  readonly command?: string
  readonly args?: readonly string[]
  /**
   * Extra environment for the pane's process. It goes to the *daemon*, because that is
   * what spawns the pty; the client only names the command.
   */
  readonly env?: Readonly<Record<string, string>>
  /**
   * Answer the client's DECRQM probe for mode 2026 with this value, as a terminal that
   * implements the mode would. Leave undefined to stay silent, like one that does not.
   */
  readonly answerDecrqm?: number
  /**
   * Config TOML for this run, written to the temp root and pointed at by `$LEAP_CHORUS_CONFIG`.
   *
   * It goes to the *daemon*, which owns the file, and reaches the client through
   * `config.get`. Absent means the shipped defaults, sidebar and tab bar included.
   */
  readonly config?: string
}

/**
 * A config with no sidebar and no tab bar.
 *
 * Tests that assert on pane geometry — which column a border is in, where a click
 * lands — want the panes to own the whole screen. `chrome.test.ts` covers the default
 * layout, so turning the furniture off here narrows a test rather than avoiding one.
 */
export const PLAIN_UI_CONFIG = '[ui]\nsidebar = false\ntab-bar = false\n'

export class TuiHarness {
  /** Everything the client has written to its terminal, unparsed. */
  raw = ''
  private readonly emulator: PaneEmulator
  private exited = false
  private exitCode: number | null = null

  private constructor(
    private readonly term: pty.IPty,
    private readonly dataRoot: string,
    readonly paths: DaemonPaths,
    private readonly daemonPid: number,
    emulator: PaneEmulator,
    private cols: number,
    private rows: number
  ) {
    this.emulator = emulator
  }

  static async start(options: HarnessOptions = {}): Promise<TuiHarness> {
    const cols = options.cols ?? 100
    const rows = options.rows ?? 30
    // Short prefix: the endpoint path has a sun_path budget (see daemon/src/paths.ts).
    const dataRoot = mkdtempSync(join(tmpdir(), 'hrt-'))
    const paths = resolveDaemonPaths({ dataRoot })
    const configEnv: Record<string, string> = {}
    if (options.config !== undefined) {
      const configPath = join(dataRoot, 'config.toml')
      writeFileSync(configPath, options.config)
      configEnv['LEAP_CHORUS_CONFIG'] = configPath
    }
    const daemonPid = spawnDetachedDaemon({
      paths,
      env: { ...process.env, ...configEnv, ...(options.env ?? {}) }
    })
    await waitUntil(async () => (await probeDaemon(paths)) !== null, () => `daemon never bound ${paths.socketPath}`)

    const args = [CLIENT_ENTRY, '--data-root', dataRoot]
    if (options.command !== undefined) args.push('--', options.command, ...(options.args ?? []))

    const term = pty.spawn(process.execPath, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: dataRoot,
      env: {
        ...process.env,
        ...configEnv,
        TERM: 'xterm-256color',
        LEAP_CHORUS_DATA_DIR: dataRoot,
        PS1: '$ '
      } as Record<string, string>
    })

    const emulator = new PaneEmulator({ cols, rows, scrollback: 200 })
    const harness = new TuiHarness(term, dataRoot, paths, daemonPid, emulator, cols, rows)

    term.onData((chunk) => {
      harness.raw += chunk
      void emulator.write(chunk)
      if (options.answerDecrqm !== undefined && /\x1b\[\?2026\$p/u.test(chunk)) {
        term.write(`\x1b[?2026;${options.answerDecrqm}$y`)
      }
    })
    term.onExit(({ exitCode }) => {
      harness.exited = true
      harness.exitCode = exitCode
    })
    return harness
  }

  get hasExited(): boolean {
    return this.exited
  }

  get lastExitCode(): number | null {
    return this.exitCode
  }

  /** Where this harness's daemon keeps its state, for driving the CLI against it. */
  get root(): string {
    return this.dataRoot
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  write(data: string): void {
    if (!this.exited) this.term.write(data)
  }

  /**
   * Type raw bytes at the client, the way a terminal does.
   *
   * node-pty types `write` as taking a string but hands a Buffer straight to the fd (see
   * daemon/src/pty-host.ts), which is the only way to deliver a byte that is not valid
   * UTF-8 — and those are exactly the bytes worth testing.
   */
  writeBytes(bytes: Uint8Array): void {
    if (!this.exited) this.term.write(Buffer.from(bytes) as unknown as string)
  }

  /** Send the Ctrl-B prefix plus one command key. */
  command(key: string): void {
    this.write(`\x02${key}`)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols
    this.rows = rows
    this.term.resize(cols, rows)
    this.emulator.resize(cols, rows)
  }

  /** The screen as the terminal would show it, with every pending byte parsed. */
  async screen(): Promise<string> {
    await this.emulator.write(new Uint8Array(0))
    return snapshotToText(this.emulator.snapshot(0, 'active'))
  }

  async cursor(): Promise<{ x: number; y: number; visible: boolean }> {
    await this.emulator.write(new Uint8Array(0))
    return this.emulator.snapshot(0, 'active').cursor
  }

  async bufferKind(): Promise<'normal' | 'alternate'> {
    await this.emulator.write(new Uint8Array(0))
    return this.emulator.snapshot(0, 'active').buffer
  }

  /** Wait until the rendered screen satisfies a predicate. */
  async waitForScreen(predicate: (screen: string) => boolean, describe: string, timeoutMs = 15_000): Promise<string> {
    let seen = ''
    await waitUntil(
      async () => {
        seen = await this.screen()
        return predicate(seen)
      },
      () => `${describe}\n--- last screen ---\n${seen}\n--- end ---`,
      timeoutMs
    )
    return seen
  }

  waitForText(needle: string, timeoutMs = 15_000): Promise<string> {
    return this.waitForScreen((screen) => screen.includes(needle), `screen never showed ${JSON.stringify(needle)}`, timeoutMs)
  }

  /** Wait for the app's first frame: a bordered pane and the status bar. */
  waitForReady(): Promise<string> {
    return this.waitForScreen(
      (screen) => screen.includes('leap-chorus') && screen.includes('┌') && screen.includes('┘'),
      'the TUI never drew its first frame'
    )
  }

  async stop(): Promise<void> {
    if (!this.exited) {
      try {
        this.term.kill()
      } catch {
        // Already gone.
      }
    }
    if (isProcessAlive(this.daemonPid)) {
      try {
        process.kill(this.daemonPid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
    await waitUntil(() => !isProcessAlive(this.daemonPid), () => `daemon ${this.daemonPid} did not exit`, 5_000).catch(
      () => {
        try {
          process.kill(this.daemonPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    )
    this.emulator.dispose()
    rmSync(this.dataRoot, { recursive: true, force: true })
  }
}

/**
 * A marker that a shell's echo of the command producing it will not match.
 *
 * Phase 1 hit this: a test waiting for its own marker matched the tty echo of the command
 * line, and passed before the command had run. Splitting the literal means the echoed
 * line reads `echo ma""rker` while only the output reads `marker`.
 */
export function markerCommand(marker: string): string {
  const cut = Math.max(1, Math.floor(marker.length / 2))
  return `echo ${marker.slice(0, cut)}""${marker.slice(cut)}\r`
}
