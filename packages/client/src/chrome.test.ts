/**
 * The sidebar, as a rendered buffer.
 *
 * Phase 12 is about six pixels of vertical padding and what colour means, and there is
 * exactly one way to test a design: **draw it and read the cells back**. A fake
 * `SessionStateSnapshot` goes in, a `ScreenBuffer` comes out, and the assertions are on
 * the text, the styles and the blank rows — so the rhythm is a fact rather than an
 * opinion, and so the next person to add a row to this strip finds out immediately.
 *
 * It runs in milliseconds and needs no daemon, no PTY and no terminal. Every sidebar
 * defect fixed by eye at the end of phase 11 would have been caught by one of these.
 *
 * The end-to-end half — that a real client in a real PTY still draws a sidebar at all —
 * stays in `test/chrome.test.ts`, which is a different file and a different bargain.
 */

import { describe, expect, it } from 'vitest'
import {
  ASCII_BORDER,
  ATTR_BOLD,
  ATTR_DIM,
  HEAVY_BORDER,
  PLAIN_BORDER,
  ROUND_BORDER,
  ScreenBuffer,
  diffBuffers,
  encodeFrame,
  renderBlock,
  type Rect
} from '@leap-chorus/tui'
import { DEFAULT_CONFIG, validateConfig } from '@leap-chorus/core'
import type { GitRepoSummary, PaneRecord, SessionStateSnapshot, TabRecord, WorkspaceRecord } from '@leap-chorus/protocol'
import { emptyHitRegions, paletteOf, renderSidebar, type HitRegions, type SidebarOptions } from './chrome.js'
import { WORKSPACE_HUES, hashId, workspaceHue, workspaceHues } from './palette.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const palette = paletteOf(DEFAULT_CONFIG)

interface AgentSpec {
  readonly agent: string
  readonly status: 'idle' | 'working' | 'blocked' | 'done'
}

interface WorkspaceSpec {
  readonly id: string
  readonly label: string
  /** One pane per entry; `null` is a plain shell. */
  readonly panes: readonly (AgentSpec | null)[]
  readonly tabs?: number
}

/**
 * A snapshot built from a short description, because the wire records are verbose and
 * none of their detail is what any of these tests is about.
 */
function snapshot(specs: readonly WorkspaceSpec[], activeId?: string): SessionStateSnapshot {
  const workspaces: WorkspaceRecord[] = []
  const tabs: TabRecord[] = []
  const panes: PaneRecord[] = []
  let paneNumber = 0

  specs.forEach((spec, index) => {
    const tabCount = spec.tabs ?? 1
    const tabIds: string[] = []
    for (let t = 0; t < tabCount; t++) {
      paneNumber += 1
      const paneId = `p${paneNumber}`
      const agent = spec.panes[t] ?? null
      panes.push({
        paneId,
        sessionId: `s${paneNumber}`,
        number: paneNumber,
        label: null,
        title: agent === null ? 'bash' : agent.agent,
        cwd: `/r/${spec.id}`,
        exited: false,
        rightClick: 'app',
        scrollOffset: 0,
        agent: agent === null ? null : agent.agent,
        agentStatus: agent === null ? null : agent.status
      })
      const tabId = `${spec.id}-t${t + 1}`
      tabIds.push(tabId)
      tabs.push({
        tabId,
        workspaceId: spec.id,
        number: t + 1,
        label: null,
        layout: { type: 'pane', paneId },
        focusedPaneId: paneId,
        zoomed: false
      })
    }
    workspaces.push({
      workspaceId: spec.id,
      number: index + 1,
      label: spec.label,
      cwd: `/r/${spec.id}`,
      tabIds,
      activeTabId: tabIds[0] as string
    })
  })

  return {
    revision: 1,
    workspaces,
    workspaceOrder: workspaces.map((workspace) => workspace.workspaceId),
    tabs,
    panes,
    activeWorkspaceId: activeId ?? (workspaces[0]?.workspaceId ?? null),
    focusedPaneId: panes[0]?.paneId ?? null
  }
}

/**
 * The phase's own case: four workspaces, four agents, panes running Claude Code.
 *
 * `explore` is deliberately not a checkout, so the branch line's absence is covered
 * too — a workspace outside git draws no second row rather than an empty one.
 */
const NAMES = ['herdr', 'web-dashboard', 'explore', 'data-pipeline'] as const

