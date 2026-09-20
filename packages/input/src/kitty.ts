/**
 * Keyboard protocol state, tracked per pane off the emulator's CSI handlers.
 *
 * PHASE-3 settled where this lives: `@xterm/headless` 6.0.0's `IModes` exposes ten modes
 * and neither the kitty keyboard protocol nor modifyOtherKeys is among them, so both are
 * observed through `term.parser.registerCsiHandler` in the daemon, beside the emulator
 * that saw the sequence. It rides the snapshot to the client, and `encodeKey` takes it as
 * a parameter. Nothing here is ambient.
 *
 * The kitty *stack* is ours to model — xterm keeps none:
 *
 *   CSI > flags u    push a new entry
 *   CSI = flags ; mode u   set the current entry (mode 1 set, 2 or-in, 3 and-not)
 *   CSI < n u        pop n entries
 *
 * A pop on an empty stack is not an error and must not throw: the spec says the terminal
 * simply has nothing to pop, and a program that pops more than it pushed is common enough
 * that crashing on it would be the bug.
 */

import { type KeyboardProtocol, type ModifyOtherKeysLevel, type SnapshotMouseTracking } from './model.js'

/** The kitty spec's cap. Past this, a program is not pushing, it is leaking. */
export const MAX_KITTY_STACK_DEPTH = 16

/** How `CSI = flags ; mode u` applies `flags` to the current entry. */
export type KittySetMode = 1 | 2 | 3

export class KeyboardProtocolState {
  /**
   * The stack of kitty flag sets. Empty means the protocol is not in use, which is not
   * the same as "in use with no flags" — a program can legitimately push 0.
   */
  private stack: number[] = []
  private modifyOtherKeysLevel: ModifyOtherKeysLevel = 0
  private applicationCursor = false
  private applicationKeypadMode = false
  private bracketedPasteMode = false
  private mouse: SnapshotMouseTracking = 'none'

  /** The flags currently in force, or 0 when the stack is empty. */
  get kittyFlags(): number {
    return this.stack.length === 0 ? 0 : (this.stack[this.stack.length - 1] as number)
  }

  get depth(): number {
    return this.stack.length
  }

  get modifyOtherKeys(): ModifyOtherKeysLevel {
    return this.modifyOtherKeysLevel
  }

  /** `CSI > flags u`. */
  push(flags: number): void {
    // Silently ignore a push past the cap rather than growing without bound. The program
    // keeps whatever was in force, which is the least surprising failure.
    if (this.stack.length >= MAX_KITTY_STACK_DEPTH) return
    this.stack.push(normalizeFlags(flags))
  }

  /** `CSI < n u`. A pop on an empty stack is a no-op, not an error. */
  pop(count = 1): void {
    const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
    for (let i = 0; i < n && this.stack.length > 0; i++) this.stack.pop()
  }

  /**
   * `CSI = flags ; mode u`.
   *
   * With an empty stack this pushes, because a program that sets flags without pushing
   * first still means to turn the protocol on — which is what kitty itself does.
   */
  set(flags: number, mode: KittySetMode = 1): void {
    const value = normalizeFlags(flags)
    if (this.stack.length === 0) {
      this.stack.push(mode === 3 ? 0 : value)
      return
    }
    const current = this.stack[this.stack.length - 1] as number
    this.stack[this.stack.length - 1] =
      mode === 2 ? current | value : mode === 3 ? current & ~value : value
  }

  /** `CSI ? flags u`: what the pane would report if asked. */
  query(): number {
    return this.kittyFlags
  }

  /** `CSI > 4 ; n m`. An absent or out-of-range parameter means 0. */
  setModifyOtherKeys(level: number | undefined): void {
    this.modifyOtherKeysLevel = level === 1 ? 1 : level === 2 ? 2 : 0
  }

  /** DECCKM, mode 1. Tracked here so `encodeKey` gets one protocol object. */
  setApplicationCursorKeys(enabled: boolean): void {
    this.applicationCursor = enabled
  }

  /** DECKPAM / DECKPNM. */
  setApplicationKeypad(enabled: boolean): void {
    this.applicationKeypadMode = enabled
  }

  /**
   * Modes the emulator already tracks, copied in each snapshot.
   *
   * These two come from xterm's own `IModes` rather than from a CSI handler, so they are
   * pushed in rather than observed here — but they belong in the same object, because a
   * client encoding input needs all of it at once.
   */
  setEmulatorModes(modes: { bracketedPaste: boolean; mouseTracking: SnapshotMouseTracking }): void {
    this.bracketedPasteMode = modes.bracketedPaste
    this.mouse = modes.mouseTracking
  }

  /** A full reset (RIS, or the pane's program exiting) clears everything. */
  reset(): void {
    this.stack = []
    this.modifyOtherKeysLevel = 0
    this.applicationCursor = false
    this.applicationKeypadMode = false
    this.bracketedPasteMode = false
    this.mouse = 'none'
  }

  /** The immutable snapshot `encodeKey` takes, and the one that rides to the client. */
  snapshot(): KeyboardProtocol {
    return {
      kittyFlags: this.kittyFlags,
      modifyOtherKeys: this.modifyOtherKeysLevel,
      applicationCursorKeys: this.applicationCursor,
      applicationKeypad: this.applicationKeypadMode,
      bracketedPaste: this.bracketedPasteMode,
      mouseTracking: this.mouse
    }
  }

  /** Restore from a snapshot, so a reattaching client does not lose the pane's state. */
  static fromSnapshot(snapshot: KeyboardProtocol): KeyboardProtocolState {
    const state = new KeyboardProtocolState()
    if (snapshot.kittyFlags !== 0) state.stack = [normalizeFlags(snapshot.kittyFlags)]
    state.modifyOtherKeysLevel = snapshot.modifyOtherKeys
    state.applicationCursor = snapshot.applicationCursorKeys
    state.applicationKeypadMode = snapshot.applicationKeypad
    state.bracketedPasteMode = snapshot.bracketedPaste
    state.mouse = snapshot.mouseTracking
    return state
  }
}

/** The five defined bits. A program setting reserved bits gets them dropped, not honoured. */
function normalizeFlags(flags: number): number {
  if (!Number.isFinite(flags) || flags < 0) return 0
  return Math.trunc(flags) & 0b0001_1111
}
