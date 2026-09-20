/**
 * Source-control RPCs.
 *
 * Every one takes a `cwd` and returns the *whole* status afterwards, rather than an
 * acknowledgement. Staging a file changes what is staged, what is unstaged and often
 * both, so a caller that had to re-read to find out would always re-read — and two
 * clients watching the same repository would disagree in between.
 */

import { ErrorCodes, type GitStatusResult } from '@leap-chorus/protocol'
import { liveCwd } from '../cwd.js'
import type { GitService, GitStatus } from '../git.js'
import { RequestError, optionalString, optionalStringArray, requireString, type Params } from './params.js'

export interface GitContext {
  readonly git: GitService
  /** The pane's shell pid and recorded cwd, for resolving `paneId`. */
  readonly paneCwdInput: (paneId: string) => { shellPid: number | null; recorded: string } | null
}

/**
 * Where the caller means.
 *
 * `paneId` is preferred and `cwd` is the escape hatch, because the directory a pane is
 * *in* is not the one it was spawned in — a shell that has `cd`-ed somewhere else
 * leaves `pane.cwd` untouched, and asking about the spawn directory reports the wrong
 * repository, or none. Resolved per call rather than cached on the model: `cd` sends no
 * notification, so anything stored here goes stale silently.
 */
async function resolveCwd(context: GitContext, params: Params): Promise<string> {
  const paneId = optionalString(params, 'paneId')
  if (paneId === undefined) return requireString(params, 'cwd')
  const input = context.paneCwdInput(paneId)
  if (input === null) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  const live = input.shellPid === null ? null : await liveCwd(input.shellPid)
  return live ?? input.recorded
}

/** JSON for the wire. The service's own types are already plain data. */
function wire(status: GitStatus): GitStatusResult {
  return {
    root: status.root,
    branch: status.branch,
    staged: status.staged,
    unstaged: status.unstaged,
    ahead: status.ahead,
    behind: status.behind,
    hasUpstream: status.hasUpstream
  }
}

export async function gitStatus(context: GitContext, params: Params): Promise<GitStatusResult> {
  return wire(await context.git.status(await resolveCwd(context, params)))
}

export async function gitStage(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.stage(await resolveCwd(context, params), paths))
}

export async function gitUnstage(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.unstage(await resolveCwd(context, params), paths))
}

export async function gitDiscard(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.discard(await resolveCwd(context, params), paths))
}

export async function gitCommit(context: GitContext, params: Params): Promise<GitStatusResult> {
  const cwd = await resolveCwd(context, params)
  return wire(await context.git.commit(cwd, requireString(params, 'message')))
}
