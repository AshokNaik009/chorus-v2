/**
 * Named colour themes.
 *
 * ## Why these carry RGB and the config schema carries palette indices
 *
 * `[theme]` in the config file takes palette indices (`-1..255`), because a hand-written
 * config should work on a terminal with sixteen colours and because an index follows
 * whatever palette the user has already themed their terminal with. A *named* theme is
 * the opposite claim — "make it look like catppuccin, whatever my terminal thinks green
 * is" — so these are true 24-bit colours.
 *
 * Both end up as a {@link SnapshotColor}, which is one number: `-1` is the terminal's
 * default, `0..255` is a palette index, and anything with {@link RGB} set is truecolor.
 * A theme and an override therefore compose without the renderer knowing which it got.
 *
 * ## Choosing a theme's roles rather than copying its palette
 *
 * Each upstream theme publishes ~25 colours; this needs eleven roles. The mapping is
 * by *role*, not by name: `focus-border` takes the theme's primary accent, `agent-blocked`
 * its red, `agent-working` its yellow, `agent-done` its green, because those carry
 * meaning that has to survive the theme changing. A theme that rendered "blocked" in
 * its accent colour would be prettier and useless.
 */

import type { ThemeConfig } from './config.js'

/** Truecolor tag, matching the protocol's `COLOR_RGB_FLAG`. Kept local so `core` stays dependency-free. */
export const RGB = 0x1000000

/** Pack `#rrggbb` into a `SnapshotColor`. */
export function rgb(hex: number): number {
  return RGB | (hex & 0xffffff)
}

export interface ThemeDefinition {
  readonly name: string
  /** For the picker: whether this is a light theme, so the list can be read at a glance. */
  readonly light: boolean
  readonly colors: ThemeConfig
}

interface Roles {
  readonly accent: number
  readonly dim: number
  readonly text: number
  readonly base: number
  readonly surface: number
  readonly red: number
  readonly yellow: number
  readonly green: number
  /** Text drawn *on* the accent. Black for light accents, white for dark ones. */
  readonly onAccent: number
}

/**
 * Turn eight semantic roles into the eleven fields the renderer wants.
 *
 * One function so every theme is internally consistent: the same accent is used for
 * the focused border, the active tab and the active sidebar row, and the same
 * "text on accent" is used wherever that accent is a background.
 */
function theme(name: string, light: boolean, roles: Roles): ThemeDefinition {
  return {
    name,
    light,
    colors: {
      focusBorder: roles.accent,
      idleBorder: roles.dim,
      paneTitle: roles.text,
      statusFg: roles.onAccent,
      statusBg: roles.accent,
      sidebarFg: roles.text,
      sidebarBg: roles.base,
      sidebarActiveFg: roles.onAccent,
      sidebarActiveBg: roles.accent,
      tabActiveFg: roles.onAccent,
      tabActiveBg: roles.accent,
      tabIdleFg: roles.dim,
      tabIdleBg: roles.surface,
      agentIdle: roles.dim,
      agentWorking: roles.yellow,
      agentBlocked: roles.red,
      agentDone: roles.green
    }
  }
}

/**
 * The built-in themes.
 *
 * `terminal` is first and is not a colour scheme: every value is `-1`, the terminal's
 * own default, so the multiplexer borrows whatever the user already configured. It is
 * the honest default for a program that draws inside someone else's terminal.
 */
