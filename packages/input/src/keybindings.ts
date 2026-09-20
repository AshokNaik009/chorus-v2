/**
 * Chord -> action.
 *
 * The *mechanism* from herdr's `src/input/keybindings.rs` (Apache-2.0, herdr 3f2a6e74):
 * a table keyed on a chord, with two dispatch modes — Direct, where the key fires on its
 * own, and Prefix, where it fires only after the prefix key.
 *
 * herdr's action enum is not ported. It names workspaces, tabs, worktrees and a config
 * system, all of which are phase 4 and beyond, and PHASE-3 says not to build ahead. What
 * is here is the resolution machinery plus the actions the phase-2 client already has, so
 * phase 4 adds rows to a table rather than replacing a switch statement.
 *
 * ## Why a chord and not a character
 *
 * Phase 2 matched on one byte, which is all it could do. A chord carries modifiers, so
 * `prefix h` and `prefix H` are different rows without case-sniffing, and a future
 * `Ctrl+Left` is expressible at all. Comparison masks out Caps Lock and Num Lock, because
 * a binding for `h` must still fire when Caps Lock happens to be on.
 */

import { CHORD_MODIFIERS, MOD_NONE, MOD_SHIFT, type Key, type Modifiers } from './model.js'

/** Whether a binding fires on its own or only after the prefix key. */
export type Dispatch = 'direct' | 'prefix'

/** A chord: the key identity a binding matches on, with no event-kind or text. */
export interface Chord {
  readonly name: Key['name']
  readonly char?: string
  readonly fn?: number
  readonly modifiers: Modifiers
}

export interface Binding<Action> {
  readonly chord: Chord
  readonly dispatch: Dispatch
  readonly action: Action
}

/** Parse `C-b`, `S-Tab`, `A-x`, `F5`, `%`. Returns null for anything it cannot read. */
export function parseChord(text: string): Chord | null {
  if (text.length === 0) return null
  const parts = text.split('-')
  // A trailing empty segment means the base *is* the separator: `-` is minus, `C--` is
  // Ctrl+minus. Splitting produces one more segment than there are dashes, so the base
  // and the empty tail are both dropped.
  let base: string | undefined
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    parts.pop()
    parts.pop()
    base = '-'
  } else {
    base = parts.pop()
  }
  if (base === undefined || base.length === 0) return null

  let modifiers: Modifiers = MOD_NONE
  for (const part of parts) {
    switch (part.toUpperCase()) {
      case 'C':
        modifiers |= 1 << 2
        break
      case 'A':
      case 'M':
        modifiers |= 1 << 1
        break
      case 'S':
        modifiers |= MOD_SHIFT
        break
      case 'D':
        modifiers |= 1 << 3
        break
      default:
        return null
    }
  }

  const named: Record<string, Key['name']> = {
    enter: 'enter',
    tab: 'tab',
    backtab: 'backtab',
    escape: 'escape',
    esc: 'escape',
    backspace: 'backspace',
    delete: 'delete',
    insert: 'insert',
    home: 'home',
    end: 'end',
    pageup: 'pageup',
    pagedown: 'pagedown',
    up: 'up',
    down: 'down',
    left: 'left',
    right: 'right'
  }
  const lower = base.toLowerCase()
  const name = named[lower]
  if (name !== undefined) return { name, modifiers }

  const fn = /^f(\d{1,2})$/u.exec(lower)
  if (fn) {
    const number = Number.parseInt(fn[1] as string, 10)
    if (number >= 1 && number <= 35) return { name: 'f', fn: number, modifiers }
  }

  if ([...base].length !== 1) return null
  // An uppercase letter is Shift plus the unshifted codepoint, because that is what a
  // decoded key carries: `Key.char` is always the unshifted form. Writing `H` in a
  // config and comparing it to a key that reports `h` would never match.
  if (base >= 'A' && base <= 'Z') {
    return { name: 'char', char: base.toLowerCase(), modifiers: modifiers | MOD_SHIFT }
  }
  return { name: 'char', char: base, modifiers }
}

