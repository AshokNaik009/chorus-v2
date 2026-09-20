import type { SnapshotKeyboard } from '@leap-chorus/protocol'

/**
 * What a keystroke, a mouse event, and a pane's negotiated keyboard protocol are.
 *
 * Derived from herdr's `src/input/model.rs` and `src/input/parse.rs` (Apache-2.0, herdr
 * 3f2a6e74). herdr expresses keys with crossterm's `KeyCode`/`KeyModifiers`, so the
 * *shapes* transliterate but the enumerations do not — they are restated here, with the
 * same kitty codepoint mapping and the same modifier bit order, because those are
 * protocol facts rather than crossterm's opinions.
 *
 * Two decisions that everything downstream leans on:
 *
 * - A key is data, not a string. `encode()` is a pure function of `(Key, protocol)`;
 *   the protocol is a parameter, never ambient state. That is what lets one pane run
 *   kitty keyboard and its neighbour run legacy with no shared mutable mode.
 * - Modifiers are a bitmask in the *kitty* order (shift=1, alt=2, ctrl=4, super=8,
 *   hyper=16, meta=32, caps=64, num=128), because that is the wire order for both the
 *   kitty protocol and xterm's `1;<mod>` encoding. Storing them in any other order means
 *   a conversion on every parse and every encode.
 */

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

export const MOD_NONE = 0
export const MOD_SHIFT = 1 << 0
export const MOD_ALT = 1 << 1
export const MOD_CTRL = 1 << 2
export const MOD_SUPER = 1 << 3
export const MOD_HYPER = 1 << 4
export const MOD_META = 1 << 5
export const MOD_CAPS_LOCK = 1 << 6
export const MOD_NUM_LOCK = 1 << 7

/** A bitmask of the MOD_* flags. */
export type Modifiers = number

/**
 * Modifiers that change what a key *means* rather than describing the keyboard's state.
 *
 * Caps Lock and Num Lock are reported by the kitty protocol but are not chord modifiers:
 * a binding for `a` must still fire when Caps Lock happens to be on. Every comparison
 * against a binding masks with this first.
 */
export const CHORD_MODIFIERS = MOD_SHIFT | MOD_ALT | MOD_CTRL | MOD_SUPER | MOD_HYPER | MOD_META

export function hasModifier(modifiers: Modifiers, flag: number): boolean {
  return (modifiers & flag) !== 0
}

/**
 * Decode an xterm/kitty modifier parameter.
 *
 * The wire carries `1 + mask`, so a bare key is `1` and Shift is `2`. A zero or absent
 * parameter means no modifiers; herdr's `checked_sub(1)` rejects 0 outright, which loses
 * the handful of terminals that send `CSI 1;0 A`, so this saturates instead.
 */
export function modifiersFromParam(param: number | undefined): Modifiers {
  if (param === undefined || !Number.isFinite(param) || param < 1) return MOD_NONE
  return Math.trunc(param) - 1
}

/** The inverse: what goes on the wire for these modifiers. */
export function modifierParam(modifiers: Modifiers): number {
  return (modifiers & 0xff) + 1
}

// ---------------------------------------------------------------------------
// Key codes
// ---------------------------------------------------------------------------

/**
 * A named key, or a character.
 *
 * `char` carries the *unshifted* codepoint the key produces — `a`, not `A`, even when
 * Shift is held; `shiftedChar` carries the shifted alternate when the terminal reported
 * one. Bindings compare against `char`, so `Ctrl+A` and `Ctrl+Shift+A` are distinguishable
 * without a layout table.
 */
export type KeyName =
  | 'char'
  | 'backspace'
  | 'enter'
  | 'tab'
  | 'backtab'
  | 'escape'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'insert'
  | 'delete'
  | 'f'
  | 'capslock'
  | 'scrolllock'
  | 'numlock'
  | 'printscreen'
  | 'pause'
  | 'menu'
  | 'keypadbegin'
  | 'media'
  | 'modifier'
  /** A key the terminal named but this build does not model. Never encoded back. */
  | 'unknown'

