/**
 * Shared scaffolding for the tests that need a real daemon process on disk.
 *
 * These tests run against the *built* `dist/main.js`, not the TypeScript sources, because
 * what they prove is about process lifetime: a daemon that outlives its launcher has to
 * be a real detached process, not an object in the test's own event loop.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from '../src/client.js'
import { isProcessAlive } from '../src/lock.js'
import { probeDaemon, resolveDaemonEntry, spawnDetachedDaemon } from '../src/adopt.js'
import { assertSocketPathFits, resolveDaemonPaths, type DaemonPaths } from '../src/paths.js'

const created: string[] = []

/** A short-prefixed temp root, because the endpoint path has a `sun_path` budget. */
export function tempDataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hrd-'))
  created.push(root)
  return root
}

export function cleanupDataRoots(): void {
  while (created.length > 0) {
    const root = created.pop()
    if (root !== undefined) removeWithRetry(root)
  }
}

/**
 * `rmSync` is not atomic, and these directories can still have a process in them.
 *
 * `force: true` swallows "it was not there"; it does nothing about "somebody put a file
 * back while I was walking the tree", which is what a daemon writing its session file
 * every few seconds does. The result is `ENOTEMPTY` on the final `rmdir` — a teardown
 * failure that fails the *test*, which is how a documented flake ends up looking like a
 * product bug. The daemon is stopped and waited for before this runs; this is the
 * backstop for the case where stopping it timed out.
 *
 * Synchronous on purpose: every caller is an `afterEach`/`afterAll` that does not await,
 * and `Atomics.wait` sleeps the thread rather than spinning it.
 */
function removeWithRetry(root: string, attempts = 5): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (attempt >= attempts - 1 || (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
    }
  }
}

export function testPaths(): DaemonPaths {
  const paths = resolveDaemonPaths({ dataRoot: tempDataRoot() })
  // Fail here, with the measurement, rather than inside bind(2) on a CI box.
  assertSocketPathFits(paths.socketPath)
  return paths
}

export async function waitUntil(
  check: () => boolean | Promise<boolean>,
  describeFailure: string,
  timeoutMs = 10_000,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out: ${describeFailure}`)
}

export interface DaemonHandle {
  readonly paths: DaemonPaths
  readonly pid: number
  stop(): Promise<void>
}

/** Start a detached daemon and wait until its endpoint answers. */
export async function startDetachedDaemon(paths: DaemonPaths = testPaths()): Promise<DaemonHandle> {
  const pid = spawnDetachedDaemon({ paths })
  await waitUntil(async () => (await probeDaemon(paths)) !== null, `daemon never bound ${paths.socketPath}`)
  return {
    paths,
    pid,
    async stop(): Promise<void> {
      if (isProcessAlive(pid)) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
      await waitUntil(() => !isProcessAlive(pid), `daemon ${pid} did not exit`, 5_000).catch(async () => {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
        // And *wait* for it. Returning here used to hand control back while the daemon
        // was still running, so `cleanupDataRoots` would start deleting the data root
        // out from under a live process that was still writing its session file — which
        // is where `survival.test.ts`'s long-standing
        // `ENOTEMPTY: directory not empty, rmdir …/daemon` came from. SIGKILL is not
        // instantaneous, and under load it is not close to it.
        await waitUntil(() => !isProcessAlive(pid), `daemon ${pid} survived SIGKILL`, 5_000).catch(() => {
          // Nothing else to try. The retry in `cleanupDataRoots` is the backstop.
        })
      })
    }
  }
}

export async function connectTo(paths: DaemonPaths, clientName = 'test-client') {
  return DaemonClient.connect({ socketPath: paths.socketPath, clientName })
}

/**
 * Run a client in its own process, so a test can kill it the way a real client dies.
 *
 * `script` is ESM source evaluated by node with the daemon package importable; the data
 * root arrives as argv[1] and the built daemon entry as LEAP_CHORUS_DAEMON_ENTRY.
 */
export function spawnClientProcess(paths: DaemonPaths, script: string, args: readonly string[] = []): ChildProcess {
  return spawn(process.execPath, ['--input-type=module', '-e', script, paths.dataRoot, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LEAP_CHORUS_DAEMON_ENTRY: resolveDaemonEntry(),
      LEAP_CHORUS_DAEMON_MODULE: daemonModuleUrl(),
      LEAP_CHORUS_DATA_DIR: paths.dataRoot
    }
  })
}

/** Collect a client process's stdout until it exits, failing on a non-zero exit. */
export function runClientProcess(
  paths: DaemonPaths,
  script: string,
  args: readonly string[] = []
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawnClientProcess(paths, script, args)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolve({ stdout, stderr, code }))
  })
}

/** Absolute path to the built daemon package entry, for scripts run in other processes. */
export function daemonModuleUrl(): string {
  const entry = resolveDaemonEntry()
  return new URL(`file://${entry.replace(/main\.js$/u, 'index.js')}`).href
}
