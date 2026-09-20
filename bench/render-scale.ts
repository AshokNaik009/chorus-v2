#!/usr/bin/env node
/**
 * PHASE-2's benchmark: does the render path hold 15 panes inside a 16 ms frame?
 *
 * This is the last open architectural risk in the project, so the measurement is made
 * against the real thing — a detached daemon over a real unix socket, real PTYs running
 * real programs, and the real `TuiApp.render()`. The only substitution is the terminal
 * itself: frames go to a counting sink instead of a TTY, because writing to a terminal
 * measures the terminal.
 *
 * Geometry is pinned at 200x50 so a later run is comparable, and the per-pane cell
 * dimensions the layout produced are recorded alongside the numbers.
 *
 * Three timings are reported per scenario, because "frame time" is ambiguous here:
 *
 *   frame  = the whole of render(): snapshot round trips plus paint. What a user waits for.
 *   fetch  = the part spent waiting on the daemon.
 *   paint  = compose + diff + encode. This client's own code, and the part a rewrite
 *            would change.
 *
 * Run: node bench/dist/render-scale.js [--seconds N] [--out bench/RESULTS.md]
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DaemonClient,
  isProcessAlive,
  probeDaemon,
  resolveDaemonPaths,
  spawnDetachedDaemon,
  type DaemonPaths
} from '@leap-chorus/daemon'
import { TuiApp, innerOf } from '@leap-chorus/client'

/** PHASE-2 pins the outer terminal so runs stay comparable. */
const COLS = 200
const ROWS = 50
const TARGET_PANES = 15
const FRAME_BUDGET_MS = 16

/** A pane printing a line every 50 ms: roughly what a coding agent emits. */
const REALISTIC_COMMAND = ['/bin/sh', '-c', 'i=0; while :; do i=$((i+1)); echo "pane line $i .............................."; sleep 0.05; done']
/** A pane that never stops: the failure mode flow control exists for. */
const FLOOD_COMMAND = ['/bin/sh', '-c', 'yes "flood line ........................................"']

/**
 * The config every run uses, written into the run's own data root.
 *
 * Pinned rather than inherited for two reasons. The measurement has to be comparable
 * across machines, and whoever runs this has a `~/.config/leap-chorus/config.toml` of their
 * own. And PHASE-4 criterion 7 asks specifically for the *full* UI — sidebar and tab
 * bar drawn — because that is where render cost creeps in, so the run states that it
 * is on rather than depending on a default staying true.
 */
const BENCH_CONFIG = `[ui]
sidebar = true
sidebar-width = 22
tab-bar = true
status-bar = true

[general]
mouse = false
`

interface Sample {
  frameMs: number
  fetchMs: number
  paintMs: number
  bytes: number
  cells: number
  snapshots: number
  composed: number
}

export interface ScenarioResult {
  readonly name: string
  readonly panes: number
  readonly visiblePanes: number
  readonly paneCells: string
  readonly frames: number
  readonly frameP50: number
  readonly frameP99: number
  readonly fetchP50: number
  readonly fetchP99: number
  readonly paintP50: number
  readonly paintP99: number
  readonly snapshotsPerFrame: number
  readonly composedPerFrame: number
  readonly cellsPerFrame: number
  readonly bytesPerFrameMean: number
  readonly bytesPerSecond: number
  readonly wireBytesPerSecond: number
  readonly cpuPercent: number
  readonly clientRssMiB: number
  readonly daemonRssMiB: number
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] as number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

function rssMiB(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    const kib = Number.parseInt(out, 10)
    return Number.isFinite(kib) ? kib / 1024 : 0
  } catch {
    return 0
  }
}

interface Rig {
  readonly app: TuiApp
  readonly client: DaemonClient
  readonly paths: DaemonPaths
  readonly daemonPid: number
  readonly dataRoot: string
  bytesWritten: number
  stop(): Promise<void>
}

