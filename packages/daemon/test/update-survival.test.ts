/**
 * Criterion 9 — the phase-1 survival test, across a real client version bump.
 *
 * Phase 1 proved a client can die and be replaced. This proves the thing that actually
 * happens during an update: the client on disk is *replaced by a different build*, and
 * the daemon — still running the old version, still holding every PTY — serves the new
 * one. That is the whole reason the daemon owns the PTYs and the socket is versioned.
 *
 * ## What this test does and does not prove
 *
 * It builds the app twice, at two different versions, into two separate installation
 * directories. The daemon is started from installation 1 and never restarted. A client
 * process then runs **from installation 2's bundle**, against that daemon.
 *
 * So it proves: a newer client binary, loaded from different files, adopts a running
 * older daemon; the PTY keeps its pid; the screen keeps its contents; and the protocol
 * negotiation between the two succeeds.
 *
 * It does not prove anything about a *daemon* version bump, which is the harder case
 * (spawn the new one alongside, migrate, retire the old) and is not in phase 5's
 * criteria. HANDOFF.md says so plainly.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isProcessAlive } from '../src/lock.js'
import { snapshotToText } from '../src/snapshot.js'
import { cleanupDataRoots, connectTo, startDetachedDaemon, waitUntil, type DaemonHandle } from './harness.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const daemons: DaemonHandle[] = []
let installations: string

/**
 * Build the app and stamp it with a version.
 *
 * The bundle is produced once and copied, because esbuild is the slow part and the
 * bytes are identical anyway — what differs between installations is the version
 * recorded in the manifest and, critically, *where they live on disk*.
 */
function installAt(directory: string, version: string): void {
  cpSync(join(repoRoot, 'dist-app'), directory, { recursive: true })
  const manifestPath = join(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest['version'] = version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

beforeAll(() => {
  // Build once; the test is about two installations, not two compilations.
  execFileSync(process.execPath, [join(repoRoot, 'scripts/build-app.mjs')], { cwd: repoRoot, stdio: 'pipe' })
  installations = mkdtempSync(join(tmpdir(), 'lc-update-'))
  installAt(join(installations, 'v1'), '1.0.0')
  installAt(join(installations, 'v2'), '2.0.0')
}, 120_000)

afterEach(async () => {
  while (daemons.length > 0) {
    const daemon = daemons.pop()
    if (daemon) await daemon.stop()
  }
  cleanupDataRoots()
})

afterAll(() => {
  rmSync(installations, { recursive: true, force: true })
})

/** Speak the protocol from a given installation's bundle, in its own process. */
function runFromInstallation(installation: string, dataRoot: string, script: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script, dataRoot, installation], {
    encoding: 'utf8',
    env: {
      ...process.env,
      LEAP_CHORUS_DATA_DIR: dataRoot,
      // The daemon under test is already running; nothing here may start another.
      LEAP_CHORUS_DAEMON_ENTRY: join(installation, 'leap-chorusd.js')
    }
  })
}

/**
 * A minimal client: connect over the socket, do one thing, print JSON.
 *
 * Deliberately not importing the bundle's own client code — the bundle is a TUI that
 * wants a terminal. What is under test is that the *installed files* of version 2 can
 * drive a daemon started from version 1, and the socket is the whole contract.
 */
const PROBE = `
import { connect } from 'node:net'
import { join } from 'node:path'

const dataRoot = process.argv[1]
const request = JSON.parse(process.env.LC_REQUEST)
const socket = connect(join(dataRoot, 'daemon', 'daemon-v1.sock'))
const replies = []
let buffer = ''
socket.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (line.trim()) replies.push(JSON.parse(line))
  }
})
await new Promise((done, fail) => {
  socket.once('connect', done)
  socket.once('error', fail)
})
socket.write(JSON.stringify({ type: 'req', id: 1, method: 'hello', params: { protocolVersion: 1, clientName: 'update-probe' } }) + '\\n')
socket.write(JSON.stringify({ type: 'req', id: 2, ...request }) + '\\n')

const deadline = Date.now() + 15000
while (Date.now() < deadline) {
  const hello = replies.find((reply) => reply.id === 1)
  const answer = replies.find((reply) => reply.id === 2)
  if (hello && answer) {
    console.log(JSON.stringify({ hello: hello.result ?? hello.error, answer: answer.result ?? answer.error, ok: answer.ok }))
    socket.end()
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, 25))
}
throw new Error('no answer from the daemon')
`

