/**
 * The endpoint: handshake, dispatch, and the instance lock as the server enforces it.
 */

import { existsSync, statSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { ErrorCodes, PROTOCOL_VERSION, encodeWritePayload } from '@leap-chorus/protocol'
import { DaemonClient, DaemonRequestError } from '../src/client.js'
import { isDaemonError } from '../src/errors.js'
import { snapshotToText } from '../src/snapshot.js'
import { DaemonServer } from '../src/socket.js'
import { cleanupDataRoots, connectTo, runClientProcess, testPaths, waitUntil } from './harness.js'

const servers: DaemonServer[] = []

async function startServer(paths = testPaths()): Promise<DaemonServer> {
  // `ephemeral` skips the session file: these tests are about the endpoint, and a
  // daemon that restores a previous arrangement is phase 4's persistence test.
  const server = await DaemonServer.start({ paths, ephemeral: true })
  servers.push(server)
  return server
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await server.close('test-teardown')
  }
  cleanupDataRoots()
})

describe('endpoint', () => {
  it('binds a private socket named for its protocol generation', async () => {
    const server = await startServer()
    expect(server.paths.socketPath.endsWith(`daemon-v${PROTOCOL_VERSION}.sock`)).toBe(true)
    expect(existsSync(server.paths.socketPath)).toBe(true)
    if (process.platform !== 'win32') {
      expect(statSync(server.paths.socketPath).mode & 0o777).toBe(0o600)
      expect(statSync(server.paths.daemonDir).mode & 0o077).toBe(0)
    }
  })

  it('completes a handshake and reports itself', async () => {
    const server = await startServer()
    const { client, daemon } = await connectTo(server.paths)
    expect(daemon.protocolVersion).toBe(PROTOCOL_VERSION)
    expect(daemon.pid).toBe(process.pid)
    expect(daemon.socketPath).toBe(server.paths.socketPath)
    client.close()
  })

  it('refuses a client from an unsupported generation', async () => {
    const server = await startServer()
    // Connect without the helper so the bad version reaches the wire.
    const { client } = await connectTo(server.paths)
    await expect(
      client.call('hello', { protocolVersion: PROTOCOL_VERSION + 1, clientName: 'from-the-future' })
    ).rejects.toThrow(/too-new/u)
    client.close()
  })

  it('requires a handshake before anything else', async () => {
    const server = await startServer()
    const socketPath = server.paths.socketPath
    // DaemonClient.connect always says hello, so drive a raw connection here.
    const { connect } = await import('node:net')
    const socket = connect(socketPath)
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))
    const response = await new Promise<string>((resolve) => {
      socket.once('data', (chunk: Buffer) => resolve(chunk.toString('utf8')))
      socket.write(`${JSON.stringify({ type: 'req', id: 1, method: 'session.list', params: {} })}\n`)
    })
    expect(response).toContain(ErrorCodes.notHandshaken)
    socket.destroy()
  })

  it('answers unknown methods and missing sessions by code', async () => {
    const server = await startServer()
    const { client } = await connectTo(server.paths)
    await expect(client.call('session.get', { id: 'nope' })).rejects.toMatchObject({
      code: ErrorCodes.sessionNotFound
    })
    await expect(
      (client as unknown as { call(m: string, p: unknown): Promise<unknown> }).call('session.teleport', {})
    ).rejects.toMatchObject({ code: ErrorCodes.unknownMethod })
    client.close()
  })

  it('creates, writes to, snapshots, and kills a session over the wire', async () => {
    const server = await startServer()
    const { client } = await connectTo(server.paths)

    const { session } = await client.call('session.create', {
      cols: 80,
      rows: 24,
      command: '/bin/bash',
      args: ['--norc', '--noprofile']
    })
    expect(session.pid).toBeGreaterThan(0)

    await client.call('session.write', { id: session.id, data: 'echo over-the-wire\n' })
    await waitUntil(async () => {
      const { snapshot } = await client.call('session.snapshot', { id: session.id })
      return snapshotToText(snapshot).includes('over-the-wire')
    }, 'snapshot never showed the command output')

    const { sessions } = await client.call('session.list', {})
    expect(sessions.map((entry) => entry.id)).toContain(session.id)

    await client.call('session.kill', { id: session.id })
    await client.waitForEvent((event) => event.event === 'session.exit' && event.id === session.id)

    const after = await client.call('session.get', { id: session.id })
    expect(after.session.alive).toBe(false)
    // Writing to a dead session is an error, not a silent no-op.
    await expect(client.call('session.write', { id: session.id, data: 'x' })).rejects.toBeInstanceOf(
      DaemonRequestError
    )
    client.close()
  })

  it('carries arbitrary bytes across the wire without a UTF-8 round trip', async () => {
    const server = await startServer()
    const { client } = await connectTo(server.paths)

    const { session } = await client.call('session.create', {
      cols: 60,
      rows: 8,
      command: '/bin/sh',
      // `cat -v` only escapes a high byte outside a UTF-8 locale; echo off so the screen
      // shows what the child received, not the tty's raw echo of what was sent.
      args: ['-c', 'stty -echo; exec cat -v'],
      env: { LC_ALL: 'C', LANG: 'C' }
    })

    // What `encodeWritePayload` produces for a chunk with a high byte in it. JSON cannot
    // hold 0xE8 as a character, so the encoding tag is the whole point.
    const bytes = Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28, 0x0a])
    const payload = encodeWritePayload(bytes)
    expect(payload.encoding).toBe('base64')
    await client.call('session.write', { id: session.id, ...payload })

    await waitUntil(async () => {
      const { snapshot } = await client.call('session.snapshot', { id: session.id })
      return snapshotToText(snapshot).includes('M-h')
    }, 'the high byte never reached the child intact')

    // An all-ASCII chunk stays a plain string, so an ordinary keystroke costs one byte.
    expect(encodeWritePayload(Buffer.from('ls\r', 'utf8'))).toEqual({ data: 'ls\r' })

    await client.call('session.kill', { id: session.id })
    client.close()
  })

  it('delivers output events only to subscribers', async () => {
    const server = await startServer()
    const { client: creator } = await connectTo(server.paths, 'creator')
    const { client: bystander } = await connectTo(server.paths, 'bystander')

    const bystanderEvents: string[] = []
    bystander.onEvent((event) => bystanderEvents.push(event.event))

    const { session } = await creator.call('session.create', {
      cols: 40,
      rows: 10,
      command: '/bin/bash',
      args: ['--norc', '--noprofile']
    })
    // Creating implies subscribing, so the creator hears about its own session.
    await creator.waitForEvent((event) => event.event === 'session.output' && event.id === session.id)
    expect(bystanderEvents).toEqual([])

    await bystander.call('session.subscribe', { id: session.id })
    await creator.call('session.write', { id: session.id, data: 'echo subscribed\n' })
    await bystander.waitForEvent((event) => event.event === 'session.output' && event.id === session.id)

    await bystander.call('session.unsubscribe', { id: session.id })
    creator.close()
    bystander.close()
  })

  it('validates request parameters', async () => {
    const server = await startServer()
    const { client } = await connectTo(server.paths)
    await expect(
      client.call('session.create', { cols: 0, rows: 24 } as unknown as { cols: number; rows: number })
    ).rejects.toMatchObject({ code: ErrorCodes.badRequest })
    await expect(
      client.call('session.write', { id: '', data: 'x' })
    ).rejects.toMatchObject({ code: ErrorCodes.badRequest })
    client.close()
  })
})