function fourAndFour(): SessionStateSnapshot {
  return snapshot([
    { id: 'w1', label: 'herdr', panes: [{ agent: 'claude', status: 'working' }, null], tabs: 2 },
    { id: 'w2', label: 'web-dashboard', panes: [{ agent: 'claude', status: 'idle' }] },
    { id: 'w3', label: 'explore', panes: [{ agent: 'codex', status: 'blocked' }] },
    { id: 'w4', label: 'data-pipeline', panes: [{ agent: 'claude', status: 'done' }] }
  ])
}

function summary(branch: string, extra: Partial<GitRepoSummary> = {}): GitRepoSummary {
  return {
    path: '/r',
    isRepo: true,
    branch,
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    dirty: false,
    ...extra
  }
}

const SUMMARIES: ReadonlyMap<string, GitRepoSummary> = new Map([
  ['w1', summary('main', { ahead: 1, dirty: true })],
  ['w2', summary('feat/charts')],
  ['w4', summary('main', { behind: 2 })]
])

interface Drawn {
  readonly buffer: ScreenBuffer
  readonly hits: HitRegions
  readonly rows: string[]
  /**
   * Every row without its last column.
   *
   * The last column is `RIGHT_PAD`, which the resize grip lives in — three cells of
   * `⋮` at the vertical middle of whatever height the strip happens to be. Snapshots
   * of the *design* should not move when the strip gets a row taller, so they read
   * this and the grip gets its own test.
   */
  readonly body: string[]
  /** The row a piece of text is on, or -1. */
  row(text: string): number
}

function draw(
  state: SessionStateSnapshot,
  options: SidebarOptions & { width?: number; height?: number } = {}
): Drawn {
  const width = options.width ?? DEFAULT_CONFIG.ui.sidebarWidth
  const height = options.height ?? 30
  const area: Rect = { x: 0, y: 0, width, height }
  const buffer = new ScreenBuffer(width, height)
  const hits = emptyHitRegions()
  renderSidebar(buffer, area, state, palette, hits, options)
  const rows = Array.from({ length: height }, (_, y) => buffer.rowText(y))
  return {
    buffer,
    hits,
    rows,
    body: Array.from({ length: height }, (_, y) => buffer.rowText(y, { trimRight: false }).slice(0, width - 1).replace(/\s+$/u, '')),
    row: (text) => rows.findIndex((line) => line.includes(text))
  }
}

// ---------------------------------------------------------------------------
// Criterion 2 — the rhythm, at each state
// ---------------------------------------------------------------------------

describe('the rhythm is one row (criterion 2)', () => {
  it('an empty session is a header, a blank and the action row', () => {
    const drawn = draw(snapshot([]))
    expect(drawn.rows[0]?.trim()).toBe('spaces')
    expect(drawn.rows[1]).toBe('')
    expect(drawn.rows[2]).toContain('+ new')
    // Nothing invented below it: no agents card, no placeholder row.
    expect(drawn.body.slice(3, 29).every((line) => line.length === 0)).toBe(true)
  })

  it('one workspace with no agent draws no agents card at all', () => {
    const drawn = draw(snapshot([{ id: 'w1', label: 'solo', panes: [null] }]))
    expect(drawn.rows[0]?.trim()).toBe('spaces')
    expect(drawn.rows[1]).toContain('solo')
    // Its one tab is nested under it, because it is the active workspace.
    // The bar down the left is the selection, and it runs the whole entry — name,
    // branch and tabs — so four rows still read as one thing.
    expect(drawn.rows[2]).toBe('▌     › 1')
    expect(drawn.rows[3]).toBe('')
    expect(drawn.rows[4]).toContain('+ new')
    expect(drawn.rows.join('\n')).not.toContain('agents')
  })

  it('four workspaces and four agents: a blank between every entry, and one gutter between the cards', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES })
    // The whole strip, as text. This is the assertion the phase is actually about:
    // if somebody adds a row without a blank beside it, this is what changes.
    expect(drawn.body.slice(0, 25)).toEqual([
      ' spaces',
      '▌ 1 ● herdr',
      '▌     main ↑1 *',
      '▌     › 1',
      '▌       2',
      '',
      '  2 ○ web-dashboard',
      '      feat/charts',
      '',
      '  3 ◉ explore',
      '',
      '  4 ✓ data-pipeline',
      '      main ↓2',
      '',
      ' + new      ▤ files      menu',
      '',
      ' agents',
      '    ◉ explore',
      '      blocked · codex',
      '',
      '    ● herdr',
      '      working · claude',
      '',
      '    ○ web-dashboard',
      '      idle · claude'
    ])
  })

  it('the gutter between the cards is the sidebar, and a blank inside a card is the card', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES })
    const gutter = drawn.rows.findIndex((line) => line.trim() === 'agents') - 1
    expect(drawn.buffer.get(0, gutter).bg).toBe(palette.sidebar.bg)
    // The blank between two workspace entries keeps the card's tint, which is what
    // makes the card read as a panel rather than as three unrelated rows.
    expect(drawn.buffer.get(0, 5).bg).toBe(palette.card.bg)
    expect(palette.card.bg).not.toBe(palette.sidebar.bg)
  })

  it('the strip stops drawing when it runs out of rows rather than overflowing', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES, height: 7 })
    expect(drawn.rows).toHaveLength(7)
    expect(drawn.rows[0]?.trim()).toBe('spaces')
    // The last row is the collapse arrow's, which is drawn wherever the strip ends.
    expect(drawn.rows[6]).toContain('«')
  })
})

