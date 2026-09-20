/**
 * Framer vectors, transliterated from herdr's `src/raw_input.rs` test module
 * (Apache-2.0, herdr 3f2a6e74). The test names follow herdr's where one exists, so a
 * failure here can be read against the original.
 *
 * The orphaned-mouse-tail cases are the ones worth reading: they encode a rule that is
 * easy to get backwards. Idle resolves a lone ESC. Idle does *not* resolve a truncated
 * mouse report — that gets retained, and either completes (and is discarded, because it
 * is stale) or proves itself not a report (and is released as the text it always was).
 */

import { describe, expect, it } from 'vitest'
import {
  InputFramer,
  completeEscapeSequenceLen,
  firstUtf8CharLen,
  startsWithIncompleteSgrMouse,
  startsWithIncompleteUtf8,
  startsWithIncompleteX10Mouse,
  utf8CharWidth,
  type Frame
} from './framer.js'

const b = (text: string): Buffer => Buffer.from(text, 'latin1')

/** The framed sequences, as latin1 strings so a byte is one character in the assertion. */
function texts(frames: readonly Frame[]): string[] {
  return frames.map((frame) =>
    frame.kind === 'paste' ? `<paste:${frame.data.toString('latin1')}>` : frame.bytes.toString('latin1')
  )
}

describe('utf8 framing', () => {
  it('reports the width of a lead byte', () => {
    expect(utf8CharWidth(0x41)).toBe(1)
    expect(utf8CharWidth(0xc3)).toBe(2)
    expect(utf8CharWidth(0xe4)).toBe(3)
    expect(utf8CharWidth(0xf0)).toBe(4)
    // A continuation byte is not a lead, and neither is 0xFF.
    expect(utf8CharWidth(0x80)).toBeNull()
    expect(utf8CharWidth(0xff)).toBeNull()
  })

  it('needs every byte of a character before it frames one', () => {
    const full = Buffer.from('世', 'utf8')
    expect(firstUtf8CharLen(full)).toBe(3)
    expect(firstUtf8CharLen(full.subarray(0, 2))).toBeNull()
    expect(startsWithIncompleteUtf8(full.subarray(0, 2))).toBe(true)
    expect(startsWithIncompleteUtf8(full)).toBe(false)
    // A byte that can never lead is not "incomplete"; waiting for it would hang forever.
    expect(startsWithIncompleteUtf8(Buffer.from([0xff]))).toBe(false)
  })
})

describe('completeEscapeSequenceLen', () => {
  it('holds a bare escape', () => {
    expect(completeEscapeSequenceLen(b('\x1b'))).toBeNull()
  })

  it('measures CSI, SS3 and OSC sequences', () => {
    expect(completeEscapeSequenceLen(b('\x1b[A'))).toBe(3)
    expect(completeEscapeSequenceLen(b('\x1b[1;5A'))).toBe(6)
    expect(completeEscapeSequenceLen(b('\x1bOP'))).toBe(3)
    expect(completeEscapeSequenceLen(b('\x1b[15~'))).toBe(5)
    expect(completeEscapeSequenceLen(b('\x1b]0;title\x07'))).toBe(10)
    expect(completeEscapeSequenceLen(b('\x1b]0;title\x1b\\'))).toBe(11)
    expect(completeEscapeSequenceLen(b('\x1b]0;title'))).toBeNull()
  })

  it('gives the legacy mouse report its fixed six bytes', () => {
    expect(completeEscapeSequenceLen(b('\x1b[MCN1'))).toBe(6)
    expect(completeEscapeSequenceLen(b('\x1b[MCN'))).toBeNull()
  })

  it('ends an SGR mouse report only on M or m', () => {
    expect(completeEscapeSequenceLen(b('\x1b[<0;20;10M'))).toBe(11)
    expect(completeEscapeSequenceLen(b('\x1b[<0;20;10m'))).toBe(11)
    expect(completeEscapeSequenceLen(b('\x1b[<0;20;10'))).toBeNull()
  })

  it('yields a doubled escape in front of a mouse report as one byte', () => {
    // Alt held during a mouse report. Consuming both would swallow the report.
    expect(completeEscapeSequenceLen(b('\x1b\x1b[<0;20;10M'))).toBe(1)
    expect(completeEscapeSequenceLen(b('\x1b\x1b[MCN1'))).toBe(1)
  })

  it('measures a doubled escape in front of an ordinary sequence as the whole thing', () => {
    expect(completeEscapeSequenceLen(b('\x1b\x1b[A'))).toBe(4)
  })

  it('measures ESC plus one multi-byte character', () => {
    expect(completeEscapeSequenceLen(Buffer.concat([b('\x1b'), Buffer.from('é', 'utf8')]))).toBe(3)
    expect(completeEscapeSequenceLen(Buffer.concat([b('\x1b'), Buffer.from('é', 'utf8').subarray(0, 1)]))).toBeNull()
  })
})

