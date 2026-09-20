import { describe, expect, it } from 'vitest'
import {
  buildProcessIndex,
  descendantsOf,
  foregroundCandidates,
  foregroundCommand,
  hasChildren,
  parseProcessRows,
  ProcessTable,
  ProcessTableError
} from './process-table.js'

/** `ps -axo pid=,ppid=,pgid=,tpgid=,command=`, as a real one looks. */
const SAMPLE = [
  '    1     0     1    -1 /sbin/launchd',
  '  900     1   900   950 -bash',
  '  950   900   950   950 node /Users/x/.nvm/versions/node/v22.1.0/bin/claude',
  '  975   950   950   950 rg --json pattern',
  '  600     1   600    -1 /usr/sbin/cupsd'
].join('\n')

describe('parsing', () => {
  it('reads the five columns, keeping the command whole', () => {
    const rows = parseProcessRows(SAMPLE)
    expect(rows).toHaveLength(5)
    expect(rows[2]).toEqual({
      pid: 950,
      ppid: 900,
      pgid: 950,
      tpgid: 950,
      command: 'node /Users/x/.nvm/versions/node/v22.1.0/bin/claude'
    })
  })

  it('skips a row it cannot read rather than failing the capture', () => {
    // A zombie with no command column is real; losing it costs one process, and
    // rejecting the whole table would tell every pane its agent had vanished.
    expect(parseProcessRows(`garbage\n${SAMPLE}`)).toHaveLength(5)
  })

  it('accepts a negative tpgid, which means no controlling tty', () => {
    expect(parseProcessRows(SAMPLE)[0]?.tpgid).toBe(-1)
  })
})

describe('the index', () => {
  const index = buildProcessIndex(parseProcessRows(SAMPLE))

  it('maps pid and parent/child in one pass', () => {
    expect(index.byPid.get(950)?.command).toContain('claude')
    expect(index.childrenByPpid.get(900)?.map((row) => row.pid)).toEqual([950])
  })

  it('walks descendants depth first', () => {
    expect(descendantsOf(index, 900).map((row) => row.pid)).toEqual([950, 975])
    expect(descendantsOf(index, 975)).toEqual([])
  })

  it('answers the close guard question', () => {
    expect(hasChildren(index, 900)).toBe(true)
    expect(hasChildren(index, 975)).toBe(false)
  })

  it('names the process in front of a shell from its tty foreground group', () => {
    expect(foregroundCommand(index, 900)).toContain('claude')
  })

  it('names the shell itself when nothing is in front of it', () => {
    const idle = buildProcessIndex(parseProcessRows('  900     1   900   900 -bash'))
    expect(foregroundCommand(idle, 900)).toBe('-bash')
  })

  it('has no answer for a pid the table does not contain', () => {
    expect(foregroundCommand(index, 12345)).toBeNull()
  })

  /**
   * The bug this pins down made every MCP-using agent invisible.
   *
   * A pane launched straight into `claude` is its own foreground process group leader,
   * so the tty rule does not fire. Claude then starts a Playwright MCP server, so it
   * has descendants. The old code went straight to the *deepest* descendant and
   * returned `node .../playwright` — not an agent — and the pane reported no agent at
   * all while claude's UI was on the screen. Found by running it.
   */
  it('prefers the pane\'s own program over anything it spawned', () => {
    const withMcp = buildProcessIndex(
      parseProcessRows(
        [
          '18701     1 18701 18701 claude',
          '18734 18701 18701 18701 npm exec @playwright/mcp@0.0.79 --user-data-dir /Users/x/Library',
          '18816 18734 18701 18701 node /Users/x/.npm/_npx/51691537fc71f2b0/node_modules/.bin/playwright'
        ].join('\n')
      )
    )
    expect(foregroundCommand(withMcp, 18701)).toBe('claude')
  })

  it('offers candidates best guess first: leader, then root, then children by depth', () => {
    const withMcp = buildProcessIndex(
      parseProcessRows(
        ['18701     1 18701 18701 claude', '18734 18701 18701 18701 npm exec mcp', '18816 18734 18701 18701 node deep'].join('\n')
      )
    )
    expect(foregroundCandidates(withMcp, 18701)).toEqual(['claude', 'npm exec mcp', 'node deep'])
  })

  it('still puts a distinct tty foreground group first', () => {
    // The ordinary case: a shell with vim in front of it.
    expect(foregroundCandidates(index, 900)[0]).toContain('claude')
  })
})