describe('the same design at 22 columns and at 30 (criterion 2)', () => {
  it('30 — the design width — fits the four-workspace, four-agent case whole (criterion 7)', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES, width: 30 })
    expect(DEFAULT_CONFIG.ui.sidebarWidth).toBe(30)
    // Nothing truncates: not a workspace name, not a branch, not an agent's line.
    expect(drawn.rows.join('\n')).not.toContain('…')
    for (const name of NAMES) {
      expect(drawn.row(name)).toBeGreaterThanOrEqual(0)
    }
    expect(drawn.row('blocked · codex')).toBeGreaterThanOrEqual(0)
    expect(drawn.row('feat/charts')).toBeGreaterThanOrEqual(0)
  })

  it('22 — the old width — keeps every row and loses only the label on the files button', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES, width: 22 })
    // The structure is identical; the strip is a design that narrows, not a different
    // layout below a threshold.
    expect(drawn.rows[0]?.trim()).toBe('spaces')
    expect(drawn.rows[1]).toContain('herdr')
    expect(drawn.rows[5]).toBe('')
    expect(drawn.row('web-dashboard')).toBe(6)
    // `▤ files` no longer fits between `new` and `menu`, so the word goes and the
    // button stays — which is the whole point of having a narrow form.
    expect(drawn.body[14]).toContain('▤ files')

    // It degrades at 19, where the gap between `new` and `menu` no longer holds the
    // word: the button survives as its glyph rather than disappearing.
    const narrow = draw(fourAndFour(), { summaries: SUMMARIES, width: 19 })
    expect(narrow.body[14]).toContain('▤')
    expect(narrow.body[14]).not.toContain('files')
    expect(narrow.hits.actionRow?.files).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Criterion 3 — hue is identity
// ---------------------------------------------------------------------------

