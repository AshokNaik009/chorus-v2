/**
 * The `[sidebar]` block, and the enum validation it needed.
 *
 * Criterion 7 asks that these settings "round-trip: set in the dialog, written to the
 * config file, survive a restart". The file half is `config-loader`'s and is tested
 * there; this is the schema half — that every key is known, that every default is the
 * behaviour phases 7 and 8 already shipped, and that a wrong value is reported with the
 * alternatives rather than accepted.
 *
 * ## Why an `enum` kind was added rather than reusing `string`
 *
 * `ui.pane-buttons` has been a bare `string` since phase 4, which meant
 * `pane-buttons = "sideway"` validated cleanly and then fell through every branch of the
 * renderer to whatever the last `else` happened to be — a setting silently doing
 * something the user did not ask for. Three of the four new keys are that same shape and
 * all of them are reachable from a dialog, so the set is declared and checked.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, configKeys, validateConfig } from './config.js'

describe('the defaults are what phases 7 and 8 already did', () => {
  it('changes nothing for a user who never opens the dialog', () => {
    // Every one of these is the behaviour that shipped before this block existed. A
    // default that changed the dock for somebody who did not ask would be a regression
    // dressed as a feature.
    expect(DEFAULT_CONFIG.sidebar).toEqual({
      dock: 'left',
      layout: 'separate',
      icons: 'ascii',
      gitFooter: false,
      followPane: true,
      rememberView: false,
      preview: false,
      aiCommit: false,
      // `auto` is the one default here that does something conditionally, and it is
      // still the "changes nothing" answer: it means *the editor this terminal belongs
      // to, if it belongs to one*, and in a plain terminal no editor is detected and
      // the click selects exactly as it did before. See `client/src/editor.ts`.
      openWith: 'auto'
    })
  })

  it('icons default to ascii, which is a width decision and not a taste one', () => {
    // Nerd Font glyphs are Private Use Area code points and `codePointWidth` measures
    // them as one column; a terminal that disagrees shifts every mouse hit region on the
    // row. See `packages/client/src/icons.ts`.
    expect(DEFAULT_CONFIG.sidebar.icons).toBe('ascii')
  })

  it('the one switch that can send a working tree to a model is off', () => {
    expect(DEFAULT_CONFIG.sidebar.aiCommit).toBe(false)
  })
})

describe('reading a [sidebar] block', () => {
  it('takes every key', () => {
    const { config, problems } = validateConfig({
      sidebar: {
        dock: 'right',
        layout: 'unified',
        icons: 'nerd',
        'git-footer': true,
        'follow-pane': false,
        'remember-view': true,
        preview: true,
        'ai-commit': true,
        'open-with': 'cursor'
      }
    })
    expect(problems).toEqual([])
    expect(config.sidebar).toEqual({
      dock: 'right',
      layout: 'unified',
      icons: 'nerd',
      gitFooter: true,
      followPane: false,
      rememberView: true,
      preview: true,
      aiCommit: true,
      openWith: 'cursor'
    })
  })

  it('a key left out keeps its default rather than becoming undefined', () => {
    const { config } = validateConfig({ sidebar: { dock: 'right' } })
    expect(config.sidebar.dock).toBe('right')
    expect(config.sidebar.icons).toBe('ascii')
    expect(config.sidebar.followPane).toBe(true)
  })

  it('every schema key is reachable by its dotted path', () => {
    const keys = configKeys()
    for (const key of [
      'sidebar.dock',
      'sidebar.layout',
      'sidebar.icons',
      'sidebar.git-footer',
      'sidebar.follow-pane',
      'sidebar.remember-view',
      'sidebar.preview',
      'sidebar.ai-commit',
      'sidebar.open-with'
    ]) {
      expect(keys).toContain(key)
    }
  })

  it('an unknown key under [sidebar] is named by its full path', () => {
    const { problems } = validateConfig({ sidebar: { 'dock-side': 'right' } })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatchObject({ kind: 'unknown-key', path: 'sidebar.dock-side' })
  })
})

describe('a value outside the set is refused, with the set', () => {
  it('names the alternatives rather than only the rejection', () => {
    const { config, problems } = validateConfig({ sidebar: { dock: 'sideways' } })
    expect(problems).toHaveLength(1)
    expect(problems[0]?.kind).toBe('bad-value')
    // A config key with two legal values should never send anybody to the documentation.
    expect(problems[0]?.message).toContain('"left"')
    expect(problems[0]?.message).toContain('"right"')
    expect(problems[0]?.message).toContain('sideways')
    // And the key stays at its default: one bad key must not stop leap-chorus starting.
    expect(config.sidebar.dock).toBe('left')
  })

  it('checks layout and icons the same way', () => {
    expect(validateConfig({ sidebar: { layout: 'split' } }).problems[0]?.kind).toBe('bad-value')
    expect(validateConfig({ sidebar: { icons: 'nerdfont' } }).problems[0]?.kind).toBe('bad-value')
  })

  it('a number where a name belongs is a type problem, not a value one', () => {
    const { problems } = validateConfig({ sidebar: { dock: 3 } })
    expect(problems[0]?.kind).toBe('wrong-type')
  })

  it('closes the pane-buttons hole it was added for', () => {
    // This validated cleanly before the `enum` kind existed, and then picked whatever
    // the renderer's last `else` did.
    const { config, problems } = validateConfig({ ui: { 'pane-buttons': 'sideway' } })
    expect(problems[0]?.kind).toBe('bad-value')
    expect(config.ui.paneButtons).toBe('icons')
    // The three real values still pass.
    for (const value of ['icons', 'ascii', 'off']) {
      expect(validateConfig({ ui: { 'pane-buttons': value } }).problems).toEqual([])
    }
  })
})
