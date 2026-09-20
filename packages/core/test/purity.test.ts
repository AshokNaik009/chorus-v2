/**
 * PHASE-4 criterion 1, asserted rather than reviewed.
 *
 * `core` must have zero runtime dependencies. That is what makes the session model
 * testable without PTYs, sockets or a terminal, and it is the one rule in this phase
 * that a single careless import would quietly undo — so it is checked mechanically,
 * three ways: the manifest, the imports, and the globals.
 *
 * This file lives in `test/` rather than `src/` precisely because it needs `node:fs`,
 * which nothing in `src/` may have.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    // Test files may import vitest; the rule is about what ships.
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

describe('@leap-chorus/core has no runtime dependencies', () => {
  it('declares none in its manifest', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual([])
  })

  it('imports nothing outside itself', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(packageRoot, 'src'))) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/gu)) {
        const specifier = match[1] as string
        // Relative imports only. Not `node:*`, not a package, not a workspace sibling.
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          offenders.push(`${file}: ${specifier}`)
        }
      }
      for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
        offenders.push(`${file}: require(${match[1] as string})`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * `tsconfig.json` sets `"types": []`, so `Buffer`, `process` and the rest are not even
   * in scope at compile time. This asserts the setting itself, because removing it is
   * how the rule would come back undone.
   */
  it('compiles without Node type declarations in scope', () => {
    const tsconfig = JSON.parse(readFileSync(join(packageRoot, 'tsconfig.json'), 'utf8')) as {
      compilerOptions?: { types?: string[] }
      references?: unknown[]
    }
    expect(tsconfig.compilerOptions?.types).toEqual([])
    expect(tsconfig.references ?? []).toEqual([])
  })

  it('names no Node global in its source', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(join(packageRoot, 'src'))) {
      const text = readFileSync(file, 'utf8')
      // Comments legitimately discuss `Buffer` and `process`; code must not use them.
      const code = text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|\s)\/\/[^\n]*/gu, '$1')
      for (const global of ['process.', 'Buffer.', '__dirname', 'require(']) {
        if (code.includes(global)) offenders.push(`${file}: ${global}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
