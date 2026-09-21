/**
 * Installed plugins, on disk.
 *
 * Four directories and one file, all under the data root so one `LEAP_CHORUS_DATA_DIR`
 * isolates a test completely — the same rule the integration hooks follow:
 *
 * ```
 * <dataRoot>/plugins/
 *   registry.json     what is installed, and what it is pinned to
 *   store/<id>/       the checkout, as fetched and built
 *   config/<id>/      HERDR_PLUGIN_CONFIG_DIR — the user's, never ours to rewrite
 *   state/<id>/       HERDR_PLUGIN_STATE_DIR
 *   bin/herdr-compat  the $HERDR_BIN_PATH shim
 *   tmp/              install scratch; nothing here survives a failed install
 * ```
 *
 * ## Why the registry holds a snapshot rather than a path
 *
 * herdr re-reads every manifest at load. This stores the manifest *as it was approved*:
 * the entrypoints, the ignored keys, the pin. A manifest rewritten in the store after
 * the fact therefore does not silently change what the host will run, and
 * `verify()` is what turns "the files changed" from invisible into a report.
 *
 * That is deliberate and it is not a sandbox. The plugin's own code is in the store and
 * we run it; rewriting `main.sh` needs no manifest edit at all. What the snapshot buys
 * is that the *set of things the host will launch* is fixed at the moment the user said
 * yes, and that a difference is detectable. PHASE-10 is explicit that bounding a plugin
 * is not a security boundary, and neither is this.
 *
 * ## Two hashes, because there are two questions
 *
 * `pin.contentHash` is over the **fetched source**, `.git` excluded, before any build
 * ran: it answers "did the remote hand me the same bytes as last time?" and is what an
 * unchanged re-install is checked against. `installedHash` is over the **built store
 * directory** as the install left it, and is what `verify()` compares — it answers "has
 * anything changed under my feet since?". One hash cannot answer both: a build writes
 * into its own checkout, so a pin taken after the build would differ on every machine,
 * and a check that always fires is a check nobody reads.
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InstalledPluginInfo, PluginEntrypointInfo, PluginPin, PluginPlatform } from '@leap-chorus/protocol'
import { writeFileDurable } from '../durable.js'

/** Bumped only if the on-disk shape changes incompatibly. */
export const REGISTRY_VERSION = 1

export const SHIM_FILENAME = 'herdr-compat'

export class PluginRegistryError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'PluginRegistryError'
  }
}

/** What `registry.json` holds per plugin. Everything `InstalledPluginInfo` has but the derived bits. */
export interface PluginRecord {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string | null
  readonly platforms: readonly PluginPlatform[]
  readonly entrypoints: readonly PluginEntrypointInfo[]
  readonly ignored: readonly string[]
  readonly pin: PluginPin
  readonly installedHash: string
  readonly installedAt: number
}

export interface PluginVerifyReport {
  readonly id: string
  readonly expected: string
  readonly actual: string | null
  /** `ok`, `changed`, or `missing` when the store directory is gone. */
  readonly status: 'ok' | 'changed' | 'missing'
}

export class PluginStore {
  readonly pluginsDir: string
  readonly registryPath: string
  readonly storeDir: string
  readonly tmpDir: string
  readonly binDir: string
  readonly shimPath: string

  constructor(readonly dataRoot: string) {
    this.pluginsDir = join(dataRoot, 'plugins')
    this.registryPath = join(this.pluginsDir, 'registry.json')
    this.storeDir = join(this.pluginsDir, 'store')
    this.tmpDir = join(this.pluginsDir, 'tmp')
    this.binDir = join(this.pluginsDir, 'bin')
    this.shimPath = join(this.binDir, SHIM_FILENAME)
  }

  rootFor(id: string): string {
    return join(this.storeDir, id)
  }

  configDirFor(id: string): string {
    return join(this.pluginsDir, 'config', id)
  }

  stateDirFor(id: string): string {
    return join(this.pluginsDir, 'state', id)
  }

  /**
   * The two directories a plugin owns.
   *
   * Created on install and on every launch, because a user who deleted one should get
   * an empty one back rather than a plugin that fails to start. Never removed on
   * uninstall — see `remove`.
   */
  ensureUserDirs(id: string): void {
    mkdirSync(this.configDirFor(id), { recursive: true })
    mkdirSync(this.stateDirFor(id), { recursive: true })
  }

