/**
 * The preview service: bounded reads, binary sniffing, and renderer choice.
 *
 * Criteria 2-5 of PHASE-9 live here. Two of them are the reason this file exists at all
 * rather than being a handful of assertions on a returned object:
 *
 * - **Criterion 3** asks for a test that "would fail if the whole file were read". A
 *   test that only checks `binary: true` would pass against an implementation that
 *   slurps two gigabytes first, so `PreviewOutcome.bytesRead` exists solely to make the
 *   bound observable, and the assertions below are on *that*.
 * - **Criterion 4** asks about a file that grows between the stat and the read. That is
 *   a race, and a test that tried to win it by timing would be flaky. It is provoked
 *   deterministically instead: `readBounded` is given a cap smaller than the file, which
 *   drives exactly the same code path — the probe byte comes back, so `more` is true —
 *   and then the real growth case is checked against a file that is appended to between
 *   two calls.
 */

import { mkdtemp, rm, writeFile, appendFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BINARY_PROBE_BYTES,
  PreviewService,
  isBinaryBuffer,
  readBounded,
  rendererArgs,
  rendererFor,
  type Capture,
  type CaptureOutcome
} from './preview.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'leap-preview-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A capture that never finds anything, which is the machine this runs on. */
const absent: Capture = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  failure: 'absent'
})

/** A capture standing in for an installed renderer. Records what it was asked to run. */
function present(stdout: string, seen: { command?: string; args?: readonly string[] } = {}): Capture {
  return async (command, args) => {
    seen.command = command
    seen.args = args
    return { code: 0, stdout, stderr: '', timedOut: false, failure: null }
  }
}

describe('reading within a bound', () => {
  it('reads the whole of a small file and says there is no more', async () => {
    await writeFile(join(root, 'small.txt'), 'hello\nworld\n')
    const read = await readBounded(join(root, 'small.txt'), 1024)
    expect(read.bytes.toString('utf8')).toBe('hello\nworld\n')
    expect(read.more).toBe(false)
    expect(read.size).toBe(12)
  })

  // Criterion 2: never more than the cap, tested with a file larger than the cap.
  it('stops at the cap on a file larger than it, and pulls exactly one probe byte past', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(50_000))
    const read = await readBounded(join(root, 'big.txt'), 1_000)
    expect(read.bytes.length).toBe(1_000)
    expect(read.more).toBe(true)
    // 1,001 and not 50,000: the whole point. One byte past the cap is how "there is
    // more" is learned, and it is the *only* byte past the cap that is ever read.
    expect(read.bytesRead).toBe(1_001)
  })

  // Criterion 4. The probe byte is what makes a grown file distinguishable from a
  // complete one; without it both come back as a full buffer that looks whole.
  it('a file that grew since it was last read reports more rather than a short buffer', async () => {
    const path = join(root, 'growing.log')
    await writeFile(path, 'a'.repeat(100))
    const first = await readBounded(path, 100)
    expect(first.more).toBe(false)

    await appendFile(path, 'b'.repeat(900))
    // The same cap as before — which is what a caller that remembered the old size
    // would pass. The probe byte comes back, so the short buffer announces itself.
    const second = await readBounded(path, 100)
    expect(second.bytes.length).toBe(100)
    expect(second.more).toBe(true)
  })

  it('refuses a limit that is not a positive integer rather than treating it as unbounded', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    await expect(readBounded(join(root, 'a.txt'), 0)).rejects.toThrow(/positive integer/u)
    await expect(readBounded(join(root, 'a.txt'), -1)).rejects.toThrow(/positive integer/u)
    await expect(readBounded(join(root, 'a.txt'), 1.5)).rejects.toThrow(/positive integer/u)
  })

  it('refuses a directory rather than reading whatever a directory read returns', async () => {
    await mkdir(join(root, 'sub'))
    await expect(readBounded(join(root, 'sub'), 1024)).rejects.toThrow(/directory/u)
  })
})