/**
 * Does this key press match this chord?
 *
 * `char` is compared against the key's unshifted codepoint, and — when that misses —
 * against its shifted alternate. The fallback is for the symbols no layout table here
 * could resolve: a config that binds `%` means the key that types `%`, and a terminal
 * speaking the kitty protocol reports that as `5` with Shift and `shiftedChar: '%'`.
 * Without the fallback, `prefix %` would work in every terminal except the ones with
 * the best keyboard support.
 */
export function chordMatches(chord: Chord, key: Key): boolean {
  if (key.name !== chord.name) return false
  if (chord.fn !== undefined && key.fn !== chord.fn) return false
  if (chord.char !== undefined && key.char !== chord.char) {
    if (key.shiftedChar !== chord.char) return false
    // A shifted-alternate match has already accounted for Shift; the chord need not
    // name it, because `%` is not "Shift and something" to anyone who types it.
    return (key.modifiers & CHORD_MODIFIERS & ~MOD_SHIFT) === (chord.modifiers & CHORD_MODIFIERS & ~MOD_SHIFT)
  }
  // Caps Lock and Num Lock describe the keyboard, not the chord.
  return (key.modifiers & CHORD_MODIFIERS) === (chord.modifiers & CHORD_MODIFIERS)
}

export class KeybindingTable<Action> {
  private readonly bindings: Array<Binding<Action>> = []

  /** Add a binding. A later one for the same chord and dispatch wins, so a config can override. */
  bind(chord: Chord | string, dispatch: Dispatch, action: Action): boolean {
    const parsed = typeof chord === 'string' ? parseChord(chord) : chord
    if (parsed === null) return false
    const existing = this.bindings.findIndex(
      (binding) => binding.dispatch === dispatch && sameChordShape(binding.chord, parsed)
    )
    const entry: Binding<Action> = { chord: parsed, dispatch, action }
    if (existing >= 0) this.bindings[existing] = entry
    else this.bindings.push(entry)
    return true
  }

  /** The action for this key, or null. Only presses and repeats fire a binding. */
  resolve(key: Key, dispatch: Dispatch): Action | null {
    if (key.kind === 'release') return null
    for (const binding of this.bindings) {
      if (binding.dispatch !== dispatch) continue
      if (chordMatches(binding.chord, key)) return binding.action
    }
    return null
  }

  get size(): number {
    return this.bindings.length
  }

  list(): ReadonlyArray<Binding<Action>> {
    return this.bindings
  }
}

function sameChordShape(a: Chord, b: Chord): boolean {
  return (
    a.name === b.name &&
    a.char === b.char &&
    a.fn === b.fn &&
    (a.modifiers & CHORD_MODIFIERS) === (b.modifiers & CHORD_MODIFIERS)
  )
}

/** Render a chord the way `parseChord` reads it. For the status bar and for tests. */
export function formatChord(chord: Chord): string {
  const parts: string[] = []
  if ((chord.modifiers & (1 << 2)) !== 0) parts.push('C')
  if ((chord.modifiers & (1 << 1)) !== 0) parts.push('A')
  if ((chord.modifiers & (1 << 3)) !== 0) parts.push('D')
  const shifted = (chord.modifiers & MOD_SHIFT) !== 0
  const letter = chord.name === 'char' && chord.char !== undefined && chord.char >= 'a' && chord.char <= 'z'
  const base =
    chord.name === 'char'
      ? shifted && letter
        ? (chord.char as string).toUpperCase()
        : (chord.char ?? '?')
      : chord.name === 'f'
        ? `F${chord.fn ?? 0}`
        : chord.name
  // Shift on a letter is written as the uppercase letter, matching the parser; on
  // anything else it is spelled out.
  if (shifted && !letter) parts.push('S')
  return [...parts, base].join('-')
}
