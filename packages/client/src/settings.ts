/**
 * The settings dialog.
 *
 * PHASE-4 shipped no modals, on the grounds that the two candidates then in view — a
 * rename prompt and a confirm-close — "would both be guesses at an interaction language
 * phase 5's agent UI will set". Renaming turned out not to need one; a one-line answer
 * belongs on the status line. *This* needs one: a list you move through, two sections,
 * and a thing that happens when you press enter.
 *
 * ## Shape
 *
 * State and rendering, no I/O. The dialog says what it wants done — apply this theme,
 * install these integrations — and the app performs it. That keeps the RPC calls in
 * one place and lets this be tested by driving keys at a plain object.
 *
 * ## Only sections that do something
 *
 * herdr's dialog has five tabs: theme, indicators, sound, toasts, integrations. Two of
 * those correspond to features this build has. Drawing the other three as empty tabs
 * would be a menu that lies about what the program can do, so there are two.
 */

import { THEMES, type ThemeDefinition } from '@leap-chorus/core'
import { ScreenBuffer, truncate, type Rect, type Style } from '@leap-chorus/tui'
import type { IntegrationRecord } from '@leap-chorus/protocol'
import type { Palette } from './chrome.js'

/**
 * The line under the sound toggles.
 *
 * Said "the terminal bell — your terminal decides how it sounds" while that was the
 * mechanism. It no longer is: playback goes through the platform's own audio player,
 * and the bell is only what happens when there is not one.
 */
const SOUND_CAPTION = 'plays through your system audio; falls back to the terminal bell'

/** The toggles in the sound section, and the config paths they write. */
const SOUND_ROWS = [
  { key: 'agentBlocked', path: 'sound.agent-blocked', label: 'ring when an agent needs you' },
  { key: 'agentDone', path: 'sound.agent-done', label: 'ring when an agent finishes' }
] as const satisfies readonly { key: 'agentDone' | 'agentBlocked'; path: string; label: string }[]

export type SettingsSection = 'keys' | 'theme' | 'sound' | 'integrations'

// `keys` first, and it is the section the dialog opens on: the most likely reason
// someone found this dialog at all is that they do not know the keys yet.
export const SETTINGS_SECTIONS: readonly SettingsSection[] = ['keys', 'theme', 'sound', 'integrations']

/**
 * Spell a chord the way a keyboard is labelled.
 *
 * The config writes `C-b` because that is tmux's spelling and what a user types into
 * a binding. Nobody reading a help list knows it. `Ctrl+B` needs no explaining, which
 * is the whole job of this screen.
 */
export function describeChord(chord: string): string {
  return chord
    .split('-')
    .map((part, index, parts) => {
      if (index === parts.length - 1) return part.length === 1 ? part.toUpperCase() : part
      if (part === 'C') return 'Ctrl'
      if (part === 'S') return 'Shift'
      if (part === 'M' || part === 'A') return 'Alt'
      return part
    })
    .join('+')
}

/** What a keystroke asked the app to do. The dialog itself performs nothing. */
export type SettingsOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'close' }
  | { readonly kind: 'redraw' }
  | { readonly kind: 'apply-theme'; readonly theme: string }
  | { readonly kind: 'install-integration'; readonly agent: string }
  | { readonly kind: 'toggle-sound'; readonly path: string; readonly value: boolean }

export class SettingsDialog {
  section: SettingsSection = 'keys'
  /** Selection index within the active section. */
  private cursor = 0
  /** Filled by the app from `integration.list`; empty until it answers. */
  integrations: readonly IntegrationRecord[] = []
  /** The live sound settings, so the dialog shows what is actually in force. */
  sound: { agentDone: boolean; agentBlocked: boolean } = { agentDone: true, agentBlocked: true }

  /** The bindings to list, resolved by the app from the live config. */
  readonly keys: readonly { readonly chord: string; readonly summary: string }[]

  constructor(
    readonly currentTheme: string,
    keys: readonly { readonly chord: string; readonly summary: string }[] = []
  ) {
    this.keys = keys
  }

  private get rows(): number {
    if (this.section === 'theme') return THEMES.length
    if (this.section === 'keys') return this.keys.length
    if (this.section === 'sound') return SOUND_ROWS.length
    return this.integrations.length
  }

  selectedTheme(): ThemeDefinition | null {
    return this.section === 'theme' ? (THEMES[this.cursor] ?? null) : null
  }

  /**
   * Handle one key.
   *
   * `tab` cycles sections and resets the cursor, because an index into the theme list
   * means nothing in the integrations list — carrying it over would land the selection
   * somewhere arbitrary.
   */
  handleKey(name: string, char: string | undefined): SettingsOutcome {
    if (name === 'escape' || char === 'q') return { kind: 'close' }

    if (name === 'tab') {
      const index = SETTINGS_SECTIONS.indexOf(this.section)
      this.section = SETTINGS_SECTIONS[(index + 1) % SETTINGS_SECTIONS.length] as SettingsSection
      this.cursor = 0
      return { kind: 'redraw' }
    }
    if (name === 'up' || char === 'k') {
      // Clamped rather than wrapped: a list you can walk off the end of is a list you
      // lose your place in.
      this.cursor = Math.max(0, this.cursor - 1)
      return { kind: 'redraw' }
    }
    if (name === 'down' || char === 'j') {
      this.cursor = Math.min(Math.max(0, this.rows - 1), this.cursor + 1)
      return { kind: 'redraw' }
    }
    if (name === 'enter') {
      // The keys section is a reference, not a menu: there is nothing to apply.
      if (this.section === 'keys') return { kind: 'none' }
      if (this.section === 'theme') {
        const theme = THEMES[this.cursor]
        return theme === undefined ? { kind: 'none' } : { kind: 'apply-theme', theme: theme.name }
      }
      if (this.section === 'sound') {
        const row = SOUND_ROWS[this.cursor]
        if (row === undefined) return { kind: 'none' }
        return { kind: 'toggle-sound', path: row.path, value: !this.sound[row.key] }
      }
      const entry = this.integrations[this.cursor]
      return entry === undefined ? { kind: 'none' } : { kind: 'install-integration', agent: entry.agent }
    }
    return { kind: 'none' }
  }