export const THEMES: readonly ThemeDefinition[] = [
  {
    name: 'terminal',
    light: false,
    colors: {
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
      agentIdle: 8,
      agentWorking: 3,
      agentBlocked: 1,
      agentDone: 2
    }
  },
  theme('catppuccin', false, {
    accent: rgb(0x89b4fa),
    dim: rgb(0x6c7086),
    text: rgb(0xcdd6f4),
    base: rgb(0x1e1e2e),
    surface: rgb(0x313244),
    red: rgb(0xf38ba8),
    yellow: rgb(0xf9e2af),
    green: rgb(0xa6e3a1),
    onAccent: rgb(0x1e1e2e)
  }),
  theme('catppuccin-latte', true, {
    accent: rgb(0x1e66f5),
    dim: rgb(0x8c8fa1),
    text: rgb(0x4c4f69),
    base: rgb(0xeff1f5),
    surface: rgb(0xccd0da),
    red: rgb(0xd20f39),
    yellow: rgb(0xdf8e1d),
    green: rgb(0x40a02b),
    onAccent: rgb(0xeff1f5)
  }),
  theme('tokyo-night', false, {
    accent: rgb(0x7aa2f7),
    dim: rgb(0x565f89),
    text: rgb(0xc0caf5),
    base: rgb(0x1a1b26),
    surface: rgb(0x24283b),
    red: rgb(0xf7768e),
    yellow: rgb(0xe0af68),
    green: rgb(0x9ece6a),
    onAccent: rgb(0x1a1b26)
  }),
  theme('tokyo-night-day', true, {
    accent: rgb(0x2e7de9),
    dim: rgb(0x848cb5),
    text: rgb(0x3760bf),
    base: rgb(0xe1e2e7),
    surface: rgb(0xc4c8da),
    red: rgb(0xf52a65),
    yellow: rgb(0x8c6c3e),
    green: rgb(0x587539),
    onAccent: rgb(0xe1e2e7)
  }),
  theme('dracula', false, {
    accent: rgb(0xbd93f9),
    dim: rgb(0x6272a4),
    text: rgb(0xf8f8f2),
    base: rgb(0x282a36),
    surface: rgb(0x44475a),
    red: rgb(0xff5555),
    yellow: rgb(0xf1fa8c),
    green: rgb(0x50fa7b),
    onAccent: rgb(0x282a36)
  }),
  theme('nord', false, {
    accent: rgb(0x88c0d0),
    dim: rgb(0x4c566a),
    text: rgb(0xd8dee9),
    base: rgb(0x2e3440),
    surface: rgb(0x3b4252),
    red: rgb(0xbf616a),
    yellow: rgb(0xebcb8b),
    green: rgb(0xa3be8c),
    onAccent: rgb(0x2e3440)
  }),
  theme('gruvbox', false, {
    accent: rgb(0xd79921),
    dim: rgb(0x928374),
    text: rgb(0xebdbb2),
    base: rgb(0x282828),
    surface: rgb(0x3c3836),
    red: rgb(0xfb4934),
    yellow: rgb(0xfabd2f),
    green: rgb(0xb8bb26),
    onAccent: rgb(0x282828)
  }),
  theme('gruvbox-light', true, {
    accent: rgb(0xb57614),
    dim: rgb(0x928374),
    text: rgb(0x3c3836),
    base: rgb(0xfbf1c7),
    surface: rgb(0xebdbb2),
    red: rgb(0x9d0006),
    yellow: rgb(0xb57614),
    green: rgb(0x79740e),
    onAccent: rgb(0xfbf1c7)
  }),
  theme('one-dark', false, {
    accent: rgb(0x61afef),
    dim: rgb(0x5c6370),
    text: rgb(0xabb2bf),
    base: rgb(0x282c34),
    surface: rgb(0x3e4451),
    red: rgb(0xe06c75),
    yellow: rgb(0xe5c07b),
    green: rgb(0x98c379),
    onAccent: rgb(0x282c34)
  }),
  theme('one-light', true, {
    accent: rgb(0x4078f2),
    dim: rgb(0xa0a1a7),
    text: rgb(0x383a42),
    base: rgb(0xfafafa),
    surface: rgb(0xe5e5e6),
    red: rgb(0xe45649),
    yellow: rgb(0xc18401),
    green: rgb(0x50a14f),
    onAccent: rgb(0xfafafa)
  }),
  theme('solarized', false, {
    accent: rgb(0x268bd2),
    dim: rgb(0x586e75),
    text: rgb(0x93a1a1),
    base: rgb(0x002b36),
    surface: rgb(0x073642),
    red: rgb(0xdc322f),
    yellow: rgb(0xb58900),
    green: rgb(0x859900),
    onAccent: rgb(0x002b36)
  }),
  theme('solarized-light', true, {
    accent: rgb(0x268bd2),
    dim: rgb(0x93a1a1),
    text: rgb(0x586e75),
    base: rgb(0xfdf6e3),
    surface: rgb(0xeee8d5),
    red: rgb(0xdc322f),
    yellow: rgb(0xb58900),
    green: rgb(0x859900),
    onAccent: rgb(0xfdf6e3)
  })
]

export const THEME_NAMES: readonly string[] = THEMES.map((entry) => entry.name)

export function themeByName(name: string): ThemeDefinition | null {
  return THEMES.find((entry) => entry.name === name) ?? null
}

/**
 * The colours actually in force: a named theme, with explicit `[theme]` keys on top.
 *
 * The override rule is "explicit beats named", and the way it is decided is by
 * comparing against `DEFAULT_CONFIG.theme`: a field the user did not write still holds
 * its default, and a default must not beat the theme the user asked for. So a field is
 * treated as an override exactly when it differs from the default.
 *
 * That has one honest limit, stated rather than hidden: setting a field *to* the
 * default value while a theme is active is indistinguishable from not setting it, so
 * the theme wins. Nobody writes `focus-border = 6` to mean "override catppuccin back
 * to palette 6", and the alternative is tracking provenance through the whole loader
 * for that one case.
 */
export function resolveTheme(themeName: string, overrides: ThemeConfig, defaults: ThemeConfig): ThemeConfig {
  const named = themeName.length === 0 ? null : themeByName(themeName)
  if (named === null) return overrides

  const out = { ...named.colors } as Record<string, number>
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== (defaults as unknown as Record<string, number>)[key]) out[key] = value
  }
  return out as unknown as ThemeConfig
}
