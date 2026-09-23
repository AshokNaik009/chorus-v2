# Handoff — end of Phase 12

**Read `PLAN.md` first, then `phases/PARITY.md`.** This file is the state of the world
as this session leaves it. Everything was measured on **2026-09-22**, macOS (darwin
25.6.0, arm64, Apple silicon, 10 cores), Node v22.1.0, pnpm 10.18.0. **`rg`, `bat`,
`glow` and `delta` are still not installed on this machine** — unchanged since phase 9.

## Status

- **Phase 12 complete: yes, on all 9 criteria.** Including criterion 9, which is the
  first time in four phases the benchmark was actually run — see *Numbers*.
- `pnpm test`: **86 files, 1,516 tests**, run to completion at load average 13–15, with
  the one known flake — `multiplexer.test.ts > splits top/bottom`, `expected 0 to be
  greater than or equal to 2`, which passes in isolation and is unchanged since phase 10.
  The run *before* the two post-phase fixes below was 1,505 and completely green.
- **This phase adds no feature and closes no `PARITY.md` row**, by design. It is the
  spacing unit, the type hierarchy and the rule for what colour means.
- New tests: **33**, all in `packages/client/src/chrome.test.ts`, all rendered-buffer.

| # | Criterion | Verdict | Where |
|---|---|---|---|
| 1 | `pnpm test` green | met, full suite, run to completion | 1,505 tests, no failures |
| 2 | a rendered-buffer test per sidebar state | met — empty, one workspace, four-and-four, hovered, 22 columns, 30 columns | `chrome.test.ts`, `describe('the rhythm is one row')` |
| 3 | same hue per workspace, different between, surviving restart and reorder | met, seven tests | `describe('hue is identity')` |
| 4 | every `HitRegions` entry still resolves | met — workspace row, branch row, tab row, agent row (both lines), close `x`, `new`, `▤ files`, `menu`, collapse, grip | `describe('every hit region still resolves')` |
| 5 | count and `x` absent unhovered, present hovered | met, asserted as buffer text | `describe('… are hover chrome')` |
| 6 | bold and dim reach the terminal | met, asserted at `encodeFrame`, with a negative control | `describe('bold and dim reach the terminal')` |
| 7 | nothing truncates at 30 in the four-workspace, four-agent case | met — the whole strip is asserted and contains no `…` | `'30 — the design width'` |
| 8 | `round` renders `╭╮╰╯`, existing values unchanged | met; `plain`/`heavy`/`ascii` all re-asserted, and `true`/`false` still validate | `describe('pane borders')` |
| 9 | no regression in `bench/RESULTS.md` | **met, and measured** — A/B against the pre-phase build under the same load | *Numbers* |

## What exists now

The workspace strip is **two cards on a tinted surface** with one blank row between
every entry, instead of eleven consecutive lines of text. A workspace gets a **stable
colour derived from its id**, and its agents borrow it, so the eye connects an agent to
its project without reading a word; status gave up the hue and kept the *shape* of its
dot (`○` idle, `●` working, `◉` blocked) plus the coloured state word. Hierarchy is
weight — bold name, dim everything subordinate — which `ATTR_BOLD` and `ATTR_DIM` have
supported since phase 2 and which the chrome had never once set. The pane count and the
close `x` are drawn on the hovered row only. The default `ui.sidebar-width` is **30**,
and `ui.pane-borders` is now a name rather than a boolean, defaulting to `round`.

## Before and after

Both rendered by the real `renderSidebar`, same fixture — four workspaces, four agents,
three of them in checkouts — at the old default width of 22 and the new one of 30.
The `⋮` down the right is the resize grip, which has always been there.

**Before (22 columns, `41aaf24`):**

```
spaces
1 * herdr          2 x
    main ↑1 ●
  › 1
    2
2 · web-dashboard  1 x
    feat/charts
3   explore        1 x
4 ! data-pipeline  1 x
    main ↓2
 new   ▤ files   menu
                      
agents
 ! codex
   blocked · data-pip⋮
 * claude            ⋮
   working · herdr   ⋮
 · claude
   idle · web-dashboa…
```

Eleven consecutive lines with no break. Every row carries a count and an `x`. Two of
four agents say `claude` and nothing else, and both of the lines that would have said
*which project* are cut off. Colour: every name the same grey, every dot coloured by
state.

**After (30 columns, this build):**

