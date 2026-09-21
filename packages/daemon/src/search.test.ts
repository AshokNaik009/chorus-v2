/**
 * Search: argv, caps, classification, and the streaming runner.
 *
 * ## Why there are two kinds of test here
 *
 * `rg` is **not installed on the development machine** (see HANDOFF.md), so nothing in
 * this file may depend on it existing. Two substitutes, each proving something the
 * other cannot:
 *
 * - a **fake runner**, which parses the argv the service built and matches it against
 *   an in-memory corpus. It is not a re-implementation of ripgrep for its own sake: it
 *   is how a test asserts that `--word-regexp` *changes the result set* rather than
 *   only that the flag was in the array. It parses argv rather than being told the
 *   options, so it cannot agree with `buildContentArgs` by construction.
 * - a **fake `rg` binary**, a Node script the real `createRipgrepRunner` spawns. That
 *   covers what a fake runner by definition cannot: chunked UTF-8 decoding, killing
 *   the child at a cap, the timeout, exit codes, and `ENOENT`.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ErrorCodes } from '@leap-chorus/protocol'
import { RequestError } from './rpc/params.js'
import {
  MAX_LINE_LENGTH,
  RipgrepLaunchError,
  RipgrepMissingError,
  SearchService,
  buildContentArgs,
  buildFilesArgs,
  classifySpawnFailure,
  clipLine,
  createRipgrepRunner,
  expandGlobs,
  isTransientSpawnError,
  linuxInstallCommand,
  parseRgLine,
  searchPath,
  type RipgrepOutcome,
  type RipgrepRun,
  type RipgrepRunner
} from './search.js'

const temporary: string[] = []

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// A fake ripgrep that reads the argv it was given
// ---------------------------------------------------------------------------

/** One line of one file in the corpus the fake searches. */
interface CorpusFile {
  readonly path: string
  readonly lines: readonly string[]
}

/** rg's glob rule: no slash matches the basename at any depth, a slash matches the path. */
function globMatches(pattern: string, path: string): boolean {
  const body = pattern
    .split('*')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/gu, '\\$&'))
    .join('\u0000')
    .replace(/\u0000\u0000/gu, '.*')
    .replace(/\u0000/gu, '[^/]*')
  const target = pattern.includes('/') ? path : (path.split('/').pop() ?? path)
  return new RegExp(`^${body}$`, 'u').test(target)
}

/**
 * A runner that behaves like `rg --json` over `corpus`, driven only by its argv.
 *
 * Deliberately independent of `buildContentArgs`: it re-reads every flag from the
 * array, so a test that changes one option and sees the result change has proved that
 * the flag we emit is the flag ripgrep would act on.
 */
function fakeRipgrep(corpus: readonly CorpusFile[], calls: string[][] = []): RipgrepRunner {
  return (run: RipgrepRun) => {
    calls.push([...run.args])
    const args = [...run.args]
    const listOnly = args.includes('--files')
    const ignoreCase = args.includes('--ignore-case')
    const wholeWord = args.includes('--word-regexp')
    const fixed = args.includes('--fixed-strings')
    const includes: string[] = []
    const excludes: string[] = []
    let maxPerFile = Number.POSITIVE_INFINITY
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--glob') {
        const pattern = args[i + 1] as string
        if (pattern.startsWith('!')) excludes.push(pattern.slice(1))
        else includes.push(pattern)
        i++
      }
      if (args[i] === '--max-count') maxPerFile = Number(args[i + 1])
    }
    const separator = args.indexOf('--')
    const query = separator === -1 ? '' : (args[separator + 1] as string)

    const visible = corpus.filter(
      (file) =>
        (includes.length === 0 || includes.some((pattern) => globMatches(pattern, file.path))) &&
        !excludes.some((pattern) => globMatches(pattern, file.path))
    )

    let stop = false
    const emit = (line: string): void => {
      if (!stop && run.onLine(line) === 'stop') stop = true
    }
    if (listOnly) {
      for (const file of visible) emit(file.path)
    } else {
      const body = fixed ? query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : query
      const pattern = new RegExp(wholeWord ? `\\b(?:${body})\\b` : body, `g${ignoreCase ? 'iu' : 'u'}`)
      for (const file of visible) {
        let perFile = 0
        for (const [index, text] of file.lines.entries()) {
          if (stop || perFile >= maxPerFile) break
          pattern.lastIndex = 0
          const submatches: { start: number; end: number }[] = []
          let found = pattern.exec(text)
          while (found !== null) {
            // Byte offsets, as rg reports them — not character offsets. The conversion
            // back is the service's job and one of the tests below turns on it.
            submatches.push({
              start: Buffer.byteLength(text.slice(0, found.index), 'utf8'),
              end: Buffer.byteLength(text.slice(0, found.index + found[0].length), 'utf8')
            })
            if (found[0].length === 0) pattern.lastIndex += 1
            found = pattern.exec(text)
          }
          if (submatches.length === 0) continue
          perFile += 1
          emit(
            JSON.stringify({
              type: 'match',
              data: {
                path: { text: file.path },
                line_number: index + 1,
                lines: { text: `${text}\n` },
                submatches
              }
            })
          )
        }
      }
    }
    const outcome: RipgrepOutcome = { code: stop ? null : 0, stderr: '', stopped: stop, timedOut: false }
    return Promise.resolve(outcome)
  }
}

