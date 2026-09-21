/**
 * `leap-chorus --compat herdr` — the five commands a herdr plugin's launcher calls.
 *
 * PHASE-10's fourth decision, answered: **a binary named `herdr` that is not herdr will
 * confuse someone eventually, so we do not ship one.** `$HERDR_BIN_PATH` points at a
 * generated wrapper called `herdr-compat`, which is three lines of `sh` around this
 * flag. The mechanism is identical and nothing on the user's `PATH` is impersonated —
 * a plugin that runs `herdr` rather than `"$HERDR_BIN_PATH"` finds the user's real
 * herdr, or nothing, which is the truth either way.
 *
 * ## The five
 *
 * Investigating `herdr-file-viewer` on 2026-09-20 found it does not link against herdr
 * at all: its launcher scripts shell out to the binary found through `$HERDR_BIN_PATH`,
 * and they use exactly five commands.
 *
 * | herdr | here |
 * |---|---|
 * | `pane list --json` | `pane list --herdr-json` — see below |
 * | `pane zoom <id> --on\|--off` | the same |
 * | `pane close <id>` | the same |
 * | `plugin pane open --plugin ID --entrypoint ID …` | `plugin pane open` |
 * | `plugin config-dir <id>` | the same |
 *
 * **It is six, not five.** Reading `herdr-file-viewer`'s launcher scripts rather than
 * its description turned up `tab focus <tab_id>`, which its tab launcher uses to switch
 * to an existing viewer tab instead of opening a second one. `leap-chorus tab focus`
 * was added for it. `pane focus` is translated too, for a line.
 *
 * ## Translating the commands is not enough
 *
 * The output is part of the contract. `open-file-viewer.sh` pipes `pane list` straight
 * into the viewer binary's own `--launch-decision`, which deserializes
 * `{result:{panes:[{pane_id,label,focused,tab_id}]}}` and answers `OPEN` for anything it
 * cannot parse. Our `pane list` prints a bare array in camelCase — close enough to look
 * right and different enough that the plugin would have silently lost focus-or-close
 * and opened a new viewer every time. Hence `--herdr-json`, and hence the `tab_id` our
 * `pane list` did not previously carry at all.
 *
 * ## What translation cannot do
 *
 * herdr's placements `overlay`, `popup` and `zoomed` name window shapes this
 * multiplexer does not have; they become `split`, and the result says so. `--width` and
 * `--height` size a popup and are dropped with a line on stderr — silently ignoring a
 * geometry request would leave a plugin author debugging a layout that was never asked
 * for.
 */

import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileDurable } from '@leap-chorus/daemon'

/** herdr's placement names, and what each becomes here. */
const PLACEMENTS: Readonly<Record<string, 'split' | 'tab'>> = {
  overlay: 'split',
  popup: 'split',
  split: 'split',
  tab: 'tab',
  zoomed: 'split'
}

export interface Translation {
  /** The `leap-chorus` argv to run instead. */
  readonly argv: readonly string[]
  /** Lines to put on stderr first: a dropped flag, a coerced placement. */
  readonly notes: readonly string[]
}

export class HerdrCompatError extends Error {}

/**
 * Turn a herdr command line into ours.
 *
 * Pure: it reads `env` for the two ids herdr sets on a plugin's process and touches
 * nothing else, so the whole translation table is testable without a daemon.
 */