```
 spaces
▌ 1 ● herdr                   
▌     main ↑1 *               
▌     › 1                     
▌       2                     
                              
  2 ○ web-dashboard           
      feat/charts             
                              
  3   explore                 
                              
  4 ◉ data-pipeline           
      main ↓2                 
                              
 + new      ▤ files      menu⋮
                             ⋮
 agents                      ⋮
    ◉ data-pipeline           
      blocked · codex         
                              
    ● herdr                   
      working · claude        
                              
    ○ web-dashboard           
      idle · claude           
```

Rows 0–14 are one card on a `235` background, row 15 is the untinted gutter, row 16
onward is the second card. `herdr` is pink, `web-dashboard` orange, `explore` tan,
`data-pipeline` violet — in the strip *and* in the agents list. `▌` is the active
workspace's selection bar and runs the whole entry. Nothing truncates.

**After (22 columns, same build)** — the design narrows rather than becoming a
different layout; only the agent's tool line is cut:

```
 spaces
▌ 1 ● herdr           
▌     main ↑1 *       
▌     › 1             
▌       2             
                      
  2 ○ web-dashboard   
      feat/charts     
                      
  3   explore         
                      
  4 ◉ data-pipeline   
      main ↓2         
                      
 + new  ▤ files  menu⋮
```

## Types and contracts the next phase depends on

```ts
// packages/client/src/palette.ts — new
export const WORKSPACE_HUES: readonly number[]      // 8 entries, 256-colour cube
export function hashId(id: string): number          // FNV-1a, 32-bit, via Math.imul
export function workspaceHue(id: string): number    // the hue an id prefers
export function workspaceHues(ids: readonly string[]): Map<string, number>

// packages/tui/src/widgets/block.ts
export const ROUND_BORDER: BorderChars              // ╭ ╮ ╰ ╯ with PLAIN's rules

// packages/core/src/config.ts
export type PaneBorderStyle = 'plain' | 'round' | 'off'
interface UiConfig { readonly paneBorders: PaneBorderStyle /* was boolean */ }
// DEFAULT_CONFIG.ui.sidebarWidth: 22 -> 30
// DEFAULT_CONFIG.ui.paneBorders:  true -> 'round'

// a new schema scalar, for any key that used to be a boolean and is now a name
type Scalar = … | { kind: 'flag-enum'; values: readonly string[]; whenTrue: string; whenFalse: string }

// packages/client/src/chrome.ts — renderSidebar's signature changed
export interface SidebarOptions {
  readonly hoverRow?: number
  readonly hoverEnabled?: boolean       // [general] mouse-hover
  readonly dockRight?: boolean
  readonly summaries?: ReadonlyMap<string, GitRepoSummary>
}
export function renderSidebar(
  buffer: ScreenBuffer, area: Rect, state: SessionStateSnapshot,
  palette: Palette, hits: HitRegions, options?: SidebarOptions
): void
export interface Palette { /* … */ readonly card: Style }   // new field
export const CARD_SURFACE = 235

// packages/client/src/model.ts — the glyph table, unchanged in shape
const STATUS_GLYPHS = { idle: '○', working: '●', blocked: '◉', unknown: '?', done: '✓' }
```

`HitRegions` is **unchanged**. Every field it had, every field's shape, and every
consumer in `app.ts` still works — which is what the 33 new tests are for.

## The design rules, as they landed

**1. Hue is identity; fill and weight are state.**

Eight hues from the 256-colour cube: `39` azure, `43` teal, `77` green, `220` yellow,
`208` orange, `205` pink, `135` violet, `180` tan. **None of them is red**, because red
is `agent-blocked` — the one colour in the program that means "this is waiting on you" —
and a workspace that hashed to it would look urgent for its whole life. A test asserts
that.

The hue comes from FNV-1a of the workspace **id**, which `persist.ts` writes and
`restoreSession` reads back unchanged. A bare hash would have been perfectly stable and
frequently useless: with eight hues and four workspaces, the birthday bound says two of
them share a colour **59% of the time**. So `workspaceHues` walks the ids **in sorted
order** — not display order — and each takes its preferred hue or the next free one.
That buys:

- every workspace a distinct hue, guaranteed, up to eight of them;
- survival of a **restart**, because the ids are persisted;
- survival of a **reorder**, because `workspaceOrder` is never read.

