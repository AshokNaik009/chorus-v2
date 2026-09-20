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
import { ErrorCodes, type GitBranch } from '@leap-chorus/protocol'
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
 * Parse `git status --porcelain -z --branch --renames --untracked-files=all`.
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

/**
 * Path-prefix containment on `/`-separated repo-relative paths.
 *
 * Equal, or a real descendant — `src/app.ts` is under `src` and `srcfile.ts` is not.
 * An undefined prefix contains everything, which is how "the whole repository" is
 * spelled. Ported from `under` in herdr-sidebar's `git.rs`.
 */
export function under(path: string, prefix: string | undefined): boolean {
  if (prefix === undefined) return true
  const p = prefix.replace(/\/+$/u, '')
  const c = path.replace(/\/+$/u, '')
  if (p === '') return true
  return c === p || (c.length > p.length && c.startsWith(p) && c[p.length] === '/')
}

/**
 * The paths an index operation on `prefix` should hand to git.
 *
 * Given one side of the status — the working-tree side to stage, the index side to
 * unstage — this is every path under the prefix, with a rename contributing **both**
 * of its halves.
 *
 * Both halves is the whole fix for the two rename defects. `git add -- new.txt` after
 * a `git mv` stages the addition and leaves ` D old.txt` behind, and `git reset HEAD --
 * new.txt` on a staged rename leaves `D old.txt` still staged: git only composes or
 * decomposes a rename when both paths move together. Verified against git 2.54.0 on
 * 2026-09-20.
 *
 * A rename whose *source* is under the prefix counts too, even when its target is not:
 * moving a file out of a directory is a change to that directory.
 */
export function pathsUnder(entries: readonly GitFileEntry[], prefix: string | undefined): string[] {
  const out: string[] = []
  for (const entry of entries) {
    const originUnder = entry.origin !== null && under(entry.origin, prefix)
    if (!under(entry.path, prefix) && !originUnder) continue
    for (const path of entry.origin === null ? [entry.path] : [entry.path, entry.origin]) {
      if (!out.includes(path)) out.push(path)
    }
  }
  return out.sort()
}

/**
 * Drop every path at or inside one of `nested` — a nested repository's own roots.
 *
 * `git add -- some/dir` where `some/dir` holds an unregistered inner repository records
 * it as a **gitlink**: a single entry naming a commit, in a repository that has no
 * submodule config to resolve it with. Enumerating the paths and then dropping these
 * makes the boundary explicit instead of quietly crossing it.
 */
export function dropNested(paths: readonly string[], nested: readonly string[]): string[] {
  return paths.filter((path) => !nested.some((root) => under(path, root)))
}

/**
 * Parse `for-each-ref --format=%(HEAD)%00%(refname:short)%00%(refname)%00%(symref)`.
 *
 * Symbolic refs are dropped: `refs/remotes/origin/HEAD` is an alias for whatever the
 * remote's default branch is, and checking it out by name gives a detached HEAD at a
 * branch the user did not pick. Verified present in a real clone on 2026-09-20.
 *
 * The current branch is rotated to the front rather than sorted there, so the rest keep
 * their most-recently-committed order.
 */
export function parseBranches(raw: string): GitBranch[] {
  const branches: GitBranch[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    const fields = line.split('\0')
    if (fields.length < 3) continue
    const name = (fields[1] ?? '').trim()
    const full = (fields[2] ?? '').trim()
    const symref = (fields[3] ?? '').trim()
    if (name.length === 0 || symref.length > 0) continue
    branches.push({
      name,
      // `%(HEAD)` is `*` or a single space, never empty.
      current: (fields[0] ?? '').trim() === '*',
      remote: full.startsWith('refs/remotes/')
    })
  }
  const current = branches.findIndex((branch) => branch.current)
  return current <= 0 ? branches : [...branches.slice(current), ...branches.slice(0, current)]
}

/**
 * Windows caps a command line near 32k, so a stage of a large untracked tree goes in
 * batches. herdr-sidebar uses the same number.
 */
const STAGE_CHUNK = 64

/**
 * The hash of a zero-byte blob, which every empty file shares.
 *
 * Pairing on it would match a `.gitkeep` against an unrelated deleted placeholder, so
 * empty content never pairs. `git hash-object -t blob /dev/null` prints it.
 */
const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'

