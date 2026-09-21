/**
 * Source-control RPCs.
 *
 * Every one takes a `cwd` and returns the *whole* status afterwards, rather than an
 * acknowledgement. Staging a file changes what is staged, what is unstaged and often
 * both, so a caller that had to re-read to find out would always re-read — and two
 * clients watching the same repository would disagree in between.
 */

import {
  ErrorCodes,
  type FsListResult,
  type GitBranchesResult,
  type GitStatusResult,
  type GitSuggestResult,
  type GitSyncResult
} from '@leap-chorus/protocol'
import type { FsService } from '../fs.js'
import { liveCwd } from '../cwd.js'
import type { GitService, GitStatus } from '../git.js'
import type { SuggestService } from '../suggest.js'
import {
  RequestError,
  optionalBoolean,
  optionalString,
  optionalStringArray,
  requireString,
  type Params
} from './params.js'

export interface GitContext {
  readonly git: GitService
  /** Commit-message drafting. See `suggest.ts` for why the model half is opt-in. */
  readonly suggest: SuggestService
  readonly fs: FsService
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
export async function resolveCwd(context: GitContext, params: Params): Promise<string> {
  const paneId = optionalString(params, 'paneId')
  if (paneId === undefined) return requireString(params, 'cwd')
  const input = context.paneCwdInput(paneId)
  if (input === null) throw new RequestError(ErrorCodes.paneNotFound, `no pane ${paneId}`)
  const live = input.shellPid === null ? null : await liveCwd(input.shellPid)
  return live ?? input.recorded
}

/**
 * The root a panel is looking at: the repository, or the pane's live directory.
 *
 * Phase 7 established this for the Explorer and search has to agree with it — a tree
 * rooted at the repository and a search rooted at a subdirectory would disagree about
 * what a relative path means. Outside a checkout there is no repository to root at, so
 * the shell's own directory is the answer.
 */
export async function resolveRoot(context: GitContext, params: Params): Promise<string> {
  const cwd = await resolveCwd(context, params)
  try {
    return await context.git.repoRoot(cwd)
  } catch {
    return cwd
  }
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

/**
 * List a directory under the pane's repository, or its working directory.
 *
 * Rooted at the repository when there is one, so the tree matches what source control
 * is talking about; at the shell's directory otherwise, so it still works outside a
 * checkout.
 */
export async function fsList(context: GitContext, params: Params): Promise<FsListResult> {
  const root = await resolveRoot(context, params)
  const listing = await context.fs.list(root, optionalString(params, 'path') ?? '')
  return { root, path: listing.path, entries: listing.entries }
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

export async function gitBranches(context: GitContext, params: Params): Promise<GitBranchesResult> {
  const { root, branches } = await context.git.branches(await resolveCwd(context, params))
  return { root, branches }
}

export async function gitCheckout(context: GitContext, params: Params): Promise<GitStatusResult> {
  const cwd = await resolveCwd(context, params)
  // `remote` comes from the client rather than being re-derived from the name, because
  // a local branch may legitimately be called `origin/thing` and guessing from the
  // string would check out the wrong one of the two.
  const remote = optionalBoolean(params, 'remote') ?? false
  return wire(await context.git.checkout(cwd, requireString(params, 'branch'), remote))
}

/** Pull-rebase then push. The message is git's, which is the point — see `git.ts`. */
export async function gitSync(context: GitContext, params: Params): Promise<GitSyncResult> {
  const { status, message } = await context.git.sync(await resolveCwd(context, params))
  return { status: wire(status), message }
}

/**
 * Draft a commit subject.
 *
 * `ai` defaults to **false** here as well as in the client, so a caller that forgets to
 * send it gets the offline draft rather than a subprocess. The one switch that can send
 * a working tree to a model should have to be thrown on purpose at every layer.
 */
export async function gitSuggest(context: GitContext, params: Params): Promise<GitSuggestResult> {
  const cwd = await resolveCwd(context, params)
  const status = await context.git.status(cwd)
  return context.suggest.suggest(status.root, status, optionalBoolean(params, 'ai') ?? false)
}
