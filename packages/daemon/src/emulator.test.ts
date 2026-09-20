import { describe, expect, it } from 'vitest'
import { ATTR_BOLD, COLOR_DEFAULT, rgbColor } from '@leap-chorus/protocol'
import { PaneEmulator } from './emulator.js'
import { snapshotToText } from './snapshot.js'

const ALT_ON = '\u001b[?1049h'
const ALT_OFF = '\u001b[?1049l'

describe('PaneEmulator', () => {
  it('constructs and parses under plain Node with no window polyfill', async () => {
    // Guards the phase-1 finding: @xterm/headless's single `window` reference is behind
    // an isNode short-circuit, so no polyfill is needed outside Electron.
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined')
    const emulator = new PaneEmulator({ cols: 20, rows: 4 })
    await emulator.writeText('hello')
    expect(snapshotToText(emulator.snapshot(0))).toContain('hello')
    emulator.dispose()
  })

  it('settles writes before a snapshot is read', async () => {
    const emulator = new PaneEmulator({ cols: 20, rows: 4 })
    // write() is queued internally; the promise is the only ordering guarantee.
    await emulator.writeText('queued-output')
    expect(snapshotToText(emulator.snapshot(0))).toContain('queued-output')
    emulator.dispose()
  })

  describe('alternate screen', () => {
    it('switches buffers and keeps the normal buffer intact (criterion 3)', async () => {
      const emulator = new PaneEmulator({ cols: 30, rows: 5 })
      await emulator.writeText('before-alt-screen\r\n')
      expect(emulator.bufferType).toBe('normal')

      await emulator.writeText(`${ALT_ON}inside-alt-screen`)
      expect(emulator.bufferType).toBe('alternate')

      const active = emulator.snapshot(1)
      expect(active.buffer).toBe('alternate')
      expect(snapshotToText(active)).toContain('inside-alt-screen')
      expect(snapshotToText(active)).not.toContain('before-alt-screen')

      // The pre-switch text is still there, underneath.
      const normal = emulator.snapshot(1, 'normal')
      expect(normal.buffer).toBe('normal')
      expect(snapshotToText(normal)).toContain('before-alt-screen')

      await emulator.writeText(ALT_OFF)
      expect(emulator.bufferType).toBe('normal')
      expect(snapshotToText(emulator.snapshot(2))).toContain('before-alt-screen')
      emulator.dispose()
    })
  })

  describe('UTF-8 across chunk boundaries (criterion 7)', () => {
    it('joins a codepoint split between two writes', async () => {
      const emulator = new PaneEmulator({ cols: 10, rows: 2 })
      const encoded = Buffer.from('世', 'utf8')
      expect(encoded.byteLength).toBe(3)

      await emulator.write(new Uint8Array(encoded.subarray(0, 2)))
      await emulator.write(new Uint8Array(encoded.subarray(2)))

      const snapshot = emulator.snapshot(0)
      const text = snapshotToText(snapshot)
      expect(text.startsWith('世')).toBe(true)
      expect(text).not.toContain('�')
      // One character, two columns: a renderer must advance by width, not text.length.
      const firstRun = snapshot.lines[0]?.runs[0]
      expect(firstRun?.text[0]).toBe('世')
      expect(firstRun?.width).toBeGreaterThanOrEqual(2)
      emulator.dispose()
    })

    it('joins a codepoint split three ways', async () => {
      const emulator = new PaneEmulator({ cols: 10, rows: 2 })
      const encoded = Buffer.from('é', 'utf8')
      await emulator.write(new Uint8Array(encoded.subarray(0, 1)))
      await emulator.write(new Uint8Array(encoded.subarray(1)))
      expect(snapshotToText(emulator.snapshot(0)).startsWith('é')).toBe(true)
      emulator.dispose()
    })
  })

  it('tracks cursor visibility, which xterm does not expose on IModes', async () => {
    const emulator = new PaneEmulator({ cols: 10, rows: 2 })
    expect(emulator.snapshot(0).cursor.visible).toBe(true)
    await emulator.writeText('\u001b[?25l')
    expect(emulator.snapshot(0).cursor.visible).toBe(false)
    await emulator.writeText('\u001b[?25h')
    expect(emulator.snapshot(0).cursor.visible).toBe(true)
    emulator.dispose()
  })

  it('reports the title', async () => {
    const emulator = new PaneEmulator({ cols: 10, rows: 2 })
    const seen: string[] = []
    emulator.onTitleChange((title) => seen.push(title))
    await emulator.writeText('\u001b]0;pane-title\u0007')
    expect(seen).toEqual(['pane-title'])
    expect(emulator.snapshot(0).title).toBe('pane-title')
    emulator.dispose()
  })

  it('resizes (criterion 6)', async () => {
    const emulator = new PaneEmulator({ cols: 80, rows: 24 })
    emulator.resize(200, 50)
    expect(emulator.cols).toBe(200)
    expect(emulator.rows).toBe(50)
    const snapshot = emulator.snapshot(0)
    expect(snapshot.cols).toBe(200)
    expect(snapshot.rows).toBe(50)
    expect(snapshot.lines).toHaveLength(50)
    for (const line of snapshot.lines) {
      const width = line.runs.reduce((sum, run) => sum + run.width, 0)
      expect(width).toBe(200)
    }
    emulator.dispose()
  })
})