describe('the framer', () => {
  it('frames a plain character', () => {
    expect(texts(new InputFramer().push(b('a')))).toEqual(['a'])
  })

  it('frames several sequences arriving in one read', () => {
    expect(texts(new InputFramer().push(b('\x1b[A\x1b[Bx')))).toEqual(['\x1b[A', '\x1b[B', 'x'])
  })

  it('buffers a lone escape until the idle flush', () => {
    // herdr: lone_escape_is_buffered_until_timeout_flush
    const framer = new InputFramer()
    expect(framer.push(b('\x1b'))).toEqual([])
    expect(framer.hasPendingLoneEscape).toBe(true)
    expect(texts(framer.flushIdle())).toEqual(['\x1b'])
  })

  it('does not emit an escape when an arrow completes it first', () => {
    // herdr: escape_followed_by_arrow_before_flush_does_not_emit_escape
    const framer = new InputFramer()
    expect(framer.push(b('\x1b'))).toEqual([])
    expect(texts(framer.push(b('[B')))).toEqual(['\x1b[B'])
  })

  it('does not emit text when an SGR mouse report completes a held escape', () => {
    // herdr: escape_followed_by_sgr_mouse_before_flush_does_not_emit_text
    const framer = new InputFramer()
    expect(framer.push(b('\x1b'))).toEqual([])
    expect(texts(framer.push(b('[<65;43;26M')))).toEqual(['\x1b[<65;43;26M'])
  })

  it('emits both when an escape is followed by a whole mouse report', () => {
    // herdr: lone_escape_then_complete_sgr_mouse_report_emits_both_events
    for (const report of ['\x1b[<35;10;20M', '\x1b[<35;10;20m']) {
      const framer = new InputFramer()
      expect(framer.push(b('\x1b'))).toEqual([])
      expect(texts(framer.push(b(report)))).toEqual(['\x1b', report])
      expect(framer.flushIdle()).toEqual([])
    }
  })

  it('reassembles a sequence split across reads, one byte at a time', () => {
    const framer = new InputFramer()
    const frames: Frame[] = []
    for (const byte of b('\x1b[1;5A')) frames.push(...framer.push(Buffer.from([byte])))
    expect(texts(frames)).toEqual(['\x1b[1;5A'])
  })

  it('reassembles a UTF-8 character split across reads', () => {
    const framer = new InputFramer()
    const bytes = Buffer.from('世', 'utf8')
    expect(framer.push(bytes.subarray(0, 2))).toEqual([])
    expect(framer.flushIdle()).toEqual([]) // herdr: incomplete_utf8_prefix_is_not_flushed_on_timeout
    const frames = framer.push(bytes.subarray(2))
    // One frame of three bytes, not three frames of one. Compared as bytes, because the
    // latin1 view `texts()` uses would show this character as three.
    expect(frames).toHaveLength(1)
    const frame = frames[0] as Frame
    expect(frame.kind === 'bytes' && frame.bytes.toString('utf8')).toBe('世')
  })

  it('emits a byte that can never start a character rather than buffering it forever', () => {
    // herdr: invalid_utf8_lead_byte_is_flushed_instead_of_buffered_forever
    expect(texts(new InputFramer().push(Buffer.from([0xff, 0x41])))).toEqual(['\xff', 'A'])
  })
})

