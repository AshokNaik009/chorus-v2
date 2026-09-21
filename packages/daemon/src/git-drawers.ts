/**
 * The eight Source Control drawers: one `git` command each, parsed into rows.
 *
 * Ported from herdr-sidebar's `Drawer` (`src/scm_app.rs`) and the queries behind it
 * (`src/git.rs`, l.350-445), MIT. See `NOTICE`.
 *
 * ## Rows are structured, and the client never parses its own display text
 *
 * herdr-sidebar's `git.rs` returns `Vec<String>` — rendered lines — and `scm_app.rs`
 * recovers what a row *points at* with `parse_drawer_ref`, which hunts the line for
 * "the first whitespace token of at least seven lowercase hex characters". That is an
 * artifact of the boundary between those two files, and we control both ends of ours,
 * so the daemon sends a tagged row with a full hash in a field and the client renders
 * it. The hex rule survives here as a **validator** (`isCommitHash`) for a ref an
 * action arrives with, which is the direction it is actually good in.
 *
 * The commands are herdr-sidebar's, with one deliberate change: where it asks for
 * `--oneline` and reads the printed line back, we ask for the same log with an explicit
 * `--format` whose fields are NUL-separated. It is the same `git log --graph`, and the
 * rails still come from git — `rail` is literally the bytes it printed before our first
 * NUL, because drawing our own DAG is a project, not a row.
 *
 * ## One git command per drawer
 *
 * Nothing here resolves the repository root first. `git log`, `git branch`, `git tag`,
 * `git stash list`, `git remote -v` and `git worktree list` all work from any directory
 * inside a checkout, so a drawer costs exactly one invocation — which is what makes
 * "fetch on expand" cheap enough to be the whole caching story. `fileHistory` is the
 * one that would have needed a root, and `:(top)` pathspec magic buys it back:
 * `-- ':(top)a file.txt'` is repo-relative wherever the shell happens to be. Verified
 * against git 2.54.0 (Apple Git-157) on 2026-09-21, including from a subdirectory and
 * with a space in the path.
 *
 * ## Nothing is cached
 *
 * `git.ts`'s standing rule. The user runs git in the pane next to this panel; a drawer
 * that remembered its rows would be wrong in the one situation that matters. Drawers
 * are collapsed by default, fetched on expand and re-fetched on `r`.
 */

import {
  ErrorCodes,
  type GitBranchRow,
  type GitCommitRow,
  type GitDrawerActionId,
  type GitDrawerId,
  type GitDrawerRow,
  type GitRemoteRow,
  type GitStashRow,
  type GitTagRow,
  type GitWorktreeRow
} from '@leap-chorus/protocol'
import { BRANCH_REF_ARGS, parseBranches } from './git.js'
import { RequestError } from './rpc/params.js'
import { parseWorktreeList, runGit, type GitRunner } from './worktree.js'

/** herdr-sidebar's `DRAWER_LIMIT` (`scm_app.rs:43`). */
export const DRAWER_LIMIT = 30

/** Display order, which is herdr-sidebar's. */
export const DRAWER_IDS: readonly GitDrawerId[] = [
  'graph',
  'commits',
  'fileHistory',
  'branches',
  'worktrees',
  'remotes',
  'stashes',
  'tags'
]

/**
 * The log format every commit drawer shares.
 *
 * Leading `%x00` so a `--graph` line always has its rail — possibly empty — before the
 * first separator, and a line git drew with *no* commit on it has no separator at all.
 * That single byte is the whole disambiguation, and it cannot collide with anything in
 * the rail art.
 */
const COMMIT_FORMAT = '--format=%x00%H%x00%h%x00%D%x00%ad%x00%s'

/** A hash is hex and at least seven characters. herdr-sidebar's rule, used to check. */
export function isCommitHash(value: string): boolean {
  return /^[0-9a-f]{7,64}$/u.test(value)
}

/** A `stash@{N}` reference, and nothing else — `N` is what `git stash` will index. */
export function isStashRef(value: string): boolean {
  return /^stash@\{\d{1,6}\}$/u.test(value)
}

/**
 * A name git will accept as a ref, refused before it reaches a command line.
 *
 * Not a security boundary — every argument here goes to `execFile`, never a shell — but
 * a leading `-` would be read as an option by `git branch -d`, and that is worth
 * refusing by name rather than discovering as a strange failure.
 */