describe('deciding binary from a bounded prefix', () => {
  it('a NUL makes it binary and no NUL does not', () => {
    expect(isBinaryBuffer(Buffer.from('plain text'))).toBe(false)
    expect(isBinaryBuffer(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
  })

  it('scans at most the probe length even when handed more', () => {
    // A NUL well past the probe window. A scan that looked at the whole buffer would
    // call this binary; a bounded one cannot see it and must not.
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES * 4, 0x61)
    buffer[BINARY_PROBE_BYTES + 10] = 0
    expect(isBinaryBuffer(buffer)).toBe(false)
  })

  // Criterion 3, and the assertion that gives the criterion teeth: this fails if the
  // implementation ever reads the file to decide about the file.
  it('decides from a bounded read — a huge binary file costs one probe, not a slurp', async () => {
    const path = join(root, 'core.dump')
    const body = Buffer.alloc(2 * 1024 * 1024, 0x41)
    body[4] = 0
    await writeFile(path, body)

    const service = new PreviewService({ capture: absent })
    const result = await service.read(root, 'core.dump', 34)

    expect(result.binary).toBe(true)
    expect(result.lines).toEqual([])
    expect(result.size).toBe(2 * 1024 * 1024)
    // The whole file is 2 MiB. Anything above the probe window plus its one extra byte
    // means the bound stopped being enforced by the read.
    expect(result.bytesRead).toBeLessThanOrEqual(BINARY_PROBE_BYTES + 1)
  })

  it('a text file is not refused, and its bytes are not returned as noise', async () => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\nthree\n')
    const service = new PreviewService({ capture: absent })
    const result = await service.read(root, 'a.txt', 34)
    expect(result.binary).toBe(false)
    expect(result.lines).toEqual(['one', 'two', 'three'])
  })
})

describe('caps on the text path', () => {
  it('a file past the byte cap is shown and says there was more', async () => {
    await writeFile(join(root, 'long.txt'), 'line\n'.repeat(1_000))
    const service = new PreviewService({ capture: absent, maxBytes: 100 })
    const result = await service.read(root, 'long.txt', 34)
    expect(result.truncated).toBe(true)
    expect(result.cap).toBe('bytes')
    expect(result.lines.length).toBe(20)
  })

  it('a file past the line cap says so, and says `lines` rather than `bytes`', async () => {
    await writeFile(join(root, 'many.txt'), 'x\n'.repeat(500))
    const service = new PreviewService({ capture: absent, maxLines: 10 })
    const result = await service.read(root, 'many.txt', 34)
    expect(result.lines.length).toBe(10)
    expect(result.cap).toBe('lines')
  })

  it('a complete file reports no cap at all', async () => {
    await writeFile(join(root, 'ok.txt'), 'a\nb\n')
    const service = new PreviewService({ capture: absent })
    const result = await service.read(root, 'ok.txt', 34)
    expect(result.truncated).toBe(false)
    expect(result.cap).toBeNull()
  })

  it('splits CRLF and a bare CR, and does not invent a trailing empty line', async () => {
    await writeFile(join(root, 'mixed.txt'), 'a\r\nb\rc\n')
    const service = new PreviewService({ capture: absent })
    expect((await service.read(root, 'mixed.txt', 34)).lines).toEqual(['a', 'b', 'c'])
  })
})

