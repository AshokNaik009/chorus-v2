/**
 * The Changes overlay's data: `git diff`, parsed into hunks and line numbers.
 *
 * ## Why this parses at all, when nothing else in the project does
 *
 * `herdr-file-viewer` — the Rust plugin this was ported from — has no diff parser. It
 * pipes raw `git diff` text into `delta` on stdin and converts the returned ANSI back
 * into spans (`src/render.rs:259`). That route is closed here, and `preview.ts:296`
 * says why in one line: *this dock paints its own styles and cannot consume ANSI*. It
 * is the same reason `bat` runs `--color=never` and `delta` runs `--color-only=false`.
 * Taking `delta`'s colours would mean first writing an ANSI-to-cell parser, which is a
 * bigger and less useful program than this one.
 *
 * So the structure comes from here and the colours come from the client's `Palette`.
 * That is also PHASE-11's standing rule applied to a new shape: rows arrive structured
 * and the client never recovers meaning from its own display text.
 *
 * ## What `git diff` does not tell you, and the three workarounds
 *
 * **1. It omits untracked files entirely.** An agent that writes a new file would show
 * nothing at all — the single most likely thing to look at, invisible. `git.rs:264` in
 * the Rust viewer solves it the only way git offers: a separate
 * `diff --no-index -- /dev/null <path>` per file. That exits **1** when there *are*
 * differences, so its status is deliberately ignored.
 *
 * **2. Spawns are unbounded even when bytes are.** A byte cap does not stop five
 * hundred one-line untracked files from costing five hundred processes, which is why
 * the Rust viewer carries `MAX_UNTRACKED_DIFF_FILES` alongside its byte cap. Ours is
 * far smaller: that is a file viewer you sit in, this is an overlay you glance at.
 *
 * **3. A repository can rewrite its own diffs.** `diff.external` and a textconv filter
 * are repository-controlled, and an agent's worktree — often a fresh clone nobody has
 * read — is exactly where that matters. `--no-ext-diff --no-textconv` on every
 * invocation, as the Rust viewer does.
 *
 * ## Nothing is cached
 *
 * `git.ts`'s rule, and it is stronger here than anywhere: the diff is of a tree an
 * agent is writing to *right now*. `r` re-fetches; there is nothing to invalidate.
 */

import {
  ErrorCodes,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type GitDiffResult
} from '@leap-chorus/protocol'
import type { GitService } from './git.js'
import { RequestError } from './rpc/params.js'
import { gitBufferOverflowMessage, runGit, type GitRunner } from './worktree.js'

/** Context lines per hunk. git's own default, and enough to place a change. */
export const DIFF_CONTEXT = 3

/** Past this many lines a file is shown as a prefix and marked `truncated`. */
export const DIFF_MAX_LINES_PER_FILE = 4_000

/** Total lines across every file, so a thousand small files cannot win either. */
export const DIFF_MAX_LINES_TOTAL = 20_000

/**
 * How many untracked files get their own `--no-index` invocation.
 *
 * The Rust viewer's cap is 512. Sixty-four here, because the failure mode differs: it
 * is a viewer the user lives in and this is an overlay summoned from a keypress, where
 * five hundred sequential spawns would read as the program having hung.
 */
export const DIFF_MAX_UNTRACKED = 64

/** Arguments every diff invocation carries, whatever it is diffing. */
const SAFE_DIFF_ARGS: readonly string[] = [
  '--no-color',
  // A repository must not be able to substitute its own program for git's differ, nor
  // filter the text on the way out. See the header.
  '--no-ext-diff',
  '--no-textconv'
]

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface HunkHeader {
  readonly oldStart: number
  readonly oldCount: number
  readonly newStart: number
  readonly newCount: number
  readonly section: string
}

/**
 * `@@ -a,b +c,d @@ section` — the one line that carries every line number below it.
 *
 * The counts are optional in the format and default to **1**, not 0: `@@ -1 +1 @@` is
 * a one-line change, and reading the absent count as zero would make every line after
 * it in that file wrong. `git.ts:firstHunkLine` has matched the start of this header
 * since phase 9 for a different purpose; this is the same grammar, read whole.
 */
export function parseHunkHeader(line: string): HunkHeader | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/u.exec(line)
  if (match === null) return null
  const toCount = (raw: string | undefined): number => (raw === undefined ? 1 : Number.parseInt(raw, 10))
  const oldStart = Number.parseInt(match[1] as string, 10)
  const newStart = Number.parseInt(match[3] as string, 10)
  if (!Number.isFinite(oldStart) || !Number.isFinite(newStart)) return null
  return {
    oldStart,
    oldCount: toCount(match[2]),
    newStart,
    newCount: toCount(match[4]),
    section: match[5] ?? ''
  }
}

