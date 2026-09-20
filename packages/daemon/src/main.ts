#!/usr/bin/env node
/**
 * `leap-chorusd` — the daemon entrypoint.
 *
 * Started detached (see adopt.ts), it owns every PTY and the terminal state behind them.
 * It writes one JSON readiness line to its log and then serves until told to stop.
 */

import { appendFileSync } from 'node:fs'
import { isEntrypoint } from './adopt.js'
import { isDaemonError } from './errors.js'
import { migrateLegacyDataRoot, resolveDaemonPaths } from './paths.js'
import { DaemonServer } from './socket.js'

interface Args {
  dataRoot?: string
  help: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--data-root') {
      const value = argv[i + 1]
      if (value !== undefined) {
        args.dataRoot = value
        i++
      }
    } else if (arg === '--help' || arg === '-h') {
      args.help = true
    }
  }
  return args
}

const USAGE = `leap-chorusd — leap-chorus terminal daemon

Usage: leap-chorusd [--data-root <path>]

Environment:
  LEAP_CHORUS_DATA_DIR   data root (default: $XDG_DATA_HOME/leap-chorus, else ~/.leap-chorus)
`

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }

  // Before resolving anything else: a pre-rename install has its session under the old
  // root, and leaving it there would strand it. See migrateLegacyDataRoot.
  const migration = migrateLegacyDataRoot(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot })

  const paths = resolveDaemonPaths(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot })

  const log = (line: Record<string, unknown>): void => {
    const entry = JSON.stringify({ time: new Date().toISOString(), pid: process.pid, ...line })
    try {
      appendFileSync(paths.logPath, `${entry}\n`, { mode: 0o600 })
    } catch {
      // A daemon that cannot write its log still has PTYs to serve.
    }
    // stdout is /dev/null when detached; useful when run in the foreground.
    process.stdout.write(`${entry}\n`)
  }

  if (migration !== null) {
    log({
      event: migration.moved ? 'data_root_migrated' : 'data_root_migration_skipped',
      from: migration.from,
      to: migration.to,
      ...(migration.reason === undefined ? {} : { reason: migration.reason })
    })
    if (!migration.moved) process.stderr.write(`data root not migrated: ${migration.reason ?? ''}\n`)
  }

  let server: DaemonServer
  try {
    server = await DaemonServer.start({
      paths,
      onShutdownRequested: () => {
        log({ event: 'shutdown_requested' })
        void stop('client-request')
      }
    })
  } catch (error) {
    if (isDaemonError(error)) {
      log({ event: 'startup_failed', code: error.code, message: error.message })
      process.stderr.write(`${error.code}: ${error.message}\n`)
      // 78 is EX_CONFIG: a supervisor should not restart into the same refusal.
      return 78
    }
    throw error
  }

  log({
    event: 'daemon_ready',
    protocolVersion: paths.protocolVersion,
    socketPath: paths.socketPath,
    dataRoot: paths.dataRoot,
    nodeVersion: process.version
  })

  let stopping: Promise<void> | null = null
  const stop = async (reason: string): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      log({ event: 'shutting_down', reason })
      await server.close(reason)
    })()
    return stopping
  }

  await new Promise<void>((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      void stop(signal).then(resolve)
    }
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    // When the last client disconnects the daemon keeps running: surviving a client
    // restart is the entire point. Only an explicit stop ends it.
    const done = (): void => resolve()
    process.once('beforeExit', done)
  })

  await stop('exit')
  return 0
}

// Run only when executed directly, not when imported by a test.
if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`leap-chorusd failed: ${String(error)}\n`)
      process.exitCode = 1
    })
}
