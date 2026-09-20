/**
 * Source-control RPCs.
 *
 * Every one takes a `cwd` and returns the *whole* status afterwards, rather than an
 * acknowledgement. Staging a file changes what is staged, what is unstaged and often
 * both, so a caller that had to re-read to find out would always re-read — and two
 * clients watching the same repository would disagree in between.
 */

import type { GitStatusResult } from '@leap-chorus/protocol'
import type { GitService, GitStatus } from '../git.js'
import { optionalStringArray, requireString, type Params } from './params.js'

export interface GitContext {
  readonly git: GitService
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
  return wire(await context.git.status(requireString(params, 'cwd')))
}

export async function gitStage(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.stage(requireString(params, 'cwd'), paths))
}

export async function gitUnstage(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.unstage(requireString(params, 'cwd'), paths))
}

export async function gitDiscard(context: GitContext, params: Params): Promise<GitStatusResult> {
  const paths = optionalStringArray(params, 'paths') ?? []
  return wire(await context.git.discard(requireString(params, 'cwd'), paths))
}

export async function gitCommit(context: GitContext, params: Params): Promise<GitStatusResult> {
  return wire(await context.git.commit(requireString(params, 'cwd'), requireString(params, 'message')))
}
