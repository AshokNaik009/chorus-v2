/**
 * The eight Source Control drawers, as collapsible sections under the changes list.
 *
 * herdr-sidebar's `Drawer` / `DrawerPanel` (`src/scm_app.rs`, MIT), reduced to what a
 * docked column can carry. See `NOTICE`.
 *
 * ## This holds display, and the daemon holds git
 *
 * Every row arrives structured — a commit has a `hash` field, a worktree has a `path`
 * field — so nothing here ever reads a value back out of the text it drew. That is the
 * one rule this file exists to keep: herdr-sidebar's `parse_drawer_ref` recovers a
 * commit hash by scanning the rendered line for a hex-looking token, which it has to
 * do because `git.rs` hands it `Vec<String>`. We control both ends, so we do not.
 *
 * What *does* live here is the two display rules that survive from upstream, both of
 * them about a 34-column pane being unforgiving:
 *
 * - `prettyWorktree` shows the folder's name and its branch, not the absolute path,
 *   which upstream's comment says "clipped uselessly in a narrow pane".
 * - `prettyRemoteUrl` renders `git@host:owner/repo.git` and
 *   `https://host/owner/repo.git` alike as `owner/repo`, and a local-path remote as
 *   its folder name.
 *
 * ## Collapsed by default, fetched on expand, cached never
 *
 * Eight `git` invocations on every status refresh, in a panel that already runs one,
 * is how a sidebar becomes the reason a repository feels slow. A drawer holds rows
 * only while it is open: collapsing throws them away, and expanding asks again.
 */

import type { GitDrawerActionId, GitDrawerId, GitDrawerResult, GitDrawerRow } from '@leap-chorus/protocol'
import { stringWidth, truncate } from '@leap-chorus/tui'
import type { MenuItem } from './prompt.js'

/** Display order, which is herdr-sidebar's. */
export const DRAWER_ORDER: readonly GitDrawerId[] = [
  'graph',
  'commits',
  'fileHistory',
  'branches',
  'worktrees',
  'remotes',
  'stashes',
  'tags'
]

const TITLES: Readonly<Record<GitDrawerId, string>> = {
  graph: 'Graph',
  commits: 'Commits',
  fileHistory: 'File History',
  branches: 'Branches',
  worktrees: 'Worktrees',
  remotes: 'Remotes',
  stashes: 'Stashes',
  tags: 'Tags'
}

export function drawerTitle(id: GitDrawerId): string {
  return TITLES[id]
}

interface DrawerState {
  expanded: boolean
  /** Null while nothing has come back yet — collapsed, or in flight. */
  rows: readonly GitDrawerRow[] | null
  note: string | null
  error: string | null
  loading: boolean
}

function emptyState(): DrawerState {
  return { expanded: false, rows: null, note: null, error: null, loading: false }
}

/** A line the panel draws: the drawer's own header, one of its rows, or its reason. */
export type DrawerLine =
  | { readonly kind: 'drawer'; readonly id: GitDrawerId; readonly text: string }
  | { readonly kind: 'drawer-row'; readonly id: GitDrawerId; readonly row: GitDrawerRow; readonly text: string }
  | { readonly kind: 'drawer-note'; readonly id: GitDrawerId; readonly text: string }

export class DrawersPanel {
  private readonly states = new Map<GitDrawerId, DrawerState>()

  private state(id: GitDrawerId): DrawerState {
    const found = this.states.get(id)
    if (found !== undefined) return found
    const fresh = emptyState()
    this.states.set(id, fresh)
    return fresh
  }

  isExpanded(id: GitDrawerId): boolean {
    return this.state(id).expanded
  }

  /** Which drawers are open, so `r` can re-fetch exactly those and nothing else. */
  expandedIds(): GitDrawerId[] {
    return DRAWER_ORDER.filter((id) => this.isExpanded(id))
  }

