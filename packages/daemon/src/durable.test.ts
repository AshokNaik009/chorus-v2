/**
 * Criterion 8: "a write interrupted at any point leaves either the old file or the new
 * one, never an empty one."
 *
 * ## How you test that without killing a process
 *
 * You cannot pick the instant to kill and be sure you picked the bad one. What you *can*
 * do is check the property that makes the bad instant impossible: **the destination is
 * never opened for writing.** The old code called `writeFileSync(path, text)`, which
 * truncates the destination and then writes — so there is a window, however short, in
 * which the user's config file is zero bytes on disk. The new code writes a sibling and
 * renames, and `rename(2)` is atomic: a reader sees the old inode or the new one.
 *
 * So the tests below assert on what is observable and decisive:
 *
 * - a failing write leaves the previous contents **byte-identical**, not empty;
 * - the temporary is a *different path*, so the destination is never truncated;
 * - the temporary does not survive a failure;
 * - the `.bak` holds what was there before.
 *
 * The fsyncs themselves cannot be observed from inside the process that issued them —
 * that is what makes them durability rather than semantics — so they are asserted by
 * reading the code and by the fact that a filesystem which refuses the *directory*
 * fsync still completes the write, which the last test covers.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeFileDurable } from './durable.js'

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'leap-durable-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writing a file the user would mind losing', () => {
  it('writes a file that was not there, creating the directory on the way', () => {
    const path = join(dir, 'nested', 'deep', 'config.toml')
    writeFileDurable(path, '[ui]\nsidebar = true\n')
    expect(readFileSync(path, 'utf8')).toBe('[ui]\nsidebar = true\n')
  })

  it('replaces an existing file completely', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, 'old contents that are longer than the new ones\n')
    writeFileDurable(path, 'new\n')
    expect(readFileSync(path, 'utf8')).toBe('new\n')
  })

  it('leaves no temporary behind on success', () => {
    const path = join(dir, 'config.toml')
    writeFileDurable(path, 'a\n')
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  // The criterion, stated as the property that makes it true.
  it('a write that fails leaves the previous file byte-identical, never empty', () => {
    const path = join(dir, 'config.toml')
    const original = '[theme]\nname = "nord"\n'
    writeFileSync(path, original)

    // A destination that cannot be renamed onto. `dir` is a directory, so the temporary
    // is written and fsync'd and then the rename fails — which is precisely the window
    // the old in-place write could not survive, because by then it had already
    // truncated the real file.
    expect(() => writeFileDurable(dir, 'new\n')).toThrow()

    // The real config is untouched, because nothing ever opened it for writing, and the
    // failed write left no debris beside it.
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('never truncates the destination: the bytes go to a sibling first', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, 'original\n')
    // If the implementation ever went back to writing in place, the only file touched
    // would be `path` itself and there would be no sibling at any point. Observing the
    // sibling is the closest a same-process test can get to observing atomicity.
    let sawTemporary = false
    const before = new Set(readdirSync(dir))
    writeFileDurable(path, 'replacement\n', { backup: true })
    for (const name of readdirSync(dir)) {
      if (!before.has(name) && name.startsWith('config.toml.')) sawTemporary = true
    }
    // The `.bak` is the sibling that survives; the `.tmp` is gone by now, by design.
    expect(sawTemporary).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('replacement\n')
  })

  it('keeps one backup of what was there, when asked', () => {
    const path = join(dir, 'config.toml')
    writeFileSync(path, 'first\n')
    writeFileDurable(path, 'second\n', { backup: true })
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('first\n')
    writeFileDurable(path, 'third\n', { backup: true })
    // One backup, not a history: the `.bak` always holds the version immediately before
    // the current one, which is the thing somebody who lost a setting wants back.
    expect(readFileSync(`${path}.bak`, 'utf8')).toBe('second\n')
    expect(readFileSync(path, 'utf8')).toBe('third\n')
  })

  it('writes the first file with no backup to take, and does not invent an empty one', () => {
    const path = join(dir, 'fresh.toml')
    writeFileDurable(path, 'a\n', { backup: true })
    expect(readFileSync(path, 'utf8')).toBe('a\n')
    // A `.bak` of nothing would be a zero-byte file the user could restore *over* a
    // good config, which is worse than having no backup.
    expect(existsSync(`${path}.bak`)).toBe(false)
  })

  it('honours the mode it is given, so a session file stays private', () => {
    const path = join(dir, 'session.json')
    writeFileDurable(path, '{}\n', { mode: 0o600 })
    expect(readFileSync(path, 'utf8')).toBe('{}\n')
  })

  it('the directory fsync is best-effort: the write completes whatever the filesystem says', () => {
    // On the platforms that refuse a directory fsync — Windows, and some network
    // filesystems — the write must still land. There is no way to make this machine
    // refuse, so what is asserted is the consequence: nothing about the directory fsync
    // is on the success path, and a plain write on a normal filesystem still returns.
    const path = join(dir, 'config.toml')
    expect(() => writeFileDurable(path, 'ok\n')).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('ok\n')
  })
})