const CORPUS: readonly CorpusFile[] = [
  { path: 'src/alpha.ts', lines: ['const Needle = 1', 'needles everywhere', 'nothing here'] },
  { path: 'src/deep/beta.ts', lines: ['a needle in a haystack'] },
  { path: 'docs/readme.md', lines: ['the Needle documented'] }
]

function service(runner: RipgrepRunner, options: Record<string, unknown> = {}): SearchService {
  return new SearchService({ ripgrep: runner, installCommand: async () => 'brew install ripgrep', ...options })
}

// ---------------------------------------------------------------------------

describe('the ripgrep argv', () => {
  it('guards the query with `--` and targets the working directory', () => {
    const args = buildContentArgs('-v', {})
    expect(args.slice(-3)).toEqual(['--', '-v', '.'])
    // Without the guard, a query beginning with a dash parses as a flag.
    expect(args.indexOf('--')).toBe(args.length - 3)
  })

  it('caps per file and by file size, and never walks .git', () => {
    const args = buildContentArgs('x', {})
    expect(args).toContain('--json')
    expect(args).toContain('--hidden')
    expect(args.join(' ')).toContain('--glob !.git')
    expect(args.join(' ')).toContain('--max-count 100')
    expect(args.join(' ')).toContain(`--max-filesize ${1024 * 1024}`)
  })

  it('spells each option the way ripgrep does', () => {
    expect(buildContentArgs('x', {})).toContain('--ignore-case')
    expect(buildContentArgs('x', { matchCase: true })).not.toContain('--ignore-case')
    expect(buildContentArgs('x', { wholeWord: true })).toContain('--word-regexp')
    expect(buildContentArgs('x', {})).toContain('--fixed-strings')
    expect(buildContentArgs('x', { regex: true })).not.toContain('--fixed-strings')
  })

  it('lists files without a query operand', () => {
    expect(buildFilesArgs()).not.toContain('--')
    expect(buildFilesArgs()).toContain('--files')
  })
})

describe('glob expansion', () => {
  it('splits on commas and drops the empties', () => {
    expect(expandGlobs(' *.ts , , *.md ')).toEqual(['*.ts', '*.md'])
  })

  it('reads a bare directory name as everything under it, at any depth', () => {
    // Somebody who types `src` means the tree, not a file called `src`. herdr-sidebar's
    // `build_search_globs` does the same expansion.
    expect(expandGlobs('src')).toEqual(['src', 'src/**', '**/src/**'])
    expect(expandGlobs('packages/core')).toEqual(['packages/core', 'packages/core/**'])
  })
})

