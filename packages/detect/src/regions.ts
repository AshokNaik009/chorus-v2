/**
 * Regions: which slice of the screen a rule is allowed to look at.
 *
 * Ported from herdr's `src/detect/manifest.rs` (Apache-2.0, herdr 3f2a6e74). A rule
 * that matched the whole pane would fire on the user's own prose the moment they typed
 * "do you want to proceed?" into a prompt, so every rule names a region and the region
 * is the rule's real precision.
 *
 * ## One deliberate difference from herdr
 *
 * herdr computes a slice offset as `sum(line.len() + 1)`, which assumes `\n`
 * separators; on `\r\n` input its `lines()` strips the `\r` and the offsets drift by a
 * byte per line. This walks an explicit line-start table instead, so the slice is
 * exact whatever the separator is. Screen text from the emulator is `\n`-joined, so the
 * two agree on every input we produce — but a region that is quietly off by three
 * characters is not a bug worth keeping for fidelity's sake.
 */

/** Everything a rule may read. OSC strings are their own regions, not screen text. */
export interface DetectionInput {
  readonly screen: string
  readonly oscTitle: string
  readonly oscProgress: string
}

export function detectionInput(partial: Partial<DetectionInput>): DetectionInput {
  return {
    screen: partial.screen ?? '',
    oscTitle: partial.oscTitle ?? '',
    oscProgress: partial.oscProgress ?? ''
  }
}

const NAMED_REGIONS = [
  'whole_recent',
  'after_last_prompt_marker',
  'before_current_prompt_marker',
  'whole_recent_without_current_prompt_marker',
  'current_prompt_block_marker',
  'after_current_prompt_block_marker',
  'prompt_box_body',
  'above_prompt_box',
  'last_non_empty_above_prompt_box',
  'after_last_horizontal_rule',
  'osc_title',
  'osc_progress'
] as const

export type NamedRegion = (typeof NAMED_REGIONS)[number]

/** `top_non_empty_lines` arrived with engine 3; a manifest below that may not use it. */
export const TOP_NON_EMPTY_LINES_ENGINE_VERSION = 3
const MAX_TOP_REGION_LINE_COUNT = 0xffff

/** Validate a region spec, returning null when it names nothing. */
export function parseRegionSpec(spec: string): { kind: string; count?: number } | null {
  const trimmed = spec.trim()
  if ((NAMED_REGIONS as readonly string[]).includes(trimmed)) return { kind: trimmed }
  for (const name of ['bottom_lines', 'bottom_non_empty_lines']) {
    const count = countArgument(trimmed, name)
    if (count !== null) return { kind: name, count }
  }
  const top = topRegionCount(trimmed)
  if (top !== null) return { kind: 'top_non_empty_lines', count: top }
  return null
}

