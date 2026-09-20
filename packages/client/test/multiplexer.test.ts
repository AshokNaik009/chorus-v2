/**
 * The multiplexer, end to end: a real client process in a real PTY, rendering real panes.
 *
 * PHASE-2 acceptance criteria 2 (a working multiplexer), 3 (vim), 4 (resize), and the
 * output half of 9 (DEC 2026 is never emitted to a terminal that did not advertise it).
 */

import { afterEach, describe, expect, it } from 'vitest'
import { PLAIN_UI_CONFIG, TuiHarness, markerCommand, waitUntil } from './harness.js'

let harness: TuiHarness | null = null

afterEach(async () => {
  await harness?.stop()
  harness = null
})

async function startShell(
  options: { cols?: number; rows?: number; answerDecrqm?: number; config?: string } = {}
): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    command: '/bin/bash',
    // No rc files: the prompt and aliases of whoever runs the suite must not reach it.
    args: ['--norc', '--noprofile'],
    // These assert on which column a border is in, so the panes own the whole screen.
    // The default layout, sidebar and tab bar included, is chrome.test.ts's subject.
    config: PLAIN_UI_CONFIG,
    ...options
  })
  await harness.waitForReady()
  return harness
}

describe('a single pane', () => {
  it('draws a bordered pane and a status bar', async () => {
    const tui = await startShell()
    const screen = await tui.screen()
    const lines = screen.split('\n')
    expect(lines[0]?.startsWith('┌')).toBe(true)
    expect(lines[0]?.endsWith('┐')).toBe(true)
    // The status bar owns the last row; the pane's bottom border is the row above it.
    expect(lines[tui.size.rows - 2]?.startsWith('└')).toBe(true)
    expect(lines[tui.size.rows - 1]).toContain('1 pane')
  })

  it('runs a shell whose output reaches the screen', async () => {
    const tui = await startShell()
    tui.write(markerCommand('alpha-one'))
    const screen = await tui.waitForText('alpha-one')
    // Inside the pane, not spilling over its border.
    const row = screen.split('\n').find((l) => l.includes('alpha-one')) ?? ''
    expect(row.startsWith('│')).toBe(true)
  })

  it('uses the alternate screen and restores the terminal on quit', async () => {
    const tui = await startShell()
    expect(await tui.bufferKind()).toBe('alternate')
    tui.command('q')
    await tui.waitForScreen(() => tui.hasExited, 'the client never exited after prefix-q')
    expect(tui.lastExitCode).toBe(0)
    expect(tui.raw).toContain('\x1b[?1049l')

    // Every mode it turned on, it turns off again. A terminal left reporting mouse events
    // makes every subsequent click look like garbage typed at whatever shell the user
    // lands back in, and that outlives this process.
    expect(tui.raw).toContain('\x1b[?1002h')
    expect(tui.raw).toContain('\x1b[?1006h')
    expect(tui.raw).toContain('\x1b[?2004h')
    expect(tui.raw).toContain('\x1b[?1002l')
    expect(tui.raw).toContain('\x1b[?1006l')
    expect(tui.raw).toContain('\x1b[?2004l')
  })
})

