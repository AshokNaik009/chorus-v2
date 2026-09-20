/**
 * Rust `regex` patterns, compiled to JavaScript `RegExp`.
 *
 * The manifests are herdr's, written against the Rust `regex` crate (Apache-2.0,
 * herdr 3f2a6e74). Porting them as data rather than rewriting them is the whole point
 * of taking the manifest design, so the dialect gap is handled here, once, instead of
 * being smeared across 22 TOML files that then diverge from upstream.
 *
 * Four differences matter, and each is translated rather than approximated:
 *
 * | Rust | JavaScript | What we do |
 * |---|---|---|
 * | `(?i)` `(?m)` `(?s)` inline flags | not supported at all | lift a *leading* flag group to `RegExp` flags |
 * | `\x{2733}` | needs the `u` flag | rewrite to `\uXXXX`, which needs nothing |
 * | `\A` / `\z` | not supported | rewrite to `(?<![\s\S])` / `(?![\s\S])` |
 * | `\p{L}` | needs the `u` flag | set `u`, and switch `\x{}` to `\u{}` to match |
 *
 * Two differences are *not* translated, and are recorded because a future manifest
 * could trip on them:
 *
 * - **Inline flags are only accepted at position 0.** Rust scopes `(?i)` to the rest of
 *   its enclosing group; a lifted flag applies to the whole pattern. Every bundled
 *   manifest puts them first, where the two readings agree, and
 *   {@link translateRustRegex} throws on one that does not rather than compiling
 *   something subtly different. `bundled.test.ts` walks every shipped pattern.
 * - **`\d` `\w` `\s` are Unicode-aware in Rust and ASCII-only in JavaScript** without
 *   `u`. For matching a terminal screen's control chrome ("2 selected", "esc to
 *   cancel") the two agree; a manifest that leans on it would need `\p{Nd}`.
 */

export class RegexTranslationError extends Error {
  constructor(
    readonly pattern: string,
    reason: string
  ) {
    super(`cannot translate ${JSON.stringify(pattern)}: ${reason}`)
    this.name = 'RegexTranslationError'
  }
}

/** Inline flags Rust accepts that have a JavaScript equivalent. */
const SUPPORTED_INLINE_FLAGS = new Set(['i', 'm', 's'])

export interface TranslatedRegex {
  readonly source: string
  readonly flags: string
}

/**
 * Rewrite one Rust pattern into `RegExp` source plus flags.
 *
 * Pure, and separate from compilation, so a test can assert on the translation itself
 * rather than on whatever a `RegExp` happens to print.
 */
export function translateRustRegex(pattern: string): TranslatedRegex {
  const { flags, rest } = takeLeadingFlags(pattern)
  rejectLateFlagGroup(pattern, rest)

  // `\p{...}` is the only construct that forces `u`, and `u` then changes how every
  // other escape is read, so the decision is made once, up front.
  const unicode = /\\[pP]\{/.test(rest)
  const source = rewriteEscapes(pattern, rest, unicode)
  return { source, flags: `${flags}${unicode ? 'u' : ''}` }
}

export function compileRustRegex(pattern: string): RegExp {
  const { source, flags } = translateRustRegex(pattern)
  try {
    return new RegExp(source, flags)
  } catch (error) {
    throw new RegexTranslationError(pattern, String(error))
  }
}

/** True when a pattern can be compiled. Used by manifest validation. */
export function isTranslatableRustRegex(pattern: string): boolean {
  try {
    compileRustRegex(pattern)
    return true
  } catch {
    return false
  }
}

function takeLeadingFlags(pattern: string): { flags: string; rest: string } {
  let rest = pattern
  const collected = new Set<string>()
  // Repeated, because `(?i)(?m)` is as legal as `(?im)`.
  for (;;) {
    const match = /^\(\?([a-zA-Z]+)\)/.exec(rest)
    if (!match) break
    const group = match[1] as string
    for (const flag of group) {
      if (!SUPPORTED_INLINE_FLAGS.has(flag)) {
        throw new RegexTranslationError(pattern, `inline flag \`${flag}\` has no JavaScript equivalent`)
      }
      collected.add(flag)
    }
    rest = rest.slice(match[0].length)
  }
  // Sorted so the same pattern always yields the same flags string, which makes the
  // translation testable by value.
  return { flags: [...collected].sort().join(''), rest }
}

/**
 * Refuse a flag group anywhere but the front.
 *
 * Rust would scope it; we would not. Erroring is the only honest option — a silently
 * wider `(?i)` turns a precise blocker rule into one that matches prose.
 */
function rejectLateFlagGroup(pattern: string, rest: string): void {
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '\\') {
      i++
      continue
    }
    if (rest[i] !== '(') continue
    const match = /^\(\?([a-zA-Z]+)\)/.exec(rest.slice(i))
    if (match) {
      throw new RegexTranslationError(
        pattern,
        `inline flags are only supported at the start of a pattern, found \`${match[0]}\` at offset ${i}`
      )
    }
  }
}

/**
 * Rewrite the escapes whose spelling differs, leaving everything else byte for byte.
 *
 * Walks the pattern rather than running replacements over it, because `\\x{41}` is a
 * literal backslash followed by `x{41}` and a regex-based pass cannot see that.
 */
function rewriteEscapes(pattern: string, rest: string, unicode: boolean): string {
  let out = ''
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i] as string
    if (char !== '\\') {
      out += char
      continue
    }
    const next = rest[i + 1]
    if (next === undefined) throw new RegexTranslationError(pattern, 'trailing backslash')

    if (next === 'A') {
      // Not `^`: a lifted `(?m)` would change what `^` means, and `\A` never means that.
      out += '(?<![\\s\\S])'
      i++
      continue
    }
    if (next === 'z') {
      out += '(?![\\s\\S])'
      i++
      continue
    }
    if (next === 'x' && rest[i + 2] === '{') {
      const close = rest.indexOf('}', i + 3)
      if (close === -1) throw new RegexTranslationError(pattern, 'unterminated \\x{...}')
      const digits = rest.slice(i + 3, close)
      out += codepointEscape(pattern, digits, unicode)
      i = close
      continue
    }
    out += char + next
    i++
  }
  return out
}

function codepointEscape(pattern: string, digits: string, unicode: boolean): string {
  if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) {
    throw new RegexTranslationError(pattern, `\\x{${digits}} is not a code point`)
  }
  const value = Number.parseInt(digits, 16)
  if (value > 0x10ffff) throw new RegexTranslationError(pattern, `\\x{${digits}} is out of range`)
  if (unicode) return `\\u{${value.toString(16)}}`
  if (value > 0xffff) {
    // Without `u`, an astral code point is two UTF-16 units, which is wrong inside a
    // character class range and a silent bug outside one. Only `\p{...}` forces the
    // non-`u` path, so this is reachable only by a manifest mixing the two.
    throw new RegexTranslationError(
      pattern,
      `\\x{${digits}} is above the BMP and this pattern cannot use the \`u\` flag`
    )
  }
  return `\\u${value.toString(16).padStart(4, '0')}`
}