export function translateHerdrArgv(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Translation {
  const [group, verb, ...rest] = argv
  if (group === undefined || group === '--help' || group === '-h') {
    throw new HerdrCompatError(usage())
  }

  if (group === 'pane') {
    switch (verb) {
      case 'list':
        // `--herdr-json`, not `--json`: a plugin does not just *call* herdr's CLI, it
        // *parses* it. See the note on that flag in `main.ts`.
        return { argv: ['pane', 'list', '--herdr-json'], notes: [] }
      case 'zoom':
      case 'close':
      case 'focus':
        return { argv: ['pane', verb, ...rest.filter((arg) => arg !== '--json')], notes: [] }
      default:
        throw new HerdrCompatError(`herdr-compat: unsupported 'pane ${verb ?? ''}'\n\n${usage()}`)
    }
  }

  if (group === 'tab') {
    // herdr-file-viewer's tab launcher switches to an existing viewer tab with
    // `tab focus <id>` rather than opening a second one.
    if (verb === 'focus' || verb === 'close') {
      return { argv: ['tab', verb, ...rest], notes: [] }
    }
    if (verb === 'list') return { argv: ['tab', 'list'], notes: [] }
    throw new HerdrCompatError(`herdr-compat: unsupported 'tab ${verb ?? ''}'\n\n${usage()}`)
  }

  if (group === 'plugin' && verb === 'config-dir') {
    const pluginId = rest[0] ?? env['HERDR_PLUGIN_ID']
    if (pluginId === undefined) {
      throw new HerdrCompatError('herdr-compat: plugin config-dir needs a plugin id')
    }
    return { argv: ['plugin', 'config-dir', pluginId], notes: [] }
  }

  if (group === 'plugin' && verb === 'pane') {
    const [paneVerb, ...paneRest] = rest
    if (paneVerb === 'focus' || paneVerb === 'close') {
      // herdr's `plugin pane focus/close` take an ordinary pane id, so they are the
      // ordinary commands under another name.
      return { argv: ['pane', paneVerb, ...paneRest], notes: [] }
    }
    if (paneVerb !== 'open') {
      throw new HerdrCompatError(`herdr-compat: unsupported 'plugin pane ${paneVerb ?? ''}'\n\n${usage()}`)
    }
    return translatePaneOpen(paneRest, env)
  }

  throw new HerdrCompatError(`herdr-compat: unsupported '${group} ${verb ?? ''}'\n\n${usage()}`)
}

function translatePaneOpen(args: readonly string[], env: NodeJS.ProcessEnv): Translation {
  const notes: string[] = []
  const out: string[] = ['plugin', 'pane', 'open']
  let pluginId = env['HERDR_PLUGIN_ID']
  let entrypointId = env['HERDR_PLUGIN_ENTRYPOINT_ID']

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const value = args[i + 1]
    switch (arg) {
      case '--plugin':
        pluginId = requireValue(arg, value)
        i++
        break
      case '--entrypoint':
        entrypointId = requireValue(arg, value)
        i++
        break
      case '--placement': {
        const raw = requireValue(arg, value)
        const placement = PLACEMENTS[raw]
        if (placement === undefined) {
          throw new HerdrCompatError(`herdr-compat: unknown placement '${raw}'`)
        }
        if (placement !== raw) notes.push(`placement '${raw}' has no counterpart here; opening a ${placement}`)
        out.push('--placement', placement)
        i++
        break
      }
      case '--target-pane':
        out.push('--target-pane', requireValue(arg, value))
        i++
        break
      case '--direction':
        out.push('--direction', requireValue(arg, value))
        i++
        break
      case '--cwd':
        out.push('--cwd', requireValue(arg, value))
        i++
        break
      case '--env':
        out.push('--env', requireValue(arg, value))
        i++
        break
      case '--focus':
        break
      case '--no-focus':
        out.push('--no-focus')
        break
      case '--width':
      case '--height':
        notes.push(`${arg} sizes a popup, which this multiplexer does not have; ignored`)
        i++
        break
      case '--workspace':
        // Accepted and dropped: a plugin pane opens where the user is, and honouring a
        // workspace id would mean moving their focus somewhere they did not ask to go.
        notes.push('--workspace is ignored; a plugin pane opens in the active workspace')
        i++
        break
      default:
        throw new HerdrCompatError(`herdr-compat: unknown option '${arg}'`)
    }
  }

  if (pluginId === undefined) {
    throw new HerdrCompatError('herdr-compat: plugin pane open needs --plugin (or $HERDR_PLUGIN_ID)')
  }
  out.push('--plugin', pluginId)
  if (entrypointId !== undefined) out.push('--entrypoint', entrypointId)
  return { argv: out, notes }
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new HerdrCompatError(`herdr-compat: ${flag} needs a value`)
  return value
}

function usage(): string {
  return `herdr-compat — herdr's plugin commands, translated for leap-chorus

This is NOT herdr. It is a shim leap-chorus points $HERDR_BIN_PATH at so a herdr
plugin's launcher scripts run unchanged. It understands:

  pane list [--json]
  pane zoom <id> [--on|--off]
  pane close <id>
  pane focus <id>
  tab list
  tab focus <id>
  tab close <id>
  plugin pane open [--plugin ID] [--entrypoint ID] [--placement overlay|popup|split|tab|zoomed]
                   [--target-pane ID] [--direction right|down] [--cwd PATH] [--env K=V] [--no-focus]
  plugin config-dir [<id>]

Anything else is an error rather than a guess.`
}

// ---------------------------------------------------------------------------
// The generated wrapper
// ---------------------------------------------------------------------------

/**
 * The shim's text.
 *
 * `sh`, not Node: it has to work when this client is a bundled binary with no
 * importable entry, and `exec` keeps it out of the process tree the plugin sees. The
 * first comment line is a load-bearing part of the answer to decision 4 — anyone who
 * finds this file while debugging should learn in one line that it is not herdr.
 */
export function shimScript(execPath: string, entry: string | null): string {
  const target = entry === null ? [shellQuote(execPath)] : [shellQuote(execPath), shellQuote(entry)]
  return `#!/bin/sh
# leap-chorus herdr-compat shim — generated; edits are overwritten.
#
# This is NOT herdr. $HERDR_BIN_PATH points here so a herdr plugin's launcher
# scripts run unchanged; it translates the handful of commands they use.
exec ${target.join(' ')} --compat herdr "$@"
`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * Write the shim, from whatever is running right now.
 *
 * Rewritten on every `leap-chorus plugin …` invocation rather than only at install
 * time, because the two paths baked into it — the node binary and this client's entry —
 * move when the user upgrades, and a shim that names a deleted `node` fails inside a
 * plugin, three layers from anything that could explain it.
 */
export function writeShim(
  shimPath: string,
  options: { execPath?: string; entry?: string | null } = {}
): string {
  const execPath = options.execPath ?? process.execPath
  // A bundled single-file build has no separate entry to pass; argv[1] is then the
  // binary itself and repeating it would run it twice.
  const entry = options.entry === undefined ? (process.argv[1] ?? null) : options.entry
  mkdirSync(dirname(shimPath), { recursive: true })
  writeFileDurable(shimPath, shimScript(execPath, entry === execPath ? null : entry), { mode: 0o755 })
  // `writeFileDurable` creates the temporary with the same mode, but a restrictive
  // umask can still clear the execute bits on the way in; a shim that is not executable
  // is a plugin that cannot start.
  chmodSync(shimPath, 0o755)
  return shimPath
}
