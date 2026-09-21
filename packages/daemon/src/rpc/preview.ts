/**
 * `preview.read` — the one RPC the embedded preview needs.
 *
 * Rooted with `resolveRoot`, the same one `fs.list` and `search.files` use, so a
 * relative path means one thing across the whole dock. A preview that resolved paths
 * its own way would show a different file than the row the cursor is on the moment the
 * pane's `cd` and the repository root disagree.
 */

import type { PreviewResult } from '@leap-chorus/protocol'
import type { PreviewService } from '../preview.js'
import { resolveRoot, type GitContext } from './git.js'
import { optionalNumber, requireString, type Params } from './params.js'

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
  const root = await resolveRoot(context, params)
  const path = requireString(params, 'path')
  const width = optionalNumber(params, 'width') ?? DEFAULT_WIDTH
  // `bytesRead` exists for tests and is stripped here rather than at the call site, so
  // it cannot reach the wire by somebody forgetting.
  const { bytesRead: _ignored, ...result } = await context.preview.read(root, path, width)
  return result
}
