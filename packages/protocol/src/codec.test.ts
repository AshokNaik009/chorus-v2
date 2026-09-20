import { describe, expect, it } from 'vitest'
import { createFrameDecoder, encodeFrame, FrameParseError, FrameTooLongError } from './codec.js'

function collect(options: { maxFrameBytes?: number } = {}) {
  const messages: unknown[] = []
  const errors: Error[] = []
  const decoder = createFrameDecoder({
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error)
  })
  return { decoder, messages, errors }
}

describe('NDJSON framing', () => {
  it('round-trips a message', () => {
    const { decoder, messages } = collect()
    decoder.push(encodeFrame({ type: 'req', id: 1, method: 'hello', params: {} }))
    expect(messages).toEqual([{ type: 'req', id: 1, method: 'hello', params: {} }])
  })

  it('delivers several frames arriving in one chunk', () => {
    const { decoder, messages } = collect()
    decoder.push(Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 }), encodeFrame({ n: 3 })]))
    expect(messages).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('reassembles a frame split across chunks, including mid-multibyte', () => {
    const { decoder, messages } = collect()
    const frame = encodeFrame({ text: '世界' })
    // Split inside the UTF-8 encoding of 世 so a naive toString() per chunk would corrupt it.
    const cut = frame.indexOf(Buffer.from('世', 'utf8')) + 1
    decoder.push(frame.subarray(0, cut))
    expect(messages).toEqual([])
    decoder.push(frame.subarray(cut))
    expect(messages).toEqual([{ text: '世界' }])
  })

  it('reports an unparsable frame and keeps going', () => {
    const { decoder, messages, errors } = collect()
    decoder.push(Buffer.from('{not json}\n'))
    decoder.push(encodeFrame({ ok: true }))
    expect(errors[0]).toBeInstanceOf(FrameParseError)
    expect(messages).toEqual([{ ok: true }])
  })

  it('bounds an unterminated frame and resynchronizes at the next newline', () => {
    const { decoder, messages, errors } = collect({ maxFrameBytes: 64 })
    decoder.push(Buffer.from('x'.repeat(200)))
    expect(errors[0]).toBeInstanceOf(FrameTooLongError)
    // The oversized frame is discarded up to its terminator, not buffered forever.
    expect(decoder.pendingBytes).toBe(0)
    decoder.push(Buffer.from('more-garbage\n'))
    decoder.push(encodeFrame({ recovered: true }))
    expect(messages).toEqual([{ recovered: true }])
  })

  it('rejects an oversized complete frame without dropping the next one', () => {
    const { decoder, messages, errors } = collect({ maxFrameBytes: 64 })
    decoder.push(Buffer.concat([Buffer.from(`${'y'.repeat(200)}\n`), encodeFrame({ next: true })]))
    expect(errors[0]).toBeInstanceOf(FrameTooLongError)
    expect(messages).toEqual([{ next: true }])
  })

  it('ignores empty lines', () => {
    const { decoder, messages, errors } = collect()
    decoder.push(Buffer.from('\n\n'))
    expect(messages).toEqual([])
    expect(errors).toEqual([])
  })
})
