# Phase 12 — The chrome, as a designed surface

**Read `../PLAN.md`, `PARITY.md` and `../HANDOFF.md` first.**

## Why this phase exists

Every phase so far asked *does it work*. `PARITY.md` scores features, and by the end of
phase 11 the Source Control section has no red left in it. Put our sidebar next to
herdr's and the port still looks like a different class of program — and **not one row
of `PARITY.md` explains why**, because nothing in it measures what a surface looks like
when it is all drawn at once.

That is the hole. The chrome was built one row at a time across five phases: phase 2
added workspace rows, phase 5 added the agents section, phase 9 added the footer, phase
11 added a branch line and an action button. Each was reasonable alone. Nobody ever set
a **rhythm** — a spacing unit, a type hierarchy, a rule for what colour means — so the
result is eight decisions by eight authors stacked in one column. It reads as dense,
noisy and unconsidered, because it is.

**This phase is about the six pixels of vertical padding and what colour means.** It
adds no feature and closes no parity row.

## Source material, and one honest caveat

Measured **2026-09-22** from two screenshots, side by side: herdr's rendering and ours
at the same task (three-plus workspaces, several agents, panes running Claude Code).

**The herdr image is a website hero mock.** The conversation *inside* its own centre
pane says so — "make the herdr.dev hero mock look exactly like real claude code" — and
it has no status bar, no truncation anywhere, and a caption in prose underneath. So it
is a target for **direction**, not a pixel reference, and any criterion below that reads
"identical to the screenshot" would be a criterion nobody can meet. What is portable is
the *system*: the spacing, the hierarchy, the colour semantics. Those are visible and
unambiguous, and they are what we do not have.

## The diagnosis, itemised

Eight differences, in the order they cost the most.

### 1. Colour means the wrong thing

**herdr: hue is identity, fill is state.** `herdr` is yellow in `spaces` *and* yellow in
`agents`; `web-dashboard` is pink in both. The eye connects the agent to its project
without reading a word. State is carried by the dot's *fill* — hollow idle, solid
working, ringed blocked — and by the state word itself, which is coloured to match.

**Ours: hue is state, and identity has no channel at all.** Every workspace is the same
grey; every agent's dot is coloured by status. So a list of four agents gives no way to
tell which project any of them is in without reading the dim second line, and the one
question the list exists to answer — *which of my things needs me* — is answered by the
same colour on every row.

This is the single largest difference and it is worth fixing first because it costs
almost nothing: a stable hue per workspace, derived from its id, reused by the agent
rows.

### 2. There is no vertical rhythm

herdr puts a blank row between entries and pads its section headers top and bottom. Ours
has no blank rows anywhere: `spaces` sits directly on workspace 1, which sits directly
on workspace 2. Eleven consecutive lines of text with no break is why ours reads as a
log and herdr's reads as a list.

### 3. Sections are lists; they should be cards

herdr's `spaces` and `agents` are two panels with their own inset background, separated
by a gutter. Ours are two headings in one undifferentiated column. The card is what
makes the blank space below `data-pipeline` read as *the end of the list* rather than as
the screen having run out of content.

### 4. We have bold and dim and never use them

`ATTR_BOLD` and `ATTR_DIM` exist in `packages/tui/src/ansi.ts` and are emitted correctly
by the writer. **The chrome sets neither, anywhere.** herdr's hierarchy is entirely
weight: bold name, dim subtitle, dim section header. Ours tries to do the same job with
colour alone, which is why the second line does not recede.

### 5. The row carries three pieces of chrome nobody looks at

Ours: `1   workspace 1     1 x` — an index, a pane count, a close button, on every row,
always. herdr: `herdr` and its branch. The count and the `x` are *occasionally* useful
and *permanently* present, which is the worst trade in a 24-column strip. The index is
load-bearing — `C-b 1` — and the other two are not.

### 6. The sidebar is too narrow to hold a design

Default `ui.sidebarWidth` is **22**. herdr's is roughly 45. At 22, `workspace 1` plus a
count plus an `x` is already full, `Claude Co…` truncates in the agents list, and there
is no room for the indent that would make a two-line entry read as one entry. Every
other problem here is harder at 22 columns.

### 7. Pane borders are square, and their titles are crowded

herdr: rounded corners, the title inset in the top rule, nothing else on the border.
Ours: square corners, `cla` truncated to three characters, and `◧ ⬓ ✕` jammed against the
right corner on every pane at all times. `packages/tui/src/widgets/block.ts` already has
`PLAIN_BORDER` / `HEAVY_BORDER` / `ASCII_BORDER` and no rounded set.

### 8. The agents list shows the tool where the task should be

