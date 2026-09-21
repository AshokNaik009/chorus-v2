/**
 * Reading a file for the dock to glance at.
 *
 * The behaviour target is herdr-sidebar's viewer (MIT); the *mechanics* of reading a
 * file without hanging on it are orca's (MIT, Lovecast Inc. 2026). See `NOTICE`.
 *
 * ## Why this is not `viewer.rs`
 *
 * herdr-sidebar's `viewer.rs` is 4,082 lines and the largest single file in that
 * project: `syntect` grammars, `two-face`'s extended set, and `image` decoding for
 * seven formats. **We should not have one.** In a terminal multiplexer, `bat`, `glow`
 * and `delta` already do this, the user has already chosen and configured them, and a
 * pane is still the right place to *read* something. What is worth building is an
 * embedded preview for *glancing* — thirty-four columns, no search, no theme of its
 * own — and glancing is a much smaller problem.
 *
 * ## The three things a preview must not do
 *
 * **1. Read the file to decide about the file.** A binary check that reads a 2 GB core
 * dump looking for a NUL is a hang, and the panel holds the keyboard while it hangs.
 * Orca's `isBinaryFilePrefix` reads `BINARY_PROBE_BYTES` into a fixed buffer and looks
 * no further; so does this. The cap is enforced by the *read*, not by the scan, so a
 * test that counts bytes off the disk fails if this ever regresses.
 *
 * **2. Trust a `stat` it did not take on the open descriptor.** Orca's
 * `readNodeFileWithinLimit` stats, rejects, allocates, reads — and then probes **one
 * byte past** the stat size, because the file can grow in between. Without that probe a
 * file being appended to returns a short buffer that looks complete. We go one step
 * further and `fstat` the *already-open descriptor*, which removes the race rather than
 * detecting it; the probe byte stays, because a file can still grow between the fstat
 * and the read.
 *
 * **3. Pretend a cap did not fire.** Same rule phase 8's search follows: every bound
 * that stopped something travels with the result and the panel says so on screen.
 *
 * ## The caps are much smaller than orca's
 *
 * Orca renders into Monaco and caps text at 10 MiB. This renders into a dock that is
 * thirty-four columns wide, and nobody glances at ten megabytes. The *shape* is orca's
 * — a text cap, a separate binary cap, a probe size, and an error that carries both the
 * observed size and the limit so the message can say both — and only the numbers differ.
 */

import { spawn } from 'node:child_process'
import { constants, open } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { ErrorCodes, type PreviewRenderer, type PreviewResult } from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'
import { isTransientSpawnError, searchPath } from './search.js'
import { canonicalPath } from './worktree.js'

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/**
 * The most a text preview will read off the disk.
 *
 * 256 KiB rather than orca's 10 MiB: this is a glance in a narrow column, and a file
 * past this is one to open in a pager. Big enough that no ordinary source file, log
 * excerpt or config is ever clipped.
 */
export const PREVIEW_MAX_BYTES = 256 * 1024

/** Lines kept after decoding. A file of one million short lines is still bounded. */
export const PREVIEW_MAX_LINES = 5_000

/**
 * How much of a file is read to decide whether it is binary. Orca's number.
 *
 * The scan looks at what this read returns and never asks for more, which is the whole
 * point — the decision costs one 8 KiB read whatever the file's size.
 */
export const BINARY_PROBE_BYTES = 8 * 1024

/** A single line longer than this is cut; the dock cannot show it and holding it costs. */
export const PREVIEW_MAX_LINE_LENGTH = 2_000

/** How long an external renderer gets before it is killed and the plain path is taken. */
export const RENDERER_TIMEOUT_MS = 5_000

/** The most output an external renderer may produce. It is rendering into a dock. */
export const RENDERER_MAX_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// Bounded reading
// ---------------------------------------------------------------------------

export interface BoundedRead {
  readonly bytes: Buffer
  /** What the descriptor said the file was, at the moment it was opened. */
  readonly size: number
  /** There is more content than `bytes` holds — the cap fired, or the file grew. */
  readonly more: boolean
  /**
   * Bytes actually pulled off the disk, including the probe byte.
   *
   * Reported so a test can assert the binary check never read the whole file. Nothing
   * in the product looks at it; it exists to make criterion 3 checkable rather than
   * assertable-by-reading.
   */
  readonly bytesRead: number
}

/**
 * Read at most `maxBytes` of `path`, and say whether there was more.
 *
 * `fstat` on the open descriptor rather than `stat` on the path: the file the caller
 * named and the file that got opened are the same inode this way, which is the actual
 * fix for the race orca's probe byte detects. The probe byte stays anyway — a file can
 * grow between the fstat and the read, and then a buffer sized from the fstat comes
 * back full and looks complete.
 *
 * `maxBytes` must be a positive safe integer. Orca rejects a negative or non-integer
 * limit rather than treating it as "no limit", and that is the right call: a limit that
 * silently means *unbounded* is worse than no limit at all, because the caller believes
 * there is one.
 */
