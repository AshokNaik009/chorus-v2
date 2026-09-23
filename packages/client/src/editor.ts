/**
 * Which editor, if any, this terminal belongs to.
 *
 * Running inside VS Code's integrated terminal — or Cursor's, or Windsurf's — clicking
 * a changed file should open it *there*, in the window the terminal is already a part
 * of. Running in iTerm over SSH it should not, because there is no window to open it
 * in and yanking focus to some unrelated GUI is not what the click meant.
 *
 * ## This is the client's question, and it is asked fresh every time
 *
 * The daemon is long-lived, detached, and was spawned by whichever client happened to
 * start it. Panes inherit *its* environment. So a daemon started from one VS Code
 * window keeps that window's environment for as long as it lives, and a client
 * attached later from a different window — or from a plain terminal — would inherit an
 * answer that is wrong and looks right. This is the same trap `code-connect` exists to
 * work around for tmux, and a multiplexer is exactly the program that falls into it.
 *
 * So the resolution reads the **client's** `process.env`, at the moment of the click,
 * and nothing is cached, stored on the model, or sent over the wire. Same rule as the
 * clipboard: it is a property of the terminal a client is attached to, not of the
 * session.
 *
 * ## What is actually reliable
 *
 * Verified on this machine, 2026-09-22, inside a VS Code 1.135.0 integrated terminal:
 *
 * ```
 * TERM_PROGRAM=vscode            __CFBundleIdentifier=com.microsoft.VSCode
 * VSCODE_INJECTION=1             VSCODE_GIT_ASKPASS_NODE=/Applications/Visual Studio Code.app/…
 * VSCODE_IPC_HOOK_CLI            ← ABSENT
 * ```
 *
 * **`VSCODE_IPC_HOOK_CLI` is not dependable**, although every write-up names it as the
 * variable to check. It was absent in a terminal that was unambiguously VS Code's. It
 * is also the variable that goes stale inside a multiplexer, so it is doubly the wrong
 * thing to hang this on. The three that held are the bundle id, the askpass path and
 * `TERM_PROGRAM` — and conveniently they degrade in that order from *exact fork* to
 * *some VS Code*.
 */

import { accessSync, constants } from 'node:fs'

/** A resolved editor: what to run, what to call it, and how we worked it out. */
export interface ExternalEditor {
  /** The command, resolved on `PATH` at call time. */
  readonly cli: string
  /** For messages. "VS Code", "Cursor". */
  readonly name: string
  /** Which rule matched, so a `--why`-style question has an answer. */
  readonly source: 'config' | 'bundle-id' | 'askpass' | 'term-program'
}

interface Known {
  readonly cli: string
  readonly name: string
}

/**
 * macOS bundle identifiers, which are the one signal that names the *fork* exactly.
 *
 * Cursor's is a ToDesktop build id rather than a readable reverse-DNS name, which is
 * why the askpass rule below exists as well: an id nobody can guess at is an id that
 * changes when they rebuild, and the path to `Cursor.app` will still say Cursor.
 */
const BUNDLE_IDS: Readonly<Record<string, Known>> = {
  'com.microsoft.VSCode': { cli: 'code', name: 'VS Code' },
  'com.microsoft.VSCodeInsiders': { cli: 'code-insiders', name: 'VS Code Insiders' },
  'com.visualstudio.code.oss': { cli: 'code-oss', name: 'Code - OSS' },
  'com.vscodium': { cli: 'codium', name: 'VSCodium' },
  'com.vscodium.codium': { cli: 'codium', name: 'VSCodium' },
  'com.todesktop.230313mzl4w4u92': { cli: 'cursor', name: 'Cursor' },
  'com.exafunction.windsurf': { cli: 'windsurf', name: 'Windsurf' }
}

