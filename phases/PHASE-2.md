# Phase 2 — TUI client, render loop, and the 15-pane benchmark

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase is second

Phase 1 proved the daemon can hold state. This phase proves two things:

1. We can render that state to a real terminal without a TUI framework.
2. It is fast enough at realistic pane counts.

Point 2 is the **last open architectural risk** in the whole project. Node runs
one event loop; herdr uses 31 OS threads. If the render path cannot hold 15
panes, we need to know now, not in month four.

## Goal

Replace `cli-probe` with a real TUI client: attach to the daemon, render pane
snapshots into a cell buffer, diff against the previous frame, and write only
the changed cells to stdout as ANSI. Then measure it under load.

## Deliverables

```
packages/
  tui/                    # ~4000 lines
    src/cell.ts           # Cell: char, fg, bg, attrs (bold/dim/italic/underline/reverse)
    src/buffer.ts         # 2D cell grid; get/set/fill/resize
    src/rect.ts           # Rect, split horizontal/vertical, constraints
    src/layout.ts         # layout tree -> Rect per pane (port /Users/ashoknaik/claude-experiments/herdr/src/layout.rs)
    src/widgets/block.ts  # borders + title
    src/widgets/text.ts   # wrapped paragraph, spans with style
    src/widgets/clear.ts
    src/diff.ts           # previous buffer vs next -> minimal cell runs
    src/ansi.ts           # cell runs -> ANSI; SGR state machine, cursor moves
    src/screen.ts         # raw mode, alt screen, resize (SIGWINCH), teardown
  client/                 # ~1500 lines
    src/attach.ts         # connect to daemon socket, negotiate version
    src/frame.ts          # snapshot -> buffer composition
    src/main.ts           # entrypoint: `herdr-ts`
bench/
  render-scale.ts         # the benchmark below
```

## Why not Ink / OpenTUI / blessed

Measured on herdr at `3f2a6e74`: every `use ratatui::...` in the tree resolves
to **24 unique identifiers**, and it renders headless into a cell buffer.

```
Backend  Block  Borders  Buffer  Clear  ClearType  Color  Constraint
Direction  Frame  Layout  Line  Modifier  Paragraph  Position  Rect
Size  Span  Style  Terminal  TestBackend  Widget  WindowSize  Wrap
```

That is the whole surface. Note `Cell` is *not* in it — herdr goes through
`Buffer`'s accessors. Writing this layer directly is ~4k lines and gives full
control of the diff.

**Ink**: the refresh rate is locked to 30fps, and each React state change walks
the whole node tree, builds a full 2D buffer, and writes a complete repaint.
That is deliberate — correctness and no partial updates — but it means 300
lines/sec of agent output becomes 300 full-tree renders
([ink#657](https://github.com/vadimdemedes/ink/discussions/657)).

**OpenTUI**: `@opentui/core` is at **0.5.11** (2026-09-07) — pre-1.0, with a
native Zig core, a `bun-ffi-structs` dependency, and
`engines: { bun: ">=1.3.0", node: ">=26.4.0" }`. Node 26 is Current, not LTS,
so adopting it would drag our runtime floor above every LTS line *and* trade
node-pty's native dependency for a second one. Revisit after it hits 1.0.

**Use synchronized output (DEC mode 2026)** — wrap each frame in `CSI ? 2026 h`
/ `CSI ? 2026 l`. This eliminates tearing where it is supported. Do not assume
it is silently ignored elsewhere: **query it first** with DECRQM
`CSI ? 2026 $ p`. No reply, or a reply of `CSI ? 2026 ; 0 $ y`, means
unsupported — then don't emit the brackets at all. A terminal that neither
implements the mode nor ignores it cleanly will otherwise print garbage into
the user's scrollback on every frame.

## The benchmark (this is the deliverable that matters)

`bench/render-scale.ts` must measure at **fixed, stated geometry** — pin it to
a 200x50 outer terminal and record the per-pane cell dimensions the layout
produced, so a later run is comparable:

| Scenario | Panes | Output |
|---|---|---|
| Single active | 1 | frame time p50/p99, bytes written |
| Realistic | 15 | same |
| Stress | 15 | all panes running `yes`, hidden + visible |

Record: frame time p50/p99, CPU%, RSS, daemon→client bytes/sec.

**A floor you can already assume.** Extracting a full 200x50 grid out of
`@xterm/headless` 6.0.0 — `getLine` + `getCell` + `getChars`/`getFgColor`/
`getBgColor`/`isBold` on all 10,000 cells, reusing one cell object via
`buffer.getNullCell()` — measured **0.153 ms** on the dev machine (Node 22,
2026-09-19). So the snapshot-extraction half of 15 panes of that size is ~2.3ms
of the 16ms budget *before* diff, ANSI encoding, or socket I/O. If your numbers
land far above that, the cost is in your code, not in xterm; profile before
blaming the emulator. Reuse the `getNullCell()` object — allocating a cell per
read is the easiest way to lose this margin.

**Compare hidden vs visible panes.** herdr's rule: hidden panes still parse PTY
output, but must not trigger presentation work. If a hidden pane costs the same
as a visible one, the early-exit is missing and the design is wrong.

Write results to `bench/RESULTS.md`. This file is the phase's real output.

## Acceptance criteria

1. `pnpm test` green.
2. A visible, working multiplexer: split panes, each running a shell, rendered
   correctly in a real terminal (iTerm2/Ghostty/Alacritty on macOS, plus one
   Linux terminal).
3. `vim` in a pane renders and behaves correctly (alt screen, cursor position).
4. Terminal resize (SIGWINCH) reflows panes without corruption.
5. Frame diff writes strictly fewer bytes than a full repaint, proven by a test.
6. `bench/RESULTS.md` exists with all three scenarios measured.
7. **15-pane p99 frame time under 16ms** at the stated geometry, on the dev
   machine, with the machine and Node version recorded. If it is not, stop and
   write up why in `HANDOFF.md` — that is a legitimate phase outcome and the
   project decision point.
8. Hidden panes measurably cheaper than visible ones.
9. DEC 2026 is gated on a DECRQM probe: a terminal that does not advertise it
   receives no `CSI ? 2026` bytes at all. Test the probe parser against both a
   `0`/absent reply and a `1`/`2` reply.

## Do NOT do in this phase

- No mouse, no kitty keyboard protocol, no bracketed paste. Phase 3.
  Raw stdin passthrough is fine; a ctrl-key to quit is enough.
- No workspaces or tabs. Panes in one flat layout tree only.
- No config files. Hardcode.
- No agent detection.
- No scrollback UI, no copy mode, no search.

## Handoff

Write `HANDOFF.md`:
- The benchmark numbers, plainly. Do not round in our favor.
- The `Buffer`/`Cell` API shape (phase 4 builds widgets on it)
- Which terminals were verified
- If criterion 7 failed: what the bottleneck profiled to
