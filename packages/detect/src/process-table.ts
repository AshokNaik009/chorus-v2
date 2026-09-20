/**
 * One `ps` snapshot, shared by every pane.
 *
 * Taken from orca's `src/shared/process-table-snapshot-reader.ts` and
 * `process-table-index.ts` (MIT, Lovecast Inc. 2026), because they encode a measurement
 * this project would otherwise have to repeat:
 *
 * > Detection runs per pane on a poll. Use ONE TTL-cached `ps` snapshot with a memoized
 * > parent/child index, shared across all panes. Do not fork `pgrep` per pane.
 *
 * The number behind that rule: `pgrep -P` makes procps-ng open six procfs files per
 * process to resolve one ppid, measured at ~4k file opens per call on a 690-process
 * host, and the pane poll was making up to 8 of those calls a second (orca #13537). A
 * TTL-cached `ps` turns per-pane-per-poll work into per-TTL work, and the parent/child
 * index turns a per-pane linear scan into a map lookup.
 *
 * ## `fresh` is not an optimization knob
 *
 * A poll may read a 500 ms-old table because its next tick corrects it. A *destructive*
 * decision — closing a pane that "has no children" — acts on the answer once, and a
 * child that started inside the TTL would be killed with no confirmation. So
 * {@link ProcessTable.fresh} exists, it bypasses the cache, and closing paths call it.
 */

import { execFile } from 'node:child_process'

/** How long a capture may be reused. Sized to the detection poll, not to `ps`. */
export const PROCESS_TABLE_TTL_MS = 500

/** A wedged `ps` must not wedge the poll. Generous, because a loaded host is slow. */
export const PS_TIMEOUT_MS = 10_000

/** Above this a capture is truncation, not a machine with very many processes. */
export const PS_MAX_BUFFER_BYTES = 32 * 1024 * 1024

export interface ProcessRow {
  readonly pid: number
  readonly ppid: number
  /** Process group id; the foreground group is the one the tty reports. */
  readonly pgid: number
  /** The tty's foreground process group, or -1 when the process has no controlling tty. */
  readonly tpgid: number
  readonly command: string
}

/** Parent/child correlation over one capture, built once and read many times. */
export interface ProcessIndex {
  readonly rows: readonly ProcessRow[]
  readonly byPid: ReadonlyMap<number, ProcessRow>
  readonly childrenByPpid: ReadonlyMap<number, readonly ProcessRow[]>
}

export class ProcessTableError extends Error {
  constructor(readonly reason: 'capture_truncated' | 'empty_capture' | 'capture_failed', message: string) {
    super(message)
    this.name = 'ProcessTableError'
  }
}

const PS_ARGS = ['-axo', 'pid=,ppid=,pgid=,tpgid=,command='] as const

/**
 * Parse `ps -axo pid=,ppid=,pgid=,tpgid=,command=`.
 *
 * Lenient per row, strict per capture: a row that does not parse is skipped (a zombie
 * with no command is real), but a capture that yields no rows at all is an unreadable
 * table rather than a machine with no processes — and reading it as the latter would
 * tell every pane its agent had exited.
 */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const rawLine of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s*$/u.exec(rawLine)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    rows.push({
      pid,
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      tpgid: Number(match[4]),
      command: match[5] as string
    })
  }
  return rows
}

export function buildProcessIndex(rows: readonly ProcessRow[]): ProcessIndex {
  const byPid = new Map<number, ProcessRow>()
  const childrenByPpid = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    // A malformed table repeating a pid keeps the first, matching a `find()` walk.
    if (!byPid.has(row.pid)) byPid.set(row.pid, row)
    const children = childrenByPpid.get(row.ppid)
    if (children === undefined) childrenByPpid.set(row.ppid, [row])
    else children.push(row)
  }
  return { rows, byPid, childrenByPpid }
}

