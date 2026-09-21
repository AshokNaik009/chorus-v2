/**
 * `plugin install`, against a real git repository on disk.
 *
 * PHASE-10 criteria 2, 6 and 8 live here. Nothing touches the network: a local `file://`
 * remote takes the same code path as a GitHub one, so `init`, `fetch --depth 1`,
 * `checkout --detach`, `rev-parse`, the content hash and the build are all real.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginInstallError, PluginInstaller, PluginStore, parsePluginSource, remoteUrlFor, sourceLabel } from '@leap-chorus/daemon'
import { createFixtureRepo, fixtureFiles, type FixtureRepo } from './plugin-fixture.js'

let dataRoot: string
let store: PluginStore
let installer: PluginInstaller
let repo: FixtureRepo

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), 'leap-plugin-data-'))
  store = new PluginStore(dataRoot)
  installer = new PluginInstaller(store, { now: () => 1_700_000_000_000 })
  repo = createFixtureRepo(fixtureFiles())
})

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true })
  rmSync(repo.path, { recursive: true, force: true })
})

function install(overrides: Parameters<PluginInstaller['install']>[0] extends infer T ? Partial<T> : never = {}) {
  return installer.install({ source: parsePluginSource(repo.path), ...overrides })
}

// ---------------------------------------------------------------------------
// Criterion 2 — clone, build, register
// ---------------------------------------------------------------------------

describe('a plugin installs from a git repository', () => {
  it('fetches, runs the declared build, and registers', async () => {
    const outcome = await install()
    expect(outcome.status).toBe('installed')
    const plugin = outcome.plugin
    expect(plugin?.id).toBe('fixture.viewer')
    expect(plugin?.version).toBe('0.1.0')
    // The build ran, in the checkout, and its output is in the installed tree.
    expect(readFileSync(join(store.rootFor('fixture.viewer'), 'built-marker'), 'utf8')).toBe('built')
    // And it is in the registry, readable by anything with the data root.
    expect(new PluginStore(dataRoot).get('fixture.viewer')?.name).toBe('Fixture Viewer')
  })

  it('records the commit it resolved, not just the ref', async () => {
    const outcome = await install()
    expect(outcome.plugin?.pin.commit).toBe(repo.head())
  })

  it('carries the entrypoints across, placements and all', async () => {
    const plugin = (await install()).plugin
    expect(plugin?.entrypoints.map((entry) => [entry.kind, entry.id, entry.placement])).toEqual([
      ['pane', 'viewer', 'split'],
      ['action', 'echo-env', 'split']
    ])
  })

  it('creates the plugin’s config and state directories', async () => {
    const plugin = (await install()).plugin
    expect(existsSync(plugin?.configDir ?? '')).toBe(true)
    expect(existsSync(plugin?.stateDir ?? '')).toBe(true)
  })

  it('shows the user what it is about to run before it runs anything', async () => {
    let preview = null as null | { build: readonly (readonly string[])[]; commit: string }
    await installer.install({
      source: parsePluginSource(repo.path),
      confirm: (candidate) => {
        preview = candidate
        return false
      }
    })
    expect(preview?.build).toEqual([['sh', '-c', 'printf built > built-marker']])
    expect(preview?.commit).toBe(repo.head())
  })

  it('installs nothing when the user says no', async () => {
    const outcome = await installer.install({ source: parsePluginSource(repo.path), confirm: () => false })
    expect(outcome.status).toBe('cancelled')
    expect(store.list()).toEqual([])
    expect(existsSync(store.rootFor('fixture.viewer'))).toBe(false)
  })

  it('installs from a subdirectory of a monorepo', async () => {
    const mono = createFixtureRepo([
      { path: 'other/README', body: 'not a plugin' },
      ...fixtureFiles().map((file) => ({ ...file, path: `tools/viewer/${file.path}` }))
    ])
    try {
      const outcome = await installer.install({ source: parsePluginSource(`${mono.path}`), ref: 'HEAD' }).catch(() => null)
      // Without the subdir there is no manifest at the root, and that is an error
      // naming the file rather than a stack.
      expect(outcome).toBeNull()
      const scoped = { ...parsePluginSource(mono.path), subdir: ['tools', 'viewer'] }
      const good = await installer.install({ source: scoped })
      expect(good.plugin?.id).toBe('fixture.viewer')
      // Only the plugin's own directory is installed.
      expect(readdirSync(store.rootFor('fixture.viewer'))).toContain('herdr-plugin.toml')
      expect(readdirSync(store.rootFor('fixture.viewer'))).not.toContain('other')
    } finally {
      rmSync(mono.path, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Criterion 6 — a failed build leaves nothing half-installed
// ---------------------------------------------------------------------------

describe('a build that fails', () => {
  const failing = fixtureFiles({
    manifest: `id = "fixture.viewer"
name = "Fixture Viewer"
version = "0.1.0"

[[build]]
command = ["sh", "-c", "printf 'no compiler here' >&2; exit 7"]

[[panes]]
id = "viewer"
title = "Fixture Viewer"
command = ["true"]
`
  })

  it('is reported with the program, the status and its stderr', async () => {
    repo.commit(failing)
    const error = await install().catch((caught: unknown) => caught as PluginInstallError)
    expect(error).toBeInstanceOf(PluginInstallError)
    expect((error as PluginInstallError).code).toBe('plugin_build_failed')
    expect((error as PluginInstallError).message).toContain('status 7')
    expect((error as PluginInstallError).message).toContain('no compiler here')
  })

  it('leaves nothing behind: no registry entry, no store directory, no scratch', async () => {
    repo.commit(failing)
    await install().catch(() => null)
    expect(store.list()).toEqual([])
    expect(existsSync(store.rootFor('fixture.viewer'))).toBe(false)
    expect(existsSync(store.tmpDir) ? readdirSync(store.tmpDir) : []).toEqual([])
  })

  it('leaves a previous installation working', async () => {
    // The dangerous case: a good version is installed, an upgrade's build fails, and
    // the user is left with nothing. The previous checkout is moved aside, not deleted.
    await install()
    const before = readFileSync(join(store.rootFor('fixture.viewer'), 'built-marker'), 'utf8')
    repo.commit(failing)
    await install({ update: true }).catch(() => null)
    expect(store.get('fixture.viewer')?.version).toBe('0.1.0')
    expect(readFileSync(join(store.rootFor('fixture.viewer'), 'built-marker'), 'utf8')).toBe(before)
  })
})

describe('a build that rewrites the manifest', () => {
  it('is refused, because the user approved the file it replaced', async () => {
    // herdr's `ensure_manifest_unchanged_after_build`. Without it a build script
    // appends `[[actions]]` to the manifest the preview rendered and the host
    // registers what nobody saw.
    repo.commit(
      fixtureFiles({
        manifest: `id = "fixture.viewer"
name = "Fixture Viewer"
version = "0.1.0"

[[build]]
command = ["sh", "-c", "printf '\\n[[actions]]\\nid = \\"sneaky\\"\\ntitle = \\"S\\"\\ncommand = [\\"sh\\", \\"-c\\", \\"curl evil\\"]\\n' >> herdr-plugin.toml"]

[[panes]]
id = "viewer"
title = "Fixture Viewer"
command = ["true"]
`
      })
    )
    const error = await install().catch((caught: unknown) => caught as PluginInstallError)
    expect((error as PluginInstallError).code).toBe('plugin_manifest_changed_after_build')
    expect(store.list()).toEqual([])
  })
})

describe('a manifest that does not parse', () => {
  it('fails before the build runs', async () => {
    repo.commit([
      { path: 'herdr-plugin.toml', body: 'id = "Not Valid"\nname = "n"\nversion = "1"\n' },
      { path: 'marker', body: 'x' }
    ])
    const error = await install().catch((caught: unknown) => caught as Error)
    expect((error as { code?: string }).code).toBe('invalid_plugin_id')
    expect(store.list()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Criterion 8 — the install is pinned
// ---------------------------------------------------------------------------

describe('pinning', () => {
  it('fetches the same bytes twice', async () => {
    const first = await install()
    const second = await install()
    expect(second.plugin?.pin.contentHash).toBe(first.plugin?.pin.contentHash)
    expect(second.replaced).toBe(true)
  })

  it('refuses a changed artifact at the same ref rather than installing it', async () => {
    // The tag-rewrite case, exactly: install at v1, somebody moves v1, install again.
    repo.tag('v1')
    await install({ ref: 'v1' })
    repo.commit(fixtureFiles({ manifest: readFileSync(join(repo.path, 'herdr-plugin.toml'), 'utf8').replace('0.1.0', '0.2.0') }))
    repo.tag('v1')

    const error = await install({ ref: 'v1' }).catch((caught: unknown) => caught as PluginInstallError)
    expect((error as PluginInstallError).code).toBe('plugin_artifact_changed')
    expect((error as PluginInstallError).message).toContain('--update')
    // And the installed version is untouched.
    expect(store.get('fixture.viewer')?.version).toBe('0.1.0')
  })

  it('accepts the new bytes when --update says the user meant it', async () => {
    repo.tag('v1')
    await install({ ref: 'v1' })
    repo.commit(fixtureFiles({ manifest: readFileSync(join(repo.path, 'herdr-plugin.toml'), 'utf8').replace('0.1.0', '0.2.0') }))
    repo.tag('v1')
    const outcome = await install({ ref: 'v1', update: true })
    expect(outcome.plugin?.version).toBe('0.2.0')
  })

  it('does not refuse when the ref itself changed, because that is a different request', async () => {
    await install()
    repo.commit(fixtureFiles({ manifest: readFileSync(join(repo.path, 'herdr-plugin.toml'), 'utf8').replace('0.1.0', '0.3.0') }))
    repo.tag('v2')
    const outcome = await install({ ref: 'v2' })
    expect(outcome.plugin?.version).toBe('0.3.0')
  })

  it('checks an explicit --pin on a first install', async () => {
    const hash = (await install()).plugin?.pin.contentHash as string
    store.remove('fixture.viewer')
    await expect(install({ pin: hash })).resolves.toMatchObject({ status: 'installed' })

    store.remove('fixture.viewer')
    const error = await install({ pin: 'sha256:deadbeef' }).catch((caught: unknown) => caught as PluginInstallError)
    expect((error as PluginInstallError).code).toBe('plugin_pin_mismatch')
    expect(store.list()).toEqual([])
  })

  it('pins the source, not the build output', async () => {
    // A build writes into its own checkout. If the pin covered that, the same source
    // would hash two ways on two machines and the check would fire on every install.
    const outcome = await install()
    expect(outcome.plugin?.pin.contentHash).not.toBe(outcome.plugin?.installedHash)
    expect(new PluginStore(dataRoot).verify('fixture.viewer')?.status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Criterion 9 — what happens about revocation, written down as a test
// ---------------------------------------------------------------------------

describe('revocation: what this host does not have', () => {
  it('has no kill list — an installed plugin keeps running until the user removes it', async () => {
    // PHASE-10 decision 3 was answered "nothing, and say so". This test is the saying
    // so: there is no signed list, no fetch, no revocation at a distance. If a plugin
    // turns out to be malicious after a hundred people installed it, a hundred people
    // each have to run `plugin remove`.
    await install()
    expect(store.get('fixture.viewer')).not.toBeNull()

    // Nothing here consults a remote list; there is no such call to make.
    const fresh = new PluginStore(dataRoot)
    expect(fresh.get('fixture.viewer')?.entrypoints).toHaveLength(2)

    // Removal is local, manual, and the only mechanism that exists.
    expect(fresh.remove('fixture.viewer')).toBe(true)
    expect(fresh.get('fixture.viewer')).toBeNull()
  })

  it('does detect a plugin whose files changed after the install', async () => {
    // The one thing that *is* offered instead: an audit a user can run against an
    // advisory. It catches a local change; it cannot catch a plugin that was
    // malicious the day it was published.
    await install()
    writeFileSync(join(store.rootFor('fixture.viewer'), 'built-marker'), 'tampered')
    const report = store.verify('fixture.viewer')
    expect(report?.status).toBe('changed')
  })

  it('publishes the pin so a user can compare it with an advisory', async () => {
    const plugin = (await install()).plugin
    expect(plugin?.pin.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(plugin?.pin.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })
})

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

describe('parsing a source', () => {
  it('reads owner/repo and owner/repo/subdir', () => {
    expect(parsePluginSource('smarzban/herdr-file-viewer')).toEqual({
      kind: 'github',
      owner: 'smarzban',
      repo: 'herdr-file-viewer',
      subdir: []
    })
    expect(parsePluginSource('acme/tools/plugins/viewer')).toMatchObject({ subdir: ['plugins', 'viewer'] })
  })

  it('strips a trailing .git, because people paste clone URLs', () => {
    expect(parsePluginSource('acme/tool.git')).toMatchObject({ repo: 'tool' })
  })

  it('reads an absolute path, a relative one and a file:// URL as the same thing', () => {
    expect(parsePluginSource('/tmp/x')).toEqual({ kind: 'path', path: '/tmp/x', subdir: [] })
    expect(parsePluginSource('file:///tmp/x')).toEqual({ kind: 'path', path: '/tmp/x', subdir: [] })
    expect(parsePluginSource('./x').kind).toBe('path')
  })

  it.each(['', 'owner', 'own er/repo', 'a/b/../c', 'acme/../../etc'])('refuses %s', (raw) => {
    expect(() => parsePluginSource(raw)).toThrow(PluginInstallError)
  })

  it('reads ../../etc/passwd as a local path, which is what it is', () => {
    // Not a traversal: a leading `.` means the user named a directory, and the only
    // thing that happens to it is `git fetch`. The traversal that would matter is a
    // `..` inside a GitHub subdir, which the case above refuses.
    expect(parsePluginSource('../../etc/passwd').kind).toBe('path')
  })

  it('refuses an unexpanded tilde rather than making a directory called ~', () => {
    expect(() => parsePluginSource('~/plugins/x')).toThrow(/expand/u)
  })

  it('sends a local path through file://, so --depth behaves the same either way', () => {
    // git ignores `--depth` on the plain local transport and says so in a warning
    // nobody reads; `file://` is the transport that honours it.
    expect(remoteUrlFor(parsePluginSource('/tmp/x'))).toBe('file:///tmp/x')
    expect(remoteUrlFor(parsePluginSource('acme/tool'))).toBe('https://github.com/acme/tool.git')
  })

  it('labels a source the way the user typed it', () => {
    expect(sourceLabel(parsePluginSource('acme/tool/sub'))).toBe('acme/tool/sub')
  })

  it('refuses a directory that is not a git repository, naming why', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'leap-plain-'))
    try {
      const error = await installer
        .install({ source: parsePluginSource(plain) })
        .catch((caught: unknown) => caught as PluginInstallError)
      expect((error as PluginInstallError).code).toBe('plugin_source_not_a_repository')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})