/** Extract the text a rule sees. An unknown region is empty, as in herdr. */
export function region(input: DetectionInput, spec: string): string {
  const trimmed = spec.trim()
  // OSC regions source from their own fields, never from the screen.
  if (trimmed === 'osc_title') return input.oscTitle
  if (trimmed === 'osc_progress') return input.oscProgress

  const content = input.screen
  switch (trimmed) {
    case 'whole_recent':
      return content
    case 'after_last_prompt_marker':
      return afterLastPromptMarker(content)
    case 'before_current_prompt_marker':
      return beforeCurrentPromptMarker(content)
    case 'whole_recent_without_current_prompt_marker':
      return currentPromptIndex(splitLines(content)) === null ? content : ''
    case 'current_prompt_block_marker':
      return currentPromptBlockMarker(content) ?? ''
    case 'after_current_prompt_block_marker':
      return afterCurrentPromptBlockMarker(content) ?? ''
    case 'prompt_box_body':
      return promptBoxBody(content) ?? ''
    case 'above_prompt_box':
      return abovePromptBox(content)
    case 'last_non_empty_above_prompt_box':
      return lastNonEmptyLine(abovePromptBox(content))
    case 'after_last_horizontal_rule':
      return afterLastHorizontalRule(content)
    default:
      break
  }

  const bottom = countArgument(trimmed, 'bottom_lines')
  if (bottom !== null) return bottomLines(content, bottom)
  const bottomNonEmpty = countArgument(trimmed, 'bottom_non_empty_lines')
  if (bottomNonEmpty !== null) return bottomNonEmptyLines(content, bottomNonEmpty)
  const top = topRegionCount(trimmed)
  if (top !== null) return topNonEmptyLines(content, top)
  return ''
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

interface Lines {
  /** Line text, `\r` stripped, exactly as Rust's `str::lines()` yields it. */
  readonly text: string[]
  /** Index into the original string where each line begins, plus one past the end. */
  readonly starts: number[]
}

/**
 * Split like Rust's `str::lines()`: on `\n`, dropping one trailing `\r`, and with no
 * empty final element for a string that ends in a newline.
 */
export function splitLines(content: string): Lines {
  const text: string[] = []
  const starts: number[] = []
  let index = 0
  // Stops at `content.length` rather than past it: a trailing newline ends the last
  // line, it does not begin an empty one.
  while (index < content.length) {
    const newline = content.indexOf('\n', index)
    const end = newline === -1 ? content.length : newline
    let line = content.slice(index, end)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    text.push(line)
    starts.push(index)
    if (newline === -1) break
    index = newline + 1
  }
  starts.push(content.length)
  return { text, starts }
}

function sliceFrom(content: string, lines: Lines, index: number): string {
  return content.slice(lineStart(content, lines, index))
}

function lineStart(content: string, lines: Lines, index: number): number {
  if (index <= 0) return 0
  if (index >= lines.text.length) return content.length
  return lines.starts[index] as number
}

// ---------------------------------------------------------------------------
// Counted regions
// ---------------------------------------------------------------------------

function countArgument(spec: string, name: string): number | null {
  if (!spec.startsWith(`${name}(`) || !spec.endsWith(')')) return null
  const digits = spec.slice(name.length + 1, -1)
  if (!/^\d+$/.test(digits)) return null
  return Number.parseInt(digits, 10)
}

function topRegionCount(spec: string): number | null {
  const count = countArgument(spec, 'top_non_empty_lines')
  // Leading zeros are rejected the way herdr rejects them, so `top_non_empty_lines(05)`
  // is an invalid region rather than a surprising one.
  if (count === null || /^0/.test(spec.slice('top_non_empty_lines('.length, -1))) return null
  return count <= MAX_TOP_REGION_LINE_COUNT ? count : null
}

function bottomLines(content: string, count: number): string {
  const lines = splitLines(content)
  return sliceFrom(content, lines, Math.max(0, lines.text.length - count))
}

function bottomNonEmptyLines(content: string, count: number): string {
  const lines = splitLines(content)
  let seen = 0
  let start = -1
  for (let i = lines.text.length - 1; i >= 0 && seen < count; i--) {
    if ((lines.text[i] as string).trim().length === 0) continue
    seen += 1
    start = i
  }
  return start === -1 ? '' : sliceFrom(content, lines, start)
}

function topNonEmptyLines(content: string, count: number): string {
  const lines = splitLines(content)
  let seen = 0
  let end = -1
  for (let i = 0; i < lines.text.length && seen < count; i++) {
    if ((lines.text[i] as string).trim().length === 0) continue
    seen += 1
    end = i
  }
  return end === -1 ? '' : content.slice(0, lineStart(content, lines, end + 1))
}

// ---------------------------------------------------------------------------
// Prompt markers (codex's `›` prompt and its block bullets)
// ---------------------------------------------------------------------------

function isPromptLine(line: string): boolean {
  return line === '›' || line.startsWith('› ')
}

function isBlockMarkerLine(line: string): boolean {
  return line.startsWith('•') || line.startsWith('■') || line.startsWith('✗') || line.startsWith('✓')
}

function lastIndexWhere(lines: string[], predicate: (line: string) => boolean): number {
  for (let i = lines.length - 1; i >= 0; i--) if (predicate(lines[i] as string)) return i
  return -1
}

function afterLastPromptMarker(content: string): string {
  const lines = splitLines(content)
  const index = lastIndexWhere(lines.text, isPromptLine)
  return index === -1 ? content : sliceFrom(content, lines, index + 1)
}

/**
 * The newest prompt marker, but only while it is still the newest thing on screen.
 *
 * A block marker *after* it means the agent has answered since, so that prompt is
 * stale and there is no current one.
 */
function currentPromptIndex(lines: Lines): number | null {
  const index = lastIndexWhere(lines.text, isPromptLine)
  if (index === -1) return null
  for (let i = index + 1; i < lines.text.length; i++) {
    if (isBlockMarkerLine(lines.text[i] as string)) return null
  }
  return index
}

function beforeCurrentPromptMarker(content: string): string {
  const lines = splitLines(content)
  const index = currentPromptIndex(lines)
  if (index === null) return content
  return content.slice(0, lineStart(content, lines, index))
}

function currentPromptBlockMarker(content: string): string | null {
  const lines = splitLines(content)
  const index = currentPromptIndex(lines)
  if (index === null) return null
  for (let i = index - 1; i >= 0; i--) {
    const line = lines.text[i] as string
    if (isBlockMarkerLine(line)) return line
  }
  return null
}

function afterCurrentPromptBlockMarker(content: string): string | null {
  const lines = splitLines(content)
  const index = currentPromptIndex(lines)
  if (index === null) return null
  for (let i = index - 1; i >= 0; i--) {
    if (isBlockMarkerLine(lines.text[i] as string)) return sliceFrom(content, lines, i)
  }
  return null
}

// ---------------------------------------------------------------------------
// The prompt box (claude's boxed input)
// ---------------------------------------------------------------------------

/**
 * A run of box-drawing horizontals, optionally with a label after it.
 *
 * The three-character floor is what keeps a line of prose containing one `─` from
 * being read as the top of the input box.
 */
export function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length === 0) return false
  let ruleChars = 0
  while (ruleChars < trimmed.length && trimmed[ruleChars] === '─') ruleChars += 1
  if (ruleChars === 0) return false
  const suffix = trimmed.slice(ruleChars).trimStart()
  return suffix.length === 0 || ruleChars >= 3
}