/**
 * The conclusion of a git command: the last non-empty line it wrote.
 *
 * stderr first, because that is where git narrates; stdout carries "Already up to
 * date." and little else. Split on bare `\r` as well as newlines, since progress
 * output (`Rebasing (1/1)\r`) shares a line with the result that follows it.
 */
function lastLine(result: { stdout: string; stderr: string }): string {
  for (const stream of [result.stderr, result.stdout]) {
    const lines = stream.split(/[\r\n]+/u).map((line) => line.trim()).filter((line) => line.length > 0)
    const last = lines[lines.length - 1]
    if (last !== undefined) return last
  }
  return ''
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
      ['status', '--porcelain', '-z', '--branch', '--renames', '--untracked-files=all'],
      root
    )
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim() || 'git status failed')
    }
    return parseStatus(result.stdout, root)
  }

  /**
   * Stage paths — files or directories — from the working tree.
   *
   * Nothing is handed to git as typed. Every target is expanded against the *current*
   * status into the set of working-tree paths beneath it, and that set is what `git add
   * -A` receives. Three things fall out of doing it that way, and each one is a defect
   * the direct spelling has:
   *
   * - A rename arrives as both of its paths, so `old.txt` and `new.txt` land in the
   *   index together and git composes them back into an `R`. Staging only the selected
   *   path leaves a dangling ` D old.txt`.
   * - A directory becomes its files, so an unregistered inner repository inside it is
   *   not swallowed as a **gitlink** — `git add -- dir` would record one silently.
   * - `-A` is what makes a deletion stageable at all.
   *
   * An empty `paths` means the whole repository, which is the same expansion with no
   * prefix rather than a different command.
   */
  async stage(cwd: string, paths: readonly string[]): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    const status = await this.status(root)
    const targets: (string | undefined)[] = paths.length === 0 ? [undefined] : [...paths]
    const candidates: string[] = []
    for (const target of targets) {
      for (const path of pathsUnder(status.unstaged, target)) {
        if (!candidates.includes(path)) candidates.push(path)
      }
    }
    for (const path of await this.decomposedRenamePartners(root, status, candidates)) {
      if (!candidates.includes(path)) candidates.push(path)
    }
    const kept = dropNested(candidates, this.nestedRootsFor(root, candidates))
    if (kept.length === 0) {
      if (candidates.length > 0) {
        // Silence here would look like a broken keystroke: the row stays where it was
        // and nothing says why. Selecting something *inside* the nested repository
        // stages it there, which is the route that works.
        throw new RequestError(
          ErrorCodes.gitFailed,
          'nothing staged: those paths belong to a nested repository, not this one'
        )
      }
      return status
    }
    for (let i = 0; i < kept.length; i += STAGE_CHUNK) {
      await this.mutate(root, ['add', '-A', '--', ...kept.slice(i, i + STAGE_CHUNK)])
    }
    return this.status(root)
  }

  /**
   * The other half of a rename git has already taken apart.
   *
   * PHASE-7 opens with this repro and prescribes the wrong fix for it, which reading
   * `GitFileEntry.origin` will not close. Verified against git 2.54.0 on 2026-09-20:
   * after `git mv old new` and a `reset`, status reports ` D old` and `?? new` as two
   * unrelated entries — **no origin on either**, because git only pairs a worktree-side
   * rename when the target is already tracked. herdr-sidebar's `Git::stage` passes
   * `entry.orig` and so has the same gap; its own test for this feeds the parser a
   * synthetic ` R` entry that real git does not emit here.
   *
   * What does close it is that `git add -A -- old new` composes the two back into an
   * `R` once both land in the index together. So the missing half is found the way git
   * itself would: by blob identity.
   *
   * Deliberately exact content, not similarity, and only when **exactly one** candidate
   * matches on each side. A loose rule here stages work the user did not select, which
   * is the one thing a stage must never do. Empty files never pair at all — every
   * `.gitkeep` in a repository hashes the same.
   */
  private async decomposedRenamePartners(
    root: string,
    status: GitStatus,
    targets: readonly string[]
  ): Promise<string[]> {
    const untracked = status.unstaged.filter((entry) => entry.letter === 'U').map((entry) => entry.path)
    const deleted = status.unstaged.filter((entry) => entry.letter === 'D').map((entry) => entry.path)
    // Nothing to pair unless the selection reaches one kind and leaves some of the other
    // behind. This is the early exit that keeps an ordinary stage at one `git add`.
    const wantDeleted = untracked.some((path) => targets.includes(path)) && deleted.some((path) => !targets.includes(path))
    const wantUntracked = deleted.some((path) => targets.includes(path)) && untracked.some((path) => !targets.includes(path))
    if (!wantDeleted && !wantUntracked) return []

    const [byUntracked, byDeleted] = await Promise.all([
      this.worktreeBlobs(root, untracked),
      this.indexBlobs(root, deleted)
    ])
    const partners: string[] = []
    const pair = (from: Map<string, string>, to: Map<string, string>, selected: boolean): void => {
      for (const [path, hash] of from) {
        if (targets.includes(path) !== selected || hash === EMPTY_BLOB) continue
        const matches = [...to].filter(([other, otherHash]) => otherHash === hash && !targets.includes(other))
        if (matches.length !== 1) continue
        const only = matches[0]
        if (only !== undefined) partners.push(only[0])
      }
    }
    if (wantDeleted) pair(byUntracked, byDeleted, true)
    if (wantUntracked) pair(byDeleted, byUntracked, true)
    return partners
  }

  /** What `git add` would store for each path, as it stands in the working tree. */
  private async worktreeBlobs(root: string, paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (paths.length === 0) return out
    for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
      const chunk = paths.slice(i, i + STAGE_CHUNK)
      const result = await this.git(['hash-object', '--', ...chunk], root)
      if (result.code !== 0) return new Map()
      const hashes = result.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      // One hash per path, in order. A short answer means a path git could not read, and
      // guessing which one would pair the wrong file — so the whole batch is abandoned.
      if (hashes.length !== chunk.length) return new Map()
      chunk.forEach((path, index) => out.set(path, hashes[index] as string))
    }
    return out
  }

  /** What the index already holds for each path — the version a deletion is deleting. */
  private async indexBlobs(root: string, paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (paths.length === 0) return out
    for (let i = 0; i < paths.length; i += STAGE_CHUNK) {
      const result = await this.git(['ls-files', '-s', '-z', '--', ...paths.slice(i, i + STAGE_CHUNK)], root)
      if (result.code !== 0) return new Map()
      for (const record of result.stdout.split('\0')) {
        // `<mode> <hash> <stage>\t<path>`; a conflicted path appears at stages 1-3 and
        // is skipped, because there is no single version it is a rename of.
        const tab = record.indexOf('\t')
        if (tab === -1) continue
        const fields = record.slice(0, tab).split(' ')
        if (fields[2] !== '0') continue
        const hash = fields[1]
        if (hash !== undefined) out.set(record.slice(tab + 1), hash)
      }
    }
    return out
  }

  /**
   * The nested-repository roots on the way to any of `paths`.
   *
   * Every ancestor prefix, and the path itself, that carries its own `.git` — a
   * directory for a plain clone, a *file* for a worktree or submodule, so `existsSync`
   * rather than a directory check. This repository's own root is excluded by
   * construction: the prefixes are repo-relative and start one level down.
   */
  private nestedRootsFor(root: string, paths: readonly string[]): string[] {
    const seen = new Set<string>()
    const roots: string[] = []
    for (const path of paths) {
      const parts = path.replace(/\/+$/u, '').split('/')
      for (let end = 1; end <= parts.length; end++) {
        const prefix = parts.slice(0, end).join('/')
        if (seen.has(prefix)) continue
        seen.add(prefix)
        if (existsSync(join(root, ...parts.slice(0, end), '.git'))) roots.push(prefix)
      }
    }
    return roots
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
    const status = await this.status(root)
    // Expanded against the *staged* side, for the mirror of the staging defect: a
    // staged `R old -> new` reset by its new path alone leaves `D old` still staged.
    // A directory expands to its files here for the same reason it does in `stage`.
    const args =
      paths.length === 0
        ? ['reset', '-q', 'HEAD', '--', '.']
        : ['reset', '-q', 'HEAD', '--', ...this.unstageTargets(status, paths)]
    // A reset with nothing to reset exits 1 with no message; that is not a failure.
    const result = await this.git(args, root)
    if (result.code !== 0 && result.stderr.trim().length > 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim())
    }
    return this.status(root)
  }

  /**
   * Paths for `reset`, falling back to what was asked for.
   *
   * The expansion can come back empty — a path the client believes is staged but this
   * status does not list, which is what a stale panel looks like. Resetting the literal
   * path then is harmless and gives git's own message if there is one; sending nothing
   * would quietly reset the entire index instead.
   */
  private unstageTargets(status: GitStatus, paths: readonly string[]): string[] {
    const out: string[] = []
    for (const path of paths) {
      for (const resolved of pathsUnder(status.staged, path)) {
        if (!out.includes(resolved)) out.push(resolved)
      }
    }
    return out.length === 0 ? [...paths] : out
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

  /**
   * Local and remote-tracking branches, for the picker.
   *
   * `for-each-ref` rather than `branch -a`, because it can print the fields separated
   * by NUL and say whether a ref is symbolic — and `branch -a`'s rendering of
   * `origin/HEAD -> origin/main` would have to be unparsed back into the same thing.
   */
  async branches(cwd: string): Promise<{ root: string; branches: GitBranch[] }> {
    const root = await this.repoRoot(cwd)
    const result = await this.git(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(HEAD)%00%(refname:short)%00%(refname)%00%(symref)',
        'refs/heads',
        'refs/remotes'
      ],
      root
    )
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim() || 'git for-each-ref failed')
    }
    return { root, branches: parseBranches(result.stdout) }
  }

  /**
   * Switch branches. **Never forced**: a checkout that would lose work fails, and the
   * failure carries git's own explanation of which files are in the way.
   *
   * A remote-tracking name becomes an ordinary local branch that tracks it, which is
   * what every editor's branch picker does — the alternative, a detached HEAD, is a
   * state a picker should not be able to put someone in by accident.
   *
   * herdr-sidebar's behaviour is kept verbatim in one awkward case: picking
   * `origin/feature` when a local `feature` already exists fails with git's `a branch
   * named 'feature' already exists`. That is accurate and says what to pick instead.
   */
  async checkout(cwd: string, branch: string, remote: boolean): Promise<GitStatus> {
    const root = await this.repoRoot(cwd)
    if (branch.trim().length === 0) {
      throw new RequestError(ErrorCodes.badRequest, 'checkout needs a branch name')
    }
    const status = await this.status(root)
    if (status.branch === branch) return status
    await this.mutate(root, remote ? ['checkout', '--track', branch] : ['checkout', branch])
    return this.status(root)
  }

  /**
   * VS Code's Sync Changes: `pull --rebase --autostash`, then `push`.
   *
   * The autostash is the load-bearing flag, not a convenience. A tree you are looking
   * at in a source-control panel is a dirty tree — that is why the panel is open — and
   * a plain `pull` or `pull --ff-only` refuses to start on one. Substituting either
   * would make the button work only in the state where nobody needs it.
   *
   * **Push only runs if the pull succeeded.** A rebase that stops on a conflict leaves
   * HEAD detached mid-rebase, and pushing from there fails with `You are not currently
   * on a branch`, which describes nothing the user did. Verified on 2026-09-20: the
   * dirty tree is held in the autostash and comes back on `rebase --continue` or
   * `--abort`, so the work is safe but not on disk — which is exactly what the message
   * has to convey, and git's own hint block already does.
   */
  async sync(cwd: string): Promise<{ status: GitStatus; message: string }> {
    const root = await this.repoRoot(cwd)
    const pull = await this.git(['pull', '--rebase', '--autostash'], root)
    if (pull.code !== 0) {
      throw new RequestError(
        ErrorCodes.gitFailed,
        pull.stderr.trim() || pull.stdout.trim() || 'git pull --rebase --autostash failed'
      )
    }
    const push = await this.git(['push'], root)
    if (push.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, push.stderr.trim() || 'git push failed')
    }
    // The last line of each, which is where git puts the conclusion: "Successfully
    // rebased…", "Already up to date.", "abc..def main -> main". The lines above it
    // are progress and the remote's URL, and neither fits a 34-column panel.
    const said = [lastLine(pull), lastLine(push)].filter((part) => part.length > 0).join(' · ')
    return { status: await this.status(root), message: said.length > 0 ? said : 'synced with remote' }
  }

  private async mutate(root: string, args: readonly string[]): Promise<void> {
    const result = await this.git(args, root)
    if (result.code !== 0) {
      throw new RequestError(ErrorCodes.gitFailed, result.stderr.trim() || `git ${args[0]} failed`)
    }
  }
}
