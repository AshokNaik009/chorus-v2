/**
 * Installing an agent's hooks.
 *
 * Two writes per agent, and the second is the hard one:
 *
 * 1. the hook script, into our own directory — easy, we own the file
 * 2. a reference to it in the *agent's* settings file — which the user also owns
 *
 * ## The rule for step 2
 *
 * Never rewrite a file we did not write. The settings file holds the user's model
 * config, their permissions, their own hooks; a formatter that reserialized it would
 * destroy comments and key order the user put there on purpose. So this reads the
 * JSON, adds exactly the entries that are missing, removes only entries pointing at
 * *our* hook path, and writes back with the same two-space indentation every one of
 * these files already uses.
 *
 * herdr goes further and edits the CST so untouched bytes survive byte for byte
 * (`jsonc_parser`, `claude_settings.rs`). That needs a JSONC CST library; the honest
 * version of the trade-off is written at `readSettings` below.
 *
 * ## Idempotence
 *
 * Criterion 5. Installing twice is one install: the hook is rewritten only when its
 * version marker is older, and the settings entry is added only when an entry naming
 * the same hook path is not already there. `install; install` leaves the settings file
 * byte-identical, which is what the test asserts.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { IntegrationInstallOutcome, IntegrationRecord } from '@leap-chorus/protocol'
import { INTEGRATION_ASSETS, INTEGRATION_ASSET_VERSION, assetFor, installedVersionOf } from './assets.js'

export interface IntegrationOptions {
  /** Where hooks are written. Defaults to `<data root>/integrations`. */
  readonly hookDir: string
  /** Stands in for `$HOME` when resolving an agent's settings file. Tests set it. */
  readonly home?: string
}

/** The lifecycle events we ask an agent to call us on, and the action name for each. */
const CLAUDE_HOOKS: readonly { event: string; action: string; matcher?: string }[] = [
  // SessionStart is filtered to the sources claude documents, so an unrelated
  // internal start does not spawn a hook process for nothing. herdr's matcher.
  { event: 'SessionStart', action: 'session', matcher: '^(startup|resume|clear|compact|fork)$' },
  { event: 'UserPromptSubmit', action: 'working' },
  { event: 'PreToolUse', action: 'working' },
  { event: 'PostToolUse', action: 'working' },
  { event: 'Notification', action: 'blocked' },
  { event: 'Stop', action: 'idle' },
  { event: 'SessionEnd', action: 'idle' }
]

export function hookPathFor(options: IntegrationOptions, agent: string): string {
  const asset = assetFor(agent)
  return join(options.hookDir, agent, asset?.fileName ?? 'leap-chorus-agent-state.sh')
}

function settingsPathFor(options: IntegrationOptions, agent: string): string | null {
  const asset = assetFor(agent)
  if (asset === null || asset.settingsPath === null) return null
  return join(options.home ?? homedir(), asset.settingsPath)
}

export function listIntegrations(options: IntegrationOptions): IntegrationRecord[] {
  return INTEGRATION_ASSETS.map((asset) => {
    const hookPath = hookPathFor(options, asset.agent)
    const contents = readIfPresent(hookPath)
    return {
      agent: asset.agent,
      installed: contents !== null,
      installedVersion: contents === null ? null : installedVersionOf(contents),
      availableVersion: INTEGRATION_ASSET_VERSION,
      hookPath,
      settingsPath: settingsPathFor(options, asset.agent)
    }
  })
}

export function installIntegrations(
  options: IntegrationOptions,
  request: { agents?: readonly string[]; force?: boolean } = {}
): IntegrationInstallOutcome[] {
  const wanted = request.agents ?? INTEGRATION_ASSETS.map((asset) => asset.agent)
  return wanted.map((agent) => installOne(options, agent, request.force === true))
}

