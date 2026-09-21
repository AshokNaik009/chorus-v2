import { describe, expect, it } from 'vitest'
import {
  currentPluginPlatform,
  effectivePlatforms,
  parsePluginManifest,
  platformAllows,
  PluginManifestError
} from './manifest.js'

const MINIMAL = `id = "acme.tool"
name = "Acme Tool"
version = "1.2.3"
`

function parse(extra: string): ReturnType<typeof parsePluginManifest> {
  return parsePluginManifest(`${MINIMAL}${extra}`)
}

function codeOf(body: () => unknown): string {
  try {
    body()
  } catch (error) {
    if (error instanceof PluginManifestError) return error.code
    throw error
  }
  throw new Error('expected a PluginManifestError')
}

describe('identity', () => {
  it('reads the required fields and trims them', () => {
    const manifest = parsePluginManifest(`id = "acme.tool"
name = "  Acme Tool  "
version = "1.2.3"
description = "  does things  "
`)
    expect(manifest.id).toBe('acme.tool')
    expect(manifest.name).toBe('Acme Tool')
    expect(manifest.description).toBe('does things')
  })

  it('treats an empty description as absent rather than as an empty string', () => {
    expect(parse('description = "   "\n').description).toBeNull()
  })

  it.each([
    ['../escape', 'a relative path'],
    ['Acme.Tool', 'an uppercase letter'],
    ['acme tool', 'a space'],
    ['-leading', 'a leading dash'],
    ['acme/tool', 'a separator'],
    ['a..b', 'a doubled dot']
  ])('refuses %s as a plugin id (%s)', (id) => {
    expect(codeOf(() => parsePluginManifest(`id = "${id}"\nname = "n"\nversion = "1"\n`))).toBe('invalid_plugin_id')
  })

  it('refuses an id the store uses for its own directories', () => {
    // `store` would install into the directory holding every installation.
    expect(codeOf(() => parsePluginManifest('id = "store"\nname = "n"\nversion = "1"\n'))).toBe('invalid_plugin_id')
  })

  it('refuses an id longer than herdr allows', () => {
    const id = 'a'.repeat(121)
    expect(codeOf(() => parsePluginManifest(`id = "${id}"\nname = "n"\nversion = "1"\n`))).toBe('invalid_plugin_id')
  })

  it.each([
    ['name', 'invalid_plugin_name'],
    ['version', 'invalid_plugin_version']
  ])('requires %s', (field, code) => {
    const body = MINIMAL.split('\n')
      .filter((line) => !line.startsWith(field))
      .join('\n')
    expect(codeOf(() => parsePluginManifest(body))).toBe(code)
  })

  it('names the line when the TOML itself is broken', () => {
    const error = (() => {
      try {
        parsePluginManifest('id = "a\n')
      } catch (caught) {
        return caught as PluginManifestError
      }
      return null
    })()
    expect(error?.code).toBe('plugin_manifest_parse_failed')
    expect(error?.message).toContain('line 1')
  })
})

describe('commands', () => {
  it('reads argv as an array and never splits a string', () => {
    const manifest = parse(`[[actions]]
id = "run"
title = "Run"
command = ["sh", "-c", "echo hello world"]
`)
    expect(manifest.entrypoints[0]?.command).toEqual(['sh', '-c', 'echo hello world'])
  })

  it.each([
    ['command = "sh -c echo"', 'a bare string'],
    ['command = []', 'an empty array'],
    ['command = ["  "]', 'a blank program'],
    ['command = ["sh", 3]', 'a non-string argument']
  ])('refuses %s (%s)', (line) => {
    expect(codeOf(() => parse(`[[actions]]\nid = "run"\ntitle = "Run"\n${line}\n`))).toBe('invalid_plugin_command')
  })

  it('requires a command on every entrypoint', () => {
    expect(codeOf(() => parse('[[panes]]\nid = "v"\ntitle = "V"\n'))).toBe('invalid_plugin_command')
  })
})

describe('placements', () => {
  it('keeps split and tab as declared', () => {
    const manifest = parse(`[[panes]]
id = "a"
title = "A"
placement = "tab"
command = ["true"]
`)
    expect(manifest.entrypoints[0]?.placement).toBe('tab')
    expect(manifest.entrypoints[0]?.placementFallbackFrom).toBeNull()
  })

  it.each(['overlay', 'popup', 'zoomed'])('falls %s back to a split and says where it came from', (declared) => {
    const manifest = parse(`[[panes]]
id = "a"
title = "A"
placement = "${declared}"
command = ["true"]
`)
    // The fallback is reported rather than hidden: a plugin author who asked for a
    // popup should be able to find out they did not get one.
    expect(manifest.entrypoints[0]?.placement).toBe('split')
    expect(manifest.entrypoints[0]?.placementFallbackFrom).toBe(declared)
  })

  it('defaults a pane with no placement to a split', () => {
    const manifest = parse('[[panes]]\nid = "a"\ntitle = "A"\ncommand = ["true"]\n')
    expect(manifest.entrypoints[0]?.placement).toBe('split')
  })

  it('refuses a placement it has never heard of instead of guessing', () => {
    expect(
      codeOf(() => parse('[[panes]]\nid = "a"\ntitle = "A"\nplacement = "sidebar"\ncommand = ["true"]\n'))
    ).toBe('invalid_plugin_placement')
  })

  it('ignores placement on an action, which is always headless', () => {
    const manifest = parse('[[actions]]\nid = "a"\ntitle = "A"\nplacement = "tab"\ncommand = ["true"]\n')
    expect(manifest.entrypoints[0]?.placement).toBe('split')
    expect(manifest.ignored).toContain('actions.a.placement (unknown)')
  })
})

