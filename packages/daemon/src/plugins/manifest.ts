/**
 * `herdr-plugin.toml` — the subset this host honours, and what it refuses.
 *
 * Ported from herdr's `src/app/api/plugins/manifest.rs` (Apache-2.0). See `NOTICE`.
 * That file is 608 lines and validates a manifest with event hooks, link handlers,
 * startup commands, invocation contexts and popup geometry. This one is smaller
 * because PHASE-10 says not to build any of that until a plugin needs it.
 *
 * ## The rule this file is built around
 *
 * A key we do not honour is **named**, never dropped. herdr's manifest is a promise a
 * plugin author wrote down; reading `[[events]]` and silently never firing it produces
 * a plugin that appears installed and quietly does nothing — which is precisely the
 * failure mode PHASE-10's notes on orca's capability set warn about, in a different
 * costume. So every unhonoured key lands in `ignored`, `plugin install` prints the
 * list, and `plugin list` keeps it.
 *
 * ## What is honoured
 *
 * | Key | What we do |
 * |---|---|
 * | `id` `name` `version` `description` | identity, validated |
 * | `platforms` | an entry not for this platform is never offered |
 * | `[[build]]` | run at install, in the fetched checkout, bounded |
 * | `[[actions]]` | argv, runnable headless or in a pane |
 * | `[[panes]]` | argv, opened in a split or a tab |
 *
 * ## What is not
 *
 * `[[events]]`, `[[startup]]`, `[[link_handlers]]`, `min_herdr_version`, an action's
 * `contexts`, and a pane's `width`/`height`. The first three are behaviour we do not
 * run; `min_herdr_version` is a claim about a program this is not; `contexts` decides
 * which of herdr's menus an action appears in and we have no such menus; the geometry
 * belongs to a popup we do not have.
 *
 * ## Why ids are validated harder than herdr's
 *
 * A plugin id becomes a directory name under the data root. herdr percent-encodes
 * whatever it is given (`plugin_paths.rs`); we refuse anything that is not already a
 * safe path component. The encoder is a second place for a path-traversal bug to hide,
 * and an id like `../../etc` is not a plugin id somebody meant to write.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseToml, TomlError, type TomlValue } from '@leap-chorus/config-loader'
import type {
  PluginDeclaredPlacement,
  PluginEntrypointInfo,
  PluginPlacement,
  PluginPlatform
} from '@leap-chorus/protocol'

export const MANIFEST_FILENAME = 'herdr-plugin.toml'

/** herdr's limit, kept so a manifest that fits there fits here. */
const ID_MAX_CHARS = 120

/**
 * Directory names the store uses for itself.
 *
 * A plugin whose id is `store` would be installed into the directory holding every
 * installation. Rejected at parse time rather than defended against at every join.
 */
const RESERVED_IDS = new Set(['bin', 'config', 'state', 'store', 'tmp'])

const PLATFORMS: readonly PluginPlatform[] = ['linux', 'macos', 'windows']
const DECLARED_PLACEMENTS: readonly PluginDeclaredPlacement[] = ['overlay', 'popup', 'split', 'tab', 'zoomed']

/** Which of herdr's placements this host can actually produce, and what the rest become. */
const PLACEMENT_FALLBACK: Readonly<Record<PluginDeclaredPlacement, PluginPlacement>> = {
  overlay: 'split',
  popup: 'split',
  split: 'split',
  tab: 'tab',
  zoomed: 'split'
}

/** Top-level keys that parse and are deliberately not honoured. */
const IGNORED_TOP_LEVEL = new Set(['min_herdr_version', 'startup', 'events', 'link_handlers'])
const HONOURED_TOP_LEVEL = new Set(['id', 'name', 'version', 'description', 'platforms', 'build', 'actions', 'panes'])

/** Keys inside an action or pane table that parse and are deliberately not honoured. */
const IGNORED_ENTRY_KEYS = new Set(['contexts', 'width', 'height'])

export class PluginManifestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'PluginManifestError'
  }
}

export interface PluginBuildStep {
  readonly platforms: readonly PluginPlatform[]
  readonly command: readonly string[]
}

