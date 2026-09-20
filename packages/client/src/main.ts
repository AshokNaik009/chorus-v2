#!/usr/bin/env node
/**
 * `leap-chorus` — the TUI client.
 *
 * Attach to the daemon (starting one if needed), open the terminal, and run the app until
 * the user quits. Quitting is not killing: `prefix d` detaches and leaves every session
 * running in the daemon, which is the whole point of the split.
 */

import { isEntrypoint } from '@leap-chorus/daemon'
import { Screen } from '@leap-chorus/tui'
import { DEFAULT_CONFIG, type Config } from '@leap-chorus/core'
import { attach } from './attach.js'
import { TuiApp } from './app.js'

const USAGE = `leap-chorus — terminal multiplexer client

Usage: leap-chorus [options] [--] [command [args...]]

Options:
  --data-root <path>   daemon data root (default: $LEAP_CHORUS_DATA_DIR, else ~/.leap-chorus)
  --config <path>      config file (default: $LEAP_CHORUS_CONFIG, else ~/.config/leap-chorus/config.toml)
  --cwd <path>         working directory for new panes
  --no-sync            never use synchronized output, even if the terminal supports it
  --no-mouse           do not ask the terminal for mouse reports
                       (hover highlighting is [general] mouse-hover in the config)
  -h, --help           this message

Commands:
  kill-server          stop the daemon and every pane it owns
  agent read <pane> [--source detection|viewport]
                       print the text detection runs against
  agent explain <pane> which rules fired, and the region each one saw
  agent reload-manifests [agent...]
                       re-read detection manifests without restarting anything

Keys (default prefix is Ctrl-B; every binding below is configurable under [keys]):
  C-b %   split left/right      C-b "   split top/bottom
  C-b h/j/k/l  move focus       C-b o   next pane
  C-b H/J/K/L  resize split     C-b { }  swap panes
  C-b z   zoom focused pane     C-b x   close focused pane
  C-b c   new tab               C-b n/p  next/previous tab
  C-b w   new workspace         C-b ( )  previous/next workspace
  C-b s   toggle the sidebar    C-b PgUp/PgDn/End  scroll this pane
  C-b r   force repaint         C-b R   reload the config
  C-b d   detach (sessions keep running)
  C-b q   quit
  C-b C-b sends a literal Ctrl-B
`

interface Options {
  dataRoot?: string
  configPath?: string
  cwd?: string
  noSync: boolean
  noMouse: boolean
  killServer: boolean
  agent?: { verb: string; paneId: string | undefined; rest: string[] }
  help: boolean
  command?: string
  args: string[]
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = { noSync: false, noMouse: false, killServer: false, help: false, args: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      const rest = argv.slice(i + 1)
      if (rest.length > 0) {
        options.command = rest[0] as string
        options.args = rest.slice(1) as string[]
      }
      break
    }
    if (arg === '--data-root') {
      const value = argv[i + 1]
      if (value !== undefined) {
        options.dataRoot = value
        i++
      }
    } else if (arg === '--config') {
      const value = argv[i + 1]
      if (value !== undefined) {
        options.configPath = value
        i++
      }
    } else if (arg === '--cwd') {
      const value = argv[i + 1]
      if (value !== undefined) {
        options.cwd = value
        i++
      }
    } else if (arg === '--no-sync') {
      options.noSync = true
    } else if (arg === '--no-mouse') {
      options.noMouse = true
    } else if (arg === 'kill-server' || arg === '--kill-server') {
      // tmux's name for it, as a subcommand or a flag, because muscle memory will
      // try both.
      options.killServer = true
    } else if (arg === 'agent') {
      // `agent <verb> [pane]`: the detection development loop. Everything after is
      // its own, so the pane id is not mistaken for a command to run in a pane.
      options.agent = { verb: argv[i + 1] ?? '', paneId: argv[i + 2], rest: argv.slice(i + 3) as string[] }
      break
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg !== undefined && !arg.startsWith('-')) {
      options.command = arg
      options.args = argv.slice(i + 1) as string[]
      break
    }
  }
  return options
}

/**
 * Stop the running daemon.
 *
 * Detaching leaves the daemon and its PTYs running — that is the whole point of the
 * architecture — but until now there was no way to stop one short of `pkill`. A
 * background process a user cannot turn off is a bug however deliberate its lifetime
 * is, and this was found the obvious way: by leaving one running for 75 minutes.
 *
 * `noSpawn` is the important part. Without it, asking to kill a daemon that is not
 * running would *start* one and then kill it.
 */
async function killServer(options: Options): Promise<number> {
  let attachment
  try {
    attachment = await attach({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      noSpawn: true,
      clientName: 'leap-chorus-kill'
    })
  } catch {
    process.stdout.write('no daemon is running\n')
    return 0
  }
  const { client, daemon } = attachment
  try {
    await client.call('daemon.shutdown', {})
    process.stdout.write(`stopped the daemon (pid ${daemon.pid})\n`)
    return 0
  } catch (error) {
    process.stderr.write(`could not stop the daemon: ${String(error)}\n`)
    return 1
  } finally {
    client.close()
  }
}

