/**
 * The working directory a pane's shell is actually in.
 *
 * `pane.cwd` on the session model is where the pane was *spawned*. A shell that has
 * since `cd`-ed somewhere else does not update it, and nothing tells us it moved: the
 * cwd is the shell's own process state, not something it reports. So anything that
 * needs the live directory — the source-control panel asking which repository you are
 * looking at — has to go and read it.
 *
 * ## Why not OSC 7
 *
 * A shell *can* announce its directory with `OSC 7 ; file://host/path`, and a terminal
 * that listens gets it for free. Most shells only emit it when the user's prompt has
 * been configured to, which is exactly the people who would not notice it missing. The
 * kernel always knows, so ask the kernel; OSC 7 would be a cache in front of this, not
 * a replacement for it.
 *
 * ## Why the shell's pid and not the foreground job's
 *
 * `cd` is a shell builtin: it changes the shell's own directory. A foreground child —
 * vim, an agent — has whatever directory it inherited, which is the same one until it
 * changes its own. The shell is the process whose cwd answers "where am I".
 */

import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'

/** A stuck `lsof` must not stall a panel refresh. */
const LOOKUP_TIMEOUT_MS = 2_000

/**
 * The current working directory of `pid`, or null when it cannot be read.
 *
 * Null rather than a throw: a process that exited between the snapshot and this call is
 * ordinary, and the caller falls back to the recorded cwd.
 */
export async function liveCwd(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform === 'linux') return linuxCwd(pid)
  if (platform === 'darwin') return darwinCwd(pid)
  return null
}

/** Linux keeps it in procfs, as a symlink. One readlink, no subprocess. */
async function linuxCwd(pid: number): Promise<string | null> {
  try {
    const path = await readlink(`/proc/${pid}/cwd`)
    return path.length > 0 ? path : null
  } catch {
    return null
  }
}

/**
 * macOS has no procfs, so this shells out to `lsof`.
 *
 * `-Fn` is the machine-readable format — one field per line, tagged by its first
 * character — rather than the columns, which are aligned for people and shift when a
 * path is long. `-a` makes the two filters AND rather than OR, without which this asks
 * for every open file of every process.
 */
async function darwinCwd(pid: number): Promise<string | null> {
  const stdout = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  if (stdout === null) return null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n/')) return line.slice(1)
  }
  return null
}

function run(command: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, [...args], { encoding: 'utf8', timeout: LOOKUP_TIMEOUT_MS }, (error, stdout) => {
      // `lsof` exits non-zero when it has nothing to report, which is not an error
      // worth distinguishing from a path it could not read.
      resolve(error !== null && stdout.length === 0 ? null : stdout)
    })
  })
}

/** Exported for the parser's own test: `lsof -Fn` output, minus the process running it. */
export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n/')) return line.slice(1)
  }
  return null
}