Ours draws `✱ Claude Co…` — the window title Claude Code sets — so four Claude panes are
four identical rows. herdr shows the *workspace* as the identity (`herdr`, `explore`,
`web-dashboard`) and puts the tool in the dim line. Phase 11 moved halfway to this and
stopped at the pane title; the pane title is not an identity.

## The design rules this phase sets

These are the decisions. Everything in *Deliverables* is a consequence of one of them.

1. **Hue is identity. Fill and weight are state.** A workspace gets a stable colour from
   a small palette, chosen by hashing its id so it survives a restart and a reorder. Its
   agents borrow it. Status stops owning hue and keeps the glyph plus the coloured state
   *word*.
2. **The spacing unit is one row.** One blank row between entries, one above a section
   header, none below it. No exceptions, because an exception is how a rhythm ends.
3. **Hierarchy is weight, not colour.** Bold for the thing's name; dim for everything
   subordinate; colour reserved for identity and state.
4. **Chrome appears when it is relevant.** The pane count and the `x` are drawn on the
   hovered row only — hover already exists (`hoverRow`, `trackHover`). The workspace
   index stays, dimmed, in a fixed left gutter, because it is a key you can press.
5. **A section is a card**: its own background tint, one column of padding on each side,
   a gutter between cards.
6. **34 columns is the design width.** `MIN_SCM_WIDTH` is already 34 and every dock view
   is built for it; the workspace strip should not be a different, narrower thing. The
   default moves 22 → 30 and the strip is designed against 30.

## Deliverables

```
packages/tui/src/widgets/block.ts    # ROUND_BORDER, and `ui.pane-borders = "round"`
packages/client/src/palette.ts       # workspaceHue(): the identity palette + hashing
packages/client/src/chrome.ts        # the rewrite: cards, rhythm, weight, hover chrome
packages/core/src/config.ts          # sidebarWidth 22 → 30; pane-borders gains "round"
packages/client/src/chrome.test.ts   # a rendered-buffer snapshot per state
```

**`chrome.ts` is a rewrite of `renderSidebar`, not a patch.** It is ~200 lines that grew
by accretion and the whole point of this phase is that accretion is the defect. The hit
regions it records are load-bearing and every one of them has to survive — which is what
the test file is for.

**Render into a buffer and assert on the text.** `peek.mjs`-style: build a fake
`SessionStateSnapshot`, render, read the rows back as strings. It is the only way to
test a design, it runs in milliseconds, and phase 11 proved the shape works — every
sidebar defect in phase 11 was found by eye and would have been caught by one of these.

## Do NOT do in this phase

- **No new features.** Not the `grouped` toggle, not hover actions, not a tabbed preview
  header. Those are `PARITY.md` orphans and they are not this.
- **No new colour configuration.** The identity palette is derived, not configured. A
  `[theme]` key per workspace is a settings page nobody asked for.
- **No truecolor.** The palette is the 256-colour cube, as everything else here is.
- **No Nerd Font glyphs.** `icons.ts` settled this: Private Use Area code points have no
  assigned width and shift every hit region on the row.
- **Do not touch the pane renderer.** Borders are chrome; what is inside a pane is the
  emulator's and is measured in `bench/RESULTS.md`.

## Acceptance criteria

1. `pnpm test` green.
2. A rendered-buffer test per sidebar state — empty, one workspace, four workspaces with
   agents, a hovered row, 22 columns, 30 columns — asserting the text and the blank
   rows, so the rhythm is a fact and not an opinion.
3. Two agents in the same workspace draw the same hue; two workspaces draw different
   ones; the hue survives a restart and a reordering of the workspace list.
4. Every hit region in `HitRegions` still resolves: a test clicks a workspace row, a tab
   row, an agent row, the close `x`, `new`, `▤ files`, `menu` and the collapse arrow,
   and asserts what each one hit.
5. The pane count and `x` are absent from an unhovered row and present on the hovered
   one, asserted in the buffer.
6. Bold and dim actually reach the terminal — asserted at the ANSI writer, not at the
   style object.
7. Nothing truncates at the new default width in the four-workspace, four-agent case.
8. `ui.pane-borders = "round"` renders `╭╮╰╯` and the existing values still render what
   they rendered.
9. No regression in `bench/RESULTS.md` — and this time **measure it**, because this is
   the first phase in four that touches the render path on purpose.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The identity palette, and how a hue is derived
- What moved from "always drawn" to "hover only", and what was left alone
- Whether the 34-column design width held, or whether the strip needs its own number
- **A before/after of the rendered sidebar, as text, in the handoff itself.** This phase
  is about how something looks; a handoff that describes it in prose is a handoff that
  cannot be checked.
