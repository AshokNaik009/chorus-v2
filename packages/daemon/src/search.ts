/**
 * Search: the file list quick open filters, and content search over the root.
 *
 * The behaviour is herdr-sidebar's (MIT) — its caps, its option set, its honesty about
 * being capped. The *mechanics* are ported from orca (MIT, Lovecast Inc. 2026), which
 * already had a working ripgrep integration in Node and had already hit most of the
 * traps. See `NOTICE`.
 *
 * ## Why we shell out to `rg` instead of walking the tree
 *
 * herdr-sidebar compiles ripgrep's `ignore` and `globset` crates into its binary and
 * walks the tree itself. There is no TypeScript equivalent worth the dependency, and
 * this project already delegates to installed tools — `git`, `$PAGER`, `$EDITOR`. So
 * `rg` is the engine, and its absence is a message rather than a crash.
 *
 * ## Why `spawn` and never `execFile`
 *
 * `execFile` buffers stdout internally and kills the child at `maxBuffer` *even with
 * `data` listeners attached*, and its buffer-exceeded error is silent enough that a
 * caller reports `truncated: false` while dropping matches. Under rg's verbose
 * `--json` a megabyte-scale buffer fills long before the match cap. A capped search
 * that claims to be complete is the one lie this feature must not tell, so nothing
 * here reuses `runGit`, which is `execFile` with an 8 MB cap.
 *
 * ## Why `--json` and not `--vimgrep`
 *
 * `path:line:col:text` is ambiguous the moment a path contains a colon. rg's JSON
 * Lines give `data.path.text`, `data.line_number`, `data.lines.text` and
 * `data.submatches[]` as structured fields, and a path is whatever the field says.
 *
 * ## Every result set is bounded here, not in the client
 *
 * Matches, files, line length and wall-clock time all have caps, and the one that
 * fired travels with the result. `truncated` is set in the same tick the decision to
 * stop is made — a caller that resolves first would report a capped search as whole.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  ErrorCodes,
  type SearchCap,
  type SearchContentResult,
  type SearchFileMatches,
  type SearchFilesResult,
  type SearchMatch
} from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'
import { runGit, type GitRunner } from './worktree.js'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** herdr-sidebar's `QUICK_OPEN_FILE_LIMIT` / `CONTENT_SEARCH_FILE_LIMIT`. */
export const SEARCH_FILE_LIMIT = 20_000
/** herdr-sidebar's `CONTENT_SEARCH_MATCH_LIMIT`. */
export const SEARCH_MATCH_LIMIT = 1_000
/** herdr-sidebar's `CONTENT_SEARCH_MAX_BYTES`, handed to rg as `--max-filesize`. */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024
/** orca's `MAX_MATCHES_PER_FILE`: one file cannot flood the whole budget. */
export const MAX_MATCHES_PER_FILE = 100
/** orca's `MAX_LINE_CONTENT_LENGTH`. Longer lines are windowed around the match. */
export const MAX_LINE_LENGTH = 500
/** orca's `SEARCH_TIMEOUT_MS`. A search past this is killed and reported truncated. */
export const SEARCH_TIMEOUT_MS = 15_000
/** orca's `LIST_FILES_TIMEOUT_MS`. Listing walks more and matches nothing, so longer. */
export const LIST_FILES_TIMEOUT_MS = 25_000

// ---------------------------------------------------------------------------
// Failure kinds: missing is advice, launch failure is "try again"
// ---------------------------------------------------------------------------

/**
 * `rg` is not on the daemon's `PATH`.
 *
 * Deliberately not "ripgrep is not installed": the daemon's environment is not the
 * user's interactive one, and a daemon started outside a login shell can miss a
 * perfectly well installed binary. The message says which claim is being made.
 */
export class RipgrepMissingError extends Error {
  constructor() {
    super('ripgrep is not on the daemon PATH')
    this.name = 'RipgrepMissingError'
  }
}