  /**
   * Open or close a drawer. Returns true when the caller should fetch it.
   *
   * Closing drops the rows rather than keeping them for next time: `git.ts`'s standing
   * rule is that nothing is cached, and rows held across a collapse would be a list of
   * commits from before the rebase the user just ran in the pane behind this one.
   */
  toggle(id: GitDrawerId): boolean {
    const state = this.state(id)
    if (state.expanded) {
      this.states.set(id, emptyState())
      return false
    }
    this.states.set(id, { expanded: true, rows: null, note: null, error: null, loading: true })
    return true
  }

  /** Open a drawer that may already be open, and say whether a fetch is needed. */
  expand(id: GitDrawerId): boolean {
    if (this.isExpanded(id)) return false
    return this.toggle(id)
  }

  collapse(id: GitDrawerId): boolean {
    if (!this.isExpanded(id)) return false
    this.states.set(id, emptyState())
    return true
  }

  /** Mark an open drawer as in flight again, for `r`. */
  reload(id: GitDrawerId): void {
    const state = this.state(id)
    if (!state.expanded) return
    state.loading = true
    state.error = null
  }

  adopt(result: GitDrawerResult): void {
    const state = this.state(result.drawer)
    // A reply for a drawer that has since been closed is dropped: adopting it would
    // re-open a section the user collapsed while the call was in flight.
    if (!state.expanded) return
    state.rows = result.rows
    state.note = result.note
    state.error = null
    state.loading = false
  }

  fail(id: GitDrawerId, message: string): void {
    const state = this.state(id)
    if (!state.expanded) return
    state.rows = []
    state.note = null
    state.error = message
    state.loading = false
  }

  /** Everything the panel should draw, headers included, in display order. */
  lines(): DrawerLine[] {
    const lines: DrawerLine[] = []
    for (const id of DRAWER_ORDER) {
      const state = this.state(id)
      const count = state.rows === null ? null : state.rows.filter((row) => row.kind !== 'rail').length
      const marker = state.expanded ? '▾' : '▸'
      const suffix = state.expanded && count !== null ? ` (${count})` : ''
      lines.push({ kind: 'drawer', id, text: `${marker} ${drawerTitle(id)}${suffix}` })
      if (!state.expanded) continue
      if (state.loading) {
        lines.push({ kind: 'drawer-note', id, text: 'loading…' })
        continue
      }
      if (state.error !== null) {
        lines.push({ kind: 'drawer-note', id, text: state.error })
        continue
      }
      if (state.note !== null) {
        lines.push({ kind: 'drawer-note', id, text: state.note })
      }
      for (const row of state.rows ?? []) {
        lines.push({ kind: 'drawer-row', id, row, text: rowText(row) })
      }
      // An empty drawer says so. No stashes and no tags is the normal state of most
      // repositories, and a header with nothing under it reads as a failed fetch.
      if ((state.rows ?? []).length === 0 && state.note === null) {
        lines.push({ kind: 'drawer-note', id, text: 'empty' })
      }
    }
    return lines
  }
}

/**
 * What a row says on screen.
 *
 * Every field comes from the wire. The rail is git's own `--graph` art, drawn exactly
 * as it arrived — PHASE-11 is explicit that drawing our own DAG is a project and not a
 * row.
 */
export function rowText(row: GitDrawerRow): string {
  switch (row.kind) {
    case 'commit':
      return `${row.rail}${row.short} ${row.subject}`
    case 'rail':
      return row.rail
    case 'branch':
      return `${row.current ? '* ' : '  '}${row.name}`
    case 'worktree':
      return prettyWorktree(row)
    case 'remote':
      return `${row.name}  ${prettyRemoteUrl(row.url)}`
    case 'stash':
      return `${row.index}  ${row.subject}`
    case 'tag':
      return row.name
  }
}