describe('content search', () => {
  it('groups matches by file and counts them', async () => {
    const result = await service(fakeRipgrep(CORPUS)).content('/root', 'needle')
    expect(result.files.map((file) => file.path)).toEqual(['src/alpha.ts', 'src/deep/beta.ts', 'docs/readme.md'])
    expect(result.totalMatches).toBe(4)
    expect(result.truncated).toBe(false)
    expect(result.cap).toBeNull()
    expect(result.files[0]?.matches[0]).toMatchObject({ line: 1, column: 7, text: 'const Needle = 1' })
  })

  it('an empty query searches nothing rather than everything', async () => {
    const calls: string[][] = []
    const result = await service(fakeRipgrep(CORPUS, calls)).content('/root', '')
    expect(result.files).toEqual([])
    expect(calls).toHaveLength(0)
  })

  // Criterion 4: each of the four option groups changes the result set.
  it('case sensitivity changes the result set', async () => {
    const insensitive = await service(fakeRipgrep(CORPUS)).content('/root', 'needle')
    const sensitive = await service(fakeRipgrep(CORPUS)).content('/root', 'needle', { matchCase: true })
    expect(insensitive.totalMatches).toBe(4)
    expect(sensitive.totalMatches).toBe(2)
    expect(sensitive.files.map((file) => file.path)).toEqual(['src/alpha.ts', 'src/deep/beta.ts'])
  })

  it('whole word changes the result set', async () => {
    const loose = await service(fakeRipgrep(CORPUS)).content('/root', 'needle')
    const strict = await service(fakeRipgrep(CORPUS)).content('/root', 'needle', { wholeWord: true })
    // `needles` on line 2 of alpha.ts survives the loose search and not the strict one.
    expect(loose.totalMatches - strict.totalMatches).toBe(1)
  })

  it('regex changes the result set', async () => {
    // `needle.` is a literal nobody has written and a pattern everything matches.
    const literal = await service(fakeRipgrep(CORPUS)).content('/root', 'needle.')
    const pattern = await service(fakeRipgrep(CORPUS)).content('/root', 'needle.', { regex: true })
    expect(literal.totalMatches).toBe(0)
    expect(pattern.totalMatches).toBe(4)
  })

  it('include and exclude globs change the result set', async () => {
    const included = await service(fakeRipgrep(CORPUS)).content('/root', 'needle', { include: '*.md' })
    expect(included.files.map((file) => file.path)).toEqual(['docs/readme.md'])
    const excluded = await service(fakeRipgrep(CORPUS)).content('/root', 'needle', { exclude: 'docs' })
    expect(excluded.files.map((file) => file.path)).toEqual(['src/alpha.ts', 'src/deep/beta.ts'])
  })

  // Criterion 5, first half: a tiny cap rather than a huge repository.
  it('reports the match cap instead of quietly returning fewer', async () => {
    const result = await service(fakeRipgrep(CORPUS), { matchLimit: 2 }).content('/root', 'needle')
    expect(result.totalMatches).toBe(2)
    expect(result.truncated).toBe(true)
    expect(result.cap).toBe('matches')
  })

  it('reports the file cap the same way', async () => {
    const result = await service(fakeRipgrep(CORPUS), { fileLimit: 1 }).content('/root', 'needle')
    expect(result.cap).toBe('files')
    expect(result.truncated).toBe(true)
  })

  // Criterion 5, second half: the timeout is a cap and reports as one.
  it('a timed-out search is truncated, not complete', async () => {
    const slow: RipgrepRunner = () =>
      Promise.resolve({ code: null, stderr: '', stopped: false, timedOut: true })
    const result = await service(slow).content('/root', 'needle')
    expect(result.truncated).toBe(true)
    expect(result.cap).toBe('time')
  })

  it('relays ripgrep’s own complaint about a bad pattern', async () => {
    const broken: RipgrepRunner = () =>
      Promise.resolve({ code: 2, stderr: 'regex parse error: unclosed group\n', stopped: false, timedOut: false })
    await expect(service(broken).content('/root', '(')).rejects.toMatchObject({
      code: ErrorCodes.badRequest,
      message: 'regex parse error: unclosed group'
    })
  })

  it('says what is missing, with this platform’s install line', async () => {
    const absent: RipgrepRunner = () => Promise.reject(new RipgrepMissingError())
    const error = (await service(absent)
      .content('/root', 'needle')
      .catch((thrown: unknown) => thrown)) as RequestError
    expect(error).toBeInstanceOf(RequestError)
    expect(error.code).toBe(ErrorCodes.searchUnavailable)
    expect(error.message).toContain('brew install ripgrep')
    // The claim is about *our* PATH, which is the only one the daemon can speak for.
    expect(error.message).toContain('daemon PATH')
  })

  it('a launch failure is not install advice', async () => {
    const wedged: RipgrepRunner = () => Promise.reject(new RipgrepLaunchError('EMFILE'))
    const error = (await service(wedged)
      .content('/root', 'needle')
      .catch((thrown: unknown) => thrown)) as RequestError
    expect(error.message).toContain('EMFILE')
    expect(error.message).not.toContain('brew install')
  })
})