function installOne(options: IntegrationOptions, agent: string, force: boolean): IntegrationInstallOutcome {
  const asset = assetFor(agent)
  const hookPath = hookPathFor(options, agent)
  if (asset === null) {
    return {
      agent,
      installed: false,
      result: 'no integration is available for this agent',
      hookPath,
      warning: null
    }
  }

  let result: string
  try {
    const existing = readIfPresent(hookPath)
    const existingVersion = existing === null ? null : installedVersionOf(existing)
    const needsWrite = force || existing === null || existingVersion === null || existingVersion < INTEGRATION_ASSET_VERSION

    if (needsWrite) {
      mkdirSync(dirname(hookPath), { recursive: true, mode: 0o700 })
      writeFileSync(hookPath, asset.contents, { mode: 0o700 })
      // Written *and* chmod'd: `writeFileSync`'s mode is masked by the umask, and a
      // hook the agent cannot execute is an integration that silently never runs.
      chmodSync(hookPath, 0o700)
      result = existing === null ? 'installed' : 'updated'
    } else {
      result = 'unchanged'
    }
  } catch (error) {
    return { agent, installed: false, result: `could not write the hook: ${String(error)}`, hookPath, warning: null }
  }

  let warning: string | null = null
  const settingsPath = settingsPathFor(options, agent)
  if (settingsPath !== null) {
    try {
      const changed = agent === 'claude' ? writeClaudeSettings(settingsPath, hookPath) : writeOpencodeSettings(settingsPath, hookPath)
      if (changed && result === 'unchanged') result = 'updated'
    } catch (error) {
      // The hook is installed and the agent simply will not call it yet. Reporting
      // that as a total failure would hide the half that worked.
      warning = `hook installed, but ${settingsPath} could not be updated: ${String(error)}`
    }
  }

  return { agent, installed: true, result, hookPath, warning }
}

// ---------------------------------------------------------------------------
// The agents' own settings files
// ---------------------------------------------------------------------------

interface JsonObject {
  [key: string]: unknown
}

/**
 * Read a settings file as JSON, tolerating the two things these files really contain.
 *
 * A missing file is an empty object: that is a first install. A file that does not
 * parse is an *error*, not an empty object — overwriting a config we failed to
 * understand is how a user loses their permissions list.
 *
 * The cost of `JSON.parse` over a CST: comments are lost on the files that have them,
 * and key order is preserved only because V8 preserves insertion order. herdr keeps
 * the bytes exactly; we keep the data. Accepted because these files are machine-
 * written far more often than hand-commented, and the alternative is a JSONC CST
 * dependency for one call site.
 */
function readSettings(path: string): JsonObject {
  const raw = readIfPresent(path)
  if (raw === null || raw.trim().length === 0) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings file is not a JSON object')
  }
  return parsed as JsonObject
}

function writeSettings(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {}
}

/** The command string an agent runs. Quoted, because a hook dir may contain a space. */
export function hookCommand(hookPath: string, action: string): string {
  return `'${hookPath.replace(/'/gu, `'\\''`)}' ${action}`
}

/**
 * claude's `hooks` shape: event -> [{ matcher?, hooks: [{ type, command }] }].
 *
 * Returns whether anything changed, which is what makes idempotence observable.
 */
export function writeClaudeSettings(path: string, hookPath: string): boolean {
  const settings = readSettings(path)
  const hooks = asObject(settings['hooks'])
  let changed = false

  for (const { event, action, matcher } of CLAUDE_HOOKS) {
    const command = hookCommand(hookPath, action)
    const entries = asArray(hooks[event])
    const desired: JsonObject = {
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: 'command', command }]
    }

    // Already exactly right: leave the array untouched. This is the second half of
    // idempotence — the first is not rewriting the hook file itself.
    if (entries.some((entry) => JSON.stringify(entry) === JSON.stringify(desired))) continue

    // Otherwise drop our own stale entries — a previous install at a different path,
    // or this event with a different action — and leave every entry that is not ours.
    const kept = entries.filter((entry) => !ownsHookEntry(entry, hookPath))
    kept.push(desired)
    hooks[event] = kept
    changed = true
  }

  if (!changed) return false
  settings['hooks'] = hooks
  writeSettings(path, settings)
  return true
}

/**
 * Whether a settings entry is one we wrote.
 *
 * Judged by the *file name* we own, not by the current hook path. Matching the path
 * would fail to recognize our own entry from an install at a different data root —
 * leaving two entries behind, so the agent runs the hook twice and reports every
 * state twice. The file name is ours by construction; nothing else writes it.
 */
function ownsHookEntry(entry: unknown, hookPath: string): boolean {
  const ownName = hookPath.slice(hookPath.lastIndexOf('/') + 1)
  return asArray(asObject(entry)['hooks']).some((hook) => {
    const command = asObject(hook)['command']
    return typeof command === 'string' && (command.includes(ownName) || command.includes(hookPath))
  })
}

/** opencode's plugin list is a flat array of command strings. */
export function writeOpencodeSettings(path: string, hookPath: string): boolean {
  const settings = readSettings(path)
  const existing = asArray(settings['plugin']).filter((entry) => typeof entry === 'string')
  const ours = hookCommand(hookPath, 'session')
  if (existing.includes(ours)) return false
  settings['plugin'] = [...existing.filter((entry) => !String(entry).includes(hookPath)), ours]
  writeSettings(path, settings)
  return true
}

function readIfPresent(path: string): string | null {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