async function startRig(command: readonly string[], panes: number): Promise<Rig> {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hrb-'))
  const paths = resolveDaemonPaths({ dataRoot })
  const configPath = join(dataRoot, 'config.toml')
  writeFileSync(configPath, BENCH_CONFIG)
  const daemonPid = spawnDetachedDaemon({ paths, env: { ...process.env, LEAP_CHORUS_CONFIG: configPath } })

  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && (await probeDaemon(paths)) === null) await sleep(25)

  const { client } = await DaemonClient.connect({ socketPath: paths.socketPath, clientName: 'leap-chorus-bench' })

  const state = { bytesWritten: 0 }
  const app = await TuiApp.start({
    client,
    cols: COLS,
    rows: ROWS,
    write: (data) => {
      state.bytesWritten += Buffer.byteLength(data, 'utf8')
    },
    command: command[0] as string,
    args: command.slice(1),
    // The status bar is one row of the app's own chrome; leave it on, it is part of a frame.
    statusBar: true,
    // The measurement loop below drives every frame. The app must not also render on its
    // own timer, or half the work would happen outside the samples.
    autoRender: false
  })

  // Grow to `panes` by repeatedly splitting whichever pane currently has the most room.
  // That produces the balanced grid a real 15-pane workspace would have, rather than a
  // degenerate spine of slivers.
  while (app.paneCount < panes) {
    let best: { id: string; area: number; direction: 'horizontal' | 'vertical' } | null = null
    for (const id of app.paneIds()) {
      const r = app.rectOf(id)
      if (!r) continue
      // Cells are about twice as tall as they are wide, so compare width/2 to height
      // when deciding which way to cut.
      const direction = r.width / 2 >= r.height ? 'horizontal' : 'vertical'
      const area = r.width * r.height
      if (best === null || area > best.area) best = { id, area, direction }
    }
    if (!best) break
    await app.setFocus(best.id)
    const created = await app.split(best.direction)
    if (created === null) break
  }

  const rig: Rig = {
    app,
    client,
    paths,
    daemonPid,
    dataRoot,
    get bytesWritten() {
      return state.bytesWritten
    },
    set bytesWritten(value: number) {
      state.bytesWritten = value
    },
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
      if (isProcessAlive(daemonPid)) {
        try {
          process.kill(daemonPid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
      rmSync(dataRoot, { recursive: true, force: true })
    }
  }
  return rig
}

/** Describe the cell dimensions the layout actually produced, so a rerun is comparable. */
function paneCellSummary(app: TuiApp): string {
  const sizes = app
    .paneIds()
    .map((id) => app.rectOf(id))
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .map((r) => {
      const inner = innerOf(r)
      return `${inner.width}x${inner.height}`
    })
  const counts = new Map<string, number>()
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([size, count]) => (count === 1 ? size : `${count}x ${size}`))
    .join(', ')
}

async function measure(
  name: string,
  rig: Rig,
  options: { seconds: number; warmupSeconds: number; zoomed: boolean }
): Promise<ScenarioResult> {
  await rig.app.setZoom(options.zoomed)

  // Warm up: let the shells start, the JIT settle, and the first full repaint happen.
  const warmupEnd = Date.now() + options.warmupSeconds * 1000
  while (Date.now() < warmupEnd) {
    await rig.app.render()
    await sleep(FRAME_BUDGET_MS)
  }

  const samples: Sample[] = []
  const bytesAtStart = rig.bytesWritten
  const wireAtStart = rig.client.bytesReceived
  const cpuAtStart = process.cpuUsage()
  const startedAt = performance.now()
  const end = Date.now() + options.seconds * 1000

  while (Date.now() < end) {
    const tickStart = performance.now()
    const stats = await rig.app.render()
    samples.push({
      frameMs: stats.durationMs,
      fetchMs: stats.fetchMs,
      paintMs: stats.paintMs,
      bytes: stats.bytes,
      cells: stats.cells,
      snapshots: stats.snapshotsFetched,
      composed: stats.panesComposed
    })
    // Pace at the frame budget rather than spinning: measuring a busy loop would report
    // a throughput number dressed up as a latency one.
    await sleep(FRAME_BUDGET_MS - (performance.now() - tickStart))
  }

  const elapsedMs = performance.now() - startedAt
  const cpu = process.cpuUsage(cpuAtStart)
  const cpuPercent = ((cpu.user + cpu.system) / 1000 / elapsedMs) * 100

  const frames = samples.map((s) => s.frameMs).sort((a, b) => a - b)
  const fetches = samples.map((s) => s.fetchMs).sort((a, b) => a - b)
  const paints = samples.map((s) => s.paintMs).sort((a, b) => a - b)
  const totalBytes = rig.bytesWritten - bytesAtStart
  const wireBytes = rig.client.bytesReceived - wireAtStart

  const mean = (pick: (s: Sample) => number): number =>
    samples.length === 0 ? 0 : samples.reduce((total, s) => total + pick(s), 0) / samples.length

  return {
    name,
    panes: rig.app.paneCount,
    visiblePanes: rig.app.visiblePanes().length,
    paneCells: paneCellSummary(rig.app),
    frames: samples.length,
    frameP50: percentile(frames, 50),
    frameP99: percentile(frames, 99),
    fetchP50: percentile(fetches, 50),
    fetchP99: percentile(fetches, 99),
    paintP50: percentile(paints, 50),
    paintP99: percentile(paints, 99),
    snapshotsPerFrame: mean((s) => s.snapshots),
    composedPerFrame: mean((s) => s.composed),
    cellsPerFrame: mean((s) => s.cells),
    bytesPerFrameMean: samples.length === 0 ? 0 : totalBytes / samples.length,
    bytesPerSecond: (totalBytes / elapsedMs) * 1000,
    wireBytesPerSecond: (wireBytes / elapsedMs) * 1000,
    cpuPercent,
    clientRssMiB: process.memoryUsage().rss / 1024 / 1024,
    daemonRssMiB: rssMiB(rig.daemonPid)
  }
}

