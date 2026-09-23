/**
 * `preview.read` — the one RPC the embedded preview needs.
 *
 * Rooted by the caller when it says, and by `resolveRoot` — the same one `fs.list` and
 * `search.files` use — when it does not. Sharing the *function* with `fs.list` was not
 * enough: it was being called again, later, against a pane that may have moved, so the
 * tree and the preview could disagree about what a relative path meant. The root now
 * travels with the path that was computed against it.
 */

import type { PreviewResult } from '@leap-chorus/protocol'
import type { PreviewService } from '../preview.js'
import { resolveRoot, type GitContext } from './git.js'
import { optionalNumber, optionalString, requireString, type Params } from './params.js'

export interface PreviewContext extends GitContext {
  readonly preview: PreviewService
}

/**
 * Default width when the client does not say.
 *
 * `MIN_SCM_WIDTH` from the client, repeated rather than imported: the daemon does not
 * depend on the client package, and a renderer given a plausible width when it was told
 * nothing beats one given zero.
 */
const DEFAULT_WIDTH = 34

export async function previewRead(context: PreviewContext, params: Params): Promise<PreviewResult> {
  // **The caller's root wins when it sends one.** `resolveRoot` answers "where is the
  // focused pane now", which is a different question from "what is this path relative
  // to" the moment a shell `cd`s or focus moves to a pane in another repository — and
  // the tree the path came from was listed against a root the client still has. Falling
  // back keeps every existing caller working. See `PreviewReadParams.root`.
  const root = optionalString(params, 'root') ?? (await resolveRoot(context, params))
  const path = requireString(params, 'path')
  const width = optionalNumber(params, 'width') ?? DEFAULT_WIDTH
  // `bytesRead` exists for tests and is stripped here rather than at the call site, so
  // it cannot reach the wire by somebody forgetting.
  const { bytesRead: _ignored, ...result } = await context.preview.read(root, path, width)
  return result
}
