import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DECRQM_NOT_RECOGNIZED,
  DECRQM_PERMANENTLY_RESET,
  DECRQM_PERMANENTLY_SET,
  DECRQM_RESET,
  DECRQM_SET,
  SYNC_OUTPUT_MODE,
  decrqmIndicatesSupport,
  decrqmQuery,
  parseDecrqmReply,
  Screen,
  probeMode,
  stripDecrqmReply
} from './screen.js'

describe('parseDecrqmReply', () => {
  it('reads the value out of a well-formed reply', () => {
    expect(parseDecrqmReply('\x1b[?2026;1$y', SYNC_OUTPUT_MODE)).toBe(DECRQM_SET)
    expect(parseDecrqmReply('\x1b[?2026;2$y', SYNC_OUTPUT_MODE)).toBe(DECRQM_RESET)
    expect(parseDecrqmReply('\x1b[?2026;0$y', SYNC_OUTPUT_MODE)).toBe(DECRQM_NOT_RECOGNIZED)
    expect(parseDecrqmReply('\x1b[?2026;4$y', SYNC_OUTPUT_MODE)).toBe(DECRQM_PERMANENTLY_RESET)
  })

  it('returns null when no reply is present', () => {
    expect(parseDecrqmReply('', SYNC_OUTPUT_MODE)).toBeNull()
    expect(parseDecrqmReply('some typing', SYNC_OUTPUT_MODE)).toBeNull()
    // A truncated reply is not a reply yet.
    expect(parseDecrqmReply('\x1b[?2026;1', SYNC_OUTPUT_MODE)).toBeNull()
  })

  it('ignores a reply for a different mode', () => {
    expect(parseDecrqmReply('\x1b[?1049;1$y', SYNC_OUTPUT_MODE)).toBeNull()
    // 2026 must not match as a prefix of a longer mode number either.
    expect(parseDecrqmReply('\x1b[?20261;1$y', SYNC_OUTPUT_MODE)).toBeNull()
  })

  it('finds the reply among unrelated input', () => {
    expect(parseDecrqmReply('abc\x1b[?2026;1$ydef', SYNC_OUTPUT_MODE)).toBe(DECRQM_SET)
  })
})

describe('decrqmIndicatesSupport', () => {
  it('treats set, reset and permanently-set as supported', () => {
    expect(decrqmIndicatesSupport(DECRQM_SET)).toBe(true)
    expect(decrqmIndicatesSupport(DECRQM_RESET)).toBe(true)
    expect(decrqmIndicatesSupport(DECRQM_PERMANENTLY_SET)).toBe(true)
  })

  it('treats not-recognized, permanently-reset and silence as unsupported', () => {
    expect(decrqmIndicatesSupport(DECRQM_NOT_RECOGNIZED)).toBe(false)
    expect(decrqmIndicatesSupport(DECRQM_PERMANENTLY_RESET)).toBe(false)
    expect(decrqmIndicatesSupport(null)).toBe(false)
  })
})

describe('stripDecrqmReply', () => {
  it('removes the reply and keeps the user keystrokes around it', () => {
    expect(stripDecrqmReply('ab\x1b[?2026;1$ycd', SYNC_OUTPUT_MODE)).toBe('abcd')
  })
})

describe('probeMode', () => {
  function streams(): { input: PassThrough; output: PassThrough; written: string[] } {
    const input = new PassThrough()
    const output = new PassThrough()
    const written: string[] = []
    output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))
    return { input, output, written }
  }

  it('sends the query and reports support on a 1 reply', async () => {
    const { input, output, written } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    expect(written.join('')).toBe(decrqmQuery(SYNC_OUTPUT_MODE))
    input.write('\x1b[?2026;1$y')
    await expect(promise).resolves.toMatchObject({ supported: true, value: DECRQM_SET })
  })

  it('reports support on a 2 reply', async () => {
    const { input, output } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    input.write('\x1b[?2026;2$y')
    await expect(promise).resolves.toMatchObject({ supported: true, value: DECRQM_RESET })
  })

  it('reports no support on a 0 reply', async () => {
    const { input, output } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    input.write('\x1b[?2026;0$y')
    await expect(promise).resolves.toMatchObject({ supported: false, value: DECRQM_NOT_RECOGNIZED })
  })

  it('reports no support when the terminal says nothing at all', async () => {
    const { input, output } = streams()
    const result = await probeMode({ input, output, timeoutMs: 30 })
    expect(result).toMatchObject({ supported: false, value: null })
  })

  it('hands back input that arrived during the probe', async () => {
    const { input, output } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    input.write('ls\x1b[?2026;1$y -la')
    const result = await promise
    expect(result.leftover.toString('latin1')).toBe('ls -la')
  })

  it('does not corrupt a high byte that arrived beside the reply', async () => {
    // The whole reason leftover is a Buffer: a legacy X10 mouse report puts `32 + column`
    // in one byte, so column 200 is 0xE8 — not valid UTF-8 on its own, and destroyed by a
    // StringDecoder. Byte-for-byte survival is the contract.
    const { input, output } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    input.write(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28]))
    input.write('\x1b[?2026;1$y')
    const result = await promise
    expect([...result.leftover]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28])
  })

  it('handles a reply split across two reads', async () => {
    const { input, output } = streams()
    const promise = probeMode({ input, output, timeoutMs: 1_000 })
    await new Promise((resolve) => setImmediate(resolve))
    input.write('\x1b[?20')
    await new Promise((resolve) => setImmediate(resolve))
    input.write('26;1$y')
    await expect(promise).resolves.toMatchObject({ supported: true })
  })
})

describe('Screen input backlog', () => {
  it('replays keystrokes that arrived before a handler existed', async () => {
    // The gap is real: open() waits up to the probe timeout for DECRQM, and the caller
    // then does its own async setup before attaching a handler.
    const input = new PassThrough() as unknown as NodeJS.ReadStream
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const screen = await Screen.open({ input, output, synchronizedOutput: false, fallbackSize: { cols: 80, rows: 24 } })
    try {
      input.write('typed-early')
      await new Promise((resolve) => setImmediate(resolve))

      const seen: Buffer[] = []
      screen.onInput((data) => seen.push(data))
      await new Promise((resolve) => setImmediate(resolve))
      expect(Buffer.concat(seen).toString('latin1')).toBe('typed-early')

      input.write('and-later')
      await new Promise((resolve) => setImmediate(resolve))
      expect(Buffer.concat(seen).toString('latin1')).toBe('typed-earlyand-later')
    } finally {
      screen.close()
    }
  })

  it('delivers input as raw bytes, without a StringDecoder in the way', async () => {
    const input = new PassThrough() as unknown as NodeJS.ReadStream
    const output = new PassThrough() as unknown as NodeJS.WriteStream
    const screen = await Screen.open({ input, output, synchronizedOutput: false, fallbackSize: { cols: 80, rows: 24 } })
    try {
      const seen: Buffer[] = []
      screen.onInput((data) => seen.push(data))
      // A legacy X10 mouse report for a column past 95, and a Latin-1 paste byte.
      input.write(Buffer.from([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28, 0xe9]))
      await new Promise((resolve) => setImmediate(resolve))
      expect([...Buffer.concat(seen)]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0xe8, 0x28, 0xe9])
    } finally {
      screen.close()
    }
  })
})