describe('platforms', () => {
  it('accepts windows even though nothing here runs it', () => {
    // Parsing is not offering. Refusing the *word* would make every cross-platform
    // plugin uninstallable on macOS and Linux for no gain.
    expect(parse('platforms = ["windows", "macos"]\n').platforms).toEqual(['windows', 'macos'])
  })

  it('de-duplicates rather than complaining', () => {
    expect(parse('platforms = ["linux", "linux"]\n').platforms).toEqual(['linux'])
  })

  it('refuses a platform name it does not know, and lists the ones it does', () => {
    const error = (() => {
      try {
        parse('platforms = ["bsd"]\n')
      } catch (caught) {
        return caught as PluginManifestError
      }
      return null
    })()
    expect(error?.code).toBe('invalid_plugin_platform')
    expect(error?.message).toContain('linux, macos, windows')
  })

  it('lets an entry override the plugin, and inherits when it does not', () => {
    expect(effectivePlatforms([], ['linux'])).toEqual(['linux'])
    expect(effectivePlatforms(['macos'], ['linux'])).toEqual(['macos'])
    expect(effectivePlatforms([], [])).toEqual([])
  })

  it('treats an empty platform list as every platform', () => {
    expect(platformAllows([], 'macos')).toBe(true)
    expect(platformAllows([], null)).toBe(true)
    expect(platformAllows(['linux'], 'macos')).toBe(false)
    expect(platformAllows(['linux'], null)).toBe(false)
  })

  it('maps node platform names to herdr ones', () => {
    expect(currentPluginPlatform('darwin')).toBe('macos')
    expect(currentPluginPlatform('linux')).toBe('linux')
    expect(currentPluginPlatform('win32')).toBe('windows')
    expect(currentPluginPlatform('aix')).toBeNull()
  })
})

describe('what is ignored is named', () => {
  it('reports event hooks, startup commands and link handlers', () => {
    const manifest = parse(`min_herdr_version = "3.0.0"

[[events]]
on = "pane.exit"
command = ["true"]

[[startup]]
command = ["true"]

[[link_handlers]]
id = "h"
title = "H"
pattern = "x"
action = "a"
`)
    expect(manifest.ignored).toEqual(['[[events]]', '[[link_handlers]]', '[[startup]]', 'min_herdr_version'])
  })

  it('marks an unknown key as unknown, so a typo is distinguishable from a skipped feature', () => {
    expect(parse('platfroms = ["linux"]\n').ignored).toEqual(['platfroms (unknown)'])
  })

  it('reports per-entry keys it does not honour, by entrypoint id', () => {
    const manifest = parse(`[[panes]]
id = "viewer"
title = "V"
command = ["true"]
width = "50%"
height = 20
contexts = ["pane"]
`)
    expect(manifest.ignored).toEqual([
      'panes.viewer.contexts',
      'panes.viewer.height',
      'panes.viewer.width'
    ])
  })

  it('says nothing when a manifest uses only what is honoured', () => {
    expect(parse('[[panes]]\nid = "v"\ntitle = "V"\ncommand = ["true"]\n').ignored).toEqual([])
  })
})

describe('entrypoints', () => {
  it('puts panes before actions, each sorted, so two reads agree', () => {
    const manifest = parse(`[[actions]]
id = "zulu"
title = "Z"
command = ["true"]

[[actions]]
id = "alpha"
title = "A"
command = ["true"]

[[panes]]
id = "mike"
title = "M"
command = ["true"]
`)
    expect(manifest.entrypoints.map((entry) => `${entry.kind}:${entry.id}`)).toEqual([
      'pane:mike',
      'action:alpha',
      'action:zulu'
    ])
  })

  it('refuses two panes with the same id', () => {
    const body = `[[panes]]
id = "v"
title = "A"
command = ["true"]

[[panes]]
id = "v"
title = "B"
command = ["true"]
`
    expect(codeOf(() => parse(body))).toBe('duplicate_plugin_pane_id')
  })

  it('allows a pane and an action to share an id, the way herdr does', () => {
    // Separate namespaces in herdr; `rpc/plugins.ts` resolves the pane first.
    const manifest = parse(`[[panes]]
id = "run"
title = "P"
command = ["true"]

[[actions]]
id = "run"
title = "A"
command = ["true"]
`)
    expect(manifest.entrypoints).toHaveLength(2)
  })

  it('refuses a [[panes]] written as a table rather than an array of tables', () => {
    expect(codeOf(() => parse('[panes]\nid = "v"\n'))).toBe('invalid_plugin_manifest')
  })
})
