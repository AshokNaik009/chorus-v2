/**
 * The agent methods: report, explain, read, reload.
 *
 * Three of the four exist for the *development* loop rather than for the UI, and that
 * is deliberate. Detection rules go stale the day an agent ships a new spinner, and the
 * only thing that makes a manifest better than hard-coded matching is being able to see
 * what the engine saw and fix it without a release:
 *
 * ```
 * agent.read    <pane>   # exactly the text detection ran against
 * agent.explain <pane>   # every rule, whether it fired, and the region it looked at
 * ...edit ~/.config/leap-chorus/agent-detection/<agent>.toml...
 * agent.reload_manifests # without restarting the daemon or losing the pane
 * ```
 *
 * That is herdr's loop, and it is the reason the manifest design was worth porting.
 */

import { ErrorCodes } from '@leap-chorus/protocol'
import { themeByName } from '@leap-chorus/core'
import type {
  AgentExplainResult,
  AgentReadResult,
  AgentReloadManifestsResult,
  AgentReportResult,
  ConfigSetResult,
  ConfigSetThemeResult,
  WireAgentStatus
} from '@leap-chorus/protocol'
import type { ModelContext } from './session-model.js'
import {
  RequestError,
  optionalEnum,
  optionalString,
  optionalStringArray,
  requireNumber,
  requireString,
  type Params
} from './params.js'

const AGENT_STATES = ['idle', 'working', 'blocked', 'unknown', 'done'] as const satisfies readonly WireAgentStatus[]

/** States an integration may claim. `done` is not among them: it is a process fact. */
const REPORTABLE_STATES = ['idle', 'working', 'blocked', 'unknown'] as const

export function agentReport(context: ModelContext, params: Params): AgentReportResult {
  const paneId = requireString(params, 'paneId')
  // `source` is required but unused for routing: it names which integration is
  // speaking, which is what makes a misbehaving hook identifiable in a log.
  requireString(params, 'source')
  const agent = requireString(params, 'agent')
  const seq = requireNumber(params, 'seq')
  const state = optionalEnum(params, 'state', REPORTABLE_STATES)
  const agentSessionId = optionalString(params, 'agentSessionId')

  const accepted = context.runtime.noteAgentReport({
    paneId,
    agent,
    state,
    seq,
    ...(agentSessionId === undefined ? {} : { agentSessionId })
  })
  return { accepted, revision: context.runtime.state.revision }
}

export function agentRead(context: ModelContext, params: Params): AgentReadResult {
  const paneId = requireString(params, 'paneId')
  const source = optionalEnum(params, 'source', ['detection', 'viewport'] as const) ?? 'detection'
  const pane = context.runtime.state.panes.get(paneId)
  if (!pane) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  const session = pane.sessionId === null ? undefined : context.sessions.get(pane.sessionId)
  if (!session) return { paneId, text: '', oscTitle: '', oscProgress: '' }

  return {
    paneId,
    // `viewport` is what the user is looking at, scroll included; `detection` is the
    // live screen. They differ exactly when someone has scrolled up, which is the
    // reason detection never reads the viewport.
    text: source === 'viewport' ? session.textLines().join('\n') : session.detectionScreen(),
    oscTitle: session.oscTitle,
    oscProgress: session.oscProgress
  }
}