/** `rg` exists but would not start. Retryable, and never install advice. */
export class RipgrepLaunchError extends Error {
  constructor(readonly code: string) {
    super(`ripgrep failed to start (${code})`)
    this.name = 'RipgrepLaunchError'
  }
}

/**
 * Fork/exec pressure, which is not evidence that ripgrep is missing.
 *
 * Telling somebody to `brew install ripgrep` when they are out of file descriptors is
 * wrong advice that costs them the real diagnosis. orca keeps the same set.
 */
const TRANSIENT_SPAWN_CODES: ReadonlySet<string> = new Set([
  'EAGAIN',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'ETXTBSY'
])

export function isTransientSpawnError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && TRANSIENT_SPAWN_CODES.has(code)
}

/**
 * Turn a spawn failure into the error that says the right thing.
 *
 * `ENOENT` is the only code that means "there is no such program". Everything else —
 * transient pressure, a permission problem on the binary — is a launch failure, whose
 * message names the code rather than blaming an install.
 */
export function classifySpawnFailure(error: unknown): RipgrepMissingError | RipgrepLaunchError {
  const code = (error as { code?: unknown } | null | undefined)?.code
  if (code === 'ENOENT') return new RipgrepMissingError()
  return new RipgrepLaunchError(typeof code === 'string' ? code : 'unknown')
}

// ---------------------------------------------------------------------------
// The install line, per platform
// ---------------------------------------------------------------------------

const GENERIC_LINUX_INSTALL = 'install ripgrep with your package manager (apt / dnf / pacman / apk)'

/** Ported from orca's `detectLinuxInstallCommandFromOsRelease`. */
export function linuxInstallCommand(osRelease: string): string {
  const ids: string[] = []
  for (const line of osRelease.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) value = value.slice(1, -1)
    // `ID` is one token; `ID_LIKE` is a space-separated list of families, which is how
    // a Mint or a Pop!_OS says "treat me as Debian".
    if (key === 'ID' || key === 'ID_LIKE') ids.push(...value.split(/\s+/u).filter((id) => id.length > 0))
  }
  for (const id of ids) {
    if (id === 'debian' || id === 'ubuntu') return 'sudo apt install ripgrep'
    if (id === 'fedora' || id === 'rhel' || id === 'centos') return 'sudo dnf install ripgrep'
    if (id === 'arch') return 'sudo pacman -S ripgrep'
    if (id === 'alpine') return 'sudo apk add ripgrep'
  }
  return GENERIC_LINUX_INSTALL
}

/**
 * What to type on *this* machine.
 *
 * "Install ripgrep" is not actionable; `brew install ripgrep` is. Ported from orca's
 * `detectInstallCommand`, which is the version that reads `/etc/os-release`.
 */
export async function installCommand(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'darwin') return 'brew install ripgrep'
  if (platform === 'linux') {
    try {
      return linuxInstallCommand(await readFile('/etc/os-release', 'utf8'))
    } catch {
      return GENERIC_LINUX_INSTALL
    }
  }
  return 'install ripgrep — https://github.com/BurntSushi/ripgrep#installation'
}

// ---------------------------------------------------------------------------
// PATH: the daemon's is not the user's
// ---------------------------------------------------------------------------

/**
 * The directories a daemon spawned outside a login shell would otherwise not have.
 *
 * A user who installed ripgrep with Homebrew or `cargo install` can run `rg` and the
 * daemon cannot, which reads as a lie about their machine. orca augments `PATH` for
 * exactly this reason. Appended, never prepended: the user's own `PATH` order wins.
 */
const EXTRA_PATH_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

export function searchPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const current = (env['PATH'] ?? '').split(delimiter).filter((dir) => dir.length > 0)
  const seen = new Set(current)
  for (const dir of [join(home, '.local', 'bin'), join(home, '.cargo', 'bin'), ...EXTRA_PATH_DIRS]) {
    if (!seen.has(dir)) {
      current.push(dir)
      seen.add(dir)
    }
  }
  return current.join(delimiter)
}

function searchEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: searchPath(env) }
}

// ---------------------------------------------------------------------------
// The runner: one spawn, streamed, killable
// ---------------------------------------------------------------------------

export interface RipgrepRun {
  readonly args: readonly string[]
  readonly cwd: string
  /** One decoded stdout line. Return `stop` to kill the child immediately. */
  readonly onLine: (line: string) => 'continue' | 'stop'
  /** Kill the child after this long and report `timedOut`. */
  readonly timeoutMs: number
}

export interface RipgrepOutcome {
  /** rg's exit code: 0 matched, 1 matched nothing, 2 something went wrong. */
  readonly code: number | null
  readonly stderr: string
  /** The child was killed because `onLine` said stop. */
  readonly stopped: boolean
  /** The child was killed because it ran past `timeoutMs`. */
  readonly timedOut: boolean
}

/**
 * Run one `rg`.
 *
 * Rejects with `RipgrepMissingError` or `RipgrepLaunchError` and resolves with
 * everything else — a non-zero exit is data, not a throw, because "no matches" is exit
 * code 1 and is the most ordinary outcome there is.
 */
export type RipgrepRunner = (run: RipgrepRun) => Promise<RipgrepOutcome>

export interface RipgrepRunnerOptions {
  /** The program to spawn. Overridden in tests, where there is no `rg` to spawn. */
  readonly command?: string
  /** Arguments before rg's own. Lets a test point `command` at a script. */
  readonly prefixArgs?: readonly string[]
  readonly env?: NodeJS.ProcessEnv
  /**
   * Add the usual install directories to `PATH`. On by default.
   *
   * Off is for tests: a test that proves "rg is absent" by emptying `PATH` cannot do
   * that while the runner is helpfully putting `/usr/bin` back.
   */
  readonly augmentPath?: boolean
}

/**
 * Kill a child, unless the handle never got a pid.
 *
 * A spawn that failed leaves `pid === undefined`, and `kill()` on that handle signals
 * *our own process group* — which on a daemon means killing every pane it owns. orca
 * documents this one; it is the most expensive trap in the file.
 */
function killChild(child: ChildProcess): void {
  if (child.pid === undefined) return
  child.kill()
}

export function createRipgrepRunner(options: RipgrepRunnerOptions = {}): RipgrepRunner {
  const command = options.command ?? 'rg'
  const prefix = options.prefixArgs ?? []
  const env = options.augmentPath === false ? { ...options.env } : searchEnv(options.env)
  return (run) =>
    new Promise<RipgrepOutcome>((resolve, reject) => {
      let child: ChildProcess
      try {
        child = spawn(command, [...prefix, ...run.args], {
          cwd: run.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env
        })
      } catch (error) {
        // `spawn` throws synchronously on some option failures. Left uncaught it would
        // escape the executor and leave this promise pending forever.
        reject(classifySpawnFailure(error))
        return
      }

      // A UTF-8 filename can straddle a chunk boundary; a stateful decoder keeps the
      // JSON record intact where `chunk.toString()` would insert U+FFFD.
      const decoder = new StringDecoder('utf8')
      let pending = ''
      let stderr = ''
      let stopped = false
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        killChild(child)
      }, run.timeoutMs)
      timer.unref?.()

      const settle = (outcome: RipgrepOutcome | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // A queued spawn `error` can still arrive after we have settled, and an
        // unhandled `error` on a ChildProcess takes the whole daemon down.
        child.on('error', () => {})
        if (outcome instanceof Error) reject(outcome)
        else resolve(outcome)
      }

      const feed = (text: string): void => {
        if (stopped) return
        pending += text
        let newline = pending.indexOf('\n')
        while (newline !== -1) {
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (run.onLine(line) === 'stop') {
            stopped = true
            pending = ''
            killChild(child)
            return
          }
          newline = pending.indexOf('\n')
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => feed(decoder.write(chunk)))
      child.stderr?.on('data', (chunk: Buffer) => {
        // Bounded: a permission-denied storm must not be held in memory in full.
        if (stderr.length < 8192) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) => settle(classifySpawnFailure(error)))
      child.once('close', (code) => {
        const tail = pending + decoder.end()
        if (!stopped && tail.length > 0) run.onLine(tail)
        settle({ code, stderr, stopped, timedOut })
      })
    })
}

