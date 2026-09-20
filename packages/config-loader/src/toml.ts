/**
 * A TOML 1.0 parser, for config files.
 *
 * ## Why this exists rather than a dependency
 *
 * PHASE-4 posed the collision squarely: `core` must have zero runtime dependencies, and
 * Node has no built-in TOML parser (no `node:toml`, and no proposal for one). The phase
 * offered two ways out — move the parser into a separate package that owns the
 * dependency, or drop TOML for JSONC. This takes the first, and then finds it does not
 * need the dependency either: the subset of TOML a config file uses is a few hundred
 * lines, and writing it keeps the whole repository at zero third-party runtime
 * dependencies outside the two that earn their place (`node-pty`, `@xterm/headless`).
 *
 * ## What is supported
 *
 * Comments; bare, quoted and dotted keys; `[table]` and `[[array of tables]]`; basic and
 * literal strings including their multi-line forms; integers in all four bases with
 * underscores; floats including `inf` and `nan`; booleans; arrays; inline tables.
 *
 * ## What is not
 *
 * Offset/local date-times. A config file has no use for one, and accepting them would
 * mean deciding what a `Date` means to the schema. A date-time in a config file is a
 * parse error naming its line, which is a better outcome than silently reading it as a
 * string.
 */

export class TomlError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number
  ) {
    super(`${message} (line ${line}, column ${column})`)
    this.name = 'TomlError'
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue }

interface Cursor {
  readonly text: string
  index: number
}

const BARE_KEY = /[A-Za-z0-9_-]/u

export function parseToml(text: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {}
  const cursor: Cursor = { text: stripBom(text), index: 0 }
  // Tables created by a header, so a second `[a]` is a duplicate but `[a.b]` after
  // `[a]` is not. Tables created implicitly by a dotted key are not in here.
  const declared = new Set<string>()
  const inlineOrArray = new Set<string>()
  let current = root
  let currentPath: string[] = []

  for (;;) {
    skipWhitespaceAndComments(cursor)
    if (cursor.index >= cursor.text.length) break

    if (peek(cursor) === '[') {
      const isArray = cursor.text.startsWith('[[', cursor.index)
      cursor.index += isArray ? 2 : 1
      skipInlineWhitespace(cursor)
      const path = parseKeyPath(cursor)
      skipInlineWhitespace(cursor)
      expect(cursor, isArray ? ']]' : ']')
      requireLineEnd(cursor)

      const joined = path.join('\u0000')
      if (isArray) {
        current = pushArrayTable(root, path, cursor, inlineOrArray)
        declared.add(`${joined}\u0000#${(getArray(root, path) ?? []).length - 1}`)
      } else {
        if (declared.has(joined)) throw error(cursor, `table [${path.join('.')}] is defined twice`)
        declared.add(joined)
        current = descend(root, path, cursor, inlineOrArray)
      }
      currentPath = path
      continue
    }

    const path = parseKeyPath(cursor)
    skipInlineWhitespace(cursor)
    expect(cursor, '=')
    skipInlineWhitespace(cursor)
    const value = parseValue(cursor)
    requireLineEnd(cursor)

    const table = path.length === 1 ? current : descend(current, path.slice(0, -1), cursor, inlineOrArray)
    const key = path[path.length - 1] as string
    if (Object.prototype.hasOwnProperty.call(table, key)) {
      throw error(cursor, `key \`${[...currentPath, ...path].join('.')}\` is defined twice`)
    }
    table[key] = value
  }

  return root
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

function positionOf(cursor: Cursor): { line: number; column: number } {
  let line = 1
  let lastBreak = -1
  for (let i = 0; i < cursor.index && i < cursor.text.length; i++) {
    if (cursor.text[i] === '\n') {
      line += 1
      lastBreak = i
    }
  }
  return { line, column: cursor.index - lastBreak }
}

function error(cursor: Cursor, message: string): TomlError {
  const { line, column } = positionOf(cursor)
  return new TomlError(message, line, column)
}

function peek(cursor: Cursor, offset = 0): string | undefined {
  return cursor.text[cursor.index + offset]
}

function skipInlineWhitespace(cursor: Cursor): void {
  while (peek(cursor) === ' ' || peek(cursor) === '\t') cursor.index += 1
}

function skipWhitespaceAndComments(cursor: Cursor): void {
  for (;;) {
    const ch = peek(cursor)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      cursor.index += 1
      continue
    }
    if (ch === '#') {
      while (cursor.index < cursor.text.length && peek(cursor) !== '\n') cursor.index += 1
      continue
    }
    return
  }
}

