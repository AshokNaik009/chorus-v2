/**
 * The config schema: defaults, merge, validation, and unknown-key reporting.
 *
 * ## Where the TOML parser is, and why it is not here
 *
 * PHASE-4 names this collision explicitly: `core` must have zero runtime dependencies,
 * and Node has no built-in TOML parser. The split it recommends is the one taken here —
 * `core` owns the *schema* and operates on a plain object, and `@leap-chorus/config-loader`
 * owns turning TOML text into that object, plus the file I/O and the search path.
 *
 * `config-loader` did not need a dependency either, in the end: it carries a TOML
 * parser written for this project (~400 lines, the subset a config file uses). So the
 * repository still has no third-party config dependency, and `core` still has none of
 * anything. See `packages/config-loader/src/toml.ts`.
 *
 * ## Validation
 *
 * `validateConfig` walks the schema against a parsed object and returns *both* a
 * merged, fully-populated config and a list of problems. It never throws: a config
 * with one bad key should start leap-chorus with that key at its default and a warning on
 * screen, not refuse to start. Unknown keys are reported by full dotted path, because
 * "unknown key" without the path is the single least useful diagnostic a config system
 * can emit.
 */

import { isCommandName } from './commands.js'

// ---------------------------------------------------------------------------
// The config itself
// ---------------------------------------------------------------------------

export interface GeneralConfig {
  /** The program a new pane runs. Empty means the user's login shell. */
  readonly shell: string
  /** Where a new workspace starts. Empty means the user's home directory. */
  readonly cwd: string
  /** Lines of scrollback each pane retains. */
  readonly scrollback: number
  /** Ask the host terminal for mouse reports. */
  readonly mouse: boolean
  /**
   * Highlight the sidebar row under the pointer.
   *
   * **On by default**, and the reason is feedback rather than decoration. A session
   * with one workspace and one pane has nothing a click can visibly change — clicking
   * the active pane focuses the pane that already had focus — so with no hover the UI
   * is indistinguishable from one where the mouse is broken. That is not a
   * hypothetical: it was the first thing a user hit.
   *
   * It costs DEC 1003, any-motion reporting, which fires per cell crossed. Measured
   * on this codebase: moving onto a new row repaints that row for 66 bytes, and
   * moving *within* a row costs nothing at all, because the handler compares the row
   * and returns early. That is cheap enough to be worth knowing your pointer works.
   */
  readonly mouseHover: boolean
  /** Rows a `pane.scroll-up` step moves, or 0 for one screen. */
  readonly scrollStep: number
}

export interface UiConfig {
  readonly sidebar: boolean
  readonly sidebarWidth: number
  readonly tabBar: boolean
  readonly statusBar: boolean
  readonly paneBorders: boolean
  /**
   * How the split/close buttons on a pane's border are drawn.
   *
   * `icons` uses half-filled squares that show where the new pane lands — `◨` puts it
   * on the right, `⬓` below. Those are East Asian *Ambiguous* width, so a terminal in
   * a CJK locale may draw them two cells wide and shift every button's hit region one
   * column; `ascii` is the escape hatch for that, and `off` reclaims the border.
   */
  readonly paneButtons: 'icons' | 'ascii' | 'off'
}

export interface ThemeConfig {
  readonly focusBorder: number
  readonly idleBorder: number
  readonly paneTitle: number
  readonly statusFg: number
  readonly statusBg: number
  readonly sidebarFg: number
  readonly sidebarBg: number
  readonly sidebarActiveFg: number
  readonly sidebarActiveBg: number
  readonly tabActiveFg: number
  readonly tabActiveBg: number
  readonly tabIdleFg: number
  readonly tabIdleBg: number
  /**
   * Agent status colours.
   *
   * Colour is the *second* channel here, never the only one: the badge itself is a
   * glyph (`AGENT_STATUS_GLYPH`), so a monochrome terminal and a colour-blind reader
   * both still get the state. These make a blocked pane findable at a glance in a
   * sidebar of fifteen.
   */
  readonly agentIdle: number
  readonly agentWorking: number
  readonly agentBlocked: number
  readonly agentDone: number
}

/**
 * A theme name, or '' for "use the explicit colours below".
 *
 * Kept out of `ThemeConfig` because that interface is eleven colours and nothing else;
 * the name selects a *set* of them and is resolved before rendering. See
 * `resolveTheme`.
 */
export type ThemeName = string