describe('one capture, many panes (PHASE-5 criterion 3)', () => {
  /**
   * The rule this proves, from PHASE-5:
   *
   * > with 15 panes polling, the process table is captured once per TTL window, not 15
   * > times. Prove it with a counter in a test.
   */
  it('captures once for fifteen panes inside one TTL window', async () => {
    let captures = 0
    let clock = 1000
    const table = new ProcessTable({
      capture: async () => {
        captures += 1
        return SAMPLE
      },
      now: () => clock,
      ttlMs: 500
    })

    // Sequential, as a poll that awaits each pane would be: the second onward are
    // cache hits, not coalesced waits, which is the stronger claim.
    for (let pane = 0; pane < 15; pane++) await table.get()

    expect(captures).toBe(1)
    expect(table.stats.captures).toBe(1)
    expect(table.stats.cacheHits).toBe(14)
    expect(table.stats.indexBuilds).toBe(1)
  })

  it('captures once for fifteen panes polling concurrently', async () => {
    let captures = 0
    const table = new ProcessTable({
      capture: async () => {
        captures += 1
        await new Promise((resolve) => setTimeout(resolve, 5))
        return SAMPLE
      },
      now: () => Date.now()
    })

    await Promise.all(Array.from({ length: 15 }, () => table.get()))
    expect(captures).toBe(1)
    expect(table.stats.coalesced).toBe(14)
  })

  it('builds the index once and hands the same one to every pane', async () => {
    const table = new ProcessTable({ capture: async () => SAMPLE, now: () => 1000 })
    const first = await table.get()
    const second = await table.get()
    // Identity, not equality: a per-pane rebuild would be a new object.
    expect(second).toBe(first)
    expect(table.stats.indexBuilds).toBe(1)
  })

  it('captures again once the TTL has passed', async () => {
    let clock = 1000
    let captures = 0
    const table = new ProcessTable({
      capture: async () => {
        captures += 1
        return SAMPLE
      },
      now: () => clock,
      ttlMs: 500
    })
    await table.get()
    clock += 499
    await table.get()
    expect(captures).toBe(1)
    clock += 2
    await table.get()
    expect(captures).toBe(2)
  })
})

describe('fresh', () => {
  it('bypasses the TTL, because a kill cannot be corrected next tick', async () => {
    let clock = 1000
    let captures = 0
    const table = new ProcessTable({
      capture: async () => {
        captures += 1
        return SAMPLE
      },
      now: () => clock,
      ttlMs: 500
    })
    await table.get()
    await table.get()
    expect(captures).toBe(1)
    await table.fresh()
    expect(captures).toBe(2)
  })

  it('does not settle for a capture that started before it was asked for', async () => {
    const started: number[] = []
    let n = 0
    const table = new ProcessTable({
      capture: async () => {
        const id = ++n
        started.push(id)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return SAMPLE
      }
    })
    const slow = table.get()
    const fresh = table.fresh()
    await Promise.all([slow, fresh])
    // Two captures: joining the in-flight one would hand the destructive caller a
    // table older than its own question.
    expect(started).toEqual([1, 2])
  })
})

describe('an unreadable table', () => {
  it('is an error, not a machine with no processes', async () => {
    // Reading an empty capture as "nothing is running" would report every agent done.
    const table = new ProcessTable({ capture: async () => '   \n' })
    await expect(table.get()).rejects.toThrow(ProcessTableError)
  })

  it('reports truncation as its own reason, not as a failed capture', async () => {
    // A caller has to be able to tell "the table is too big to read" from "ps is
    // gone", because only one of them is worth retrying with a narrower question.
    const table = new ProcessTable({ capture: async () => 'x'.repeat(32 * 1024 * 1024) })
    await expect(table.get()).rejects.toMatchObject({ reason: 'capture_truncated' })
  })

  it('does not poison the cache: the next call retries', async () => {
    let attempt = 0
    const table = new ProcessTable({
      capture: async () => {
        attempt += 1
        if (attempt === 1) throw new Error('ps went missing')
        return SAMPLE
      }
    })
    await expect(table.get()).rejects.toThrow()
    await expect(table.get()).resolves.toBeDefined()
  })
})
