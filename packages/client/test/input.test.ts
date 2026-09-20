/**
 * Input, end to end through the real client in a real PTY.
 *
 * PHASE-3 criteria 5 (mouse: click to focus) and 6 (a large paste is one event), plus the
 * parts of 7 a machine can check — that a program in a pane receives the same bytes it
 * would outside the multiplexer. The human half of 7 is recorded in HANDOFF.md.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { PLAIN_UI_CONFIG, TuiHarness, markerCommand, waitUntil } from './harness.js'

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

/**
 * A pane that prints every byte it receives as printable ASCII.
 *
 * `cat -v` outside a UTF-8 locale escapes anything non-printing, and `stty raw -echo`
 * stops the line discipline from eating `^C`, `^Z` and friends before cat sees them — so
 * what lands on screen is exactly what the client sent the pane.
 */
async function byteEcho(cols = 120, rows = 30): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols,
    rows,
    command: '/bin/sh',
    args: ['-c', 'stty raw -echo; printf READY; exec cat -v'],
    env: { LC_ALL: 'C', LANG: 'C' },
    // No sidebar or tab bar: these tests are about bytes and coordinates, and the
    // chrome would move every column they assert on. chrome.test.ts covers it.
    config: PLAIN_UI_CONFIG
  })
  await harness.waitForReady()
  await harness.waitForText('READY')
  return harness
}

describe('keys reach the pane as the right bytes', () => {
  it('encodes named keys, arrows and chords', async () => {
    const tui = await byteEcho()

    // Arrow keys, as a terminal sends them, come back as the bytes a program expects.
    tui.write('\x1b[A\x1b[B\x1b[C\x1b[D')
    await tui.waitForText('^[[A^[[B^[[C^[[D')

    // A Ctrl chord survives; `stty raw` is what lets ^C through to cat rather than
    // signalling the process group.
    tui.write('\x01\x03')
    await tui.waitForText('^A^C')

    // Alt is the ESC prefix, and a modified arrow keeps its xterm form.
    tui.write('\x1ba\x1b[1;5C')
    await tui.waitForText('^[a^[[1;5C')
  })

  it('resolves a lone escape into the Escape key after the idle window', async () => {
    const tui = await byteEcho()
    // Nothing follows it, so after the framer's idle timeout it is Escape and nothing else.
    tui.write('\x1b')
    await tui.waitForText('^[')
    // And an escape that *is* followed by a sequence is not split into Escape plus text.
    tui.write('\x1b[A')
    await tui.waitForText('^[^[[A')
  })

  it('carries a byte that is not valid UTF-8', async () => {
    const tui = await byteEcho()
    // The trailing 'x' is load-bearing. 0xE9 is a valid *lead* byte for a three-byte
    // character, so on its own it is an incomplete character rather than a stray byte, and
    // the framer holds it — as herdr does, and for the same reason: flushing it on idle
    // would split a slowly-arriving `é` into garbage. The next byte disambiguates it.
    tui.writeBytes(Buffer.from([0xe8, 0xe9, 0x78]))
    const screen = await tui.waitForText('M-h')
    expect(screen).toContain('M-ix')
    expect(screen).not.toContain('M-oM-?M-=')
  })

  it('holds a trailing high byte until the next byte disambiguates it', async () => {
    // The flip side, stated rather than hidden: a lead byte with nothing after it is not
    // delivered, because it could still become a character. It is bounded — one character
    // at most — and it resolves the moment anything else is typed.
    const tui = await byteEcho()
    tui.writeBytes(Buffer.from([0xe9]))
    tui.write('a')
    await tui.waitForText('a')
    // Once resolved, the byte arrives as itself and not as U+FFFD.
    const screen = await tui.waitForText('M-ia')
    expect(screen).not.toContain('M-oM-?M-=')
  })

  it('does not send the prefix key itself to the pane', async () => {
    const tui = await byteEcho()
    tui.write('a')
    await tui.waitForText('a')
    // Ctrl-B arms the prefix; it must not reach the pane.
    tui.write('\x02')
    await tui.waitForScreen((s) => s.includes('PREFIX'), 'the prefix was never armed')
    // Doubled, it does.
    tui.write('\x02\x02')
    await tui.waitForText('^B')
  })
})