/** The real one. Tests inject their own; `rg` may not exist on this machine. */
export const runRipgrep: RipgrepRunner = createRipgrepRunner()

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/**
 * Comma-separated globs, the way VS Code's include/exclude boxes take them.
 *
 * A bare directory name is expanded the way herdr-sidebar's `build_search_globs` does:
 * somebody who types `src` means everything under `src`, not a file named `src`. A
 * pattern with glob metacharacters is passed through, because it already says what it
 * means.
 */
export function expandGlobs(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(',')) {
    const pattern = part.trim().replace(/\/+$/u, '')
    if (pattern.length === 0) continue
    out.push(pattern)
    if (/[*?[\]{}]/u.test(pattern)) continue
    out.push(`${pattern}/**`)
    // A bare name with no slash is a directory that could be at any depth, which is
    // how `node_modules` behaves as an exclude.
    if (!pattern.includes('/')) out.push(`**/${pattern}/**`)
  }
  return out
}

export interface ContentSearchOptions {
  readonly matchCase?: boolean
  readonly wholeWord?: boolean
  readonly regex?: boolean
  readonly include?: string
  readonly exclude?: string
}

/**
 * rg's argv, which is the part worth getting exactly right.
 *
 * `--` before the query, or a query starting with `-` parses as a flag. `--max-count`
 * is **per file** and so does not replace the global cap. The target is `.` rather
 * than the absolute root because rg only prunes root-relative exclude globs when the
 * target is relative to its working directory — and relative paths are what the panel
 * shows anyway.
 */
export function buildContentArgs(query: string, options: ContentSearchOptions): string[] {
  return [
    '--json',
    '--hidden',
    '--no-messages',
    '--glob',
    '!.git',
    '--max-count',
    String(MAX_MATCHES_PER_FILE),
    '--max-filesize',
    String(SEARCH_MAX_FILE_BYTES),
    ...(options.matchCase === true ? [] : ['--ignore-case']),
    ...(options.wholeWord === true ? ['--word-regexp'] : []),
    ...(options.regex === true ? [] : ['--fixed-strings']),
    ...expandGlobs(options.include ?? '').flatMap((pattern) => ['--glob', pattern]),
    ...expandGlobs(options.exclude ?? '').flatMap((pattern) => ['--glob', `!${pattern}`]),
    '--',
    query,
    '.'
  ]
}

/** `rg --files`: the listing quick open filters. No query, so no `--`-guarded operand. */
export function buildFilesArgs(): string[] {
  return ['--files', '--hidden', '--no-messages', '--glob', '!.git']
}

// ---------------------------------------------------------------------------
// Clipping a long line around its match
// ---------------------------------------------------------------------------

const ELLIPSIS = '…'

/**
 * Window a long line on the match rather than clipping from the start.
 *
 * A minified file's one 200 KB line matched at column 150,000 shows nothing useful if
 * you take its first 500 characters. The **true** column stays separate from the
 * **display** column so "open at that line" still lands correctly. Ported from orca's
 * `clampLineContext`.
 */
