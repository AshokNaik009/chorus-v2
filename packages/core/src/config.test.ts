import { describe, expect, it } from 'vitest'
import { COMMANDS, isCommandName } from './commands.js'
import {
  DEFAULT_CONFIG,
  bindingEntries,
  configKeys,
  looksLikeChord,
  validateConfig
} from './config.js'

describe('defaults', () => {
  it('validate an empty document to the defaults, with no complaints', () => {
    const { config, problems } = validateConfig({})
    expect(problems).toEqual([])
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('every default binding names a real command', () => {
    for (const [chord, command] of Object.entries(DEFAULT_CONFIG.keys.prefixBindings)) {
      expect(isCommandName(command), `${chord} -> ${command}`).toBe(true)
      expect(looksLikeChord(chord), `${chord} is unreadable`).toBe(true)
    }
  })

  it('every schema key has a field path', () => {
    // `configKeys` walks the schema; validating a document that sets all of them at
    // their defaults must produce no `unknown-key`.
    for (const key of configKeys()) {
      const [section, field] = key.split('.') as [string, string]
      const { problems } = validateConfig({ [section]: { [field]: fixtureFor(key) } })
      expect(
        problems.filter((problem) => problem.kind === 'unknown-key'),
        `${key} is in the schema but has no field path`
      ).toEqual([])
    }
  })
})

function fixtureFor(key: string): unknown {
  if (key === 'keys.prefix') return 'C-a'
  if (key.endsWith('bindings')) return {}
  if (key === 'general.shell' || key === 'general.cwd') return '/bin/sh'
  if (key.startsWith('theme.')) return 4
  if (key === 'general.scrollback') return 100
  if (key === 'general.scroll-step') return 3
  if (key === 'ui.sidebar-width') return 30
  return true
}

describe('validation', () => {
  it('reports an unknown section by name', () => {
    const { problems } = validateConfig({ nonsense: {} })
    expect(problems).toEqual([{ kind: 'unknown-key', path: 'nonsense', message: 'unknown section [nonsense]' }])
  })

  it('reports an unknown key by full dotted path', () => {
    const { problems } = validateConfig({ ui: { 'sidebar-colour': 3 } })
    expect(problems[0]).toMatchObject({ kind: 'unknown-key', path: 'ui.sidebar-colour' })
    expect(problems[0]?.message).toContain('ui.sidebar-colour')
  })

  it('reports a wrong type and keeps the default', () => {
    const { config, problems } = validateConfig({ ui: { sidebar: 'yes' } })
    expect(problems[0]).toMatchObject({ kind: 'wrong-type', path: 'ui.sidebar' })
    expect(config.ui.sidebar).toBe(DEFAULT_CONFIG.ui.sidebar)
  })

  it('reports an out-of-range number and keeps the default', () => {
    const { config, problems } = validateConfig({ ui: { 'sidebar-width': 500 } })
    expect(problems[0]).toMatchObject({ kind: 'out-of-range', path: 'ui.sidebar-width' })
    expect(config.ui.sidebarWidth).toBe(DEFAULT_CONFIG.ui.sidebarWidth)
  })

  it('accepts a value in range', () => {
    const { config, problems } = validateConfig({ ui: { 'sidebar-width': 30 } })
    expect(problems).toEqual([])
    expect(config.ui.sidebarWidth).toBe(30)
  })

  it('reports a section that is not a table', () => {
    const { problems } = validateConfig({ ui: 3 })
    expect(problems[0]).toMatchObject({ kind: 'wrong-type', path: 'ui' })
  })

  it('collects every problem rather than stopping at the first', () => {
    const { problems } = validateConfig({
      ui: { sidebar: 'yes', 'sidebar-width': 500, nope: 1 },
      bogus: {}
    })
    expect(problems).toHaveLength(4)
  })
})

describe('keybindings', () => {
  it('a user binding adds to the defaults rather than replacing them', () => {
    const { config, problems } = validateConfig({ keys: { bindings: { 'C-t': 'tab.create' } } })
    expect(problems).toEqual([])
    expect(config.keys.prefixBindings['C-t']).toBe('tab.create')
    // `%` still splits.
    expect(config.keys.prefixBindings['%']).toBe('pane.split-right')
  })

  it('an empty command unbinds a default', () => {
    const { config } = validateConfig({ keys: { bindings: { '%': '' } } })
    expect(config.keys.prefixBindings['%']).toBeUndefined()
  })

  it('rebinding a default replaces it', () => {
    const { config } = validateConfig({ keys: { bindings: { '%': 'tab.create' } } })
    expect(config.keys.prefixBindings['%']).toBe('tab.create')
  })

  it('reports a command that does not exist, by chord', () => {
    const { problems } = validateConfig({ keys: { bindings: { 'C-t': 'pane.teleport' } } })
    expect(problems[0]).toMatchObject({ kind: 'unknown-command' })
    expect(problems[0]?.path).toContain('C-t')
    expect(problems[0]?.message).toContain('pane.teleport')
  })

  it('reports an unreadable chord', () => {
    const { problems } = validateConfig({ keys: { bindings: { 'Q-x': 'tab.create' } } })
    expect(problems[0]).toMatchObject({ kind: 'bad-chord' })
  })

  it('reports an unreadable prefix and keeps C-b', () => {
    const { config, problems } = validateConfig({ keys: { prefix: 'Q-z' } })
    expect(problems[0]).toMatchObject({ kind: 'bad-chord', path: 'keys.prefix' })
    expect(config.keys.prefix).toBe('C-b')
  })

  it('direct bindings are separate from prefix ones', () => {
    const { config } = validateConfig({ keys: { 'direct-bindings': { 'C-S-Left': 'pane.focus-left' } } })
    const entries = bindingEntries(config)
    expect(entries.find((entry) => entry.chord === 'C-S-Left')?.dispatch).toBe('direct')
    expect(entries.find((entry) => entry.chord === '%')?.dispatch).toBe('prefix')
  })

  it('`-` and `C--` are readable chords', () => {
    expect(looksLikeChord('-')).toBe(true)
    expect(looksLikeChord('C--')).toBe(true)
    expect(looksLikeChord('')).toBe(false)
  })
})

describe('the command catalog', () => {
  it('has no duplicates', () => {
    const names = COMMANDS.map((command) => command.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('separates client-local commands from session ones', () => {
    const client = COMMANDS.filter((command) => command.scope === 'client').map((command) => command.name)
    expect(client).toContain('client.quit')
    expect(client).not.toContain('pane.split-right')
  })
})
