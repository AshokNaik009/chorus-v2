# Phase 4 — Session model and API

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase

Phases 1-3 built a terminal. This phase makes it a *multiplexer*: workspaces,
tabs, panes, layout operations, persistence, and the command surface that drives
them. It is the largest phase by volume and the smallest by risk.

## Source material

herdr's state layer is already pure data, testable without PTYs — this is the
part of herdr that ports most directly.

Re-measured 2026-09-19 at herdr `3f2a6e74`. The earlier draft of this table
undercounted badly — `app/` by half, `persist/` by more than half. These are
`wc -l` over all `.rs` files in the path, tests included.

| herdr file | Lines | What |
|---|---|---|
| `/Users/ashoknaik/claude-experiments/herdr/src/app/` | 36,582 | AppState, actions, runtime (of which `app/state.rs` is 1,504) |
| `/Users/ashoknaik/claude-experiments/herdr/src/layout.rs` | 1,167 | Layout tree, splits, ratios |
| `/Users/ashoknaik/claude-experiments/herdr/src/workspace/` | 3,910 | Workspace model |
| `/Users/ashoknaik/claude-experiments/herdr/src/session.rs` | 1,087 | Session model |
| `/Users/ashoknaik/claude-experiments/herdr/src/persist/` | 4,207 | Save/restore |
| `/Users/ashoknaik/claude-experiments/herdr/src/config/` | 7,697 | TOML/JSONC config, reload |
| `/Users/ashoknaik/claude-experiments/herdr/src/selection.rs` | 645 | Selection model |

That is ~55k lines of Rust, not the ~32k the old table implied. The `~15000
lines` estimate for `core/` below is therefore optimistic; treat it as a target
to *design toward*, not a forecast. Rust's test blocks inflate these counts and
we are deliberately porting a subset — but if `core/` is tracking past 25k,
that is a signal to cut scope, not to keep typing.

**The API surface is frozen and enumerable.** herdr has exactly 38 endpoint
methods in `/Users/ashoknaik/claude-experiments/herdr/tests/fixtures/endpoint-method-shapes-v1.json`. Use that
file as the checklist. We are not wire-compatible (we use JSON-RPC, not bincode)
but the *method set* is the right feature target.

## The 38 methods

```
workspace.create/close/focus/rename/move/move_block   (6)
tab.create/close/focus/rename/move                    (5)
pane.split/close/focus/focus_direction/resize/swap/zoom/rename  (8)
pane.scroll/input.set/link.activate/edit_scrollback   (4)
pane.copy_motion/copy_search/selection.read           (3)
layout.set_split_ratio                                (1)
worktree.create/list/open/remove                      (4)
integration.install/list                              (2)
command.invoke                                        (1)
server.reload_config                                  (1)
client_shell.surface.set                              (1)
product_announcement.dismiss / release_notes.dismiss  (2)
```

The counts add to exactly 38, matching the fixture.

Phase 4 ships **28**: the 27 workspace/tab/pane/layout methods, plus
`server.reload_config`, which acceptance criterion 5 below requires and which
is meaningless to defer when config lands in this phase.

Phase 5 takes `worktree.*` (4) and `integration.*` (2). That leaves **four**
genuinely deferrable: `command.invoke`, `client_shell.surface.set`,
`product_announcement.dismiss`, `release_notes.dismiss`. 28 + 6 + 4 = 38.

## Deliverables

```
packages/
  core/                     # ~15000 lines, ZERO runtime dependencies
    src/state.ts            # AppState — pure data
    src/layout-tree.ts      # split tree, ratios, focus direction
    src/workspace.ts
    src/tab.ts
    src/pane.ts
    src/actions.ts          # every mutation, as a pure reducer
    src/selection.ts
    src/persist.ts          # serialize/restore
    src/config.ts           # schema, defaults, merge, validation
    src/invariants.ts       # assertInvariants() — see note below
  daemon/
    src/rpc/                # the 27 methods, dispatching into core
  client/
    src/ui/                 # sidebar, tab bar, status line, modals
```

**`core` must have zero runtime dependencies.** This is the single most
important structural rule of the phase. It is what makes the state layer
testable without PTYs, sockets, or a terminal — and it is exactly how both
reference projects keep their logic honest (Orca keeps its host-agnostic logic in `/Users/ashoknaik/claude-experiments/orca/src/shared/`,
and herdr's `AppState::test_new()`).

**This collides with `core/src/config.ts`, and the collision is real.** Node
has no built-in TOML parser (no `node:toml`, and no plan for one), so a TOML
config needs a dependency. Resolve it one of two ways, and say which in the
handoff:

- Split it: `core/` owns the config *schema*, defaults, merge, and validation —
  all operating on a plain object — and a separate `config-loader` package owns
  the TOML text → object step and its dependency. This keeps the rule intact
  and is the recommended shape.
- Or drop TOML for JSONC, which is parseable in ~200 lines with no dependency.

Do not quietly add a TOML parser to `core/` and call the rule satisfied.

**Port herdr's invariant checks.** `AppState::assert_invariants_for_test()` and
`test_with_adversarial_identity_state()` exist because identity/state refactors
break in subtle ways. Build the TS equivalents in `invariants.ts` now, not later.

## Acceptance criteria

1. `pnpm test` green. `core` tests run with no I/O and no PTY, and `core`'s
   `package.json` has an empty `dependencies` — assert this in a test, do not
   trust review.
2. All 28 methods (27 workspace/tab/pane/layout + `server.reload_config`)
   implemented and tested.
3. Persistence round trip: build a 3-workspace / 8-pane state, save, restart the
   daemon, restore, and assert structural equality plus live PTYs reattached.
4. Invariant check passes against adversarial state (duplicate ids, orphaned
   panes, dangling focus, empty workspaces).
5. Config loads from TOML, validates, reports unknown keys, and hot-reloads via
   `server.reload_config` without dropping panes.
6. Keybindings from config drive actions end to end.
7. No regression in `bench/RESULTS.md` — re-run the phase-2 benchmark with the
   full UI (sidebar + tab bar) drawn. This is where render cost creeps in.

## Do NOT do in this phase

- No agent detection or status. Phase 5.
- No worktrees, no integrations. Phase 5.
- No SSH. Phase 6.
- No plugins. Post-v1.
- No update/channel machinery. Phase 5.

## Handoff

Write `HANDOFF.md`:
- Which of the 28 methods are done, and any deliberately skipped
- The config schema as it actually landed, the config *format* you chose, and
  where the parser dependency ended up
- Actual `core/` line count against the 15k estimate
- Benchmark numbers with full UI drawn, vs phase 2/3
