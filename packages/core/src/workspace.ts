/**
 * A workspace: an ordered list of tabs and the one that is active.
 *
 * herdr's workspace also carries worktree membership, agent aggregation and metadata
 * tokens. Those are phase 5; what is here is the organizational shape they hang off.
 */

export interface Workspace {
  readonly id: string
  label: string | null
  /** Public number, 1-based, reassigned when workspaces are closed or reordered. */
  number: number
  /** The directory new tabs and panes inherit unless told otherwise. */
  readonly cwd: string
  tabIds: string[]
  activeTabId: string
  readonly createdAt: number
}

export interface CreateWorkspaceOptions {
  readonly id: string
  readonly cwd: string
  readonly activeTabId: string
  readonly tabIds?: readonly string[]
  readonly label?: string | null
  readonly number?: number
  readonly createdAt?: number
}

export function createWorkspace(options: CreateWorkspaceOptions): Workspace {
  return {
    id: options.id,
    label: options.label ?? null,
    number: options.number ?? 1,
    cwd: options.cwd,
    tabIds: [...(options.tabIds ?? [options.activeTabId])],
    activeTabId: options.activeTabId,
    createdAt: options.createdAt ?? 0
  }
}

export function workspaceDisplayName(workspace: Workspace, fallback: string): string {
  if (workspace.label !== null && workspace.label.length > 0) return workspace.label
  return fallback
}