describe('paste (PHASE-3 criterion 6)', () => {
  it('delivers a large paste as one write, not N keystrokes', async () => {
    const tui = await byteEcho(200, 40)

    // 1 MiB of a repeating marker, bracketed the way a terminal brackets a paste.
    const block = 'abcdefgh'.repeat(128 * 1024)
    expect(block.length).toBe(1024 * 1024)
    tui.write(`\x1b[200~${block}\x1b[201~`)

    // cat echoes it back; the screen only holds the tail, so the check is that the tail
    // arrived and nothing framed the brackets as keys.
    await tui.waitForScreen(
      (s) => s.includes('abcdefgh') && !s.includes('^[[200~') && !s.includes('^[[201~'),
      'the paste never arrived, or its brackets were treated as input',
      30_000
    )
  }, 60_000)

  it('does not bracket a paste for a pane that never asked for it', async () => {
    const tui = await byteEcho()
    tui.write('\x1b[200~plain\x1b[201~')
    const screen = await tui.waitForText('plain')
    // `cat` never enabled mode 2004, so it must not receive `CSI 200 ~`.
    expect(screen).not.toContain('^[[200~')
  })

  it('carries a paste containing bytes a UTF-8 decode would destroy', async () => {
    const tui = await byteEcho()
    tui.writeBytes(Buffer.concat([
      Buffer.from('\x1b[200~', 'latin1'),
      Buffer.from([0x78, 0xe8, 0x79]),
      Buffer.from('\x1b[201~', 'latin1')
    ]))
    const screen = await tui.waitForText('xM-hy')
    expect(screen).not.toContain('M-oM-?M-=')
  })
})

describe('mouse (PHASE-3 criterion 5)', () => {
  it('clicking a pane focuses it', async () => {
    harness = await TuiHarness.start({
      cols: 120,
      rows: 30,
      command: '/bin/bash',
      args: ['--norc', '--noprofile'],
      config: PLAIN_UI_CONFIG
    })
    await harness.waitForReady()
    harness.command('%')
    await harness.waitForText('2 panes')

    // Focus starts on the new right-hand pane. A click in the left half moves it back;
    // the focused pane is the one with the cyan border, so the check is on which half the
    // cursor is in — that is what the client actually moved.
    //
    // Polled, not read once: `2 panes` appears in the status bar as soon as the model
    // says so, which is before the render that moves the cursor into the new pane has
    // necessarily landed. Reading once made this test fail about one run in three on a
    // loaded machine.
    const split = harness
    await waitUntil(
      async () => (await split.cursor()).x > 60,
      () => 'focus never reached the new right-hand pane'
    )

    // SGR mouse press at column 10, row 5 (the wire is one-based).
    harness.write('\x1b[<0;11;6M\x1b[<0;11;6m')
    const tui = harness
    await waitUntil(
      async () => (await tui.cursor()).x < 60,
      () => 'clicking the left pane never moved focus to it'
    )
  })

  it('does not forward reports to a pane that never asked for them', async () => {
    const tui = await byteEcho()
    tui.write('\x1b[<0;5;3M\x1b[<0;5;3m')
    tui.write('after')
    const screen = await tui.waitForText('after')
    // `cat` enabled no mouse mode, so the report is swallowed rather than typed at it.
    expect(screen).not.toContain('^[[<0;')
  })

  it('translates coordinates into the pane, for a program that did ask', async () => {
    // A pane that turns on 1002 + 1006 gets reports in its own coordinate space: the
    // client subtracts the pane's origin before re-encoding.
    harness = await TuiHarness.start({
      cols: 120,
      rows: 30,
      command: '/bin/sh',
      args: ['-c', 'stty raw -echo; printf "\\033[?1002h\\033[?1006hREADY"; exec cat -v'],
      env: { LC_ALL: 'C', LANG: 'C' },
      config: PLAIN_UI_CONFIG
    })
    await harness.waitForReady()
    await harness.waitForText('READY')

    // Screen column 11, row 6 (one-based on the wire) is column 10, row 5 zero-based.
    // The pane's content starts at (1, 1) because of its border, so the pane sees (9, 4)
    // zero-based, which goes back on the wire as 10 and 5.
    harness.write('\x1b[<0;11;6M')
    const screen = await harness.waitForText('^[[<0;10;5M')
    expect(screen).toContain('^[[<0;10;5M')
  })
})

describe('the shell still works', () => {
  it('runs a command typed the ordinary way', async () => {
    // The boring case, which is the one that would break first if framing were wrong.
    harness = await TuiHarness.start({
      command: '/bin/bash',
      args: ['--norc', '--noprofile'],
      config: PLAIN_UI_CONFIG
    })
    await harness.waitForReady()
    harness.write(markerCommand('input-still-works'))
    await harness.waitForText('input-still-works')
  })
})