  records(): PluginRecord[] {
    if (!existsSync(this.registryPath)) return []
    let parsed: unknown
    const text = readFileSync(this.registryPath, 'utf8')
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // Loudly, and without rewriting it. A registry that failed to parse is one the
      // user can still read and fix; replacing it with `[]` here would turn a bad line
      // into "you have no plugins", which is the same shape of loss `durable.ts` exists
      // to prevent.
      throw new PluginRegistryError(
        'plugin_registry_unreadable',
        `${this.registryPath} is not valid JSON (${String((error as Error).message)}); move it aside to start over`
      )
    }
    const plugins = (parsed as { plugins?: unknown })?.plugins
    if (!Array.isArray(plugins)) {
      throw new PluginRegistryError('plugin_registry_unreadable', `${this.registryPath} has no 'plugins' array`)
    }
    return plugins as PluginRecord[]
  }

  /** Records, decorated with the paths and the on-disk facts a caller needs. */
  list(): InstalledPluginInfo[] {
    return this.records().map((record) => this.decorate(record))
  }

  get(id: string): InstalledPluginInfo | null {
    const record = this.records().find((entry) => entry.id === id)
    return record === undefined ? null : this.decorate(record)
  }

  /** Insert or replace one plugin, keeping the file sorted by id so a diff is readable. */
  save(record: PluginRecord): void {
    const kept = this.records().filter((entry) => entry.id !== record.id)
    kept.push(record)
    kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    this.write(kept)
  }

  /**
   * Forget a plugin and delete its checkout.
   *
   * `config/` and `state/` are **kept**, which is herdr's behaviour and the right one:
   * a reinstall after an accidental uninstall should not have lost the user's settings.
   * `plugin remove --purge` is the way to mean it.
   */
  remove(id: string, options: { purge?: boolean } = {}): boolean {
    const before = this.records()
    const kept = before.filter((entry) => entry.id !== id)
    const found = kept.length !== before.length
    if (found) this.write(kept)
    rmSync(this.rootFor(id), { recursive: true, force: true })
    if (options.purge === true) {
      rmSync(this.configDirFor(id), { recursive: true, force: true })
      rmSync(this.stateDirFor(id), { recursive: true, force: true })
    }
    return found
  }

  /** Re-hash what is on disk and compare it with what was approved. */
  verify(id: string): PluginVerifyReport | null {
    const record = this.records().find((entry) => entry.id === id)
    if (record === undefined) return null
    const root = this.rootFor(id)
    if (!existsSync(root)) return { id, expected: record.installedHash, actual: null, status: 'missing' }
    const actual = hashDirectory(root)
    return { id, expected: record.installedHash, actual, status: actual === record.installedHash ? 'ok' : 'changed' }
  }

  private write(records: readonly PluginRecord[]): void {
    writeFileDurable(this.registryPath, `${JSON.stringify({ version: REGISTRY_VERSION, plugins: records }, null, 2)}\n`, {
      mode: 0o600,
      backup: true
    })
  }

  private decorate(record: PluginRecord): InstalledPluginInfo {
    const root = this.rootFor(record.id)
    return {
      id: record.id,
      name: record.name,
      version: record.version,
      description: record.description ?? null,
      root,
      manifestPath: join(root, 'herdr-plugin.toml'),
      configDir: this.configDirFor(record.id),
      stateDir: this.stateDirFor(record.id),
      platforms: record.platforms ?? [],
      entrypoints: record.entrypoints ?? [],
      ignored: record.ignored ?? [],
      pin: record.pin,
      installedHash: record.installedHash,
      installedAt: record.installedAt,
      missing: !existsSync(root)
    }
  }
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

/** Never hashed, and never installed: git metadata differs between two identical checkouts. */
const HASH_EXCLUDE = new Set(['.git'])

/**
 * A deterministic SHA-256 over a directory tree.
 *
 * Three decisions, each of which a naive version gets wrong:
 *
 * - **Sorted by byte order, not by locale.** `readdir` order is filesystem order, and
 *   an install on APFS and one on ext4 would otherwise hash differently for no reason.
 * - **Only the executable bit of the mode.** Full modes carry the umask of whoever ran
 *   `git fetch`, so hashing them makes the same bytes hash two ways on one machine.
 * - **Symlinks are recorded, not followed.** Following one leaves the tree, and a
 *   plugin containing `link -> /etc/passwd` would otherwise hash the reader's machine.
 *
 * Directories are recorded too, so an empty directory is part of the identity and a
 * file moved between two same-named directories cannot collide.
 */
export function hashDirectory(root: string): string {
  const hash = createHash('sha256')
  walk(root, '', hash)
  return `sha256:${hash.digest('hex')}`
}

function walk(root: string, relative: string, hash: ReturnType<typeof createHash>): void {
  const entries = readdirSync(join(root, relative), { withFileTypes: true })
  // `sort` on strings is UTF-16 code-unit order, which is stable everywhere and is all
  // this needs: it must agree with itself across machines, not with any collation.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const entry of entries) {
    if (relative === '' && HASH_EXCLUDE.has(entry.name)) continue
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`
    const absolute = join(root, path)
    if (entry.isSymbolicLink()) {
      hash.update(`l ${path} ${readlinkSync(absolute)}\n`)
    } else if (entry.isDirectory()) {
      hash.update(`d ${path}\n`)
      walk(root, path, hash)
    } else if (entry.isFile()) {
      const stat = lstatSync(absolute)
      const executable = (stat.mode & 0o111) === 0 ? '-' : 'x'
      const body = readFileSync(absolute)
      hash.update(`f ${path} ${executable} ${body.length}\n`)
      hash.update(body)
    }
    // Sockets, fifos and devices are skipped: a plugin checkout has none, and hashing
    // one would mean opening it.
  }
}