function fixed(value: number, digits = 2): string {
  return value.toFixed(digits)
}

function humanBytes(value: number): string {
  if (value >= 1024 * 1024) return `${fixed(value / 1024 / 1024, 1)} MiB`
  if (value >= 1024) return `${fixed(value / 1024, 1)} KiB`
  return `${Math.round(value)} B`
}

function report(results: readonly ScenarioResult[], seconds: number): string {
  const header = [
    '# bench/RESULTS.md — render scaling',
    '',
    'Generated by `node bench/dist/render-scale.js`. Every number below is measured, not',
    'estimated, and not rounded in our favour.',
    '',
    '## Conditions',
    '',
    `- Outer terminal pinned to **${COLS}x${ROWS}**; the per-pane cell dimensions each`,
    '  scenario produced are listed with it.',
    `- ${seconds}s sample window per scenario, after a warmup, paced at one frame per`,
    `  ${FRAME_BUDGET_MS} ms.`,
    '- Real detached daemon over a real unix socket, real PTYs. Frames go to a counting',
    '  sink rather than a TTY: writing to a terminal measures the terminal.',
    '- **Full UI drawn**: sidebar (22 columns), tab bar, status bar. PHASE-4 criterion 7',
    '  asks for this specifically, so the config is pinned in the benchmark rather than',
    '  inherited from whoever runs it. Panes therefore get 178 of the 200 columns and',
    '  48 of the 50 rows.',
    `- Node ${process.version}, ${process.platform}/${process.arch}.`,
    '',
    '## Timings',
    '',
    '`frame` is the whole of `render()` — snapshot round trips plus paint, which is what a',
    'user waits for. `fetch` is the part spent waiting on the daemon; `paint` is compose +',
    'diff + encode, this client\'s own code.',
    '',
    '| Scenario | Panes | Visible | Pane cells | frame p50 | frame p99 | fetch p50 | fetch p99 | paint p50 | paint p99 |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const r of results) {
    header.push(
      `| ${r.name} | ${r.panes} | ${r.visiblePanes} | ${r.paneCells} | ${fixed(r.frameP50)} ms | ${fixed(r.frameP99)} ms | ${fixed(r.fetchP50)} ms | ${fixed(r.fetchP99)} ms | ${fixed(r.paintP50)} ms | ${fixed(r.paintP99)} ms |`
    )
  }

  header.push(
    '',
    '## Cost',
    '',
    '| Scenario | Frames | Snapshots/frame | Panes composed | Cells repainted | Bytes/frame | To terminal | Daemon→client | CPU | Client RSS | Daemon RSS |',
    '|---|---|---|---|---|---|---|---|---|---|---|'
  )
  for (const r of results) {
    header.push(
      `| ${r.name} | ${r.frames} | ${fixed(r.snapshotsPerFrame, 1)} | ${fixed(r.composedPerFrame, 1)} | ${Math.round(r.cellsPerFrame)} | ${humanBytes(r.bytesPerFrameMean)} | ${humanBytes(r.bytesPerSecond)}/s | ${humanBytes(r.wireBytesPerSecond)}/s | ${fixed(r.cpuPercent, 1)}% | ${fixed(r.clientRssMiB, 1)} MiB | ${fixed(r.daemonRssMiB, 1)} MiB |`
    )
  }

  const fifteen = results.find((r) => r.name.startsWith('Realistic'))
  const stressVisible = results.find((r) => r.name === 'Stress, visible')
  const stressHidden = results.find((r) => r.name === 'Stress, 14 hidden')

  header.push('', '## Acceptance criteria', '')
  if (fifteen) {
    const verdict = fifteen.frameP99 < FRAME_BUDGET_MS ? 'PASS' : 'FAIL'
    header.push(
      `- **Criterion 7 — 15-pane p99 frame time under ${FRAME_BUDGET_MS} ms: ${verdict}.**`,
      `  Measured ${fixed(fifteen.frameP99)} ms at ${fifteen.paneCells}.`
    )
  }
  if (stressVisible && stressHidden) {
    // The decisive evidence is what the client *stopped doing*, not the clock. Both rows
    // run the same fifteen flooding PTYs in the same daemon; only visibility differs.
    const verdict =
      stressHidden.snapshotsPerFrame < stressVisible.snapshotsPerFrame * 0.5 &&
      stressHidden.bytesPerSecond < stressVisible.bytesPerSecond
        ? 'PASS'
        : 'FAIL'
    const snapshotRatio =
      stressHidden.snapshotsPerFrame === 0 ? Infinity : stressVisible.snapshotsPerFrame / stressHidden.snapshotsPerFrame
    const wireRatio =
      stressHidden.wireBytesPerSecond === 0 ? Infinity : stressVisible.wireBytesPerSecond / stressHidden.wireBytesPerSecond
    header.push(
      `- **Criterion 8 — hidden panes measurably cheaper: ${verdict}.**`,
      `  Same fifteen flooding PTYs in the same daemon either way; only visibility differs.`,
      `  Snapshots pulled per frame: ${fixed(stressVisible.snapshotsPerFrame, 1)} visible against`,
      `  ${fixed(stressHidden.snapshotsPerFrame, 1)} hidden` +
        (Number.isFinite(snapshotRatio) ? ` (${fixed(snapshotRatio, 1)}x).` : '.'),
      `  Bytes to the terminal: ${humanBytes(stressVisible.bytesPerSecond)}/s against`,
      `  ${humanBytes(stressHidden.bytesPerSecond)}/s. Daemon→client:`,
      `  ${humanBytes(stressVisible.wireBytesPerSecond)}/s against ${humanBytes(stressHidden.wireBytesPerSecond)}/s` +
        (Number.isFinite(wireRatio) ? ` (${fixed(wireRatio, 1)}x).` : '.'),
      '',
      `  Paint time moves less than those ratios — ${fixed(stressHidden.paintP50)} ms hidden`,
      `  against ${fixed(stressVisible.paintP50)} ms visible — and the reason is worth stating`,
      '  rather than hiding: hiding panes here means zooming, so the one surviving pane grows',
      `  from ${stressVisible.paneCells} to ${stressHidden.paneCells} and blits roughly as many`,
      '  cells as the fifteen small ones did. The saving the clock does show is the fourteen',
      '  snapshot round trips and the fourteen blits that no longer happen; what replaced them',
      '  is one bigger pane.'
    )
  }
  header.push('')
  return header.join('\n')
}

