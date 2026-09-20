/**
 * The kitty flag stack and modifyOtherKeys level. PHASE-3 criterion 3, minus the part
 * that needs a real emulator — that half is in the daemon's tests.
 */

import { describe, expect, it } from 'vitest'
import {
  KITTY_DISAMBIGUATE_ESCAPE_CODES,
  KITTY_REPORT_ALL_KEYS,
  KITTY_REPORT_ALTERNATE_KEYS,
  KITTY_REPORT_EVENT_TYPES,
  LEGACY_PROTOCOL
} from './model.js'
import { KeyboardProtocolState, MAX_KITTY_STACK_DEPTH } from './kitty.js'

describe('the kitty flag stack', () => {
  it('starts empty, which is not the same as zero flags', () => {
    const state = new KeyboardProtocolState()
    expect(state.depth).toBe(0)
    expect(state.kittyFlags).toBe(0)
    // A program can legitimately push 0, and that *is* the protocol being on.
    state.push(0)
    expect(state.depth).toBe(1)
    expect(state.kittyFlags).toBe(0)
  })

  it('pushes and pops', () => {
    const state = new KeyboardProtocolState()
    state.push(KITTY_DISAMBIGUATE_ESCAPE_CODES)
    expect(state.kittyFlags).toBe(1)
    state.push(KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES)
    expect(state.kittyFlags).toBe(3)
    state.pop()
    expect(state.kittyFlags).toBe(1)
    state.pop()
    expect(state.depth).toBe(0)
    expect(state.kittyFlags).toBe(0)
  })

  it('treats a pop on an empty stack as a no-op', () => {
    // PHASE-3 asks for this by name. A program that pops more than it pushed is common;
    // throwing would make that the multiplexer's crash rather than the program's mistake.
    const state = new KeyboardProtocolState()
    expect(() => state.pop()).not.toThrow()
    expect(() => state.pop(5)).not.toThrow()
    expect(state.depth).toBe(0)
    state.push(1)
    state.pop(99)
    expect(state.depth).toBe(0)
    expect(state.kittyFlags).toBe(0)
  })

  it('pops several at once', () => {
    const state = new KeyboardProtocolState()
    state.push(1)
    state.push(2)
    state.push(4)
    state.pop(2)
    expect(state.depth).toBe(1)
    expect(state.kittyFlags).toBe(1)
  })

  it('bounds the stack rather than letting a leaking program grow it', () => {
    const state = new KeyboardProtocolState()
    for (let i = 0; i < MAX_KITTY_STACK_DEPTH + 10; i++) state.push(1)
    expect(state.depth).toBe(MAX_KITTY_STACK_DEPTH)
  })

  it('sets, ors and clears the current entry', () => {
    const state = new KeyboardProtocolState()
    state.push(KITTY_DISAMBIGUATE_ESCAPE_CODES)
    state.set(KITTY_REPORT_EVENT_TYPES, 1)
    expect(state.kittyFlags).toBe(KITTY_REPORT_EVENT_TYPES)
    state.set(KITTY_REPORT_ALTERNATE_KEYS, 2)
    expect(state.kittyFlags).toBe(KITTY_REPORT_EVENT_TYPES | KITTY_REPORT_ALTERNATE_KEYS)
    state.set(KITTY_REPORT_EVENT_TYPES, 3)
    expect(state.kittyFlags).toBe(KITTY_REPORT_ALTERNATE_KEYS)
    // Setting does not change the depth.
    expect(state.depth).toBe(1)
  })

  it('turns the protocol on when a program sets without pushing first', () => {
    const state = new KeyboardProtocolState()
    state.set(KITTY_REPORT_ALL_KEYS, 1)
    expect(state.depth).toBe(1)
    expect(state.kittyFlags).toBe(KITTY_REPORT_ALL_KEYS)
  })

  it('drops reserved bits rather than honouring them', () => {
    const state = new KeyboardProtocolState()
    state.push(0xffff)
    expect(state.kittyFlags).toBe(0b0001_1111)
  })
})

describe('modifyOtherKeys', () => {
  it('accepts levels 1 and 2 and nothing else', () => {
    const state = new KeyboardProtocolState()
    expect(state.modifyOtherKeys).toBe(0)
    state.setModifyOtherKeys(1)
    expect(state.modifyOtherKeys).toBe(1)
    state.setModifyOtherKeys(2)
    expect(state.modifyOtherKeys).toBe(2)
    state.setModifyOtherKeys(0)
    expect(state.modifyOtherKeys).toBe(0)
    // `CSI > 4 m` with no parameter turns it off.
    state.setModifyOtherKeys(2)
    state.setModifyOtherKeys(undefined)
    expect(state.modifyOtherKeys).toBe(0)
    // A level nobody defined is not level 2.
    state.setModifyOtherKeys(9)
    expect(state.modifyOtherKeys).toBe(0)
  })
})

describe('snapshots', () => {
  it('round-trips through a snapshot, so a reattach does not lose the pane state', () => {
    // PHASE-3 criterion 3: the flags survive a client detach and reattach. They survive
    // because they never lived in the client.
    const state = new KeyboardProtocolState()
    state.push(KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES)
    state.setModifyOtherKeys(2)
    state.setApplicationCursorKeys(true)
    state.setApplicationKeypad(true)

    const snapshot = state.snapshot()
    expect(snapshot).toEqual({
      kittyFlags: KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES,
      modifyOtherKeys: 2,
      applicationCursorKeys: true,
      applicationKeypad: true,
      // Pushed in from the emulator's own mode tracking rather than observed here.
      bracketedPaste: false,
      mouseTracking: 'none'
    })
    expect(KeyboardProtocolState.fromSnapshot(snapshot).snapshot()).toEqual(snapshot)
  })

  it('reports the legacy protocol when nothing has been negotiated', () => {
    expect(new KeyboardProtocolState().snapshot()).toEqual(LEGACY_PROTOCOL)
  })

  it('clears everything on a reset', () => {
    const state = new KeyboardProtocolState()
    state.push(7)
    state.setModifyOtherKeys(2)
    state.setApplicationCursorKeys(true)
    state.reset()
    expect(state.snapshot()).toEqual(LEGACY_PROTOCOL)
    expect(state.depth).toBe(0)
  })
})