function requireLineEnd(cursor: Cursor): void {
  skipInlineWhitespace(cursor)
  if (peek(cursor) === '#') {
    while (cursor.index < cursor.text.length && peek(cursor) !== '\n') cursor.index += 1
  }
  const ch = peek(cursor)
  if (ch === undefined) return
  if (ch === '\n') {
    cursor.index += 1
    return
  }
  if (ch === '\r' && peek(cursor, 1) === '\n') {
    cursor.index += 2
    return
  }
  throw error(cursor, `unexpected \`${ch}\` after value`)
}

function expect(cursor: Cursor, token: string): void {
  if (!cursor.text.startsWith(token, cursor.index)) throw error(cursor, `expected \`${token}\``)
  cursor.index += token.length
}

function parseKeyPath(cursor: Cursor): string[] {
  const path: string[] = [parseKeyPart(cursor)]
  for (;;) {
    skipInlineWhitespace(cursor)
    if (peek(cursor) !== '.') return path
    cursor.index += 1
    skipInlineWhitespace(cursor)
    path.push(parseKeyPart(cursor))
  }
}

function parseKeyPart(cursor: Cursor): string {
  const ch = peek(cursor)
  if (ch === '"') return parseBasicString(cursor)
  if (ch === "'") return parseLiteralString(cursor)
  let key = ''
  while (cursor.index < cursor.text.length && BARE_KEY.test(cursor.text[cursor.index] as string)) {
    key += cursor.text[cursor.index]
    cursor.index += 1
  }
  if (key.length === 0) throw error(cursor, 'expected a key')
  return key
}

/** Walk (creating as needed) to the table at `path`. Rejects overwriting a non-table. */
function descend(
  root: Record<string, TomlValue>,
  path: readonly string[],
  cursor: Cursor,
  inlineOrArray: Set<string>
): Record<string, TomlValue> {
  let table = root
  const trail: string[] = []
  for (const key of path) {
    trail.push(key)
    if (inlineOrArray.has(trail.join('\u0000'))) {
      throw error(cursor, `cannot extend inline table \`${trail.join('.')}\``)
    }
    const existing = table[key]
    if (existing === undefined) {
      const created: Record<string, TomlValue> = {}
      table[key] = created
      table = created
      continue
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1]
      if (last === undefined || typeof last !== 'object' || Array.isArray(last)) {
        throw error(cursor, `\`${trail.join('.')}\` is not a table`)
      }
      table = last as Record<string, TomlValue>
      continue
    }
    if (typeof existing !== 'object') throw error(cursor, `\`${trail.join('.')}\` is not a table`)
    table = existing as Record<string, TomlValue>
  }
  return table
}

function getArray(root: Record<string, TomlValue>, path: readonly string[]): TomlValue[] | null {
  let value: TomlValue | undefined = root
  for (const key of path) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    value = (value as Record<string, TomlValue>)[key]
  }
  return Array.isArray(value) ? value : null
}

