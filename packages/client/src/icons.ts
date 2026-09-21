/**
 * File icons, in three themes, none of which may lie about its width.
 *
 * The extension table is herdr-sidebar's `icons.rs` (MIT), reduced to the categories a
 * thirty-four-column dock can distinguish. The *width* discipline is this project's
 * and is the whole reason this file is more than a lookup table. See `NOTICE`.
 *
 * ## Why `ascii` is the default and has no icons at all
 *
 * This is not taste. Nerd Font glyphs live in the Unicode **Private Use Area**, which
 * by definition has no assigned width: `codePointWidth` in `packages/tui/src/width.ts`
 * measures a PUA code point as one column, and a terminal or font that draws it as two
 * shifts every column after it on that row — taking the mouse hit regions with it, so
 * a click lands on the wrong thing. That is the same failure `ui.pane-buttons = ascii`
 * already exists to escape, and it is not hypothetical.
 *
 * So the default theme draws **no icon column**, which makes the tree byte-identical to
 * what phases 7 and 8 shipped. A user who turns icons on is saying they know what their
 * font does. Emoji are the middle ground: they are honestly East Asian Wide, this
 * project's width table already measures them as two columns, and a terminal that
 * disagrees about an emoji is a terminal with bigger problems.
 *
 * ## The invariant every theme must hold
 *
 * **Every glyph in a theme measures exactly `width` columns**, and the renderer
 * reserves exactly that many. One glyph of the wrong width would move every column
 * after it on that row only, which is the kind of bug that looks like a rendering glitch
 * and is actually a mis-click. `iconThemes()` and the test beside this file exist to
 * make that checkable rather than hoped for.
 */

import { stringWidth } from '@leap-chorus/tui'

export type IconThemeName = 'ascii' | 'emoji' | 'nerd'

/**
 * What a row's icon is chosen from.
 *
 * Coarser than herdr-sidebar's table on purpose: at thirty-four columns the reader is
 * distinguishing "a folder / some code / a picture / a thing I cannot read", and forty
 * language-specific glyphs cost forty chances to get a width wrong for a distinction
 * nobody can see at that size.
 */
export type IconKind =
  | 'dir'
  | 'dir-open'
  | 'code'
  | 'markup'
  | 'config'
  | 'doc'
  | 'image'
  | 'media'
  | 'archive'
  | 'binary'
  | 'lock'
  | 'file'

export interface IconTheme {
  readonly name: IconThemeName
  /**
   * Columns every glyph in this theme occupies.
   *
   * Zero means the theme draws no icon column at all, and the renderer reserves
   * nothing — not a space. See the module note.
   */
  readonly width: number
  readonly glyphs: Readonly<Record<IconKind, string>>
}

const EMPTY: Readonly<Record<IconKind, string>> = {
  dir: '',
  'dir-open': '',
  code: '',
  markup: '',
  config: '',
  doc: '',
  image: '',
  media: '',
  archive: '',
  binary: '',
  lock: '',
  file: ''
}

/**
 * No icons, and no column reserved for them.
 *
 * The default, and the one that is correct on every terminal ever made.
 */
export const ASCII_THEME: IconTheme = { name: 'ascii', width: 0, glyphs: EMPTY }

/**
 * Emoji, every one of them two columns by this project's own width table.
 *
 * Chosen from the ranges `width.ts` lists as Wide (`1f300`-`1f64f`, `1f900`-`1f9ff`),
 * so `stringWidth` and the renderer agree by construction rather than by luck. No
 * variation selectors and no ZWJ sequences: both are zero-width code points appended to
 * a base, and a terminal that renders the sequence as one glyph and one that renders it
 * as two disagree about the row's width — which is exactly the failure this file is
 * about.
 */
export const EMOJI_THEME: IconTheme = {
  name: 'emoji',
  width: 2,
  glyphs: {
    dir: '📁',
    'dir-open': '📂',
    code: '📜',
    markup: '📝',
    config: '🔧',
    doc: '📄',
    image: '🖼',
    media: '🎬',
    archive: '📦',
    binary: '🔩',
    lock: '🔒',
    file: '📄'
  }
}

/**
 * Nerd Font glyphs, all from the Private Use Area and all declared one column.
 *
 * Declared, not measured — that is the honest description. `codePointWidth` returns 1
 * for every PUA code point because there is nothing else it could return, so the test
 * beside this file proves the theme is *self-consistent*, not that a given terminal
 * agrees. Turning this theme on is a statement about your font, which is why it is not
 * the default and why `[sidebar] icons` says so.
 */
export const NERD_THEME: IconTheme = {
  name: 'nerd',
  width: 1,
  glyphs: {
    dir: '',
    'dir-open': '',
    code: '',
    markup: '',
    config: '',
    doc: '',
    image: '',
    media: '',
    archive: '',
    binary: '',
    lock: '',
    file: ''
  }
}

