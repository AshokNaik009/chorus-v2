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
import type { WireLayoutNode } from '@leap-chorus/protocol'
import { attach } from './attach.js'
import { TuiApp } from './app.js'
import { HerdrCompatError, translateHerdrArgv } from './compat.js'
import { pluginCommand } from './plugin-cli.js'

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
  pane list            every pane as JSON: id, cwd, agent, status, focus
  pane open [pane] [--right|--down] [--command <cmd>] [--cwd <dir>] [--no-focus]
                       split a pane and print the new pane's id
  pane focus <pane>    focus a pane
  pane zoom [pane] [--on|--off]
                       zoom a pane, or toggle when neither flag is given
  pane close <pane>    close a pane
  tab list             every tab as JSON: id, workspace, label, panes
  tab focus <tab>      focus a tab
  tab close <tab>      close a tab
  agent read <pane> [--source detection|viewport]
                       print the text detection runs against
  agent explain <pane> which rules fired, and the region each one saw
  agent reload-manifests [agent...]
                       re-read detection manifests without restarting anything
  plugin <command>     install and run herdr plugins ('plugin help' lists them)
  --compat herdr ...   run a herdr plugin command through the translation shim
                       (this is what $HERDR_BIN_PATH points at; it is not herdr)

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
  pane?: { verb: string; paneId: string | undefined; rest: string[] }
  tab?: { verb: string; tabId: string | undefined; rest: string[] }
  plugin?: { verb: string; rest: string[] }
  compat?: { flavour: string; rest: string[] }
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
    } else if (arg === 'pane') {
      // `pane <verb> [id] [flags]`. Same shape as `agent`: everything after belongs to
      // the subcommand, so an id is never mistaken for a program to run in a pane.
      options.pane = { verb: argv[i + 1] ?? '', paneId: argv[i + 2], rest: argv.slice(i + 3) as string[] }
      break
    } else if (arg === 'tab') {
      options.tab = { verb: argv[i + 1] ?? '', tabId: argv[i + 2], rest: argv.slice(i + 3) as string[] }
      break
    } else if (arg === 'plugin') {
      // Everything after belongs to the subcommand, for the same reason `pane` and
      // `agent` do: a plugin id must never be mistaken for a program to run in a pane.
      options.plugin = { verb: argv[i + 1] ?? '', rest: argv.slice(i + 2) as string[] }
      break
    } else if (arg === '--compat') {
      // `--compat herdr <herdr argv…>`. The flavour is explicit and checked, so a later
      // second flavour cannot silently inherit herdr's translation table.
      options.compat = { flavour: argv[i + 1] ?? '', rest: argv.slice(i + 2) as string[] }
      break
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

/** Every pane id in a wire layout, in draw order. */
function panesOf(node: WireLayoutNode): string[] {
  return node.type === 'pane' ? [node.paneId] : [...panesOf(node.first), ...panesOf(node.second)]
}

/**
 * Tab control from the command line.
 *
 * `tab focus` exists because a herdr plugin needs it: herdr-file-viewer's tab launcher
 * switches to an existing viewer tab rather than opening a second one, and it does that
 * with `herdr tab focus <tab_id>`. PHASE-10 counted five commands from reading the
 * plugin's description; the scripts use six.
 */
async function tabCommand(
  options: Options,
  request: { verb: string; tabId: string | undefined; rest: string[] }
): Promise<number> {
  if (request.verb === 'focus' && (request.tabId === undefined || request.tabId.length === 0)) {
    process.stderr.write('leap-chorus tab focus needs a tab id\n')
    return 2
  }

  let attachment
  try {
    attachment = await attach({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      noSpawn: true,
      clientName: 'leap-chorus-tab'
    })
  } catch {
    process.stderr.write('no daemon is running\n')
    return 1
  }

  const { client } = attachment
  try {
    switch (request.verb) {
      case 'list': {
        const { state } = await client.call('state.get', {})
        const tabs = state.tabs.map((tab) => ({
          tabId: tab.tabId,
          workspaceId: tab.workspaceId,
          number: tab.number,
          label: tab.label,
          focusedPaneId: tab.focusedPaneId,
          zoomed: tab.zoomed,
          paneIds: panesOf(tab.layout)
        }))
        process.stdout.write(`${JSON.stringify(tabs, null, 2)}\n`)
        return 0
      }
      case 'focus':
        await client.call('tab.focus', { tabId: request.tabId as string })
        return 0
      case 'close':
        await client.call('tab.close', { tabId: request.tabId as string })
        return 0
      default:
        process.stderr.write(`unknown tab command: ${request.verb}\n`)
        return 2
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return 1
  } finally {
    client.close()
  }
}

/**
 * Pane control from the command line.
 *
 * Thin wrappers over the RPCs the daemon already exposes, for the same reason the
 * `agent` verbs are: anything the TUI can do to a pane, a script — or an agent's hook,
 * or a plugin's launcher — should be able to do without a terminal attached.
 *
 * The shapes follow herdr's CLI (`pane list --json`, `pane zoom <id> --on`), because
 * tools written against herdr invoke exactly these and matching them costs nothing.
 */
async function paneCommand(
  options: Options,
  request: { verb: string; paneId: string | undefined; rest: string[] }
): Promise<number> {
  const needsPane = request.verb === 'close' || request.verb === 'focus'
  if (needsPane && (request.paneId === undefined || request.paneId.length === 0)) {
    process.stderr.write(`leap-chorus pane ${request.verb} needs a pane id\n`)
    return 2
  }

  let attachment
  try {
    attachment = await attach({
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
      // Never start a daemon to answer a question about panes it would not have.
      noSpawn: true,
      clientName: 'leap-chorus-pane'
    })
  } catch {
    process.stderr.write('no daemon is running\n')
    return 1
  }

  const { client } = attachment
  // `pane list --herdr-json` parks the flag in `paneId`, because the parser reserves
  // that slot positionally — the same reason `zoom` has to test `paneId.startsWith('-')`
  // below. Both places are searched, so a flag cannot be swallowed by a verb that takes
  // no id.
  const flag = (name: string): boolean => request.rest.includes(name) || request.paneId === name
  const value = (name: string): string | undefined => {
    const index = request.rest.indexOf(name)
    return index === -1 ? undefined : request.rest[index + 1]
  }

  try {
    switch (request.verb) {
      case 'list': {
        const { state } = await client.call('state.get', {})
        // Which tab and workspace a pane is in. Not in the first version of this
        // command, and a herdr plugin's launcher cannot work without it: the file
        // viewer decides focus-or-open by asking whether its own pane is in the *same
        // tab* as the focused one.
        const owner = new Map<string, { tabId: string; workspaceId: string }>()
        for (const tab of state.tabs) {
          for (const paneId of panesOf(tab.layout)) owner.set(paneId, { tabId: tab.tabId, workspaceId: tab.workspaceId })
        }
        // JSON is the only format worth promising a script. The human-readable form is
        // the sidebar, which is already better than anything printed here.
        const panes = state.panes.map((pane) => ({
          paneId: pane.paneId,
          number: pane.number,
          label: pane.label,
          title: pane.title,
          cwd: pane.cwd,
          exited: pane.exited,
          focused: pane.paneId === state.focusedPaneId,
          tabId: owner.get(pane.paneId)?.tabId ?? null,
          workspaceId: owner.get(pane.paneId)?.workspaceId ?? null,
          agent: pane.agent ?? null,
          agentStatus: pane.agentStatus ?? null
        }))
        // `--herdr-json` is the compatibility shape, and it exists because translating
        // a herdr plugin's *commands* turned out not to be enough: `herdr pane list`'s
        // output is part of the contract too. herdr-file-viewer pipes it straight into
        // its own Rust `launch_decision`, which deserializes
        // `{result:{panes:[{pane_id,label,focused,tab_id}]}}` and answers OPEN for
        // anything it cannot parse — so without this the plugin still works and can
        // never focus or close its own pane. Only the shim sets this flag.
        if (flag('--herdr-json')) {
          process.stdout.write(
            `${JSON.stringify(
              {
                result: {
                  panes: panes.map((pane) => ({
                    pane_id: pane.paneId,
                    label: pane.label,
                    title: pane.title,
                    focused: pane.focused,
                    tab_id: pane.tabId,
                    workspace_id: pane.workspaceId,
                    cwd: pane.cwd,
                    exited: pane.exited
                  }))
                }
              },
              null,
              2
            )}\n`
          )
          return 0
        }
        process.stdout.write(`${JSON.stringify(panes, null, 2)}\n`)
        return 0
      }
      case 'focus': {
        await client.call('pane.focus', { paneId: request.paneId as string })
        return 0
      }
      case 'close': {
        await client.call('pane.close', { paneId: request.paneId as string })
        return 0
      }
      case 'zoom': {
        // `--on`/`--off` rather than a bare toggle when asked for explicitly: a script
        // that zooms must be able to say which state it wants, not flip whatever it found.
        const mode = flag('--on') ? 'on' : flag('--off') ? 'off' : 'toggle'
        await client.call('pane.zoom', {
          ...(request.paneId === undefined || request.paneId.startsWith('-') ? {} : { paneId: request.paneId }),
          mode
        })
        return 0
      }
      case 'open': {
        // The pane id, if any, is the one to split; `--right`/`--down` place the new one.
        const direction = flag('--down') ? 'down' : 'right'
        const command = value('--command')
        const cwd = value('--cwd') ?? options.cwd
        const result = (await client.call('pane.split', {
          direction,
          focus: !flag('--no-focus'),
          ...(request.paneId === undefined || request.paneId.startsWith('-') ? {} : { targetPaneId: request.paneId }),
          ...(command === undefined ? {} : { command }),
          ...(cwd === undefined ? {} : { cwd })
        })) as { paneId?: string } | null
        // The new pane's id on stdout, so a caller can act on what it just made.
        if (result?.paneId !== undefined) process.stdout.write(`${result.paneId}\n`)
        return 0
      }
      default:
        process.stderr.write(`unknown pane command: ${request.verb}\n`)
        return 2
    }
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return 1
  } finally {
    client.close()
  }
}

/**
 * `--compat herdr` — run a herdr command line through the translation and then run us.
 *
 * Re-entering `main` with the translated argv rather than calling the handlers directly
 * is deliberate: a plugin's launcher then goes through exactly the same parsing,
 * attachment and error reporting a person typing the command would, so the shim cannot
 * develop its own behaviour by drifting out of step with the real path.
 */
async function compatCommand(options: Options, request: { flavour: string; rest: string[] }): Promise<number> {
  if (request.flavour !== 'herdr') {
    process.stderr.write(`unknown compatibility flavour: ${request.flavour || '(none)'}\n`)
    return 2
  }
  let translated
  try {
    translated = translateHerdrArgv(request.rest)
  } catch (error) {
    if (error instanceof HerdrCompatError) {
      process.stderr.write(`${error.message}\n`)
      return 2
    }
    throw error
  }
  for (const note of translated.notes) process.stderr.write(`herdr-compat: ${note}\n`)
  const prefix = options.dataRoot === undefined ? [] : ['--data-root', options.dataRoot]
  return main([...prefix, ...translated.argv])
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(USAGE)
    return 0
  }

  if (options.compat !== undefined) return compatCommand(options, options.compat)
  if (options.killServer) return killServer(options)
  if (options.agent !== undefined) return agentCommand(options, options.agent)
  if (options.pane !== undefined) return paneCommand(options, options.pane)
  if (options.tab !== undefined) return tabCommand(options, options.tab)
  if (options.plugin !== undefined) {
    return pluginCommand({
      verb: options.plugin.verb,
      rest: options.plugin.rest,
      ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot })
    })
  }

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