export async function readBounded(path: string, maxBytes: number): Promise<BoundedRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RequestError(ErrorCodes.badRequest, `preview limit must be a positive integer, got ${maxBytes}`)
  }
  const handle = await open(path, constants.O_RDONLY)
  try {
    const stat = await handle.stat()
    if (stat.isDirectory()) {
      throw new RequestError(ErrorCodes.badRequest, `${path} is a directory`)
    }
    const limit = Math.min(stat.size, maxBytes)
    // One past the limit, always. If that byte comes back, there is more than we are
    // returning, whether because the cap fired or because the file grew under us.
    const buffer = Buffer.allocUnsafe(limit + 1)
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0)
    const kept = Math.min(bytesRead, limit)
    return {
      bytes: buffer.subarray(0, kept),
      size: stat.size,
      more: bytesRead > limit,
      bytesRead
    }
  } finally {
    await handle.close()
  }
}

/**
 * Is this buffer binary?
 *
 * A NUL byte in the first `BINARY_PROBE_BYTES`, which is the same rule `git diff` and
 * every editor uses and is right about every format anybody previews. Scans at most the
 * probe length **even when handed more**, so a caller that over-reads does not turn a
 * bounded decision into an unbounded one.
 */
export function isBinaryBuffer(bytes: Buffer): boolean {
  const end = Math.min(bytes.length, BINARY_PROBE_BYTES)
  for (let i = 0; i < end; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// External renderers
// ---------------------------------------------------------------------------

/** What produced the lines in a result. `plain` is this file's own decoding. */
export type { PreviewRenderer }

/**
 * Whether a renderer can be run, told apart the way phase 8 tells `rg` apart.
 *
 * Deliberately the same three-way answer and the same reasoning: `ENOENT` from `spawn`
 * is the only code that means "there is no such program", `absent` says nothing about
 * whether it is *installed* — only that it is not on the daemon's `PATH`, which is not
 * the user's interactive one — and fork/exec pressure is neither.
 */
export type RendererAvailability = 'present' | 'absent' | 'unavailable'

export interface CaptureOutcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** The spawn itself failed. `absent` when ENOENT, `unavailable` otherwise. */
  readonly failure: RendererAvailability | null
}

export type Capture = (command: string, args: readonly string[], cwd: string) => Promise<CaptureOutcome>

/**
 * Run a renderer and capture its stdout, bounded in bytes and in time.
 *
 * `spawn`, not `execFile`, for the reason phase 8's search documents: `execFile`
 * buffers internally and kills the child at `maxBuffer` with an error whose silence a
 * caller can easily read as success. Here the bound is explicit and the result says
 * nothing was lost that it did not report.
 *
 * `PATH` is augmented with `searchPath` — phase 8's, not a second copy — because a
 * daemon started outside a login shell does not have the user's `PATH`, and telling
 * somebody `glow` is missing when they can run it is a lie about their machine.
 */
export function createCapture(env: NodeJS.ProcessEnv = process.env): Capture {
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: searchPath(env) }
  return (command, args, cwd) =>
    new Promise<CaptureOutcome>((resolvePromise) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn(command, [...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv })
      } catch (error) {
        resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, failure: failureOf(error) })
        return
      }

      // Stateful, because a UTF-8 sequence can straddle a chunk boundary and a plain
      // `chunk.toString()` inserts U+FFFD where it does.
      const decoder = new StringDecoder('utf8')
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        // A spawn that never got a pid must not be killed: `kill()` on that handle
        // signals *our own process group*, which on a daemon is every pane it owns.
        if (child.pid !== undefined) child.kill()
      }, RENDERER_TIMEOUT_MS)
      timer.unref?.()

      const settle = (outcome: CaptureOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // A queued spawn `error` can arrive after this has settled, and an unhandled
        // `error` on a ChildProcess takes the whole daemon down.
        child.on('error', () => {})
        resolvePromise(outcome)
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (bytes >= RENDERER_MAX_BYTES) return
        bytes += chunk.length
        stdout += decoder.write(chunk)
        if (bytes >= RENDERER_MAX_BYTES && child.pid !== undefined) child.kill()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) =>
        settle({ code: null, stdout: '', stderr: '', timedOut, failure: failureOf(error) })
      )
      child.once('close', (code) => settle({ code, stdout: stdout + decoder.end(), stderr, timedOut, failure: null }))
    })
}

