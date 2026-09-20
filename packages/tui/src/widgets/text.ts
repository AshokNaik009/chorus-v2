/**
 * Styled text: spans, lines, and a paragraph that wraps.
 *
 * Wrapping is width-aware, not length-aware — a line of CJK breaks at half as many
 * characters as a line of ASCII, and a combining mark never counts as a break
 * opportunity. Used by status bars, the help overlay, and pane placeholders.
 */

import type { ScreenBuffer } from '../buffer.js'
import { DEFAULT_STYLE, type Style } from '../cell.js'
import { intersection, type Rect } from '../rect.js'
import { stringWidth } from '../width.js'

export interface Span {
  readonly text: string
  readonly style?: Style
}

export interface TextLine {
  readonly spans: readonly Span[]
}

export function span(text: string, style?: Style): Span {
  return style === undefined ? { text } : { text, style }
}

export function line(...spans: Span[]): TextLine {
  return { spans }
}

export type Alignment = 'left' | 'center' | 'right'

export interface ParagraphOptions {
  readonly wrap?: boolean
  readonly align?: Alignment
  readonly style?: Style
  /** First rendered line, for a scrolled view. */
  readonly scroll?: number
}

export function lineWidth(text: TextLine): number {
  let total = 0
  for (const s of text.spans) total += stringWidth(s.text)
  return total
}

/** Render lines into `area`, returning how many rows were used. */
export function renderParagraph(
  buffer: ScreenBuffer,
  area: Rect,
  lines: readonly TextLine[],
  options: ParagraphOptions = {}
): number {
  const clipped = intersection(area, buffer.rect)
  if (clipped.width === 0 || clipped.height === 0) return 0

  const base = options.style ?? DEFAULT_STYLE
  const laid = options.wrap === true ? lines.flatMap((text) => wrapLine(text, clipped.width)) : lines
  const scroll = Math.max(0, options.scroll ?? 0)

  let row = 0
  for (let i = scroll; i < laid.length && row < clipped.height; i++, row++) {
    const text = laid[i]
    if (!text) continue
    const width = lineWidth(text)
    const offset =
      options.align === 'center'
        ? Math.max(0, Math.floor((clipped.width - width) / 2))
        : options.align === 'right'
          ? Math.max(0, clipped.width - width)
          : 0
    let x = clipped.x + offset
    const limit = clipped.x + clipped.width
    for (const s of text.spans) {
      if (x >= limit) break
      x = buffer.writeString(x, clipped.y + row, s.text, s.style ?? base, limit)
    }
  }
  return row
}

/**
 * Break one line into lines that fit `width`, preferring spaces.
 *
 * Styles survive the break: a span split across two rows becomes two spans with the same
 * style, so a highlighted phrase stays highlighted on both.
 */
export function wrapLine(text: TextLine, width: number): TextLine[] {
  if (width <= 0) return []
  if (lineWidth(text) <= width) return [text]

  const out: TextLine[] = []
  let current: Span[] = []
  let used = 0

  const flush = (): void => {
    // Trailing whitespace on a wrapped line is invisible but not free: it pads the line
    // to the break column, so an aligned or background-styled paragraph shows the padding.
    while (current.length > 0 && /^\s+$/u.test(current[current.length - 1]?.text ?? '')) current.pop()
    out.push({ spans: current })
    current = []
    used = 0
  }

  for (const s of text.spans) {
    // Keep separators attached to the preceding word so a break lands after them.
    const words = s.text.split(/(\s+)/u).filter((word) => word.length > 0)
    for (const word of words) {
      const wordWidth = stringWidth(word)
      if (used + wordWidth <= width) {
        current.push(s.style === undefined ? { text: word } : { text: word, style: s.style })
        used += wordWidth
        continue
      }
      if (used > 0) {
        flush()
        // A line never starts with the whitespace that caused the break.
        if (/^\s+$/u.test(word)) continue
      }
      if (wordWidth <= width) {
        current.push(s.style === undefined ? { text: word } : { text: word, style: s.style })
        used = wordWidth
        continue
      }
      // A single word longer than the line: hard-break it at the column limit.
      let chunk = ''
      let chunkWidth = 0
      for (const char of word) {
        const charWidth = stringWidth(char)
        if (chunkWidth + charWidth > width) {
          current.push(s.style === undefined ? { text: chunk } : { text: chunk, style: s.style })
          flush()
          chunk = ''
          chunkWidth = 0
        }
        chunk += char
        chunkWidth += charWidth
      }
      if (chunk.length > 0) {
        current.push(s.style === undefined ? { text: chunk } : { text: chunk, style: s.style })
        used = chunkWidth
      }
    }
  }
  if (current.length > 0 || out.length === 0) flush()
  return out
}
