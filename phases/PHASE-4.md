# Phase 4 — Session model and API

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase

Phases 1-3 built a terminal. This phase makes it a *multiplexer*: workspaces,
tabs, panes, layout operations, persistence, and the command surface that drives
them. It is the largest phase by volume and the smallest by risk.

## Source material

herdr's state layer is already pure data, testable without PTYs — this is the
part of herdr that ports most directly.

| herdr file | Lines | What |
|---|---|---|
| `../herdr/src/app/state.rs` + `app/` | ~18,300 | AppState, actions, runtime |
| `../herdr/src/layout.rs` | ~1,100 | Layout tree, splits, ratios |
| `../herdr/src/workspace/` | 4,064 | Workspace model |
| `../herdr/src/session.rs` | ~1,000 | Session model |
| `../herdr/src/persist/` | 1,902 | Save/restore |
| `../herdr/src/config/` | 5,092 | TOML/JSONC config, reload |
| `../herdr/src/selection.rs` | ~600 | Selection model |

**The API surface is frozen and enumerable.** herdr has exactly 38 endpoint
methods in `../herdr/tests/fixtures/endpoint-method-shapes-v1.json`. Use that
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

Phase 4 ships the first 27 (workspace/tab/pane/layout). Worktrees and
integrations are phase 5. The last three are cosmetic; defer.

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
reference projects keep their logic honest (`../orca/packages/core` equivalent,
and herdr's `AppState::test_new()`).

**Port herdr's invariant checks.** `AppState::assert_invariants_for_test()` and
`test_with_adversarial_identity_state()` exist because identity/state refactors
break in subtle ways. Build the TS equivalents in `invariants.ts` now, not later.

## Acceptance criteria

1. `pnpm test` green. `core` tests run with no I/O and no PTY.
2. All 27 workspace/tab/pane/layout methods implemented and tested.
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
- Which of the 27 methods are done, and any deliberately skipped
- The config schema as it actually landed
- Benchmark numbers with full UI drawn, vs phase 2/3
