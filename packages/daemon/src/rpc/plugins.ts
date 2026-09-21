/**
 * `plugin.list`, `plugin.pane.open`, `plugin.action.invoke`.
 *
 * Three methods, and deliberately no more. PHASE-10: "No event hooks or plugin-invoked
 * RPCs beyond the five commands, until a plugin needs them." The five commands a herdr
 * launcher script actually calls are `pane list/open/zoom/close` — which have existed
 * since phase 5 and are not plugin-specific — and `plugin config-dir`, which needs no
 * daemon at all. So nothing here is reachable *by* a plugin; these are how the host
 * opens one.
 *
 * ## A plugin's pane is an ordinary pane
 *
 * There is no `PluginPane` type, no second lifecycle, no overlay. An entrypoint's argv
 * goes into `pane.split` or `tab.create` and the result is a pane like any other: the
 * user can zoom it, move it, close it, and the plugin finds out the way every other
 * program does, by its stdin closing.
 *
 * ## Idempotency is per entrypoint, not per placement
 *
 * One entrypoint has one live pane, wherever it happens to be. Opening `file-viewer`
 * twice focuses the first rather than splitting a second copy beside it — and asking
 * for it in a tab when it is already in a split focuses the split, because the thing
 * the user wants is the viewer, not another one. The record is dropped as soon as the
 * pane is gone, which is checked against live state on every open rather than tracked
 * by an event: a pane can disappear because its program exited, and nothing tells this
 * map about that.
 */

import type {
  InstalledPluginInfo,
  PluginActionInvokeResult,
  PluginEntrypointInfo,
  PluginListResult,
  PluginPaneOpenResult,
  PluginPlacement
} from '@leap-chorus/protocol'
import { paneIds } from '@leap-chorus/core'
import { currentPluginPlatform, effectivePlatforms, platformAllows } from '../plugins/manifest.js'
import type { PluginStore } from '../plugins/registry.js'
import { PluginBusyError, PluginRunner } from '../plugins/run.js'
import type { ModelContext } from './session-model.js'
import { badRequest, optionalBoolean, optionalEnum, optionalEnv, optionalString, requireString, type Params } from './params.js'

export interface PluginContext extends ModelContext {
  readonly plugins: PluginStore
  readonly runner: PluginRunner
  readonly paneIndex: PluginPaneIndex
}

const PLACEMENTS: readonly PluginPlacement[] = ['split', 'tab']
const DIRECTIONS = ['right', 'down'] as const

/** Which pane is currently showing which entrypoint. Lives for the daemon's lifetime. */
export class PluginPaneIndex {
  private readonly panes = new Map<string, string>()

  private static key(pluginId: string, entrypointId: string): string {
    return `${pluginId}\u0000${entrypointId}`
  }

  get(pluginId: string, entrypointId: string): string | null {
    return this.panes.get(PluginPaneIndex.key(pluginId, entrypointId)) ?? null
  }

  set(pluginId: string, entrypointId: string, paneId: string): void {
    this.panes.set(PluginPaneIndex.key(pluginId, entrypointId), paneId)
  }

  forget(pluginId: string, entrypointId: string): void {
    this.panes.delete(PluginPaneIndex.key(pluginId, entrypointId))
  }
}

// ---------------------------------------------------------------------------
// plugin.list
// ---------------------------------------------------------------------------

export function pluginList(context: PluginContext, params: Params): PluginListResult {
  const pluginId = optionalString(params, 'pluginId')
  const plugins = context.plugins.list()
  return {
    plugins: pluginId === undefined ? plugins : plugins.filter((plugin) => plugin.id === pluginId),
    shimPath: context.plugins.shimPath
  }
}

// ---------------------------------------------------------------------------
// plugin.pane.open
// ---------------------------------------------------------------------------

