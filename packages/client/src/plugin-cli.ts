/**
 * `leap-chorus plugin …`.
 *
 * ## Why install runs here and not in the daemon
 *
 * Installing means a `git fetch` and then somebody else's build script, which for
 * `herdr-file-viewer` falls back to `cargo build`. Putting that in the daemon would
 * block the process that owns every PTY on a stranger's compiler, and the confirmation
 * it has to ask for is on a terminal the daemon does not have. herdr makes the same
 * split for the same reason: `src/cli/plugin.rs` does the work, and only tells the
 * server afterwards.
 *
 * So the registry is a **file**, written here and re-read by the daemon on every use.
 * That also means `plugin list`, `plugin install`, `plugin remove` and `plugin verify`
 * work with no daemon running, which matters the first time somebody installs
 * something before ever opening the TUI.
 *
 * `plugin pane open` and `plugin action invoke` are the two that need a daemon, because
 * both are about panes.
 *
 * ## `--json` is herdr's shape
 *
 * PHASE-10 criterion 4 asks that `plugin list --json` match what the launcher scripts
 * parse. `herdrPluginListJson` below is the one place that claim lives, in herdr's
 * snake_case with herdr's field names, and it is pinned by a test — so a rename in our
 * own protocol types cannot quietly break a script written against herdr.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  PluginInstallError,
  PluginInstaller,
  PluginManifestError,
  PluginRegistryError,
  PluginStore,
  parsePluginSource,
  resolveDataRoot,
  sourceLabel,
  type InstallPreview
} from '@leap-chorus/daemon'
import type { InstalledPluginInfo } from '@leap-chorus/protocol'
import { attach } from './attach.js'
import { writeShim } from './compat.js'

export const PLUGIN_USAGE = `leap-chorus plugin — install and run herdr plugins

  plugin install <owner>/<repo>[/subdir] [--ref REF] [--pin HASH] [--update] [--yes]
  plugin install <path-to-git-repo> [--ref REF] [--yes]
                       fetch, show what it declares, run its build, register it
  plugin list [--json] [<id>]
  plugin verify [<id>]  re-hash the installed files and compare with the install
  plugin remove <id> [--purge]
  plugin config-dir <id>
  plugin shim           print the $HERDR_BIN_PATH wrapper's path, rewriting it
  plugin pane open --plugin ID [--entrypoint ID] [--placement split|tab]
                   [--target-pane ID] [--direction right|down] [--cwd PATH]
                   [--env K=V] [--no-focus]
  plugin action invoke --plugin ID <action-id> [--cwd PATH]

A plugin is someone else's program and runs as you, with your files and your
network. leap-chorus shows you what it declares, pins the bytes it fetched, and
bounds its output. None of that is a sandbox.`

interface PluginArgs {
  readonly verb: string
  readonly rest: readonly string[]
  readonly dataRoot?: string
}

export async function pluginCommand(args: PluginArgs): Promise<number> {
  const dataRoot = args.dataRoot ?? resolveDataRoot()
  const store = new PluginStore(dataRoot)
  // Every path through here can end up launching a plugin, and a stale shim is a
  // plugin that cannot call back. Cheap, idempotent, and always current.
  mkdirSync(store.binDir, { recursive: true })
  writeShim(store.shimPath)

  try {
    switch (args.verb) {
      case 'install':
        return await installCommand(store, args.rest)
      case 'list':
        return listCommand(store, args.rest)
      case 'verify':
        return verifyCommand(store, args.rest)
      case 'remove':
      case 'uninstall':
        return removeCommand(store, args.rest)
      case 'config-dir':
        return configDirCommand(store, args.rest)
      case 'shim':
        process.stdout.write(`${store.shimPath}\n`)
        return 0
      case 'pane':
        return await paneCommand(args, store)
      case 'action':
        return await actionCommand(args)
      case 'help':
      case '--help':
      case '-h':
      case '':
        process.stdout.write(`${PLUGIN_USAGE}\n`)
        return args.verb === '' ? 2 : 0
      default:
        process.stderr.write(`unknown plugin command: ${args.verb}\n\n${PLUGIN_USAGE}\n`)
        return 2
    }
  } catch (error) {
    // Every error this file raises carries a code and a sentence. Anything else is a
    // bug and gets its stack, because a bug hidden behind a tidy message is worse.
    if (
      error instanceof PluginInstallError ||
      error instanceof PluginManifestError ||
      error instanceof PluginRegistryError
    ) {
      process.stderr.write(`${error.code}: ${error.message}\n`)
      return 1
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function installCommand(store: PluginStore, rest: readonly string[]): Promise<number> {
  const [raw, ...flags] = rest
  if (raw === undefined || raw.startsWith('-')) {
    process.stderr.write('usage: leap-chorus plugin install <owner>/<repo>[/subdir] [--ref REF] [--yes]\n')
    return 2
  }
  const options = parseFlags(flags, {
    values: new Set(['--ref', '--pin', '--subdir']),
    booleans: new Set(['--yes', '-y', '--update'])
  })
  if (options.error !== null) {
    process.stderr.write(`${options.error}\n`)
    return 2
  }

  const parsed = parsePluginSource(raw)
  const subdir = options.values['--subdir']
  const source = subdir === undefined ? parsed : { ...parsed, subdir: subdir.split('/').filter((s) => s.length > 0) }
  const yes = options.booleans.has('--yes') || options.booleans.has('-y')

  // Refusing a non-interactive install without `--yes` is herdr's rule, and it is the
  // one that stops `plugin install` from being something a script can do to a user.
  if (!yes && !process.stdin.isTTY) {
    process.stderr.write('a plugin install needs --yes when stdin is not a terminal\n')
    return 2
  }

  const installer = new PluginInstaller(store)
  const outcome = await installer.install({
    source,
    ...(options.values['--ref'] === undefined ? {} : { ref: options.values['--ref'] }),
    ...(options.values['--pin'] === undefined ? {} : { pin: options.values['--pin'] }),
    ...(options.booleans.has('--update') ? { update: true } : {}),
    onProgress: (line) => process.stderr.write(`${line}\n`),
    confirm: async (preview) => {
      process.stdout.write(renderPreview(preview))
      return yes ? true : await confirm('Install this plugin?')
    }
  })

  if (outcome.status === 'cancelled' || outcome.plugin === null) {
    process.stderr.write('plugin install cancelled\n')
    return 1
  }
  const plugin = outcome.plugin
  process.stdout.write(
    `${outcome.replaced ? 'Replaced' : 'Installed'} ${plugin.id} ${plugin.version} from ${sourceLabel(source)}\n` +
      `  pinned  ${plugin.pin.contentHash} (commit ${plugin.pin.commit.slice(0, 12)})\n` +
      `  files   ${plugin.root}\n` +
      `  config  ${plugin.configDir}\n`
  )
  return 0
}

/**
 * What the user says yes to.
 *
 * Every argv is printed in full, including the build's. The point is not that anybody
 * will audit `sh -c` line by line — it is that "I was never shown it" stops being true,
 * and that a manifest which quietly grew a second build step between two versions is
 * visible at the moment it matters.
 */