/**
 * `absent` only for `ENOENT`; everything else is `unavailable`.
 *
 * The distinction is load-bearing rather than decorative: `absent` is *remembered* for
 * the life of the daemon and `unavailable` is not. Phase 8's `isTransientSpawnError` is
 * what says fork/exec pressure belongs in the second group — being out of file
 * descriptors is not evidence that `glow` is uninstalled, and caching it as such would
 * disable the renderer until the daemon restarts.
 */
function failureOf(error: unknown): RendererAvailability {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ENOENT' && !isTransientSpawnError(error)) return 'absent'
  return 'unavailable'
}

// ---------------------------------------------------------------------------
// Choosing a renderer
// ---------------------------------------------------------------------------

const MARKDOWN = new Set(['.md', '.markdown', '.mdown', '.mkd'])
const DIFF = new Set(['.diff', '.patch'])

/**
 * Which external program, if any, should render this path.
 *
 * One per kind, and each earns its place by doing something the plain path cannot:
 *
 * - **`glow` for markdown.** Reflow. A README in thirty-four columns is the case where
 *   an external renderer is worth the spawn, because it turns a wall of link syntax and
 *   table pipes into prose that fits.
 * - **`delta` for a `.diff` or `.patch`.** Same argument: it is the user's own diff
 *   viewer, already configured, and a diff is the one text format whose *structure* is
 *   worth more than its bytes.
 * - **`bat` for everything else.** With colour off, which is the honest part: this dock
 *   paints its own styles and cannot consume ANSI, so **`bat`'s syntax highlighting is
 *   the one thing we do not take**. What it does give is the user's own configured
 *   wrapping, tab expansion and encoding handling, applied at the dock's real width.
 */
export function rendererFor(path: string): PreviewRenderer {
  const extension = extname(path).toLowerCase()
  if (MARKDOWN.has(extension)) return 'glow'
  if (DIFF.has(extension)) return 'delta'
  return 'bat'
}