export function clipLine(
  text: string,
  start: number,
  length: number
): Pick<SearchMatch, 'text' | 'column' | 'matchLength' | 'displayColumn' | 'displayMatchLength'> {
  if (text.length <= MAX_LINE_LENGTH) {
    return { text, column: start + 1, matchLength: length, displayColumn: start + 1, displayMatchLength: length }
  }
  const shownLength = Math.min(length, MAX_LINE_LENGTH)
  const leftBudget = Math.floor((MAX_LINE_LENGTH - shownLength) / 2)
  let windowStart = Math.max(0, start - leftBudget)
  const windowEnd = Math.min(text.length, windowStart + MAX_LINE_LENGTH)
  windowStart = Math.max(0, windowEnd - MAX_LINE_LENGTH)

  let snippet = text.slice(windowStart, windowEnd)
  let displayColumn = start - windowStart + 1
  if (windowStart > 0) {
    snippet = ELLIPSIS + snippet
    displayColumn += ELLIPSIS.length
  }
  if (windowEnd < text.length) snippet += ELLIPSIS
  return {
    text: snippet,
    column: start + 1,
    matchLength: length,
    displayColumn,
    displayMatchLength: shownLength
  }
}

// ---------------------------------------------------------------------------
// Parsing rg's JSON Lines
// ---------------------------------------------------------------------------

interface RgMatch {
  readonly path: string
  readonly line: number
  readonly text: string
  readonly submatches: readonly { readonly start: number; readonly end: number }[]
}

/**
 * One line of `rg --json`, or null for anything that is not a match record.
 *
 * rg also emits `begin`, `end` and `summary` records; none of them carries a match and
 * all of them are skipped. A record whose path is not text — rg base64-encodes a path
 * that is not valid UTF-8 — is skipped too, because nothing downstream could open it.
 */
export function parseRgLine(line: string): RgMatch | null {
  if (line.length === 0) return null
  let message: {
    type?: unknown
    data?: {
      path?: { text?: unknown }
      line_number?: unknown
      lines?: { text?: unknown }
      submatches?: unknown
    }
  }
  try {
    message = JSON.parse(line) as typeof message
  } catch {
    return null
  }
  if (message.type !== 'match' || message.data === undefined) return null
  const path = message.data.path?.text
  if (typeof path !== 'string') return null
  const text = typeof message.data.lines?.text === 'string' ? message.data.lines.text.replace(/\r?\n$/u, '') : ''
  const lineNumber = typeof message.data.line_number === 'number' ? message.data.line_number : 0
  const raw = Array.isArray(message.data.submatches) ? message.data.submatches : []
  const submatches = raw
    .filter(
      (entry): entry is { start: number; end: number } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { start?: unknown }).start === 'number' &&
        typeof (entry as { end?: unknown }).end === 'number'
    )
    .map((entry) => ({ start: entry.start, end: entry.end }))
  // Some matches report a line with no submatch ranges. Surfacing a line-level hit
  // beats dropping a match rg is sure about — orca's note, kept.
  return {
    path,
    line: lineNumber,
    text,
    submatches: submatches.length > 0 ? submatches : [{ start: 0, end: text.length > 0 ? 1 : 0 }]
  }
}

/**
 * rg's byte offsets into a line, as the character offsets everything else here uses.
 *
 * rg reports `submatches` in bytes and JavaScript slices in UTF-16 code units, so a
 * line with an accent in it highlights the wrong span unless the two are converted.
 * The all-ASCII fast path is the common case and skips the allocation entirely.
 */
function byteToCharOffset(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes === text.length) return Math.min(byteOffset, text.length)
  if (byteOffset >= bytes) return text.length
  return Buffer.from(text, 'utf8').subarray(0, byteOffset).toString('utf8').length
}

/**
 * Case-insensitively by path, ties broken exactly.
 *
 * herdr-sidebar sorts its quick-open index on a lowercased label, so `README` sits
 * with `readme` rather than above the whole tree. The exact tiebreak keeps the order
 * stable between two paths that differ only in case.
 */
function byPathOrder(left: string, right: string): number {
  return left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right)
}