export function renderPreview(preview: InstallPreview): string {
  const lines: string[] = []
  const manifest = preview.manifest
  lines.push('')
  lines.push(`  ${manifest.name} (${manifest.id}) ${manifest.version}`)
  if (manifest.description !== null) lines.push(`  ${manifest.description}`)
  lines.push(`  from    ${preview.sourceLabel} at ${preview.ref ?? 'the default branch'}`)
  lines.push(`  commit  ${preview.commit}`)
  lines.push(`  bytes   ${preview.contentHash}`)
  if (preview.existing !== null) {
    lines.push(`  replaces ${preview.existing.version} installed ${new Date(preview.existing.installedAt).toISOString()}`)
  }
  lines.push('')
  if (preview.build.length === 0) {
    lines.push('  builds  nothing')
  } else {
    lines.push('  builds  (runs as you, before anything else)')
    for (const argv of preview.build) lines.push(`            ${argv.join(' ')}`)
  }
  const entrypoints = manifest.entrypoints
  lines.push(entrypoints.length === 0 ? '  opens   nothing' : '  opens')
  for (const entry of entrypoints) {
    const fallback = entry.placementFallbackFrom === null ? '' : ` (manifest says ${entry.placementFallbackFrom})`
    lines.push(`            ${entry.kind} ${entry.id} — ${entry.placement}${fallback}: ${entry.command.join(' ')}`)
  }
  if (preview.unavailable.length > 0) {
    lines.push(`  skipped ${preview.unavailable.join(', ')} — not for this platform`)
  }
  if (manifest.ignored.length > 0) {
    // The honest half. A plugin whose whole behaviour is event hooks will install
    // cleanly and do nothing, and this is where a user finds that out first.
    lines.push(`  ignored ${manifest.ignored.join(', ')}`)
    lines.push('          this host does not run those; the plugin may not work as written')
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close()
      resolve(/^y(es)?$/iu.test(answer.trim()))
    })
  })
}