  /** A click inside the dialog. Coordinates are absolute. */
  handleClick(column: number, row: number, area: Rect): SettingsOutcome {
    const header = area.y + 1
    if (row === header) {
      // Section tabs, laid out the same way `render` lays them out.
      let x = area.x + 2
      for (const section of SETTINGS_SECTIONS) {
        const width = section.length + 2
        if (column >= x && column < x + width) {
          this.section = section
          this.cursor = 0
          return { kind: 'redraw' }
        }
        x += width + 1
      }
      return { kind: 'none' }
    }
    const first = area.y + 4
    const index = row - first
    if (index >= 0 && index < this.rows) {
      this.cursor = index
      // A click selects *and* commits: a double-click would be two round trips to
      // discover, and every row here is reversible.
      return this.handleKey('enter', undefined)
    }
    return { kind: 'none' }
  }

  render(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    const inner = { x: area.x + 2, y: area.y, width: area.width - 4, height: area.height }
    buffer.fill(area, ' ', palette.sidebar)

    buffer.writeString(inner.x, area.y, 'settings', palette.paneTitle, area.x + area.width)

    let x = inner.x
    for (const section of SETTINGS_SECTIONS) {
      const label = ` ${section} `
      buffer.writeString(x, area.y + 1, label, section === this.section ? palette.tabActive : palette.tabIdle, area.x + area.width)
      x += label.length + 1
    }

    const rowStyle = (selected: boolean): Style => (selected ? palette.sidebarActive : palette.sidebar)
    let y = area.y + 4
    const limit = area.y + area.height - 2

    if (this.section === 'keys') {
      for (const entry of this.keys) {
        if (y >= limit) break
        buffer.writeString(inner.x, y, truncate(entry.chord, 22).padEnd(22, ' '), palette.paneTitle, area.x + area.width)
        buffer.writeString(inner.x + 22, y, truncate(entry.summary, inner.width - 22), palette.sidebar, area.x + area.width)
        y += 1
      }
    } else if (this.section === 'theme') {
      for (const [index, entry] of THEMES.entries()) {
        if (y >= limit) break
        // A tick marks what is *in force*; the highlight marks what is selected. They
        // are different questions and the dialog answers both at once.
        const mark = entry.name === this.currentTheme ? ' ✓' : ''
        const kind = entry.light ? ' (light)' : ''
        buffer.writeString(
          inner.x,
          y,
          truncate(`${index === this.cursor ? '▸ ' : '  '}${entry.name}${mark}${kind}`, inner.width).padEnd(inner.width, ' '),
          rowStyle(index === this.cursor),
          area.x + area.width
        )
        y += 1
      }
    } else if (this.section === 'sound') {
      for (const [index, row] of SOUND_ROWS.entries()) {
        if (y >= limit) break
        // `[x]` / `[ ]` rather than a colour: a checkbox is readable in one glance and
        // survives a monochrome terminal, which a highlighted row does not.
        const mark = this.sound[row.key] ? '[x]' : '[ ]'
        buffer.writeString(
          inner.x,
          y,
          truncate(`${index === this.cursor ? '▸ ' : '  '}${mark} ${row.label}`, inner.width).padEnd(inner.width, ' '),
          rowStyle(index === this.cursor),
          area.x + area.width
        )
        y += 1
      }
      if (y < limit) {
        buffer.writeString(inner.x, y + 1, truncate(SOUND_CAPTION, inner.width), palette.idleBorder, area.x + area.width)
      }
    } else if (this.integrations.length === 0) {
      buffer.writeString(inner.x, y, 'no integrations are available', palette.idleBorder, area.x + area.width)
    } else {
      for (const [index, entry] of this.integrations.entries()) {
        if (y >= limit) break
        const state = entry.installed
          ? entry.installedVersion === entry.availableVersion
            ? 'installed'
            : 'update available'
          : 'not installed'
        const label = `${index === this.cursor ? '▸ ' : '  '}${entry.agent}`
        buffer.writeString(inner.x, y, truncate(label, 18).padEnd(18, ' '), rowStyle(index === this.cursor), area.x + area.width)
        buffer.writeString(inner.x + 18, y, truncate(state, inner.width - 18).padEnd(inner.width - 18, ' '), rowStyle(index === this.cursor), area.x + area.width)
        y += 1
      }
    }

    const footer = area.y + area.height - 1
    const hint =
      this.section === 'keys'
        ? 'tab section · esc close'
        : this.section === 'sound'
          ? '↑↓ select · tab section · ↵ toggle · esc close'
        : this.section === 'theme'
          ? '↑↓ select · tab section · ↵ apply · esc close'
          : '↑↓ select · tab section · ↵ install · esc close'
    buffer.writeString(inner.x, footer, truncate(hint, inner.width), palette.idleBorder, area.x + area.width)
  }
}

/** Centre the dialog, clamped so it always fits. */
export function settingsArea(cols: number, rows: number): Rect {
  const width = Math.min(62, Math.max(30, cols - 4))
  const height = Math.min(THEMES.length + 10, Math.max(12, rows - 4))
  return {
    x: Math.max(0, Math.floor((cols - width) / 2)),
    y: Math.max(0, Math.floor((rows - height) / 2)),
    width,
    height
  }
}