/**
 * A row, fitted to the columns it actually has.
 *
 * PHASE-11's criterion 8: a remote and a worktree must survive 34 columns *with the
 * part that identifies them still on screen*. Plain truncation loses exactly that, and
 * in opposite directions — a remote's `owner/repo` is at the end of its row and a
 * worktree's folder name is at the start — so each one drops the half that is
 * recoverable rather than the half that is not:
 *
 * ```
 *   origin  some-org/some-repository      →  …me-org/some-repository
 *   * leap-chorus-feature ⎇ feature       →  * leap-chorus-feature
 * ```
 *
 * Everything else truncates from the right, because everything else leads with what
 * identifies it: a commit with its short hash, a branch and a tag with their names.
 */
export function fitRowText(row: GitDrawerRow, width: number): string {
  if (width <= 0) return ''
  const full = rowText(row)
  if (stringWidth(full) <= width) return full
  if (row.kind === 'remote') {
    // The name is the droppable half: it is `origin` in almost every repository, and
    // the URL is what says which repository this is.
    return tailOf(prettyRemoteUrl(row.url), width)
  }
  if (row.kind === 'worktree') {
    const mark = row.primary ? '* ' : '  '
    const named = `${mark}${row.name}`
    // The branch is the droppable half: two worktrees of one repository are told apart
    // by their folders, and the branch is one keystroke away in the row's menu.
    return stringWidth(named) <= width ? named : `${mark}${tailOf(row.name, Math.max(0, width - mark.length))}`
  }
  return truncate(full, width)
}

/** Keep the end of a string, marking the cut — `…me-org/some-repository`. */
function tailOf(text: string, width: number): string {
  if (width <= 0) return ''
  if (stringWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const char of [...text].reverse()) {
    const charWidth = stringWidth(char)
    if (used + charWidth > width - 1) break
    out = `${char}${out}`
    used += charWidth
  }
  return `…${out}`
}

/**
 * A worktree as a folder name and a branch.
 *
 * `pretty_worktree_line` upstream, and the reason it exists is the reason it is kept:
 * an absolute path in a 34-column pane is a column of truncation. A detached worktree
 * shows its short head instead, and one with neither shows just the folder.
 */
export function prettyWorktree(row: { name: string; branch: string | null; head: string | null; primary: boolean }): string {
  const mark = row.primary ? '* ' : '  '
  if (row.branch !== null && row.branch.length > 0) return `${mark}${row.name} ⎇ ${row.branch}`
  if (row.head !== null && row.head.length > 0) return `${mark}${row.name} @ ${row.head.slice(0, 7)}`
  return `${mark}${row.name}`
}

/**
 * `owner/repo` from a remote URL, whatever spelling it arrived in.
 *
 * `pretty_remote_url` upstream. `git@github.com:owner/repo.git` and
 * `https://github.com/owner/repo.git` are the same two words, and those two words are
 * the only part that identifies a remote in a narrow pane. Anything that is not a URL
 * — a local path, which is how a worktree-shaped test fixture spells its origin —
 * renders as its folder name for the same reason.
 */
export function prettyRemoteUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/u, '')
  if (trimmed.length === 0) return ''
  const withoutGit = trimmed.replace(/\.git$/u, '')
  // scp-like: `git@host:owner/repo`. The colon, not a scheme, is what marks it.
  const scp = /^[^/\s]+@[^/:\s]+:(.+)$/u.exec(withoutGit)
  const path = scp !== null ? (scp[1] ?? '') : stripScheme(withoutGit)
  const parts = path.split('/').filter((part) => part.length > 0)
  if (parts.length === 0) return withoutGit
  if (parts.length === 1) return parts[0] as string
  return `${parts[parts.length - 2] as string}/${parts[parts.length - 1] as string}`
}

function stripScheme(url: string): string {
  const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]*)\/(.*)$/u.exec(url)
  // A scheme means the authority is a host, so it is dropped; a bare path keeps
  // everything, and `parts.slice(-2)` above turns `/srv/git/repo` into `git/repo`.
  return scheme !== null ? (scheme[2] ?? '') : url
}