/** Depth-first descendants of a pid, off a prebuilt index. */
export function descendantsOf(index: ProcessIndex, rootPid: number): ProcessRow[] {
  const out: ProcessRow[] = []
  const stack = [...(index.childrenByPpid.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const row = stack.pop() as ProcessRow
    out.push(row)
    for (const child of index.childrenByPpid.get(row.pid) ?? []) stack.push(child)
  }
  return out
}

/**
 * How many captures happened, and how many index builds.
 *
 * Exposed because PHASE-5 criterion 3 is "prove it with a counter in a test": fifteen
 * panes polling inside one TTL window must produce one capture, not fifteen.
 */
export interface ProcessTableStats {
  captures: number
  indexBuilds: number
  cacheHits: number
  coalesced: number
}

export interface ProcessTableOptions {
  /** Injected in tests. Returns raw `ps` stdout. */
  readonly capture?: () => Promise<string>
  readonly now?: () => number
  readonly ttlMs?: number
}

interface Snapshot {
  readonly index: ProcessIndex
  readonly completedAtMs: number
}

export class ProcessTable {
  readonly stats: ProcessTableStats = { captures: 0, indexBuilds: 0, cacheHits: 0, coalesced: 0 }

  private readonly captureFn: () => Promise<string>
  private readonly now: () => number
  private readonly ttlMs: number
  private cached: Snapshot | null = null
  private inFlight: Promise<ProcessIndex> | null = null

  constructor(options: ProcessTableOptions = {}) {
    this.captureFn = options.capture ?? capturePs
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? PROCESS_TABLE_TTL_MS
  }

  /**
   * The shared table, captured at most once per TTL window.
   *
   * Three callers inside one window produce one capture and two cache hits; three
   * callers while a capture is running produce one capture and two coalesced waits.
   * Both are the point.
   */
  async get(): Promise<ProcessIndex> {
    const cached = this.cached
    if (cached !== null && this.now() - cached.completedAtMs < this.ttlMs) {
      this.stats.cacheHits += 1
      return cached.index
    }
    if (this.inFlight !== null) {
      this.stats.coalesced += 1
      return this.inFlight
    }
    return this.run()
  }

  /** A capture that started after this call. For decisions that cannot be retried. */
  async fresh(): Promise<ProcessIndex> {
    const prior = this.inFlight
    if (prior !== null) {
      // Not `await prior`: that capture began before this caller asked, so it can be
      // exactly as stale as the cache it is bypassing.
      try {
        await prior
      } catch {
        // The capture below owns this call's result.
      }
    }
    return this.run()
  }

  private async run(): Promise<ProcessIndex> {
    const pending = (async () => {
      const stdout = await this.captureFn()
      if (Buffer.byteLength(stdout, 'utf8') >= PS_MAX_BUFFER_BYTES) {
        throw new ProcessTableError('capture_truncated', 'ps output hit the buffer ceiling')
      }
      const rows = parseProcessRows(stdout)
      if (rows.length === 0) throw new ProcessTableError('empty_capture', 'ps returned no usable rows')
      this.stats.captures += 1
      this.stats.indexBuilds += 1
      const index = buildProcessIndex(rows)
      this.cached = { index, completedAtMs: this.now() }
      return index
    })()
    this.inFlight = pending
    try {
      return await pending
    } finally {
      if (this.inFlight === pending) this.inFlight = null
    }
  }

  reset(): void {
    this.cached = null
    this.inFlight = null
    this.stats.captures = 0
    this.stats.indexBuilds = 0
    this.stats.cacheHits = 0
    this.stats.coalesced = 0
  }
}

function capturePs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      [...PS_ARGS],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER_BYTES },
      (error, stdout) => {
        if (error) {
          const code = (error as { code?: unknown }).code
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            reject(new ProcessTableError('capture_truncated', 'ps output hit the buffer ceiling'))
            return
          }
          reject(new ProcessTableError('capture_failed', `ps failed: ${String(error)}`))
          return
        }
        resolve(stdout)
      }
    )
  })
}

// ---------------------------------------------------------------------------
// Questions the detector asks of a table
// ---------------------------------------------------------------------------

/**
 * Everything that could be the program a pane is running, best guess first.
 *
 * A list rather than one answer, because no single rule is right for every pane and
 * the caller is the only thing that knows what it is looking for. The order is:
 *
 * 1. **the tty's foreground process group leader**, when it is someone other than the
 *    root — this is the `vim` a shell is running, and the most common case
 * 2. **the root itself** — the pane's own program, when the pane *is* the program
 * 3. **descendants, shallowest first** — a wrapper script's child, before anything it
 *    went on to spawn
 *
 * (2) before (3) is the correction for a bug worth naming: a pane launched directly
 * into `claude` is its own foreground group leader, so rule (1) does not fire, and the
 * previous code fell straight to *the deepest descendant*. Claude had started a
 * Playwright MCP server, so the deepest descendant was `node .../playwright`, which is
 * not an agent — and the pane reported no agent at all while claude's UI sat on the
 * screen. Any agent that runs an MCP server, which in practice is most of them, was
 * undetectable. Found by running one.
 *
 * Shallowest-first in (3) is the same reasoning one level down: a launcher's child is
 * far more likely to be the agent than whatever that child subsequently forked.
 */
export function foregroundCandidates(index: ProcessIndex, rootPid: number): string[] {
  const root = index.byPid.get(rootPid)
  if (root === undefined) return []

  const candidates: string[] = []
  // Compared against `pid`, not `pgid`: a group leader's pgid is its own pid, so this
  // asks "is some *other* process group in the foreground".
  if (root.tpgid > 0 && root.tpgid !== root.pid) {
    const leader = index.byPid.get(root.tpgid)
    if (leader !== undefined) candidates.push(leader.command)
  }
  candidates.push(root.command)

  const depth = new Map<number, number>([[rootPid, 0]])
  const descendants = descendantsOf(index, rootPid)
  for (const row of descendants) depth.set(row.pid, (depth.get(row.ppid) ?? 0) + 1)
  for (const row of [...descendants].sort((a, b) => (depth.get(a.pid) ?? 0) - (depth.get(b.pid) ?? 0))) {
    candidates.push(row.command)
  }
  return candidates
}

/** The single best guess at what a pane is running. See {@link foregroundCandidates}. */
export function foregroundCommand(index: ProcessIndex, rootPid: number): string | null {
  return foregroundCandidates(index, rootPid)[0] ?? null
}

/** Whether anything at all runs under a pane's shell. Used by close guards. */
export function hasChildren(index: ProcessIndex, shellPid: number): boolean {
  return (index.childrenByPpid.get(shellPid)?.length ?? 0) > 0
}
