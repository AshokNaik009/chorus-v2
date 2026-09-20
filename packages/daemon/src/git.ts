/**
 * Working-tree git: status, staging, discarding and committing.
 *
 * Ported from herdr-sidebar's `src/git.rs` (MIT) — the porcelain parsing rules in
 * particular, which are the part that is easy to get subtly wrong. See `NOTICE`.
 *
 * ## Stateless, like the worktree service
 *
 * Every read shells out. Nothing is cached, for the reason `worktree.ts` gives: the
 * user can run git themselves in a pane we are showing them, so anything remembered
 * here is a lie waiting to be told. A status call is one `git status` and that is all.
 *
 * ## Why this lives in the daemon
 *
 * Two clients attached to one session must agree about what is staged, and a client
 * that reattaches has to learn it in one round trip. Same argument as agent state.
 */

import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ErrorCodes } from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'
import { canonicalPath, runGit, type GitRunner } from './worktree.js'

/** One changed path, on one side of the index. */
export interface GitFileEntry {
  /** Repo-relative, as git prints it. */
  readonly path: string
  /** The rename/copy source, when there is one. */
  readonly origin: string | null
  /**
   * A single letter: `M`odified, `A`dded, `D`eleted, `R`enamed, `C`opied, `U`ntracked,
   * or `!` for a conflict.
   */
  readonly letter: string
}

export interface GitStatus {
  /** The repository root, canonical. */
  readonly root: string
  readonly branch: string
  readonly staged: readonly GitFileEntry[]
  readonly unstaged: readonly GitFileEntry[]
  readonly ahead: number
  readonly behind: number
  /** The branch tracks something at all — the header carried `...remote`. */
  readonly hasUpstream: boolean
}

const CONFLICTS = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/** Type changes read as plain modifications, matching VS Code and herdr-sidebar. */
function displayLetter(code: string): string {
  return code === 'T' ? 'M' : code
}

/**
 * The branch from the `## …` header.
 *
 * Handles `main...origin/main [ahead 1]`, a bare `main`, `No commits yet on main`, and
 * `HEAD (no branch)` when detached.
 */
export function parseBranch(header: string): string {
  const head = header.split('...')[0] ?? header
  return head.startsWith('No commits yet on ') ? head.slice('No commits yet on '.length) : head
}

/**
 * `[ahead 1, behind 2]` from the header.
 *
 * Either half may be missing, and `[gone]` or a header with no bracket at all gives
 * zeros rather than an error — an upstream that has been deleted is a normal state.
 */
export function parseAheadBehind(header: string): { ahead: number; behind: number } {
  const open = header.lastIndexOf('[')
  if (open === -1) return { ahead: 0, behind: 0 }
  const bracket = header.slice(open + 1).replace(/]$/, '')
  const count = (tag: string): number => {
    for (const part of bracket.split(',')) {
      const trimmed = part.trim()
      if (trimmed.startsWith(tag)) {
        const parsed = Number.parseInt(trimmed.slice(tag.length).trim(), 10)
        return Number.isNaN(parsed) ? 0 : parsed
      }
    }
    return 0
  }
  return { ahead: count('ahead '), behind: count('behind ') }
}

/**
 * Parse `git status --porcelain -z --branch --untracked-files=all`.
 *
 * `-z` matters: it is what makes a path with a newline or a quote in it survive the
 * trip. It also changes the shape — entries are NUL-terminated and a rename's source
 * is its *own* record after the entry, rather than an ` -> ` inside one.
 *
 * A path can appear on both sides at once, which is the case worth keeping straight: a
 * file staged and then edited again is `MM`, one `M` in `staged` and one in `unstaged`.
 */
export function parseStatus(raw: string, root: string): GitStatus {
  const parts = raw.split('\0')
  let branch = ''
  let ahead = 0
  let behind = 0
  let hasUpstream = false
  const staged: GitFileEntry[] = []
  const unstaged: GitFileEntry[] = []

  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry === undefined || entry.length === 0) continue
    if (entry.startsWith('## ')) {
      const header = entry.slice(3)
      branch = parseBranch(header)
      ;({ ahead, behind } = parseAheadBehind(header))
      hasUpstream = header.includes('...')
      continue
    }
    // `XY path`: two status codes, a space, then the path.
    if (entry.length < 4 || entry[2] !== ' ') continue
    const x = entry[0] as string
    const y = entry[1] as string
    const path = entry.slice(3)

    // A rename or copy puts its source in the next NUL-separated field, so it has to
    // be consumed here whether or not it ends up being reported.
    let origin: string | null = null
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = parts[i + 1]
      if (next !== undefined && next.length > 0) {
        origin = next
        i++
      }
    }

    if (x === '?' && y === '?') {
      unstaged.push({ path, origin: null, letter: 'U' })
      continue
    }
    if (x === '!') continue
    if (CONFLICTS.has(`${x}${y}`)) {
      unstaged.push({ path, origin, letter: '!' })
      continue
    }
    if (x !== ' ') {
      staged.push({ path, origin: x === 'R' || x === 'C' ? origin : null, letter: displayLetter(x) })
    }
    if (y !== ' ') {
      unstaged.push({ path, origin: y === 'R' || y === 'C' ? origin : null, letter: displayLetter(y) })
    }
  }

  return { root, branch, staged, unstaged, ahead, behind, hasUpstream }
}

