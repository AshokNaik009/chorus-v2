/**
 * Git worktrees: one checkout per agent, so two agents do not fight over one tree.
 *
 * Shaped after orca's worktree lifecycle (MIT, Lovecast Inc. 2026), reduced to the four
 * operations PHASE-5 asks for. orca's own implementation spans ~60 files because it
 * also carries base-ref probing, divergence analysis, deferred removal, lineage
 * summaries and a WSL path flavour; none of that is in scope, and taking it wholesale
 * would import a model of git this project has no use for.
 *
 * ## Git is the state, and we never cache it
 *
 * Every read here shells out. There is no worktree table in `AppState`, deliberately:
 * the user can `git worktree add` in a pane we are showing them, and a model that
 * remembered what git said a minute ago would be wrong in the one situation that
 * matters. `git worktree list --porcelain` is a few milliseconds and is called by a
 * human action, never by a poll.
 *
 * ## What is refused
 *
 * Removing a worktree with uncommitted changes needs `force`, and removing the primary
 * working tree is refused outright — git would refuse too, but a clearer error beats
 * relaying "fatal: ... is a main working tree".
 */

import { execFile } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { ErrorCodes } from '@leap-chorus/protocol'
import type { WorktreeRecord } from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'

/** A git call that hangs must not hang the daemon. Generous: a checkout can be slow. */
export const GIT_TIMEOUT_MS = 30_000

/** How much of a git command's stdout is buffered before `execFile` gives up. */
export const GIT_MAX_BUFFER = 8 * 1024 * 1024

export interface GitResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
  /**
   * `execFile` killed the child because its output passed `GIT_MAX_BUFFER`.
   *
   * Carried rather than inferred, because the symptom is a non-zero code with an
   * *empty* stderr and a partial stdout — indistinguishable, at the call site, from a
   * git that failed quietly. See `gitBufferOverflowMessage`.
   *
   * Optional so a test's fake runner — which cannot overflow anything — stays three
   * fields long.
   */
  readonly overflowed?: boolean
}

export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitResult>

/**
 * The environment every git call runs under.
 *
 * Three separate problems, all of them PHASE-7 follow-ups against shipped code, and
 * all three fixed by not letting git inherit the daemon's environment unexamined.
 *
 * **1. git must not be able to prompt.** `git.sync` talks to a remote. A remote that
 * demands credentials makes git block on a terminal prompt that nothing is attached to,
 * and `execFile`'s timeout then kills it after thirty seconds with no output at all —
 * so the user is told "git push failed" and never told the word *credentials*. A
 * timeout is the wrong fix; making the prompt impossible is the right one, because a
 * git that cannot prompt **fails immediately and says why**. Cached credentials are
 * untouched: only the interactive fallback dies. `GCM_INTERACTIVE` is separate because
 * Git Credential Manager ignores the two askpass variables.
 *
 * **2. git translates itself.** `parseBranch` matches the literal `No commits yet on `
 * and `sync` relays git's stderr verbatim; a gettext-enabled git under a non-English
 * locale translates both, down to the `fatal:` prefix. English **UTF-8** rather than
 * plain `C`, so hooks git spawns keep a UTF-8 `LC_CTYPE`; `LANGUAGE` outranks `LC_ALL`
 * in gettext's lookup, so it is pinned too. Same argument as `--renames`: what git
 * prints should depend on the repository, not on who is running it.
 *
 * **3. the panel fights the user's own shell over `index.lock`.** This one is specific
 * to a docked panel: `git status` takes the lock to write back a refreshed index, and
 * the panel is docked *next to a shell the user runs git in*. `GIT_OPTIONAL_LOCKS=0`
 * makes every read here read-only, so it can neither lose that race nor cause it.
 *
 * The two `credential.*` settings ride in through `GIT_CONFIG_KEY_n`/`VALUE_n` rather
 * than `-c`, so they apply to the whole process — submodule and helper invocations
 * included — without the caller having to remember to pass them. Verified accepted by
 * git 2.54.0 (Apple Git-157) on 2026-09-21: the env spelling above reads back through
 * `git config --get credential.interactive`.
 */