export async function run(options: { seconds?: number; out?: string } = {}): Promise<ScenarioResult[]> {
  const seconds = options.seconds ?? Number.parseInt(process.env['LEAP_CHORUS_BENCH_SECONDS'] ?? '10', 10)
  const results: ScenarioResult[] = []

  // 1. One pane, the baseline every other number is read against.
  {
    const rig = await startRig(REALISTIC_COMMAND, 1)
    try {
      results.push(await measure('Single active', rig, { seconds, warmupSeconds: 2, zoomed: false }))
    } finally {
      await rig.stop()
    }
  }

  // 2. Fifteen panes of ordinary agent-ish output. This is criterion 7.
  {
    const rig = await startRig(REALISTIC_COMMAND, TARGET_PANES)
    try {
      results.push(await measure(`Realistic ${TARGET_PANES}`, rig, { seconds, warmupSeconds: 3, zoomed: false }))
    } finally {
      await rig.stop()
    }
  }

  // 3. Fifteen panes all flooding, visible and then hidden. This is criterion 8: the same
  //    daemon, the same PTYs, the same output rate — only the visibility changes.
  {
    const rig = await startRig(FLOOD_COMMAND, TARGET_PANES)
    try {
      results.push(await measure('Stress, visible', rig, { seconds, warmupSeconds: 3, zoomed: false }))
      results.push(await measure('Stress, 14 hidden', rig, { seconds, warmupSeconds: 2, zoomed: true }))
    } finally {
      await rig.stop()
    }
  }

  const markdown = report(results, seconds)
  const out = options.out ?? process.env['LEAP_CHORUS_BENCH_OUT'] ?? new URL('../RESULTS.md', import.meta.url).pathname
  writeFileSync(out, markdown, 'utf8')
  process.stdout.write(`${markdown}\nWritten to ${out}\n`)
  return results
}

function parse(argv: readonly string[]): { seconds?: number; out?: string } {
  const options: { seconds?: number; out?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') {
      const value = Number.parseInt(argv[i + 1] ?? '', 10)
      if (Number.isFinite(value)) options.seconds = value
      i++
    } else if (argv[i] === '--out') {
      const value = argv[i + 1]
      if (value !== undefined) options.out = value
      i++
    }
  }
  return options
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  run(parse(process.argv.slice(2)))
    .then(() => {
      process.exit(0)
    })
    .catch((error: unknown) => {
      process.stderr.write(`render-scale: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
      process.exit(1)
    })
}