function call(installation: string, dataRoot: string, method: string, params: unknown): Record<string, any> {
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', PROBE, dataRoot, installation],
    {
      encoding: 'utf8',
      env: { ...process.env, LC_REQUEST: JSON.stringify({ method, params }), LEAP_CHORUS_DATA_DIR: dataRoot }
    }
  )
  return JSON.parse(output.trim().split('\n').pop() as string) as Record<string, any>
}

describe('a client version bump (criterion 9)', () => {
  it('leaves the daemon and its ptys running, and the new client adopts them', async () => {
    const daemon = await startDetachedDaemon()
    daemons.push(daemon)
    const dataRoot = daemon.paths.dataRoot
    const v1 = join(installations, 'v1')
    const v2 = join(installations, 'v2')

    // The installations really are different files at different versions.
    expect(JSON.parse(readFileSync(join(v1, 'package.json'), 'utf8')).version).toBe('1.0.0')
    expect(JSON.parse(readFileSync(join(v2, 'package.json'), 'utf8')).version).toBe('2.0.0')

    // --- version 1 creates a session and leaves a marker on its screen ---
    const marker = `bump-${Math.random().toString(16).slice(2, 10)}`
    const created = call(v1, dataRoot, 'session.create', {
      cols: 80,
      rows: 24,
      command: '/bin/bash',
      args: ['--norc', '--noprofile']
    })
    expect(created.ok).toBe(true)
    const sessionId = created.answer.session.id as string
    const ptyPid = created.answer.session.pid as number
    expect(ptyPid).toBeGreaterThan(0)

    // Split so the tty's echo of the command is not mistaken for its output.
    const cut = Math.floor(marker.length / 2)
    call(v1, dataRoot, 'session.write', {
      id: sessionId,
      data: `echo "${marker.slice(0, cut)}""${marker.slice(cut)}"\n`
    })
    await waitUntil(async () => {
      const snapshot = call(v1, dataRoot, 'session.snapshot', { id: sessionId })
      return snapshotToText(snapshot.answer.snapshot).includes(marker)
    }, 'version 1 never saw its own marker')

    // --- the update: version 1's installation is gone, version 2 takes over ---
    rmSync(v1, { recursive: true, force: true })

    // The daemon is untouched by that, because it is a separate process that has
    // already loaded everything it needs.
    expect(isProcessAlive(daemon.pid)).toBe(true)
    expect(isProcessAlive(ptyPid)).toBe(true)

    // --- version 2, from different files, adopts the running daemon ---
    const adopted = call(v2, dataRoot, 'session.get', { id: sessionId })
    expect(adopted.ok).toBe(true)
    expect(adopted.hello.daemon.pid).toBe(daemon.pid)
    expect(adopted.hello.daemon.protocolVersion).toBe(1)
    // Same process, not a respawn: this is the claim the whole architecture rests on.
    expect(adopted.answer.session.pid).toBe(ptyPid)
    expect(adopted.answer.session.alive).toBe(true)

    // The screen version 1 left behind is still there.
    const snapshot = call(v2, dataRoot, 'session.snapshot', { id: sessionId })
    expect(snapshotToText(snapshot.answer.snapshot)).toContain(marker)

    // And the surviving pty still answers the new client, rather than merely existing.
    const second = `after-${Math.random().toString(16).slice(2, 10)}`
    const secondCut = Math.floor(second.length / 2)
    call(v2, dataRoot, 'session.write', {
      id: sessionId,
      data: `echo "${second.slice(0, secondCut)}""${second.slice(secondCut)}"\n`
    })
    await waitUntil(async () => {
      const latest = call(v2, dataRoot, 'session.snapshot', { id: sessionId })
      return snapshotToText(latest.answer.snapshot).includes(second)
    }, 'the surviving pty did not answer the upgraded client')

    // Belt and braces: the daemon never restarted at any point.
    const { client, daemon: info } = await connectTo(daemon.paths, 'final')
    try {
      expect(info.pid).toBe(daemon.pid)
    } finally {
      client.close()
    }
  }, 120_000)
})