export interface KeysConfig {
  /** The chord that arms prefix bindings. */
  readonly prefix: string
  /** Chord -> command, fired only after the prefix. */
  readonly prefixBindings: Readonly<Record<string, string>>
  /** Chord -> command, fired on its own. */
  readonly directBindings: Readonly<Record<string, string>>
}

/**
 * When to play a notification, and what to play.
 *
 * This was once the terminal bell alone, on the reasoning that a multiplexer has no
 * business acquiring an audio device when `\x07` is a noise every terminal already
 * knows how to make. In practice most terminals make no noise for it — VS Code's
 * integrated terminal ignores it by default — so the feature was silent for most users
 * with nothing to indicate why. herdr plays a real file through the platform's own
 * player and so do we; the bell remains the fallback where no player exists.
 */
export interface SoundConfig {
  /** An agent finished its turn: went from working to idle, or exited. */
  readonly agentDone: boolean
  /** An agent is waiting on you. The one worth interrupting for. */
  readonly agentBlocked: boolean
  /** An audio file to play instead of the bundled one. Empty means the bundled one. */
  readonly donePath: string
  readonly blockedPath: string
}

export interface Config {
  /** A named theme, applied under any explicit `[theme]` colours. */
  readonly themeName: ThemeName
  readonly sound: SoundConfig
  readonly general: GeneralConfig
  readonly ui: UiConfig
  readonly theme: ThemeConfig
  readonly keys: KeysConfig
}

/**
 * tmux's defaults where tmux has one, because that is what a user's fingers know.
 * `h/j/k/l` for focus and the shifted forms for resize come from herdr.
 */
export const DEFAULT_PREFIX_BINDINGS: Readonly<Record<string, string>> = {
  '%': 'pane.split-right',
  '"': 'pane.split-down',
  x: 'pane.close',
  z: 'pane.zoom',
  h: 'pane.focus-left',
  j: 'pane.focus-down',
  k: 'pane.focus-up',
  l: 'pane.focus-right',
  o: 'pane.focus-next',
  Tab: 'pane.focus-next',
  H: 'pane.resize-left',
  J: 'pane.resize-down',
  K: 'pane.resize-up',
  L: 'pane.resize-right',
  '{': 'pane.swap-left',
  '}': 'pane.swap-right',
  PageUp: 'pane.scroll-up',
  PageDown: 'pane.scroll-down',
  End: 'pane.scroll-bottom',
  c: 'tab.create',
  // tmux's names: `,` renames the window, `$` renames the session. Closest analogues
  // here are the tab and the workspace.
  ',': 'tab.rename',
  $: 'workspace.rename',
  // herdr's `prefix+shift+p`. Lowercase `p` is taken by tab.previous, as in tmux.
  P: 'pane.rename',
  // herdr advertises `?` for keybinds and settings; this is the settings half.
  '?': 'client.settings',
  '&': 'tab.close',
  n: 'tab.next',
  p: 'tab.previous',
  w: 'workspace.create',
  ')': 'workspace.next',
  '(': 'workspace.previous',
  s: 'client.toggle-sidebar',
  d: 'client.detach',
  q: 'client.quit',
  r: 'client.repaint',
  R: 'client.reload-config',
  'C-b': 'client.send-prefix'
}

export const DEFAULT_CONFIG: Config = {
  themeName: '',
  // Both on: the entire point of a status badge is to be noticed, and the two
  // transitions worth a noise are "your turn" and "it finished".
  sound: { agentDone: true, agentBlocked: true, donePath: '', blockedPath: '' },
  general: { shell: '', cwd: '', scrollback: 5000, mouse: true, mouseHover: true, scrollStep: 0 },
  ui: { sidebar: true, sidebarWidth: 22, tabBar: true, statusBar: true, paneBorders: true, paneButtons: 'icons' },
  theme: {
    focusBorder: 6,
    idleBorder: 8,
    paneTitle: 7,
    statusFg: 0,
    statusBg: 6,
    sidebarFg: 7,
    sidebarBg: -1,
    sidebarActiveFg: 0,
    sidebarActiveBg: 6,
    tabActiveFg: 0,
    tabActiveBg: 6,
    tabIdleFg: 7,
    tabIdleBg: -1,
    // Blocked is red because it is the one state that is waiting on the human.
    agentIdle: 8,
    agentWorking: 3,
    agentBlocked: 1,
    agentDone: 2
  },
  keys: { prefix: 'C-b', prefixBindings: DEFAULT_PREFIX_BINDINGS, directBindings: {} }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

type Scalar =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'string' }
  | { readonly kind: 'integer'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'chord' }