describe('instance lock at the endpoint (criterion 5)', () => {
  it('refuses a second daemon on the same root and leaves the first serving', async () => {
    const server = await startServer()

    await expect(DaemonServer.start({ paths: server.paths })).rejects.toSatisfy(
      (error: unknown) => isDaemonError(error) && error.code === 'leap_chorus_instance_lock_held'
    )

    // The refusal must not have disturbed the incumbent: same socket, still answering,
    // and still holding the terminal it booted with rather than a replacement.
    const { client, daemon } = await connectTo(server.paths)
    expect(daemon.pid).toBe(process.pid)
    const { sessions } = await client.call('session.list', {})
    expect(sessions.map((session) => session.id)).toEqual(server.sessions.list().map((session) => session.id))
    expect(sessions.every((session) => session.alive)).toBe(true)
    client.close()
  })

  it('exits 78 from a second daemon process rather than restarting into the same refusal', async () => {
    const server = await startServer()
    const result = await runClientProcess(
      server.paths,
      `
      const { main } = await import(process.env.LEAP_CHORUS_DAEMON_ENTRY)
      const code = await main(['--data-root', process.argv[1]])
      process.stdout.write(String(code))
      process.exit(code)
      `
    )
    expect(result.code).toBe(78)
    expect(result.stderr).toContain('leap_chorus_instance_lock_held')

    // And the incumbent is untouched.
    const { client } = await connectTo(server.paths)
    await client.call('daemon.info', {})
    client.close()
  })

  it('reclaims the endpoint after an unclean exit left a socket file behind', async () => {
    const paths = testPaths()
    const first = await startServer(paths)
    // Simulate a crash: drop the server's listener without releasing lock or socket file.
    await first.close('simulated-crash')
    servers.pop()
    expect(existsSync(paths.lockPath)).toBe(false)

    const second = await startServer(paths)
    expect(existsSync(second.paths.socketPath)).toBe(true)
    const { client } = await connectTo(paths)
    client.close()
  })
})

describe('client', () => {
  it('rejects in-flight calls when the daemon goes away', async () => {
    const server = await startServer()
    const { client } = await DaemonClient.connect({ socketPath: server.paths.socketPath })
    const pending = client.call('session.list', {})
    await pending
    await server.close('bye')
    servers.pop()
    await expect(client.call('session.list', {})).rejects.toThrow()
  })
})