/** Application names, as they appear in an `.app` bundle or a Linux install prefix. */
const APP_NAMES: readonly (readonly [RegExp, Known])[] = [
  [/visual studio code - insiders/u, { cli: 'code-insiders', name: 'VS Code Insiders' }],
  [/visual studio code|^code$/u, { cli: 'code', name: 'VS Code' }],
  [/cursor/u, { cli: 'cursor', name: 'Cursor' }],
  [/windsurf/u, { cli: 'windsurf', name: 'Windsurf' }],
  [/vscodium|codium/u, { cli: 'codium', name: 'VSCodium' }],
  [/code-oss|code - oss/u, { cli: 'code-oss', name: 'Code - OSS' }]
]

export interface ResolveOptions {
  /** `[sidebar] open-with`. `auto` detects, `off` disables, anything else is a command. */
  readonly configured?: string
  /** Is this command runnable? Injected so the table can be tested without a PATH. */
  readonly exists?: (cli: string) => boolean
}

/**
 * The editor this terminal belongs to, or null.
 *
 * Null is a perfectly ordinary answer and the caller must treat it as one: it means
 * "a plain terminal", which is most of them.
 */
export function resolveExternalEditor(
  env: NodeJS.ProcessEnv,
  options: ResolveOptions = {}
): ExternalEditor | null {
  const exists = options.exists ?? onPath
  const configured = (options.configured ?? 'auto').trim()
  if (configured === 'off') return null
  if (configured.length > 0 && configured !== 'auto') {
    // An explicit command is used whether or not this looks like an editor's terminal,
    // and whether or not we recognize the name — that is what asking for it means. It
    // still has to exist, because a typo must report itself rather than do nothing.
    return exists(configured) ? { cli: configured, name: configured, source: 'config' } : null
  }

  const candidate = detect(env)
  if (candidate === null) return null
  if (exists(candidate.editor.cli)) return { ...candidate.editor, source: candidate.source }
  // The fork's own CLI is not on `PATH` — a Cursor terminal on a machine where only
  // `code` was ever installed. Falling back to `code` opens the file in the *other*
  // editor, which is worse than saying no: the click would appear to work and put the
  // file somewhere the user is not looking.
  return null
}

/**
 * Why there is no editor, as a sentence somebody can act on — or null to stay quiet.
 *
 * `resolveExternalEditor` returning null has three quite different causes and the
 * caller could not tell them apart, so it said nothing for all three. A click that
 * silently does nothing is indistinguishable from a broken one: this project already
 * settled that argument once, over `Copy …` and OSC 52, and came down on the side of
 * saying so.
 *
 * Null is returned for exactly one case — `open-with = "off"` — because a no-op the
 * user *asked* for does not need explaining every time they click.
 *
 * ## Every one of these fits in 34 columns
 *
 * `ScmPanel`'s note is **truncated, not wrapped** — `renderScmPanel` says so, and the
 * reason is that a note leads with its conclusion. The first draft of these did not
 * fit, and what got cut was the half that mattered: the terminal showed
 * `no editor for this terminal — set…` and hid the setting. So each of these leads with
 * the **action** and stays inside `MIN_SCM_WIDTH`, which a test asserts.
 */
export function explainNoEditor(env: NodeJS.ProcessEnv, options: ResolveOptions = {}): string | null {
  const exists = options.exists ?? onPath
  const configured = (options.configured ?? 'auto').trim()
  if (configured === 'off') return null

  // A typo has to report itself rather than do nothing, which is what asking for a
  // specific command by name is owed.
  if (configured.length > 0 && configured !== 'auto') {
    // The conclusion first, because this is the one message whose tail is arbitrary —
    // it echoes whatever is in the config file, and a 60-character typo would push
    // "not on PATH" off the end of a 34-column dock. The others are bounded by
    // `KNOWN_EDITOR_CLIS` and can read the natural way round.
    return exists(configured) ? null : `not on PATH: ${configured}`
  }

  const candidate = detect(env)
  if (candidate !== null) {
    // Resolution is about to succeed; there is nothing to explain.
    if (exists(candidate.editor.cli)) return null
    // Detected the fork, but its CLI is missing — a Cursor terminal on a machine where
    // only `code` was installed. Naming the command is what makes it actionable: the
    // editor is right, the shell command was never installed from its palette.
    return `${candidate.editor.cli} is not on PATH`
  }

  // A plain terminal, which is most of them. Name an editor that is actually installed
  // rather than a generic instruction: the fix is one line and it should be copyable
  // straight off the screen.
  const installed = installedEditor(exists)
  return installed === null
    ? 'set [sidebar] open-with = <cmd>'
    : `set [sidebar] open-with = "${installed}"`
}