// ---------------------------------------------------------------------------
// list, verify, remove, config-dir
// ---------------------------------------------------------------------------

function listCommand(store: PluginStore, rest: readonly string[]): number {
  const json = rest.includes('--json')
  const id = rest.find((arg) => !arg.startsWith('-'))
  const plugins = store.list().filter((plugin) => id === undefined || plugin.id === id)
  if (json) {
    process.stdout.write(`${JSON.stringify(herdrPluginListJson(plugins, store.shimPath), null, 2)}\n`)
    return 0
  }
  if (plugins.length === 0) {
    process.stdout.write('no plugins installed\n')
    return 0
  }
  for (const plugin of plugins) {
    const state = plugin.missing ? ' [files missing]' : ''
    process.stdout.write(`${plugin.id}\t${plugin.version}\t${plugin.pin.source}\t${plugin.pin.commit.slice(0, 12)}${state}\n`)
    for (const entry of plugin.entrypoints) {
      process.stdout.write(`  ${entry.kind}\t${entry.id}\t${entry.placement}\t${entry.command.join(' ')}\n`)
    }
    if (plugin.ignored.length > 0) process.stdout.write(`  ignored\t${plugin.ignored.join(', ')}\n`)
  }
  return 0
}

/**
 * herdr's `plugin list --json` shape.
 *
 * snake_case, herdr's field names, herdr's nesting. Our own fields are added rather
 * than substituted — `pin` and `installed_hash` have no herdr counterpart and a script
 * that does not know them ignores them. `enabled` is always true: this host has no
 * enable/disable, and a script that filters on it should see every plugin it can run
 * rather than none.
 */
export function herdrPluginListJson(
  plugins: readonly InstalledPluginInfo[],
  shimPath: string
): Record<string, unknown> {
  return {
    shim_path: shimPath,
    plugins: plugins.map((plugin) => ({
      plugin_id: plugin.id,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      plugin_root: plugin.root,
      manifest_path: plugin.manifestPath,
      config_dir: plugin.configDir,
      state_dir: plugin.stateDir,
      enabled: !plugin.missing,
      platforms: plugin.platforms,
      panes: plugin.entrypoints
        .filter((entry) => entry.kind === 'pane')
        .map((entry) => ({
          id: entry.id,
          title: entry.title,
          description: entry.description,
          placement: entry.placement,
          command: entry.command,
          platforms: entry.platforms
        })),
      actions: plugin.entrypoints
        .filter((entry) => entry.kind === 'action')
        .map((entry) => ({
          action_id: entry.id,
          title: entry.title,
          description: entry.description,
          command: entry.command,
          platforms: entry.platforms
        })),
      ignored: plugin.ignored,
      source: {
        kind: plugin.pin.source.startsWith('/') ? 'path' : 'github',
        source: plugin.pin.source,
        ref: plugin.pin.ref,
        commit: plugin.pin.commit,
        content_hash: plugin.pin.contentHash
      },
      installed_hash: plugin.installedHash,
      installed_at: plugin.installedAt
    }))
  }
}

/**
 * `plugin verify` — PHASE-10 decision 3, such as it is.
 *
 * There is no kill list. This is what exists instead: a user who reads an advisory can
 * ask whether the bytes on their disk are still the bytes they approved, and can read
 * the pinned commit out of `plugin list --json` to compare against one. It catches a
 * local change; it cannot catch a plugin that was malicious the day it was published.
 * The handoff says so in those words.
 */
