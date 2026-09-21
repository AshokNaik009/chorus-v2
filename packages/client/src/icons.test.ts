/**
 * Criterion 6: "every glyph's measured width matches what the renderer assumed,
 * asserted per theme. A click on a row lands on that row in all three."
 *
 * ## Why the width half is the whole point
 *
 * One glyph of the wrong width moves every column after it **on that row only**. The
 * visible symptom is a row that looks slightly misaligned; the real symptom is that the
 * mouse hit region for everything right of the glyph is off by one, so a click lands on
 * the wrong thing. That is the bug `ui.pane-buttons = ascii` already exists to escape,
 * and an icon theme is the largest new opportunity this project has ever had to
 * reintroduce it.
 *
 * ## What the nerd theme's test does and does not prove
 *
 * Nerd Font glyphs are Private Use Area code points, and a PUA code point has no
 * assigned width — `codePointWidth` returns 1 because there is nothing else it could
 * return. So the nerd assertions prove the theme is **self-consistent with this
 * renderer**, not that any particular terminal agrees. That is exactly why `ascii` is
 * the default and why `[sidebar] icons` documents the trade rather than hiding it.
 */

import { describe, expect, it } from 'vitest'
import { ScreenBuffer, stringWidth } from '@leap-chorus/tui'
import type { Rect } from '@leap-chorus/tui'
import type { Palette } from './chrome.js'
import { ExplorerPanel } from './explorer.js'
import {
  ASCII_THEME,
  EMOJI_THEME,
  ICON_THEMES,
  NERD_THEME,
  iconColumns,
  iconFor,
  iconKind,
  iconTheme,
  themeWidthProblems
} from './icons.js'

const palette: Palette = {
  focusBorder: { fg: 6, bg: -1, attrs: 0 },
  idleBorder: { fg: 8, bg: -1, attrs: 0 },
  paneTitle: { fg: 7, bg: -1, attrs: 0 },
  status: { fg: 0, bg: 6, attrs: 0 },
  sidebar: { fg: 7, bg: -1, attrs: 0 },
  sidebarActive: { fg: 0, bg: 6, attrs: 0 },
  tabActive: { fg: 0, bg: 6, attrs: 0 },
  tabIdle: { fg: 7, bg: -1, attrs: 0 },
  agent: {
    idle: { fg: 8, bg: -1, attrs: 0 },
    working: { fg: 3, bg: -1, attrs: 0 },
    blocked: { fg: 1, bg: -1, attrs: 0 },
    done: { fg: 2, bg: -1, attrs: 0 }
  }
} as unknown as Palette

describe('every theme keeps its own promise about width', () => {
  it.each(ICON_THEMES.map((theme) => [theme.name, theme] as const))(
    '%s: every glyph measures exactly the declared width',
    (_name, theme) => {
      // The check itself lives in `icons.ts`, not here, so it survives somebody deleting
      // this file and still guards a theme added later.
      expect(themeWidthProblems(theme)).toEqual([])
    }
  )

  it('the declared widths are the ones the project measures, not ones we hoped for', () => {
    expect(ASCII_THEME.width).toBe(0)
    // Emoji from the ranges `width.ts` lists as East Asian Wide, so the renderer and
    // `stringWidth` agree by construction rather than by luck.
    expect(EMOJI_THEME.width).toBe(2)
    expect(stringWidth(EMOJI_THEME.glyphs.dir)).toBe(2)
    // PUA, measured as one column because that is all a PUA code point can be measured
    // as. See the module note.
    expect(NERD_THEME.width).toBe(1)
    expect(stringWidth(NERD_THEME.glyphs.dir)).toBe(1)
  })

  it('no glyph carries a variation selector or a joiner', () => {
    // Both are zero-width code points appended to a base. A terminal that composes the
    // sequence into one glyph and one that does not disagree about the row's width,
    // which is the failure this whole file is about.
    for (const theme of ICON_THEMES) {
      for (const glyph of Object.values(theme.glyphs)) {
        expect(glyph).not.toMatch(/[︀-️‍]/u)
      }
    }
  })

  it('an unknown theme name falls back to ascii rather than to nothing', () => {
    expect(iconTheme('ascii')).toBe(ASCII_THEME)
    expect(iconTheme('emoji')).toBe(EMOJI_THEME)
    expect(iconTheme('nerd')).toBe(NERD_THEME)
  })
})

