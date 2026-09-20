import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isEntrypoint } from './adopt.js'
import { isDaemonError } from './errors.js'
import {
  assertSocketPathFits,
  legacyDataRoots,
  migrateLegacyDataRoot,
  resolveDataRoot,
  resolveDaemonPaths,
  SUN_PATH_MAX_BYTES
} from './paths.js'

describe('data root resolution', () => {
  it('prefers LEAP_CHORUS_DATA_DIR', () => {
    expect(resolveDataRoot({ LEAP_CHORUS_DATA_DIR: '/tmp/explicit', XDG_DATA_HOME: '/tmp/xdg' })).toBe('/tmp/explicit')
  })

  it('falls back to XDG_DATA_HOME/leap-chorus, then ~/.leap-chorus', () => {
    expect(resolveDataRoot({ XDG_DATA_HOME: '/tmp/xdg' })).toBe('/tmp/xdg/leap-chorus')
    expect(resolveDataRoot({})).toBe(join(homedir(), '.leap-chorus'))
  })

  it('places the endpoint and lock under daemon/, named by generation', () => {
    const paths = resolveDaemonPaths({ dataRoot: '/tmp/root', protocolVersion: 3 })
    expect(paths.socketPath).toBe('/tmp/root/daemon/daemon-v3.sock')
    expect(paths.lockPath).toBe('/tmp/root/daemon/daemon-v3.lock')
    expect(paths.daemonDir).toBe('/tmp/root/daemon')
  })
})

describe('the pre-v1 data root', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'leap-chorus-migrate-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const env = (): NodeJS.ProcessEnv => ({ XDG_DATA_HOME: root })

  it('names the roots the old build would have used', () => {
    expect(legacyDataRoots({ XDG_DATA_HOME: '/tmp/xdg' })).toEqual([
      '/tmp/xdg/herdr',
      join(homedir(), '.herdr')
    ])
  })

  it('moves a pre-rename root, session file and all', () => {
    const old = join(root, 'herdr', 'daemon')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'session-v1.json'), '{"version":1}')

    const migration = migrateLegacyDataRoot({ env: env() })
    expect(migration?.moved).toBe(true)
    expect(migration?.to).toBe(join(root, 'leap-chorus'))
    expect(readFileSync(join(root, 'leap-chorus', 'daemon', 'session-v1.json'), 'utf8')).toBe('{"version":1}')
    expect(existsSync(join(root, 'herdr'))).toBe(false)
  })

  it('refuses to move a root a pre-rename daemon still owns, and says why', () => {
    const old = join(root, 'herdr', 'daemon')
    mkdirSync(old, { recursive: true })
    writeFileSync(join(old, 'daemon-v1.sock'), '')
    writeFileSync(join(old, 'daemon-v1.lock'), '{}')

    const migration = migrateLegacyDataRoot({ env: env() })
    expect(migration?.moved).toBe(false)
    expect(migration?.reason).toContain('daemon-v1.sock')
    // The old root is left exactly where the running daemon expects it.
    expect(existsSync(join(root, 'herdr', 'daemon', 'daemon-v1.sock'))).toBe(true)
  })

  it('leaves an existing new root alone', () => {
    mkdirSync(join(root, 'herdr', 'daemon'), { recursive: true })
    mkdirSync(join(root, 'leap-chorus', 'daemon'), { recursive: true })
    expect(migrateLegacyDataRoot({ env: env() })).toBeNull()
    expect(existsSync(join(root, 'herdr'))).toBe(true)
  })

  it('does nothing when the root was chosen explicitly', () => {
    mkdirSync(join(root, 'herdr'), { recursive: true })
    expect(migrateLegacyDataRoot({ env: env(), dataRoot: join(root, 'elsewhere') })).toBeNull()
    expect(migrateLegacyDataRoot({ env: { ...env(), LEAP_CHORUS_DATA_DIR: join(root, 'x') } })).toBeNull()
  })

  it('does nothing when there is no pre-rename root', () => {
    expect(migrateLegacyDataRoot({ env: env() })).toBeNull()
  })
})

