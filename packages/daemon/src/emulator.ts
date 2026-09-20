/**
 * One `@xterm/headless` Terminal per pane.
 *
 * Two things about @xterm/headless 6.0.0 that shape this file:
 *
 * 1. No `window` polyfill is needed under plain Node. The bundle's single `window`
 *    reference is guarded by an `isNode` probe that short-circuits first. orca needs a
 *    polyfill only because Electron's ELECTRON_RUN_AS_NODE breaks that probe. We are not
 *    Electron.
 * 2. It is CJS-only, with no `exports` map, so Node's ESM interop surfaces only
 *    `default`. `import { Terminal } from '@xterm/headless'` is a TypeError at runtime;
 *    the default import below is the working form.
 *
 * `write()` is asynchronous — the data goes through an internal queue, so a snapshot
 * taken on the next line can be stale. Every write here returns a promise that settles
 * when that chunk has been parsed.
 */

import xterm from '@xterm/headless'
import { KeyboardProtocolState } from '@leap-chorus/input'
import type { SnapshotKeyboard, SnapshotMouseTracking, TerminalSnapshot } from '@leap-chorus/protocol'
import { bufferTextLines, captureSnapshot, type SnapshotBufferSelector } from './snapshot.js'

/** xterm reports mouse tracking as its own enum; map it to the wire vocabulary. */
function mouseTrackingOf(mode: string): SnapshotMouseTracking {
  switch (mode) {
    case 'x10':
      return 'x10'
    case 'vt200':
      return 'vt200'
    case 'drag':
      return 'drag'
    case 'any':
      return 'any'
    default:
      return 'none'
  }
}

const { Terminal } = xterm

export interface EmulatorOptions {
  readonly cols: number
  readonly rows: number
  readonly scrollback?: number
}

const DEFAULT_SCROLLBACK = 5000

export class PaneEmulator {
  private readonly terminal: xterm.Terminal
  private readonly titleListeners = new Set<(title: string) => void>()
  private title: string | null = null
  /** The payload of the last OSC 9;4, without its `4;` prefix. */
  private progress = ''
  // DECTCEM is not on xterm's public IModes, so it is observed off the parser.
  private cursorVisible = true
  /** Keyboard protocol negotiation, observed off the parser. See registerKeyboardProtocolHandlers. */
  private readonly keyboard = new KeyboardProtocolState()
  private disposed = false
  /** Bytes handed to write() that have not finished parsing. Drives PTY backpressure. */
  private inflightBytes = 0

