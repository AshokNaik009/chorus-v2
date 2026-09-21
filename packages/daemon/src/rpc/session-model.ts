/**
 * The 28 session-model methods.
 *
 * Each handler does three things and no more: read params, turn them into a `core`
 * action or a `core` query, and shape the answer. The model logic is in `core`, the
 * PTYs are in `SessionRuntime`, and the routing is in `socket.ts`. If a handler here
 * grows a branch about *what should happen*, that branch belongs in `actions.ts`.
 *
 * Method names are herdr's client-shell endpoint names
 * (`src/server/client_commands.rs`), so `SESSION_MODEL_METHODS` in the protocol package
 * can be checked against them and against
 * `tests/fixtures/endpoint-method-shapes-v1.json`.
 */

import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ErrorCodes,
  type MutationResult,
  type PaneCopyMotionResult,
  type PaneCopySearchResult,
  type PaneEditScrollbackResult,
  type PaneLinkActivateResult,
  type PaneSelectionReadResult,
  type StateGetResult
} from '@leap-chorus/protocol'
import {
  applyMotion,
  linkAt,
  readSelection,
  searchContent,
  type Action,
  type ActionResult,
  type CopyMotion,
  type PaneDirection,
  type SplitDirection,
  type ZoomMode
} from '@leap-chorus/core'
import type { SessionRuntime } from '../runtime.js'
import type { SessionManager } from '../sessions.js'
import {
  RequestError,
  optionalBoolean,
  optionalEnum,
  optionalEnv,
  optionalNumber,
  optionalRange,
  optionalString,
  optionalStringArray,
  optionalViewport,
  requireBooleanPath,
  requireEnum,
  requireIndex,
  requireNumber,
  requirePoint,
  requireString,
  requireStringArray,
  type Params
} from './params.js'

const PANE_DIRECTIONS = ['left', 'right', 'up', 'down'] as const satisfies readonly PaneDirection[]
const SPLIT_DIRECTIONS = ['right', 'down'] as const satisfies readonly SplitDirection[]
const ZOOM_MODES = ['toggle', 'on', 'off'] as const satisfies readonly ZoomMode[]
const COPY_MOTIONS = [
  'line_end',
  'first_non_blank',
  'next_word_start',
  'previous_word_start',
  'next_word_end',
  'next_big_word_start',
  'previous_big_word_start',
  'next_big_word_end',
  'previous_paragraph',
  'next_paragraph'
] as const satisfies readonly CopyMotion[]

export interface ModelContext {
  readonly runtime: SessionRuntime
  readonly sessions: SessionManager
}

/**
 * Turn an action result into the wire's `MutationResult`.
 *
 * A rejected action is an *error*, not a quiet `changed: false`: a caller that asked to
 * close a pane that does not exist has a bug, and hiding it behind a success would make
 * that bug show up three actions later as a missing pane.
 */
function mutation(result: ActionResult): MutationResult {
  if (!result.ok) throw new RequestError(ErrorCodes.actionRejected, result.error ?? 'action rejected')
  return {
    revision: result.revision,
    changed: result.changed,
    ...(result.created?.workspaceId === undefined ? {} : { workspaceId: result.created.workspaceId }),
    ...(result.created?.tabId === undefined ? {} : { tabId: result.created.tabId }),
    ...(result.created?.paneId === undefined ? {} : { paneId: result.created.paneId })
  }
}

function dispatch(context: ModelContext, action: Action): MutationResult {
  return mutation(context.runtime.dispatch(action))
}

/** Pane content as text, scrollback included. Errors when the pane has no session. */
function paneLines(context: ModelContext, paneId: string): string[] {
  const pane = context.runtime.state.panes.get(paneId)
  if (!pane) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  if (pane.sessionId === null) return []
  const session = context.sessions.get(pane.sessionId)
  if (!session) return []
  return session.textLines()
}

export function stateGet(context: ModelContext): StateGetResult {
  return { state: context.runtime.snapshot() }
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function workspaceCreate(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'workspace.create',
    ...maybe('cwd', optionalString(params, 'cwd')),
    ...maybe('label', optionalString(params, 'label')),
    ...maybe('focus', optionalBoolean(params, 'focus')),
    ...maybe('env', optionalEnv(params, 'env')),
    ...maybe('sourceWorkspaceId', optionalString(params, 'sourceWorkspaceId')),
    ...maybe('command', optionalString(params, 'command')),
    ...maybe('args', optionalStringArray(params, 'args'))
  })
}

