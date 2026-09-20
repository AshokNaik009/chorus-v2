/**
 * The branch picker, driven by keystrokes at a plain object.
 *
 * The picker performs nothing, so everything it decides is observable here: what the
 * filter leaves, where the cursor lands, and which branch `Enter` names. The integration
 * side — that `b` opens it and a checkout updates the panel's branch line — is in
 * `test/source-control.test.ts`, because that is a claim about wiring.
 */

import type { GitBranch } from '@leap-chorus/protocol'
import { describe, expect, it } from 'vitest'
import { BranchPicker } from './branch.js'

function branches(): GitBranch[] {
  return [
    { name: 'main', current: true, remote: false },
    { name: 'feature/login', current: false, remote: false },
    { name: 'feature/logout', current: false, remote: false },
    { name: 'origin/main', current: false, remote: true },
    { name: 'origin/feature/login', current: false, remote: true }
  ]
}

/** Type a string at the picker, one character at a time, as a terminal would. */
function type(picker: BranchPicker, text: string): void {
  for (const char of text) picker.handleKey('char', char, false)
}

describe('the branch picker', () => {
  it('opens on the current branch', () => {
    expect(new BranchPicker(branches()).selected()?.name).toBe('main')
  })

  it('opens on the first entry when nothing is current, as on a detached HEAD', () => {
    const detached = branches().map((branch) => ({ ...branch, current: false }))
    expect(new BranchPicker(detached).selected()?.name).toBe('main')
  })

  it('filters as you type, case-insensitively', () => {
    const picker = new BranchPicker(branches())
    type(picker, 'LOGIN')
    expect(picker.matches().map((branch) => branch.name)).toEqual(['feature/login', 'origin/feature/login'])
  })

  it('backspaces back out of the filter', () => {
    const picker = new BranchPicker(branches())
    type(picker, 'logout')
    expect(picker.matches()).toHaveLength(1)
    for (let i = 0; i < 3; i++) picker.handleKey('backspace', undefined, false)
    expect(picker.filter).toBe('log')
    expect(picker.matches().map((branch) => branch.name)).toEqual(['feature/login', 'feature/logout', 'origin/feature/login'])
  })

  it('clears the whole filter on ^c', () => {
    const picker = new BranchPicker(branches())
    type(picker, 'logout')
    picker.handleKey('char', 'c', true)
    expect(picker.filter).toBe('')
    expect(picker.matches()).toHaveLength(5)
  })

  /**
   * The cursor must not slide under a typing user. If the branch under it when the
   * last character was typed is still in the list, that is the one Enter takes.
   */
  it('keeps the cursor on the same branch while the list narrows around it', () => {
    const picker = new BranchPicker(branches())
    picker.handleKey('down', undefined, false)
    expect(picker.selected()?.name).toBe('feature/login')
    type(picker, 'feature')
    expect(picker.selected()?.name).toBe('feature/login')
  })

  it('falls back to the first match when the selected branch is filtered away', () => {
    const picker = new BranchPicker(branches())
    expect(picker.selected()?.name).toBe('main')
    type(picker, 'logout')
    expect(picker.selected()?.name).toBe('feature/logout')
  })

  it('moves with the arrow keys and stops at both ends', () => {
    const picker = new BranchPicker(branches())
    picker.handleKey('up', undefined, false)
    expect(picker.selected()?.name).toBe('main')
    for (let i = 0; i < 10; i++) picker.handleKey('down', undefined, false)
    expect(picker.selected()?.name).toBe('origin/feature/login')
  })

  it('asks for a checkout of the selected branch on enter, saying whether it is remote', () => {
    const picker = new BranchPicker(branches())
    type(picker, 'origin/main')
    expect(picker.handleKey('enter', undefined, false)).toEqual({
      kind: 'checkout',
      branch: { name: 'origin/main', current: false, remote: true }
    })
  })

  it('does nothing on enter when the filter matches no branch', () => {
    const picker = new BranchPicker(branches())
    type(picker, 'nothing-like-this')
    expect(picker.matches()).toEqual([])
    expect(picker.handleKey('enter', undefined, false)).toEqual({ kind: 'none' })
  })

  it('closes on escape', () => {
    expect(new BranchPicker(branches()).handleKey('escape', undefined, false)).toEqual({ kind: 'close' })
  })

  /**
   * `j` and `k` are filter characters here, not movement. A picker that swallowed them
   * could not find a branch with a `j` in it, and `feat/jwt` is a real branch name.
   */
  it('types j and k rather than moving with them', () => {
    const picker = new BranchPicker([
      { name: 'main', current: true, remote: false },
      { name: 'feat/jwt', current: false, remote: false }
    ])
    type(picker, 'j')
    expect(picker.filter).toBe('j')
    expect(picker.selected()?.name).toBe('feat/jwt')
  })
})