/** The argv for each renderer, at a given dock width. */
export function rendererArgs(renderer: PreviewRenderer, path: string, width: number): string[] {
  const columns = Math.max(20, Math.min(width, 200))
  switch (renderer) {
    case 'glow':
      // `-s notty` is glow's own "no ANSI" style. Without it glow emits colour even
      // when its stdout is a pipe, and this panel would paint the escape codes.
      return ['-s', 'notty', '-w', String(columns), '--', path]
    case 'delta':
      return ['--color-only=false', '--paging=never', '--width', String(columns), '--', path]
    case 'bat':
      return [
        '--color=never',
        '--style=plain',
        '--paging=never',
        `--terminal-width=${columns}`,
        '--wrap=character',
        '--',
        path
      ]
    case 'plain':
      return []
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface PreviewServiceOptions {
  readonly capture?: Capture
  readonly maxBytes?: number
  readonly maxLines?: number
  /** Try an external renderer at all. Off makes every read take the plain path. */
  readonly useRenderers?: boolean
}

/** What `read` returns internally. The RPC drops `bytesRead` on the way to the wire. */
export interface PreviewOutcome extends PreviewResult {
  /** Bytes pulled off the disk. Asserted by tests; never sent. */
  readonly bytesRead: number
}

export class PreviewService {
  private readonly capture: Capture
  private readonly maxBytes: number
  private readonly maxLines: number
  private readonly useRenderers: boolean
  /**
   * What each renderer turned out to be, remembered for the life of the daemon.
   *
   * The one thing in this file that is cached, and only the *negative*: a `glow` that
   * was absent a second ago is still absent, and re-probing it on every keystroke of a
   * cursor moving down a tree is a fork per row. A renderer installed while the daemon
   * runs is picked up on the next restart, which is the same deal `rg` gets.
   */
  private readonly known = new Map<PreviewRenderer, RendererAvailability>()

  constructor(options: PreviewServiceOptions = {}) {
    this.capture = options.capture ?? createCapture()
    this.maxBytes = options.maxBytes ?? PREVIEW_MAX_BYTES
    this.maxLines = options.maxLines ?? PREVIEW_MAX_LINES
    this.useRenderers = options.useRenderers ?? true
  }

  /**
   * Read `relative` under `root` for display.
   *
   * The path is resolved against the root and checked *after* resolution, so `..` and a
   * symlink that points outside both fail rather than being caught by a string test
   * that a crafted name can walk past.
   */
  async read(root: string, relative: string, width: number): Promise<PreviewOutcome> {
    const path = this.resolveWithin(root, relative)

    // Binary first, and from its own small read. Deciding this from the text-sized read
    // would mean a 256 KiB read to discover an icon file is an icon file.
    const probe = await readBounded(path, BINARY_PROBE_BYTES)
    if (isBinaryBuffer(probe.bytes)) {
      return {
        path: relative,
        renderer: 'plain',
        lines: [],
        binary: true,
        truncated: false,
        cap: null,
        size: probe.size,
        bytesRead: probe.bytesRead
      }
    }

    const read = await readBounded(path, this.maxBytes)
    const bytesRead = probe.bytesRead + read.bytesRead

    if (this.useRenderers) {
      const rendered = await this.render(rendererFor(relative), path, root, width)
      if (rendered !== null) {
        const { lines, cap } = this.splitLines(rendered, read.more)
        return {
          path: relative,
          renderer: rendererFor(relative),
          lines,
          binary: false,
          truncated: cap !== null,
          cap,
          size: read.size,
          bytesRead
        }
      }
    }

    // The plain path: decode what was read and split it ourselves. `StringDecoder` and
    // not `toString`, because the cap can fall in the middle of a multi-byte character
    // and `toString` would end the preview on a replacement character.
    const decoder = new StringDecoder('utf8')
    const text = decoder.write(read.bytes) + decoder.end()
    const { lines, cap } = this.splitLines(text, read.more)
    return {
      path: relative,
      renderer: 'plain',
      lines,
      binary: false,
      truncated: cap !== null,
      cap,
      size: read.size,
      bytesRead
    }
  }

  /**
   * Run a renderer, or return null to take the plain path.
   *
   * Null for every reason: absent, would not start, timed out, exited non-zero, or
   * produced nothing. A preview must never fail *because* an optional tool did — the
   * plain path always works, so a renderer is an improvement or it is nothing.
   */
  private async render(
    renderer: PreviewRenderer,
    path: string,
    cwd: string,
    width: number
  ): Promise<string | null> {
    if (renderer === 'plain') return null
    if (this.known.get(renderer) === 'absent') return null
    const outcome = await this.capture(renderer, rendererArgs(renderer, path, width), cwd)
    if (outcome.failure !== null) {
      // Only `absent` is remembered. A transient launch failure is not evidence the
      // program is missing, and caching it would disable a renderer for the life of the
      // daemon because the machine was briefly out of file descriptors.
      if (outcome.failure === 'absent') this.known.set(renderer, 'absent')
      return null
    }
    this.known.set(renderer, 'present')
    if (outcome.timedOut || outcome.code !== 0) return null
    return outcome.stdout.length > 0 ? outcome.stdout : null
  }

  /** Split, bound the line count and the line length, and say which bound fired. */
  private splitLines(text: string, more: boolean): { lines: string[]; cap: PreviewResult['cap'] } {
    // `\r\n` and a bare `\r`, because a file written on Windows and a file written by a
    // progress bar both reach here.
    const all = text.split(/\r\n|\n|\r/u)
    // A trailing newline produces a final empty element that is not a line of the file.
    if (all.length > 0 && all[all.length - 1] === '') all.pop()

    let cap: PreviewResult['cap'] = more ? 'bytes' : null
    let lines = all
    if (all.length > this.maxLines) {
      lines = all.slice(0, this.maxLines)
      cap = 'lines'
    }
    return {
      lines: lines.map((line) =>
        line.length > PREVIEW_MAX_LINE_LENGTH ? `${line.slice(0, PREVIEW_MAX_LINE_LENGTH)}…` : line
      ),
      cap
    }
  }

  /**
   * `root` + `relative`, refusing anything that leaves the root.
   *
   * Checked with a separator-terminated prefix, not a bare `startsWith`: for a root of
   * `/tmp/repo`, `startsWith` also accepts `/tmp/repo-elsewhere`. Symlinks are resolved
   * first so a link inside the root pointing outside it is refused too, which a lexical
   * check alone would miss.
   */
  private resolveWithin(root: string, relative: string): string {
    if (relative.length === 0) throw new RequestError(ErrorCodes.badRequest, 'preview needs a path')
    if (isAbsolute(relative)) throw new RequestError(ErrorCodes.badRequest, 'preview takes a relative path')
    // `canonicalPath`, so the two sides of the comparison are resolved the same way.
    // On macOS a root under `$TMPDIR` is `/var/folders/…` to the caller and
    // `/private/var/folders/…` once resolved, and a containment check between the two
    // always fails; a symlink inside the root pointing outside it is caught here too,
    // which a lexical check alone would miss.
    const base = canonicalPath(root)
    const full = canonicalPath(join(base, relative))
    if (full !== base && !full.startsWith(`${base}${sep}`)) {
      throw new RequestError(ErrorCodes.badRequest, `path escapes the root: ${relative}`)
    }
    return full
  }
}

