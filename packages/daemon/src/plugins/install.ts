/**
 * `plugin install` — fetching a git repository and running its build.
 *
 * This is the file where PHASE-10's first decision lands, so it is worth writing the
 * answer down at the top rather than in a handoff nobody opens:
 *
 * > **leap-chorus does execute code fetched from a URL on the user's say-so, and it has
 * > no capability model, no consent fingerprint, and no kill list.** What it has is a
 * > confirmation, a pin, and an audit trail. Orca's "yes" to the same question is
 * > ~9,914 non-test lines; this is a few hundred, and the difference is exactly the
 * > security model it does not have.
 *
 * What a user is trusting, stated plainly, is in `PLAN.md` and in `HANDOFF.md`. In one
 * line: everything, as themselves. The build below is an arbitrary program from a
 * stranger's repository running with the user's filesystem, network and credentials.
 *
 * ## What is actually defended
 *
 * - **Nothing runs before the user has seen it.** The manifest is read from the fetched
 *   checkout and shown — id, version, every argv, every ignored key — and the build runs
 *   only after a yes.
 * - **The artifact is pinned.** The source tree's hash is recorded. A second install of
 *   the same ref that produces different bytes is *refused*, not installed, so a
 *   rewritten tag or a compromised account cannot upgrade an installed plugin quietly.
 *   `--pin sha256:…` checks a first install against a hash published elsewhere.
 * - **The manifest cannot change under the build.** herdr does this too, and the reason
 *   is sharp: without it, a build script can append `[[actions]]` to the manifest the
 *   user just approved and the host would register them.
 * - **A failed install leaves nothing.** Everything happens in a temp directory; the
 *   store is touched only by one rename, with the previous checkout kept aside until
 *   the registry write succeeds.
 *
 * ## Shape taken from herdr
 *
 * `git init` / `remote add` / `fetch --depth 1` / `checkout --detach FETCH_HEAD`, the
 * preview-then-confirm, the manifest re-read after the build, and the
 * rename-with-rollback are all `src/cli/plugin.rs` (Apache-2.0). See `NOTICE`. The pin
 * is not herdr's; it is the answer to PHASE-10's decision 2.
 */

import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { InstalledPluginInfo, PluginPin } from '@leap-chorus/protocol'
import { gitEnv } from '../worktree.js'
import {
  currentPluginPlatform,
  effectivePlatforms,
  loadPluginManifest,
  platformAllows,
  type PluginManifest
} from './manifest.js'
import { hashDirectory, type PluginRecord, type PluginStore } from './registry.js'
import { describeFailure, PluginRunner, PLUGIN_BUILD_TIMEOUT_MS } from './run.js'

export class PluginInstallError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'PluginInstallError'
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface GithubSource {
  readonly kind: 'github'
  readonly owner: string
  readonly repo: string
  readonly subdir: readonly string[]
}

export interface PathSource {
  readonly kind: 'path'
  readonly path: string
  readonly subdir: readonly string[]
}

export type PluginSource = GithubSource | PathSource

/**
 * `owner/repo[/subdir…]`, or a local path.
 *
 * The local form is not a convenience for tests — though it is what lets PHASE-10's
 * criterion 2 be met against a fixture rather than the network. It is how a plugin is
 * written: `plugin install ./my-plugin` takes the same path as a GitHub install, so the
 * thing an author tests is the thing a user gets.
 */
export function parsePluginSource(raw: string): PluginSource {
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw new PluginInstallError('invalid_plugin_source', 'a source is required')

  if (trimmed.startsWith('file://') || trimmed.startsWith('/') || trimmed.startsWith('.') || trimmed.startsWith('~')) {
    const path = trimmed.startsWith('file://') ? new URL(trimmed).pathname : trimmed
    if (path.startsWith('~')) {
      throw new PluginInstallError('invalid_plugin_source', `expand '~' before passing a path: ${trimmed}`)
    }
    return { kind: 'path', path: resolve(path), subdir: [] }
  }

  const segments = trimmed.split('/')
  const [owner, repo, ...subdir] = segments
  if (owner === undefined || repo === undefined || segments.length < 2) {
    throw new PluginInstallError(
      'invalid_plugin_source',
      `expected <owner>/<repo>[/subdir…] or a local path, got '${trimmed}'`
    )
  }
  validateGithubSegment(owner, 'owner')
  validateGithubSegment(repo, 'repository')
  for (const segment of subdir) validateSubdirSegment(segment)
  return { kind: 'github', owner, repo: repo.replace(/\.git$/u, ''), subdir }
}