/** The first known editor command on `PATH`, for the suggestion above. */
export function installedEditor(exists: (cli: string) => boolean = onPath): string | null {
  return KNOWN_EDITOR_CLIS.find((cli) => exists(cli)) ?? null
}

/** Every editor command this file knows by name, most common first. */
export const KNOWN_EDITOR_CLIS: readonly string[] = [
  'code',
  'cursor',
  'windsurf',
  'codium',
  'code-insiders',
  'code-oss'
]

function detect(env: NodeJS.ProcessEnv): { editor: Known; source: ExternalEditor['source'] } | null {
  // 1. The bundle id, which names the fork exactly. macOS only, and it is the signal
  //    every other tool that solves this reaches for first.
  const bundle = env['__CFBundleIdentifier']
  if (bundle !== undefined) {
    const known = BUNDLE_IDS[bundle]
    if (known !== undefined) return { editor: known, source: 'bundle-id' }
  }

  // 2. The askpass helper's path, which VS Code and every fork of it export. This is
  //    the Linux path — there is no bundle id there — and it carries the application's
  //    own name: `/Applications/Cursor.app/…`, `/usr/share/code/…`.
  for (const key of ['VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN', 'GIT_ASKPASS']) {
    const value = env[key]
    if (value === undefined || value.length === 0) continue
    const named = fromPath(value)
    if (named !== null) return { editor: named, source: 'askpass' }
  }

  // 3. `TERM_PROGRAM=vscode`, which every fork also sets — Cursor and Windsurf both
  //    report themselves as `vscode` here, so this rule knows only that it is *a* VS
  //    Code, and `code` is the only sensible guess left.
  if (env['TERM_PROGRAM'] === 'vscode') return { editor: { cli: 'code', name: 'VS Code' }, source: 'term-program' }
  return null
}

/** Pull an application name out of an `.app` bundle path or a Linux install prefix. */
function fromPath(value: string): Known | null {
  const app = /\/([^/]+)\.app\//u.exec(value)
  const share = /\/(?:usr\/share|opt)\/([^/]+)\//u.exec(value)
  const name = (app?.[1] ?? share?.[1] ?? '').toLowerCase()
  if (name.length === 0) return null
  for (const [pattern, known] of APP_NAMES) {
    if (pattern.test(name)) return known
  }
  return null
}

/**
 * Is `cli` runnable?
 *
 * `PATH` is walked here rather than shelling out to `which`, because this runs on a
 * click and a subprocess per click is a subprocess too many. `PATHEXT` is not
 * consulted: PLAN.md does not support Windows.
 */
function onPath(cli: string): boolean {
  // An absolute or relative path is taken as given.
  if (cli.includes('/')) return isExecutable(cli)
  const dirs = (process.env['PATH'] ?? '').split(':').filter((dir) => dir.length > 0)
  return dirs.some((dir) => isExecutable(`${dir}/${cli}`))
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The argv to open `file` at `line`.
 *
 * `--goto` is what makes `path:line` a position rather than part of the filename.
 *
 * **`--reuse-window` is deliberately not passed.** VS Code already has a setting for
 * this — `window.openFilesInNewWindow` — and by default a file opens in the last
 * active window. Forcing `-r` would override a preference the user has already
 * expressed, to solve a problem they may not have.
 */
export function editorArgs(file: string, line: number | null): string[] {
  return ['--goto', line === null || line < 1 ? file : `${file}:${line}`]
}