export function pluginPaneOpen(context: PluginContext, params: Params): PluginPaneOpenResult {
  const pluginId = requireString(params, 'pluginId')
  const plugin = requirePlugin(context, pluginId)
  const entry = resolveEntrypoint(plugin, optionalString(params, 'entrypointId'))
  const placement = optionalEnum(params, 'placement', PLACEMENTS) ?? entry.placement
  const focus = optionalBoolean(params, 'focus') ?? true

  const existing = context.paneIndex.get(plugin.id, entry.id)
  if (existing !== null) {
    if (context.runtime.state.panes.has(existing)) {
      // Already open. Focus it and say so — `reused` is the difference between "here it
      // is" and "here is another one", and a caller that wanted a second copy can close
      // the first.
      if (focus) context.runtime.dispatch({ type: 'pane.focus', paneId: existing })
      const tab = tabOf(context, existing)
      return {
        pluginId: plugin.id,
        entrypointId: entry.id,
        paneId: existing,
        tabId: tab,
        placement,
        reused: true,
        placementFallbackFrom: entry.placementFallbackFrom
      }
    }
    context.paneIndex.forget(plugin.id, entry.id)
  }

  const cwd = optionalString(params, 'cwd') ?? plugin.root
  const env = {
    ...launchEnv(context, plugin, entry, optionalString(params, 'targetPaneId')),
    ...(optionalEnv(params, 'env') ?? {})
  }
  const [command, ...args] = entry.command

  const result =
    placement === 'tab'
      ? context.runtime.dispatch({
          type: 'tab.create',
          focus,
          cwd,
          label: entry.title,
          env,
          ...(command === undefined ? {} : { command }),
          ...(args.length === 0 ? {} : { args })
        })
      : context.runtime.dispatch({
          type: 'pane.split',
          direction: optionalEnum(params, 'direction', DIRECTIONS) ?? 'right',
          focus,
          cwd,
          env,
          ...(optionalString(params, 'targetPaneId') === undefined
            ? {}
            : { targetPaneId: requireString(params, 'targetPaneId') }),
          ...(command === undefined ? {} : { command }),
          ...(args.length === 0 ? {} : { args })
        })

  if (!result.ok) throw badRequest(`could not open ${plugin.id}/${entry.id}: ${result.error ?? 'action rejected'}`)
  const paneId = result.created?.paneId
  if (paneId === undefined) {
    throw badRequest(`could not open ${plugin.id}/${entry.id}: no pane was created`)
  }
  context.paneIndex.set(plugin.id, entry.id, paneId)
  // A pane named after the entrypoint, because `bash` in the tab bar tells nobody which
  // plugin is running.
  context.runtime.dispatch({ type: 'pane.rename', paneId, label: entry.title })

  return {
    pluginId: plugin.id,
    entrypointId: entry.id,
    paneId,
    tabId: result.created?.tabId ?? tabOf(context, paneId),
    placement,
    reused: false,
    placementFallbackFrom: entry.placementFallbackFrom
  }
}

// ---------------------------------------------------------------------------
// plugin.action.invoke
// ---------------------------------------------------------------------------

/**
 * Run an action headless and report what it printed.
 *
 * Headless, not in a pane: an action that wants a terminal declares `[[panes]]`, and
 * this is the other kind — the one that writes a file or pokes a socket and exits. The
 * output is capped and the caller is told when that happened, which is criterion 7.
 */