describe('the file list', () => {
  it('lists what ripgrep prints, sorted case-insensitively', async () => {
    const result = await service(
      fakeRipgrep([{ path: 'b.ts', lines: [] }, { path: 'A.ts', lines: [] }, { path: 'src/c.ts', lines: [] }])
    ).files('/root')
    expect(result.files).toEqual(['A.ts', 'b.ts', 'src/c.ts'])
    expect(result.engine).toBe('ripgrep')
    expect(result.truncated).toBe(false)
  })

  it('reports the file cap', async () => {
    const corpus = Array.from({ length: 5 }, (_unused, index) => ({ path: `f${index}.ts`, lines: [] }))
    const result = await service(fakeRipgrep(corpus), { fileLimit: 2 }).files('/root')
    expect(result.files).toHaveLength(2)
    expect(result.cap).toBe('files')
    expect(result.truncated).toBe(true)
  })

  // Criterion 6: quick open still works in a repository with no ripgrep.
  it('falls back to git ls-files inside a repository', async () => {
    const seen: string[][] = []
    const git = async (args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
      seen.push([...args])
      if (args[0] === 'rev-parse') return { stdout: 'true\n', stderr: '', code: 0 }
      return { stdout: 'b.ts\0A.ts\0', stderr: '', code: 0 }
    }
    const absent: RipgrepRunner = () => Promise.reject(new RipgrepMissingError())
    const result = await service(absent, { git }).files('/root')
    expect(result.engine).toBe('git')
    expect(result.files).toEqual(['A.ts', 'b.ts'])
    // Detected with rev-parse, never by looking for a `.git` entry: the latter answers
    // "no" from a subdirectory of a checkout and lists ignored build output instead.
    expect(seen[0]).toEqual(['rev-parse', '--is-inside-work-tree'])
    expect(seen[1]).toContain('--exclude-standard')
  })

  it('outside a repository there is nothing to fall back to, so it says so', async () => {
    const git = async (): Promise<{ stdout: string; stderr: string; code: number }> => ({
      stdout: '',
      stderr: 'not a git repository',
      code: 128
    })
    const absent: RipgrepRunner = () => Promise.reject(new RipgrepMissingError())
    await expect(service(absent, { git }).files('/root')).rejects.toMatchObject({
      code: ErrorCodes.searchUnavailable
    })
  })
})

// ---------------------------------------------------------------------------
// Criterion 7
// ---------------------------------------------------------------------------

describe('classifying a spawn failure', () => {
  it('EMFILE is not "ripgrep is not installed"', () => {
    const classified = classifySpawnFailure(Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }))
    expect(classified).toBeInstanceOf(RipgrepLaunchError)
    expect(classified).not.toBeInstanceOf(RipgrepMissingError)
    expect(classified.message).toContain('EMFILE')
    expect(isTransientSpawnError({ code: 'EMFILE' })).toBe(true)
  })

  it('every fork/exec pressure code is transient', () => {
    for (const code of ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'ETXTBSY']) {
      expect(isTransientSpawnError({ code })).toBe(true)
      expect(classifySpawnFailure({ code })).toBeInstanceOf(RipgrepLaunchError)
    }
    expect(isTransientSpawnError({ code: 'ENOENT' })).toBe(false)
  })

  it('only ENOENT means there is no such program', () => {
    expect(classifySpawnFailure({ code: 'ENOENT' })).toBeInstanceOf(RipgrepMissingError)
    expect(classifySpawnFailure({ code: 'EACCES' })).toBeInstanceOf(RipgrepLaunchError)
    expect(classifySpawnFailure(new Error('no code'))).toBeInstanceOf(RipgrepLaunchError)
  })
})