/** `a/b` on every platform: the panel, the pager and the wire all want one separator. */
function normalizePath(path: string): string {
  return path.replace(/^\.[\\/]/u, '').replace(/\\/gu, '/')
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface SearchServiceOptions {
  readonly ripgrep?: RipgrepRunner
  readonly git?: GitRunner
  readonly matchLimit?: number
  readonly fileLimit?: number
  readonly timeoutMs?: number
  readonly listTimeoutMs?: number
  /** Overridden in tests so an assertion does not depend on the host's package manager. */
  readonly installCommand?: () => Promise<string>
}

export class SearchService {
  private readonly ripgrep: RipgrepRunner
  private readonly git: GitRunner
  private readonly matchLimit: number
  private readonly fileLimit: number
  private readonly timeoutMs: number
  private readonly listTimeoutMs: number
  private readonly install: () => Promise<string>

  constructor(options: SearchServiceOptions = {}) {
    this.ripgrep = options.ripgrep ?? runRipgrep
    this.git = options.git ?? runGit
    this.matchLimit = options.matchLimit ?? SEARCH_MATCH_LIMIT
    this.fileLimit = options.fileLimit ?? SEARCH_FILE_LIMIT
    this.timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
    this.listTimeoutMs = options.listTimeoutMs ?? LIST_FILES_TIMEOUT_MS
    this.install = options.installCommand ?? (() => installCommand())
  }

  /**
   * Every file under `root`, for quick open to filter.
   *
   * One call, not one per keystroke: filtering a cached 20,000-entry list is a string
   * compare and a round trip is not. Ignored files are absent because that is what rg
   * does by default, and it is what makes the list worth reading.
   */
  async files(root: string): Promise<SearchFilesResult> {
    try {
      return await this.filesWithRipgrep(root)
    } catch (error) {
      if (!(error instanceof RipgrepMissingError)) throw this.toRequestError(error)
      const fallback = await this.filesWithGit(root)
      if (fallback !== null) return fallback
      throw await this.unavailable('quick open')
    }
  }

  private async filesWithRipgrep(root: string): Promise<SearchFilesResult> {
    const files: string[] = []
    // A holder rather than a `let`: the flag is set inside the line callback, and a
    // plain local would be narrowed to `null` by control-flow analysis afterwards.
    const state: { cap: SearchCap | null } = { cap: null }
    const outcome = await this.ripgrep({
      args: buildFilesArgs(),
      cwd: root,
      timeoutMs: this.listTimeoutMs,
      onLine: (line) => {
        const path = normalizePath(line.trim())
        if (path.length === 0) return 'continue'
        files.push(path)
        // Set in the same tick as the decision to stop, not after the child closes.
        if (files.length >= this.fileLimit) {
          state.cap = 'files'
          return 'stop'
        }
        return 'continue'
      }
    })
    if (outcome.timedOut && state.cap === null) state.cap = 'time'
    this.rejectOnRipgrepError(outcome, files.length)
    files.sort(byPathOrder)
    return { root, files, truncated: state.cap !== null, cap: state.cap, engine: 'ripgrep' }
  }

  /**
   * `git ls-files` as the no-ripgrep fallback, inside a repository only.
   *
   * The repository test is `rev-parse --is-inside-work-tree` rather than looking for a
   * `.git` entry: the latter answers "no" from a subdirectory of a checkout and falls
   * through to a listing full of ignored build artifacts. orca's comment, verified.
   *
   * `--cached --others --exclude-standard` is the closest git has to what rg lists:
   * tracked files plus untracked ones, minus everything `.gitignore` covers.
   */
  private async filesWithGit(root: string): Promise<SearchFilesResult | null> {
    const inside = await this.git(['rev-parse', '--is-inside-work-tree'], root)
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
    const listed = await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
    if (listed.code !== 0) return null
    const files = listed.stdout
      .split('\0')
      .map((path) => normalizePath(path))
      .filter((path) => path.length > 0)
    let cap: SearchCap | null = null
    if (files.length > this.fileLimit) {
      files.length = this.fileLimit
      cap = 'files'
    }
    files.sort(byPathOrder)
    return { root, files, truncated: cap !== null, cap, engine: 'git' }
  }

  /**
   * Content search over `root`.
   *
   * No fallback. orca ships a `git grep` one and we deliberately do not port it: two
   * engines that disagree about regex dialect make results differ by machine, which is
   * worse than an honest "install ripgrep". PHASE-8 records its argv for phase 9.
   */
  async content(root: string, query: string, options: ContentSearchOptions = {}): Promise<SearchContentResult> {
    if (query.length === 0) {
      return { root, files: [], totalMatches: 0, truncated: false, cap: null }
    }
    const byPath = new Map<string, SearchMatch[]>()
    const order: string[] = []
    const state: { total: number; cap: SearchCap | null } = { total: 0, cap: null }

    const outcome = await this.ripgrep({
      args: buildContentArgs(query, options),
      cwd: root,
      timeoutMs: this.timeoutMs,
      onLine: (line) => {
        const parsed = parseRgLine(line)
        if (parsed === null) return 'continue'
        const path = normalizePath(parsed.path)
        let matches = byPath.get(path)
        if (matches === undefined) {
          if (byPath.size >= this.fileLimit) {
            state.cap = 'files'
            return 'stop'
          }
          matches = []
          byPath.set(path, matches)
          order.push(path)
        }
        for (const submatch of parsed.submatches) {
          const start = byteToCharOffset(parsed.text, submatch.start)
          const end = byteToCharOffset(parsed.text, submatch.end)
          matches.push({ line: parsed.line, ...clipLine(parsed.text, start, Math.max(0, end - start)) })
          state.total += 1
          if (state.total >= this.matchLimit) {
            state.cap = 'matches'
            return 'stop'
          }
        }
        return 'continue'
      }
    }).catch(async (error: unknown) => {
      if (error instanceof RipgrepMissingError) throw await this.unavailable('content search')
      throw this.toRequestError(error)
    })

    if (outcome.timedOut && state.cap === null) state.cap = 'time'
    this.rejectOnRipgrepError(outcome, state.total)

    const files: SearchFileMatches[] = order.map((path) => ({ path, matches: byPath.get(path) ?? [] }))
    return { root, files, totalMatches: state.total, truncated: state.cap !== null, cap: state.cap }
  }

  /**
   * rg exit code 2 with nothing found is a real failure, and its stderr says what.
   *
   * An invalid regular expression is the case that matters: rg prints the parse error
   * and exits 2, and relaying it verbatim tells the user what to fix. `--no-messages`
   * has already dropped the permission-denied noise that would otherwise land here.
   */
  private rejectOnRipgrepError(outcome: RipgrepOutcome, found: number): void {
    if (outcome.stopped || outcome.timedOut) return
    if (outcome.code !== 2 || found > 0) return
    const message = outcome.stderr.split('\n').find((line) => line.trim().length > 0)
    if (message === undefined) return
    throw new RequestError(ErrorCodes.badRequest, message.trim())
  }

  private toRequestError(error: unknown): Error {
    if (error instanceof RequestError) return error
    if (error instanceof RipgrepLaunchError) {
      return new RequestError(ErrorCodes.searchUnavailable, `${error.message} — try again`)
    }
    return error instanceof Error ? error : new Error(String(error))
  }

  /** The one message that carries advice, so it carries this platform's install line. */
  private async unavailable(what: string): Promise<RequestError> {
    return new RequestError(
      ErrorCodes.searchUnavailable,
      `${what} needs ripgrep, and rg is not on the daemon PATH. ` +
        `If it is installed, the daemon may not see your shell PATH. Otherwise: ${await this.install()}`
    )
  }
}