/** The *second* rule from the bottom: the box has a floor and a ceiling. */
function promptBoxTopBorderIndex(lines: string[]): number | null {
  let seen = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isHorizontalRule(lines[i] as string)) continue
    seen += 1
    if (seen === 2) return i
  }
  return null
}

function promptBoxBody(content: string): string | null {
  const lines = splitLines(content)
  const top = promptBoxTopBorderIndex(lines.text)
  if (top === null) return null
  const start = lineStart(content, lines, top + 1)
  let endIndex = lines.text.length
  for (let i = top + 1; i < lines.text.length; i++) {
    if (isHorizontalRule(lines.text[i] as string)) {
      endIndex = i
      break
    }
  }
  return content.slice(start, lineStart(content, lines, endIndex))
}

function abovePromptBox(content: string): string {
  const lines = splitLines(content)
  const top = promptBoxTopBorderIndex(lines.text)
  if (top === null) return content
  return content.slice(0, lineStart(content, lines, top))
}

function afterLastHorizontalRule(content: string): string {
  const lines = splitLines(content)
  let start = 0
  for (let i = 0; i < lines.text.length; i++) {
    if (isHorizontalRule(lines.text[i] as string)) start = lineStart(content, lines, i + 1)
  }
  return content.slice(start)
}

function lastNonEmptyLine(content: string): string {
  const lines = splitLines(content)
  for (let i = lines.text.length - 1; i >= 0; i--) {
    const line = lines.text[i] as string
    if (line.trim().length > 0) return line
  }
  return ''
}