describe('choosing and running a renderer', () => {
  it('picks glow for markdown, delta for a patch, bat for everything else', () => {
    expect(rendererFor('README.md')).toBe('glow')
    expect(rendererFor('a/b/CHANGES.markdown')).toBe('glow')
    expect(rendererFor('fix.patch')).toBe('delta')
    expect(rendererFor('x.diff')).toBe('delta')
    expect(rendererFor('src/app.ts')).toBe('bat')
    expect(rendererFor('noextension')).toBe('bat')
  })

  it('every renderer is asked for plain text at the width it was given', () => {
    expect(rendererArgs('glow', '/r/a.md', 34)).toContain('notty')
    expect(rendererArgs('glow', '/r/a.md', 34)).toContain('34')
    expect(rendererArgs('bat', '/r/a.ts', 34)).toContain('--color=never')
    expect(rendererArgs('delta', '/r/a.diff', 34)).toContain('--paging=never')
    // `--` before the path in every one, or a filename starting with `-` is a flag.
    for (const renderer of ['glow', 'delta', 'bat'] as const) {
      expect(rendererArgs(renderer, '/r/-weird', 34)).toContain('--')
    }
  })

  // Criterion 5, the present branch.
  it('uses the renderer when it is there, and says which one produced the lines', async () => {
    await writeFile(join(root, 'doc.md'), '# Title\n\nsome *prose*\n')
    const seen: { command?: string; args?: readonly string[] } = {}
    const service = new PreviewService({ capture: present('Title\n\nsome prose\n', seen) })
    const result = await service.read(root, 'doc.md', 40)
    expect(seen.command).toBe('glow')
    expect(result.renderer).toBe('glow')
    expect(result.lines).toEqual(['Title', '', 'some prose'])
  })

  // Criterion 5, the absent branch. This is the machine this test runs on.
  it('takes the plain path when the renderer is absent, and still shows the file', async () => {
    await writeFile(join(root, 'doc.md'), '# Title\n')
    const service = new PreviewService({ capture: absent })
    const result = await service.read(root, 'doc.md', 34)
    expect(result.renderer).toBe('plain')
    expect(result.lines).toEqual(['# Title'])
  })

  it('a renderer that exits non-zero, times out or says nothing falls back rather than failing', async () => {
    await writeFile(join(root, 'a.ts'), 'const x = 1\n')
    const outcomes: CaptureOutcome[] = [
      { code: 2, stdout: 'partial', stderr: 'boom', timedOut: false, failure: null },
      { code: null, stdout: '', stderr: '', timedOut: true, failure: null },
      { code: 0, stdout: '', stderr: '', timedOut: false, failure: null }
    ]
    for (const outcome of outcomes) {
      const service = new PreviewService({ capture: async () => outcome })
      const result = await service.read(root, 'a.ts', 34)
      // A preview must never fail *because* an optional tool did.
      expect(result.renderer).toBe('plain')
      expect(result.lines).toEqual(['const x = 1'])
    }
  })

  it('an absent renderer is probed once, not once per file', async () => {
    await writeFile(join(root, 'a.md'), 'a\n')
    await writeFile(join(root, 'b.md'), 'b\n')
    let calls = 0
    const service = new PreviewService({
      capture: async () => {
        calls += 1
        return { code: null, stdout: '', stderr: '', timedOut: false, failure: 'absent' }
      }
    })
    await service.read(root, 'a.md', 34)
    await service.read(root, 'b.md', 34)
    // A cursor moving down a tree must not fork a process per row to rediscover that
    // `glow` is still not installed.
    expect(calls).toBe(1)
  })

  it('a transient launch failure is NOT remembered — it is not evidence of an absence', async () => {
    await writeFile(join(root, 'a.md'), 'a\n')
    let calls = 0
    const service = new PreviewService({
      capture: async () => {
        calls += 1
        return { code: null, stdout: '', stderr: '', timedOut: false, failure: 'unavailable' }
      }
    })
    await service.read(root, 'a.md', 34)
    await service.read(root, 'a.md', 34)
    // Being out of file descriptors for a moment must not disable the renderer for the
    // life of the daemon. Phase 8 drew this line for `rg`; it is the same line.
    expect(calls).toBe(2)
  })

  it('renderers can be turned off entirely, and then nothing is spawned', async () => {
    await writeFile(join(root, 'a.md'), '# x\n')
    let calls = 0
    const service = new PreviewService({
      useRenderers: false,
      capture: async () => {
        calls += 1
        return { code: 0, stdout: 'never', stderr: '', timedOut: false, failure: null }
      }
    })
    const result = await service.read(root, 'a.md', 34)
    expect(calls).toBe(0)
    expect(result.renderer).toBe('plain')
  })
})

describe('staying inside the root', () => {
  it('refuses a path that climbs out with ..', async () => {
    const service = new PreviewService({ capture: absent })
    await expect(service.read(root, '../outside.txt', 34)).rejects.toThrow(/escapes the root/u)
  })

  it('refuses an absolute path', async () => {
    const service = new PreviewService({ capture: absent })
    await expect(service.read(root, '/etc/hosts', 34)).rejects.toThrow(/relative path/u)
  })

  it('refuses an empty path rather than reading the root', async () => {
    const service = new PreviewService({ capture: absent })
    await expect(service.read(root, '', 34)).rejects.toThrow(/needs a path/u)
  })

  // A lexical check alone passes this: `root/link` has no `..` in it. Resolving first
  // is what catches it.
  it('refuses a symlink inside the root that points outside it', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'leap-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'nope\n')
      await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
      const service = new PreviewService({ capture: absent })
      await expect(service.read(root, 'link.txt', 34)).rejects.toThrow(/escapes the root/u)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('a path with a `..` that stays inside is fine', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'a.txt'), 'yes\n')
    const service = new PreviewService({ capture: absent })
    expect((await service.read(root, 'sub/../a.txt', 34)).lines).toEqual(['yes'])
  })
})
