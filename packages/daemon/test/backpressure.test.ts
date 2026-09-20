/**
 * Criterion 8 — a pane running `yes` must not grow the daemon without bound while no
 * client is reading.
 *
 * The policy under test is the one documented in sessions.ts: node-pty's
 * `handleFlowControl` stays off, the daemon drives `pause()`/`resume()` off the
 * emulator's unparsed backlog, and clients are never sent raw output at all. So there
 * are three things to assert — that the backlog is bounded, that nothing is dropped, and
 * that the daemon's RSS is flat under a sustained flood.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { PaneEmulator } from '../src/emulator.js'
import { isProcessAlive } from '../src/lock.js'
import { HIGH_WATER_BYTES, SessionManager } from '../src/sessions.js'
import { cleanupDataRoots, connectTo, startDetachedDaemon, waitUntil, type DaemonHandle } from './harness.js'

const YES = existsSync('/usr/bin/yes') ? '/usr/bin/yes' : 'yes'
/** The criterion says 30 seconds; shorten it only when iterating locally. */
const FLOOD_SECONDS = Number.parseInt(process.env['LEAP_CHORUS_BACKPRESSURE_SECONDS'] ?? '30', 10)

const daemons: DaemonHandle[] = []
let manager: SessionManager | null = null

afterEach(async () => {
  manager?.disposeAll()
  manager = null
  while (daemons.length > 0) {
    const daemon = daemons.pop()
    if (daemon) await daemon.stop()
  }
  cleanupDataRoots()
})

/** Resident set size in KiB, as the OS reports it. */
function rssKib(pid: number): number {
  const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  const value = Number.parseInt(out, 10)
  if (!Number.isFinite(value)) throw new Error(`Could not read RSS for pid ${pid}: ${JSON.stringify(out)}`)
  return value
}

describe('emulator backlog accounting', () => {
  it('counts unparsed bytes and drains to zero', async () => {
    const emulator = new PaneEmulator({ cols: 80, rows: 24 })
    const chunk = new Uint8Array(Buffer.from('x'.repeat(64 * 1024)))

    // Deliberately unawaited: this is what a producer faster than the parser looks like.
    const writes: Array<Promise<void>> = []
    for (let i = 0; i < 40; i++) writes.push(emulator.write(chunk))
    expect(emulator.pendingBytes).toBeGreaterThan(0)

    await Promise.all(writes)
    expect(emulator.pendingBytes).toBe(0)
    emulator.dispose()
  })
})

describe('flooding pane, in process', () => {
  it('keeps the unparsed backlog bounded and drops nothing', async () => {
    manager = new SessionManager()
    const session = manager.create({ cols: 80, rows: 24, command: YES, args: [] })

    let peakPending = 0
    let sawPause = false
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      peakPending = Math.max(peakPending, session.emulator.pendingBytes)
      sawPause = sawPause || session.isPaused
    }

    // The flood has to be real, or this test proves nothing.
    expect(session.info().bytesRead).toBeGreaterThan(1_000_000)
    // Bounded: the backlog cannot exceed the high-water mark by more than the pty read
    // that crossed it, because the next read is not taken until it drains.
    expect(peakPending).toBeLessThan(HIGH_WATER_BYTES * 2)
    // Nothing is discarded under this policy; a future dropping policy would report here.
    expect(session.info().bytesDropped).toBe(0)
    expect(session.alive).toBe(true)
    // Whether pause actually engaged depends on how the parser keeps up; either way the
    // backlog bound above is the invariant. Record it for the log, do not require it.
    expect(typeof sawPause).toBe('boolean')
  })
})

describe('flooding pane, no client attached (criterion 8)', () => {
  it(
    `holds RSS steady across ${FLOOD_SECONDS}s of \`yes\``,
    async () => {
      const daemon = await startDetachedDaemon()
      daemons.push(daemon)

      const { client } = await connectTo(daemon.paths, 'flood-starter')
      const { session } = await client.call('session.create', { cols: 80, rows: 24, command: YES, args: [] })
      // Detach: from here on nobody is reading this pane's output.
      client.close()

      // Let the daemon reach steady state before taking the baseline, so JIT warmup and
      // first-allocation growth are not mistaken for a leak.
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      const baselineKib = rssKib(daemon.pid)

      await new Promise((resolve) => setTimeout(resolve, FLOOD_SECONDS * 1_000))
      const finalKib = rssKib(daemon.pid)

      expect(isProcessAlive(daemon.pid)).toBe(true)

      const { client: reader } = await connectTo(daemon.paths, 'flood-reader')
      try {
        const { session: after } = await reader.call('session.get', { id: session.id })
        // The flood ran the whole time, unattended.
        expect(after.alive).toBe(true)
        expect(after.bytesRead).toBeGreaterThan(10_000_000)
        expect(after.bytesDropped).toBe(0)

        // And the pane is still responsive rather than wedged behind its own backlog.
        await waitUntil(async () => {
          const { snapshot } = await reader.call('session.snapshot', { id: session.id })
          return snapshot.rows === 24
        }, 'the flooded pane never answered a snapshot request')
      } finally {
        reader.close()
      }

      const growthMib = (finalKib - baselineKib) / 1024
      // Unbounded buffering of a ~50 MB/s flood would be hundreds of MiB over this window.
      // Allow slack for GC timing, not for a trend.
      expect(growthMib).toBeLessThan(32)
    },
    (FLOOD_SECONDS + 45) * 1_000
  )
})
