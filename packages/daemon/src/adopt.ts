/**
 * Detachment and adoption.
 *
 * This is the file that makes live updates possible without `SCM_RIGHTS`. Node has no
 * `sendmsg` control-message API, so a PTY file descriptor cannot be handed from a dying
 * process to its replacement. orca's answer, which we take: never kill the PTY owner.
 * The daemon is spawned detached — its own process group, no inherited stdio, unref'd —
 * so whatever launched it can exit, be killed, or be replaced, and the daemon and every
 * PTY it owns keep running. A new client then *adopts* the running daemon by connecting
 * to the endpoint its protocol generation owns.
 *
 * Detachment is not service isolation. Under systemd, `KillMode=mixed` SIGKILLs the whole
 * cgroup when the stop timeout expires, detached or not. Surviving a service restart needs
 * separately supervised cgroups, which is out of scope here.
 */

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { DaemonInfo } from '@leap-chorus/protocol'
import { DaemonClient } from './client.js'
import { holderIsLive, readLockRecord } from './lock.js'
import type { DaemonPaths } from './paths.js'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Was this module run directly, rather than imported?
 *
 * The obvious spelling — `import.meta.url === \`file://${process.argv[1]}\`` — is
 * wrong on any path containing a symlink, and it fails *silently*: the program starts,
 * does nothing, and exits 0. macOS makes this the common case rather than the corner
 * one, because `/tmp` and `/var` are symlinks into `/private`, so a tarball unpacked
 * anywhere under either has `import.meta.url` reading `/private/var/...` while
 * `argv[1]` still says `/var/...`.
 *
 * Found by unpacking a release tarball and running it: `--help` printed nothing and
 * exited 0. Comparing real paths is the fix; comparing strings is the bug.
 */
export function isEntrypoint(moduleUrl: string, argv1: string | undefined = process.argv[1]): boolean {
  if (argv1 === undefined || argv1.length === 0) return false
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return path
    }
  }
  return real(fileURLToPath(moduleUrl)) === real(resolve(argv1))
}

/**
 * Locate the daemon entrypoint.
 *
 * Three layouts, because there are three ways this code runs:
 *
 * - **packaged**: `leap-chorusd.js` sits beside the bundled client in a tarball
 * - **built**: `main.js` sits next to this module in `dist/`
 * - **from source**: the built `dist/main.js` is one level up
 *
 * The packaged name is checked first because it is the only one a stranger's machine
 * will have, and because `main.js` is a name generic enough to exist by accident.
 * `LEAP_CHORUS_DAEMON_ENTRY` overrides all three.
 */
export function resolveDaemonEntry(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['LEAP_CHORUS_DAEMON_ENTRY']
  if (override && override.length > 0) return override
  const candidates = [join(here, 'leap-chorusd.js'), join(here, 'main.js'), join(here, '..', 'dist', 'main.js')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Cannot find the daemon entrypoint (looked at ${candidates.join(', ')}); run \`pnpm build\` or set LEAP_CHORUS_DAEMON_ENTRY`
  )
}

export interface SpawnDaemonOptions {
  readonly paths: DaemonPaths
  readonly entry?: string
  readonly execPath?: string
  readonly env?: NodeJS.ProcessEnv
}

/** Start a daemon that outlives this process. Returns its pid. */
export function spawnDetachedDaemon(options: SpawnDaemonOptions): number {
  const entry = options.entry ?? resolveDaemonEntry(options.env)
  const child = spawn(options.execPath ?? process.execPath, [entry, '--data-root', options.paths.dataRoot], {
    // `detached` gives the daemon its own process group (setsid on POSIX), so a signal
    // sent to the launcher's group does not reach it.
    detached: true,
    // No inherited stdio: a launcher's terminal closing must not give the daemon EPIPE,
    // and the daemon must not hold the launcher's pipes open.
    stdio: 'ignore',
    env: { ...(options.env ?? process.env), LEAP_CHORUS_DATA_DIR: options.paths.dataRoot }
  })
  // Stop the parent's event loop from waiting on it.
  child.unref()
  if (child.pid === undefined) throw new Error('Failed to spawn daemon: no pid')
  return child.pid
}

/** Connect to a running daemon, or null if nothing is listening. */
export async function probeDaemon(paths: DaemonPaths, timeoutMs = 2_000): Promise<DaemonInfo | null> {
  if (!existsSync(paths.socketPath)) return null
  try {
    const { client, daemon } = await DaemonClient.connect({
      socketPath: paths.socketPath,
      clientName: 'leap-chorus-probe',
      connectTimeoutMs: timeoutMs
    })
    client.close()
    return daemon
  } catch {
    // ECONNREFUSED on an existing socket file means a crashed daemon left it behind.
    return null
  }
}

/** True when a lock record names a process that is still running. */
export function daemonLockIsLive(paths: DaemonPaths): boolean {
  const record = readLockRecord(paths.lockPath)
  return record !== null && holderIsLive(record)
}

export interface EnsureDaemonOptions extends SpawnDaemonOptions {
  /** How long to wait for a freshly spawned daemon to answer. */
  readonly startupTimeoutMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Adopt the running daemon for this protocol generation, starting one if needed.
 *
 * "Adopt" and not "attach" because the daemon may predate this client entirely — that is
 * the point of the split.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonInfo> {
  const existing = await probeDaemon(options.paths)
  if (existing) return existing

  spawnDetachedDaemon(options)

  const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000)
  const interval = options.pollIntervalMs ?? 50
  let lastError: unknown
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    try {
      const info = await probeDaemon(options.paths)
      if (info) return info
    } catch (error) {
      lastError = error
    }
  }
  throw new Error(
    `Daemon did not become reachable at ${options.paths.socketPath}${lastError ? `: ${String(lastError)}` : ''}`
  )
}