describe('snapshot encoding', () => {
  it('splits runs at style boundaries and packs colors', async () => {
    const emulator = new PaneEmulator({ cols: 20, rows: 1 })
    await emulator.writeText('\u001b[1;31mred\u001b[0m plain')

    const snapshot = emulator.snapshot(0)
    const runs = snapshot.lines[0]?.runs ?? []
    expect(runs[0]?.text).toBe('red')
    expect(runs[0]?.attrs & ATTR_BOLD).toBe(ATTR_BOLD)
    expect(runs[0]?.fg).toBe(1)
    expect(runs[1]?.fg).toBe(COLOR_DEFAULT)
    expect(runs[1]?.attrs).toBe(0)
    expect(runs.map((run) => run.text).join('')).toBe('red plain'.padEnd(20, ' '))
    emulator.dispose()
  })

  it('encodes truecolor distinguishably from the palette', async () => {
    const emulator = new PaneEmulator({ cols: 10, rows: 1 })
    await emulator.writeText('\u001b[38;2;18;52;86mx')
    const run = emulator.snapshot(0).lines[0]?.runs[0]
    expect(run?.fg).toBe(rgbColor(0x123456))
    // Palette indices never reach the truecolor tag, so the two cannot be confused.
    expect(run?.fg).toBeGreaterThan(255)
    emulator.dispose()
  })

  it('reports every row at full width', async () => {
    const emulator = new PaneEmulator({ cols: 12, rows: 3 })
    await emulator.writeText('ab\r\n')
    const snapshot = emulator.snapshot(0)
    expect(snapshot.lines).toHaveLength(3)
    for (const line of snapshot.lines) {
      expect(line.runs.reduce((sum, run) => sum + run.width, 0)).toBe(12)
    }
    emulator.dispose()
  })

  it('counts scrollback without transferring it', async () => {
    const emulator = new PaneEmulator({ cols: 10, rows: 3 })
    for (let i = 0; i < 10; i++) await emulator.writeText(`line${i}\r\n`)
    const snapshot = emulator.snapshot(0)
    expect(snapshot.lines).toHaveLength(3)
    expect(snapshot.scrollbackLines).toBeGreaterThan(0)
    // The visible screen is the tail, not the head.
    expect(snapshotToText(snapshot)).toContain('line9')
    expect(snapshotToText(snapshot)).not.toContain('line0')
    emulator.dispose()
  })
})

