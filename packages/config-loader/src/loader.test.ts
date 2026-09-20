import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '@leap-chorus/core'
import { configSearchPaths, loadConfig, parseSource, summarizeProblems } from './loader.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'leap-chorus-cfg-'))
  roots.push(root)
  return root
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true })
})

describe('the search path', () => {
  it('LEAP_CHORUS_CONFIG names a file and skips the search', () => {
    expect(configSearchPaths({ LEAP_CHORUS_CONFIG: '/etc/leap-chorus.toml' })).toEqual(['/etc/leap-chorus.toml'])
  })

  it('XDG_CONFIG_HOME comes before the data root', () => {
    const paths = configSearchPaths({ XDG_CONFIG_HOME: '/xdg', LEAP_CHORUS_DATA_DIR: '/data' })
    expect(paths[0]).toBe('/xdg/leap-chorus/config.toml')
    expect(paths[1]).toBe('/data/config.toml')
  })

  it('a relative XDG_CONFIG_HOME is ignored, as the spec says', () => {
    const paths = configSearchPaths({ XDG_CONFIG_HOME: 'relative' })
    expect(paths[0]).not.toContain('relative')
  })
})

describe('loading', () => {
  it('a missing file is not an error', () => {
    const loaded = loadConfig({ path: join(tempRoot(), 'nope.toml') })
    expect(loaded.errors).toEqual([])
    expect(loaded.problems).toEqual([])
    expect(loaded.path).toBeNull()
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
  })

  it('reads and validates a real file', () => {
    const root = tempRoot()
    const path = join(root, 'config.toml')
    writeFileSync(path, '[ui]\nsidebar-width = 30\n[keys]\nprefix = "C-a"\n')
    const loaded = loadConfig({ path })
    expect(loaded.path).toBe(path)
    expect(loaded.errors).toEqual([])
    expect(loaded.config.ui.sidebarWidth).toBe(30)
    expect(loaded.config.keys.prefix).toBe('C-a')
  })

  it('falls through the search path to the first file that exists', () => {
    const root = tempRoot()
    mkdirSync(join(root, 'xdg', 'leap-chorus'), { recursive: true })
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'config.toml'), '[ui]\nsidebar = false\n')
    const loaded = loadConfig({
      env: { XDG_CONFIG_HOME: join(root, 'xdg'), LEAP_CHORUS_DATA_DIR: join(root, 'data') }
    })
    expect(loaded.path).toBe(join(root, 'data', 'config.toml'))
    expect(loaded.config.ui.sidebar).toBe(false)
  })

  it('a parse error names the line and leaves the defaults in force', () => {
    const root = tempRoot()
    const path = join(root, 'config.toml')
    writeFileSync(path, '[ui]\nsidebar = true\nbroken = @\n')
    const loaded = loadConfig({ path })
    expect(loaded.errors).toHaveLength(1)
    expect(loaded.errors[0]).toContain('line 3')
    expect(loaded.config).toEqual(DEFAULT_CONFIG)
  })

  it('a schema problem keeps the rest of the file', () => {
    const loaded = parseSource('[ui]\nsidebar-width = 900\nsidebar = false\n', 'inline')
    expect(loaded.errors).toEqual([])
    expect(loaded.problems).toHaveLength(1)
    expect(loaded.config.ui.sidebarWidth).toBe(DEFAULT_CONFIG.ui.sidebarWidth)
    expect(loaded.config.ui.sidebar).toBe(false)
  })

  it('an unreadable path that is not ENOENT is reported', () => {
    const loaded = loadConfig({
      path: '/whatever.toml',
      readFile: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
    })
    expect(loaded.errors[0]).toContain('permission denied')
  })

  it('summarizes problems for a one-line status bar', () => {
    const loaded = parseSource('[ui]\nsidebar-width = 900\nnope = 1\n', 'inline')
    expect(summarizeProblems(loaded)).toContain('+1 more')
    expect(summarizeProblems(parseSource('[ui]\nsidebar = true\n', 'inline'))).toBe('')
  })
})

describe('the parser lives here, not in core', () => {
  it('config-loader depends only on core', async () => {
    const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
      dependencies: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies)).toEqual(['@leap-chorus/core'])
  })
})