describe('sun_path budget', () => {
  it('accepts the default endpoint on this machine', () => {
    const paths = resolveDaemonPaths({})
    expect(() => assertSocketPathFits(paths.socketPath)).not.toThrow()
    // Recorded so the handoff can state the measured worst case, not a guess.
    expect(Buffer.byteLength(paths.socketPath, 'utf8')).toBeLessThan(SUN_PATH_MAX_BYTES)
  })

  /**
   * PHASE-5 Part D: the renamed root is 6 bytes longer than the phase-1 one, and
   * `assertSocketPathFits` is "there to be trusted, not assumed". So measure both
   * shapes of the default root against the real cap rather than asserting the delta.
   */
  it('still fits after the rename, at both default roots', () => {
    const viaHome = resolveDaemonPaths({ env: {} }).socketPath
    const viaXdg = resolveDaemonPaths({ env: { XDG_DATA_HOME: join(homedir(), '.local', 'share') } }).socketPath
    for (const path of [viaHome, viaXdg]) {
      expect(() => assertSocketPathFits(path)).not.toThrow()
      // Headroom, not just a pass: a home directory longer than this still works.
      expect(SUN_PATH_MAX_BYTES - 1 - Buffer.byteLength(path, 'utf8')).toBeGreaterThan(20)
    }
    expect(viaHome.endsWith('/.leap-chorus/daemon/daemon-v1.sock')).toBe(true)
  })

  it('refuses an over-long path by name rather than as ENAMETOOLONG at bind time', () => {
    const tooLong = `/tmp/${'d'.repeat(SUN_PATH_MAX_BYTES)}/daemon/daemon-v1.sock`
    try {
      assertSocketPathFits(tooLong)
      expect.unreachable('expected a DaemonError')
    } catch (error) {
      expect(isDaemonError(error)).toBe(true)
      expect(isDaemonError(error) && error.code).toBe('leap_chorus_socket_path_too_long')
    }
  })

  it('counts the NUL terminator against the cap', () => {
    // Exactly maxBytes - 1 characters fits; one more does not.
    const fits = `/${'a'.repeat(SUN_PATH_MAX_BYTES - 2)}`
    expect(Buffer.byteLength(fits, 'utf8')).toBe(SUN_PATH_MAX_BYTES - 1)
    expect(() => assertSocketPathFits(fits)).not.toThrow()
    expect(() => assertSocketPathFits(`${fits}a`)).toThrow()
  })

  it('measures bytes, not characters', () => {
    const multibyte = `/tmp/${'é'.repeat(60)}.sock`
    expect(multibyte.length).toBeLessThan(SUN_PATH_MAX_BYTES)
    expect(() => assertSocketPathFits(multibyte)).toThrow()
  })
})

describe('the entrypoint guard', () => {
  /**
   * The bug this pins down shipped as far as a built tarball: the client started,
   * printed nothing and exited 0, because `import.meta.url` said `/private/var/...`
   * and `process.argv[1]` said `/var/...`. On macOS that is not a corner case — it is
   * every path under `/tmp` and `/var`.
   */
  it('matches a module run through a symlinked path', () => {
    const real = realpathSync(tmpdir())
    // `tmpdir()` is `/var/folders/...` and its real path is `/private/var/folders/...`
    // on macOS; on Linux the two are equal and the test still holds.
    const file = join(tmpdir(), 'entry.js')
    const realFile = join(real, 'entry.js')
    writeFileSync(realFile, '')
    try {
      expect(isEntrypoint(pathToFileURL(realFile).href, file)).toBe(true)
      expect(isEntrypoint(pathToFileURL(realFile).href, realFile)).toBe(true)
    } finally {
      rmSync(realFile, { force: true })
    }
  })

  it('says no for a module that was imported, not run', () => {
    expect(isEntrypoint(pathToFileURL('/tmp/a.js').href, '/tmp/b.js')).toBe(false)
  })

  it('says no when there is no argv[1] at all', () => {
    // `node -e` and the REPL both leave it undefined.
    expect(isEntrypoint(pathToFileURL('/tmp/a.js').href, undefined)).toBe(false)
    expect(isEntrypoint(pathToFileURL('/tmp/a.js').href, '')).toBe(false)
  })
})
