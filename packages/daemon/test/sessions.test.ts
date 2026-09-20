/**
 * Real PTYs, real programs. These cover the acceptance criteria that only a live pty
 * can prove: that a shell's output reaches a snapshot, that a resize reaches the child,
 * and that a codepoint split across two pty reads survives the byte boundary.
 */

import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionManager, type Session } from '../src/sessions.js'
import { snapshotToText } from '../src/snapshot.js'

const BASH = '/bin/bash'
const BASH_ARGS = ['--norc', '--noprofile'] as const

let manager: SessionManager | null = null

afterEach(() => {
  manager?.disposeAll()
  manager = null
})

function newManager(): SessionManager {
  manager = new SessionManager()
  return manager
}

async function waitFor(check: () => boolean | Promise<boolean>, describeFailure: () => string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out: ${describeFailure()}`)
}

async function screenOf(session: Session): Promise<string> {
  await session.settle()
  return snapshotToText(session.snapshot())
}

async function waitForText(session: Session, needle: string, timeoutMs = 10_000): Promise<string> {
  let last = ''
  await waitFor(
    async () => {
      last = await screenOf(session)
      return last.includes(needle)
    },
    () => `screen never contained ${JSON.stringify(needle)}. Last screen:\n${last}`,
    timeoutMs
  )
  return last
}

/**
 * Split a marker so the tty's echo of the typed command does not match it.
 *
 * Without this, a test that waits for its own marker matches the echoed command line and
 * proceeds before the shell has run anything.
 */
function echoMarkerCommand(marker: string): string {
  const cut = Math.floor(marker.length / 2)
  return `echo "${marker.slice(0, cut)}""${marker.slice(cut)}"`
}

/**
 * Block until the shell is actually reading commands.
 *
 * Input written before then is buffered by the tty and eventually runs, so the risk is
 * not lost input but a test that samples the screen before anything has happened.
 */
async function waitForShell(session: Session): Promise<void> {
  const marker = `ready-${randomBytes(4).toString('hex')}`
  session.writeText(`${echoMarkerCommand(marker)}\n`)
  await waitForText(session, marker)
}

function newShell(sessions: SessionManager, cols = 80, rows = 24): Session {
  return sessions.create({ cols, rows, command: BASH, args: [...BASH_ARGS] })
}

/**
 * A pane that renders every input byte it receives as printable ASCII.
 *
 * `cat -v` escapes anything non-printing, but only outside a UTF-8 locale — under
 * `LC_ALL=en_US.UTF-8` BSD cat passes a high byte straight through, and the emulator then
 * shows U+FFFD whether or not the byte survived, which proves nothing. `LC_ALL=C` makes
 * the escaping unconditional. Echo is off so the only thing on screen is cat's output,
 * not the tty's raw echo of what was typed.
 */
function byteEcho(
  sessions: SessionManager,
  cols = 80,
  rows = 24,
  script = 'stty -echo; exec cat -v'
): Session {
  return sessions.create({ cols, rows, command: '/bin/sh', args: ['-c', script], env: { LC_ALL: 'C', LANG: 'C' } })
}

/** How `cat -v` under LC_ALL=C renders one byte. */
function catVisible(byte: number): string {
  if (byte >= 0x80) return `M-${catVisible(byte - 0x80)}`
  if (byte === 0x7f) return '^?'
  if (byte < 0x20) return `^${String.fromCharCode(byte + 0x40)}`
  return String.fromCharCode(byte)
}

describe('PTY-backed sessions', () => {
  it('runs a shell and reads its output back from a snapshot (criterion 2)', async () => {
    const sessions = newManager()
    const session = newShell(sessions)
    expect(session.pid).toBeGreaterThan(0)
    await waitForShell(session)

    session.writeText('echo hello\n')
    const text = await waitForText(session, 'hello')
    expect(text).toMatch(/^hello$/mu)
    expect(session.info().bytesRead).toBeGreaterThan(0)
  })

  it('reports exit and stops claiming a pid', async () => {
    const sessions = newManager()
    const session = sessions.create({ cols: 40, rows: 10, command: BASH, args: ['--norc', '-c', 'exit 3'] })
    const exit = await new Promise<{ exitCode: number }>((resolve) => {
      const off = sessions.subscribe({
        exit: (_id, value) => {
          off()
          resolve(value)
        }
      })
    })
    expect(exit.exitCode).toBe(3)
    expect(session.alive).toBe(false)
    expect(session.pid).toBeNull()
    // The screen survives the process; a dead pane is still readable.
    expect(() => session.snapshot()).not.toThrow()
  })

  it('resizes the pty and the emulator together (criterion 6)', async () => {
    const sessions = newManager()
    const session = newShell(sessions)
    await waitForShell(session)

    session.resize(200, 50)
    expect(session.emulator.cols).toBe(200)
    expect(session.emulator.rows).toBe(50)

    const snapshot = session.snapshot()
    expect(snapshot.cols).toBe(200)
    expect(snapshot.rows).toBe(50)
    expect(snapshot.lines).toHaveLength(50)
    expect(snapshot.lines.every((line) => line.runs.reduce((sum, run) => sum + run.width, 0) === 200)).toBe(true)

    // The child sees the new size too, or SIGWINCH never landed.
    session.writeText('echo "size=$(tput cols)x$(tput lines)"\n')
    const text = await waitForText(session, 'size=200x50')
    expect(text).toContain('size=200x50')
    expect(session.info().cols).toBe(200)
  })

  it('joins a codepoint split across two pty reads (criterion 7)', async () => {
    const sessions = newManager()
    const session = newShell(sessions, 40, 6)
    await waitForShell(session)

    // Two bytes, a pause, then the third: the pty delivers this as separate reads, so the
    // codepoint genuinely straddles an onData boundary. A Buffer.toString() per chunk
    // would produce two replacement characters here.
    session.writeText("printf '\\xe4\\xb8'; sleep 0.4; printf '\\x96\\n'\n")
    const text = await waitForText(session, '世')
    expect(text).toContain('世')
    expect(text).not.toContain('\ufffd')
  })

  it('delivers a non-UTF-8 input byte to the child unchanged', async () => {
    // Phase 3's reason for making the whole input path bytes. A legacy X10 mouse report
    // encodes a column as `32 + column`, so column 200 is 0xE8 — a byte no valid UTF-8
    // string can carry. Before this, it reached the pane as EF BF BD (U+FFFD) and the
    // report came out two bytes longer than it went in.
    const sessions = newManager()
    const session = byteEcho(sessions)

    session.write(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28, 0x0a]))
    // The whole report comes back as printable ASCII, so the assertion is on the exact
    // byte. A mangled 0xE8 would read `M-oM-?M-=` — the three bytes of U+FFFD.
    const text = await waitForText(session, 'M-h')
    expect(text).toContain('^[[M M-h(')
    expect(text).not.toContain('M-oM-?M-=')
  })

  it('round-trips every byte value 0x01..0xFF through a session write', async () => {
    const sessions = newManager()
    // -icanon -isig -ixon -iexten so the line discipline stops acting on ^C, ^D, ^S, ^Z,
    // DEL, and the two IEXTEN characters that are easy to forget: ^O (discard output) and
    // ^V (literal next, which eats itself *and* quotes the byte after it). OPOST stays on,
    // so the output still gets its CR before every LF and the screen does not stair-step.
    const session = byteEcho(
      sessions,
      240,
      24,
      'stty -echo -icanon -isig -ixon -iexten min 1 time 0; printf READY\\\\n; exec cat -vt'
    )
    // The write has to land after stty has run, or the bytes are consumed under the old
    // settings — which is the shape of the first version of this test.
    await waitForText(session, 'READY')

    // Every byte but NUL (swallowed by the tty regardless), LF and CR (emitted as real
    // line endings rather than escapes, so they are not part of a contiguous run). The
    // 0x80..0xFF half is the point: each of those is invalid UTF-8 on its own, and each
    // arrived as U+FFFD before the input path carried bytes.
    const values = Array.from({ length: 255 }, (_, i) => i + 1).filter((byte) => byte !== 0x0a && byte !== 0x0d)
    session.write(Buffer.from(values))

    const expected = values.map(catVisible).join('')
    const text = await waitForText(session, catVisible(0xff), 15_000)
    expect(text.replace(/[\r\n]/gu, '')).toContain(expected)
  })

  it('reflects a full-screen program on the alternate screen (criterion 3)', async () => {
    const sessions = newManager()
    const session = newShell(sessions, 60, 12)
    await waitForShell(session)

    const normalMarker = `normal-${randomBytes(3).toString('hex')}`
    session.writeText(`${echoMarkerCommand(normalMarker)}\n`)
    await waitForText(session, normalMarker)

    const altMarker = `alt-${randomBytes(3).toString('hex')}`
    session.writeText(`printf '\\033[?1049h'; ${echoMarkerCommand(altMarker)}\n`)
    await waitFor(
      async () => {
        await session.settle()
        return session.emulator.bufferType === 'alternate'
      },
      () => 'the program never switched to the alternate screen'
    )

    const active = session.snapshot()
    expect(active.buffer).toBe('alternate')
    expect(snapshotToText(active)).toContain(altMarker)
    expect(snapshotToText(active)).not.toContain(normalMarker)

    // The normal buffer still holds everything the alternate screen is covering.
    const normal = session.snapshot('normal')
    expect(normal.buffer).toBe('normal')
    expect(snapshotToText(normal)).toContain(normalMarker)

    session.writeText("printf '\\033[?1049l'\n")
    await waitFor(
      async () => {
        await session.settle()
        return session.emulator.bufferType === 'normal'
      },
      () => 'the program never left the alternate screen'
    )
    expect(snapshotToText(session.snapshot())).toContain(normalMarker)
  })

  it('emits coalesced output events rather than one per chunk', async () => {
    const sessions = newManager()
    const session = newShell(sessions)
    await waitForShell(session)

    let events = 0
    let lastSequence = 0
    sessions.subscribe({
      output: (_id, sequence) => {
        events += 1
        expect(sequence).toBeGreaterThanOrEqual(lastSequence)
        lastSequence = sequence
      }
    })

    const doneMarker = `done-${randomBytes(3).toString('hex')}`
    session.writeText(`for i in $(seq 1 400); do echo "line $i"; done; ${echoMarkerCommand(doneMarker)}\n`)
    await waitForText(session, doneMarker)

    expect(session.sequence).toBeGreaterThan(3000)
    // 400 lines of output must not mean 400 wakeups.
    expect(events).toBeLessThan(60)
    expect(lastSequence).toBeGreaterThan(0)
  })
})