export async function pluginActionInvoke(context: PluginContext, params: Params): Promise<PluginActionInvokeResult> {
  const pluginId = requireString(params, 'pluginId')
  const plugin = requirePlugin(context, pluginId)
  const actionId = requireString(params, 'actionId')
  const entry = plugin.entrypoints.find((candidate) => candidate.kind === 'action' && candidate.id === actionId)
  if (entry === undefined) throw badRequest(`${plugin.id} has no action '${actionId}'`)
  assertAvailable(plugin, entry)

  const cwd = optionalString(params, 'cwd') ?? plugin.root
  context.plugins.ensureUserDirs(plugin.id)
  try {
    const outcome = await context.runner.run({
      argv: entry.command,
      cwd,
      env: { ...process.env, ...launchEnv(context, plugin, entry, undefined) }
    })
    return {
      pluginId: plugin.id,
      actionId: entry.id,
      code: outcome.code,
      signal: outcome.signal,
      stdout: outcome.stdout,
      stderr: outcome.failure === null ? outcome.stderr : `${entry.command[0] ?? ''}: ${outcome.stderr}`,
      truncated: outcome.truncated,
      timedOut: outcome.timedOut
    }
  } catch (error) {
    if (error instanceof PluginBusyError) throw badRequest(error.message)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function requirePlugin(context: PluginContext, pluginId: string): InstalledPluginInfo {
  const plugin = context.plugins.get(pluginId)
  if (plugin === null) throw badRequest(`no plugin '${pluginId}' is installed`)
  if (plugin.missing) throw badRequest(`${pluginId} is registered but its files are gone from ${plugin.root}`)
  return plugin
}

/**
 * Which entrypoint to open.
 *
 * With no id: the only one, and an error naming the alternatives when there are
 * several. A host that silently picked the first would open a different thing after the
 * plugin's next release added one above it alphabetically.
 */
function resolveEntrypoint(plugin: InstalledPluginInfo, entrypointId: string | undefined): PluginEntrypointInfo {
  if (entrypointId === undefined) {
    // Panes sort before actions, so a plugin with one pane and several actions still has
    // an unambiguous answer for "open it".
    const panes = plugin.entrypoints.filter((entry) => entry.kind === 'pane')
    const candidates = panes.length > 0 ? panes : plugin.entrypoints
    const only = candidates[0]
    if (only === undefined) throw badRequest(`${plugin.id} declares no panes or actions`)
    if (candidates.length > 1) {
      throw badRequest(`${plugin.id} has several entrypoints; name one of ${candidates.map((e) => e.id).join(', ')}`)
    }
    assertAvailable(plugin, only)
    return only
  }
  // Panes first: herdr keeps pane ids and action ids in separate namespaces, so one
  // manifest may legally use the same id for both. The pane is the one that opens.
  const entry =
    plugin.entrypoints.find((candidate) => candidate.kind === 'pane' && candidate.id === entrypointId) ??
    plugin.entrypoints.find((candidate) => candidate.id === entrypointId)
  if (entry === undefined) throw badRequest(`${plugin.id} has no entrypoint '${entrypointId}'`)
  assertAvailable(plugin, entry)
  return entry
}

function assertAvailable(plugin: InstalledPluginInfo, entry: PluginEntrypointInfo): void {
  const platforms = effectivePlatforms(entry.platforms, plugin.platforms)
  const current = currentPluginPlatform()
  if (platformAllows(platforms, current)) return
  throw badRequest(
    `${plugin.id}/${entry.id} declares platforms ${platforms.join(', ')}; this is ${current ?? process.platform}`
  )
}

/** The tab a pane is in — by walking each layout, because a pane need not be the focused one. */
function tabOf(context: PluginContext, paneId: string): string | null {
  for (const tab of context.runtime.state.tabs.values()) {
    if (paneIds(tab.layout).includes(paneId)) return tab.id
  }
  return null
}

/**
 * What a plugin's process learns about the host.
 *
 * herdr's names, from `src/app/api/plugins/env.rs` and `panes.rs`, because a launcher
 * script reads `$HERDR_PLUGIN_ROOT` and does not care which program set it.
 *
 * `HERDR_BIN_PATH` is the one that matters and the one PHASE-10's fourth decision is
 * about: it points at `plugins/bin/herdr-compat`, a generated wrapper around
 * `leap-chorus --compat herdr`. It is **not** a binary called `herdr`. A plugin that
 * shells out to it gets herdr's five commands translated; a plugin that goes looking
 * for `herdr` on `PATH` finds whatever the user has, which is the honest answer.
 */
/**
 * Why a plugin starts in its own directory and not in the user's.
 *
 * herdr's `plugin_pane_cwd` and its action runner both default to `plugin_root`, and
 * this host copied the obvious-looking thing instead — the focused pane's cwd — until
 * `herdr-file-viewer` was installed for real and did not open. Its manifest says
 * `command = ["./target/release/herdr-file-viewer"]`: a **relative** program, resolved
 * against the cwd. Started in the user's repository it is not there, the pane's process
 * dies immediately, and the pane closes itself a frame later — which looks exactly like
 * a plugin that opened and instantly crashed, with nothing on screen to read.
 *
 * A plugin that wants the user's directory reads `focused_pane_cwd` out of
 * `HERDR_PLUGIN_CONTEXT_JSON`, which is what that field is for.
 */
function launchEnv(
  context: PluginContext,
  plugin: InstalledPluginInfo,
  entry: PluginEntrypointInfo,
  targetPaneId: string | undefined
): Record<string, string> {
  const snapshot = context.runtime.snapshot()
  const paneId = targetPaneId ?? snapshot.focusedPaneId
  const pane = snapshot.panes.find((candidate) => candidate.paneId === paneId)
  const tab = snapshot.tabs.find((candidate) => candidate.focusedPaneId === paneId)
  const workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === snapshot.activeWorkspaceId)

  context.plugins.ensureUserDirs(plugin.id)
  const env: Record<string, string> = {
    HERDR_PLUGIN_ID: plugin.id,
    HERDR_PLUGIN_ROOT: plugin.root,
    HERDR_PLUGIN_CONFIG_DIR: plugin.configDir,
    HERDR_PLUGIN_STATE_DIR: plugin.stateDir,
    HERDR_PLUGIN_ENTRYPOINT_ID: entry.id,
    HERDR_BIN_PATH: context.plugins.shimPath,
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: workspace?.workspaceId ?? null,
      workspace_label: workspace?.label ?? null,
      workspace_cwd: workspace?.cwd ?? null,
      tab_id: tab?.tabId ?? null,
      tab_label: tab?.label ?? null,
      focused_pane_id: pane?.paneId ?? null,
      focused_pane_cwd: pane?.cwd ?? null,
      focused_pane_agent: pane?.agent ?? null,
      focused_pane_status: pane?.agentStatus ?? null,
      invocation_source: 'leap-chorus'
    })
  }
  if (workspace !== undefined) env['HERDR_WORKSPACE_ID'] = workspace.workspaceId
  if (pane !== undefined) env['HERDR_PANE_ID'] = pane.paneId
  return env
}