export interface PluginManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string | null
  readonly platforms: readonly PluginPlatform[]
  readonly build: readonly PluginBuildStep[]
  /** Panes first, then actions; each sorted by id, so two reads agree. */
  readonly entrypoints: readonly PluginEntrypointInfo[]
  /** Every key that parsed and is not honoured, as `[[events]]` or `panes.viewer.width`. */
  readonly ignored: readonly string[]
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function parsePluginManifest(text: string): PluginManifest {
  let raw: Record<string, TomlValue>
  try {
    raw = parseToml(text)
  } catch (error) {
    const message = error instanceof TomlError ? error.message : String(error)
    throw new PluginManifestError('plugin_manifest_parse_failed', message)
  }

  const ignored: string[] = []
  for (const key of Object.keys(raw)) {
    if (HONOURED_TOP_LEVEL.has(key)) continue
    // An unknown key and a known-but-unhonoured one are both reported, because a typo
    // in `platforms` is indistinguishable from a feature we skipped until somebody
    // reads the list.
    ignored.push(IGNORED_TOP_LEVEL.has(key) ? keyLabel(key, raw[key]) : `${keyLabel(key, raw[key])} (unknown)`)
  }

  const id = requireId(raw['id'], 'id', 'invalid_plugin_id')
  if (RESERVED_IDS.has(id)) {
    throw new PluginManifestError('invalid_plugin_id', `plugin id '${id}' is reserved by the plugin store`)
  }
  const name = requireText(raw['name'], 'name', 'invalid_plugin_name')
  const version = requireText(raw['version'], 'version', 'invalid_plugin_version')
  const description = optionalText(raw['description'], 'description')
  const platforms = readPlatforms(raw['platforms'], 'platforms')

  const build = tables(raw['build'], 'build').map((table, index) => {
    collectIgnored(table, new Set(['platforms', 'command']), `build[${index}]`, ignored)
    return {
      platforms: readPlatforms(table['platforms'], `build[${index}].platforms`),
      command: readCommand(table['command'], `build[${index}].command`)
    }
  })

  const panes = tables(raw['panes'], 'panes').map((table, index) =>
    readEntrypoint(table, index, 'pane', ignored)
  )
  const actions = tables(raw['actions'], 'actions').map((table, index) =>
    readEntrypoint(table, index, 'action', ignored)
  )

  rejectDuplicates(panes, 'duplicate_plugin_pane_id', 'pane')
  rejectDuplicates(actions, 'duplicate_plugin_action_id', 'action')

  const byId = new Intl.Collator('en', { sensitivity: 'base' })
  const entrypoints = [
    ...[...panes].sort((a, b) => byId.compare(a.id, b.id)),
    ...[...actions].sort((a, b) => byId.compare(a.id, b.id))
  ]

  return { id, name, version, description, platforms, build, entrypoints, ignored: ignored.sort() }
}

/**
 * Read `<dir>/herdr-plugin.toml`, or the file itself when given one.
 *
 * herdr accepts both, and a launcher script that passes its own manifest path is the
 * reason. The returned `root` is the directory, which is what `HERDR_PLUGIN_ROOT`
 * means to a plugin.
 */
export function loadPluginManifest(path: string): { manifest: PluginManifest; manifestPath: string; root: string } {
  const manifestPath = path.endsWith('.toml') ? path : join(path, MANIFEST_FILENAME)
  let text: string
  try {
    text = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    const code = (error as { code?: string }).code === 'ENOENT' ? 'plugin_manifest_not_found' : 'plugin_manifest_read_failed'
    throw new PluginManifestError(code, `${manifestPath}: ${String((error as Error).message ?? error)}`)
  }
  const manifest = parsePluginManifest(text)
  return { manifest, manifestPath, root: dirname(manifestPath) }
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/** Node's `process.platform` in herdr's vocabulary, or null on a platform herdr cannot name. */
export function currentPluginPlatform(platform: NodeJS.Platform = process.platform): PluginPlatform | null {
  if (platform === 'darwin') return 'macos'
  if (platform === 'linux') return 'linux'
  if (platform === 'win32') return 'windows'
  return null
}

/**
 * An entry's platforms, falling back to the plugin's.
 *
 * herdr's `effective_platforms`: an entry that names none inherits the plugin's list,
 * and a plugin that names none runs everywhere. Empty means everywhere in both cases,
 * which is why this returns a list rather than a boolean.
 */
export function effectivePlatforms(
  entry: readonly PluginPlatform[],
  plugin: readonly PluginPlatform[]
): readonly PluginPlatform[] {
  return entry.length > 0 ? entry : plugin
}

export function platformAllows(platforms: readonly PluginPlatform[], current: PluginPlatform | null): boolean {
  if (platforms.length === 0) return true
  return current !== null && platforms.includes(current)
}

// ---------------------------------------------------------------------------
// Field readers
// ---------------------------------------------------------------------------

function readEntrypoint(
  table: Record<string, TomlValue>,
  index: number,
  kind: 'pane' | 'action',
  ignored: string[]
): PluginEntrypointInfo {
  const section = kind === 'pane' ? 'panes' : 'actions'
  const known = new Set(['id', 'title', 'description', 'platforms', 'command', ...IGNORED_ENTRY_KEYS])
  if (kind === 'pane') known.add('placement')
  const id = requireId(table['id'], `${section}[${index}].id`, `invalid_plugin_${kind}_id`)
  collectIgnored(table, known, `${section}.${id}`, ignored)

  const declared =
    kind === 'pane' ? readPlacement(table['placement'], `${section}.${id}.placement`) : ('split' as const)
  const placement = PLACEMENT_FALLBACK[declared]

  return {
    id,
    title: requireText(table['title'], `${section}.${id}.title`, `invalid_plugin_${kind}_title`),
    description: optionalText(table['description'], `${section}.${id}.description`),
    kind,
    placement,
    placementFallbackFrom: placement === declared ? null : declared,
    command: readCommand(table['command'], `${section}.${id}.command`),
    platforms: readPlatforms(table['platforms'], `${section}.${id}.platforms`)
  }
}

/**
 * Report a key we parsed and will not honour.
 *
 * `IGNORED_ENTRY_KEYS` are herdr's own and get no `(unknown)` marker; anything else in
 * the table is a typo or a newer manifest, and saying which is the whole point.
 */
function collectIgnored(
  table: Record<string, TomlValue>,
  known: Set<string>,
  path: string,
  ignored: string[]
): void {
  for (const key of Object.keys(table)) {
    if (!known.has(key)) {
      ignored.push(`${path}.${key} (unknown)`)
    } else if (IGNORED_ENTRY_KEYS.has(key)) {
      ignored.push(`${path}.${key}`)
    }
  }
}

/**
 * `[[events]]` when the key really is an array of tables, `platfroms` when it is not.
 *
 * A mistyped `platforms = ["linux"]` is also an array, and labelling it `[[platfroms]]`
 * would point the reader at a section they never wrote.
 */
function keyLabel(key: string, value: TomlValue | undefined): string {
  const first = Array.isArray(value) ? value[0] : undefined
  const isTableArray = typeof first === 'object' && first !== null && !Array.isArray(first)
  return isTableArray ? `[[${key}]]` : key
}

function tables(value: TomlValue | undefined, label: string): Record<string, TomlValue>[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new PluginManifestError('invalid_plugin_manifest', `${label} must be a [[${label}]] array of tables`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PluginManifestError('invalid_plugin_manifest', `${label} must be a [[${label}]] array of tables`)
    }
    return entry as Record<string, TomlValue>
  })
}

