/**
 * Instance lock: one live daemon per data root per protocol generation.
 *
 * The lock deliberately scopes *one role* — who owns this endpoint generation. A lock
 * that asked "is anything using this root" would refuse exactly the restarts a surviving
 * daemon makes worthwhile. (orca's orcad lock makes the same distinction.)
 *
 * A dead holder's record is reclaimed. To make that safe against PID reuse, the record
 * carries the holder's process start time as well as its PID: a recycled PID does not
 * read as the original holder. A record belonging to another uid is never reclaimed.
 */

import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync, chmodSync } from 'node:fs'
import { DaemonError, errnoOf } from './errors.js'

export interface LockRecord {
  readonly pid: number
  /** Opaque, platform-specific process start stamp. Empty when it could not be read. */
  readonly startTime: string
  readonly uid: number
  readonly protocolVersion: number
  readonly socketPath: string
  readonly acquiredAt: number
}

export interface InstanceLock {
  readonly path: string
  readonly record: LockRecord
  release(): void
}

/**
 * Process start time, used to tell "PID 4211 is still the daemon" from "PID 4211 was
 * recycled by something else". `ps -o lstart=` is the portable-enough answer on macOS
 * and Linux; when it fails we fall back to PID liveness alone and say so by recording
 * an empty stamp.
 */
export function readProcessStartTime(pid: number): string {
  if (process.platform === 'win32') return ''
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return ''
  }
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else: alive for our purposes.
    return errnoOf(error) === 'EPERM'
  }
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1
}

function parseRecord(raw: string): LockRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Partial<LockRecord>
    if (typeof record.pid !== 'number' || typeof record.uid !== 'number') return null
    return {
      pid: record.pid,
      startTime: typeof record.startTime === 'string' ? record.startTime : '',
      uid: record.uid,
      protocolVersion: typeof record.protocolVersion === 'number' ? record.protocolVersion : 0,
      socketPath: typeof record.socketPath === 'string' ? record.socketPath : '',
      acquiredAt: typeof record.acquiredAt === 'number' ? record.acquiredAt : 0
    }
  } catch {
    return null
  }
}

/** True when the recorded holder is still the process that took the lock. */
export function holderIsLive(record: LockRecord): boolean {
  if (!isProcessAlive(record.pid)) return false
  if (record.startTime === '') return true
  const startTime = readProcessStartTime(record.pid)
  // An unreadable start time for a live PID is inconclusive; treat the holder as live
  // rather than stealing a lock we cannot prove is stale.
  if (startTime === '') return true
  return startTime === record.startTime
}

/**
 * Ensure the data root is ours and private.
 *
 * A root that is merely too permissive and that we own is tightened to 0700 rather than
 * refused — refusing when we could just fix it helps nobody. We refuse when the
 * permissions are not ours to fix. Windows is exempt: ACLs are not a POSIX mode.
 */
export function ensurePrivateDirectory(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error) {
    throw new DaemonError('leap_chorus_data_root_unusable', `Cannot create ${dir}: ${String(error)}`, { cause: error })
  }

  if (process.platform === 'win32') return

  let stats
  try {
    stats = statSync(dir)
  } catch (error) {
    throw new DaemonError('leap_chorus_data_root_unusable', `Cannot stat ${dir}: ${String(error)}`, { cause: error })
  }

  const uid = currentUid()
  if (uid >= 0 && stats.uid !== uid) {
    throw new DaemonError(
      'leap_chorus_data_root_wrong_owner',
      `${dir} is owned by uid ${stats.uid}, not ${uid}`
    )
  }

  const mode = stats.mode & 0o777
  if ((mode & 0o077) !== 0) {
    try {
      chmodSync(dir, 0o700)
    } catch (error) {
      throw new DaemonError(
        'leap_chorus_data_root_unusable',
        `${dir} is group/world accessible (mode ${mode.toString(8)}) and could not be tightened`,
        { cause: error }
      )
    }
  }
}

export interface AcquireLockOptions {
  readonly lockPath: string
  readonly socketPath: string
  readonly protocolVersion: number
  readonly pid?: number
}

/**
 * Take the instance lock, or refuse with a named code.
 *
 * Exclusive create (`wx`) is the primitive: it is atomic, so two daemons racing to start
 * cannot both believe they won.
 */
export function acquireInstanceLock(options: AcquireLockOptions): InstanceLock {
  const pid = options.pid ?? process.pid
  const record: LockRecord = {
    pid,
    startTime: readProcessStartTime(pid),
    uid: currentUid(),
    protocolVersion: options.protocolVersion,
    socketPath: options.socketPath,
    acquiredAt: Date.now()
  }

  const write = (): InstanceLock => {
    let fd: number
    try {
      fd = openSync(options.lockPath, 'wx', 0o600)
    } catch (error) {
      if (errnoOf(error) === 'EEXIST') {
        throw new DaemonError('leap_chorus_instance_lock_held', `Lock is held: ${options.lockPath}`)
      }
      throw new DaemonError(
        'leap_chorus_instance_lock_unusable',
        `Cannot create lock ${options.lockPath}: ${String(error)}`,
        { cause: error }
      )
    }
    try {
      writeSync(fd, JSON.stringify(record))
    } finally {
      closeSync(fd)
    }
    return {
      path: options.lockPath,
      record,
      release(): void {
        try {
          // Only drop the file if it is still ours; never delete a successor's lock.
          const existing = existsSync(options.lockPath) ? parseRecord(readFileSync(options.lockPath, 'utf8')) : null
          if (existing && existing.pid === record.pid && existing.acquiredAt === record.acquiredAt) {
            unlinkSync(options.lockPath)
          }
        } catch {
          // Releasing is best-effort: a stale file is reclaimable, a thrown error at
          // shutdown is not useful.
        }
      }
    }
  }

  try {
    return write()
  } catch (error) {
    if (!(error instanceof DaemonError) || error.code !== 'leap_chorus_instance_lock_held') throw error
  }

  // Someone got there first, or left a corpse behind. Decide which.
  let raw: string
  try {
    raw = readFileSync(options.lockPath, 'utf8')
  } catch (readError) {
    throw new DaemonError(
      'leap_chorus_instance_lock_unusable',
      `Lock ${options.lockPath} exists but cannot be read: ${String(readError)}`,
      { cause: readError }
    )
  }

  const existing = parseRecord(raw)
  if (!existing) {
    // An unparsable record proves nothing about a holder, so it is reclaimable.
    unlinkSync(options.lockPath)
    return write()
  }

  const uid = currentUid()
  if (uid >= 0 && existing.uid !== uid) {
    throw new DaemonError(
      'leap_chorus_instance_lock_foreign_identity',
      `Lock ${options.lockPath} belongs to uid ${existing.uid}, not ${uid}`
    )
  }

  if (holderIsLive(existing)) {
    throw new DaemonError(
      'leap_chorus_instance_lock_held',
      `Another daemon (pid ${existing.pid}) owns ${options.socketPath}`
    )
  }

  try {
    unlinkSync(options.lockPath)
  } catch (error) {
    throw new DaemonError(
      'leap_chorus_instance_lock_unusable',
      `Cannot reclaim stale lock ${options.lockPath}: ${String(error)}`,
      { cause: error }
    )
  }
  return write()
}

/** Read a lock record without taking it. Used by clients to find a running daemon. */
export function readLockRecord(lockPath: string): LockRecord | null {
  try {
    return parseRecord(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}
