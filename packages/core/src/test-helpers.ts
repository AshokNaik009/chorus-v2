/**
 * Helpers shared by `core`'s tests.
 *
 * Kept in `src` rather than a `test/` directory because they are about the model, and
 * because a helper that needs the model's internals should live next to it rather than
 * reach across a package boundary.
 */

import { placements, type PanePlacement } from './layout-tree.js'
import { DEFAULT_VIEWPORT } from './actions.js'
import type { AppState } from './state.js'

/** Pane rects of the active tab, at the default reference viewport. */
export function toLayoutRects(state: AppState): PanePlacement[] {
  const tab = state.activeTab
  if (!tab) return []
  return placements(tab.layout, DEFAULT_VIEWPORT)
}
