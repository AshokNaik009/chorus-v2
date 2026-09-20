/**
 * Finding, reading and reloading the config file.
 *
 * The split PHASE-4 asked for: `@leap-chorus/core` owns the schema, the defaults, the
 * merge and the validation, all over a plain object; this package owns the step from
 * bytes on disk to that object, and therefore owns every reason a config file might
 * fail that has nothing to do with what is in it — missing, unreadable, unparseable.
 *
 * A missing config file is not an error. It is the normal case.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { validateConfig, type Config, type ConfigProblem } from '@leap-chorus/core'
import { TomlError, parseToml } from './toml.js'

export const CONFIG_FILE_NAME = 'config.toml'

/**
 * Where a config file is looked for, most specific first.
 *
 * `$LEAP_CHORUS_CONFIG` names a file directly and skips the search — which is also what makes
 * the config tests hermetic, since they can point it at a temp directory rather than at
 * whatever the developer happens to have in `~/.config`.
 */
export function configSearchPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env['LEAP_CHORUS_CONFIG']
  if (explicit !== undefined && explicit.length > 0) return [resolve(explicit)]

  const paths: string[] = []
  const xdg = env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg.length > 0 && isAbsolute(xdg)) paths.push(join(xdg, 'leap-chorus', CONFIG_FILE_NAME))
  else paths.push(join(homedir(), '.config', 'leap-chorus', CONFIG_FILE_NAME))

  const dataDir = env['LEAP_CHORUS_DATA_DIR']
  if (dataDir !== undefined && dataDir.length > 0) paths.push(join(resolve(dataDir), CONFIG_FILE_NAME))
  else paths.push(join(homedir(), '.leap-chorus', CONFIG_FILE_NAME))
  return paths
}

export interface LoadedConfig {
  readonly config: Config
  /** The file the config came from, or null when none was found. */
  readonly path: string | null
  readonly problems: readonly ConfigProblem[]
  /** Parse or I/O failures, as opposed to schema problems. */
  readonly errors: readonly string[]
  /** The raw text, so a reload can tell whether anything actually changed. */
  readonly source: string | null
}

export interface LoadOptions {
  readonly path?: string
  readonly env?: NodeJS.ProcessEnv
  /** Injected so a test can load a config with no filesystem at all. */
  readonly readFile?: (path: string) => string
}

/**
 * Load and validate.
 *
 * Never throws. A file that does not parse yields the defaults plus an error naming the
 * line — because a config with a typo on line 40 should start leap-chorus and say so, not
 * leave the user at a shell prompt wondering which of their panes they lost.
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const read = options.readFile ?? defaultRead
  const candidates = options.path !== undefined ? [resolve(options.path)] : configSearchPaths(options.env)

  for (const path of candidates) {
    let source: string
    try {
      source = read(path)
    } catch (error) {
      if (isNotFound(error)) continue
      return {
        config: validateConfig(undefined).config,
        path,
        problems: [],
        errors: [`cannot read ${path}: ${messageOf(error)}`],
        source: null
      }
    }
    return parseSource(source, path)
  }

  return { config: validateConfig(undefined).config, path: null, problems: [], errors: [], source: null }
}

/** Validate config text that is already in hand. Used by reload and by tests. */
export function parseSource(source: string, path: string | null): LoadedConfig {
  let document: unknown
  try {
    document = parseToml(source)
  } catch (error) {
    const where = error instanceof TomlError ? ` at line ${error.line}` : ''
    return {
      config: validateConfig(undefined).config,
      path,
      problems: [],
      errors: [`${path ?? 'config'}${where}: ${messageOf(error)}`],
      source
    }
  }
  const { config, problems } = validateConfig(document)
  return { config, path, problems, errors: [], source }
}

function defaultRead(path: string): string {
  return readFileSync(path, 'utf8')
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    ((error as { code?: unknown }).code === 'ENOENT' || (error as { code?: unknown }).code === 'ENOTDIR')
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A one-line summary of what was wrong, for the status bar. Empty when nothing was. */
export function summarizeProblems(loaded: LoadedConfig): string {
  const counts: string[] = []
  if (loaded.errors.length > 0) counts.push(loaded.errors[0] as string)
  if (loaded.problems.length > 0) {
    const first = loaded.problems[0] as ConfigProblem
    counts.push(
      loaded.problems.length === 1 ? first.message : `${first.message} (+${loaded.problems.length - 1} more)`
    )
  }
  return counts.join('; ')
}