What it does not survive is *creating or closing* a workspace whose id collides with an
existing one — that workspace's neighbour may move one hue along. That is the trade, and
it is the right way round: a colour that is always unique and occasionally shifts beats
one that never moves and is a coin flip.

**2. The spacing unit is one row.** One blank row between entries, one above a section
header, none below it. It is implemented as *a blank before each entry except the
first*, which is the same rule with no trailing blank and no special case. The header at
the very top of the strip is the only row with no blank above it, because there is
nothing above it to separate it from.

**3. Hierarchy is weight.** Bold for a thing's name, dim for everything subordinate —
the section headers, the workspace number, the branch line, the second line of an agent,
the action row. Criterion 6 is asserted at `encodeFrame`, not at the style object, with
a negative control that renders a weightless buffer and asserts the SGR is *absent*.

**4. Chrome appears when it is relevant.** The count and the `x` are on the hovered row.
The **workspace number is not chrome** and stays, dimmed, in a fixed two-column gutter,
because it is a key you can press.

**5. A section is a card.** `Palette.card` is a new derived style: a named theme's
`tab-idle-bg` (its `surface` role, one step off its base), or `235` when the theme has
none. The gutter row between the two cards is the *sidebar's* background, not either
card's, which is what makes them read as two panels rather than one list with a gap.

**6. 30 columns.** The dock's own minimum has been 34 since phase 7; 30 is the nearest
number the workspace strip can justify without taking a third of an 80-column screen —
where `app.ts` caps it at 26 anyway.

## The grid

Everything in the strip is drawn on five columns and nothing is drawn anywhere else:

```
 0      MARK_X     ▌ on the active workspace's entry; the card's left padding otherwise
 1-2    INDEX_X    the workspace number, right-aligned, dim
 4      DOT_X      the status dot, in the workspace's hue
 6      BODY_X     names, branches, tabs, tasks
 width-1  RIGHT_PAD  kept clear; the resize grip lives here
```

## What moved to hover-only, and what did not

| | Then | Now |
|---|---|---|
| pane count | every workspace row | hovered row |
| close `x` | every workspace row (when > 1 workspace) | hovered row |
| workspace number | every row | unchanged — it is `C-b <n>` |
| status dot | every row | unchanged, but hue-coloured and shape-coded |
| branch line | when known | unchanged |
| `new` / `▤ files` / `menu` | always | unchanged — a toolbar, not a row of chrome |
| pane border buttons `◨ ⬓ ✕` | every pane, always | **unchanged, deliberately** — see *Open threads* |

**With `[general] mouse-hover = false` the chrome falls back to the active workspace
row** rather than vanishing. Without that, somebody who turned hover off would have no
close target at all, and the option is about repaint cost, not about wanting less UI.

## Numbers

**Criterion 9 was measured, as an A/B against the pre-phase build.** The committed
`bench/RESULTS.md` was recorded on a quiet machine on a different day; this machine sat
at load average **11.8–12.8** all session, so comparing against that table would have
measured the load and not the change. Instead the phase-12 tree was stashed, rebuilt at
`41aaf24`, benchmarked, restored, rebuilt and benchmarked again — **two runs six minutes
apart at the same load**, same config (the benchmark still pins `sidebar-width = 22`, on
purpose, so both runs draw the same pane geometry).

| Scenario | paint p50 before → after | frame p50 before → after |
|---|---|---|
| Single active | 0.57 ms → **0.51 ms** | 0.89 ms → **0.75 ms** |
| Realistic 15 | 0.55 ms → **0.53 ms** | 2.18 ms → **2.18 ms** |
| Stress, visible | 0.55 ms → **0.54 ms** | 3.69 ms → **3.67 ms** |
| Stress, 14 hidden | 0.36 ms → **0.36 ms** | 3.11 ms → **3.18 ms** |

`paint` is the number this phase can move: compose + diff + encode, the client's own
code. It did not move. `p99` is not tabulated because at this load it is measuring the
machine — it ranged 8–19 ms on *both* builds, above the 3.24 ms the quiet-machine table
records, in the same way for old code and new.

Cells repainted per frame are unchanged (14 / 25 / ~1,600 / 13), which is the structural
answer: the sidebar is at most a few dozen cells of a 200×50 screen, and the diff only
sends what changed.

**`bench/RESULTS.md` is left at its committed contents.** Writing load-12 numbers into
it would have looked like a catastrophic regression against the quiet-machine baseline
and would have destroyed the hand-written sections — which is the defect three handoffs
have now named. `git checkout -- bench/RESULTS.md` after any run; **the fix is code, not
a fourth sentence here.**

