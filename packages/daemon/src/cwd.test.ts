/**
 * Live working-directory lookup.
 *
 * The real lookup is exercised against this very process, which is the only way to know
 * the platform branch actually works — a mocked `lsof` would only prove the parser
 * agrees with what this file imagines `lsof` prints.
 */

import { describe, expect, it } from 'vitest'
import { liveCwd, parseLsofCwd } from './cwd.js'

describe('parseLsofCwd', () => {
  it('reads the path from the n-tagged field', () => {
    expect(parseLsofCwd('p12345\nfcwd\nn/Users/someone/project\n')).toBe('/Users/someone/project')
  })

  it('ignores the other fields', () => {
    expect(parseLsofCwd('p12345\nfcwd\nu501\n')).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(parseLsofCwd('')).toBeNull()
  })
})

describe('liveCwd', () => {
  it('finds this process own directory', async () => {
    const found = await liveCwd(process.pid)
    // Resolved on both sides: macOS reports the real path for a symlinked cwd.
    expect(found).not.toBeNull()
    expect(await import('node:fs').then((fs) => fs.realpathSync(found as string))).toBe(
      await import('node:fs').then((fs) => fs.realpathSync(process.cwd()))
    )
  })

  it('returns null for a pid that cannot exist', async () => {
    expect(await liveCwd(-1)).toBeNull()
    expect(await liveCwd(0)).toBeNull()
  })

  it('returns null on a platform with no lookup', async () => {
    expect(await liveCwd(process.pid, 'win32')).toBeNull()
  })
})