export const ICON_THEMES: readonly IconTheme[] = [ASCII_THEME, EMOJI_THEME, NERD_THEME]

export function iconTheme(name: IconThemeName): IconTheme {
  return ICON_THEMES.find((theme) => theme.name === name) ?? ASCII_THEME
}

/**
 * Whether a theme keeps its own promise about width.
 *
 * Exported rather than left in the test, because the same check is worth running
 * against a theme somebody adds later and a check that only exists in a test file is a
 * check the next person deletes with the test.
 */
export function themeWidthProblems(theme: IconTheme): string[] {
  const problems: string[] = []
  for (const [kind, glyph] of Object.entries(theme.glyphs)) {
    const measured = stringWidth(glyph)
    if (measured !== theme.width) {
      problems.push(`${theme.name}.${kind}: declared ${theme.width} columns, measures ${measured}`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// Extension -> kind
// ---------------------------------------------------------------------------

const BY_EXTENSION: Readonly<Record<string, IconKind>> = {
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  cjs: 'code',
  rs: 'code',
  go: 'code',
  py: 'code',
  rb: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cc: 'code',
  cpp: 'code',
  hpp: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  bash: 'code',
  zsh: 'code',
  fish: 'code',
  sql: 'code',
  lua: 'code',
  vim: 'code',

  html: 'markup',
  htm: 'markup',
  css: 'markup',
  scss: 'markup',
  less: 'markup',
  md: 'markup',
  markdown: 'markup',
  rst: 'markup',
  adoc: 'markup',

  json: 'config',
  jsonc: 'config',
  yaml: 'config',
  yml: 'config',
  toml: 'config',
  ini: 'config',
  cfg: 'config',
  conf: 'config',
  env: 'config',
  editorconfig: 'config',
  gitignore: 'config',
  gitattributes: 'config',

  txt: 'doc',
  pdf: 'doc',
  doc: 'doc',
  docx: 'doc',
  csv: 'doc',
  log: 'doc',

  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  svg: 'image',
  webp: 'image',
  ico: 'image',
  bmp: 'image',

  mp4: 'media',
  mov: 'media',
  mkv: 'media',
  webm: 'media',
  mp3: 'media',
  wav: 'media',
  flac: 'media',
  ogg: 'media',

  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  tgz: 'archive',
  bz2: 'archive',
  xz: 'archive',
  zst: 'archive',
  '7z': 'archive',
  rar: 'archive',

  so: 'binary',
  dylib: 'binary',
  dll: 'binary',
  exe: 'binary',
  o: 'binary',
  a: 'binary',
  wasm: 'binary',
  bin: 'binary'
}

/**
 * Whole filenames that mean something regardless of extension.
 *
 * A lockfile is the case worth special-casing: `pnpm-lock.yaml` is not a config file
 * you edit, and telling it apart from one at a glance is most of what an icon is for.
 */
const BY_NAME: Readonly<Record<string, IconKind>> = {
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'cargo.lock': 'lock',
  'poetry.lock': 'lock',
  'go.sum': 'lock',
  dockerfile: 'config',
  makefile: 'config',
  license: 'doc',
  notice: 'doc'
}

/**
 * The icon kind for a tree row.
 *
 * A dotfile with no other extension — `.gitignore`, `.editorconfig` — is looked up by
 * the part after the dot, because that *is* its extension as far as a reader is
 * concerned. `README.md` finds `md` and `.env.local` finds `local`, misses, and lands
 * on `file`; both are the right answer often enough that a second rule would cost more
 * than it earns.
 */
export function iconKind(name: string, kind: 'dir' | 'file' | 'other', expanded = false): IconKind {
  if (kind === 'dir') return expanded ? 'dir-open' : 'dir'
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower]
  if (byName !== undefined) return byName
  const dot = lower.lastIndexOf('.')
  // `lastIndexOf` of 0 is a dotfile: `.gitignore`'s extension is `gitignore`.
  const extension = dot === -1 ? '' : lower.slice(dot + 1)
  return BY_EXTENSION[extension] ?? 'file'
}

/**
 * The icon for a row, already padded to the column the renderer reserved.
 *
 * Returns `''` for a theme with no icon column, so the caller adds nothing rather than
 * adding a space — an empty theme must cost zero columns, not one.
 */
export function iconFor(
  theme: IconTheme,
  name: string,
  kind: 'dir' | 'file' | 'other',
  expanded = false
): string {
  if (theme.width === 0) return ''
  return `${theme.glyphs[iconKind(name, kind, expanded)]} `
}

/** Columns `iconFor` will occupy, glyph plus its trailing space. */
export function iconColumns(theme: IconTheme): number {
  return theme.width === 0 ? 0 : theme.width + 1
}