export function workspaceClose(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'workspace.close', workspaceId: requireString(params, 'workspaceId') })
}

export function workspaceFocus(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'workspace.focus', workspaceId: requireString(params, 'workspaceId') })
}

export function workspaceRename(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'workspace.rename',
    workspaceId: requireString(params, 'workspaceId'),
    label: optionalString(params, 'label') ?? ''
  })
}

export function workspaceMove(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'workspace.move',
    workspaceId: requireString(params, 'workspaceId'),
    insertIndex: requireIndex(params, 'insertIndex')
  })
}

export function workspaceMoveBlock(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'workspace.move_block',
    workspaceIds: requireStringArray(params, 'workspaceIds'),
    ...maybe('beforeWorkspaceId', optionalString(params, 'beforeWorkspaceId'))
  })
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export function tabCreate(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'tab.create',
    ...maybe('workspaceId', optionalString(params, 'workspaceId')),
    ...maybe('cwd', optionalString(params, 'cwd')),
    ...maybe('label', optionalString(params, 'label')),
    ...maybe('focus', optionalBoolean(params, 'focus')),
    ...maybe('env', optionalEnv(params, 'env')),
    ...maybe('command', optionalString(params, 'command')),
    ...maybe('args', optionalStringArray(params, 'args'))
  })
}

export function tabClose(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'tab.close', tabId: requireString(params, 'tabId') })
}

export function tabFocus(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'tab.focus', tabId: requireString(params, 'tabId') })
}

export function tabRename(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'tab.rename',
    tabId: requireString(params, 'tabId'),
    label: optionalString(params, 'label') ?? ''
  })
}

export function tabMove(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'tab.move',
    tabId: requireString(params, 'tabId'),
    insertIndex: requireIndex(params, 'insertIndex')
  })
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

export function paneSplit(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.split',
    direction: requireEnum(params, 'direction', SPLIT_DIRECTIONS),
    ...maybe('targetPaneId', optionalString(params, 'targetPaneId')),
    ...maybe('ratio', optionalNumber(params, 'ratio')),
    ...maybe('cwd', optionalString(params, 'cwd')),
    ...maybe('focus', optionalBoolean(params, 'focus')),
    ...maybe('command', optionalString(params, 'command')),
    ...maybe('args', optionalStringArray(params, 'args')),
    ...maybe('env', optionalEnv(params, 'env'))
  })
}

export function paneClose(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'pane.close', paneId: requireString(params, 'paneId') })
}

export function paneFocus(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, { type: 'pane.focus', paneId: requireString(params, 'paneId') })
}

export function paneFocusDirection(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.focus_direction',
    direction: requireEnum(params, 'direction', PANE_DIRECTIONS),
    ...maybe('paneId', optionalString(params, 'paneId')),
    ...maybe('viewport', optionalViewport(params))
  })
}

export function paneResize(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.resize',
    direction: requireEnum(params, 'direction', PANE_DIRECTIONS),
    ...maybe('paneId', optionalString(params, 'paneId')),
    ...maybe('amount', optionalNumber(params, 'amount')),
    ...maybe('viewport', optionalViewport(params))
  })
}

export function paneSwap(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.swap',
    ...maybe('paneId', optionalString(params, 'paneId')),
    ...maybe('direction', optionalEnum(params, 'direction', PANE_DIRECTIONS)),
    ...maybe('sourcePaneId', optionalString(params, 'sourcePaneId')),
    ...maybe('targetPaneId', optionalString(params, 'targetPaneId')),
    ...maybe('viewport', optionalViewport(params))
  })
}

export function paneZoom(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.zoom',
    ...maybe('paneId', optionalString(params, 'paneId')),
    ...maybe('mode', optionalEnum(params, 'mode', ZOOM_MODES))
  })
}

export function paneRename(context: ModelContext, params: Params): MutationResult {
  const label = params['label']
  return dispatch(context, {
    type: 'pane.rename',
    paneId: requireString(params, 'paneId'),
    label: label === undefined || label === null ? null : String(label)
  })
}

/**
 * Scroll a pane, clamped to the scrollback that exists.
 *
 * Clamped here rather than in `core` because only the runtime knows how much history a
 * pane has: `core` has never seen a terminal.
 */