export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Any `GIT_CONFIG_*` the caller already set would be clobbered by the indices below,
  // so they are dropped rather than silently half-honoured.
  const base: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/u.test(key)) base[key] = value
  }
  return {
    ...base,
    // 1 — no prompting, on any of the four paths that can raise one.
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: env['GIT_ASKPASS'] ?? '',
    SSH_ASKPASS: env['SSH_ASKPASS'] ?? '',
    GCM_INTERACTIVE: 'never',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.interactive',
    GIT_CONFIG_VALUE_0: 'false',
    GIT_CONFIG_KEY_1: 'credential.guiPrompt',
    GIT_CONFIG_VALUE_1: 'false',
    // 2 — untranslated output, in UTF-8 so hooks keep a sane LC_CTYPE.
    LANGUAGE: 'en',
    LC_ALL: 'en_US.UTF-8',
    LANG: 'en_US.UTF-8',
    // 3 — never take `index.lock` for a read.
    GIT_OPTIONAL_LOCKS: '0'
  }
}

/**
 * Whether an `execFile` failure is the `maxBuffer` cap rather than git's own exit.
 *
 * Node reports it as `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` in `code`, and older versions
 * as `ENOBUFS`; both leave a *partial* stdout and an empty stderr behind, which is why
 * a caller that only looks at the exit code reports it as an unexplained failure.
 */
function isBufferOverflow(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || code === 'ENOBUFS') return true
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && /maxBuffer/u.test(message)
}

/**
 * What to say when git produced more output than the daemon will hold.
 *
 * "git status failed" is what this used to be, because the overflow leaves stderr
 * empty and every call site falls back to `stderr || '<command> failed'`. The honest
 * message names the cap, since the repository is not broken and retrying will not help.
 */
export function gitBufferOverflowMessage(what: string): string {
  return `${what}: this repository's output exceeds the daemon's ${Math.round(
    GIT_MAX_BUFFER / (1024 * 1024)
  )} MB buffer`
}

export const runGit: GitRunner = (args, cwd) =>
  new Promise((resolvePromise) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv() },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : 1
        resolvePromise({ stdout, stderr, code, overflowed: error !== null && isBufferOverflow(error) })
      }
    )
  })

export interface WorktreeServiceOptions {
  readonly git?: GitRunner
  /** Injected in tests. Real one is `existsSync`. */
  readonly exists?: (path: string) => boolean
}