/**
 * The detection development loop, on the command line.
 *
 * `read` / `explain` / `reload-manifests` are what make a manifest better than
 * hard-coded matching: a rule that has gone stale can be seen, edited and reloaded
 * against a live pane without restarting the daemon or losing the session. They are
 * thin wrappers over the API methods of the same name, which is the point — a script
 * can do everything this can.
 */
async function agentCommand(
  options: Options,
  request: { verb: string; paneId: string | undefined; rest: string[] }
): Promise<number> {
  const requiresPane = request.verb === 'read' || request.verb === 'explain'
  if (requiresPane && (request.paneId === undefined || request.paneId.length === 0)) {
    process.stderr.write(`leap-chorus agent ${request.verb} needs a pane id\n`)
    return 2
  }

  let attachment
  try {
    attachment = await attach({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      // Never start a daemon to answer a question about panes it would not have.
      noSpawn: true,
      clientName: 'leap-chorus-agent'
    })
  } catch {
    process.stderr.write('no daemon is running\n')
    return 1
  }

  const { client } = attachment
  try {
    const paneId = request.paneId as string
    switch (request.verb) {
      case 'read': {
        const sourceIndex = request.rest.indexOf('--source')
        const source = sourceIndex === -1 ? undefined : request.rest[sourceIndex + 1]
        const result = await client.call('agent.read', {
          paneId,
          ...(source === 'viewport' || source === 'detection' ? { source } : {})
        })
        process.stdout.write(`${result.text}\n`)
        if (result.oscTitle.length > 0) process.stderr.write(`osc_title: ${result.oscTitle}\n`)
        return 0
      }
      case 'explain': {
        // JSON, because the consumer is either a human reading one field or a script.
        process.stdout.write(`${JSON.stringify(await client.call('agent.explain', { paneId }), null, 2)}\n`)
        return 0
      }
      case 'reload-manifests': {
        const agents = [request.paneId, ...request.rest].filter(
          (value): value is string => value !== undefined && !value.startsWith('-')
        )
        const result = await client.call('agent.reload_manifests', agents.length > 0 ? { agents } : {})
        for (const entry of result.manifests) {
          const warning = entry.warning === null ? '' : `  (${entry.warning})`
          process.stdout.write(`${entry.agent}\t${entry.source}\t${entry.version ?? '-'}${warning}\n`)
        }
        return 0
      }
      default:
        process.stderr.write(`unknown agent command: ${request.verb}\n`)
        return 2
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return 1
  } finally {
    client.close()
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  if (options.killServer) return killServer(options)
  if (options.agent !== undefined) return agentCommand(options, options.agent)

  const { client } = await attach(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot })

  // The config is read before the terminal is put in raw mode, because one of the
  // things it decides is whether to ask the terminal for mouse reports — and asking
  // and then changing our mind would leave the outer terminal in a mode we are not
  // reading. `--config` is passed to the *daemon*, which owns the file: the client
  // never reads it directly, so an SSH client in phase 6 needs no filesystem access.
  let config: Config = DEFAULT_CONFIG
  if (options.configPath !== undefined) {
    await client.call('server.reload_config', { path: options.configPath }).catch(() => null)
  }
  const loaded = await client.call('config.get', {}).catch(() => null)
  if (loaded !== null) config = loaded.config as Config

  // Mouse and bracketed paste are asked for here, on the *outer* terminal, so the
  // decoder has reports to decode and a paste to recognize. Screen turns both off again
  // on every exit path.
  const screen = await Screen.open({
    mouse: !options.noMouse && config.general.mouse,
    mouseMotion: !options.noMouse && config.general.mouse && config.general.mouseHover,
    bracketedPaste: true,
    ...(options.noSync ? { synchronizedOutput: false } : {})
  })

  let exitReason: string | null = null
  let resolveExit: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  const app = await TuiApp.start({
    client,
    cols: screen.cols,
    rows: screen.rows,
    write: (data) => screen.write(data),
    synchronizedOutput: screen.synchronizedOutput,
    config,
    ...(options.command === undefined ? {} : { command: options.command }),
    ...(options.args.length === 0 ? {} : { args: options.args }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    onExit: (reason) => {
      if (exitReason !== null) return
      exitReason = reason
      resolveExit?.()
    }
  })

  // onInput, not on('input'): it replays anything typed during the terminal probe.
  screen.onInput((data) => app.handleInput(data))
  screen.on('resize', (cols, rows) => app.resize(cols, rows))

  await finished

  // `quit` tears the sessions down; `detach` deliberately does not.
  if (exitReason === 'quit') await app.killAll()
  await app.close()
  screen.close()
  client.close()
  process.stdout.write(`${exitReason ?? 'exited'}\n`)
  return 0
}

if (isEntrypoint(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error: unknown) => {
      process.stderr.write(`leap-chorus: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