describe('the icon column costs what it says it costs', () => {
  it('ascii reserves nothing at all — not even a space', () => {
    // "No icons" must cost zero columns. Reserving one would take a column of filename
    // from every user who never asked for icons, which is most of them.
    expect(iconColumns(ASCII_THEME)).toBe(0)
    expect(iconFor(ASCII_THEME, 'app.ts', 'file')).toBe('')
  })

  it('the others reserve the glyph plus one separating space', () => {
    expect(iconColumns(EMOJI_THEME)).toBe(3)
    expect(iconColumns(NERD_THEME)).toBe(2)
    expect(stringWidth(iconFor(EMOJI_THEME, 'app.ts', 'file'))).toBe(iconColumns(EMOJI_THEME))
    expect(stringWidth(iconFor(NERD_THEME, 'app.ts', 'file'))).toBe(iconColumns(NERD_THEME))
  })
})

describe('choosing an icon for a row', () => {
  it('a directory knows whether it is open', () => {
    expect(iconKind('src', 'dir', false)).toBe('dir')
    expect(iconKind('src', 'dir', true)).toBe('dir-open')
  })

  it('reads the extension, case-insensitively', () => {
    expect(iconKind('app.ts', 'file')).toBe('code')
    expect(iconKind('App.TS', 'file')).toBe('code')
    expect(iconKind('README.md', 'file')).toBe('markup')
    expect(iconKind('tsconfig.json', 'file')).toBe('config')
    expect(iconKind('logo.png', 'file')).toBe('image')
    expect(iconKind('bundle.tar', 'file')).toBe('archive')
    expect(iconKind('libfoo.so', 'file')).toBe('binary')
  })

  it('a dotfile is looked up by what follows the dot, which is its extension', () => {
    expect(iconKind('.gitignore', 'file')).toBe('config')
    expect(iconKind('.editorconfig', 'file')).toBe('config')
  })

  it('a lockfile is told apart from the config file it looks like', () => {
    // The case an icon most earns its column on: `pnpm-lock.yaml` is not a YAML config
    // you edit, and at a glance it otherwise looks exactly like one.
    expect(iconKind('pnpm-lock.yaml', 'file')).toBe('lock')
    expect(iconKind('package-lock.json', 'file')).toBe('lock')
    expect(iconKind('Cargo.lock', 'file')).toBe('lock')
    expect(iconKind('pnpm-workspace.yaml', 'file')).toBe('config')
  })

  it('anything unrecognised is a plain file rather than a guess', () => {
    expect(iconKind('unknownthing', 'file')).toBe('file')
    expect(iconKind('data.qqq', 'file')).toBe('file')
  })
})

// Criterion 6's second half. A row is full width and the cursor is an index, so what
// could actually break is the *columns*: a row that overflows its area pushes the git
// letter out of the column the click handler and the renderer both assume it is in.
describe('a row stays inside its area in every theme', () => {
  const area: Rect = { x: 0, y: 0, width: 24, height: 10 }
  const names = ['app.ts', 'README.md', '日本語のファイル名前.txt', 'a-very-long-filename-indeed.ts', '.gitignore']

  it.each(ICON_THEMES.map((theme) => [theme.name, theme] as const))(
    '%s: no row writes past the dock, whatever the filename',
    (_name, theme) => {
      const panel = new ExplorerPanel()
      panel.icons = theme
      panel.adopt('/repo', '', names.map((name) => ({ name, kind: 'file' as const, link: false })))
      panel.status = {
        root: '/repo',
        branch: 'main',
        staged: [],
        unstaged: names.map((name) => ({ path: name, origin: null, letter: 'M' })),
        ahead: 0,
        behind: 0,
        hasUpstream: false
      }
      const buffer = new ScreenBuffer(area.width, area.height)
      panel.renderInto(buffer, area, palette)

      for (let y = 0; y < area.height; y++) {
        let columns = 0
        for (let x = 0; x < area.width; x++) columns += buffer.widths[y * area.width + x] ?? 0
        // Every wide glyph accounted for, and none of them straddling the edge: a row
        // whose widths do not sum to the area's width has a cell the renderer and the
        // terminal disagree about.
        expect(columns).toBe(area.width)
      }
    }
  )

  it.each(ICON_THEMES.map((theme) => [theme.name, theme] as const))(
    '%s: a click on a row selects that row',
    (_name, theme) => {
      const panel = new ExplorerPanel()
      panel.icons = theme
      panel.adopt('/repo', '', names.map((name) => ({ name, kind: 'file' as const, link: false })))
      // Row 2 of the list, whatever the theme drew into it. The list starts two rows
      // down; the icon column must not move that. These are all files, so the click
      // asks for a preview of the row it landed on — which names the row, and is the
      // sharper assertion the boolean this used to return could not make.
      expect(panel.clickRow(area.y + 2 + 2, area)).toEqual({ kind: 'preview', path: names[2] })
      expect(panel.selected()?.name).toBe(names[2])
    }
  )
})