/** `a/src/x.ts` -> `src/x.ts`; `/dev/null` -> null. Quoted paths are unquoted. */
function stripPrefix(raw: string): string | null {
  if (raw === '/dev/null') return null
  const unquoted = unquotePath(raw)
  const slash = unquoted.indexOf('/')
  // `a/` and `b/` are git's prefixes; a path with no slash at all cannot carry one.
  return slash === -1 ? unquoted : unquoted.slice(slash + 1)
}

/**
 * git quotes a path containing controls, quotes, backslashes or non-ASCII bytes.
 *
 * `core.quotePath` is on by default, so `"src/caf\303\251.ts"` is what arrives for a
 * file a user can see plainly in their editor. The escapes are C-style with **octal**
 * byte values, so the bytes are collected and decoded as UTF-8 at the end rather than
 * per escape — a two-byte character is two separate `\nnn` escapes and decoding them
 * one at a time produces two replacement characters.
 */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string
    if (char !== '\\') {
      for (const byte of Buffer.from(char, 'utf8')) bytes.push(byte)
      continue
    }
    const next = body[i + 1]
    if (next === undefined) break
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
    const mapped = simple[next]
    if (mapped !== undefined) {
      bytes.push(mapped)
      i += 1
      continue
    }
    const octal = /^[0-7]{1,3}/u.exec(body.slice(i + 1))?.[0]
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8) & 0xff)
      i += octal.length
      continue
    }
    bytes.push(92)
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * The new-side path from a `diff --git a/x b/x` line.
 *
 * Needed because a **binary** file has no `---`/`+++` pair at all — git prints the
 * header, an `index` line and `Binary files … differ`, and nothing else names it. For
 * every other file this is immediately overwritten by the `+++` side, so it is a
 * fallback rather than the source of truth.
 *
 * Splitting it is genuinely ambiguous: `core.quotePath` escapes control and non-ASCII
 * bytes but **not spaces**, so `diff --git a/my file.txt b/my file.txt` arrives as-is
 * and there is no unambiguous separator. Taking the last ` b/` is the standard
 * heuristic and is wrong only for a path that itself contains ` b/` — at which point
 * the `+++` line has already corrected it for every non-binary file.
 */