/**
 * The context menu for one row, by row type.
 *
 * PHASE-11's table, entry for entry. An `…` suffix means the entry asks first, and
 * herdr-sidebar is consistent about it: every destructive entry has one, and so does
 * every one here. The ids are consumed by `app.ts`, which owns the calls.
 */
export function drawerMenu(row: GitDrawerRow): MenuItem[] {
  switch (row.kind) {
    case 'commit':
      return [
        { label: 'Show Changes', id: 'show' },
        { label: 'Checkout (Detached)', id: 'checkout' },
        { label: 'Cherry-Pick', id: 'cherry-pick' },
        { label: 'Revert', id: 'revert' },
        { label: 'Reset Current Branch Here…', id: 'reset' },
        { label: 'Copy Hash', id: 'copy' }
      ]
    case 'branch':
      return row.current
        ? [
            { label: 'Show Tip Commit', id: 'show' },
            { label: 'Copy Branch Name', id: 'copy' }
          ]
        : [
            { label: 'Checkout Branch', id: 'checkout' },
            { label: 'Merge into Current Branch', id: 'merge' },
            { label: 'Delete Branch…', id: 'delete' },
            { label: 'Copy Branch Name', id: 'copy' }
          ]
    case 'stash':
      return [
        { label: 'Show Changes', id: 'show' },
        { label: 'Apply Stash', id: 'apply' },
        { label: 'Pop Stash', id: 'pop' },
        { label: 'Drop Stash…', id: 'drop' }
      ]
    case 'remote':
      return [
        { label: 'Fetch', id: 'fetch' },
        { label: 'Copy URL', id: 'copy' }
      ]
    case 'tag':
      return [
        { label: 'Show Changes', id: 'show' },
        { label: 'Checkout Tag', id: 'checkout' },
        { label: 'Delete Tag…', id: 'delete' },
        { label: 'Copy Tag Name', id: 'copy' }
      ]
    case 'worktree':
      return [
        // herdr-sidebar's entry is "Reveal in File Explorer". There is no file explorer
        // in a terminal multiplexer and no GUI to hand a path to, so the same intent —
        // *go and look at it* — is a pane in that directory, which is what
        // `worktree.open` has done since phase 5. Recorded as a divergence.
        { label: 'Open Worktree', id: 'open' },
        { label: 'Copy Path', id: 'copy' },
        // The primary tree is refused by `worktree.remove` with its own message, so the
        // entry stays rather than disappearing from one row of a list.
        { label: 'Remove Worktree…', id: 'remove' }
      ]
    case 'rail':
      return []
  }
}

/** What `Copy …` puts on the clipboard, or null for a row with no copy entry. */
export function copyTarget(row: GitDrawerRow): { text: string; what: string } | null {
  switch (row.kind) {
    case 'commit':
      return { text: row.hash, what: 'hash' }
    case 'branch':
      return { text: row.name, what: 'branch name' }
    case 'remote':
      return { text: row.url, what: 'remote URL' }
    case 'tag':
      return { text: row.name, what: 'tag name' }
    case 'worktree':
      return { text: row.path, what: 'path' }
    default:
      return null
  }
}

/**
 * What a menu entry means, as data.
 *
 * The whole menu table resolves to one of these, and `app.ts` does nothing but execute
 * it. That is what makes PHASE-11's sixth criterion checkable rather than hoped for:
 * "every destructive action confirms first" is the statement that every entry whose
 * label ends in `…` returns a command carrying a `confirm`, and a test can read both
 * halves off this function instead of driving a dialog.
 */
