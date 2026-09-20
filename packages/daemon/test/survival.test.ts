/**
 * Criterion 4 — the survival test. This is the phase.
 *
 * If a client can die and be replaced while its PTYs keep running, the architecture
 * holds and live updates never need `SCM_RIGHTS` fd passing. If it cannot, nothing later
 * in this project matters.
 *
 * Criterion 9 — detachment — is the same claim one level up: the process that *launched*
 * the daemon dies, and the daemon and its PTYs are still there.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { isProcessAlive } from '../src/lock.js'
import { probeDaemon } from '../src/adopt.js'
import { snapshotToText } from '../src/snapshot.js'
import {
  cleanupDataRoots,
  connectTo,
  spawnClientProcess,
  startDetachedDaemon,
  testPaths,
  waitUntil,
  type DaemonHandle
} from './harness.js'

const daemons: DaemonHandle[] = []
const killedPids: number[] = []

afterEach(async () => {
  while (daemons.length > 0) {
    const daemon = daemons.pop()
    if (daemon) await daemon.stop()
  }
  for (const pid of killedPids.splice(0)) {
    try {
      if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
  cleanupDataRoots()
})

/**
 * A client that creates a session, leaves a marker on its screen, reports what it made,
 * and then stays attached forever waiting to be killed.
 */
const LONG_LIVED_CLIENT = `
const { DaemonClient, resolveDaemonPaths, snapshotToText } = await import(process.env.LEAP_CHORUS_DAEMON_MODULE)
const paths = resolveDaemonPaths({ dataRoot: process.argv[1] })
const marker = process.argv[2]
const { client } = await DaemonClient.connect({ socketPath: paths.socketPath, clientName: 'long-lived-client' })
const { session } = await client.call('session.create', {
  cols: 80,
  rows: 24,
  command: '/bin/bash',
  args: ['--norc', '--noprofile']
})
// Split so the tty's echo of the command does not look like the command's output.
const cut = Math.floor(marker.length / 2)
await client.call('session.write', {
  id: session.id,
  data: 'echo "' + marker.slice(0, cut) + '""' + marker.slice(cut) + '"\\n'
})
const deadline = Date.now() + 15000
let seen = false
while (Date.now() < deadline && !seen) {
  const { snapshot } = await client.call('session.snapshot', { id: session.id })
  seen = snapshotToText(snapshot).includes(marker)
  if (!seen) await new Promise((r) => setTimeout(r, 25))
}
if (!seen) {
  process.stderr.write('marker never appeared\\n')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ id: session.id, pid: session.pid }) + '\\n')
// Stay attached. The test kills this process; it must never exit on its own.
setInterval(() => {}, 1000)
`

async function firstJsonLine(child: ReturnType<typeof spawnClientProcess>, what: string): Promise<{ id: string; pid: number }> {
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  await waitUntil(() => stdout.includes('\n'), `${what} printed nothing. stderr:\n${stderr}`, 20_000)
  const line = stdout.split('\n')[0] as string
  return JSON.parse(line) as { id: string; pid: number }
}

describe('survival (criterion 4)', () => {
  it('keeps the pty and its screen when the client is killed and replaced', async () => {
    const daemon = await startDetachedDaemon()
    daemons.push(daemon)

    const marker = `survive-${Math.random().toString(16).slice(2, 10)}`
    const client = spawnClientProcess(daemon.paths, LONG_LIVED_CLIENT, [marker])
    killedPids.push(client.pid as number)
    const created = await firstJsonLine(client, 'the long-lived client')
    expect(created.pid).toBeGreaterThan(0)
    expect(isProcessAlive(created.pid)).toBe(true)

    // Kill the client — not the daemon, not the pty child. SIGKILL so it gets no chance
    // to shut anything down politely.
    process.kill(client.pid as number, 'SIGKILL')
    await waitUntil(() => !isProcessAlive(client.pid as number), 'the client did not die')

    // A brand-new client adopts the same running daemon.
    const { client: successor, daemon: info } = await connectTo(daemon.paths, 'successor')
    try {
      expect(info.pid).toBe(daemon.pid)

      const { session } = await successor.call('session.get', { id: created.id })
      expect(session.alive).toBe(true)
      // Same process, not a respawn.
      expect(session.pid).toBe(created.pid)
      expect(isProcessAlive(created.pid)).toBe(true)

      // And the screen the dead client saw is still there.
      const { snapshot } = await successor.call('session.snapshot', { id: created.id })
      expect(snapshotToText(snapshot)).toContain(marker)

      // The surviving pty is still usable, not merely readable.
      const second = `after-${Math.random().toString(16).slice(2, 10)}`
      const cut = Math.floor(second.length / 2)
      await successor.call('session.write', {
        id: created.id,
        data: `echo "${second.slice(0, cut)}""${second.slice(cut)}"\n`
      })
      await waitUntil(async () => {
        const { snapshot: latest } = await successor.call('session.snapshot', { id: created.id })
        return snapshotToText(latest).includes(second)
      }, 'the surviving pty did not answer the new client')
    } finally {
      successor.close()
    }
  })
})