export function paneScroll(context: ModelContext, params: Params): MutationResult {
  const paneId = requireString(params, 'paneId')
  const requested = Math.max(0, Math.floor(requireNumber(params, 'offsetFromBottom')))
  const pane = context.runtime.state.panes.get(paneId)
  if (!pane) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  const session = pane.sessionId === null ? undefined : context.sessions.get(pane.sessionId)
  const available = session?.emulator.scrollbackLines ?? 0
  return dispatch(context, {
    type: 'pane.scroll',
    paneId,
    offsetFromBottom: Math.min(requested, available)
  })
}

export function paneInputSet(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'pane.input.set',
    paneId: requireString(params, 'paneId'),
    rightClick: requireEnum(params, 'rightClick', ['app', 'pane'] as const)
  })
}

/**
 * The link under a cell, if any.
 *
 * Returns the URL rather than opening it. Opening a browser from the daemon would mean
 * the daemon deciding what `xdg-open` means on a machine it may not be sitting at —
 * over SSH in phase 6 the answer is emphatically the client's.
 */
export function paneLinkActivate(context: ModelContext, params: Params): PaneLinkActivateResult {
  const paneId = requireString(params, 'paneId')
  const viewportRow = Math.max(0, Math.floor(requireNumber(params, 'viewportRow')))
  const col = Math.max(0, Math.floor(requireNumber(params, 'col')))
  const pane = context.runtime.state.panes.get(paneId)
  if (!pane) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  const lines = paneLines(context, paneId)
  const session = pane.sessionId === null ? undefined : context.sessions.get(pane.sessionId)
  // The caller names a row on screen; the content array counts from the top of history.
  const base = Math.max(0, (session?.emulator.scrollbackLines ?? 0) - pane.scrollOffset)
  const hit = linkAt(lines, { row: base + viewportRow, col })
  return hit === null ? { url: null, range: null } : { url: hit.url, range: hit.range }
}

/**
 * Write a pane's scrollback somewhere an editor can open it.
 *
 * herdr opens `$EDITOR` in a new pane over the same content. That needs a pane spawned
 * with an argv the daemon assembles, which is phase 5's agent-launch machinery; until
 * then the daemon produces the file and the client decides what to do with it.
 */
export function paneEditScrollback(context: ModelContext, params: Params): PaneEditScrollbackResult {
  const paneId = requireString(params, 'paneId')
  const lines = paneLines(context, paneId)
  // Trailing blank rows are the terminal's padding, not the user's scrollback.
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').length === 0) end -= 1
  const body = lines.slice(0, end).join('\n')
  const path = join(tmpdir(), `herdr-${paneId}-${Date.now()}.txt`)
  writeFileSync(path, body.length === 0 ? '' : `${body}\n`, { mode: 0o600 })
  return { path, lines: end }
}

export function paneSelectionRead(context: ModelContext, params: Params): PaneSelectionReadResult {
  const paneId = requireString(params, 'paneId')
  const lines = paneLines(context, paneId)
  return { text: readSelection(lines, requirePoint(params, 'anchor'), requirePoint(params, 'cursor')) }
}

export function paneCopyMotion(context: ModelContext, params: Params): PaneCopyMotionResult {
  const paneId = requireString(params, 'paneId')
  const lines = paneLines(context, paneId)
  const motion = requireEnum(params, 'motion', COPY_MOTIONS)
  return { cursor: applyMotion(lines, requirePoint(params, 'cursor'), motion) }
}

export function paneCopySearch(context: ModelContext, params: Params): PaneCopySearchResult {
  const paneId = requireString(params, 'paneId')
  const lines = paneLines(context, paneId)
  const previous = optionalRange(params, 'previous')
  return {
    match: searchContent(lines, requireString(params, 'query'), {
      direction: requireEnum(params, 'direction', ['forward', 'backward'] as const),
      cursor: requirePoint(params, 'cursor'),
      ...(previous === undefined ? {} : { previous })
    })
  }
}

export function layoutSetSplitRatio(context: ModelContext, params: Params): MutationResult {
  return dispatch(context, {
    type: 'layout.set_split_ratio',
    path: requireBooleanPath(params, 'path'),
    ratio: requireNumber(params, 'ratio'),
    ...maybe('tabId', optionalString(params, 'tabId')),
    ...maybe('paneId', optionalString(params, 'paneId'))
  })
}

/** Spread a key only when it has a value, so `exactOptionalPropertyTypes` stays honest. */
function maybe<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>)
}
