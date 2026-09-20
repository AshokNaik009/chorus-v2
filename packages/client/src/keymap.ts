/**
 * Config bindings -> a live keybinding table.
 *
 * This is the join PHASE-4 criterion 6 asks for: a chord in a TOML file has to end up
 * firing an action. `core` validated the names and shapes; `@leap-chorus/input` owns chord
 * parsing and matching; this is the three lines between them, plus the one thing
 * neither could do alone — reporting a chord that `core`'s shallow check accepted and
 * `parseChord` then refused.
 */

import { bindingEntries, type Config } from '@leap-chorus/core'
import { KeybindingTable, parseChord, type Chord, type Key } from '@leap-chorus/input'

export interface Keymap {
  readonly table: KeybindingTable<string>
  /** The chord that arms prefix bindings, or null when the config named an unreadable one. */
  readonly prefix: Chord | null
  /** Chords the config named that could not be parsed. Shown in the status bar. */
  readonly rejected: readonly string[]
}

export function buildKeymap(config: Config): Keymap {
  const table = new KeybindingTable<string>()
  const rejected: string[] = []

  for (const entry of bindingEntries(config)) {
    if (!table.bind(entry.chord, entry.dispatch, entry.command)) rejected.push(entry.chord)
  }
  const prefix = parseChord(config.keys.prefix)
  if (prefix === null) rejected.push(config.keys.prefix)

  return { table, prefix, rejected }
}

/** Does this key press arm the prefix? */
export function isPrefix(keymap: Keymap, key: Key): boolean {
  if (keymap.prefix === null) return false
  if (key.name !== keymap.prefix.name) return false
  if (keymap.prefix.char !== undefined && key.char !== keymap.prefix.char) return false
  // Caps Lock and Num Lock describe the keyboard, not the chord; `chordMatches` masks
  // them out and so must this.
  return (key.modifiers & 0b1111) === (keymap.prefix.modifiers & 0b1111)
}

/**
 * The bindings to advertise in the status bar, shortest first.
 *
 * Shortest first because the bar has room for six or seven and the single-character
 * ones are the ones worth showing.
 */
export function hintFor(keymap: Keymap, commands: readonly string[]): string {
  const hints: string[] = []
  for (const command of commands) {
    const binding = keymap.table.list().find((entry) => entry.dispatch === 'prefix' && entry.action === command)
    if (binding === undefined) continue
    hints.push(binding.chord.name === 'char' ? (binding.chord.char ?? '?') : binding.chord.name)
  }
  return hints.join(' ')
}
