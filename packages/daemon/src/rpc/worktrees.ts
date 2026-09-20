/**
 * `worktree.*` and `integration.*`.
 *
 * Both are server-owned facts about the machine — a checkout on disk, a hook file the
 * agent will execute — so both are API methods rather than anything the TUI reaches
 * privately. A second client, or a script, gets the same answers.
 */

import { ErrorCodes } from '@leap-chorus/protocol'
import type {
  IntegrationInstallResult,
  IntegrationListResult,
  WorktreeCreateResult,
  WorktreeListResult,
  WorktreeOpenResult,
  WorktreeRemoveResult,
  WorktreeRecord
} from '@leap-chorus/protocol'
import type { AppState } from '@leap-chorus/core'
import type { ModelContext } from './session-model.js'
import type { WorktreeService } from '../worktree.js'
import { installIntegrations, listIntegrations, type IntegrationOptions } from '../integration/install.js'
import { canonicalPath } from '../worktree.js'
import {
  RequestError,
  optionalBoolean,
  optionalEnum,
  optionalString,
  optionalStringArray,
  requireString,
  type Params
} from './params.js'

export interface WorktreeContext extends ModelContext {
  readonly worktrees: WorktreeService
  readonly integrations: IntegrationOptions
}

/**
 * Where to look when the caller does not say.
 *
 * The focused pane's cwd, because "list the worktrees" from a client means the
 * repository the user is looking at. A daemon with no panes has no default and says
 * so, rather than searching from its own cwd — which is wherever it happened to be
 * detached from, and is nobody's repository.
 */
function defaultRepoPath(state: AppState): string {
  const pane = state.focusedPane
  if (pane === null) {
    throw new RequestError(ErrorCodes.notARepository, 'no pane is focused; pass `repo`')
  }
  return pane.cwd
}

/**
 * Attach the panes sitting in each worktree.
 *
 * Panes are matched by cwd prefix, so a pane that has `cd`-ed into a subdirectory
 * still counts as being in that worktree — which is how a user thinks about it. The
 * longest matching worktree wins, because a worktree nested inside another would
 * otherwise claim both.
 */
function withPanes(state: AppState, worktrees: readonly WorktreeRecord[]): WorktreeRecord[] {
  const byPath = new Map(worktrees.map((entry) => [entry.path, [] as string[]]))
  for (const pane of state.panes.values()) {
    // Canonical on both sides: git prints real paths, a pane's cwd is whatever the
    // user typed, and on macOS `/var/...` and `/private/var/...` are the same place.
    const cwd = canonicalPath(pane.cwd)
    let best: string | null = null
    for (const entry of worktrees) {
      if (cwd !== entry.path && !cwd.startsWith(`${entry.path}/`)) continue
      if (best === null || entry.path.length > best.length) best = entry.path
    }
    if (best !== null) byPath.get(best)?.push(pane.id)
  }
  return worktrees.map((entry) => ({ ...entry, paneIds: byPath.get(entry.path) ?? [] }))
}

export async function worktreeList(context: WorktreeContext, params: Params): Promise<WorktreeListResult> {
  const repo = optionalString(params, 'repo') ?? defaultRepoPath(context.runtime.state)
  const listed = await context.worktrees.list(repo)
  return { repo: listed.repo, worktrees: withPanes(context.runtime.state, listed.worktrees) }
}

export async function worktreeCreate(context: WorktreeContext, params: Params): Promise<WorktreeCreateResult> {
  const repoPath = optionalString(params, 'repo') ?? defaultRepoPath(context.runtime.state)
  const branch = requireString(params, 'branch')
  const path = optionalString(params, 'path')
  const base = optionalString(params, 'base')

  const created = await context.worktrees.create({
    repoPath,
    branch,
    ...(path === undefined ? {} : { path }),
    ...(base === undefined ? {} : { base })
  })
  return {
    worktree: withPanes(context.runtime.state, [created.worktree])[0] as WorktreeRecord,
    created: created.created
  }
}

/**
 * Open a worktree in a workspace (default) or a tab.
 *
 * A workspace by default because that is the unit that carries a cwd: two agents in
 * two worktrees should not be two tabs of one workspace whose label says one of them.
 */
export async function worktreeOpen(context: WorktreeContext, params: Params): Promise<WorktreeOpenResult> {
  const path = canonicalPath(requireString(params, 'path'))
  const target = optionalEnum(params, 'target', ['workspace', 'tab'] as const) ?? 'workspace'
  const command = optionalString(params, 'command')
  const args = optionalStringArray(params, 'args')

  const listed = await context.worktrees.list(path)
  const worktree = listed.worktrees.find((entry) => entry.path === path)
  if (worktree === undefined) {
    throw new RequestError(ErrorCodes.notARepository, `${path} is not a worktree of ${listed.repo}`)
  }

  // The branch names the workspace, when there is one: a detached worktree gets the
  // default numbering rather than a label saying "null".
  const label = worktree.branch === null ? {} : { label: worktree.branch }
  const result = context.runtime.dispatch(
    target === 'workspace'
      ? {
          type: 'workspace.create',
          cwd: worktree.path,
          focus: true,
          ...label,
          ...(command === undefined ? {} : { command }),
          ...(args === undefined ? {} : { args })
        }
      : { type: 'tab.create', cwd: worktree.path, focus: true, ...label }
  )
  if (!result.ok) throw new RequestError(ErrorCodes.actionRejected, result.error ?? 'could not open the worktree')

  return {
    worktree: withPanes(context.runtime.state, [worktree])[0] as WorktreeRecord,
    // Only what this call *created*. Opening into a tab creates no workspace, and
    // reporting the one it happened to land in would read as "a workspace was made".
    workspaceId: target === 'workspace' ? (result.created?.workspaceId ?? null) : null,
    tabId: result.created?.tabId ?? null,
    paneId: result.created?.paneId ?? null
  }
}

export async function worktreeRemove(context: WorktreeContext, params: Params): Promise<WorktreeRemoveResult> {
  const path = canonicalPath(requireString(params, 'path'))
  const force = optionalBoolean(params, 'force')
  const deleteBranch = optionalBoolean(params, 'deleteBranch')

  // Panes still living in it are a refusal, not a warning. Removing the directory out
  // from under a running agent leaves it writing into a deleted tree.
  const inUse = [...context.runtime.state.panes.values()].filter((pane) => {
    const cwd = canonicalPath(pane.cwd)
    return cwd === path || cwd.startsWith(`${path}/`)
  })
  if (inUse.length > 0 && force !== true) {
    return {
      removed: false,
      reason: `${inUse.length} pane(s) are still in this worktree; close them or pass force`,
      branchDeleted: false
    }
  }

  return context.worktrees.remove({
    path,
    ...(force === undefined ? {} : { force }),
    ...(deleteBranch === undefined ? {} : { deleteBranch })
  })
}

export function integrationList(context: WorktreeContext): IntegrationListResult {
  return { integrations: listIntegrations(context.integrations) }
}

export function integrationInstall(context: WorktreeContext, params: Params): IntegrationInstallResult {
  const agents = optionalStringArray(params, 'agents')
  const force = optionalBoolean(params, 'force')
  return {
    outcomes: installIntegrations(context.integrations, {
      ...(agents === undefined ? {} : { agents }),
      ...(force === undefined ? {} : { force })
    })
  }
}