/**
 * Resolve symlinks before comparing a path to one git printed.
 *
 * Not a nicety. `git rev-parse --show-toplevel` and `git worktree list` both print
 * *real* paths, so on macOS a repository under `$TMPDIR` is `/var/folders/...` to the
 * caller and `/private/var/folders/...` to git — and every comparison between the two
 * silently fails: `worktree.remove` would not recognize the primary tree it was
 * refusing to delete, and a pane would never be reported as living in its worktree.
 * The same applies to any user whose checkout sits under a symlinked home or mount.
 *
 * Falls back to the lexical path when the path does not exist yet, which is the normal
 * case for a worktree about to be created.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

export class WorktreeService {
  private readonly git: GitRunner
  private readonly exists: (path: string) => boolean

  constructor(options: WorktreeServiceOptions = {}) {
    this.git = options.git ?? runGit
    this.exists = options.exists ?? existsSync
  }

  /** The repository containing `path`, or null when there is none. */
  async repoRoot(path: string): Promise<string | null> {
    if (!isAbsolute(path)) return null
    // `--show-toplevel` from inside a *linked* worktree gives that worktree's root,
    // which is what a caller asking "where am I" means. `worktree list` then reports
    // every tree of the shared repository regardless of which one we asked from.
    const result = await this.git(['rev-parse', '--show-toplevel'], path)
    if (result.code !== 0) return null
    const root = result.stdout.trim()
    return root.length > 0 ? root : null
  }

  private async requireRepo(path: string): Promise<string> {
    const root = await this.repoRoot(path)
    if (root === null) {
      throw new RequestError(ErrorCodes.notARepository, `${path} is not inside a git repository`)
    }
    return root
  }

  /**
   * Every worktree of the repository containing `path`.
   *
   * Parses `--porcelain`, not the human format: the human one aligns columns and
   * elides, and has never been a stable interface.
   */
  async list(path: string): Promise<{ repo: string; worktrees: WorktreeRecord[] }> {
    const repo = await this.requireRepo(path)
    const result = await this.git(['worktree', 'list', '--porcelain'], repo)
    if (result.code !== 0) throw gitFailed('worktree list', result)
    return { repo, worktrees: parseWorktreeList(result.stdout) }
  }

  /**
   * Add a worktree on a branch, creating the branch if it does not exist.
   *
   * The default path is a *sibling* of the repository, not a directory inside it:
   * a worktree nested in its own repository shows up in every `git status`, every
   * ripgrep and every agent's file walk, which is how one agent's checkout ends up in
   * another agent's context.
   */
  async create(options: {
    repoPath: string
    branch: string
    path?: string
    base?: string
  }): Promise<{ worktree: WorktreeRecord; created: boolean }> {
    const repo = await this.requireRepo(options.repoPath)
    const target = canonicalPath(
      options.path === undefined ? defaultWorktreePath(repo, options.branch) : options.path
    )

    const existing = (await this.list(repo)).worktrees.find((entry) => entry.path === target)
    if (existing !== undefined) return { worktree: existing, created: false }
    if (this.exists(target)) {
      throw new RequestError(ErrorCodes.gitFailed, `${target} already exists and is not a worktree`)
    }

    const hasBranch = (await this.git(['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`], repo)).code === 0
    const args = hasBranch
      ? ['worktree', 'add', target, options.branch]
      : ['worktree', 'add', '-b', options.branch, target, ...(options.base === undefined ? [] : [options.base])]

    const result = await this.git(args, repo)
    if (result.code !== 0) throw gitFailed(`worktree add ${options.branch}`, result)

    const worktree = (await this.list(repo)).worktrees.find((entry) => entry.path === target)
    if (worktree === undefined) {
      throw new RequestError(ErrorCodes.gitFailed, `git reported success but ${target} is not a worktree`)
    }
    return { worktree, created: true }
  }

  async remove(options: {
    path: string
    force?: boolean
    deleteBranch?: boolean
  }): Promise<{ removed: boolean; reason: string | null; branchDeleted: boolean }> {
    const target = canonicalPath(options.path)
    const repo = await this.requireRepo(target)
    const { worktrees } = await this.list(repo)
    const record = worktrees.find((entry) => entry.path === target)
    if (record === undefined) return { removed: false, reason: `${target} is not a worktree`, branchDeleted: false }
    if (record.primary) {
      // git refuses this too, but "is a main working tree" is not an error anyone
      // reads as "you asked to delete your repository".
      return { removed: false, reason: 'refusing to remove the primary working tree', branchDeleted: false }
    }

    // Every git call below runs from the *primary* tree, not from `repo`.
    //
    // `repo` came from `rev-parse --show-toplevel` inside the target, so for a linked
    // worktree it *is* the target — and running `git branch -D` there means running it
    // in a directory `worktree remove` has just deleted, which fails with a confusing
    // ENOENT after the removal has already succeeded. The primary tree always exists.
    const primary = worktrees.find((entry) => entry.primary)?.path ?? repo

    const args = ['worktree', 'remove', ...(options.force === true ? ['--force'] : []), target]
    const result = await this.git(args, primary)
    if (result.code !== 0) {
      return { removed: false, reason: gitMessage(result), branchDeleted: false }
    }

    let branchDeleted = false
    if (options.deleteBranch === true && record.branch !== null) {
      // `-D`, not `-d`: the caller already said to delete the branch, and `-d` would
      // refuse an unmerged one after the worktree is already gone — the worst place
      // to stop. `force` stays the gate for losing *uncommitted* work.
      branchDeleted = (await this.git(['branch', '-D', record.branch], primary)).code === 0
    }
    return { removed: true, reason: null, branchDeleted }
  }
}

/** A sibling directory named `<repo>-<branch>`, with the branch's slashes flattened. */
export function defaultWorktreePath(repo: string, branch: string): string {
  const safe = branch.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return join(dirname(repo), `${basename(repo)}-${safe.length > 0 ? safe : 'worktree'}`)
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are blank-line separated. The first is always the primary working tree,
 * which is how `primary` is decided — there is no porcelain field that says so.
 */
export function parseWorktreeList(stdout: string): WorktreeRecord[] {
  const records: WorktreeRecord[] = []
  let current: { path?: string; head?: string; branch?: string | null } = {}

  const flush = (): void => {
    if (current.path === undefined) return
    records.push({
      path: current.path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      primary: records.length === 0,
      paneIds: []
    })
    current = {}
  }

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length === 0) {
      flush()
      continue
    }
    if (line.startsWith('worktree ')) {
      flush()
      current.path = line.slice('worktree '.length)
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length)
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//u, '')
    } else if (line === 'detached') {
      current.branch = null
    }
    // `bare`, `locked`, `prunable` are not read: nothing here acts on them, and
    // inventing a field for each would be a model of git we do not need.
  }
  flush()
  return records
}

function gitMessage(result: GitResult): string {
  const text = result.stderr.trim().length > 0 ? result.stderr.trim() : result.stdout.trim()
  return text.length > 0 ? text : `git exited ${result.code}`
}

function gitFailed(what: string, result: GitResult): RequestError {
  // git's own stderr is the useful part; wrapping it in our prose would hide it.
  return new RequestError(ErrorCodes.gitFailed, `git ${what} failed: ${gitMessage(result)}`)
}