function headerPaths(line: string): string {
  const rest = line.slice('diff --git '.length)
  const split = rest.lastIndexOf(' b/')
  if (split === -1) return ''
  return unquotePath(rest.slice(split + 3).replace(/"$/u, ''))
}

interface FileDraft {
  path: string
  origin: string | null
  letter: string
  binary: boolean
  truncated: boolean
  added: number
  removed: number
  hunks: DiffHunk[]
}

function finish(draft: FileDraft, staged: boolean): DiffFile {
  return {
    path: draft.path,
    origin: draft.origin,
    letter: draft.letter,
    staged,
    binary: draft.binary,
    truncated: draft.truncated,
    added: draft.added,
    removed: draft.removed,
    hunks: draft.hunks
  }
}

export interface ParseOptions {
  readonly staged?: boolean
  readonly maxLinesPerFile?: number
  /** Forced on every file, for the `--no-index` path where git reports `A` as `M`. */
  readonly letter?: string
}

/**
 * A whole `git diff` output, as files.
 *
 * Line-oriented and single-pass. It trusts git's grammar rather than guessing: a body
 * line is only read as a hunk line while a hunk is open, which is what stops a context
 * line whose text begins with `diff --git ` — a diff inside a file, which is exactly
 * what a project like this one contains — from being read as a file header.
 */
export function parseUnifiedDiff(stdout: string, options: ParseOptions = {}): DiffFile[] {
  const staged = options.staged ?? false
  const maxLines = Math.max(1, Math.floor(options.maxLinesPerFile ?? DIFF_MAX_LINES_PER_FILE))
  const files: DiffFile[] = []
  let draft: FileDraft | null = null
  let hunk: { header: HunkHeader; text: string; lines: DiffLine[] } | null = null
  let oldLine = 0
  let newLine = 0
  let lineCount = 0
  /** The `--- ` side, held until `+++ ` says whether it is the path or the origin. */
  let oldPath: string | null = null

  const closeHunk = (): void => {
    if (draft === null || hunk === null) return
    draft.hunks.push({
      header: hunk.text,
      section: hunk.header.section,
      oldStart: hunk.header.oldStart,
      oldCount: hunk.header.oldCount,
      newStart: hunk.header.newStart,
      newCount: hunk.header.newCount,
      lines: hunk.lines
    })
    hunk = null
  }
  const closeFile = (): void => {
    closeHunk()
    if (draft !== null) files.push(finish(draft, staged))
    draft = null
    lineCount = 0
    oldPath = null
  }

  // `\r\n` is split on `\n` and the `\r` left attached: it is a byte of the line's
  // content, and stripping it here would make the overlay claim a change the file
  // does not have when only the ending differs.
  const body = stdout.split('\n')
  // `split` on a patch that ends with a newline leaves one empty element behind. It is
  // the terminator, not a line: git writes an empty context line as a single space.
  if (body[body.length - 1] === '') body.pop()
  for (const line of body) {
    if (line.startsWith('diff --git ')) {
      closeFile()
      draft = {
        path: headerPaths(line),
        origin: null,
        letter: options.letter ?? 'M',
        binary: false,
        truncated: false,
        added: 0,
        removed: 0,
        hunks: []
      }
      continue
    }
    if (draft === null) continue

    if (hunk === null) {
      // The header block, between `diff --git` and the first `@@`.
      if (line.startsWith('--- ')) {
        const path = stripPrefix(line.slice(4))
        if (path === null) draft.letter = options.letter ?? 'A'
        else oldPath = path
        continue
      }
      if (line.startsWith('+++ ')) {
        const path = stripPrefix(line.slice(4))
        if (path === null) {
          // A deletion has no new side, so the name it is filed under is the old one.
          draft.letter = options.letter ?? 'D'
          if (oldPath !== null) draft.path = oldPath
        } else {
          draft.path = path
          // Different sides mean a rename git did not label; the same path on both is
          // the ordinary case and an `origin` equal to `path` would be noise.
          if (oldPath !== null && oldPath !== path && draft.origin === null) draft.origin = oldPath
        }
        continue
      }
      if (line.startsWith('rename from ')) {
        draft.origin = unquotePath(line.slice(12))
        draft.letter = options.letter ?? 'R'
        continue
      }
      if (line.startsWith('rename to ')) {
        draft.path = unquotePath(line.slice(10))
        draft.letter = options.letter ?? 'R'
        continue
      }
      if (line.startsWith('copy from ')) {
        draft.origin = unquotePath(line.slice(10))
        draft.letter = options.letter ?? 'C'
        continue
      }
      if (line.startsWith('copy to ')) {
        draft.path = unquotePath(line.slice(8))
        draft.letter = options.letter ?? 'C'
        continue
      }
      if (line.startsWith('new file mode')) {
        draft.letter = options.letter ?? 'A'
        continue
      }
      if (line.startsWith('deleted file mode')) {
        draft.letter = options.letter ?? 'D'
        continue
      }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        draft.binary = true
        continue
      }
    }

    const header = parseHunkHeader(line)
    if (header !== null) {
      closeHunk()
      hunk = { header, text: line, lines: [] }
      oldLine = header.oldStart
      newLine = header.newStart
      continue
    }
    if (hunk === null) continue

    if (line.startsWith('\\')) {
      // `\ No newline at end of file`: a fact about the line above, not a line.
      const last = hunk.lines[hunk.lines.length - 1]
      if (last !== undefined) hunk.lines[hunk.lines.length - 1] = { ...last, noNewline: true }
      continue
    }
    if (draft.truncated) continue
    if (lineCount >= maxLines) {
      draft.truncated = true
      continue
    }

    const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith(' ') ? 'ctx' : null
    // An empty string is a context line whose content is empty and whose single space
    // some tools strip. Anything else between hunks is not ours to interpret.
    if (kind === null && line !== '') continue
    const text = kind === null ? '' : line.slice(1)
    lineCount += 1
    if (kind === 'add') {
      hunk.lines.push({ kind: 'add', old: null, new: newLine, text })
      newLine += 1
      draft.added += 1
    } else if (kind === 'del') {
      hunk.lines.push({ kind: 'del', old: oldLine, new: null, text })
      oldLine += 1
      draft.removed += 1
    } else {
      hunk.lines.push({ kind: 'ctx', old: oldLine, new: newLine, text })
      oldLine += 1
      newLine += 1
    }
  }
  closeFile()

  // A file whose path never arrived — an empty diff, or a header we do not read — is
  // dropped rather than shown as a row with no name.
  return files.filter((file) => file.path.length > 0)
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface DiffRequest {
  readonly paths?: readonly string[] | undefined
  readonly staged?: boolean | undefined
  readonly context?: number | undefined
}

export interface DiffServiceOptions {
  readonly git?: GitRunner
}

export class DiffService {
  private readonly git: GitRunner

  constructor(options: DiffServiceOptions = {}) {
    this.git = options.git ?? runGit
  }

  /**
   * Every changed file, or the ones asked for, as structured hunks.
   *
   * `status` first, and not only for the branch: it is the only source of the
   * untracked list, and an untracked file needs its own invocation. The status is
   * taken from the caller's `GitService` rather than re-run here, so the overlay and
   * the Source Control list are looking at one answer.
   */
  async diff(git: GitService, cwd: string, request: DiffRequest = {}): Promise<GitDiffResult> {
    const status = await git.status(cwd)
    const root = status.root
    const staged = request.staged === true
    const context = Math.max(0, Math.floor(request.context ?? DIFF_CONTEXT))
    const wanted = new Set(request.paths ?? [])
    const notes: string[] = []

    const args = [
      'diff',
      ...SAFE_DIFF_ARGS,
      '--find-renames',
      `-U${context}`,
      ...(staged ? ['--staged'] : []),
      '--',
      ...wanted
    ]
    const result = await this.git(args, root)
    if (result.code !== 0) {
      const said = result.stderr.trim()
      if (result.overflowed === true) notes.push(gitBufferOverflowMessage('git diff'))
      else throw new RequestError(ErrorCodes.gitFailed, said.length > 0 ? said : 'git diff failed')
    }
    const files = parseUnifiedDiff(result.stdout, { staged })

    // Untracked files, which `git diff` never mentions. Only for the working tree:
    // nothing untracked can be in the index by definition.
    if (!staged) {
      const untracked = status.unstaged
        .filter((entry) => entry.letter === 'U')
        .filter((entry) => wanted.size === 0 || wanted.has(entry.path))
      const shown = untracked.slice(0, DIFF_MAX_UNTRACKED)
      if (untracked.length > shown.length) {
        notes.push(`${untracked.length - shown.length} more untracked files not shown`)
      }
      for (const entry of shown) {
        files.push(...(await this.untracked(root, entry.path, context)))
      }
    }

    const capped = capTotal(files, notes)
    return {
      root,
      branch: status.branch,
      files: capped,
      note: notes.length > 0 ? notes.join(' · ') : null
    }
  }

  /**
   * One untracked file, via `--no-index` against `/dev/null`.
   *
   * The exit status is **ignored on purpose**: `--no-index` exits 1 when the two
   * inputs differ, which for a file against `/dev/null` is always. Treating that as
   * failure would make every new file an error, and is the trap `git.rs:543` in the
   * Rust viewer documents having fallen into.
   */
  private async untracked(root: string, path: string, context: number): Promise<DiffFile[]> {
    const result = await this.git(
      ['diff', ...SAFE_DIFF_ARGS, '--no-index', `-U${context}`, '--', nullDevice(), path],
      root
    )
    if (result.stdout.length === 0) return []
    // git prints the real `/dev/null` on the old side, so the parser's own `A`
    // inference would fire anyway; forcing `U` keeps the letter the one the Source
    // Control list shows for the same file.
    return parseUnifiedDiff(result.stdout, { letter: 'U' }).map((file) => ({ ...file, path }))
  }
}

/** Windows is not supported, but naming the constant says which line is the reason. */
function nullDevice(): string {
  return '/dev/null'
}

/**
 * Drop whole files once the total line budget is spent.
 *
 * Whole files rather than a cut in the middle of one: a file shown with three of its
 * nine hunks, silently, is worse than a file not shown with a line saying so.
 */
function capTotal(files: readonly DiffFile[], notes: string[]): DiffFile[] {
  let total = 0
  const kept: DiffFile[] = []
  for (const file of files) {
    const lines = file.hunks.reduce((sum, chunk) => sum + chunk.lines.length, 0)
    if (total + lines > DIFF_MAX_LINES_TOTAL && kept.length > 0) {
      notes.push(`${files.length - kept.length} more files not shown — the diff is too large`)
      return kept
    }
    total += lines
    kept.push(file)
  }
  return kept
}
