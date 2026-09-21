/**
 * Drafting a commit message.
 *
 * Ported from herdr-sidebar's `suggest.rs` (MIT), including the thing that makes it
 * worth porting: **it works with no model at all.** See `NOTICE`.
 *
 * ## Two drafts, and the offline one is the default
 *
 * `fromFilenames` reads the staged side of the status and writes a conventional-commit
 * subject from it. No network, no subprocess, no configuration, and it is right often
 * enough to be worth pressing. That is what `A` does out of the box.
 *
 * `fromClaude` shells out to the local `claude` CLI with the staged diff. It runs
 * **only** when the caller explicitly asks, which happens only when `[sidebar]
 * ai-commit` is on, which is off by default. This is the one thing in this project that
 * can put the contents of a working tree in front of a model, and the rule phase 8 set
 * for `rg` applies doubled: absent is a message, not a failure, and nothing leaves the
 * machine unless the user asked for it.
 *
 * ## Why the diff is capped hard
 *
 * A staged diff can be a vendored dependency bump. Sending megabytes to a CLI to get
 * back a one-line subject is slow, expensive and no better than sending the first few
 * hundred lines plus the file list — which is what a human skims anyway. The cap is
 * reported in the prompt, so the model is told it is looking at an excerpt rather than
 * being allowed to conclude the change is smaller than it is.
 */

import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { ErrorCodes } from '@leap-chorus/protocol'
import type { GitStatus } from './git.js'
import { RequestError } from './rpc/params.js'
import { searchPath } from './search.js'
import { type GitRunner, runGit } from './worktree.js'

/** How much staged diff is handed to the model. A skim, not the whole change. */
export const SUGGEST_MAX_DIFF_BYTES = 32 * 1024

/** A draft is a subject line. Anything longer is the model ignoring the instruction. */
export const SUGGEST_MAX_MESSAGE = 120

/** The CLI gets this long. A commit box that hangs is worse than one that says nothing. */
export const SUGGEST_TIMEOUT_MS = 30_000

/** Where a draft came from, so the panel can say `✧` only when a model was involved. */
export type SuggestSource = 'claude' | 'filenames'

export interface Suggestion {
  readonly message: string
  readonly source: SuggestSource
  /**
   * Why the model was not used, when it was asked for and did not run.
   *
   * Null when nothing was asked or nothing went wrong. Carried rather than thrown: a
   * draft that fell back to filenames is still a draft, and failing the whole keystroke
   * because an optional CLI was missing would be the wrong trade.
   */
  readonly note: string | null
}

// ---------------------------------------------------------------------------
// The offline draft
// ---------------------------------------------------------------------------

/**
 * Conventional-commit type from a set of paths.
 *
 * Deliberately shallow. The only claims it makes are ones the paths actually support:
 * everything under a test directory is `test`, everything under docs is `docs`, and a
 * change that is purely additions is `feat`. Anything mixed is `chore`, because
 * guessing `fix` from a filename is a guess the user then has to notice and correct.
 */
