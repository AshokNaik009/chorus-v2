/**
 * The herdr translation table.
 *
 * PHASE-10 criterion 5: "The shim answers all five commands the launchers use." Reading
 * herdr-file-viewer's scripts rather than its description turned up a sixth (`tab focus`)
 * and the fact that the *output* of `pane list` is part of the contract too. All of them
 * are asserted by name below, so a refactor that drops one fails here rather than inside
 * somebody's plugin.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HerdrCompatError, shimScript, translateHerdrArgv, writeShim } from './compat.js'

function translate(line: string, env: NodeJS.ProcessEnv = {}): readonly string[] {
  return translateHerdrArgv(line.split(' ').filter((arg) => arg.length > 0), env).argv
}

describe('the commands herdr-file-viewer\u2019s launchers call', () => {
  it('pane list --json, in herdr\u2019s own output shape', () => {
    // Not `pane list`: a plugin parses this, it does not just call it. The viewer
    // binary deserializes `{result:{panes:[{pane_id,tab_id,…}]}}` and answers OPEN for
    // anything else — which would silently cost it focus-or-close forever.
    expect(translate('pane list --json')).toEqual(['pane', 'list', '--herdr-json'])
    expect(translate('pane list')).toEqual(['pane', 'list', '--herdr-json'])
  })

  it('tab focus, which is the sixth command the launchers actually use', () => {
    expect(translate('tab focus t2')).toEqual(['tab', 'focus', 't2'])
  })

  it('pane zoom <id> --on / --off', () => {
    expect(translate('pane zoom pane-3 --on')).toEqual(['pane', 'zoom', 'pane-3', '--on'])
    expect(translate('pane zoom pane-3 --off')).toEqual(['pane', 'zoom', 'pane-3', '--off'])
    expect(translate('pane zoom pane-3')).toEqual(['pane', 'zoom', 'pane-3'])
  })

  it('pane close <id>', () => {
    expect(translate('pane close pane-3')).toEqual(['pane', 'close', 'pane-3'])
  })

  it('plugin pane open', () => {
    expect(translate('plugin pane open --plugin acme.tool --entrypoint viewer')).toEqual([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'acme.tool',
      '--entrypoint',
      'viewer'
    ])
  })

  it('plugin config-dir <id>', () => {
    expect(translate('plugin config-dir acme.tool')).toEqual(['plugin', 'config-dir', 'acme.tool'])
  })

  it('and pane focus, which is not one of the five but costs a line', () => {
    expect(translate('pane focus pane-3')).toEqual(['pane', 'focus', 'pane-3'])
  })
})

describe('what a plugin\u2019s own environment supplies', () => {
  it('defaults --plugin and --entrypoint from the ids herdr sets on the process', () => {
    // A launcher script that trusts the environment rather than repeating itself is
    // the normal case; herdr's CLI requires both flags and ours does not.
    expect(translate('plugin pane open', { HERDR_PLUGIN_ID: 'acme.tool', HERDR_PLUGIN_ENTRYPOINT_ID: 'viewer' })).toEqual([
      'plugin',
      'pane',
      'open',
      '--plugin',
      'acme.tool',
      '--entrypoint',
      'viewer'
    ])
  })

  it('lets an explicit flag beat the environment', () => {
    expect(translate('plugin pane open --plugin other', { HERDR_PLUGIN_ID: 'acme.tool' })).toContain('other')
  })

  it('defaults config-dir from the environment too', () => {
    expect(translate('plugin config-dir', { HERDR_PLUGIN_ID: 'acme.tool' })).toEqual([
      'plugin',
      'config-dir',
      'acme.tool'
    ])
  })

  it('fails with a sentence when there is nothing to default from', () => {
    expect(() => translate('plugin pane open')).toThrow(/--plugin/u)
    expect(() => translate('plugin config-dir')).toThrow(/plugin id/u)
  })
})

describe('placements this multiplexer does not have', () => {
  it.each(['overlay', 'popup', 'zoomed'])('turns %s into a split and says so', (declared) => {
    const result = translateHerdrArgv(['plugin', 'pane', 'open', '--plugin', 'a', '--placement', declared], {})
    expect(result.argv).toContain('split')
    expect(result.notes.join(' ')).toContain(declared)
  })

  it('passes split and tab through with nothing to say', () => {
    for (const placement of ['split', 'tab']) {
      const result = translateHerdrArgv(['plugin', 'pane', 'open', '--plugin', 'a', '--placement', placement], {})
      expect(result.argv).toContain(placement)
      expect(result.notes).toEqual([])
    }
  })

  it('refuses a placement herdr has never had rather than guessing', () => {
    expect(() => translate('plugin pane open --plugin a --placement sidebar')).toThrow(HerdrCompatError)
  })
})

describe('flags that have no counterpart', () => {
  it('reports --width and --height rather than dropping them silently', () => {
    // Silently ignoring a geometry request leaves a plugin author debugging a layout
    // that was never asked for.
    const result = translateHerdrArgv(['plugin', 'pane', 'open', '--plugin', 'a', '--width', '50%'], {})
    expect(result.notes.join(' ')).toContain('--width')
    expect(result.argv).not.toContain('50%')
  })

  it('reports --workspace, because honouring it would move the user', () => {
    const result = translateHerdrArgv(['plugin', 'pane', 'open', '--plugin', 'a', '--workspace', 'w1'], {})
    expect(result.notes.join(' ')).toContain('--workspace')
  })

  it('carries --target-pane, --direction, --cwd, --env and --no-focus across', () => {
    expect(
      translate('plugin pane open --plugin a --target-pane p1 --direction down --cwd /tmp --env K=V --no-focus')
    ).toEqual([
      'plugin',
      'pane',
      'open',
      '--target-pane',
      'p1',
      '--direction',
      'down',
      '--cwd',
      '/tmp',
      '--env',
      'K=V',
      '--no-focus',
      '--plugin',
      'a'
    ])
  })
})

describe('anything else is an error, not a guess', () => {
  it.each([
    'plugin install acme/tool',
    'plugin list',
    'pane split',
    'workspace create',
    'tab create',
    'plugin pane resize'
  ])('refuses %s', (line) => {
    expect(() => translate(line)).toThrow(HerdrCompatError)
  })

  it('refuses an option it does not know', () => {
    expect(() => translate('plugin pane open --plugin a --colour red')).toThrow(/--colour/u)
  })

  it('refuses a flag with no value', () => {
    expect(() => translate('plugin pane open --plugin')).toThrow(/needs a value/u)
  })

  it('prints its own usage, which says it is not herdr', () => {
    const message = (() => {
      try {
        translate('--help')
      } catch (error) {
        return (error as Error).message
      }
      return ''
    })()
    expect(message).toContain('NOT herdr')
  })
})

describe('the generated wrapper', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leap-shim-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('says in its first lines that it is not herdr', () => {
    // Decision 4: whoever finds this file while debugging learns what it is without
    // having to run it.
    expect(shimScript('/usr/bin/node', '/opt/leap/main.js')).toContain('NOT herdr')
  })

  it('execs the client with --compat herdr and forwards the arguments', () => {
    const script = shimScript('/usr/bin/node', '/opt/leap/main.js')
    expect(script).toContain(`exec '/usr/bin/node' '/opt/leap/main.js' --compat herdr "$@"`)
  })

  it('quotes paths, because a data root can contain a space', () => {
    const script = shimScript("/usr/bin/no de", "/opt/le'ap/main.js")
    expect(script).toContain(`'/usr/bin/no de'`)
    expect(script).toContain(`'/opt/le'\\''ap/main.js'`)
  })

  it('names one target when the client is a bundled binary with no separate entry', () => {
    expect(shimScript('/opt/leap-chorus', null)).toContain(`exec '/opt/leap-chorus' --compat herdr "$@"`)
  })

  it('writes an executable file, whatever the umask', () => {
    const path = writeShim(join(dir, 'bin', 'herdr-compat'), { execPath: '/usr/bin/node', entry: '/opt/main.js' })
    expect(statSync(path).mode & 0o111).toBe(0o111)
    expect(readFileSync(path, 'utf8')).toContain('--compat herdr')
  })

  it('overwrites a stale one, because node moves when the user upgrades', () => {
    const path = join(dir, 'bin', 'herdr-compat')
    writeShim(path, { execPath: '/old/node', entry: '/old/main.js' })
    writeShim(path, { execPath: '/new/node', entry: '/new/main.js' })
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('/new/node')
    expect(body).not.toContain('/old/node')
  })
})