// ---------------------------------------------------------------------------
// Criterion 8
// ---------------------------------------------------------------------------

describe('clipping a long line', () => {
  it('leaves a short line exactly as it was', () => {
    expect(clipLine('hello world', 6, 5)).toEqual({
      text: 'hello world',
      column: 7,
      matchLength: 5,
      displayColumn: 7,
      displayMatchLength: 5
    })
  })

  it('windows a long line around the match, not from the start', () => {
    const line = `${'x'.repeat(5000)}NEEDLE${'y'.repeat(5000)}`
    const clipped = clipLine(line, 5000, 6)
    expect(clipped.text).toContain('NEEDLE')
    expect(clipped.text.length).toBeLessThanOrEqual(MAX_LINE_LENGTH + 2)
    expect(clipped.text.startsWith('…')).toBe(true)
    expect(clipped.text.endsWith('…')).toBe(true)
    // The true column survives, which is what keeps "open at that line" honest.
    expect(clipped.column).toBe(5001)
    expect(clipped.text.slice(clipped.displayColumn - 1, clipped.displayColumn - 1 + 6)).toBe('NEEDLE')
  })

  it('a match at the very start keeps its window flush left', () => {
    const clipped = clipLine(`HIT${'z'.repeat(5000)}`, 0, 3)
    expect(clipped.text.startsWith('HIT')).toBe(true)
    expect(clipped.displayColumn).toBe(1)
  })

  it('a clipped line still travels with the line number it was found on', async () => {
    const long = `${'a'.repeat(4000)}needle${'b'.repeat(4000)}`
    const corpus = [{ path: 'min.js', lines: ['first', long] }]
    const result = await service(fakeRipgrep(corpus)).content('/root', 'needle')
    const match = result.files[0]?.matches[0]
    expect(match?.line).toBe(2)
    expect(match?.column).toBe(4001)
    expect(match?.text.length).toBeLessThan(long.length)
  })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parsing rg --json', () => {
  it('ignores every record that is not a match', () => {
    expect(parseRgLine('')).toBeNull()
    expect(parseRgLine('not json')).toBeNull()
    expect(parseRgLine(JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }))).toBeNull()
    expect(parseRgLine(JSON.stringify({ type: 'summary', data: {} }))).toBeNull()
  })

  it('reads the structured fields rather than splitting on colons', () => {
    // A path with a colon in it is exactly what `--vimgrep` cannot express.
    const parsed = parseRgLine(
      JSON.stringify({
        type: 'match',
        data: {
          path: { text: 'weird:name.ts' },
          line_number: 12,
          lines: { text: 'let x = 1\n' },
          submatches: [{ start: 4, end: 5 }]
        }
      })
    )
    expect(parsed).toMatchObject({ path: 'weird:name.ts', line: 12, text: 'let x = 1' })
    expect(parsed?.submatches).toEqual([{ start: 4, end: 5 }])
  })

  it('skips a path rg could not express as text', () => {
    expect(
      parseRgLine(JSON.stringify({ type: 'match', data: { path: { bytes: 'AAA=' }, line_number: 1 } }))
    ).toBeNull()
  })

  it('a match with no submatch ranges is still navigable', () => {
    const parsed = parseRgLine(
      JSON.stringify({ type: 'match', data: { path: { text: 'a.ts' }, line_number: 3, lines: { text: 'hi\n' } } })
    )
    expect(parsed?.submatches).toEqual([{ start: 0, end: 1 }])
  })

  it('converts rg’s byte offsets to character offsets', async () => {
    // rg reports submatch offsets in bytes; `é` is two of them and one JS character.
    const corpus = [{ path: 'a.ts', lines: ['éé needle'] }]
    const result = await service(fakeRipgrep(corpus)).content('/root', 'needle')
    // Byte offset 5, character offset 3, column 4. Without the conversion the panel
    // would highlight one character to the left of the match on any accented line.
    expect(result.files[0]?.matches[0]?.column).toBe(4)
  })
})

