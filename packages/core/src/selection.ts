/**
 * Copy mode: points, selections, vi motions, search, and links.
 *
 * Ported from herdr's `src/selection.rs` (Apache-2.0, herdr 3f2a6e74) and the
 * `pane.copy_motion` / `pane.copy_search` / `pane.selection.read` / `pane.link.activate`
 * endpoint methods.
 *
 * Everything here operates on `readonly string[]` — one string per content row,
 * scrollback first, visible screen last. That is the whole interface to the terminal:
 * `core` never touches an emulator, and the daemon supplies the lines. It is also why
 * these are the easiest parts of the phase to test exhaustively, since a test is an
 * array of strings and an expected point.
 *
 * Columns are *code point* offsets into a row, not display columns. A snapshot row and
 * its string agree on that for everything except double-width characters, which is a
 * known and recorded limitation rather than an oversight: fixing it means threading cell
 * widths through every motion, and nothing in phase 4 reads a CJK selection.
 */

/** A position in pane content. `row` counts from the top of the scrollback. */
export interface TextPoint {
  readonly row: number
  readonly col: number
}

export interface TextRange {
  readonly start: TextPoint
  readonly end: TextPoint
}

export type CopyMotion =
  | 'line_end'
  | 'first_non_blank'
  | 'next_word_start'
  | 'previous_word_start'
  | 'next_word_end'
  | 'next_big_word_start'
  | 'previous_big_word_start'
  | 'next_big_word_end'
  | 'previous_paragraph'
  | 'next_paragraph'

export type SearchDirection = 'forward' | 'backward'

export function comparePoints(a: TextPoint, b: TextPoint): number {
  if (a.row !== b.row) return a.row - b.row
  return a.col - b.col
}

/** Put a point inside the content. Rows clamp; a column may sit one past the last char. */
export function clampPoint(lines: readonly string[], point: TextPoint): TextPoint {
  if (lines.length === 0) return { row: 0, col: 0 }
  const row = Math.min(Math.max(0, Math.floor(point.row)), lines.length - 1)
  const line = lines[row] ?? ''
  const col = Math.min(Math.max(0, Math.floor(point.col)), line.length)
  return { row, col }
}

/**
 * The text between two points, in either order.
 *
 * The range is inclusive of the anchor cell and exclusive of the cursor cell, the way a
 * terminal selection reads: dragging from one character to the next selects one
 * character. Trailing whitespace on interior rows is kept, because a selection that
 * silently reflows is worse than one that carries spaces.
 */
