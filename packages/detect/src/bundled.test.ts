/**
 * The bundled manifests, as a build contract.
 *
 * This is the one place real manifests are tested, and it deliberately asserts nothing
 * about what they *mean* — no captured screen, no frozen rule id, no priority. It
 * asserts they load: that every shipped manifest parses, validates and compiles under
 * this engine, and that the generated module still matches the TOML on disk. A rule
 * that no longer describes a shipping CLI is a live-smoke finding, not a red suite.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderBundledManifests } from '../../../scripts/generate-bundled-manifests.mjs'
import { AGENTS } from './agents.js'
import { BUNDLED_MANIFESTS, BUNDLED_MANIFEST_IDS } from './bundled.js'
import { compileManifest, parseManifest } from './manifest.js'
import { ManifestRegistry } from './registry.js'

describe('generated module', () => {
  it('matches the TOML on disk', () => {
    // If this fails: `node scripts/generate-bundled-manifests.mjs`.
    const generated = fileURLToPath(new URL('./bundled.ts', import.meta.url))
    expect(readFileSync(generated, 'utf8')).toBe(renderBundledManifests())
  })
})

describe('every bundled manifest', () => {
  it.each(BUNDLED_MANIFESTS.map(([id, source]) => [id, source] as const))('%s parses and compiles', (id, source) => {
    const manifest = parseManifest(source)
    expect(manifest.id).toBe(id)
    // Compiling is what actually builds the RegExps, so a pattern this engine cannot
    // translate fails here rather than at the first poll on a user's machine.
    expect(() => compileManifest(manifest)).not.toThrow()
  })

  it.each(BUNDLED_MANIFESTS.map(([id]) => id))('%s is declared in AGENTS', (id) => {
    // A manifest nothing can identify is dead weight; an agent with no manifest can be
    // named but not read. Both directions are checked.
    expect(AGENTS.map((agent) => agent.id)).toContain(id)
  })

  it('declares an agent for every manifest and a manifest for every agent', () => {
    expect([...BUNDLED_MANIFEST_IDS].sort()).toEqual(AGENTS.map((agent) => agent.id).sort())
  })

  it('carries a version and an engine floor this engine satisfies', () => {
    for (const [, source] of BUNDLED_MANIFESTS) {
      const manifest = parseManifest(source)
      expect(manifest.version).not.toBeNull()
      expect(manifest.minEngineVersion).not.toBeNull()
    }
  })
})

describe('the registry', () => {
  it('serves a bundled manifest when there is no override', () => {
    const registry = new ManifestRegistry({
      overrideDir: '/nonexistent',
      readFile: () => {
        throw new Error('ENOENT')
      }
    })
    const loaded = registry.get('claude')
    expect(loaded?.source).toBe('bundled')
    expect(loaded?.warning).toBeNull()
  })

  it('knows nothing about an agent it does not bundle', () => {
    expect(new ManifestRegistry({ readFile: () => '' }).get('nonesuch')).toBeNull()
  })
})
