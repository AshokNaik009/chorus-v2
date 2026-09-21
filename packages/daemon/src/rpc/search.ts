/**
 * Search RPCs: the file list, and content search.
 *
 * Both root themselves with `resolveRoot`, the same one `fs.list` uses, so the tree,
 * the status and the search all mean the same thing by a relative path.
 *
 * ## Two calls with deliberately different rhythms
 *
 * `search.files` is called **once**, when quick open opens, and the client filters the
 * cached list as the user types: an RPC per keystroke over a 20,000-entry list is a
 * round trip for something that is a string compare. `search.content` is the opposite
 * — one call per submit, because it reads every file under the root.
 */

import type { SearchContentResult, SearchFilesResult } from '@leap-chorus/protocol'
import type { SearchService } from '../search.js'
import { resolveRoot, type GitContext } from './git.js'
import { optionalBoolean, optionalString, requireString, type Params } from './params.js'

export interface SearchContext extends GitContext {
  readonly search: SearchService
}

export async function searchFiles(context: SearchContext, params: Params): Promise<SearchFilesResult> {
  return context.search.files(await resolveRoot(context, params))
}

export async function searchContent(context: SearchContext, params: Params): Promise<SearchContentResult> {
  const root = await resolveRoot(context, params)
  // Read before the query so a missing `query` fails on the parameter rather than on
  // whichever of the five optional ones happened to be looked at first.
  const query = requireString(params, 'query')
  return context.search.content(root, query, {
    matchCase: optionalBoolean(params, 'matchCase') ?? false,
    wholeWord: optionalBoolean(params, 'wholeWord') ?? false,
    regex: optionalBoolean(params, 'regex') ?? false,
    include: optionalString(params, 'include') ?? '',
    exclude: optionalString(params, 'exclude') ?? ''
  })
}