type FieldSpec =
  | (Scalar & { readonly key: string })
  /** An open table of chord -> command, validated per entry rather than per key name. */
  | { readonly kind: 'bindings'; readonly key: string }

interface TableSpec {
  readonly key: string
  readonly fields: readonly FieldSpec[]
}

/**
 * The TOML key for each config field.
 *
 * Kebab-case on the wire, camelCase in the type: `sidebar-width` is what a user writes
 * and `sidebarWidth` is what the code reads. The mapping is explicit here rather than
 * derived, so renaming a field cannot silently change a user's config file.
 */
const SCHEMA: readonly TableSpec[] = [
  {
    key: 'general',
    fields: [
      { key: 'shell', kind: 'string' },
      { key: 'cwd', kind: 'string' },
      { key: 'scrollback', kind: 'integer', min: 0, max: 1_000_000 },
      { key: 'mouse', kind: 'boolean' },
      { key: 'mouse-hover', kind: 'boolean' },
      { key: 'scroll-step', kind: 'integer', min: 0, max: 10_000 }
    ]
  },
  {
    key: 'ui',
    fields: [
      { key: 'sidebar', kind: 'boolean' },
      { key: 'sidebar-width', kind: 'integer', min: 8, max: 80 },
      { key: 'tab-bar', kind: 'boolean' },
      { key: 'status-bar', kind: 'boolean' },
      { key: 'pane-borders', kind: 'boolean' },
      { key: 'pane-buttons', kind: 'string' }
    ]
  },
  {
    key: 'theme',
    fields: [
      { key: 'focus-border', kind: 'integer', min: -1, max: 255 },
      { key: 'idle-border', kind: 'integer', min: -1, max: 255 },
      { key: 'pane-title', kind: 'integer', min: -1, max: 255 },
      { key: 'status-fg', kind: 'integer', min: -1, max: 255 },
      { key: 'status-bg', kind: 'integer', min: -1, max: 255 },
      { key: 'sidebar-fg', kind: 'integer', min: -1, max: 255 },
      { key: 'sidebar-bg', kind: 'integer', min: -1, max: 255 },
      { key: 'sidebar-active-fg', kind: 'integer', min: -1, max: 255 },
      { key: 'sidebar-active-bg', kind: 'integer', min: -1, max: 255 },
      { key: 'tab-active-fg', kind: 'integer', min: -1, max: 255 },
      { key: 'tab-active-bg', kind: 'integer', min: -1, max: 255 },
      { key: 'tab-idle-fg', kind: 'integer', min: -1, max: 255 },
      { key: 'tab-idle-bg', kind: 'integer', min: -1, max: 255 },
      { key: 'agent-idle', kind: 'integer', min: -1, max: 255 },
      { key: 'agent-working', kind: 'integer', min: -1, max: 255 },
      { key: 'agent-blocked', kind: 'integer', min: -1, max: 255 },
      { key: 'agent-done', kind: 'integer', min: -1, max: 255 },
      // A name, not a colour: it selects the eleven below rather than being one.
      { key: 'name', kind: 'string' }
    ]
  },
  {
    key: 'sound',
    fields: [
      { key: 'agent-done', kind: 'boolean' },
      { key: 'agent-blocked', kind: 'boolean' },
      { key: 'done-path', kind: 'string' },
      { key: 'blocked-path', kind: 'string' }
    ]
  },
  {
    key: 'keys',
    fields: [
      { key: 'prefix', kind: 'chord' },
      { key: 'bindings', kind: 'bindings' },
      { key: 'direct-bindings', kind: 'bindings' }
    ]
  }
]