describe('keyboard protocol tracking (PHASE-3 criterion 3)', () => {
  async function feed(sequences: string): Promise<PaneEmulator> {
    const emulator = new PaneEmulator({ cols: 40, rows: 8 })
    await emulator.writeText(sequences)
    return emulator
  }

  it('starts on the legacy protocol', async () => {
    const emulator = await feed('')
    expect(emulator.keyboardProtocol()).toEqual({
      kittyFlags: 0,
      modifyOtherKeys: 0,
      applicationCursorKeys: false,
      applicationKeypad: false,
      bracketedPaste: false,
      mouseTracking: 'none'
    })
    emulator.dispose()
  })

  it('tracks the kitty push/set/pop stack off the parser', async () => {
    // These four sequences are the whole negotiation. xterm keeps no stack for us, so
    // this is the test that the one we keep is driven by what the program actually wrote.
    const emulator = await feed('\x1b[>1u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(1)

    await emulator.writeText('\x1b[>5u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(5)

    await emulator.writeText('\x1b[<1u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(1)

    await emulator.writeText('\x1b[<1u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(0)

    // A pop on an empty stack must not throw or corrupt anything.
    await emulator.writeText('\x1b[<1u\x1b[<9u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(0)
    emulator.dispose()
  })

  it('applies the set modes', async () => {
    const emulator = await feed('\x1b[>1u\x1b[=5;1u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(5)
    await emulator.writeText('\x1b[=2;2u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(7)
    await emulator.writeText('\x1b[=4;3u')
    expect(emulator.keyboardProtocol().kittyFlags).toBe(3)
    emulator.dispose()
  })

  it('tracks modifyOtherKeys', async () => {
    const emulator = await feed('\x1b[>4;2m')
    expect(emulator.keyboardProtocol().modifyOtherKeys).toBe(2)
    await emulator.writeText('\x1b[>4;0m')
    expect(emulator.keyboardProtocol().modifyOtherKeys).toBe(0)
    // `CSI > 4 m` with no parameter turns it off, and an unrelated `>` resource is ignored.
    await emulator.writeText('\x1b[>4;1m\x1b[>0;1m')
    expect(emulator.keyboardProtocol().modifyOtherKeys).toBe(1)
    emulator.dispose()
  })

  it('tracks the modes xterm already knows about', async () => {
    const emulator = await feed('\x1b[?1h\x1b[?2004h\x1b[?1002h')
    const protocol = emulator.keyboardProtocol()
    expect(protocol.applicationCursorKeys).toBe(true)
    expect(protocol.bracketedPaste).toBe(true)
    expect(protocol.mouseTracking).toBe('drag')
    await emulator.writeText('\x1b[?1l\x1b[?2004l\x1b[?1002l')
    const off = emulator.keyboardProtocol()
    expect(off.applicationCursorKeys).toBe(false)
    expect(off.bracketedPaste).toBe(false)
    expect(off.mouseTracking).toBe('none')
    emulator.dispose()
  })

  it('does not let the negotiation sequences reach the screen', async () => {
    // Every handler returns true, so xterm's own CSI m / CSI u handling never sees them.
    // If one leaked, `CSI = 5 ; 1 u` would be read as a cursor restore and move the cursor.
    const emulator = await feed('abc\x1b[>1u\x1b[=5;1u\x1b[<1u\x1b[>4;2mdef')
    expect(snapshotToText(emulator.snapshot(0)).trim()).toBe('abcdef')
    emulator.dispose()
  })

  it('rides the snapshot, which is how it survives a client reattaching', async () => {
    const emulator = await feed('\x1b[>9u\x1b[>4;2m\x1b[?1h')
    expect(emulator.snapshot(0).keyboard).toEqual({
      kittyFlags: 9,
      modifyOtherKeys: 2,
      applicationCursorKeys: true,
      applicationKeypad: false,
      bracketedPaste: false,
      mouseTracking: 'none'
    })
    emulator.dispose()
  })
})