export type MediaKeyName =
  | 'play'
  | 'pause'
  | 'playpause'
  | 'reverse'
  | 'stop'
  | 'fastforward'
  | 'rewind'
  | 'tracknext'
  | 'trackprevious'
  | 'record'
  | 'lowervolume'
  | 'raisevolume'
  | 'mutevolume'

export type ModifierKeyName =
  | 'leftshift'
  | 'leftcontrol'
  | 'leftalt'
  | 'leftsuper'
  | 'lefthyper'
  | 'leftmeta'
  | 'rightshift'
  | 'rightcontrol'
  | 'rightalt'
  | 'rightsuper'
  | 'righthyper'
  | 'rightmeta'
  | 'isolevel3shift'
  | 'isolevel5shift'

/**
 * Press, repeat, or release.
 *
 * Only the kitty protocol with REPORT_EVENT_TYPES ever produces `repeat` or `release`.
 * Everything else is a press, and encoding a release for a pane that did not ask for
 * event types would double every keystroke — see `encode`.
 */
export type KeyEventKind = 'press' | 'repeat' | 'release'

export interface Key {
  readonly name: KeyName
  /** Present when `name` is 'char': the unshifted codepoint. */
  readonly char?: string
  /** Present when `name` is 'f': 1..35. */
  readonly fn?: number
  readonly media?: MediaKeyName
  readonly modifierKey?: ModifierKeyName
  readonly modifiers: Modifiers
  readonly kind: KeyEventKind
  /**
   * The shifted alternate the terminal reported, when it did. Kitty only sends this with
   * REPORT_ALTERNATE_KEYS, and only while Shift is active.
   */
  readonly shiftedChar?: string
  /**
   * Text the terminal says this keystroke produced, when it said so.
   *
   * This is the layout's answer, and it beats anything this code could reconstruct: on a
   * French layout `Shift+2` is `é`, and no codepoint arithmetic here would know that. When
   * present and the protocol does not demand physical keys, `encode` emits it verbatim.
   */
  readonly text?: string
  /** Kitty repeat count. 1 unless the terminal said otherwise. */
  readonly repeatCount?: number
}

export function key(name: KeyName, modifiers: Modifiers = MOD_NONE, extra: Partial<Key> = {}): Key {
  return { name, modifiers, kind: 'press', ...extra }
}

export function charKey(char: string, modifiers: Modifiers = MOD_NONE, extra: Partial<Key> = {}): Key {
  return { name: 'char', char, modifiers, kind: 'press', ...extra }
}

export function fnKey(fn: number, modifiers: Modifiers = MOD_NONE, extra: Partial<Key> = {}): Key {
  return { name: 'f', fn, modifiers, kind: 'press', ...extra }
}