export interface GitServiceOptions {
  readonly git?: GitRunner
}

export class GitService {
  private readonly git: GitRunner

  constructor(options: GitServiceOptions = {}) {
    this.git = options.git ?? runGit
  }

  /**
   * The repository containing `cwd`, or an error naming the directory.
   *
   * Canonicalized for the reason `worktree.ts` documents: git prints real paths, so on
   * macOS a checkout under `$TMPDIR` compares unequal to itself unless both sides are
   * resolved.
   */
  async repoRoot(cwd: string): Promise<string> {
    if (!existsSync(cwd)) {
      throw new RequestError(ErrorCodes.badRequest, `no such directory: ${cwd}`)
    }
    const result = await this.git(['rev-parse', '--show-toplevel'], cwd)
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.notARepository, `${cwd} is not inside a git repository`)
    }
    return canonicalPath(result.stdout.trim())
  }

  async status(cwd: string): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    const result = await this.git(
      ['status', '--porcelain', '-z', '--branch', '--untracked-files=all'],
      root
    )
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim() || 'git status failed')
    }
    return parseStatus(result.stdout, root)
  }

  /** `git add`, which is also how a deletion and a conflict resolution are staged. */
  async stage(cwd: string, paths: readonly string[]): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    await this.mutate(root, paths.length === 0 ? ['add', '--all'] : ['add', '--', ...paths])
    return this.status(root)
  }

  /**
   * Take paths back out of the index.
   *
   * `reset -q HEAD --` rather than `restore --staged`, because the latter fails on a
   * repository with no commits yet — which is exactly when someone is most likely to
   * be staging and unstaging while they work out what belongs in the first commit.
   */
  async unstage(cwd: string, paths: readonly string[]): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    const args = paths.length === 0 ? ['reset', '-q', 'HEAD', '--', '.'] : ['reset', '-q', 'HEAD', '--', ...paths]
    // A reset with nothing to reset exits 1 with no message; that is not a failure.
    const result = await this.git(args, root)
    if (result.code !== 0 && result.stderr.trim().length > 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim())
    }
    return this.status(root)
  }

  /**
   * Throw away working-tree changes. **Destructive and not undoable by git.**
   *
   * Tracked files are restored from the index; untracked ones have to be deleted,
   * because there is no version to restore them to. The two are counted separately and
   * returned so the caller can say which is which *before* asking for confirmation —
   * "discard 3 files" hides that one of them cannot be recovered.
   */
  async discard(cwd: string, paths: readonly string[]): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    if (paths.length === 0) {
      throw new RequestError(ErrorCodes.badRequest, 'discard needs paths; it will not guess')
    }
    const status = await this.status(root)
    const untracked = new Set(
      status.unstaged.filter((entry) => entry.letter === 'U').map((entry) => entry.path)
    )
    const tracked = paths.filter((path) => !untracked.has(path))
    const toDelete = paths.filter((path) => untracked.has(path))

    if (tracked.length > 0) {
      await this.mutate(root, ['checkout', '--', ...tracked])
    }
    for (const path of toDelete) {
      // Resolved against the root and checked, so a path from a stale client cannot
      // reach outside the repository.
      const full = canonicalPath(join(root, path))
      if (!full.startsWith(root)) {
        throw new RequestError(ErrorCodes.badRequest, `path escapes the repository: ${path}`)
      }
      await rm(full, { recursive: true, force: true })
    }
    return this.status(root)
  }

  /** Commit what is staged. Refuses an empty message rather than opening an editor. */
  async commit(cwd: string, message: string): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    const trimmed = message.trim()
    if (trimmed.length === 0) {
      throw new RequestError(ErrorCodes.badRequest, 'a commit needs a message')
    }
    const status = await this.status(root)
    if (status.staged.length === 0) {
      throw new RequestError(ErrorCodes.badRequest, 'nothing staged to commit')
    }
    // `--no-verify` is deliberately NOT passed: a repository's hooks are part of what
    // committing means there, and skipping them silently would be a surprise.
    await this.mutate(root, ['commit', '-m', trimmed])
    return this.status(root)
  }

  private async mutate(root: string, args: readonly string[]): Promise<void> {
    const result = await this.git(args, root)
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim() || `git ${args[0]} failed`)
    }
  }
}
