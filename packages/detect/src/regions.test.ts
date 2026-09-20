import { describe, expect, it } from 'vitest'
import { detectionInput, isHorizontalRule, parseRegionSpec, region, splitLines } from './regions.js'

const at = (screen: string, spec: string): string => region(detectionInput({ screen }), spec)

describe('line splitting', () => {
  it('matches Rust str::lines(): no empty tail, \\r stripped', () => {
    expect(splitLines('a\nb').text).toEqual(['a', 'b'])
    expect(splitLines('a\n').text).toEqual(['a'])
    expect(splitLines('\n').text).toEqual([''])
    expect(splitLines('').text).toEqual([])
    expect(splitLines('a\r\nb').text).toEqual(['a', 'b'])
  })

  it('records where each line starts, so a slice is exact on CRLF too', () => {
    // herdr sums `line.len() + 1`, which drifts a byte per line on \r\n. An explicit
    // table cannot: the offsets come from the string, not from the stripped lines.
    expect(at('a\r\nb\r\nc', 'bottom_lines(1)')).toBe('c')
    expect(at('a\r\nb\r\nc', 'bottom_lines(2)')).toBe('b\r\nc')
  })
})

describe('counted regions', () => {
  const screen = 'one\ntwo\n\n\nthree\nfour'

  it('bottom_lines counts every line, blank or not', () => {
    expect(at(screen, 'bottom_lines(2)')).toBe('three\nfour')
    expect(at(screen, 'bottom_lines(4)')).toBe('\n\nthree\nfour')
  })

  it('bottom_non_empty_lines counts only non-blank ones, keeping the blanks between', () => {
    expect(at(screen, 'bottom_non_empty_lines(2)')).toBe('three\nfour')
    expect(at(screen, 'bottom_non_empty_lines(3)')).toBe('two\n\n\nthree\nfour')
  })

  it('top_non_empty_lines works from the other end', () => {
    expect(at(screen, 'top_non_empty_lines(1)')).toBe('one\n')
    expect(at(screen, 'top_non_empty_lines(3)')).toBe('one\ntwo\n\n\nthree\n')
  })

  it('asking for more lines than exist yields everything, not nothing', () => {
    expect(at('only', 'bottom_non_empty_lines(50)')).toBe('only')
  })

  it('a blank screen yields an empty region rather than the whole screen', () => {
    expect(at('\n\n\n', 'bottom_non_empty_lines(3)')).toBe('')
    expect(at('\n\n\n', 'top_non_empty_lines(3)')).toBe('')
  })

  it('rejects a leading zero in the count', () => {
    expect(parseRegionSpec('top_non_empty_lines(05)')).toBeNull()
    expect(parseRegionSpec('top_non_empty_lines(5)')).toEqual({ kind: 'top_non_empty_lines', count: 5 })
  })

  it('an unknown region is empty, never the whole screen', () => {
    // Failing open here would let a typo'd region match a rule against everything.
    expect(at('anything', 'bottom_lines(x)')).toBe('')
    expect(at('anything', 'nonsense')).toBe('')
  })
})

describe('the prompt box', () => {
  // claude's input box: a floor, the body, a ceiling.
  const screen = ['agent said something', '────────────', '❯ what I typed', '────────────', '  ? for shortcuts'].join('\n')

  it('prompt_box_body is what is between the two rules', () => {
    expect(at(screen, 'prompt_box_body')).toBe('❯ what I typed\n')
  })

  it('above_prompt_box stops at the box', () => {
    expect(at(screen, 'above_prompt_box')).toBe('agent said something\n')
  })

  it('last_non_empty_above_prompt_box is the one line that matters', () => {
    expect(at(`filler\n\n${screen}`, 'last_non_empty_above_prompt_box')).toBe('agent said something')
  })

  it('after_last_horizontal_rule is the footer', () => {
    expect(at(screen, 'after_last_horizontal_rule')).toBe('  ? for shortcuts')
  })

  it('needs three rule characters unless the line is only rule characters', () => {
    // Otherwise a line of prose containing one ─ becomes the top of the input box.
    expect(isHorizontalRule('───')).toBe(true)
    expect(isHorizontalRule('─── Files')).toBe(true)
    expect(isHorizontalRule('─')).toBe(true)
    expect(isHorizontalRule('─ not a rule')).toBe(false)
    expect(isHorizontalRule('text')).toBe(false)
    expect(isHorizontalRule('')).toBe(false)
  })

  it('falls back to the whole screen when there is no box', () => {
    expect(at('no box here', 'above_prompt_box')).toBe('no box here')
    expect(at('no box here', 'prompt_box_body')).toBe('')
  })
})

describe('the codex prompt marker', () => {
  it('after_last_prompt_marker starts below the newest ›', () => {
    expect(at('old\n› typed\nbelow', 'after_last_prompt_marker')).toBe('below')
  })

  it('before_current_prompt_marker stops above it', () => {
    expect(at('old\n› typed\nbelow', 'before_current_prompt_marker')).toBe('old\n')
  })

  it('a block marker after the prompt makes that prompt stale', () => {
    // The agent has answered since, so there is no *current* prompt and the
    // without-prompt region becomes the whole screen again.
    const answered = '› typed\n• the agent answered'
    expect(at(answered, 'whole_recent_without_current_prompt_marker')).toBe(answered)
    expect(at('› typed\nstill waiting', 'whole_recent_without_current_prompt_marker')).toBe('')
  })

  it('finds the block marker the current prompt belongs to', () => {
    const screen = '• first\nsome output\n• second\nmore\n› typed'
    expect(at(screen, 'current_prompt_block_marker')).toBe('• second')
    expect(at(screen, 'after_current_prompt_block_marker')).toBe('• second\nmore\n› typed')
  })

  it('treats a bare › as a prompt but not › inside a line', () => {
    expect(at('a\n›\nb', 'after_last_prompt_marker')).toBe('b')
    expect(at('a\nsee › here\nb', 'after_last_prompt_marker')).toBe('a\nsee › here\nb')
  })
})

describe('OSC regions', () => {
  it('never read the screen', () => {
    const input = detectionInput({ screen: 'on the screen', oscTitle: 'the title', oscProgress: '4;0' })
    expect(region(input, 'osc_title')).toBe('the title')
    expect(region(input, 'osc_progress')).toBe('4;0')
    expect(region(input, 'whole_recent')).toBe('on the screen')
  })
})
