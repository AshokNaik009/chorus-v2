/**
 * A tab: one layout tree, its focused pane, and whether that pane is zoomed.
 *
 * Zoom lives on the tab rather than the pane because it is a property of the *view of
 * the layout* — exactly one pane can be zoomed, and unzooming has to restore the tree
 * that was there before, which the tree already is.
 */

import { paneIds, type LayoutNode } from './layout-tree.js'

export interface Tab {
  readonly id: string
  readonly workspaceId: string
  label: string | null
  /** Public number within the workspace, reassigned on close. */
  number: number
  layout: LayoutNode
  focusedPaneId: string
  /**
   * The pane focused before this one.
   *
   * Only a real focus move writes it, so the tree edits in `actions.ts` can move focus
   * internally without corrupting it — the same rule herdr's `set_focus` enforces. It
   * exists so that closing a pane returns you where you were rather than to whichever
   * pane happens to be first in the tree.
   */
  previousFocusedPaneId: string | null
  zoomed: boolean
  readonly createdAt: number
}

export interface CreateTabOptions {
  readonly id: string
  readonly workspaceId: string
  readonly layout: LayoutNode
  readonly focusedPaneId: string
  readonly label?: string | null
  readonly number?: number
  readonly createdAt?: number
}

export function createTab(options: CreateTabOptions): Tab {
  return {
    id: options.id,
    workspaceId: options.workspaceId,
    label: options.label ?? null,
    number: options.number ?? 1,
    layout: options.layout,
    focusedPaneId: options.focusedPaneId,
    previousFocusedPaneId: null,
    zoomed: false,
    createdAt: options.createdAt ?? 0
  }
}

/** Move focus, remembering what was left. A no-op move does not disturb the memory. */
export function focusPaneInTab(tab: Tab, paneId: string): boolean {
  if (tab.focusedPaneId === paneId) return false
  tab.previousFocusedPaneId = tab.focusedPaneId
  tab.focusedPaneId = paneId
  return true
}

export function tabPaneIds(tab: Tab): string[] {
  return paneIds(tab.layout)
}

export function tabDisplayName(tab: Tab, fallback: string): string {
  if (tab.label !== null && tab.label.length > 0) return tab.label
  return fallback
}