export async function agentExplain(context: ModelContext, params: Params): Promise<AgentExplainResult> {
  const paneId = requireString(params, 'paneId')
  const pane = context.runtime.state.panes.get(paneId)
  if (!pane) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)

  const input = context.runtime.detectionInputFor(paneId)
  const empty: AgentExplainResult = {
    paneId,
    agent: pane.agent,
    status: pane.agentStatus,
    source: null,
    manifestSource: null,
    manifestVersion: null,
    matchedRule: null,
    fallbackReason: null,
    warning: null,
    evaluatedRules: [],
    screen: '',
    oscTitle: ''
  }
  if (input === null) return empty

  // A fresh table, not the cached one: explain is a human asking a question now, and
  // the answer being up to 500 ms stale is exactly the confusion it exists to remove.
  let index
  try {
    index = await context.runtime.detector.processTable.fresh()
  } catch (error) {
    return { ...empty, screen: input.screen, oscTitle: input.oscTitle ?? '', warning: String(error) }
  }

  const verdict = context.runtime.detector.classify(index, input)
  const explained = context.runtime.detector.explainPane(index, input)
  const loaded = verdict.agent === null ? null : context.runtime.detector.registry.get(verdict.agent)

  return {
    paneId,
    agent: verdict.agent,
    status: verdict.status,
    source: verdict.source,
    manifestSource: loaded === null ? null : (loaded.path ?? loaded.source),
    manifestVersion: explained?.manifestVersion ?? null,
    matchedRule: explained?.matchedRule ?? null,
    fallbackReason: explained?.fallbackReason ?? null,
    warning: loaded?.warning ?? null,
    evaluatedRules: (explained?.evaluatedRules ?? []).map((rule) => ({
      id: rule.id,
      priority: rule.priority,
      region: rule.region,
      state: rule.state,
      matched: rule.matched,
      regionBytes: rule.regionBytes,
      regionPreview: rule.regionPreview
    })),
    screen: input.screen,
    oscTitle: input.oscTitle ?? ''
  }
}

export function agentReloadManifests(context: ModelContext, params: Params): AgentReloadManifestsResult {
  const agents = optionalStringArray(params, 'agents')
  const registry = context.runtime.detector.registry
  registry.reload(agents)

  return {
    manifests: (agents ?? registry.ids).flatMap((agent) => {
      const loaded = registry.get(agent)
      if (loaded === null) return []
      return [
        {
          agent,
          source: loaded.source,
          version: loaded.compiled.manifest.version,
          path: loaded.path,
          warning: loaded.warning
        }
      ]
    })
  }
}

/** Exported so the wire's state vocabulary has exactly one definition. */
export { AGENT_STATES }

/**
 * Persist a theme choice into the user's config file.
 *
 * ## A targeted edit, not a reserializer
 *
 * The config file is the user's: it has their comments, their key order, their
 * formatting. This project has a TOML *parser* and deliberately no emitter, so writing
 * the file back from the parsed object would reformat everything to make one change.
 *
 * So this edits the bytes. Three cases, in order: a `name =` line already inside
 * `[theme]` is replaced; a `[theme]` section with no `name` gains one as its first
 * key; no `[theme]` section at all gets one appended. Everything else in the file is
 * untouched, byte for byte.
 */
export function configSetTheme(context: ModelContext, params: Params): ConfigSetThemeResult {
  const theme = requireString(params, 'theme')
  if (theme.length > 0 && themeByName(theme) === null) {
    throw new RequestError(ErrorCodes.badRequest, `no such theme: ${theme}`)
  }
  return context.runtime.writeThemeName(theme)
}

/**
 * Set one boolean or number setting, by its dotted config path.
 *
 * Restricted to a named list rather than accepting any path: this writes to the
 * user's config file, and "the client may put any key anywhere" is a much larger
 * promise than the settings dialog needs. Adding a toggle means adding a row here.
 */
const WRITABLE: Readonly<Record<string, 'boolean'>> = {
  'sound.agent-done': 'boolean',
  'sound.agent-blocked': 'boolean'
}

export function configSet(context: ModelContext, params: Params): ConfigSetResult {
  const path = requireString(params, 'path')
  const kind = WRITABLE[path]
  if (kind === undefined) throw new RequestError(ErrorCodes.badRequest, `cannot set ${path}`)
  const value = params['value']
  if (typeof value !== 'boolean') throw new RequestError(ErrorCodes.badRequest, `${path} must be a boolean`)

  const [section, key] = path.split('.') as [string, string]
  return { path: context.runtime.writeSetting(section, key, value ? 'true' : 'false'), config: null }
}