function pushArrayTable(
  root: Record<string, TomlValue>,
  path: readonly string[],
  cursor: Cursor,
  inlineOrArray: Set<string>
): Record<string, TomlValue> {
  const parent = path.length === 1 ? root : descend(root, path.slice(0, -1), cursor, inlineOrArray)
  const key = path[path.length - 1] as string
  const existing = parent[key]
  const created: Record<string, TomlValue> = {}
  if (existing === undefined) {
    parent[key] = [created]
    return created
  }
  if (!Array.isArray(existing)) throw error(cursor, `\`${path.join('.')}\` is not an array of tables`)
  existing.push(created)
  return created
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function parseValue(cursor: Cursor): TomlValue {
  const ch = peek(cursor)
  if (ch === undefined) throw error(cursor, 'expected a value')
  if (ch === '"') {
    return cursor.text.startsWith('"""', cursor.index)
      ? parseMultilineBasicString(cursor)
      : parseBasicString(cursor)
  }
  if (ch === "'") {
    return cursor.text.startsWith("'''", cursor.index)
      ? parseMultilineLiteralString(cursor)
      : parseLiteralString(cursor)
  }
  if (ch === '[') return parseArray(cursor)
  if (ch === '{') return parseInlineTable(cursor)
  return parseAtom(cursor)
}

const ESCAPES: Readonly<Record<string, string>> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  '"': '"',
  '\\': '\\'
}

function parseEscape(cursor: Cursor): string {
  const ch = peek(cursor)
  if (ch === undefined) throw error(cursor, 'unterminated escape')
  const simple = ESCAPES[ch]
  if (simple !== undefined) {
    cursor.index += 1
    return simple
  }
  if (ch === 'u' || ch === 'U') {
    const length = ch === 'u' ? 4 : 8
    const digits = cursor.text.slice(cursor.index + 1, cursor.index + 1 + length)
    if (digits.length !== length || !/^[0-9a-fA-F]+$/u.test(digits)) {
      throw error(cursor, `\\${ch} needs ${length} hex digits`)
    }
    cursor.index += 1 + length
    return String.fromCodePoint(Number.parseInt(digits, 16))
  }
  throw error(cursor, `unknown escape \\${ch}`)
}

function parseBasicString(cursor: Cursor): string {
  expect(cursor, '"')
  let out = ''
  for (;;) {
    const ch = peek(cursor)
    if (ch === undefined || ch === '\n') throw error(cursor, 'unterminated string')
    cursor.index += 1
    if (ch === '"') return out
    if (ch === '\\') {
      out += parseEscape(cursor)
      continue
    }
    out += ch
  }
}

function parseLiteralString(cursor: Cursor): string {
  expect(cursor, "'")
  let out = ''
  for (;;) {
    const ch = peek(cursor)
    if (ch === undefined || ch === '\n') throw error(cursor, 'unterminated literal string')
    cursor.index += 1
    if (ch === "'") return out
    out += ch
  }
}

function parseMultilineBasicString(cursor: Cursor): string {
  expect(cursor, '"""')
  // A newline immediately after the opening delimiter is not part of the value.
  if (peek(cursor) === '\r' && peek(cursor, 1) === '\n') cursor.index += 2
  else if (peek(cursor) === '\n') cursor.index += 1

  let out = ''
  for (;;) {
    if (cursor.text.startsWith('"""', cursor.index)) {
      // The delimiter is the *last* three quotes of the run, so `"""""` ends a string
      // whose final two characters are quotes.
      let run = 0
      while (peek(cursor, run) === '"') run += 1
      if (run > 5) throw error(cursor, 'too many quotes to end a multi-line string')
      out += '"'.repeat(run - 3)
      cursor.index += run
      return out
    }
    const ch = peek(cursor)
    if (ch === undefined) throw error(cursor, 'unterminated multi-line string')
    cursor.index += 1
    if (ch === '\\') {
      // A backslash at end of line swallows the newline and the indentation after it.
      let probe = cursor.index
      while (cursor.text[probe] === ' ' || cursor.text[probe] === '\t' || cursor.text[probe] === '\r') probe += 1
      if (cursor.text[probe] === '\n') {
        cursor.index = probe + 1
        while (peek(cursor) === ' ' || peek(cursor) === '\t' || peek(cursor) === '\n' || peek(cursor) === '\r') {
          cursor.index += 1
        }
        continue
      }
      out += parseEscape(cursor)
      continue
    }
    out += ch
  }
}

