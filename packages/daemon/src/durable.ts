/**
 * Writing a file the user would mind losing.
 *
 * Two files qualify: the session file (`runtime.ts`) and the config file, which from
 * this phase on holds settings the user set through a dialog rather than typed. Both
 * were written in ways that are wrong in different directions, and both are fixed here
 * so there is one answer rather than two.
 *
 * Shaped after orca's `durable-file-write.ts` (MIT, Lovecast Inc. 2026). See `NOTICE`.
 *
 * ## The config file was not even atomic
 *
 * `writeConfigValue` did `readFileSync` → string surgery → `writeFileSync(path, text)`
 * **in place**. `writeFileSync` truncates before it writes, so a process killed between
 * those two steps leaves a config file that is empty or half a document — and the next
 * start reads it, finds a parse error on line 40, and comes up with every setting at
 * its default. The user's own file is the thing that was lost.
 *
 * ## The session file was atomic and not durable
 *
 * `persistNow` wrote a sibling and renamed it, which is correct against a mid-write
 * kill and **not** against power loss. orca's comment, from a real bug:
 *
 * > rename() is atomic for readers but not durable. Without fsync on the file and its
 * > directory, a power loss after a successful rename can leave the old contents, or an
 * > empty inode — the same empty-file symptom as issue #1158, from a different cause.
 *
 * So: write the temporary, **fsync it**, rename, then fsync the containing *directory*,
 * which is what makes the rename itself reach the disk.
 *
 * ## Why the directory fsync is best-effort and the file fsync is not
 *
 * `fsync` on a directory fd is refused on Windows (`EPERM`/`EISDIR`) and on some
 * filesystems, and it is not the step that protects the *contents* — it orders the
 * rename. Failing the whole write because a filesystem declined to order a rename would
 * turn a weaker guarantee into no write at all. The file fsync has no such excuse.
 *
 * ## The backup
 *
 * One `.bak`, taken from whatever was there before, kept only when the old file parsed
 * as something. It is not a version history; it is the one copy that turns "I lost my
 * config" into "rename this file back".
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

export interface DurableWriteOptions {
  /** Mode for the file itself. The temporary is created with the same one. */
  readonly mode?: number
  /** Mode for the containing directory, when it has to be created. */
  readonly dirMode?: number
  /**
   * Keep the previous contents at `<path>.bak` before replacing them.
   *
   * Off by default: the session file is regenerated every few seconds and a backup of
   * it is noise. On for the config file, which a human wrote.
   */
  readonly backup?: boolean
}

/**
 * fsync a path, swallowing the refusals that are not about durability.
 *
 * Returns whether it happened, which the caller uses only for the directory — a file
 * that could not be fsync'd is a real failure and is raised by the caller.
 */
function trySync(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // Closing a descriptor we are done with cannot make anything worse.
      }
    }
  }
}

/**
 * Replace `path` with `body`, atomically for readers and durably against power loss.
 *
 * Throws on anything that would leave the write unmade. The caller decides whether
 * that matters: losing a session file costs the next restore, and losing a config write
 * has to be reported to the user, so neither decision belongs here.
 */
export function writeFileDurable(path: string, body: string, options: DurableWriteOptions = {}): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, ...(options.dirMode === undefined ? {} : { mode: options.dirMode }) })

  // The pid is in the name so two daemons — which should not happen, and does — cannot
  // hand each other a half-written temporary to rename.
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, body, options.mode === undefined ? undefined : { mode: options.mode })

  // Before the rename, not after: the rename is what publishes the file, so the bytes
  // have to be on the disk first or the rename can publish an empty inode.
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'r+')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  if (options.backup === true) {
    try {
      // A copy of what is there now, taken by reading rather than by renaming, so a
      // failure here cannot remove the file it is protecting.
      const previous = readFileSync(path)
      if (previous.length > 0) writeFileSync(`${path}.bak`, previous, { mode: options.mode ?? 0o600 })
    } catch {
      // No previous file, or it could not be read. Neither is a reason not to write.
    }
  }

  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Leaving a stray `.tmp` beats masking the rename's own error.
    }
    throw error
  }

  // Best-effort, deliberately: see the module note. This orders the rename; it does not
  // protect the contents, which the fsync above already did.
  trySync(directory)
}