function requireId(value: TomlValue | undefined, label: string, code: string): string {
  const text = requireText(value, label, code)
  if (text.length > ID_MAX_CHARS) {
    throw new PluginManifestError(code, `${label} is longer than ${ID_MAX_CHARS} characters`)
  }
  // Lowercase, starting with a letter or a digit: exactly what is safe as one path
  // component on every filesystem this project supports, with no encoder in between.
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(text)) {
    throw new PluginManifestError(
      code,
      `${label} must be lowercase and use only letters, digits, '.', '_' and '-' (got '${text}')`
    )
  }
  if (text === '.' || text === '..' || text.includes('..')) {
    throw new PluginManifestError(code, `${label} may not contain '..' (got '${text}')`)
  }
  return text
}

function requireText(value: TomlValue | undefined, label: string, code: string): string {
  if (typeof value !== 'string') throw new PluginManifestError(code, `${label} is required and must be a string`)
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new PluginManifestError(code, `${label} is required and must not be empty`)
  return trimmed
}

function optionalText(value: TomlValue | undefined, label: string): string | null {
  if (value === undefined) return null
  if (typeof value !== 'string') throw new PluginManifestError('invalid_plugin_manifest', `${label} must be a string`)
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function readPlatforms(value: TomlValue | undefined, label: string): readonly PluginPlatform[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    throw new PluginManifestError('invalid_plugin_platform', `${label} must be an array of platform names`)
  }
  const out: PluginPlatform[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !PLATFORMS.includes(entry as PluginPlatform)) {
      throw new PluginManifestError(
        'invalid_plugin_platform',
        `${label}: unknown platform '${String(entry)}' (expected ${PLATFORMS.join(', ')})`
      )
    }
    if (!out.includes(entry as PluginPlatform)) out.push(entry as PluginPlatform)
  }
  return out
}

function readPlacement(value: TomlValue | undefined, label: string): PluginDeclaredPlacement {
  if (value === undefined) return 'split'
  if (typeof value !== 'string' || !DECLARED_PLACEMENTS.includes(value as PluginDeclaredPlacement)) {
    throw new PluginManifestError(
      'invalid_plugin_placement',
      `${label}: unknown placement '${String(value)}' (expected ${DECLARED_PLACEMENTS.join(', ')})`
    )
  }
  return value as PluginDeclaredPlacement
}

/**
 * argv, and never a shell string.
 *
 * herdr's manifests are `command = ["sh", "-c", "…"]` when a plugin wants a shell, and
 * that is the plugin saying so. A bare string here would have to be split by us, and
 * every splitter disagrees with every shell about quoting.
 */
function readCommand(value: TomlValue | undefined, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new PluginManifestError('invalid_plugin_command', `${label} is required and must be an array of strings`)
  }
  const argv = value.map((entry) => {
    if (typeof entry !== 'string') {
      throw new PluginManifestError('invalid_plugin_command', `${label} must contain only strings`)
    }
    return entry
  })
  if (argv.length === 0 || argv[0]?.trim().length === 0) {
    throw new PluginManifestError('invalid_plugin_command', `${label} must name a program`)
  }
  return argv
}

function rejectDuplicates(entries: readonly PluginEntrypointInfo[], code: string, what: string): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new PluginManifestError(code, `duplicate ${what} id '${entry.id}'`)
    seen.add(entry.id)
  }
}
