import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isDaemonError } from './errors.js'
import {
  acquireInstanceLock,
  ensurePrivateDirectory,
  holderIsLive,
  isProcessAlive,
  readLockRecord,
  readProcessStartTime,
  type LockRecord
} from './lock.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'leap-chorus-lock-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()
    if (root) rmSync(root, { recursive: true, force: true })
  }
})

function acquire(root: string, pid = process.pid) {
  return acquireInstanceLock({
    lockPath: join(root, 'daemon-v1.lock'),
    socketPath: join(root, 'daemon-v1.sock'),
    protocolVersion: 1,
    pid
  })
}

describe('process identity', () => {
  it('sees this process as alive', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it('does not see an implausible pid as alive', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })

  it('reads a start time for a live process', () => {
    expect(readProcessStartTime(process.pid)).not.toBe('')
  })

  it('treats a recycled pid as a dead holder', () => {
    const record: LockRecord = {
      pid: process.pid,
      // Same pid, different start stamp: this is what pid reuse looks like.
      startTime: 'Thu Jan  1 00:00:00 1970',
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      protocolVersion: 1,
      socketPath: '/tmp/x.sock',
      acquiredAt: 0
    }
    expect(holderIsLive(record)).toBe(false)
  })
})

describe('instance lock (criterion 5)', () => {
  it('records the holder and releases cleanly', () => {
    const root = tempRoot()
    const lock = acquire(root)
    expect(readLockRecord(lock.path)?.pid).toBe(process.pid)
    lock.release()
    expect(existsSync(lock.path)).toBe(false)
  })

  it('refuses a second holder with leap_chorus_instance_lock_held', () => {
    const root = tempRoot()
    const first = acquire(root)
    try {
      acquire(root)
      expect.unreachable('second acquisition should have been refused')
    } catch (error) {
      expect(isDaemonError(error) && error.code).toBe('leap_chorus_instance_lock_held')
    }
    // The first holder's record is untouched by the refusal.
    expect(readLockRecord(first.path)?.pid).toBe(process.pid)
    first.release()
  })

  it('reclaims a dead holder', () => {
    const root = tempRoot()
    const lockPath = join(root, 'daemon-v1.lock')
    const dead: LockRecord = {
      pid: 999_999,
      startTime: 'Thu Jan  1 00:00:00 1970',
      uid: typeof process.getuid === 'function' ? process.getuid() : -1,
      protocolVersion: 1,
      socketPath: join(root, 'daemon-v1.sock'),
      acquiredAt: 1
    }
    writeFileSync(lockPath, JSON.stringify(dead))
    const lock = acquire(root)
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid)
    lock.release()
  })

  it('reclaims an unparsable record', () => {
    const root = tempRoot()
    const lockPath = join(root, 'daemon-v1.lock')
    writeFileSync(lockPath, 'not json at all')
    const lock = acquire(root)
    expect(readLockRecord(lockPath)?.pid).toBe(process.pid)
    lock.release()
  })

  it('never reclaims a record belonging to another uid', () => {
    const root = tempRoot()
    const lockPath = join(root, 'daemon-v1.lock')
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1
    if (uid < 0) return
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 999_999,
        startTime: '',
        uid: uid + 1,
        protocolVersion: 1,
        socketPath: '/tmp/x.sock',
        acquiredAt: 1
      })
    )
    try {
      acquire(root)
      expect.unreachable('a foreign record must not be reclaimed')
    } catch (error) {
      expect(isDaemonError(error) && error.code).toBe('leap_chorus_instance_lock_foreign_identity')
    }
    // Even dead, a foreign record is left exactly as found.
    expect(readLockRecord(lockPath)?.uid).toBe(uid + 1)
  })

  it('does not delete a successor lock on release', () => {
    const root = tempRoot()
    const lock = acquire(root)
    // Simulate a successor that reclaimed the file while we were shutting down.
    const successor = { ...(readLockRecord(lock.path) as LockRecord), pid: 4242, acquiredAt: Date.now() + 1 }
    writeFileSync(lock.path, JSON.stringify(successor))
    lock.release()
    expect(readLockRecord(lock.path)?.pid).toBe(4242)
    rmSync(lock.path, { force: true })
  })
})

describe('data root privacy', () => {
  it('creates the directory 0700', () => {
    const root = tempRoot()
    const dir = join(root, 'daemon')
    ensurePrivateDirectory(dir)
    if (process.platform !== 'win32') {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  it('tightens a too-permissive directory we own rather than refusing', () => {
    if (process.platform === 'win32') return
    const root = tempRoot()
    const dir = join(root, 'daemon')
    ensurePrivateDirectory(dir)
    chmodSync(dir, 0o755)
    ensurePrivateDirectory(dir)
    expect(statSync(dir).mode & 0o077).toBe(0)
  })

  it('writes the lock file 0600', () => {
    if (process.platform === 'win32') return
    const root = tempRoot()
    const lock = acquire(root)
    expect(statSync(lock.path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(lock.path, 'utf8')).protocolVersion).toBe(1)
    lock.release()
  })
})