function isRefName(value: string): boolean {
  return value.length > 0 && !value.startsWith('-') && !/[\s~^:?*[\\\0]/u.test(value)
}

export interface DrawerQuery {
  readonly drawer: GitDrawerId
  /** Repo-relative. `fileHistory` and nothing else. */
  readonly path?: string | undefined
  readonly limit?: number | undefined
}

/**
 * The argv for one drawer, or null when there is nothing to ask git.
 *
 * Exported because it is the table PHASE-11 specifies, and a test that asserts the
 * eight commands should read them from the same place the service does.
 */
export function drawerArgs(query: DrawerQuery): string[] | null {
  const limit = query.limit ?? DRAWER_LIMIT
  const count = `-${Math.max(1, Math.floor(limit))}`
  switch (query.drawer) {
    case 'graph':
      return ['log', '--graph', COMMIT_FORMAT, '--date=short', count]
    case 'commits':
      return ['log', COMMIT_FORMAT, '--date=short', count]
    case 'fileHistory': {
      const path = query.path
      if (path === undefined || path.length === 0) return null
      // `--follow` takes exactly one pathspec, and `:(top)` makes that one pathspec
      // mean the same file whichever directory the pane is sitting in.
      return ['log', '--follow', COMMIT_FORMAT, '--date=short', count, '--', `:(top)${path}`]
    }
    case 'branches':
      // The picker's query verbatim — see `GitDrawerService.rows`.
      return [...BRANCH_REF_ARGS]
    case 'worktrees':
      return ['worktree', 'list', '--porcelain']
    case 'remotes':
      return ['remote', '-v']
    case 'stashes':
      return ['stash', 'list', '--format=%H%x00%gd%x00%gs', count]
    case 'tags':
      return ['tag', '--sort=-creatordate']
  }
}

/**
 * Split a `--graph` line into the rail git drew and the commit behind it.
 *
 * Everything before the first NUL is rail, whatever it is. A line with no NUL is pure
 * art — `|\`, `|/` — and becomes a rail row, because a context menu on a piece of
 * ASCII art would be a menu about nothing.
 */
export function parseCommitLines(stdout: string): GitDrawerRow[] {
  const rows: GitDrawerRow[] = []
  for (const line of stdout.split('\n')) {
    const nul = line.indexOf('\0')
    if (nul === -1) {
      const rail = line.trimEnd()
      if (rail.length > 0) rows.push({ kind: 'rail', rail })
      continue
    }
    const rail = line.slice(0, nul)
    const fields = line.slice(nul + 1).split('\0')
    const hash = fields[0] ?? ''
    if (!isCommitHash(hash)) continue
    const row: GitCommitRow = {
      kind: 'commit',
      hash,
      short: fields[1] ?? hash.slice(0, 7),
      // `%D` is `HEAD -> main, tag: v1.0, wtb`; empty when nothing points here.
      refs: (fields[2] ?? '')
        .split(',')
        .map((ref) => ref.trim())
        .filter((ref) => ref.length > 0),
      date: fields[3] ?? '',
      subject: fields[4] ?? '',
      rail
    }
    rows.push(row)
  }
  return rows
}

/**
 * `git remote -v`, keeping the fetch URL of each remote.
 *
 * herdr-sidebar keeps the ` (fetch)` lines and drops the rest, because push and fetch
 * are the same URL in every repository anybody has, and two identical rows per remote
 * in a 34-column list is noise. Fields are tab-separated.
 */
export function parseRemotes(stdout: string): GitRemoteRow[] {
  const rows: GitRemoteRow[] = []
  for (const line of stdout.split('\n')) {
    if (!line.endsWith(' (fetch)')) continue
    const body = line.slice(0, -' (fetch)'.length)
    const tab = body.indexOf('\t')
    if (tab === -1) continue
    const name = body.slice(0, tab).trim()
    const url = body.slice(tab + 1).trim()
    if (name.length === 0) continue
    rows.push({ kind: 'remote', name, url })
  }
  return rows
}

/**
 * `git stash list --format=%H%x00%gd%x00%gs`.
 *
 * The index comes from the row's position, not from parsing `stash@{N}`: the position
 * is what `git stash apply` will act on, and the two cannot disagree if only one of
 * them is read. `ref` travels as git spelled it, which is what the command takes.
 */
export function parseStashes(stdout: string): GitStashRow[] {
  const rows: GitStashRow[] = []
  for (const line of stdout.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split('\0')
    const hash = fields[0] ?? ''
    if (!isCommitHash(hash)) continue
    const index = rows.length
    rows.push({
      kind: 'stash',
      index,
      ref: fields[1] ?? `stash@{${index}}`,
      hash,
      subject: fields[2] ?? ''
    })
  }
  return rows
}

export function parseTags(stdout: string): GitTagRow[] {
  const rows: GitTagRow[] = []
  for (const line of stdout.split('\n')) {
    const name = line.trim()
    if (name.length > 0) rows.push({ kind: 'tag', name })
  }
  return rows
}

/** The folder's own name, for a path that may end in a separator or hold spaces. */
export function worktreeName(path: string): string {
  const parts = path.replace(/[/\\]+$/u, '').split(/[/\\]/u)
  return parts[parts.length - 1] ?? path
}

function worktreeRows(stdout: string): GitWorktreeRow[] {
  // `parseWorktreeList` is `worktree.ts`'s, deliberately: PHASE-11 says this phase must
  // not grow a second way to list a worktree, and a second porcelain parser is exactly
  // that. What the drawer adds is the folder name, which is display and belongs here.
  return parseWorktreeList(stdout).map((record) => ({
    kind: 'worktree' as const,
    path: record.path,
    name: worktreeName(record.path),
    branch: record.branch,
    head: record.head,
    primary: record.primary
  }))
}

function branchRows(stdout: string): GitBranchRow[] {
  return parseBranches(stdout).map((branch) => ({
    kind: 'branch' as const,
    name: branch.name,
    current: branch.current,
    remote: branch.remote
  }))
}

/**
 * A repository with no commits, which every `log` drawer hits and none of the others.
 *
 * git exits 128 with `your current branch 'main' does not have any commits yet`.
 * Verified on 2026-09-21. Reporting that as an error would put a red `fatal:` under
 * three drawers of a repository somebody has just `git init`-ed, which is not a
 * failure — it is the first thing that is true about a new repository.
 */
function isUnbornBranch(stderr: string): boolean {
  return /does not have any commits yet|unknown revision or path not in the working tree|bad default revision/u.test(
    stderr
  )
}

export interface DrawerRows {
  readonly rows: readonly GitDrawerRow[]
  readonly note: string | null
}

export interface GitDrawerServiceOptions {
  readonly git?: GitRunner
}

export class GitDrawerService {
  private readonly git: GitRunner

  constructor(options: GitDrawerServiceOptions = {}) {
    this.git = options.git ?? runGit
  }

  /**
   * One drawer's rows.
   *
   * Runs exactly one `git` command, or none at all when there is nothing to ask —
   * `fileHistory` with no file selected returns its reason rather than an empty list,
   * because an empty list there reads as "this file has no history", which is a
   * different and wrong statement.
   */
  async rows(cwd: string, query: DrawerQuery): Promise<DrawerRows> {
    const args = drawerArgs(query)
    if (args === null) {
      return { rows: [], note: 'select a file to see its history' }
    }
    const result = await this.git(args, cwd)
    if (result.code !== 0) {
      const said = result.stderr.trim()
      if (isUnbornBranch(said)) return { rows: [], note: 'no commits yet' }
      throw new RequestError(ErrorCodes.gitFailed, said.length > 0 ? said : `git ${args[0]} failed`)
    }
    const limit = Math.max(1, Math.floor(query.limit ?? DRAWER_LIMIT))
    switch (query.drawer) {
      case 'graph':
      case 'commits':
      case 'fileHistory':
        // Already limited by `-<n>`; the rails ride along with the commits they belong
        // to, so this list is not truncated again.
        return { rows: parseCommitLines(result.stdout), note: null }
      case 'branches':
        // The *picker's* query, not `branch -a`. PHASE-11 asks for this to be decided
        // rather than defaulted: `for-each-ref` already returns the three fields a row
        // needs and already drops symbolic refs, and `refs/remotes/origin/HEAD` is a
        // row whose Checkout entry would silently detach HEAD at a branch nobody
        // picked. `branch -a --format='%(HEAD) %(refname:short)'` would hand back less
        // and have to be un-rendered into the same shape. One query, two readers.
        return { rows: branchRows(result.stdout).slice(0, limit), note: null }
      case 'worktrees':
        return { rows: worktreeRows(result.stdout).slice(0, limit), note: null }
      case 'remotes':
        return { rows: parseRemotes(result.stdout).slice(0, limit), note: null }
      case 'stashes':
        return { rows: parseStashes(result.stdout), note: null }
      case 'tags':
        // `git tag` has no count flag, so the cap is applied here. The sort is git's.
        return { rows: parseTags(result.stdout).slice(0, limit), note: null }
    }
  }

  /**
   * A drawer row's menu entry that reaches git.
   *
   * Every one of these is a single command with no interactive part. `--no-edit` on
   * the two that would otherwise open `$EDITOR` is not a convenience: the daemon has
   * no terminal, so an editor would block until `GIT_TIMEOUT_MS` killed it and the
   * user would be told nothing. The same argument as the credential guard in
   * `gitEnv`, which is already in place and is what keeps `Fetch` from hanging.
   */
  async act(cwd: string, action: GitDrawerActionId, ref: string): Promise<string> {
    const args = this.actionArgs(action, ref)
    const result = await this.git(args, cwd)
    if (result.code !== 0) {
      const said = result.stderr.trim() || result.stdout.trim()
      throw new RequestError(ErrorCodes.gitFailed, said.length > 0 ? said : `git ${args[0]} failed`)
    }
    const said = lastLine(result)
    return said.length > 0 ? said : `${action} done`
  }

  private actionArgs(action: GitDrawerActionId, ref: string): string[] {
    const commit = (): string => {
      if (!isCommitHash(ref)) {
        throw new RequestError(ErrorCodes.badRequest, `${action} needs a commit hash, not ${ref}`)
      }
      return ref
    }
    const name = (): string => {
      if (!isRefName(ref)) throw new RequestError(ErrorCodes.badRequest, `${action}: ${ref} is not a name git takes`)
      return ref
    }
    const stash = (): string => {
      if (!isStashRef(ref)) throw new RequestError(ErrorCodes.badRequest, `${action} needs a stash@{n}, not ${ref}`)
      return ref
    }
    switch (action) {
      case 'commit.checkout':
        // Detached, and said so on the menu. A commit is not a branch, and quietly
        // creating one named after it is a decision a menu entry should not make.
        return ['checkout', '--detach', commit()]
      case 'commit.cherryPick':
        return ['cherry-pick', commit()]
      case 'commit.revert':
        return ['revert', '--no-edit', commit()]
      case 'commit.reset':
        // `--mixed`: HEAD and the index move, the working tree does not. The confirm
        // dialog says exactly that. `--hard` is the one spelling of this that destroys
        // work, and no menu entry in this project has it.
        return ['reset', '--mixed', commit()]
      case 'branch.merge':
        return ['merge', '--no-edit', name()]
      case 'branch.delete':
        // `-d`, not `-D`. The confirmation is about deleting a branch, not about losing
        // commits, and git's refusal names the unmerged branch and the flag that would
        // force it — which is more than this dialog could say.
        return ['branch', '-d', name()]
      case 'stash.apply':
        return ['stash', 'apply', stash()]
      case 'stash.pop':
        return ['stash', 'pop', stash()]
      case 'stash.drop':
        return ['stash', 'drop', stash()]
      case 'remote.fetch':
        // `gitEnv` already makes a credential prompt impossible, so an unreachable or
        // private remote fails with git's own message instead of blocking on a prompt
        // nothing is attached to. See PHASE-7's follow-up 1, applied in `worktree.ts`.
        return ['fetch', name()]
      case 'tag.checkout':
        return ['checkout', name()]
      case 'tag.delete':
        return ['tag', '-d', name()]
    }
  }
}

/**
 * The conclusion of a git command: the last non-empty line it wrote.
 *
 * Same rule and the same reason as `git.ts`'s — stderr first, because that is where
 * git narrates — kept separate rather than exported across, since this one also has to
 * survive `Rebasing (1/1)\r`-style progress sharing a line with the result.
 */
function lastLine(result: { stdout: string; stderr: string }): string {
  for (const stream of [result.stderr, result.stdout]) {
    const lines = stream
      .split(/[\r\n]+/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const last = lines[lines.length - 1]
    if (last !== undefined) return last
  }
  return ''
}
