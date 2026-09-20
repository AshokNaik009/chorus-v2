/**
 * Directory listings, including the containment rules.
 *
 * The escape cases matter most: a listing that can be walked out of is worse than no
 * listing, and the symlink case is the one a lexical path check silently lets through.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FsService } from './fs.js'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-fs-'))
  made.push(root)
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, '.github'))
  writeFileSync(join(root, 'src/app.ts'), '')
  writeFileSync(join(root, 'README.md'), '')
  writeFileSync(join(root, '.gitignore'), '')
  return root
}

const fs = new FsService()

describe('FsService.list', () => {
  it('sorts directories first, then names case-insensitively', async () => {
    const root = tree()
    const listing = await fs.list(root, '')
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      '.github',
      'src',
      '.gitignore',
      'README.md'
    ])
  })

  it('marks what each entry is', async () => {
    const root = tree()
    const listing = await fs.list(root, '')
    expect(listing.entries.find((entry) => entry.name === 'src')?.kind).toBe('dir')
    expect(listing.entries.find((entry) => entry.name === 'README.md')?.kind).toBe('file')
  })

  it('lists a subdirectory by its relative path', async () => {
    const root = tree()
    const listing = await fs.list(root, 'src')
    expect(listing.path).toBe('src')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['app.ts'])
  })

  it('refuses to climb out with ..', async () => {
    const root = tree()
    await expect(fs.list(root, '..')).rejects.toThrow(/escapes the root/)
    await expect(fs.list(root, 'src/../..')).rejects.toThrow(/escapes the root/)
  })

  it('refuses an absolute path', async () => {
    const root = tree()
    await expect(fs.list(root, '/etc')).rejects.toThrow(/must be relative/)
  })

  it('refuses a symlink that points outside the root', async () => {
    const root = tree()
    const outside = mkdtempSync(join(tmpdir(), 'lc-outside-'))
    made.push(outside)
    writeFileSync(join(outside, 'secret.txt'), '')
    symlinkSync(outside, join(root, 'escape'))
    // A lexical check passes this: `root/escape` looks like it is under `root`.
    await expect(fs.list(root, 'escape')).rejects.toThrow(/escapes the root/)
  })

  it('follows a symlink that stays inside the root', async () => {
    const root = tree()
    symlinkSync(join(root, 'src'), join(root, 'alias'))
    const listing = await fs.list(root, 'alias')
    expect(listing.entries.map((entry) => entry.name)).toEqual(['app.ts'])
  })

  it('reports a file rather than listing it', async () => {
    const root = tree()
    await expect(fs.list(root, 'README.md')).rejects.toThrow(/not a directory/)
  })

  it('reports a directory that is not there', async () => {
    const root = tree()
    await expect(fs.list(root, 'nope')).rejects.toThrow(/no such directory/)
  })
})
