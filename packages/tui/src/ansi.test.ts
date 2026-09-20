import { describe, expect, it } from 'vitest'
import { ScreenBuffer } from './buffer.js'
import { ATTR_BOLD, ATTR_DIM, ATTR_ITALIC, COLOR_DEFAULT, rgbColor, style, type Style } from './cell.js'
import { BEGIN_SYNC, END_SYNC, HIDE_CURSOR, SHOW_CURSOR, cursorTo, encodeFrame, sgrSequence } from './ansi.js'
import { diffBuffers, fullSpans } from './diff.js'

const plain: Style = { fg: COLOR_DEFAULT, bg: COLOR_DEFAULT, attrs: 0 }

describe('sgrSequence', () => {
  it('states everything when the previous state is unknown', () => {
    expect(sgrSequence(null, plain)).toBe('\x1b[0m')
    expect(sgrSequence(null, style({ fg: 2, attrs: ATTR_BOLD }))).toBe('\x1b[0;1;32m')
  })

  it('emits nothing for an unchanged style', () => {
    expect(sgrSequence(plain, plain)).toBe('')
    const s = style({ fg: 100, bg: 7, attrs: ATTR_ITALIC })
    expect(sgrSequence(s, { ...s })).toBe('')
  })

  it('adds attributes incrementally', () => {
    expect(sgrSequence(plain, style({ attrs: ATTR_BOLD }))).toBe('\x1b[1m')
    expect(sgrSequence(style({ attrs: ATTR_BOLD }), style({ attrs: ATTR_BOLD | ATTR_ITALIC }))).toBe('\x1b[3m')
  })

  it('resets and re-states when an attribute has to go away', () => {
    // SGR 22 clears bold and dim together, so there is no incremental way to drop one.
    const from = style({ attrs: ATTR_BOLD | ATTR_DIM, fg: 4 })
    expect(sgrSequence(from, style({ attrs: ATTR_DIM, fg: 4 }))).toBe('\x1b[0;2;34m')
  })

  it('encodes each color space the way terminals expect', () => {
    expect(sgrSequence(plain, style({ fg: 3 }))).toBe('\x1b[33m')
    expect(sgrSequence(plain, style({ fg: 11 }))).toBe('\x1b[93m')
    expect(sgrSequence(plain, style({ fg: 200 }))).toBe('\x1b[38;5;200m')
    expect(sgrSequence(plain, style({ bg: 3 }))).toBe('\x1b[43m')
    expect(sgrSequence(plain, style({ bg: 11 }))).toBe('\x1b[103m')
    expect(sgrSequence(plain, style({ bg: 200 }))).toBe('\x1b[48;5;200m')
    expect(sgrSequence(plain, style({ fg: rgbColor(0x102030) }))).toBe('\x1b[38;2;16;32;48m')
    expect(sgrSequence(plain, style({ bg: rgbColor(0xffffff) }))).toBe('\x1b[48;2;255;255;255m')
  })

  it('returns to the default color explicitly', () => {
    expect(sgrSequence(style({ fg: 3 }), plain)).toBe('\x1b[39m')
    expect(sgrSequence(style({ bg: 3 }), plain)).toBe('\x1b[49m')
  })
})