describe('hue is identity (criterion 3)', () => {
  /** The foreground of the first non-blank cell of a row's body. */
  function bodyColour(drawn: Drawn, row: number): number {
    return drawn.buffer.get(6, row).fg
  }

  it('two agents in the same workspace draw that workspace’s hue, and nothing else does', () => {
    const state = snapshot([
      {
        id: 'w1',
        label: 'herdr',
        panes: [
          { agent: 'claude', status: 'working' },
          { agent: 'codex', status: 'idle' }
        ],
        tabs: 2
      },
      { id: 'w2', label: 'web-dashboard', panes: [{ agent: 'claude', status: 'idle' }] }
    ])
    const drawn = draw(state)
    const hue = workspaceHues(['w1', 'w2']).get('w1') as number

    // The workspace's own row, and both of its agents' rows.
    expect(bodyColour(drawn, drawn.row('herdr'))).toBe(hue)
    const agentRows = drawn.rows
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.index > drawn.row('agents') && entry.line.includes('herdr'))
    expect(agentRows).toHaveLength(2)
    for (const entry of agentRows) expect(bodyColour(drawn, entry.index)).toBe(hue)
  })

  it('two workspaces draw different hues', () => {
    const drawn = draw(fourAndFour())
    const seen = NAMES.map((name) =>
      bodyColour(drawn, drawn.row(name))
    )
    expect(new Set(seen).size).toBe(seen.length)
  })

  it('every workspace on screen gets a distinct hue, up to the size of the palette', () => {
    const ids = Array.from({ length: WORKSPACE_HUES.length }, (_, index) => `w-${index}`)
    const assigned = workspaceHues(ids)
    expect(new Set(assigned.values()).size).toBe(WORKSPACE_HUES.length)
  })

  it('the hue survives a restart: it is a function of the persisted id and nothing else', () => {
    // A restart rebuilds every record from `persist.ts` — new objects, new numbers,
    // the same ids. Two snapshots built that way must agree.
    const before = draw(fourAndFour())
    const after = draw(
      snapshot([
        { id: 'w1', label: 'herdr', panes: [{ agent: 'claude', status: 'idle' }] },
        { id: 'w2', label: 'web-dashboard', panes: [null] },
        { id: 'w3', label: 'explore', panes: [null] },
        { id: 'w4', label: 'data-pipeline', panes: [null] }
      ])
    )
    for (const name of NAMES) {
      expect(bodyColour(after, after.row(name))).toBe(bodyColour(before, before.row(name)))
    }
  })

  it('the hue survives a reordering of the workspace list', () => {
    const state = fourAndFour()
    const reordered: SessionStateSnapshot = {
      ...state,
      workspaceOrder: [...state.workspaceOrder].reverse()
    }
    const before = draw(state)
    const after = draw(reordered)
    expect(after.rows[1]).toContain('data-pipeline')
    for (const name of NAMES) {
      expect(bodyColour(after, after.row(name))).toBe(bodyColour(before, before.row(name)))
    }
  })

  it('none of the eight hues is the red that means blocked', () => {
    // Red is `agent-blocked`: the one colour in the program that means "this is waiting
    // on you". A workspace that hashed to it would look urgent for its whole life.
    expect(WORKSPACE_HUES).not.toContain(DEFAULT_CONFIG.theme.agentBlocked)
    expect(WORKSPACE_HUES).not.toContain(9)
  })

  it('hashId is stable and workspaceHue is its unclaimed preference', () => {
    expect(hashId('w1')).toBe(hashId('w1'))
    expect(hashId('w1')).not.toBe(hashId('w2'))
    expect(WORKSPACE_HUES).toContain(workspaceHue('w1'))
    expect(workspaceHues(['w1']).get('w1')).toBe(workspaceHue('w1'))
  })

  it('the state word is coloured by state, and the state dot is not', () => {
    const drawn = draw(fourAndFour())
    const blocked = drawn.row('blocked · codex')
    expect(drawn.buffer.get(6, blocked).fg).toBe(DEFAULT_CONFIG.theme.agentBlocked)
    // The dot above it is the workspace's hue: its *shape* is what says blocked.
    const dotRow = blocked - 1
    expect(drawn.buffer.get(4, dotRow).char).toBe('◉')
    expect(drawn.buffer.get(4, dotRow).fg).toBe(drawn.buffer.get(6, dotRow).fg)
    expect(drawn.buffer.get(4, dotRow).fg).not.toBe(DEFAULT_CONFIG.theme.agentBlocked)
  })
})

// ---------------------------------------------------------------------------
// Criterion 4 — every hit region still resolves
// ---------------------------------------------------------------------------

