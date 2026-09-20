/**
 * Config bindings -> resolved actions, without a daemon or a terminal.
 *
 * The end-to-end half of criterion 6 is in `test/chrome.test.ts`, where a rebound key
 * really does split a real pane. This is the unit half: that the table is built from the
 * config the way the config says, including the parts a screen test cannot show —
 * an unbind, a chord `core` accepted but `parseChord` refuses, and the fact that a
 * modifier the keyboard reports but the chord does not name is masked out.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, validateConfig, type Config } from '@leap-chorus/core'
import { MOD_ALT, MOD_CTRL, MOD_NONE, MOD_SHIFT, type Key } from '@leap-chorus/input'
import { buildKeymap, hintFor, isPrefix } from './keymap.js'

function key(char: string, modifiers = MOD_NONE): Key {
  return { name: 'char', char, modifiers, kind: 'press' }
}

function configFrom(document: unknown): Config {
  return validateConfig(document).config
}

describe('buildKeymap', () => {
  it('installs every default binding', () => {
    const keymap = buildKeymap(DEFAULT_CONFIG)
    expect(keymap.rejected).toEqual([])
    expect(keymap.table.resolve(key('%'), 'prefix')).toBe('pane.split-right')
    expect(keymap.table.resolve(key('z'), 'prefix')).toBe('pane.zoom')
    // A prefix binding must not fire on its own.
    expect(keymap.table.resolve(key('%'), 'direct')).toBeNull()
  })

  it('distinguishes a shifted binding from its lowercase twin', () => {
    const keymap = buildKeymap(DEFAULT_CONFIG)
    expect(keymap.table.resolve(key('h'), 'prefix')).toBe('pane.focus-left')
    // `H` is reported as the unshifted codepoint plus Shift, which is what the chord says.
    expect(keymap.table.resolve(key('h', MOD_SHIFT), 'prefix')).toBe('pane.resize-left')
  })

  it('takes a user binding and an unbind from the config', () => {
    const keymap = buildKeymap(
      configFrom({ keys: { bindings: { 'C-t': 'tab.create', '%': '' } } })
    )
    expect(keymap.table.resolve(key('t', MOD_CTRL), 'prefix')).toBe('tab.create')
    expect(keymap.table.resolve(key('%'), 'prefix')).toBeNull()
  })

  it('installs direct bindings that fire without the prefix', () => {
    const keymap = buildKeymap(
      configFrom({ keys: { 'direct-bindings': { 'A-n': 'tab.next' } } })
    )
    expect(keymap.table.resolve(key('n', MOD_ALT), 'direct')).toBe('tab.next')
    expect(keymap.table.resolve(key('n', MOD_ALT), 'prefix')).toBeNull()
  })

  it('reads the configured prefix', () => {
    const keymap = buildKeymap(configFrom({ keys: { prefix: 'C-a' } }))
    expect(isPrefix(keymap, key('a', MOD_CTRL))).toBe(true)
    expect(isPrefix(keymap, key('b', MOD_CTRL))).toBe(false)
  })

  it('ignores lock modifiers when matching the prefix', () => {
    const keymap = buildKeymap(DEFAULT_CONFIG)
    // Caps Lock is bit 6 in the kitty order; it describes the keyboard, not the chord.
    expect(isPrefix(keymap, key('b', MOD_CTRL | (1 << 6)))).toBe(true)
  })

  it('a release never fires a binding', () => {
    const keymap = buildKeymap(DEFAULT_CONFIG)
    expect(keymap.table.resolve({ ...key('%'), kind: 'release' }, 'prefix')).toBeNull()
  })

  /**
   * `core` validates chords shallowly, because it cannot import the input package's
   * parser without taking a dependency. A chord that passes there and fails here has to
   * be reported rather than silently dropped.
   */
  it('reports a chord core accepted that parseChord refuses', () => {
    const keymap = buildKeymap({
      ...DEFAULT_CONFIG,
      keys: { ...DEFAULT_CONFIG.keys, prefixBindings: { 'not-a-key': 'tab.create' } }
    })
    expect(keymap.rejected).toEqual(['not-a-key'])
  })

  it('reports an unreadable prefix rather than arming nothing silently', () => {
    const keymap = buildKeymap({
      ...DEFAULT_CONFIG,
      keys: { ...DEFAULT_CONFIG.keys, prefix: 'zzz' }
    })
    expect(keymap.prefix).toBeNull()
    expect(keymap.rejected).toContain('zzz')
    expect(isPrefix(keymap, key('z'))).toBe(false)
  })
})

describe('hintFor', () => {
  it('names the keys bound to the commands it is given', () => {
    expect(hintFor(buildKeymap(DEFAULT_CONFIG), ['pane.split-right', 'pane.zoom'])).toBe('% z')
  })

  it('skips a command nothing is bound to', () => {
    const keymap = buildKeymap(configFrom({ keys: { bindings: { z: '' } } }))
    expect(hintFor(keymap, ['pane.split-right', 'pane.zoom'])).toBe('%')
  })
})