describe('the daemon PATH', () => {
  it('adds the usual install directories without disturbing the user’s order', () => {
    const path = searchPath({ PATH: '/first:/second' }, '/home/u')
    expect(path.startsWith('/first:/second:')).toBe(true)
    expect(path.split(':')).toContain('/home/u/.local/bin')
    expect(path.split(':')).toContain('/home/u/.cargo/bin')
    expect(path.split(':')).toContain('/opt/homebrew/bin')
  })

  it('never lists a directory twice', () => {
    const parts = searchPath({ PATH: '/usr/bin:/bin' }, '/home/u').split(':')
    expect(new Set(parts).size).toBe(parts.length)
  })
})

describe('the install line', () => {
  it('reads ID and ID_LIKE out of /etc/os-release', () => {
    expect(linuxInstallCommand('ID=ubuntu\nNAME="Ubuntu"\n')).toBe('sudo apt install ripgrep')
    expect(linuxInstallCommand('ID=linuxmint\nID_LIKE="ubuntu debian"\n')).toBe('sudo apt install ripgrep')
    expect(linuxInstallCommand('ID=arch\n')).toBe('sudo pacman -S ripgrep')
    expect(linuxInstallCommand('ID=alpine\n')).toBe('sudo apk add ripgrep')
    expect(linuxInstallCommand('ID=plan9\n')).toContain('package manager')
  })
})

// ---------------------------------------------------------------------------
// The real runner, against a fake `rg` binary
// ---------------------------------------------------------------------------

/**
 * A Node script that impersonates `rg` well enough to exercise the runner.
 *
 * `FAKE_RG` picks the behaviour. It is written to a temp file rather than committed as
 * a fixture so it stays next to the test that explains it.
 */
const FAKE_RG_SOURCE = `
const mode = process.env.FAKE_RG
if (mode === 'hang') {
  process.stdout.write('{"type":"begin"}\\n')
  setInterval(() => {}, 1000)
} else if (mode === 'split') {
  // One JSON record cut in half mid-multibyte-character, written as two chunks.
  const record = JSON.stringify({
    type: 'match',
    data: { path: { text: 'café.ts' }, line_number: 1, lines: { text: 'héllo needle\\n' }, submatches: [{ start: 7, end: 13 }] }
  }) + '\\n'
  const bytes = Buffer.from(record, 'utf8')
  const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1
  process.stdout.write(bytes.subarray(0, cut))
  setTimeout(() => { process.stdout.write(bytes.subarray(cut)); process.exit(0) }, 10)
} else if (mode === 'flood') {
  let n = 0
  const tick = () => {
    for (let i = 0; i < 50; i++) {
      process.stdout.write(JSON.stringify({
        type: 'match',
        data: { path: { text: 'a.ts' }, line_number: ++n, lines: { text: 'needle\\n' }, submatches: [{ start: 0, end: 6 }] }
      }) + '\\n')
    }
    if (n < 100000) setTimeout(tick, 1)
  }
  tick()
} else if (mode === 'badregex') {
  process.stderr.write('regex parse error: unclosed group\\n')
  process.exit(2)
} else if (mode === 'notail') {
  // A last line with no trailing newline, which the decoder has to flush.
  process.stdout.write('a.ts\\nb.ts')
  process.exit(0)
}
`

let fakeRgPath = ''
function fakeRgScript(): string {
  if (fakeRgPath === '') {
    fakeRgPath = join(scratch('lc-rg-'), 'fake-rg.mjs')
    writeFileSync(fakeRgPath, FAKE_RG_SOURCE)
  }
  return fakeRgPath
}

function realRunner(mode: string): RipgrepRunner {
  return createRipgrepRunner({
    command: process.execPath,
    prefixArgs: [fakeRgScript()],
    env: { ...process.env, FAKE_RG: mode }
  })
}

