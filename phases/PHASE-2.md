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

Measured on herdr: it uses **20 unique ratatui imports** and renders headless
into a cell buffer. Buffer, Cell, Rect, Style, Color, Modifier, Line, Span,
Block, Borders, Paragraph, Wrap, Clear, Widget, Direction. That is the whole
surface. Writing it directly is ~4k lines and gives full control of the diff.

Ink caps at ~30fps and re-renders the visible terminal on every state change —
300 lines/sec of agent output becomes 300 React renders. OpenTUI is better but
has a Zig core and prefers Bun, which trades one native dependency for another.

**Use synchronized output (DEC mode 2026)** — wrap each frame in `CSI ? 2026 h`
/ `CSI ? 2026 l`. This eliminates tearing on terminals that support it and is
ignored harmlessly elsewhere.

## The benchmark (this is the deliverable that matters)

`bench/render-scale.ts` must measure, at fixed geometry:

| Scenario | Panes | Output |
|---|---|---|
| Single active | 1 | frame time p50/p99, bytes written |
| Realistic | 15 | same |
| Stress | 15 | all panes running `yes`, hidden + visible |

Record: frame time p50/p99, CPU%, RSS, daemon→client bytes/sec.

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
7. **15-pane p99 frame time under 16ms** on the dev machine. If it is not, stop
   and write up why in `HANDOFF.md` — that is a legitimate phase outcome and the
   project decision point.
8. Hidden panes measurably cheaper than visible ones.

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