function commitType(paths: readonly string[], allAdded: boolean): string {
  const every = (predicate: (path: string) => boolean): boolean =>
    paths.length > 0 && paths.every(predicate)
  if (every((path) => /(^|\/)(test|tests|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/u.test(path))) {
    return 'test'
  }
  if (every((path) => /(^|\/)docs?(\/|$)|\.(md|markdown|rst|adoc)$/iu.test(path))) return 'docs'
  return allAdded ? 'feat' : 'chore'
}

/**
 * The directory the change is about, when there is one.
 *
 * The longest common path prefix, and only when it is a real directory shared by more
 * than one file — `packages/client` from four files under it. One file gives its own
 * name instead, which says more than its directory does.
 */
export function commonScope(paths: readonly string[]): string | null {
  if (paths.length === 0) return null
  const split = paths.map((path) => path.split('/'))
  const first = split[0] as string[]
  let shared = first.length - 1
  for (const parts of split) {
    let i = 0
    while (i < shared && i < parts.length - 1 && parts[i] === first[i]) i++
    shared = i
  }
  if (shared === 0) return null
  return first.slice(0, shared).join('/')
}

/**
 * A subject line from the staged filenames alone.
 *
 * `suggest.rs`'s fallback, and the default here. Never empty: a staged change always
 * has at least one path, and a subject naming it beats an empty commit box.
 */
export function fromFilenames(status: GitStatus): string {
  const staged = status.staged
  if (staged.length === 0) return ''
  const paths = staged.map((entry) => entry.path)
  const allAdded = staged.every((entry) => entry.letter === 'A')
  const type = commitType(paths, allAdded)
  const verb = allAdded ? 'add' : staged.every((entry) => entry.letter === 'D') ? 'remove' : 'update'

  if (paths.length === 1) {
    const path = paths[0] as string
    const name = path.split('/').pop() ?? path
    return trim(`${type}: ${verb} ${name}`)
  }
  const scope = commonScope(paths)
  const what = `${paths.length} files`
  return trim(scope === null ? `${type}: ${verb} ${what}` : `${type}(${scope}): ${verb} ${what}`)
}

function trim(message: string): string {
  const single = message.replace(/\s+/gu, ' ').trim()
  return single.length <= SUGGEST_MAX_MESSAGE ? single : `${single.slice(0, SUGGEST_MAX_MESSAGE - 1)}…`
}

// ---------------------------------------------------------------------------
// The model draft
// ---------------------------------------------------------------------------

export interface ClaudeOutcome {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  /** The spawn failed. `'ENOENT'` means the CLI is not on the daemon's PATH. */
  readonly spawnError: string | null
}

export type ClaudeRunner = (args: readonly string[], input: string, cwd: string) => Promise<ClaudeOutcome>

/**
 * Run the local `claude` CLI, writing the prompt on stdin.
 *
 * stdin rather than an argument, because a staged diff is far past any platform's
 * command-line length limit and because a diff containing a quote would otherwise have
 * to be escaped correctly on every shell. `spawn` with no shell at all sidesteps both.
 */
export function createClaudeRunner(env: NodeJS.ProcessEnv = process.env): ClaudeRunner {
  const childEnv: NodeJS.ProcessEnv = { ...env, PATH: searchPath(env) }
  return (args, input, cwd) =>
    new Promise<ClaudeOutcome>((resolvePromise) => {
      let child: ReturnType<typeof spawn>
      try {
        child = spawn('claude', [...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv })
      } catch (error) {
        resolvePromise({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: codeOf(error) })
        return
      }
      const decoder = new StringDecoder('utf8')
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      const timer = setTimeout(() => {
        timedOut = true
        // Never kill a handle with no pid: that signals our own process group.
        if (child.pid !== undefined) child.kill()
      }, SUGGEST_TIMEOUT_MS)
      timer.unref?.()

      const settle = (outcome: ClaudeOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.on('error', () => {})
        resolvePromise(outcome)
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length < 64 * 1024) stdout += decoder.write(chunk)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString('utf8')
      })
      child.once('error', (error) =>
        settle({ code: null, stdout: '', stderr: '', timedOut, spawnError: codeOf(error) })
      )
      child.once('close', (code) =>
        settle({ code, stdout: stdout + decoder.end(), stderr, timedOut, spawnError: null })
      )
      // A closed stdin on the far side is normal — the CLI may not read it — and the
      // EPIPE it raises here must not take the daemon down.
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'unknown'
}

/**
 * Keep the first line that looks like a subject.
 *
 * A CLI can preface its answer with a sentence, wrap it in backticks, or add a trailing
 * explanation. The subject is the first non-empty line once fences and surrounding
 * quotes are gone; everything after it is discarded rather than joined, because a
 * commit *subject* is one line by definition.
 */
export function firstSubject(output: string): string {
  for (const raw of output.split('\n')) {
    const line = raw.trim().replace(/^`+|`+$/gu, '').replace(/^["']|["']$/gu, '').trim()
    if (line.length === 0) continue
    if (line.startsWith('```')) continue
    return trim(line)
  }
  return ''
}

const PROMPT_HEAD = [
  'Write a single-line git commit subject for the staged changes below.',
  'Use the Conventional Commits form `type(scope): summary` when it fits, imperative mood,',
  'no trailing period, at most 72 characters. Reply with the subject line and nothing else.',
  ''
].join('\n')

export interface SuggestServiceOptions {
  readonly git?: GitRunner
  readonly claude?: ClaudeRunner
  readonly maxDiffBytes?: number
}

export class SuggestService {
  private readonly git: GitRunner
  private readonly claude: ClaudeRunner
  private readonly maxDiffBytes: number

  constructor(options: SuggestServiceOptions = {}) {
    this.git = options.git ?? runGit
    this.claude = options.claude ?? createClaudeRunner()
    this.maxDiffBytes = options.maxDiffBytes ?? SUGGEST_MAX_DIFF_BYTES
  }

  /**
   * Draft a subject for what is staged in `root`.
   *
   * `ai` is the whole switch. False — the default everywhere — and no subprocess is
   * started and nothing is read but the status the panel already has. True and the CLI
   * is tried, with the filename draft kept as the answer if anything at all goes wrong.
   */
  async suggest(root: string, status: GitStatus, ai: boolean): Promise<Suggestion> {
    const offline = fromFilenames(status)
    if (offline.length === 0) {
      throw new RequestError(ErrorCodes.badRequest, 'nothing staged to describe')
    }
    if (!ai) return { message: offline, source: 'filenames', note: null }

    const diff = await this.stagedDiff(root)
    const outcome = await this.claude(['-p'], `${PROMPT_HEAD}${diff}`, root)

    const note = this.noteFor(outcome)
    if (note !== null) return { message: offline, source: 'filenames', note }
    const subject = firstSubject(outcome.stdout)
    return subject.length === 0
      ? { message: offline, source: 'filenames', note: 'claude returned nothing usable' }
      : { message: subject, source: 'claude', note: null }
  }

  /** Why the CLI's answer cannot be used, or null when it can. */
  private noteFor(outcome: ClaudeOutcome): string | null {
    if (outcome.spawnError === 'ENOENT') {
      // The same distinction phase 8 draws for `rg`, and for the same reason: the
      // daemon's PATH is not a login shell's, so "not installed" is a claim we cannot
      // make and do not make.
      return 'the claude CLI is not on the daemon PATH — drafted from filenames instead'
    }
    if (outcome.spawnError !== null) return `claude failed to start (${outcome.spawnError})`
    if (outcome.timedOut) return 'claude took too long — drafted from filenames instead'
    if (outcome.code !== 0) {
      const said = outcome.stderr.split('\n').find((line) => line.trim().length > 0)
      return said === undefined ? 'claude exited with an error' : `claude: ${said.trim()}`
    }
    return null
  }

  /**
   * The staged diff, capped.
   *
   * `--stat` first and always, so even a capped excerpt is preceded by the shape of the
   * whole change. `-U2` rather than the default three lines: context is what a diff
   * spends its bytes on, and two is enough to place a hunk.
   */
  private async stagedDiff(root: string): Promise<string> {
    const stat = await this.git(['diff', '--cached', '--stat'], root)
    const body = await this.git(['diff', '--cached', '-U2', '--no-color'], root)
    const head = stat.code === 0 ? stat.stdout : ''
    if (body.code !== 0) return head
    const text = body.stdout
    if (Buffer.byteLength(text, 'utf8') <= this.maxDiffBytes) return `${head}\n${text}`
    // Said out loud, so the model is not allowed to conclude the change is small.
    return `${head}\n${text.slice(0, this.maxDiffBytes)}\n[diff truncated at ${this.maxDiffBytes} bytes]`
  }
}
