/**
 * Column width of a character.
 *
 * Not a deliverable in PHASE-2's list, but `Buffer.writeString` and snapshot blitting
 * both need it and neither should own it. Deliberately small: the two facts a cell grid
 * cares about are "this occupies no column of its own" (combining marks, variation
 * selectors, zero-width joiners) and "this occupies two" (East Asian Wide/Fullwidth,
 * most emoji). Everything else is one.
 *
 * The daemon already reports authoritative widths per *run*, so this is only consulted
 * when a run is not plain ASCII, or when the TUI draws its own text.
 */

/** Ranges that occupy zero columns: combining marks, joiners, variation selectors. */
const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0711, 0x0711],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0816, 0x0819],
  [0x08e3, 0x0903],
  [0x093a, 0x093c],
  [0x0941, 0x0948],
  [0x094d, 0x094d],
  [0x0951, 0x0957],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x135d, 0x135f],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // ZWSP .. RLM (includes ZWJ at 200d)
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f], // variation selectors
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xe0100, 0xe01ef]
]

/** Ranges that occupy two columns (East Asian Wide and Fullwidth, plus emoji blocks). */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial
  [0x2e80, 0x303e], // CJK radicals .. CJK symbols
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd]
]

function inRanges(code: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const range = ranges[mid]
    if (!range) break
    if (code < range[0]) hi = mid - 1
    else if (code > range[1]) lo = mid + 1
    else return true
  }
  return false
}

/** Columns a single code point occupies. */
export function codePointWidth(code: number): number {
  if (code === 0) return 0
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0 // control characters draw nothing
  if (code < 0x7f) return 1 // the overwhelmingly common case, checked first
  if (inRanges(code, ZERO_WIDTH)) return 0
  if (inRanges(code, WIDE)) return 2
  return 1
}

/**
 * Columns a grapheme cluster occupies: the width of its base character. A cluster is
 * one cell even when several code points long, which is why this is not a sum.
 */
export function clusterWidth(cluster: string): number {
  const first = cluster.codePointAt(0)
  if (first === undefined) return 0
  return codePointWidth(first)
}

let segmenter: Intl.Segmenter | null = null

/** Split text into grapheme clusters. Lazily built: constructing a Segmenter is not free. */
export function graphemes(text: string): string[] {
  if (segmenter === null) segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const out: string[] = []
  for (const { segment } of segmenter.segment(text)) out.push(segment)
  return out
}

/** True when every character is printable 7-bit ASCII, so one char is exactly one column. */
export function isPlainAscii(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code > 0x7e) return false
  }
  return true
}

/** Total columns a string occupies. */
export function stringWidth(text: string): number {
  if (isPlainAscii(text)) return text.length
  let total = 0
  for (const cluster of graphemes(text)) total += clusterWidth(cluster)
  return total
}
