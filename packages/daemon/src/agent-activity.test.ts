import { describe, expect, it } from 'vitest'
import { parseAgentActivity } from './agent-activity.js'

const report = { paneId: 'pane-a', agent: 'claude', seq: 10 }

describe('file activity input', () => {
  it('keeps old state-only reports compatible', () => {
    expect(parseAgentActivity(report)).toBeNull()
  })

  it('normalizes paths and retains only metadata', () => {
    const activity = parseAgentActivity({ ...report, activity: { kind: 'write', cwd: '/repo', path: 'src/../app.ts', content: 'not sent' } })
    expect(activity).toMatchObject({ paneId: 'pane-a', agent: 'claude', kind: 'write', cwd: '/repo', path: '/repo/app.ts', seq: 10 })
    expect(activity).not.toHaveProperty('content')
  })

  it('does not invent a file for shell activity', () => {
    expect(parseAgentActivity({ ...report, activity: { kind: 'refresh', cwd: '/repo', path: 'guess.ts' } })).not.toHaveProperty('path')
  })

  it.each([
    null, [], 'write', { kind: 'execute', cwd: '/repo' },
    { kind: 'read', cwd: '/repo' }, { kind: 'write', cwd: 'relative', path: 'a' },
    { kind: 'read', cwd: '/repo', path: 'a\0b' }, { kind: 'read', cwd: '/repo', path: 'x'.repeat(4097) }
  ])('rejects malformed metadata: %j', (activity) => {
    expect(() => parseAgentActivity({ ...report, activity })).toThrow()
  })
})