function verifyCommand(store: PluginStore, rest: readonly string[]): number {
  const id = rest.find((arg) => !arg.startsWith('-'))
  const targets = store.list().filter((plugin) => id === undefined || plugin.id === id)
  if (targets.length === 0) {
    process.stderr.write(id === undefined ? 'no plugins installed\n' : `no plugin '${id}' is installed\n`)
    return id === undefined ? 0 : 1
  }
  let bad = 0
  for (const plugin of targets) {
    const report = store.verify(plugin.id)
    if (report === null) continue
    if (report.status === 'ok') {
      process.stdout.write(`${plugin.id}\tok\t${report.expected}\n`)
      continue
    }
    bad += 1
    process.stdout.write(
      report.status === 'missing'
        ? `${plugin.id}\tmissing\tnothing at ${plugin.root}\n`
        : `${plugin.id}\tCHANGED\texpected ${report.expected}, found ${report.actual}\n`
    )
  }
  return bad === 0 ? 0 : 1
}

function removeCommand(store: PluginStore, rest: readonly string[]): number {
  const id = rest.find((arg) => !arg.startsWith('-'))
  if (id === undefined) {
    process.stderr.write('usage: leap-chorus plugin remove <id> [--purge]\n')
    return 2
  }
  const purge = rest.includes('--purge')
  if (!store.remove(id, { purge })) {
    process.stderr.write(`no plugin '${id}' is installed\n`)
    return 1
  }
  process.stdout.write(
    purge
      ? `Removed ${id}, with its config and state.\n`
      : `Removed ${id}. Its config is still at ${store.configDirFor(id)} (--purge to delete it).\n`
  )
  return 0
}

function configDirCommand(store: PluginStore, rest: readonly string[]): number {
  const id = rest[0]
  if (id === undefined) {
    process.stderr.write('usage: leap-chorus plugin config-dir <id>\n')
    return 2
  }
  // herdr creates the directory as a side effect of being asked where it is, and a
  // launcher script relies on that: it writes into the path the moment it is printed.
  store.ensureUserDirs(id)
  process.stdout.write(`${store.configDirFor(id)}\n`)
  return 0
}

// ---------------------------------------------------------------------------
// pane open, action invoke — the two that need the daemon
// ---------------------------------------------------------------------------

async function paneCommand(args: PluginArgs, store: PluginStore): Promise<number> {
  const [verb, ...rest] = args.rest
  if (verb !== 'open') {
    process.stderr.write(`unknown plugin pane command: ${verb ?? ''}\n`)
    return 2
  }
  const options = parseFlags(rest, {
    values: new Set(['--plugin', '--entrypoint', '--placement', '--target-pane', '--direction', '--cwd']),
    booleans: new Set(['--no-focus']),
    repeated: new Set(['--env'])
  })
  if (options.error !== null) {
    process.stderr.write(`${options.error}\n`)
    return 2
  }
  const pluginId = options.values['--plugin']
  if (pluginId === undefined) {
    process.stderr.write('leap-chorus plugin pane open needs --plugin\n')
    return 2
  }
  if (!existsSync(store.registryPath)) {
    process.stderr.write(`no plugin '${pluginId}' is installed\n`)
    return 1
  }

  const env: Record<string, string> = {}
  for (const assignment of options.repeated['--env'] ?? []) {
    const eq = assignment.indexOf('=')
    if (eq <= 0) {
      process.stderr.write(`--env expects KEY=VALUE, got '${assignment}'\n`)
      return 2
    }
    env[assignment.slice(0, eq)] = assignment.slice(eq + 1)
  }

  return withDaemon(args, async (client) => {
    const result = await client.call('plugin.pane.open', {
      pluginId,
      ...(options.values['--entrypoint'] === undefined ? {} : { entrypointId: options.values['--entrypoint'] }),
      ...(options.values['--placement'] === undefined ? {} : { placement: options.values['--placement'] }),
      ...(options.values['--target-pane'] === undefined ? {} : { targetPaneId: options.values['--target-pane'] }),
      ...(options.values['--direction'] === undefined ? {} : { direction: options.values['--direction'] }),
      ...(options.values['--cwd'] === undefined ? {} : { cwd: options.values['--cwd'] }),
      ...(options.booleans.has('--no-focus') ? { focus: false } : {}),
      ...(Object.keys(env).length === 0 ? {} : { env })
    } as never)
    // The pane id on stdout so a launcher can act on what it just made; everything else
    // on stderr so `$(…)` around this captures only the id.
    process.stdout.write(`${result.paneId}\n`)
    if (result.reused) process.stderr.write(`${result.pluginId}/${result.entrypointId} was already open\n`)
    if (result.placementFallbackFrom !== null) {
      process.stderr.write(`opened a ${result.placement}; the manifest asked for ${result.placementFallbackFrom}\n`)
    }
    return 0
  })
}