export type DrawerCommand =
  /** `git <args>` in a pager pane. Never a diff viewer of our own. */
  | { readonly kind: 'show'; readonly args: readonly string[] }
  /** `git.drawerAction`. `confirm` is non-null exactly for the `…` entries. */
  | {
      readonly kind: 'action'
      readonly action: GitDrawerActionId
      readonly ref: string
      readonly confirm: { readonly title: string; readonly detail: string } | null
      /** Shown before the call, for the one action that talks to a network. */
      readonly pending?: string
    }
  /** `git.checkout` — the branch picker's RPC, not a second one. */
  | { readonly kind: 'checkout'; readonly branch: string; readonly remote: boolean }
  | { readonly kind: 'worktree-open'; readonly path: string }
  | {
      readonly kind: 'worktree-remove'
      readonly path: string
      readonly name: string
      readonly confirm: { readonly title: string; readonly detail: string }
    }
  | { readonly kind: 'copy'; readonly text: string; readonly what: string }

export function drawerCommand(row: GitDrawerRow, menuId: string): DrawerCommand | null {
  if (menuId === 'copy') {
    const target = copyTarget(row)
    return target === null ? null : { kind: 'copy', text: target.text, what: target.what }
  }
  switch (row.kind) {
    case 'commit':
      switch (menuId) {
        case 'show':
          return { kind: 'show', args: ['show', row.hash] }
        case 'checkout':
          return { kind: 'action', action: 'commit.checkout', ref: row.hash, confirm: null }
        case 'cherry-pick':
          return { kind: 'action', action: 'commit.cherryPick', ref: row.hash, confirm: null }
        case 'revert':
          return { kind: 'action', action: 'commit.revert', ref: row.hash, confirm: null }
        case 'reset':
          return {
            kind: 'action',
            action: 'commit.reset',
            ref: row.hash,
            confirm: {
              title: 'Reset current branch here?',
              // What `--mixed` actually does, said in the two clauses that differ from
              // what people fear when they read the word reset.
              detail: `${row.short} — the branch and the index move; your files do not`
            }
          }
        default:
          return null
      }
    case 'branch':
      switch (menuId) {
        case 'show':
          return { kind: 'show', args: ['show', row.name] }
        case 'checkout':
          return { kind: 'checkout', branch: row.name, remote: row.remote }
        case 'merge':
          return { kind: 'action', action: 'branch.merge', ref: row.name, confirm: null }
        case 'delete':
          return {
            kind: 'action',
            action: 'branch.delete',
            ref: row.name,
            confirm: { title: 'Delete this branch?', detail: `${row.name} — refused if it is not merged` }
          }
        default:
          return null
      }
    case 'stash':
      switch (menuId) {
        case 'show':
          return { kind: 'show', args: ['stash', 'show', '-p', row.ref] }
        case 'apply':
          return { kind: 'action', action: 'stash.apply', ref: row.ref, confirm: null }
        case 'pop':
          return { kind: 'action', action: 'stash.pop', ref: row.ref, confirm: null }
        case 'drop':
          return {
            kind: 'action',
            action: 'stash.drop',
            ref: row.ref,
            confirm: { title: 'Drop this stash?', detail: `${row.ref} — ${row.subject}` }
          }
        default:
          return null
      }
    case 'remote':
      return menuId === 'fetch'
        ? {
            kind: 'action',
            action: 'remote.fetch',
            ref: row.name,
            confirm: null,
            pending: `fetching ${row.name}…`
          }
        : null
    case 'tag':
      switch (menuId) {
        case 'show':
          return { kind: 'show', args: ['show', row.name] }
        case 'checkout':
          return { kind: 'action', action: 'tag.checkout', ref: row.name, confirm: null }
        case 'delete':
          return {
            kind: 'action',
            action: 'tag.delete',
            ref: row.name,
            confirm: { title: 'Delete this tag?', detail: `${row.name} — locally; the remote keeps its copy` }
          }
        default:
          return null
      }
    case 'worktree':
      switch (menuId) {
        case 'open':
          return { kind: 'worktree-open', path: row.path }
        case 'remove':
          return {
            kind: 'worktree-remove',
            path: row.path,
            name: row.name,
            confirm: { title: 'Remove this worktree?', detail: `${row.name} — ${row.path}` }
          }
        default:
          return null
      }
    case 'rail':
      return null
  }
}