describe('splitting', () => {
  it('splits left/right, and both panes render their own output', async () => {
    const tui = await startShell()
    tui.write(markerCommand('left-pane'))
    await tui.waitForText('left-pane')

    tui.command('%')
    await tui.waitForText('2 panes')

    tui.write(markerCommand('right-pane'))
    await tui.waitForText('right-pane')

    const screen = await tui.waitForScreen(
      (s) => s.includes('left-pane') && s.includes('right-pane'),
      'both panes never showed their own output at the same time'
    )
    // A vertical divider: the two panes' borders meet somewhere in the middle of a row.
    const middle = screen.split('\n')[Math.floor(tui.size.rows / 2)] ?? ''
    expect((middle.match(/│/gu) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('splits top/bottom', async () => {
    const tui = await startShell()
    tui.command('"')
    await tui.waitForText('2 panes')
    const screen = await tui.screen()
    const lines = screen.split('\n')
    // A horizontal divider inside the screen: a row of box-drawing between the two panes.
    const dividers = lines.filter((l, i) => i > 0 && i < tui.size.rows - 2 && /^[├└┌│].*[─]{10}/u.test(l))
    expect(dividers.length).toBeGreaterThanOrEqual(2)
  })

  it('moves focus between panes and types into the focused one', async () => {
    const tui = await startShell()
    tui.command('%')
    await tui.waitForText('2 panes')
    tui.write(markerCommand('in-right'))
    await tui.waitForText('in-right')

    tui.command('h')
    tui.write(markerCommand('in-left'))
    const screen = await tui.waitForText('in-left')

    // Each marker landed in a different pane: they cannot be on the same side.
    const leftRow = screen.split('\n').find((l) => l.includes('in-left')) ?? ''
    const rightRow = screen.split('\n').find((l) => l.includes('in-right')) ?? ''
    expect(leftRow.indexOf('in-left')).toBeLessThan(rightRow.indexOf('in-right'))
  })

  it('zoom hides the other panes and unzoom brings them back', async () => {
    const tui = await startShell()
    tui.write(markerCommand('background-pane'))
    await tui.waitForText('background-pane')
    tui.command('%')
    await tui.waitForText('2 panes')

    tui.command('z')
    await tui.waitForScreen((s) => s.includes('[zoom]'), 'zoom never engaged')
    expect(await tui.screen()).not.toContain('background-pane')

    tui.command('z')
    await tui.waitForText('background-pane')
  })

  it('killing a pane collapses the layout back', async () => {
    const tui = await startShell()
    tui.command('%')
    await tui.waitForText('2 panes')
    tui.command('x')
    await tui.waitForText('1 pane')
    const screen = await tui.screen()
    const middle = screen.split('\n')[Math.floor(tui.size.rows / 2)] ?? ''
    expect((middle.match(/│/gu) ?? []).length).toBe(2)
  })

  it('the last pane exiting ends the client', async () => {
    const tui = await startShell()
    tui.write('exit\r')
    await tui.waitForScreen(() => tui.hasExited, 'the client outlived its last pane')
    expect(tui.lastExitCode).toBe(0)
  })
})

describe('raw input bytes', () => {
  // The defect this phase opened with, end to end. Measured before the fix:
  //   typed    1b 5b 4d 20 e8 28
  //   arrived  1b 5b 4d 20 ef bf bd 28
  // The client's stdin had setEncoding('utf8') on it, so a StringDecoder replaced every
  // byte that was not valid UTF-8 with U+FFFD before anything could parse it.
  it('passes a byte that is not valid UTF-8 through to the pane unchanged', async () => {
    // `cat -v` escapes a high byte only outside a UTF-8 locale, and echo off keeps the
    // tty's raw echo off the screen, so what is asserted is what the child received.
    harness = await TuiHarness.start({
      command: '/bin/sh',
      args: ['-c', 'stty -echo; exec cat -v'],
      env: { LC_ALL: 'C', LANG: 'C' }
    })
    await harness.waitForReady()

    // Two Latin-1 bytes, typed. Neither is valid UTF-8 on its own, and neither has any
    // key meaning, so both must reach the pane as themselves rather than as U+FFFD.
    //
    // Note what is *not* sent here any more: a legacy X10 mouse report. Phase 3 decodes
    // those, so the client consumes `ESC [ M …` as a mouse event rather than forwarding
    // it — which is the point of the phase, and is covered in input.test.ts.
    harness.writeBytes(Buffer.from([0xe8, 0xe9, 0x0a]))

    // 0xE8 prints as `M-h`, 0xE9 as `M-i`. U+FFFD would print `M-oM-?M-=`.
    const screen = await harness.waitForText('M-h')
    expect(screen).toContain('M-hM-i')
    expect(screen).not.toContain('M-oM-?M-=')
  })

  it('still delivers ordinary UTF-8 text', async () => {
    harness = await TuiHarness.start({ command: '/bin/cat' })
    await harness.waitForReady()
    harness.write('héllo 世界\r')
    const screen = await harness.waitForText('héllo 世界')
    expect(screen).not.toContain('�')
  })
})

describe('vim', () => {
  // Criterion 3. `-u NONE -N` keeps the user's vimrc out of the assertions.
  it('renders, takes input, and leaves the pane usable afterwards', async () => {
    const tui = await startShell()
    tui.write('vim -u NONE -N\r')
    // vim's empty buffer marks unused rows with `~` down the left edge.
    await tui.waitForScreen((s) => (s.match(/^│~/gmu) ?? []).length > 5, 'vim never drew its empty buffer')

    tui.write('ihello from vim\x1b')
    const screen = await tui.waitForText('hello from vim')

    // The text is on vim's first row, which is the pane's first content row.
    const rowIndex = screen.split('\n').findIndex((l) => l.includes('hello from vim'))
    expect(rowIndex).toBe(1)

    // And once Escape lands, the cursor sits on the last inserted character.
    //
    // "once it lands" is new in phase 3 and is not a flake: a lone ESC is ambiguous until
    // either more bytes arrive or the idle window expires, so Escape is now delivered a
    // few milliseconds after it is typed. Sampling the cursor the instant the text appears
    // catches vim still in insert mode, one column further right.
    await waitUntil(
      async () => {
        const cursor = await tui.cursor()
        return cursor.y === 1 && cursor.x === 'hello from vim'.length
      },
      () => 'vim never left insert mode, so Escape never reached it'
    )

    tui.write(':q!\r')
    await tui.waitForScreen((s) => !s.includes('hello from vim'), 'vim never left the alternate screen')

    // The pane still works once vim is gone.
    tui.write(markerCommand('after-vim'))
    await tui.waitForText('after-vim')
  })
})

describe('resize', () => {
  // Criterion 4.
  it('reflows panes on SIGWINCH without corruption', async () => {
    const tui = await startShell({ cols: 100, rows: 30 })
    tui.command('%')
    await tui.waitForText('2 panes')
    tui.write(markerCommand('survives-resize'))
    await tui.waitForText('survives-resize')

    tui.resize(140, 40)
    await tui.waitForScreen(
      (s) => (s.split('\n')[0] ?? '').length === 140,
      'the top border never widened to the new terminal width'
    )

    const screen = await tui.waitForScreen(
      (s) => s.includes('survives-resize') && s.split('\n')[39] !== undefined,
      'content did not survive the resize'
    )
    const lines = screen.split('\n')
    expect(lines).toHaveLength(40)
    // Borders are intact at the new size: corners where corners belong, status bar last.
    const top = lines[0] ?? ''
    const bottom = lines[38] ?? ''
    expect(top.startsWith('┌')).toBe(true)
    expect(top.endsWith('┐')).toBe(true)
    expect(bottom.startsWith('└')).toBe(true)
    expect(bottom.endsWith('┘')).toBe(true)
    expect(lines[39]).toContain('2 panes')

    // Two panes side by side means exactly two of each corner, and the divider sits at
    // the new midpoint (140 / 2 = 70, so the left pane's corner is column 69) rather
    // than where the old 100-column layout put it.
    expect((top.match(/┌/gu) ?? []).length).toBe(2)
    expect((top.match(/┐/gu) ?? []).length).toBe(2)
    expect(top.indexOf('┐')).toBe(69)
    expect(top.lastIndexOf('┐')).toBe(139)
    // Every row is exactly the new width; a partial repaint would leave a short one.
    expect(new Set(lines.map((l) => l.length)).has(140)).toBe(true)
    for (const row of lines.slice(0, 39)) expect(row.length).toBe(140)

    // Shrinking works too, and the shell inside learns its new size.
    tui.resize(80, 24)
    await tui.waitForScreen(
      (s) => s.split('\n').length === 24 && (s.split('\n')[0] ?? '').length === 80,
      'the layout never shrank to the smaller terminal'
    )
  })

  it('tells the shell in the pane about its new size', async () => {
    const tui = await startShell({ cols: 100, rows: 30 })
    tui.write(markerCommand('ready'))
    await tui.waitForText('ready')

    tui.resize(120, 34)
    await tui.waitForScreen((s) => (s.split('\n')[0] ?? '').length === 120, 'the TUI never widened')

    // The pane is the terminal minus its border and the status bar.
    tui.write('echo "cols=$(tput cols) rows=$(tput lines)"\r')
    await tui.waitForText('cols=118 rows=31')
  })
})

describe('synchronized output', () => {
  // Criterion 9, the output half: the parser half is in tui/src/screen.test.ts.
  it('emits no DEC 2026 bytes to a terminal that never answered the probe', async () => {
    const tui = await startShell()
    tui.write(markerCommand('several-frames'))
    await tui.waitForText('several-frames')
    tui.command('%')
    await tui.waitForText('2 panes')

    // The query itself is expected; the mode brackets are not.
    expect(tui.raw).toContain('\x1b[?2026$p')
    expect(tui.raw).not.toContain('\x1b[?2026h')
    expect(tui.raw).not.toContain('\x1b[?2026l')
  })

  it('brackets every frame when the terminal reports the mode', async () => {
    const tui = await startShell({ answerDecrqm: 2 })
    tui.write(markerCommand('synced-frames'))
    await tui.waitForText('synced-frames')
    expect(tui.raw).toContain('\x1b[?2026h')
    expect(tui.raw).toContain('\x1b[?2026l')
  })
})