  constructor(options: EmulatorOptions) {
    this.terminal = new Terminal({
      cols: Math.max(1, options.cols),
      rows: Math.max(1, options.rows),
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
      // Required for `terminal.parser`, which throws without it. Phase 3 needs the parser
      // to track keyboard protocol modes; turning it on now costs nothing.
      allowProposedApi: true,
      logLevel: 'off'
    })

    this.terminal.onTitleChange((title) => {
      this.title = title
      for (const listener of this.titleListeners) listener(title)
    })

    // Observe DECTCEM without consuming it: returning false lets xterm's own handler run.
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(25)) this.cursorVisible = true
      // DECCKM. xterm tracks it on IModes too, but reading it here keeps the whole
      // keyboard picture in one object rather than two places that can disagree.
      if (params.includes(1)) this.keyboard.setApplicationCursorKeys(true)
      return false
    })
    this.terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.includes(25)) this.cursorVisible = false
      if (params.includes(1)) this.keyboard.setApplicationCursorKeys(false)
      return false
    })

    this.registerKeyboardProtocolHandlers()
    this.registerProgressHandler()
  }

  /**
   * Capture OSC 9;4, the progress sequence.
   *
   * Detection reads it as its own region: an agent that reports progress this way
   * costs nothing per byte to watch, where screen matching costs a region scan per
   * poll. Observed, never consumed — returning false leaves the sequence for anything
   * else that wants it, and xterm ignores it.
   */
  private registerProgressHandler(): void {
    this.terminal.parser.registerOscHandler(9, (data) => {
      // Only the `4;state;percent` form is progress; OSC 9 is also a notification.
      if (data.startsWith('4;')) this.progress = data.slice(2)
      return false
    })
  }

  /**
   * Watch the four sequences that negotiate a keyboard protocol.
   *
   * These are *consumed* — every handler returns true. They are negotiation between the
   * program and its terminal, and this daemon is that terminal; letting xterm's default
   * `CSI m` / `CSI u` handling also see them would be wrong twice over, since `CSI > … m`
   * is nothing like SGR and `CSI … u` is nothing like a cursor restore.
   *
   * `term.parser` throws unless the Terminal was built with `allowProposedApi: true`,
   * which the constructor above does.
   */
  private registerKeyboardProtocolHandlers(): void {
    // XTMODKEYS: `CSI > 4 ; n m`. Other resources exist on `>` + `m`; only 4 is ours.
    this.terminal.parser.registerCsiHandler({ prefix: '>', final: 'm' }, (params) => {
      if (params.length === 0 || params[0] !== 4) return false
      this.keyboard.setModifyOtherKeys(params.length > 1 ? (params[1] as number) : undefined)
      return true
    })
    // Kitty: push, set, pop.
    this.terminal.parser.registerCsiHandler({ prefix: '>', final: 'u' }, (params) => {
      this.keyboard.push(params.length > 0 ? (params[0] as number) : 0)
      return true
    })
    this.terminal.parser.registerCsiHandler({ prefix: '=', final: 'u' }, (params) => {
      const flags = params.length > 0 ? (params[0] as number) : 0
      const mode = params.length > 1 ? (params[1] as number) : 1
      this.keyboard.set(flags, mode === 2 ? 2 : mode === 3 ? 3 : 1)
      return true
    })
    this.terminal.parser.registerCsiHandler({ prefix: '<', final: 'u' }, (params) => {
      this.keyboard.pop(params.length > 0 ? (params[0] as number) : 1)
      return true
    })
    // DECKPAM / DECKPNM are ESC = and ESC >, not CSI.
    this.terminal.parser.registerEscHandler({ final: '=' }, () => {
      this.keyboard.setApplicationKeypad(true)
      return false
    })
    this.terminal.parser.registerEscHandler({ final: '>' }, () => {
      this.keyboard.setApplicationKeypad(false)
      return false
    })
  }

  /**
   * What the pane expects its input to look like.
   *
   * The two modes xterm already tracks are read from it rather than shadowed, so there is
   * no second copy to drift.
   */
  keyboardProtocol(): SnapshotKeyboard {
    const modes = this.terminal.modes
    this.keyboard.setEmulatorModes({
      bracketedPaste: modes.bracketedPasteMode,
      mouseTracking: mouseTrackingOf(modes.mouseTrackingMode)
    })
    return this.keyboard.snapshot()
  }

  get cols(): number {
    return this.terminal.cols
  }

  get rows(): number {
    return this.terminal.rows
  }

  get bufferType(): 'normal' | 'alternate' {
    return this.terminal.buffer.active.type
  }

  get currentTitle(): string | null {
    return this.title
  }

  onTitleChange(listener: (title: string) => void): () => void {
    this.titleListeners.add(listener)
    return () => this.titleListeners.delete(listener)
  }

  /** Bytes accepted but not yet parsed. A flooding pane shows up here first. */
  get pendingBytes(): number {
    return this.inflightBytes
  }

  /**
   * Feed PTY output. Resolves once this chunk has been parsed, so a caller that awaits
   * it is reading a settled buffer — and a caller that counts unresolved writes has a
   * true measure of how far behind the emulator is.
   */
  write(bytes: Uint8Array): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.inflightBytes += bytes.byteLength
    return new Promise<void>((resolve) => {
      this.terminal.write(bytes, () => {
        this.inflightBytes -= bytes.byteLength
        resolve()
      })
    })
  }

  /** Feed a string (used by tests and by replayed control sequences). */
  writeText(text: string): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const bytes = Buffer.byteLength(text, 'utf8')
    this.inflightBytes += bytes
    return new Promise<void>((resolve) => {
      this.terminal.write(text, () => {
        this.inflightBytes -= bytes
        resolve()
      })
    })
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return
    this.terminal.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)))
  }

  snapshot(
    sequence: number,
    buffer: SnapshotBufferSelector = 'active',
    scrollOffset = 0
  ): TerminalSnapshot {
    return captureSnapshot(this.terminal, {
      buffer,
      sequence,
      scrollOffset,
      title: this.title,
      cursorVisible: this.cursorVisible,
      keyboard: this.keyboardProtocol()
    })
  }

  /**
   * Every content row as text, scrollback included.
   *
   * Copy mode reads this: a selection, a motion or a search can reach anywhere in the
   * history, which a one-screen snapshot cannot express. It is a fresh array each call
   * and is therefore not something to put on the render path.
   */
  textLines(buffer: SnapshotBufferSelector = 'active'): string[] {
    return bufferTextLines(this.terminal, buffer)
  }

  /** Lines held above the screen. `pane.scroll` clamps against this. */
  get scrollbackLines(): number {
    return this.terminal.buffer.active.baseY
  }

  /** What the last OSC 9;4 reported, as a manifest `osc_progress` region sees it. */
  get currentProgress(): string {
    return this.progress
  }

  /**
   * The text agent detection runs against.
   *
   * Three decisions, each load-bearing:
   *
   * 1. **The live screen, not the user's viewport.** A user who scrolls up to read
   *    something must not change what their pane reports; herdr's rule, stated in its
   *    CLAUDE.md as "do not use the user-visible viewport for agent status because
   *    users can scroll it". So this reads from `baseY`, ignoring `scrollOffset`.
   * 2. **The whole screen, not the bottom N lines.** Regions do the narrowing, and
   *    they narrow from both ends — codex's trust prompt is matched with
   *    `top_non_empty_lines(20)`. Handing regions a pre-trimmed tail would silently
   *    break the rules that read from the top.
   * 3. **Trailing blank rows dropped.** A terminal pads its screen to full height, so
   *    `bottom_non_empty_lines(12)` over a padded buffer would otherwise be counting
   *    from a floor of empty rows.
   */
  detectionScreen(): string {
    const buffer = this.terminal.buffer.active
    const lines: string[] = []
    for (let y = buffer.baseY; y < buffer.baseY + this.terminal.rows; y++) {
      const line = buffer.getLine(y)
      lines.push(line ? line.translateToString(true) : '')
    }
    let end = lines.length
    while (end > 0 && (lines[end - 1] as string).trim().length === 0) end -= 1
    return lines.slice(0, end).join('\n')
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.terminal.dispose()
  }
}