describe('every hit region still resolves (criterion 4)', () => {
  const state = fourAndFour()
  const drawn = draw(state, { summaries: SUMMARIES })
  const hits = drawn.hits

  it('a workspace row hits its workspace — including its branch line', () => {
    expect(hits.workspaceRows.get(drawn.row('herdr'))).toBe('w1')
    expect(hits.workspaceRows.get(drawn.row('main ↑1'))).toBe('w1')
    expect(hits.workspaceRows.get(drawn.row('web-dashboard'))).toBe('w2')
    expect(hits.workspaceRows.get(drawn.row('data-pipeline'))).toBe('w4')
  })

  it('a tab row hits its tab, and only the active workspace has any', () => {
    expect(hits.sidebarTabRows.get(drawn.row('› 1'))).toBe('w1-t1')
    expect([...hits.sidebarTabRows.values()]).toEqual(['w1-t1', 'w1-t2'])
  })

  it('an agent row hits its pane and its workspace, on both of its lines', () => {
    // Worst state first, so the blocked agent in `explore` is the card's first entry
    // however far down the workspace list it lives.
    const first = drawn.row('agents') + 1
    expect(drawn.rows[first]).toContain('explore')
    expect(hits.agentRows.get(first)).toEqual({ paneId: 'p4', workspaceId: 'w3' })
    expect(hits.agentRows.get(first + 1)).toEqual({ paneId: 'p4', workspaceId: 'w3' })
  })

  it('the close `x` hits the workspace whose row it is on', () => {
    const hovered = draw(state, { summaries: SUMMARIES, hoverRow: 6 })
    const span = hovered.hits.workspaceCloseSpans.find((entry) => entry.y === 6)
    expect(span?.workspaceId).toBe('w2')
    // The span covers the `x` that was actually drawn, and not the count beside it.
    expect(hovered.buffer.get(span?.end as number, 6).char).toBe(' ')
    expect(hovered.buffer.rowText(6).slice((span?.x as number) + 1, span?.end)).toBe('x')
  })

  it('`new`, `▤ files` and `menu` are three targets on the action row', () => {
    const action = hits.actionRow
    expect(action).not.toBeNull()
    expect(drawn.body[action?.row as number]).toContain('+ new')
    expect(hits.newWorkspaceRow).toBe(action?.row)
    const files = action?.files
    expect(files).not.toBeNull()
    // Each target resolves to itself, in the order the click handler checks them.
    expect(drawn.body[action?.row as number].slice(files?.x, files?.end)).toBe('▤ files')
    expect(drawn.body[action?.row as number].slice(action?.menuStart)).toBe('menu')
    expect((action?.menuStart as number) > (files?.end as number)).toBe(true)
    expect((files?.x as number) >= (action?.newEnd as number)).toBe(true)
  })

  it('the collapse arrow is on the bottom row, on the edge it collapses towards', () => {
    expect(hits.collapse).toEqual({ x: 28, end: 30, y: 29 })
    expect(drawn.rows[29]).toContain('«')
    const right = draw(state, { dockRight: true })
    expect(right.hits.collapse).toEqual({ x: 0, end: 2, y: 29 })
    expect(right.rows[29]).toContain('»')
  })

  it('the resize grip is three cells on the inner edge, and moves with the dock', () => {
    expect(hits.grips.map((grip) => grip.x)).toEqual([29, 29, 29])
    expect(hits.grips.every((grip) => grip.kind === 'sidebar')).toBe(true)
    expect(draw(state, { dockRight: true }).hits.grips.map((grip) => grip.x)).toEqual([0, 0, 0])
  })
})

// ---------------------------------------------------------------------------
// Criterion 5 — chrome appears when it is relevant
// ---------------------------------------------------------------------------

describe('the pane count and the `x` are hover chrome (criterion 5)', () => {
  it('absent from an unhovered row, present on the hovered one', () => {
    const state = fourAndFour()
    const cold = draw(state, { summaries: SUMMARIES })
    expect(cold.body[6]).toBe('  2 ○ web-dashboard')
    expect(cold.hits.workspaceCloseSpans).toHaveLength(0)

    const warm = draw(state, { summaries: SUMMARIES, hoverRow: 6 })
    expect(warm.body[6]).toBe('  2 ○ web-dashboard       1 x')
    // Only that row. This is the difference the phase is about: one row of chrome
    // instead of a column of it.
    expect(warm.body[1]).toBe('▌ 1 ● herdr')
    expect(warm.hits.workspaceCloseSpans.map((span) => span.y)).toEqual([6])
  })

  it('the last workspace has a count but no `x`, because closing it would quit', () => {
    const drawn = draw(snapshot([{ id: 'w1', label: 'solo', panes: [null] }]), { hoverRow: 1 })
    expect(drawn.rows[1]).toContain('1')
    expect(drawn.rows[1]).not.toContain(' x')
    expect(drawn.hits.workspaceCloseSpans).toHaveLength(0)
  })

  it('with hover turned off the chrome falls back to the active row rather than vanishing', () => {
    // `[general] mouse-hover = false` means `hoverRow` is -1 forever. Without this the
    // close target would simply not exist for anyone who turned hover off.
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES, hoverEnabled: false, hoverRow: -1 })
    expect(drawn.body[1]).toBe('▌ 1 ● herdr               2 x')
    expect(drawn.hits.workspaceCloseSpans.map((span) => span.workspaceId)).toEqual(['w1'])
  })

  it('the workspace number stays on every row: it is a key you can press', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES })
    expect(drawn.body[1]?.slice(0, 4)).toBe('▌ 1 ')
    expect(drawn.body[6]?.slice(0, 4)).toBe('  2 ')
    expect(drawn.body[9]?.slice(0, 4)).toBe('  3 ')
  })
})