describe('bracketed paste', () => {
  it('emits one paste event for the whole block', () => {
    // herdr: parses_bracketed_paste
    const framer = new InputFramer()
    expect(texts(framer.push(b('\x1b[200~hello\x1b[201~rest')))).toEqual(['<paste:hello>', 'r', 'e', 's', 't'])
  })

  it('joins a paste split across many reads into one event', () => {
    // PHASE-3 criterion 6, in miniature: N reads in, one event out.
    const framer = new InputFramer()
    expect(framer.push(b('\x1b[200~'))).toEqual([])
    for (const part of ['abc', 'def', 'ghi']) expect(framer.push(b(part))).toEqual([])
    expect(texts(framer.push(b('\x1b[201~')))).toEqual(['<paste:abcdefghi>'])
  })

  it('holds a terminator that straddles two reads', () => {
    const framer = new InputFramer()
    framer.push(b('\x1b[200~body\x1b[20'))
    expect(framer.isPasting).toBe(true)
    expect(texts(framer.push(b('1~')))).toEqual(['<paste:body>'])
  })

  it('does not flush an incomplete paste on idle', () => {
    // herdr: incomplete_bracketed_paste_is_not_flushed_on_timeout
    const framer = new InputFramer()
    framer.push(b('\x1b[200~half'))
    expect(framer.flushIdle()).toEqual([])
    expect(framer.isPasting).toBe(true)
  })

  it('does not frame a partial paste introducer as an ordinary CSI sequence', () => {
    const framer = new InputFramer()
    expect(framer.push(b('\x1b[200'))).toEqual([])
    expect(texts(framer.push(b('~x\x1b[201~')))).toEqual(['<paste:x>'])
  })

  it('carries bytes a UTF-8 decode would have destroyed', () => {
    const framer = new InputFramer()
    const payload = Buffer.from([0xe8, 0x00ff, 0x41])
    const frames = framer.push(Buffer.concat([b('\x1b[200~'), payload, b('\x1b[201~')]))
    expect(frames).toHaveLength(1)
    const frame = frames[0] as Frame
    expect(frame.kind).toBe('paste')
    if (frame.kind === 'paste') expect([...frame.data]).toEqual([0xe8, 0xff, 0x41])
  })

  it('splits a paste that exceeds the cap instead of buffering without limit', () => {
    // A terminal that never sends `CSI 201 ~` must not be able to grow the buffer
    // forever — but the overflow is still paste, so it stays paste rather than becoming
    // a few megabytes of keystrokes at the user's shell.
    const framer = new InputFramer({ maxPasteBytes: 64 })
    framer.push(b('\x1b[200~'))
    expect(framer.push(Buffer.alloc(256, 0x61))).toHaveLength(1)
    expect(framer.isPasting).toBe(true)
    expect(texts(framer.push(b('tail\x1b[201~')))).toEqual(['<paste:aaaaatail>'])
    expect(framer.isPasting).toBe(false)
  })
})