describe('the spawning runner', () => {
  it('decodes a record split across chunks, and across a character', async () => {
    const lines: string[] = []
    const outcome = await realRunner('split')({
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onLine: (line) => {
        lines.push(line)
        return 'continue'
      }
    })
    expect(outcome.code).toBe(0)
    expect(lines).toHaveLength(1)
    expect(parseRgLine(lines[0] as string)).toMatchObject({ path: 'café.ts', text: 'héllo needle' })
  })

  it('flushes a final line that had no newline after it', async () => {
    const lines: string[] = []
    await realRunner('notail')({
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onLine: (line) => {
        lines.push(line)
        return 'continue'
      }
    })
    expect(lines).toEqual(['a.ts', 'b.ts'])
  })

  it('kills the child the moment the caller says stop', async () => {
    let seen = 0
    const outcome = await realRunner('flood')({
      args: [],
      cwd: process.cwd(),
      timeoutMs: 20_000,
      onLine: () => (++seen >= 10 ? 'stop' : 'continue')
    })
    expect(outcome.stopped).toBe(true)
    expect(seen).toBe(10)
  })

  it('kills a child that runs past the timeout and says it timed out', async () => {
    const outcome = await realRunner('hang')({
      args: [],
      cwd: process.cwd(),
      timeoutMs: 150,
      onLine: () => 'continue'
    })
    expect(outcome.timedOut).toBe(true)
  })

  it('keeps stderr and the exit code for a pattern ripgrep refused', async () => {
    const outcome = await realRunner('badregex')({
      args: [],
      cwd: process.cwd(),
      timeoutMs: 5_000,
      onLine: () => 'continue'
    })
    expect(outcome.code).toBe(2)
    expect(outcome.stderr).toContain('regex parse error')
  })

  it('an absent program is a missing ripgrep, not a crash', async () => {
    const runner = createRipgrepRunner({ command: join(scratch('lc-rg-'), 'definitely-not-rg') })
    await expect(
      runner({ args: [], cwd: process.cwd(), timeoutMs: 1_000, onLine: () => 'continue' })
    ).rejects.toBeInstanceOf(RipgrepMissingError)
  })

  // Criterion 6, the PATH half: with `rg` off PATH and the augmentation disabled,
  // spawning `rg` by name is ENOENT — which is the state this machine is in anyway.
  it('an empty PATH means missing, and nothing throws out of the promise', async () => {
    const runner = createRipgrepRunner({
      command: 'rg',
      env: { PATH: scratch('lc-empty-') },
      augmentPath: false
    })
    await expect(
      runner({ args: buildFilesArgs(), cwd: process.cwd(), timeoutMs: 1_000, onLine: () => 'continue' })
    ).rejects.toBeInstanceOf(RipgrepMissingError)
  })
})

describe('end to end with no ripgrep at all', () => {
  /** A repository with one tracked file, one untracked, and one ignored. */
  function repo(): string {
    const root = scratch('lc-search-')
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' })
    }
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    writeFileSync(join(root, '.gitignore'), 'built/\n')
    writeFileSync(join(root, 'tracked.ts'), 'const needle = 1\n')
    git('add', '--all')
    git('commit', '-q', '-m', 'first')
    writeFileSync(join(root, 'fresh.ts'), 'needle again\n')
    writeFileSync(join(root, 'built'), '')
    rmSync(join(root, 'built'))
    writeFileSync(join(root, 'ignored-anyway.log'), '')
    writeFileSync(join(root, '.gitignore'), 'built/\n*.log\n')
    return root
  }

  const absent = (): SearchService =>
    new SearchService({
      ripgrep: createRipgrepRunner({ command: 'rg', env: { PATH: scratch('lc-empty-') }, augmentPath: false }),
      installCommand: async () => 'brew install ripgrep'
    })

  it('quick open still lists the repository, ignored files absent', async () => {
    const result = await absent().files(repo())
    expect(result.engine).toBe('git')
    expect(result.files).toContain('tracked.ts')
    expect(result.files).toContain('fresh.ts')
    expect(result.files).not.toContain('ignored-anyway.log')
  })

  it('content search says what is missing and how to fix it', async () => {
    const error = (await absent()
      .content(repo(), 'needle')
      .catch((thrown: unknown) => thrown)) as RequestError
    expect(error).toBeInstanceOf(RequestError)
    expect(error.message).toContain('brew install ripgrep')
  })
})