function validateGithubSegment(value: string, label: string): void {
  if (value.length === 0 || value === '.' || value === '..') {
    throw new PluginInstallError('invalid_plugin_source', `GitHub ${label} is invalid: '${value}'`)
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new PluginInstallError('invalid_plugin_source', `GitHub ${label} contains invalid characters: '${value}'`)
  }
}

function validateSubdirSegment(value: string): void {
  if (value.length === 0 || value === '.' || value === '..' || value.includes('\\') || value.includes('\0')) {
    throw new PluginInstallError('invalid_plugin_source', `invalid plugin subdir segment: '${value}'`)
  }
}

export function sourceLabel(source: PluginSource): string {
  const base = source.kind === 'github' ? `${source.owner}/${source.repo}` : source.path
  return [base, ...source.subdir].join('/')
}

/**
 * The remote `git fetch` is pointed at.
 *
 * A local path becomes `file://`, deliberately: git refuses `--depth` over the plain
 * local transport ("`--depth` is ignored in local clones; use file:// instead"), so the
 * path form would silently fetch the whole history and then behave differently from the
 * GitHub form. Same transport, same behaviour, one code path.
 */
export function remoteUrlFor(source: PluginSource): string {
  return source.kind === 'github'
    ? `https://github.com/${source.owner}/${source.repo}.git`
    : `file://${source.path}`
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------

export interface InstallPreview {
  readonly source: PluginSource
  readonly sourceLabel: string
  readonly ref: string | null
  readonly commit: string
  readonly contentHash: string
  readonly manifest: PluginManifest
  /** What is installed under this id now, if anything. */
  readonly existing: InstalledPluginInfo | null
  /** Build steps that will run on *this* platform, in order. */
  readonly build: readonly (readonly string[])[]
  /** Entrypoints this platform will never be offered. */
  readonly unavailable: readonly string[]
}

export interface InstallOptions {
  readonly source: PluginSource
  readonly ref?: string
  /** A hash the fetched source must match. A first install has nothing else to check against. */
  readonly pin?: string
  /** Accept a changed artifact at a ref that was already pinned. */
  readonly update?: boolean
  /** Asked once, after the preview is known and before anything runs. */
  readonly confirm?: (preview: InstallPreview) => boolean | Promise<boolean>
  readonly onProgress?: (line: string) => void
  readonly buildTimeoutMs?: number
}

export type InstallStatus = 'installed' | 'cancelled'

export interface InstallOutcome {
  readonly status: InstallStatus
  readonly preview: InstallPreview
  readonly plugin: InstalledPluginInfo | null
  /** True when this replaced an existing installation. */
  readonly replaced: boolean
}

export interface PluginInstallerOptions {
  readonly runner?: PluginRunner
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
}

export class PluginInstaller {
  private readonly runner: PluginRunner
  private readonly now: () => number
  private readonly platform: NodeJS.Platform

  constructor(
    private readonly store: PluginStore,
    options: PluginInstallerOptions = {}
  ) {
    this.runner = options.runner ?? new PluginRunner()
    this.now = options.now ?? (() => Date.now())
    this.platform = options.platform ?? process.platform
  }

  async install(options: InstallOptions): Promise<InstallOutcome> {
    mkdirSync(this.store.tmpDir, { recursive: true })
    const temp = mkdtempSync(join(this.store.tmpDir, 'install-'))
    try {
      return await this.installInto(temp, options)
    } finally {
      // Whatever happened, the scratch directory goes. A half-fetched checkout left on
      // disk is the "half-installed" state criterion 6 is about.
      rmSync(temp, { recursive: true, force: true })
    }
  }

  private async installInto(temp: string, options: InstallOptions): Promise<InstallOutcome> {
    const checkout = join(temp, 'checkout')
    await this.fetch(checkout, options)
    const commit = (await this.git(checkout, ['rev-parse', 'HEAD'])).trim()

    const manifestRoot = join(checkout, ...options.source.subdir)
    if (!existsSync(manifestRoot)) {
      throw new PluginInstallError(
        'plugin_manifest_not_found',
        `${sourceLabel(options.source)} has no directory '${options.source.subdir.join('/')}' at ${commit}`
      )
    }
    const { manifest } = loadPluginManifest(manifestRoot)

    // Hashed *before* the build, and over the manifest's own directory rather than the
    // whole checkout, so a monorepo's other plugins cannot change this one's pin.
    const contentHash = hashDirectory(manifestRoot)
    const existing = this.store.get(manifest.id)
    this.checkPin(options, existing, contentHash, commit)

    const current = currentPluginPlatform(this.platform)
    if (!platformAllows(manifest.platforms, current)) {
      throw new PluginInstallError(
        'plugin_platform_unsupported',
        `${manifest.id} declares platforms ${manifest.platforms.join(', ')}; this is ${current ?? this.platform}`
      )
    }

    const build = manifest.build
      .filter((step) => platformAllows(effectivePlatforms(step.platforms, manifest.platforms), current))
      .map((step) => step.command)
    const unavailable = manifest.entrypoints
      .filter((entry) => !platformAllows(effectivePlatforms(entry.platforms, manifest.platforms), current))
      .map((entry) => `${entry.kind} ${entry.id}`)

    const preview: InstallPreview = {
      source: options.source,
      sourceLabel: sourceLabel(options.source),
      ref: options.ref ?? null,
      commit,
      contentHash,
      manifest,
      existing,
      build,
      unavailable
    }

    if (options.confirm !== undefined && !(await options.confirm(preview))) {
      return { status: 'cancelled', preview, plugin: null, replaced: false }
    }

    await this.runBuild(build, manifestRoot, manifest, options)

    // Re-read, and refuse a build that rewrote the thing the user approved.
    const after = loadPluginManifest(manifestRoot).manifest
    assertManifestUnchanged(manifest, after)

    const plugin = this.swapIn(temp, manifestRoot, manifest, {
      source: sourceLabel(options.source),
      ref: options.ref ?? null,
      commit,
      contentHash
    })
    return { status: 'installed', preview, plugin, replaced: existing !== null }
  }

  /**
   * Refuse a changed artifact, and check an explicit pin.
   *
   * The two are different questions. `--pin` is "I was told the hash; prove it" and
   * applies to a first install. The stored pin is "you approved these bytes at this
   * ref once", and the moment the same ref yields different bytes somebody has either
   * moved a tag or taken over an account. A moving branch hits this too, which is the
   * point: `--update` is how a user says they meant it.
   */
  private checkPin(
    options: InstallOptions,
    existing: InstalledPluginInfo | null,
    contentHash: string,
    commit: string
  ): void {
    if (options.pin !== undefined && options.pin !== contentHash) {
      throw new PluginInstallError(
        'plugin_pin_mismatch',
        `refusing to install: expected ${options.pin}, fetched ${contentHash}`
      )
    }
    if (existing === null || options.update === true) return
    const sameSource = existing.pin.source === sourceLabel(options.source)
    const sameRef = existing.pin.ref === (options.ref ?? null)
    if (!sameSource || !sameRef) return
    if (existing.pin.contentHash === contentHash) return
    throw new PluginInstallError(
      'plugin_artifact_changed',
      `refusing to install: ${existing.id} is pinned to ${existing.pin.contentHash} at ` +
        `${existing.pin.ref ?? 'the default branch'} (commit ${existing.pin.commit.slice(0, 12)}); that ref now ` +
        `yields ${contentHash} (commit ${commit.slice(0, 12)}). Re-run with --update to accept the new bytes.`
    )
  }

  private async fetch(checkout: string, options: InstallOptions): Promise<void> {
    if (options.source.kind === 'path' && !existsSync(join(options.source.path, '.git'))) {
      throw new PluginInstallError(
        'plugin_source_not_a_repository',
        `${options.source.path} is not a git repository; plugin install fetches a ref, so a plain directory has nothing to pin`
      )
    }
    mkdirSync(checkout, { recursive: true })
    await this.git(checkout, ['init', '--quiet'])
    await this.git(checkout, ['remote', 'add', 'origin', remoteUrlFor(options.source)])
    // `--depth 1`: a plugin's history is not something this host has any use for, and a
    // shallow fetch is the difference between a second and a minute on a large repo.
    await this.git(checkout, ['fetch', '--depth', '1', '--quiet', 'origin', options.ref ?? 'HEAD'])
    await this.git(checkout, ['checkout', '--detach', '--quiet', 'FETCH_HEAD'])
  }

  private async git(cwd: string, args: readonly string[]): Promise<string> {
    // `gitEnv` is phase 7's, not a second copy: no credential prompt to hang on, English
    // messages, and no optional locks. A fetch from a private repo fails rather than
    // blocking forever on a password nothing is attached to.
    const outcome = await this.runner.run({ argv: ['git', ...args], cwd, env: gitEnv() })
    if (outcome.failure !== null || outcome.code !== 0 || outcome.timedOut) {
      throw new PluginInstallError('plugin_git_failed', describeFailure(['git', ...args], outcome))
    }
    return outcome.stdout
  }

  private async runBuild(
    build: readonly (readonly string[])[],
    cwd: string,
    manifest: PluginManifest,
    options: InstallOptions
  ): Promise<void> {
    for (const argv of build) {
      options.onProgress?.(`$ ${argv.join(' ')}`)
      const outcome = await this.runner.run({
        argv,
        cwd,
        // The build gets the user's environment plus the plugin's own directories, so a
        // build script can seed a default config. It does *not* get `HERDR_BIN_PATH`:
        // nothing is running yet for it to talk to.
        env: {
          ...process.env,
          HERDR_PLUGIN_ID: manifest.id,
          HERDR_PLUGIN_ROOT: cwd,
          HERDR_PLUGIN_CONFIG_DIR: this.store.configDirFor(manifest.id),
          HERDR_PLUGIN_STATE_DIR: this.store.stateDirFor(manifest.id)
        },
        timeoutMs: options.buildTimeoutMs ?? PLUGIN_BUILD_TIMEOUT_MS,
        ...(options.onProgress === undefined ? {} : { onLine: options.onProgress })
      })
      if (outcome.failure !== null || outcome.code !== 0 || outcome.timedOut) {
        throw new PluginInstallError('plugin_build_failed', describeFailure(argv, outcome))
      }
    }
  }

  /**
   * One rename into the store, and a way back.
   *
   * The previous checkout is moved aside rather than deleted, so a failure between the
   * two renames restores it. The registry is written last: a store directory with no
   * registry entry is invisible and harmless, while a registry entry with no store
   * directory is a plugin that cannot run — so the order is the one where a crash
   * leaves the recoverable state.
   */
  private swapIn(temp: string, manifestRoot: string, manifest: PluginManifest, pin: PluginPin): InstalledPluginInfo {
    const root = this.store.rootFor(manifest.id)
    const backup = join(temp, 'previous')
    mkdirSync(this.store.storeDir, { recursive: true })
    this.store.ensureUserDirs(manifest.id)

    let backedUp = false
    if (existsSync(root)) {
      renameSync(root, backup)
      backedUp = true
    }
    try {
      renameSync(manifestRoot, root)
    } catch (error) {
      if (backedUp) renameSync(backup, root)
      throw new PluginInstallError('plugin_install_failed', `could not install into ${root}: ${String(error)}`)
    }

    const record: PluginRecord = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      platforms: manifest.platforms,
      entrypoints: manifest.entrypoints,
      ignored: manifest.ignored,
      pin,
      installedHash: hashDirectory(root),
      installedAt: this.now()
    }
    try {
      this.store.save(record)
    } catch (error) {
      rmSync(root, { recursive: true, force: true })
      if (backedUp) renameSync(backup, root)
      throw error
    }
    const installed = this.store.get(manifest.id)
    if (installed === null) throw new PluginInstallError('plugin_install_failed', `${manifest.id} did not register`)
    return installed
  }
}

/**
 * A build may not change the manifest the user approved.
 *
 * herdr's `ensure_manifest_unchanged_after_build`, and the attack it closes is worth
 * naming: without this, a build script appends `[[actions]]` — or a new `command` on an
 * existing one — to the file the preview was rendered from, and the host registers what
 * the user never saw. Everything shown in the preview is compared, which is why
 * `ignored` is in here too: a build that adds `[[events]]` has changed what the user was
 * told this host would skip.
 */
function assertManifestUnchanged(before: PluginManifest, after: PluginManifest): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return
  throw new PluginInstallError(
    'plugin_manifest_changed_after_build',
    `${before.id}: the build rewrote herdr-plugin.toml; refusing to install a manifest the preview did not show`
  )
}