// ---------------------------------------------------------------------------
// Criterion 6 — weight, all the way to the bytes
// ---------------------------------------------------------------------------

describe('bold and dim reach the terminal (criterion 6)', () => {
  /** What the encoder would actually write for this frame. */
  function bytes(drawn: Drawn): string {
    return encodeFrame(drawn.buffer, diffBuffers(null, drawn.buffer))
  }

  it('the style object carries them', () => {
    const drawn = draw(fourAndFour(), { summaries: SUMMARIES })
    // Bold on a workspace name, dim on the branch under it and on the header above.
    expect(drawn.buffer.get(6, 1).attrs & ATTR_BOLD).toBe(ATTR_BOLD)
    expect(drawn.buffer.get(6, 2).attrs & ATTR_DIM).toBe(ATTR_DIM)
    expect(drawn.buffer.get(1, 0).attrs & ATTR_DIM).toBe(ATTR_DIM)
    // And the number in the gutter, which is subordinate to the name beside it.
    expect(drawn.buffer.get(2, 1).attrs & ATTR_DIM).toBe(ATTR_DIM)
  })

  it('and the writer emits SGR 1 and SGR 2 for them', () => {
    // Asserted at the ANSI writer and not at the style object, because an attribute
    // that never leaves the buffer is a hierarchy nobody can see.
    const written = bytes(draw(fourAndFour(), { summaries: SUMMARIES }))
    expect(written).toMatch(/\x1b\[(?:[\d;]*;)?1(?:;[\d;]*)?m/u)
    expect(written).toMatch(/\x1b\[(?:[\d;]*;)?2(?:;[\d;]*)?m/u)
  })

  it('a strip with no weight in it emits neither, so the test above is measuring something', () => {
    const blank = new ScreenBuffer(30, 4)
    blank.fill({ x: 0, y: 0, width: 30, height: 4 }, ' ', palette.card)
    const written = encodeFrame(blank, diffBuffers(null, blank))
    expect(written).not.toMatch(/\x1b\[(?:[\d;]*;)?1(?:;[\d;]*)?m/u)
    expect(written).not.toMatch(/\x1b\[(?:[\d;]*;)?2(?:;[\d;]*)?m/u)
  })
})

// ---------------------------------------------------------------------------
// Criterion 8 — the border sets
// ---------------------------------------------------------------------------

describe('pane borders (criterion 8)', () => {
  function corners(chars: typeof PLAIN_BORDER): string {
    const buffer = new ScreenBuffer(6, 3)
    renderBlock(buffer, { x: 0, y: 0, width: 6, height: 3 }, { chars })
    return `${buffer.get(0, 0).char}${buffer.get(5, 0).char}${buffer.get(0, 2).char}${buffer.get(5, 2).char}`
  }

  it('`round` renders ╭╮╰╯', () => {
    expect(corners(ROUND_BORDER)).toBe('╭╮╰╯')
  })

  it('the existing sets still render what they rendered', () => {
    expect(corners(PLAIN_BORDER)).toBe('┌┐└┘')
    expect(corners(HEAVY_BORDER)).toBe('┏┓┗┛')
    expect(corners(ASCII_BORDER)).toBe('++++')
  })

  it('`ui.pane-borders` takes the new name and still takes the old booleans', () => {
    expect(DEFAULT_CONFIG.ui.paneBorders).toBe('round')
    expect(validateConfig({ ui: { 'pane-borders': 'round' } })).toMatchObject({
      config: { ui: { paneBorders: 'round' } },
      problems: []
    })
    // `true` is what it always was: the square set. Nobody's config file changes meaning.
    expect(validateConfig({ ui: { 'pane-borders': true } })).toMatchObject({
      config: { ui: { paneBorders: 'plain' } },
      problems: []
    })
    expect(validateConfig({ ui: { 'pane-borders': false } })).toMatchObject({
      config: { ui: { paneBorders: 'off' } },
      problems: []
    })
  })

  it('a value that is neither says what it could have been', () => {
    const { config, problems } = validateConfig({ ui: { 'pane-borders': 'curvy' } })
    expect(problems[0]).toMatchObject({ kind: 'bad-value', path: 'ui.pane-borders' })
    expect(problems[0]?.message).toContain('"round"')
    expect(config.ui.paneBorders).toBe(DEFAULT_CONFIG.ui.paneBorders)
  })
})