describe('encodeFrame', () => {
  it('brackets the frame by hiding and restoring the cursor', () => {
    const buffer = new ScreenBuffer(4, 1)
    const payload = encodeFrame(buffer, [])
    expect(payload.startsWith(HIDE_CURSOR)).toBe(true)
    expect(payload.endsWith(SHOW_CURSOR)).toBe(true)
  })

  it('emits DEC 2026 only when told to', () => {
    const buffer = new ScreenBuffer(4, 1)
    expect(encodeFrame(buffer, [])).not.toContain('2026')
    const synced = encodeFrame(buffer, [], { synchronizedOutput: true })
    expect(synced.startsWith(BEGIN_SYNC)).toBe(true)
    expect(synced.endsWith(END_SYNC)).toBe(true)
  })

  it('writes the characters of a span', () => {
    const buffer = new ScreenBuffer(10, 2)
    buffer.writeString(2, 1, 'hey', style())
    const payload = encodeFrame(buffer, [{ y: 1, x: 2, end: 5 }], { manageCursorVisibility: false })
    expect(payload).toBe(`${cursorTo(2, 1)}\x1b[0mhey`)
  })

  it('reuses the cursor position across adjacent spans on one row', () => {
    const buffer = new ScreenBuffer(40, 1)
    buffer.writeString(0, 0, 'ab', style())
    buffer.writeString(4, 0, 'cd', style())
    const payload = encodeFrame(buffer, [
      { y: 0, x: 0, end: 2 },
      { y: 0, x: 4, end: 6 }
    ], { manageCursorVisibility: false })
    // A short forward hop is CUF, not a full CUP.
    expect(payload).toContain('\x1b[2C')
    expect(payload.match(/\x1b\[\d+;\d+H/gu)).toHaveLength(1)
  })

  it('does not assume where the cursor lands after the last column', () => {
    const buffer = new ScreenBuffer(4, 2)
    buffer.writeString(0, 0, 'abcd', style())
    buffer.writeString(0, 1, 'efgh', style())
    const payload = encodeFrame(buffer, fullSpans(buffer), { manageCursorVisibility: false })
    // Each row is re-addressed absolutely rather than relying on DECAWM.
    expect(payload.match(/\x1b\[\d+;\d+H/gu)).toHaveLength(2)
  })

  it('emits a wide character once and skips its continuation cell', () => {
    const buffer = new ScreenBuffer(6, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    buffer.setCell(2, 0, 'x', 1, -1, -1, 0)
    const payload = encodeFrame(buffer, [{ y: 0, x: 0, end: 3 }], { manageCursorVisibility: false })
    expect(payload).toContain('漢x')
    expect(payload.match(/漢/gu)).toHaveLength(1)
  })

  it('backs a hand-built span off a continuation cell', () => {
    const buffer = new ScreenBuffer(6, 1)
    buffer.setCell(0, 0, '漢', 2, -1, -1, 0)
    const payload = encodeFrame(buffer, [{ y: 0, x: 1, end: 2 }], { manageCursorVisibility: false })
    expect(payload).toContain(cursorTo(0, 0))
    expect(payload).toContain('漢')
  })

  it('places the cursor where asked, and shows it only when visible', () => {
    const buffer = new ScreenBuffer(10, 4)
    const shown = encodeFrame(buffer, [], { cursor: { x: 3, y: 2, visible: true } })
    expect(shown).toContain(cursorTo(3, 2))
    expect(shown.endsWith(SHOW_CURSOR)).toBe(true)

    const hidden = encodeFrame(buffer, [], { cursor: { x: 3, y: 2, visible: false } })
    expect(hidden).toContain(cursorTo(3, 2))
    expect(hidden.endsWith(SHOW_CURSOR)).toBe(false)
  })

  it('carries style state across spans instead of re-stating it', () => {
    const buffer = new ScreenBuffer(4, 2)
    const s = style({ fg: 5, attrs: ATTR_BOLD })
    buffer.writeString(0, 0, 'aaaa', s)
    buffer.writeString(0, 1, 'bbbb', s)
    const payload = encodeFrame(buffer, fullSpans(buffer), { manageCursorVisibility: false })
    // One SGR for the whole frame: the second row inherits the first row's state.
    expect(payload.match(/\x1b\[[\d;]*m/gu)).toHaveLength(1)
  })

  it('switches style mid-row without re-addressing the cursor', () => {
    const buffer = new ScreenBuffer(8, 1)
    buffer.writeString(0, 0, 'aaaa', style({ fg: 5 }))
    buffer.writeString(4, 0, 'bbbb', style({ fg: 6 }))
    const payload = encodeFrame(buffer, fullSpans(buffer), { manageCursorVisibility: false })
    expect(payload.match(/\x1b\[\d+;\d+H/gu)).toHaveLength(1)
    expect(payload).toBe(`${cursorTo(0, 0)}\x1b[0;35maaaa\x1b[36mbbbb`)
  })

  it('ignores spans outside the buffer', () => {
    const buffer = new ScreenBuffer(4, 1)
    const payload = encodeFrame(buffer, [
      { y: 9, x: 0, end: 4 },
      { y: 0, x: 4, end: 8 }
    ], { manageCursorVisibility: false })
    expect(payload).toBe('')
  })
})

describe('round trip', () => {
  it('a diff applied to the previous frame reproduces the next frame', () => {
    // Replay the encoder's own output against a model terminal: the strongest statement
    // available without a real emulator, and enough to catch a cursor-tracking error.
    const prev = new ScreenBuffer(20, 4)
    const next = new ScreenBuffer(20, 4)
    prev.writeString(0, 0, 'hello world', style())
    prev.writeString(0, 2, 'second line', style())
    next.copyFrom(prev)
    next.writeString(6, 0, 'WORLD', style({ fg: 2 }))
    next.writeString(0, 3, 'new row', style())

    const payload = encodeFrame(next, diffBuffers(prev, next), { manageCursorVisibility: false })
    const applied = applyToModel(prev, payload)
    expect(applied.toText()).toBe(next.toText())
  })
})

/** A deliberately dumb terminal: CUP, CUF, and printable text. Enough to replay a diff. */
function applyToModel(base: ScreenBuffer, payload: string): ScreenBuffer {
  const screen = new ScreenBuffer(base.cols, base.rows)
  screen.copyFrom(base)
  let x = 0
  let y = 0
  let i = 0
  while (i < payload.length) {
    const char = payload[i] as string
    if (char === '\x1b') {
      const match = /^\x1b\[(\d*)(?:;(\d*))?([A-Za-z])/u.exec(payload.slice(i))
      if (!match) {
        i++
        continue
      }
      const [whole, first = '', second = '', final] = match
      if (final === 'H') {
        y = (first === '' ? 1 : Number.parseInt(first, 10)) - 1
        x = (second === '' ? 1 : Number.parseInt(second, 10)) - 1
      } else if (final === 'C') {
        x += first === '' ? 1 : Number.parseInt(first, 10)
      }
      i += whole.length
      continue
    }
    screen.setCell(x, y, char, 1, -1, -1, 0)
    x += 1
    i++
  }
  return screen
}