async function actionCommand(args: PluginArgs): Promise<number> {
  const [verb, ...rest] = args.rest
  if (verb !== 'invoke') {
    process.stderr.write(`unknown plugin action command: ${verb ?? ''}\n`)
    return 2
  }
  const options = parseFlags(rest, { values: new Set(['--plugin', '--cwd']), booleans: new Set() })
  if (options.error !== null) {
    process.stderr.write(`${options.error}\n`)
    return 2
  }
  const pluginId = options.values['--plugin']
  const actionId = options.positional[0]
  if (pluginId === undefined || actionId === undefined) {
    process.stderr.write('usage: leap-chorus plugin action invoke --plugin ID <action-id>\n')
    return 2
  }

  return withDaemon(args, async (client) => {
    const result = await client.call('plugin.action.invoke', {
      pluginId,
      actionId,
      ...(options.values['--cwd'] === undefined ? {} : { cwd: options.values['--cwd'] })
    } as never)
    if (result.stdout.length > 0) process.stdout.write(result.stdout)
    if (result.stderr.length > 0) process.stderr.write(result.stderr)
    if (result.truncated) process.stderr.write('\n[output passed the cap and the rest was dropped]\n')
    if (result.timedOut) process.stderr.write('\n[the action was killed after taking too long]\n')
    return result.code ?? 1
  })
}

async function withDaemon(args: PluginArgs, body: (client: DaemonClientLike) => Promise<number>): Promise<number> {
  let attachment
  try {
    attachment = await attach({
      ...(args.dataRoot === undefined ? {} : { dataRoot: args.dataRoot }),
      // Never start a daemon to open a pane in: there would be nothing to open it beside.
      noSpawn: true,
      clientName: 'leap-chorus-plugin'
    })
  } catch {
    process.stderr.write('no daemon is running\n')
    return 1
  }
  try {
    return await body(attachment.client as unknown as DaemonClientLike)
  } catch (error) {
    process.stderr.write(`${String(error)}\n`)
    return 1
  } finally {
    attachment.client.close()
  }
}

/** Just enough of the client to keep this file from importing its whole generic shape. */
interface DaemonClientLike {
  call(
    method: 'plugin.pane.open',
    params: unknown
  ): Promise<{ paneId: string; pluginId: string; entrypointId: string; reused: boolean; placement: string; placementFallbackFrom: string | null }>
  call(
    method: 'plugin.action.invoke',
    params: unknown
  ): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }>
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

interface ParsedFlags {
  readonly values: Record<string, string | undefined>
  readonly repeated: Record<string, string[] | undefined>
  readonly booleans: Set<string>
  readonly positional: string[]
  readonly error: string | null
}

/**
 * A flag parser that refuses what it does not know.
 *
 * `main.ts`'s existing commands scan for the flags they care about and ignore the rest,
 * which is fine when the caller is a person. Here the caller is a launcher script
 * written against a different program, and an option silently dropped is a plugin that
 * opens in the wrong place with no indication why.
 */
function parseFlags(
  args: readonly string[],
  spec: { values: Set<string>; booleans: Set<string>; repeated?: Set<string> }
): ParsedFlags {
  const values: Record<string, string | undefined> = {}
  const repeated: Record<string, string[] | undefined> = {}
  const booleans = new Set<string>()
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!arg.startsWith('-')) {
      positional.push(arg)
      continue
    }
    if (spec.booleans.has(arg)) {
      booleans.add(arg)
      continue
    }
    const wantsValue = spec.values.has(arg) || spec.repeated?.has(arg) === true
    if (!wantsValue) return { values, repeated, booleans, positional, error: `unknown option: ${arg}` }
    const value = args[i + 1]
    if (value === undefined) return { values, repeated, booleans, positional, error: `${arg} needs a value` }
    i++
    if (spec.repeated?.has(arg) === true) {
      ;(repeated[arg] ??= []).push(value)
    } else {
      values[arg] = value
    }
  }
  return { values, repeated, booleans, positional, error: null }
}
