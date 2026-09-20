/**
 * The render loop, driven directly.
 *
 * The PTY tests next door prove the client works as a program. These prove the two things
 * PHASE-2 asks for as numbers — that the diff beats a full repaint (criterion 5) and that
 * a hidden pane is cheaper than a visible one (criterion 8) — *deterministically*, by
 * counting what the loop did rather than timing it. The benchmark reports the clock;
 * these assert the mechanism, which is what would actually break.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DaemonClient, isProcessAlive, probeDaemon, resolveDaemonPaths, spawnDetachedDaemon } from '@leap-chorus/daemon'
import { TuiApp } from '@leap-chorus/client'

interface Rig {
  app: TuiApp
  client: DaemonClient
  written: string[]
  stop(): Promise<void>
}

let rig: Rig | null = null

afterEach(async () => {
  await rig?.stop()
  rig = null
})

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startRig(options: { cols?: number; rows?: number } = {}): Promise<Rig> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hra-'))
  const paths = resolveDaemonPaths({ dataRoot })
  const daemonPid = spawnDetachedDaemon({ paths })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && (await probeDaemon(paths)) === null) await sleep(25)

  const { client } = await DaemonClient.connect({ socketPath: paths.socketPath, clientName: 'app-test' })
  const written: string[] = []
  const app = await TuiApp.start({
    client,
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    write: (data) => written.push(data),
    // `cat` echoes what it is sent and nothing else, so output is exactly what a test asks for.
    command: '/bin/cat',
    // These tests count frames, so they drive the loop themselves.
    autoRender: false
  })

  rig = {
    app,
    client,
    written,
    async stop(): Promise<void> {
      await app.killAll().catch(() => undefined)
      await app.close()
      client.close()
      if (isProcessAlive(daemonPid)) {
        try {
          process.kill(daemonPid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
      const until = Date.now() + 5_000
      while (Date.now() < until && isProcessAlive(daemonPid)) await sleep(25)
      rmSync(dataRoot, { recursive: true, force: true })
    }
  }
  return rig
}

/** Render until a frame reports it pulled no snapshots: everything visible is current. */
async function settle(app: TuiApp, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const stats = await app.render()
    if (stats.snapshotsFetched === 0 && i > 0) return
    await sleep(25)
  }
}

describe('the render loop', () => {
  it('writes nothing when nothing changed', async () => {
    const r = await startRig()
    await settle(r.app)
    const stats = await r.app.render()
    expect(stats.spans).toBe(0)
    expect(stats.bytes).toBe(0)
  })

  // Criterion 5, at the level the user actually pays for it.
  it('an incremental frame writes far fewer bytes than a full repaint', async () => {
    const r = await startRig({ cols: 200, rows: 50 })
    await settle(r.app)

    r.app.invalidate()
    const repaint = await r.app.render()
    expect(repaint.cells).toBe(200 * 50)

    // One pane's worth of new output, then an incremental frame.
    // The pane id and its terminal's session id are different things now that the
    // daemon owns the model; a write goes to the session.
    const sessionId = r.app.focusedSessionId as string
    await r.client.call('session.write', { id: sessionId, data: 'a line of output\n' })
    await sleep(120)
    const incremental = await r.app.render()

    expect(incremental.cells).toBeGreaterThan(0)
    expect(incremental.cells).toBeLessThan(repaint.cells)
    expect(incremental.bytes).toBeLessThan(repaint.bytes)
    expect(incremental.bytes * 20).toBeLessThan(repaint.bytes)
  })

  it('a resize forces one full repaint and then goes incremental again', async () => {
    const r = await startRig({ cols: 100, rows: 30 })
    await settle(r.app)

    r.app.resize(120, 40)
    const afterResize = await r.app.render()
    expect(afterResize.cells).toBe(120 * 40)

    await settle(r.app)
    const next = await r.app.render()
    expect(next.cells).toBeLessThan(120 * 40)
  })
})

describe('hidden panes', () => {
  // Criterion 8, as a mechanism rather than a stopwatch.
  it('are never snapshotted or composed while hidden', async () => {
    const r = await startRig({ cols: 200, rows: 50 })
    const first = r.app.focusedSessionId as string
    const second = await r.app.split('horizontal')
    expect(second).not.toBeNull()
    await settle(r.app)

    // Both visible: both compose.
    expect((await r.app.render()).panesComposed).toBe(2)

    await r.app.setFocus(second as string)
    await r.app.setZoom(true)
    await settle(r.app)

    // Now make the hidden pane produce output, and keep rendering.
    await r.client.call('session.write', { id: first, data: 'hidden output\n'.repeat(50) })
    await sleep(200)

    let composed = 0
    let fetched = 0
    for (let i = 0; i < 8; i++) {
      const stats = await r.app.render()
      composed += stats.panesComposed
      fetched += stats.snapshotsFetched
      await sleep(25)
    }
    // Eight frames, one visible pane each, and not one snapshot pulled for the hidden one.
    expect(composed).toBe(8)
    expect(fetched).toBeLessThanOrEqual(1)
  })

  it('are brought up to date as soon as they become visible again', async () => {
    const r = await startRig({ cols: 200, rows: 50 })
    const first = r.app.focusedSessionId as string
    const second = await r.app.split('horizontal')
    await r.app.setFocus(second as string)
    await r.app.setZoom(true)
    await settle(r.app)

    await r.client.call('session.write', { id: first, data: 'missed-while-hidden\n' })
    await sleep(150)

    await r.app.setZoom(false)
    await settle(r.app)
    const stats = await r.app.render()
    expect(stats.panesComposed).toBe(2)
    // The output produced while it was hidden is on screen now, not lost.
    await settle(r.app)
  })

  it('still receives its output in the daemon while hidden', async () => {
    const r = await startRig({ cols: 200, rows: 50 })
    const first = r.app.focusedSessionId as string
    const second = await r.app.split('horizontal')
    await r.app.setFocus(second as string)
    await r.app.setZoom(true)
    await settle(r.app)

    await r.client.call('session.write', { id: first, data: 'parsed-anyway\n' })
    await sleep(200)

    // Hidden means "not rendered", not "not running": the daemon parsed it regardless.
    const { snapshot } = await r.client.call('session.snapshot', { id: first })
    const text = snapshot.lines.map((l) => l.runs.map((run) => run.text).join('')).join('\n')
    expect(text).toContain('parsed-anyway')
  })
})