/** Two keys are the same chord when the key and its meaning-bearing modifiers match. */
export function sameChord(a: Key, b: Key): boolean {
  return (
    a.name === b.name &&
    a.char === b.char &&
    a.fn === b.fn &&
    a.media === b.media &&
    a.modifierKey === b.modifierKey &&
    (a.modifiers & CHORD_MODIFIERS) === (b.modifiers & CHORD_MODIFIERS)
  )
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

export type MouseButton = 'left' | 'middle' | 'right' | 'none'

export type MouseEventKind =
  | 'down'
  | 'up'
  | 'drag'
  | 'move'
  | 'scrollup'
  | 'scrolldown'
  | 'scrollleft'
  | 'scrollright'

export interface MouseEvent {
  readonly kind: MouseEventKind
  readonly button: MouseButton
  /** Zero-based, in the terminal's own coordinates. The wire is one-based; this is not. */
  readonly column: number
  readonly row: number
  readonly modifiers: Modifiers
  /**
   * Which encoding the report arrived in, so a re-encode for a pane can match it.
   *
   * SGR-pixel reports carry pixel coordinates; `column`/`row` are then the cell they fall
   * in, and `pixel` keeps what was actually reported.
   */
  readonly encoding: MouseEncoding
  readonly pixel?: { readonly x: number; readonly y: number }
}

/**
 * How a mouse report is written on the wire.
 *
 * `x10` is the original `CSI M Cb Cx Cy`, three bytes of `32 + value`. It is the reason
 * this whole package works on bytes: a column past 95 puts a byte above 0x7F in the
 * middle of the report, which no UTF-8 decoding survives.
 */
export type MouseEncoding = 'x10' | 'sgr' | 'sgr-pixels'

// ---------------------------------------------------------------------------
// Keyboard protocol
// ---------------------------------------------------------------------------

/** Kitty keyboard protocol flags, as the `CSI = flags ; mode u` parameter carries them. */
export const KITTY_DISAMBIGUATE_ESCAPE_CODES = 0b0000_0001
export const KITTY_REPORT_EVENT_TYPES = 0b0000_0010
export const KITTY_REPORT_ALTERNATE_KEYS = 0b0000_0100
export const KITTY_REPORT_ALL_KEYS = 0b0000_1000
export const KITTY_REPORT_ASSOCIATED_TEXT = 0b0001_0000

/** xterm's `CSI > 4 ; n m`. Level 0 is off. */
export type ModifyOtherKeysLevel = 0 | 1 | 2

/**
 * What a pane expects its input to look like.
 *
 * One definition, and it lives in `@leap-chorus/protocol`, because it is a shared runtime
 * fact that travels on the snapshot rather than a detail of this package. `encode` takes
 * it as an argument precisely so that it stays pane state and never becomes ambient.
 */
export type KeyboardProtocol = SnapshotKeyboard

export { DEFAULT_SNAPSHOT_KEYBOARD as LEGACY_PROTOCOL } from '@leap-chorus/protocol'
export type { SnapshotKeyboard, SnapshotMouseTracking } from '@leap-chorus/protocol'

export function usesKitty(protocol: KeyboardProtocol): boolean {
  return protocol.kittyFlags !== 0
}

export function reportsEventTypes(protocol: KeyboardProtocol): boolean {
  return (protocol.kittyFlags & KITTY_REPORT_EVENT_TYPES) !== 0
}

export function reportsAllKeys(protocol: KeyboardProtocol): boolean {
  return (protocol.kittyFlags & KITTY_REPORT_ALL_KEYS) !== 0
}

export function reportsAlternateKeys(protocol: KeyboardProtocol): boolean {
  return (protocol.kittyFlags & KITTY_REPORT_ALTERNATE_KEYS) !== 0
}

export function reportsAssociatedText(protocol: KeyboardProtocol): boolean {
  return (protocol.kittyFlags & KITTY_REPORT_ASSOCIATED_TEXT) !== 0
}

// ---------------------------------------------------------------------------
// Input events
// ---------------------------------------------------------------------------

/**
 * Everything the framer can produce.
 *
 * `paste` is one event for the whole bracketed block, however many reads it spanned —
 * PHASE-3's criterion 6 is that a megabyte arrives as one event, not a million.
 * `unknown` carries a complete but unrecognized sequence: it is deliberately *not*
 * dropped, because forwarding it to the pane verbatim is how a terminal feature this
 * build has never heard of still works.
 */
export type InputEvent =
  | { readonly type: 'key'; readonly key: Key; readonly bytes: Uint8Array }
  | { readonly type: 'mouse'; readonly mouse: MouseEvent; readonly bytes: Uint8Array }
  | { readonly type: 'paste'; readonly data: Uint8Array }
  | { readonly type: 'focus'; readonly focused: boolean }
  | { readonly type: 'unknown'; readonly bytes: Uint8Array }

/** A short, stable description of a key. Used by bindings, tests, and the status bar. */
export function describeKey(k: Key): string {
  const parts: string[] = []
  if (hasModifier(k.modifiers, MOD_CTRL)) parts.push('C')
  if (hasModifier(k.modifiers, MOD_ALT)) parts.push('A')
  if (hasModifier(k.modifiers, MOD_SHIFT)) parts.push('S')
  if (hasModifier(k.modifiers, MOD_SUPER)) parts.push('D')
  const base =
    k.name === 'char'
      ? (k.char ?? '?')
      : k.name === 'f'
        ? `F${k.fn ?? 0}`
        : k.name === 'media'
          ? (k.media ?? 'media')
          : k.name === 'modifier'
            ? (k.modifierKey ?? 'modifier')
            : k.name
  return [...parts, base].join('-')
}