/** Field path in the config object for each schema key. */
const FIELD_PATHS: Readonly<Record<string, [keyof Config, string] | [keyof Config]>> = {
  'general.shell': ['general', 'shell'],
  'general.cwd': ['general', 'cwd'],
  'general.scrollback': ['general', 'scrollback'],
  'general.mouse': ['general', 'mouse'],
  'general.mouse-hover': ['general', 'mouseHover'],
  'general.scroll-step': ['general', 'scrollStep'],
  'ui.sidebar': ['ui', 'sidebar'],
  'ui.sidebar-width': ['ui', 'sidebarWidth'],
  'ui.tab-bar': ['ui', 'tabBar'],
  'ui.status-bar': ['ui', 'statusBar'],
  'ui.pane-borders': ['ui', 'paneBorders'],
  'ui.pane-buttons': ['ui', 'paneButtons'],
  'theme.focus-border': ['theme', 'focusBorder'],
  'theme.idle-border': ['theme', 'idleBorder'],
  'theme.pane-title': ['theme', 'paneTitle'],
  'theme.status-fg': ['theme', 'statusFg'],
  'theme.status-bg': ['theme', 'statusBg'],
  'theme.sidebar-fg': ['theme', 'sidebarFg'],
  'theme.sidebar-bg': ['theme', 'sidebarBg'],
  'theme.sidebar-active-fg': ['theme', 'sidebarActiveFg'],
  'theme.sidebar-active-bg': ['theme', 'sidebarActiveBg'],
  'theme.tab-active-fg': ['theme', 'tabActiveFg'],
  'theme.tab-active-bg': ['theme', 'tabActiveBg'],
  'theme.tab-idle-fg': ['theme', 'tabIdleFg'],
  'theme.tab-idle-bg': ['theme', 'tabIdleBg'],
  'theme.agent-idle': ['theme', 'agentIdle'],
  'theme.agent-working': ['theme', 'agentWorking'],
  'theme.agent-blocked': ['theme', 'agentBlocked'],
  'theme.agent-done': ['theme', 'agentDone'],
  'theme.name': ['themeName'],
  'sound.agent-done': ['sound', 'agentDone'],
  'sound.agent-blocked': ['sound', 'agentBlocked'],
  'sound.done-path': ['sound', 'donePath'],
  'sound.blocked-path': ['sound', 'blockedPath'],
  'keys.prefix': ['keys', 'prefix'],
  'keys.bindings': ['keys', 'prefixBindings'],
  'keys.direct-bindings': ['keys', 'directBindings']
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type ConfigProblemKind = 'unknown-key' | 'wrong-type' | 'out-of-range' | 'unknown-command' | 'bad-chord'

export interface ConfigProblem {
  readonly kind: ConfigProblemKind
  /** Dotted path, as the user would write it: `ui.sidebar-width`. */
  readonly path: string
  readonly message: string
}

export interface ValidatedConfig {
  readonly config: Config
  readonly problems: readonly ConfigProblem[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A chord is validated shallowly here: `core` cannot import the input package's
 * `parseChord` without taking a dependency, and the input package cannot move here
 * without bringing its whole key model. So this checks the shape — modifier prefixes
 * and a non-empty base — and the client's `parseChord` has the final word. A chord that
 * passes here and fails there is reported at bind time.
 */
export function looksLikeChord(text: string): boolean {
  if (text.length === 0) return false
  const parts = text.split('-')
  if (parts.length > 1 && parts[parts.length - 1] === '') {
    // `C--` is Ctrl+minus: the base is the separator itself.
    parts.pop()
    parts.pop()
  } else {
    parts.pop()
  }
  return parts.every((part) => ['C', 'A', 'M', 'S', 'D'].includes(part.toUpperCase()))
}

export function validateConfig(input: unknown): ValidatedConfig {
  const problems: ConfigProblem[] = []
  const config: Config = structuredCopy(DEFAULT_CONFIG)

  if (input === undefined || input === null) return { config, problems }
  if (!isRecord(input)) {
    problems.push({ kind: 'wrong-type', path: '', message: 'config must be a table' })
    return { config, problems }
  }

  const tableByKey = new Map(SCHEMA.map((table) => [table.key, table]))
  for (const [tableKey, tableValue] of Object.entries(input)) {
    const table = tableByKey.get(tableKey)
    if (!table) {
      problems.push({ kind: 'unknown-key', path: tableKey, message: `unknown section [${tableKey}]` })
      continue
    }
    if (!isRecord(tableValue)) {
      problems.push({ kind: 'wrong-type', path: tableKey, message: `[${tableKey}] must be a table` })
      continue
    }
    const fieldByKey = new Map(table.fields.map((field) => [field.key, field]))
    for (const [fieldKey, raw] of Object.entries(tableValue)) {
      const path = `${tableKey}.${fieldKey}`
      const field = fieldByKey.get(fieldKey)
      if (!field) {
        problems.push({ kind: 'unknown-key', path, message: `unknown key \`${path}\`` })
        continue
      }
      applyField(config, path, field, raw, problems)
    }
  }
  return { config, problems }
}

function applyField(
  config: Config,
  path: string,
  field: FieldSpec,
  raw: unknown,
  problems: ConfigProblem[]
): void {
  const target = FIELD_PATHS[path]
  if (!target) return
  const [section, key] = target
  // A one-element path names a top-level field (`theme.name` -> `themeName`); a
  // two-element one names a field inside a section table.
  const table =
    key === undefined
      ? (config as unknown as Record<string, unknown>)
      : (config[section] as unknown as Record<string, unknown>)
  const field_key = key ?? section

  if (field.kind === 'bindings') {
    if (!isRecord(raw)) {
      problems.push({ kind: 'wrong-type', path, message: `\`${path}\` must be a table of chord = command` })
      return
    }
    // A user's bindings table *replaces* nothing and *adds* to the defaults, so a config
    // that binds one extra key keeps `prefix %`. Unbinding is `chord = ""`.
    const merged: Record<string, string> = { ...(table[field_key] as Record<string, string>) }
    for (const [chord, command] of Object.entries(raw)) {
      const entryPath = `${path}."${chord}"`
      if (typeof command !== 'string') {
        problems.push({ kind: 'wrong-type', path: entryPath, message: `binding for \`${chord}\` must be a string` })
        continue
      }
      if (!looksLikeChord(chord)) {
        problems.push({ kind: 'bad-chord', path: entryPath, message: `\`${chord}\` is not a readable chord` })
        continue
      }
      if (command.length === 0) {
        delete merged[chord]
        continue
      }
      if (!isCommandName(command)) {
        problems.push({ kind: 'unknown-command', path: entryPath, message: `no command named \`${command}\`` })
        continue
      }
      merged[chord] = command
    }
    table[field_key] = merged
    return
  }

  switch (field.kind) {
    case 'boolean':
      if (typeof raw !== 'boolean') {
        problems.push({ kind: 'wrong-type', path, message: `\`${path}\` must be true or false` })
        return
      }
      table[field_key] = raw
      return
    case 'string':
      if (typeof raw !== 'string') {
        problems.push({ kind: 'wrong-type', path, message: `\`${path}\` must be a string` })
        return
      }
      table[field_key] = raw
      return
    case 'chord':
      if (typeof raw !== 'string' || !looksLikeChord(raw)) {
        problems.push({ kind: 'bad-chord', path, message: `\`${path}\` must be a chord such as "C-b"` })
        return
      }
      table[field_key] = raw
      return
    case 'integer': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        problems.push({ kind: 'wrong-type', path, message: `\`${path}\` must be a number` })
        return
      }
      const value = Math.trunc(raw)
      const min = field.min ?? Number.NEGATIVE_INFINITY
      const max = field.max ?? Number.POSITIVE_INFINITY
      if (value < min || value > max) {
        problems.push({
          kind: 'out-of-range',
          path,
          message: `\`${path}\` must be between ${min} and ${max}, got ${value}`
        })
        return
      }
      table[field_key] = value
      return
    }
  }
}

function structuredCopy(config: Config): Config {
  return {
    themeName: config.themeName,
    sound: { ...config.sound },
    general: { ...config.general },
    ui: { ...config.ui },
    theme: { ...config.theme },
    keys: {
      prefix: config.keys.prefix,
      prefixBindings: { ...config.keys.prefixBindings },
      directBindings: { ...config.keys.directBindings }
    }
  }
}

/** Every key the schema knows, dotted. For `leap-chorus config keys` and for tests. */
export function configKeys(): string[] {
  return SCHEMA.flatMap((table) => table.fields.map((field) => `${table.key}.${field.key}`))
}

/**
 * Bindings flattened for the client to install.
 *
 * `dispatch` is what `@leap-chorus/input`'s `KeybindingTable` wants, and keeping the shape
 * here means the client's wiring is three lines rather than a fold over two tables.
 */
export interface BindingEntry {
  readonly chord: string
  readonly dispatch: 'prefix' | 'direct'
  readonly command: string
}

export function bindingEntries(config: Config): BindingEntry[] {
  const out: BindingEntry[] = []
  for (const [chord, command] of Object.entries(config.keys.directBindings)) {
    out.push({ chord, dispatch: 'direct', command })
  }
  for (const [chord, command] of Object.entries(config.keys.prefixBindings)) {
    out.push({ chord, dispatch: 'prefix', command })
  }
  return out
}