export function readSelection(lines: readonly string[], anchor: TextPoint, cursor: TextPoint): string {
  if (lines.length === 0) return ''
  const a = clampPoint(lines, anchor)
  const b = clampPoint(lines, cursor)
  const [start, end] = comparePoints(a, b) <= 0 ? [a, b] : [b, a]

  if (start.row === end.row) {
    return (lines[start.row] ?? '').slice(start.col, end.col)
  }
  const parts: string[] = [(lines[start.row] ?? '').slice(start.col)]
  for (let row = start.row + 1; row < end.row; row++) parts.push(lines[row] ?? '')
  parts.push((lines[end.row] ?? '').slice(0, end.col))
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Word classes
// ---------------------------------------------------------------------------

type CharClass = 'blank' | 'word' | 'punct'

function classOf(ch: string | undefined): CharClass {
  if (ch === undefined || ch === ' ' || ch === '\t') return 'blank'
  if (/[\p{L}\p{N}_]/u.test(ch)) return 'word'
  return 'punct'
}

/** A "big word" is anything non-blank, the way vim's `W` counts. */
function bigClassOf(ch: string | undefined): CharClass {
  return classOf(ch) === 'blank' ? 'blank' : 'word'
}

interface Cursor {
  row: number
  col: number
}

function charAt(lines: readonly string[], at: Cursor): string | undefined {
  return (lines[at.row] ?? '')[at.col]
}

/**
 * Step one character, wrapping across rows. Returns false at the end of the content.
 *
 * An empty row is one stop, not zero: skipping it would make a motion jump two
 * paragraphs when the user asked for one word.
 */
function stepForward(lines: readonly string[], at: Cursor): boolean {
  const line = lines[at.row] ?? ''
  if (at.col < line.length - 1) {
    at.col += 1
    return true
  }
  if (at.row >= lines.length - 1) return false
  at.row += 1
  at.col = 0
  return true
}

function stepBackward(lines: readonly string[], at: Cursor): boolean {
  if (at.col > 0) {
    at.col -= 1
    return true
  }
  if (at.row === 0) return false
  at.row -= 1
  at.col = Math.max(0, (lines[at.row] ?? '').length - 1)
  return true
}

function isBlankLine(line: string | undefined): boolean {
  return line === undefined || line.trim().length === 0
}

/**
 * Apply a vi-style motion.
 *
 * Every motion is total: it returns a point inside the content even when there is
 * nowhere to go, so a caller never has to handle "the motion failed". That matches
 * herdr, where a motion at the end of the buffer simply stays put.
 */
export function applyMotion(lines: readonly string[], cursor: TextPoint, motion: CopyMotion): TextPoint {
  if (lines.length === 0) return { row: 0, col: 0 }
  const start = clampPoint(lines, cursor)
  const at: Cursor = { row: start.row, col: start.col }

  switch (motion) {
    case 'line_end': {
      const line = lines[at.row] ?? ''
      return { row: at.row, col: Math.max(0, line.length - 1) }
    }
    case 'first_non_blank': {
      const line = lines[at.row] ?? ''
      const index = line.search(/\S/u)
      return { row: at.row, col: index < 0 ? 0 : index }
    }
    case 'next_word_start':
      return wordStartForward(lines, at, classOf)
    case 'next_big_word_start':
      return wordStartForward(lines, at, bigClassOf)
    case 'previous_word_start':
      return wordStartBackward(lines, at, classOf)
    case 'previous_big_word_start':
      return wordStartBackward(lines, at, bigClassOf)
    case 'next_word_end':
      return wordEndForward(lines, at, classOf)
    case 'next_big_word_end':
      return wordEndForward(lines, at, bigClassOf)
    case 'next_paragraph': {
      let row = at.row
      // Leave the current block first, or a motion inside a gap would not move.
      while (row < lines.length - 1 && !isBlankLine(lines[row])) row += 1
      while (row < lines.length - 1 && isBlankLine(lines[row])) row += 1
      return { row, col: 0 }
    }
    case 'previous_paragraph': {
      let row = at.row
      while (row > 0 && !isBlankLine(lines[row])) row -= 1
      while (row > 0 && isBlankLine(lines[row])) row -= 1
      return { row, col: 0 }
    }
  }
}

function wordStartForward(
  lines: readonly string[],
  at: Cursor,
  classify: (ch: string | undefined) => CharClass
): TextPoint {
  const startClass = classify(charAt(lines, at))
  // Skip the rest of the current run, then any blanks: the next word starts after both.
  if (startClass !== 'blank') {
    while (classify(charAt(lines, at)) === startClass) {
      if (!stepForward(lines, at)) return { row: at.row, col: at.col }
    }
  }
  while (classify(charAt(lines, at)) === 'blank') {
    if (!stepForward(lines, at)) return { row: at.row, col: at.col }
  }
  return { row: at.row, col: at.col }
}

function wordStartBackward(
  lines: readonly string[],
  at: Cursor,
  classify: (ch: string | undefined) => CharClass
): TextPoint {
  if (!stepBackward(lines, at)) return { row: at.row, col: at.col }
  while (classify(charAt(lines, at)) === 'blank') {
    if (!stepBackward(lines, at)) return { row: at.row, col: at.col }
  }
  const runClass = classify(charAt(lines, at))
  // Walk to the first character of the run we just landed in.
  for (;;) {
    const probe: Cursor = { row: at.row, col: at.col }
    if (!stepBackward(lines, probe)) break
    if (classify(charAt(lines, probe)) !== runClass) break
    at.row = probe.row
    at.col = probe.col
  }
  return { row: at.row, col: at.col }
}

function wordEndForward(
  lines: readonly string[],
  at: Cursor,
  classify: (ch: string | undefined) => CharClass
): TextPoint {
  if (!stepForward(lines, at)) return { row: at.row, col: at.col }
  while (classify(charAt(lines, at)) === 'blank') {
    if (!stepForward(lines, at)) return { row: at.row, col: at.col }
  }
  const runClass = classify(charAt(lines, at))
  for (;;) {
    const probe: Cursor = { row: at.row, col: at.col }
    if (!stepForward(lines, probe)) break
    if (classify(charAt(lines, probe)) !== runClass) break
    at.row = probe.row
    at.col = probe.col
  }
  return { row: at.row, col: at.col }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchOptions {
  readonly direction: SearchDirection
  readonly cursor: TextPoint
  /** The match this search is stepping past, so `n` advances instead of sticking. */
  readonly previous?: TextRange
  /** Case-insensitive unless the query has an uppercase character (vim's smartcase). */
  readonly smartCase?: boolean
}

/**
 * Find the next match, wrapping once around the content.
 *
 * Plain substring search, not a regex: a user searching a terminal for `[error]` means
 * those characters. herdr does the same.
 */
export function searchContent(
  lines: readonly string[],
  query: string,
  options: SearchOptions
): TextRange | null {
  if (query.length === 0 || lines.length === 0) return null
  const smart = options.smartCase ?? true
  const fold = smart && query === query.toLowerCase()
  const needle = fold ? query.toLowerCase() : query
  const haystack = fold ? lines.map((line) => line.toLowerCase()) : lines

  const from = clampPoint(lines, options.previous?.start ?? options.cursor)
  const total = lines.length

  if (options.direction === 'forward') {
    for (let step = 0; step <= total; step++) {
      const row = (from.row + step) % total
      const line = haystack[row] ?? ''
      // On the first row start just past the anchor column, so `n` moves off the match.
      const begin = step === 0 ? from.col + (options.previous === undefined ? 0 : 1) : 0
      if (begin > line.length) continue
      const index = line.indexOf(needle, begin)
      if (index >= 0) return rangeAt(row, index, query.length)
    }
    return null
  }

  for (let step = 0; step <= total; step++) {
    const row = ((from.row - step) % total + total) % total
    const line = haystack[row] ?? ''
    const limit = step === 0 ? from.col - 1 : line.length
    if (limit < 0) continue
    const index = line.lastIndexOf(needle, limit)
    if (index >= 0) return rangeAt(row, index, query.length)
  }
  return null
}

function rangeAt(row: number, col: number, length: number): TextRange {
  return { start: { row, col }, end: { row, col: col + length } }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * The URL under a cell, if any.
 *
 * Deliberately narrow: a scheme this list knows, then non-space characters, with
 * trailing punctuation that is almost always sentence punctuation trimmed off. herdr
 * also honours OSC 8 hyperlinks, which need the emulator's cell attributes rather than
 * its text, and are therefore not here.
 */
export const LINK_SCHEMES: readonly string[] = ['http://', 'https://', 'file://', 'ftp://', 'mailto:']

const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', '>', '"', "'"])

export interface LinkHit {
  readonly url: string
  readonly range: TextRange
}

export function linkAt(lines: readonly string[], point: TextPoint): LinkHit | null {
  if (lines.length === 0) return null
  const at = clampPoint(lines, point)
  const line = lines[at.row] ?? ''

  for (const scheme of LINK_SCHEMES) {
    let index = line.indexOf(scheme)
    while (index >= 0) {
      let end = index
      while (end < line.length && !/\s/u.test(line[end] as string)) end += 1
      while (end > index && TRAILING_PUNCTUATION.has(line[end - 1] as string)) end -= 1
      if (end > index + scheme.length && at.col >= index && at.col < end) {
        return { url: line.slice(index, end), range: { start: { row: at.row, col: index }, end: { row: at.row, col: end } } }
      }
      index = line.indexOf(scheme, index + 1)
    }
  }
  return null
}