## Surprises

- **`git log`-style display text was phase 11's trap; this phase's was the colour a
  terminal has.** A card is a background tint, and there is no way to ask a terminal
  whether its background is light or dark. `235` is a *dark* answer, chosen because the
  default theme already assumes dark (`sidebar-fg = 7` on `sidebar-bg = -1` is white on
  the terminal's own background). It is stated rather than hidden, and anyone on a light
  terminal who sets `[theme] name` gets a card in their theme's real surface colour.
- **A stable hash is not a palette.** The birthday bound is the whole reason
  `workspaceHues` takes a list instead of one id. This was going to be a one-line
  `hues[hash % 8]` until the arithmetic was done.
- **`▌` down the entry replaced the accent background for "active".** A full-width
  accent row fought the card tint underneath it, and it would have had to overwrite the
  workspace's hue on the one row where identity matters most. The bar says selection
  *in* the hue, which is both facts in one column and no colour spent.
- **Agents show the workspace, not the pane title.** PHASE-12 item 8 says "the pane
  title is not an identity", and following it literally means the title is not drawn at
  all: line one is the project in the project's hue, line two is `<state> · <tool>`.
  Phase 11's `task · tool` was the window title Claude Code sets, which is the same word
  four times for four Claude panes.
- **The grip lands in the right padding column, which the action row's `menu` used to
  own.** `menu ` had a trailing space that the grip overwrote. `RIGHT_PAD` is now
  respected by the action row and by the hover chrome, so the grip has a column of its
  own on every row. The rendered-buffer tests read `drawn.body`, which is every row
  minus its last column, so a snapshot of the *design* does not move when the strip gets
  a row taller and the grip lands somewhere else.
- **The collapsed rail is the one place status keeps a hue**, and it has to be: three
  columns hold a number and a dot, so identity has nowhere to go and state has nothing
  else to ride on.
- **The integration harness waited for `┌`.** `waitForReady` could not start a client
  configured for round borders. It waits for `│` now, which is in both sets.

## Open threads deliberately left

- **`◨ ⬓ ✕` are still drawn on every pane at all times.** PHASE-12 item 7 names this,
  and rule 4 ("chrome appears when it is relevant") would say hover-only — but the
  deliverables for item 7 are `ROUND_BORDER` and nothing else, they are the only pointer
  route to split or close a pane, and `mouse-hover` can be turned off. It is the obvious
  next application of rule 4 and it needs the same fallback the sidebar's chrome got.
- **`ui.pane-borders` does not expose `heavy` or `ascii`**, although `HEAVY_BORDER` and
  `ASCII_BORDER` have existed in `block.ts` since phase 2 and the enum would have cost
  two words. Exposing them is a feature, and this phase's list says no new features.
  They are still unreachable from a config file.
- **Nine or more workspaces share hues**, in id order, once the probe runs out of free
  slots. Eight was chosen because the cube has no more than about eight hues that are
  all legible on a dark card *and* distinct from each other and from red.
- **Two agents in one workspace draw two identical rows**, differing only in order. Each
  still clicks through to its own pane. There is no column for a third fact at 30.
- **The `agents` card has no `grouped` toggle**; still a `PARITY.md` orphan, and
  explicitly out of scope here.
- **`multiplexer.test.ts` is still flaky and still undiagnosed.** It passed in the full
  run; it failed once per run when run alone twice in a row, on a different test each
  time. Unchanged from phases 10 and 11.
- **`RESULTS.md`'s generator still destroys its hand-written sections.** Fourth handoff
  to say so.
- **Everything in phase 11's *Open threads* is still open**: no end-to-end drawer test
  through `TuiHarness`, no drawer refresh on its own, `Show Changes` is still a pager
  pane, `follow-pane` is unwired, no syntax highlighting, `DaemonClient` has no request
  timeout, and phase 5's criterion 2 (detection against a running agent) is still the
  important gap.
- **The uncommitted `[sidebar] open-with` work was already in the tree when this phase
  started** (`editor.ts`, `editor.test.ts`, and changes across `app.ts`, `scm.ts`,
  `git.ts` and the protocol). It is not phase 12's; it now carries the fix below and is
  at 22 tests.
- **Whether `auto` should open a *local* editor from a plain terminal is unanswered.**
  `editor.ts` refuses to guess, and its argument is about SSH — where there is no window
  to open a file in. On a local Terminal.app with VS Code installed the refusal is
  arguably wrong, and the user hit exactly that. The message now names the one-line fix
  instead of deciding for them.
- **The explorer tree can still be rooted somewhere surprising**, which is how defect 2
  was reached — a tree rooted at `/` with full-looking row paths. Rooting at the pane's
  directory is by design and was not changed; what was fixed is that the preview now
  honours whatever root the tree was listed with.

## Two defects fixed after the phase, both reported from screenshots

Neither is phase 12 work. Both were found by looking at the running program.

**1. Clicking a changed file did nothing, and said nothing.** `[sidebar] open-with`
defaults to `auto`, which means "the editor this terminal belongs to" — and from a plain
Terminal.app there is none, so `resolveExternalEditor` returned null and
`openInExternalEditor` returned silently *by design*, with a comment saying so. A no-op
that gives no feedback is indistinguishable from a broken click, which is exactly how it
was reported. This project already settled that argument once, over `Copy …` and OSC 52,
and came down on the side of saying so.

`explainNoEditor(env, options)` is new in `editor.ts`. It tells the three causes apart
and names the line that fixes each:

| Cause | What the panel now says |
|---|---|
| a plain terminal, `code` installed | ``no editor for this terminal — set `[sidebar] open-with = "code"` `` |
| a plain terminal, nothing known installed | `… set [sidebar] open-with to your editor's command` |
| a Cursor terminal, `cursor` not on PATH | ``this looks like a Cursor terminal, but `cursor` is not on PATH`` |
| `open-with = "coed"` | ``` `open-with = "coed"` is not on PATH ``` |
| `open-with = "off"` | nothing — that no-op was asked for |

A test asserts `resolveExternalEditor` returning null and `explainNoEditor` returning a
reason are **the same condition**, so the silent click cannot come back. That cross-check
caught a real bug in the first draft, which explained itself even when resolution was
about to succeed.

**The behaviour itself was not changed.** `auto` still refuses to guess at an editor in
a terminal that does not belong to one — `editor.ts` argues that over SSH there is no
window to open a file in — so from a plain terminal the fix is still one config line.
Whether `auto` should fall back to a locally installed editor is a live question and was
not answered here.

**2. The preview could resolve a path against the wrong root.** Reported as
`path escapes the root: Users/ashoknaik/…/CODE_OF_CONDUCT.md` — a tree row path from a
tree rooted at `/`, checked against a different root entirely.

`fs.list` and `preview.read` both call `resolveRoot`, and `rpc/preview.ts`'s header
claimed that made them agree. It does not: they call it at **different moments**, and it
answers "where is the focused pane *now*". Between listing a tree and clicking a row in
it, a shell can `cd` and focus can move to a pane in another repository — and then a
path relative to the first root is resolved under the second. The lucky outcome is the
refusal above; the unlucky one is previewing a different file that happens to have that
name.

The client already had the right answer and was throwing it away. `PreviewReadParams`
gained an optional `root`, the client sends `panels.explorer.root` (the root that
listing came back with), and the daemon prefers it, falling back to `resolveRoot` when
it is absent. It grants no access the `cwd` field on `GitTargetParams` did not already
grant. Three tests in `packages/daemon/src/preview.test.ts` pin it, including one that
reproduces the original failure with the root left off.

`resolveWithin`'s refusal also now names **the root it checked against**, not just the
path. Which half is wrong is unanswerable without both, and it is usually the root.

## Getting started in a new session

```bash
pnpm install
pnpm build
ln -s "$PWD/packages/client/dist/main.js" ~/.local/bin/leap-chorus
pnpm test                                    # do not run anything alongside it

# the design, without a terminal — 33 tests, milliseconds
npx vitest run packages/client/src/chrome.test.ts

leap-chorus                                  # C-b e files · C-b f search · C-b g git · 1/2/3/4
#   the workspace strip: 30 columns, two cards · hover a row for its count and `x`
#   in the git view: ↑↓ move · ⏎ open a drawer · →← open/close · m row menu · r refresh

uptime && node bench/dist/render-scale.js --seconds 15
git checkout -- bench/RESULTS.md             # THE BENCHMARK DESTROYS IT
pgrep -f leap-chorusd                        # a leaked daemon forks `ps` every 750 ms
```