describe('detachment (criterion 9)', () => {
  it('survives SIGKILL of the process that launched it', async () => {
    const paths = testPaths()

    // A launcher: starts the daemon, makes a session, reports, then waits to be killed.
    const launcher = spawnClientProcess(
      paths,
      `
      const { ensureDaemon, DaemonClient, resolveDaemonPaths, snapshotToText } = await import(process.env.LEAP_CHORUS_DAEMON_MODULE)
      const paths = resolveDaemonPaths({ dataRoot: process.argv[1] })
      const marker = process.argv[2]
      const info = await ensureDaemon({ paths })
      const { client } = await DaemonClient.connect({ socketPath: paths.socketPath, clientName: 'launcher' })
      const { session } = await client.call('session.create', {
        cols: 80, rows: 24, command: '/bin/bash', args: ['--norc', '--noprofile']
      })
      const cut = Math.floor(marker.length / 2)
      await client.call('session.write', {
        id: session.id,
        data: 'echo "' + marker.slice(0, cut) + '""' + marker.slice(cut) + '"\\n'
      })
      const deadline = Date.now() + 15000
      let seen = false
      while (Date.now() < deadline && !seen) {
        const { snapshot } = await client.call('session.snapshot', { id: session.id })
        seen = snapshotToText(snapshot).includes(marker)
        if (!seen) await new Promise((r) => setTimeout(r, 25))
      }
      process.stdout.write(JSON.stringify({ id: session.id, pid: session.pid, daemonPid: info.pid, seen }) + '\\n')
      setInterval(() => {}, 1000)
      `,
      [`launched-${Math.random().toString(16).slice(2, 10)}`]
    )
    killedPids.push(launcher.pid as number)

    let stdout = ''
    launcher.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    let stderr = ''
    launcher.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    await waitUntil(() => stdout.includes('\n'), `the launcher printed nothing. stderr:\n${stderr}`, 20_000)
    const created = JSON.parse(stdout.split('\n')[0] as string) as {
      id: string
      pid: number
      daemonPid: number
      seen: boolean
    }
    expect(created.seen).toBe(true)
    daemons.push({
      paths,
      pid: created.daemonPid,
      stop: async () => {
        try {
          process.kill(created.daemonPid, 'SIGTERM')
        } catch {
          // Already gone.
        }
      }
    })

    // Kill the launcher outright. Not the daemon; not the pty child.
    process.kill(launcher.pid as number, 'SIGKILL')
    await waitUntil(() => !isProcessAlive(launcher.pid as number), 'the launcher did not die')

    // The daemon is a different process in a different process group, so it is untouched.
    expect(created.daemonPid).not.toBe(launcher.pid)
    expect(isProcessAlive(created.daemonPid)).toBe(true)
    expect(isProcessAlive(created.pid)).toBe(true)

    // The endpoint still accepts connections, and the session is intact.
    const info = await probeDaemon(paths)
    expect(info?.pid).toBe(created.daemonPid)

    const { client } = await connectTo(paths, 'post-launcher-death')
    try {
      const { session } = await client.call('session.get', { id: created.id })
      expect(session.alive).toBe(true)
      expect(session.pid).toBe(created.pid)
    } finally {
      client.close()
    }
  })
})
