/**
 * Data root and endpoint paths.
 *
 * The one hard constraint here is `sun_path`: macOS caps a unix socket path at 104
 * bytes including the NUL (`sys/un.h`), Linux at 108. A data root under
 * `~/Library/Application Support/...` plus `daemon/daemon-v<N>.sock` gets close enough
 * that the failure would show up on someone else's machine as a bare ENAMETOOLONG. So
 * the default roots are deliberately short, and the length is asserted at bind time.
 */

import { existsSync, readdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { lockFileName, socketFileName, PROTOCOL_VERSION } from '@leap-chorus/protocol'
import { DaemonError } from './errors.js'

/** macOS: `sizeof(sun_path)` is 104, and the path must be NUL-terminated within it. */
export const SUN_PATH_MAX_BYTES = process.platform === 'darwin' ? 104 : 108

export interface DaemonPaths {
  readonly dataRoot: string
  readonly daemonDir: string
  readonly socketPath: string
  readonly lockPath: string
  readonly logPath: string
  readonly protocolVersion: number
}

/**
 * Resolve the data root: `$LEAP_CHORUS_DATA_DIR`, else `$XDG_DATA_HOME/leap-chorus`, else `~/.leap-chorus`.
 *
 * `~/.leap-chorus` rather than a platform-idiomatic macOS location precisely because of the
 * socket path budget above; a chattier root would cost ~40 of the 104 bytes for nothing.
 */
export function resolveDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['LEAP_CHORUS_DATA_DIR']
  if (explicit && explicit.length > 0) return resolve(explicit)
  const xdg = env['XDG_DATA_HOME']
  if (xdg && xdg.length > 0) return resolve(join(xdg, 'leap-chorus'))
  return join(homedir(), '.leap-chorus')
}

export function resolveDaemonPaths(
  options: { dataRoot?: string; protocolVersion?: number; env?: NodeJS.ProcessEnv } = {}
): DaemonPaths {
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const dataRoot = options.dataRoot ? resolve(options.dataRoot) : resolveDataRoot(options.env)
  const daemonDir = join(dataRoot, 'daemon')
  return {
    dataRoot,
    daemonDir,
    socketPath: join(daemonDir, socketFileName(protocolVersion)),
    lockPath: join(daemonDir, lockFileName(protocolVersion)),
    logPath: join(daemonDir, `daemon-v${protocolVersion}.log`),
    protocolVersion
  }
}

// ---------------------------------------------------------------------------
// The pre-v1 data root
// ---------------------------------------------------------------------------

/**
 * What the data root was called before the rename, under each of the three rules above.
 *
 * Kept as a list rather than one path because a pre-v1 install could have been using
 * any of them, and the one that matters is the one that actually exists.
 */
export function legacyDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = []
  const xdg = env['XDG_DATA_HOME']
  if (xdg && xdg.length > 0) roots.push(resolve(join(xdg, 'herdr')))
  roots.push(join(homedir(), '.herdr'))
  return roots
}

export interface DataRootMigration {
  readonly from: string
  readonly to: string
  readonly moved: boolean
  readonly reason?: string
}

/**
 * Move a pre-v1 data root to its new name, once, on first start.
 *
 * ## Why this is a migration and not a rename
 *
 * A pre-v1 install has a session file, a log, and possibly a *running daemon* under the
 * old root. Simply changing the constant would leave that daemon holding a lock and a
 * socket at a path nothing looks at any more: its PTYs would stay alive, unreachable,
 * until the machine rebooted, and the user's session would appear to have vanished.
 *
 * So the rule is: move the directory when the new root does not exist yet and no live
 * daemon holds the old one. A live old daemon is reported rather than moved — renaming
 * the directory out from under a bound `AF_UNIX` socket does not free the endpoint, and
 * the honest answer is to tell the user to stop it.
 *
 * `LEAP_CHORUS_DATA_DIR` opts out entirely: an explicit root is a deliberate choice, and
 * there is no old name for it to have had.
 */
export function migrateLegacyDataRoot(
  options: { env?: NodeJS.ProcessEnv; dataRoot?: string } = {}
): DataRootMigration | null {
  const env = options.env ?? process.env
  if (options.dataRoot !== undefined) return null
  const explicit = env['LEAP_CHORUS_DATA_DIR']
  if (explicit && explicit.length > 0) return null

  const to = resolveDataRoot(env)
  if (existsSync(to)) return null

  for (const from of legacyDataRoots(env)) {
    if (!existsSync(from)) continue
    const live = liveSocketIn(join(from, 'daemon'))
    if (live !== null) {
      return {
        from,
        to,
        moved: false,
        reason: `a pre-rename daemon still owns ${live}; stop it, then start again`
      }
    }
    try {
      renameSync(from, to)
      return { from, to, moved: true }
    } catch (error) {
      return { from, to, moved: false, reason: String(error) }
    }
  }
  return null
}

/** The first bound-looking endpoint under a daemon directory, if any. */
function liveSocketIn(daemonDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(daemonDir)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.endsWith('.sock')) continue
    // A socket file left by a crash also exists; the lock beside it is what says a
    // daemon is live, and `acquireInstanceLock` is the only thing that can decide
    // that. Being conservative here costs one message, not the user's session.
    const lock = entry.replace(/\.sock$/, '.lock')
    if (entries.includes(lock)) return join(daemonDir, entry)
  }
  return null
}

/**
 * Fail loudly, and by name, when a socket path cannot fit in `sun_path`.
 *
 * Callers get this before `bind(2)` instead of an errno with no context.
 */
export function assertSocketPathFits(socketPath: string, maxBytes: number = SUN_PATH_MAX_BYTES): void {
  const bytes = Buffer.byteLength(socketPath, 'utf8')
  // The NUL terminator is part of the budget, so the usable path length is maxBytes - 1.
  if (bytes > maxBytes - 1) {
    throw new DaemonError(
      'leap_chorus_socket_path_too_long',
      `Socket path is ${bytes} bytes; this platform allows ${maxBytes - 1} (sun_path is ${maxBytes} including NUL): ${socketPath}`
    )
  }
}