function parseMultilineLiteralString(cursor: Cursor): string {
  expect(cursor, "'''")
  if (peek(cursor) === '\r' && peek(cursor, 1) === '\n') cursor.index += 2
  else if (peek(cursor) === '\n') cursor.index += 1

  const end = cursor.text.indexOf("'''", cursor.index)
  if (end < 0) throw error(cursor, 'unterminated multi-line literal string')
  const out = cursor.text.slice(cursor.index, end)
  cursor.index = end + 3
  return out
}

function parseArray(cursor: Cursor): TomlValue[] {
  expect(cursor, '[')
  const out: TomlValue[] = []
  for (;;) {
    skipWhitespaceAndComments(cursor)
    if (peek(cursor) === ']') {
      cursor.index += 1
      return out
    }
    out.push(parseValue(cursor))
    skipWhitespaceAndComments(cursor)
    if (peek(cursor) === ',') {
      cursor.index += 1
      continue
    }
    if (peek(cursor) === ']') {
      cursor.index += 1
      return out
    }
    throw error(cursor, 'expected `,` or `]` in array')
  }
}

function parseInlineTable(cursor: Cursor): Record<string, TomlValue> {
  expect(cursor, '{')
  const table: Record<string, TomlValue> = {}
  skipInlineWhitespace(cursor)
  if (peek(cursor) === '}') {
    cursor.index += 1
    return table
  }
  for (;;) {
    skipInlineWhitespace(cursor)
    const path = parseKeyPath(cursor)
    skipInlineWhitespace(cursor)
    expect(cursor, '=')
    skipInlineWhitespace(cursor)
    const value = parseValue(cursor)
    let target = table
    for (const key of path.slice(0, -1)) {
      const existing = target[key]
      if (existing === undefined) {
        const created: Record<string, TomlValue> = {}
        target[key] = created
        target = created
      } else if (typeof existing === 'object' && !Array.isArray(existing)) {
        target = existing as Record<string, TomlValue>
      } else {
        throw error(cursor, `\`${key}\` is not a table`)
      }
    }
    target[path[path.length - 1] as string] = value
    skipInlineWhitespace(cursor)
    if (peek(cursor) === ',') {
      cursor.index += 1
      continue
    }
    if (peek(cursor) === '}') {
      cursor.index += 1
      return table
    }
    throw error(cursor, 'expected `,` or `}` in inline table')
  }
}

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}/u

function parseAtom(cursor: Cursor): TomlValue {
  const start = cursor.index
  while (cursor.index < cursor.text.length && !',]}\n\r#'.includes(cursor.text[cursor.index] as string)) {
    cursor.index += 1
  }
  const raw = cursor.text.slice(start, cursor.index).trim()
  cursor.index = start + raw.length

  if (raw === 'true') return true
  if (raw === 'false') return false
  if (DATE_LIKE.test(raw) || /^\d{2}:\d{2}:\d{2}/u.test(raw)) {
    throw error(cursor, 'date-times are not supported in leap-chorus config')
  }

  const number = parseNumber(raw)
  if (number !== null) return number
  throw error(cursor, `cannot read \`${raw}\` as a value`)
}

function parseNumber(raw: string): number | null {
  if (raw.length === 0) return null
  const cleaned = raw.replace(/_/gu, '')
  if (/^[+-]?0x[0-9a-fA-F]+$/u.test(cleaned)) return Number.parseInt(cleaned.replace('0x', ''), 16) * sign(cleaned)
  if (/^[+-]?0o[0-7]+$/u.test(cleaned)) return Number.parseInt(cleaned.replace('0o', ''), 8) * sign(cleaned)
  if (/^[+-]?0b[01]+$/u.test(cleaned)) return Number.parseInt(cleaned.replace('0b', ''), 2) * sign(cleaned)
  if (/^[+-]?inf$/u.test(cleaned)) return cleaned.startsWith('-') ? -Infinity : Infinity
  if (/^[+-]?nan$/u.test(cleaned)) return NaN
  if (!/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/u.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isNaN(value) ? null : value
}

function sign(text: string): number {
  return text.startsWith('-') ? -1 : 1
}