describe('orphaned mouse tails', () => {
  it('recognizes a truncated report', () => {
    expect(startsWithIncompleteSgrMouse(b('\x1b[<3'))).toBe(true)
    expect(startsWithIncompleteSgrMouse(b('\x1b[<35;58;'))).toBe(true)
    expect(startsWithIncompleteSgrMouse(b('\x1b[<35;58;30M'))).toBe(false) // complete
    expect(startsWithIncompleteX10Mouse(b('\x1b[MC'))).toBe(true)
    expect(startsWithIncompleteX10Mouse(b('\x1b[MCN1'))).toBe(false)
  })

  it('never flushes a truncated report as text on idle', () => {
    // The bug this whole mechanism exists to prevent: `[<0;3;4` typed at the shell.
    const framer = new InputFramer()
    expect(framer.push(b('\x1b[<0;3;4'))).toEqual([])
    expect(framer.flushIdle()).toEqual([])
    expect(framer.retainedMousePrefix?.toString('latin1')).toBe('\x1b[<0;3;4')
  })

  it('discards a late report and preserves what followed it', () => {
    // herdr: timed_out_split_sgr_mouse_tail_is_discarded_and_following_input_is_preserved
    const framer = new InputFramer()
    expect(framer.push(b('\x1b[<3'))).toEqual([])
    expect(framer.flushIdle()).toEqual([])
    expect(texts(framer.push(b('5;58;30Mx')))).toEqual(['x'])
    expect(framer.retainedMousePrefix).toBeNull()
  })

  it('survives every split of the continuation', () => {
    // herdr: timed_out_sgr_mouse_completion_survives_read_splits_and_idle
    const tail = '5;28;31M'
    for (let split = 0; split <= tail.length; split++) {
      const framer = new InputFramer()
      expect(framer.push(b('\x1b[<3'))).toEqual([])
      expect(framer.flushIdle()).toEqual([])
      expect(framer.push(b(tail.slice(0, split)))).toEqual([])
      expect(framer.flushIdle()).toEqual([])
      expect(texts(framer.push(b(`${tail.slice(split)}x\x1b[A`)))).toEqual(['x', '\x1b[A'])
      expect(framer.retainedMousePrefix).toBeNull()
      expect(framer.pendingBytes).toBe(0)
    }
  })

  it('releases a continuation that proves it was never a report', () => {
    // herdr: timed_out_sgr_mouse_invalid_syntax_releases_continuation
    for (const tail of ['5;0;31M', '5;;31M', '5;28;31;1M', '999;28;31M', '5;65536;31M']) {
      const framer = new InputFramer()
      expect(framer.push(b('\x1b[<3'))).toEqual([])
      expect(framer.flushIdle()).toEqual([])
      expect(texts(framer.push(b(tail))).join('')).toBe(tail)
      expect(framer.retainedMousePrefix).toBeNull()
    }
  })

  it('releases text typed after a truncated report, and keeps framing', () => {
    // herdr: timed_out_sgr_mouse_interruption_preserves_text_and_new_events
    for (const suffix of ['x', '\x1b[A']) {
      const framer = new InputFramer()
      expect(framer.push(b('\x1b[<3'))).toEqual([])
      expect(framer.flushIdle()).toEqual([])
      expect(framer.push(b('5;28;'))).toEqual([])
      expect(framer.flushIdle()).toEqual([])
      const frames: Frame[] = []
      for (const byte of b(suffix)) frames.push(...framer.push(Buffer.from([byte])))
      expect(texts(frames).join('')).toBe(`5;28;${suffix}`)
      expect(framer.retainedMousePrefix).toBeNull()
    }
  })

  it('gives up once the continuation blows its byte budget', () => {
    // herdr: timed_out_sgr_mouse_budget_includes_prefix_and_preserves_overflow
    const framer = new InputFramer()
    expect(framer.push(b('\x1b[<35;1;'))).toEqual([])
    expect(framer.flushIdle()).toEqual([])
    const overflow = '0'.repeat(200)
    expect(texts(framer.push(b(overflow))).join('')).toBe(overflow)
    expect(framer.retainedMousePrefix).toBeNull()
  })

  it('uses the longer idle window while a report is in flight', () => {
    const framer = new InputFramer()
    expect(framer.idleTimeoutMs).toBe(10)
    framer.push(b('\x1b[<3'))
    expect(framer.idleTimeoutMs).toBe(150)
  })

  it('forgets a retained prefix on reset', () => {
    // herdr: flush_interrupted. A prefix must not outlive the session that saw it.
    const framer = new InputFramer()
    framer.push(b('\x1b[<3'))
    framer.flushIdle()
    framer.reset()
    expect(framer.retainedMousePrefix).toBeNull()
    expect(texts(framer.push(b('5;58;30M')))).toEqual(['5', ';', '5', '8', ';', '3', '0', 'M'])
  })
})
