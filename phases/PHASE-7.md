# Phase 7 — Source control, finished

**Read `../PLAN.md` and `../HANDOFF.md` first.**

Phase 6 (remote SSH attach) is still reserved and unbuilt. Phases 7-9 do not
depend on it and it does not depend on them; run them in either order.

## Why this phase

Phase 5 ended with a multiplexer. Phases 7-9 port the *sidebar* — herdr-sidebar's
Explorer and Source Control — onto it. A first slice already landed outside the
phase system (see `../HANDOFF.md`): a working-tree git service, an `fs.list`
surface, a Source Control panel on `C-b g`, and a file Explorer on `C-b e`.

That slice is a demo, not a tool. It cannot switch a branch, cannot push, and —
confirmed below — silently mis-stages a rename. This phase makes source control
something you can use for a day's work without reaching for the shell.

## Source material

Measured **2026-09-20** at herdr-sidebar `1a5d37e`. Re-measure before trusting;
do not re-copy.

| File | Lines | What to take |
|---|---|---|
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/git.rs` | 1,663 | `branches`, `checkout_branch`, `sync`, `stage`, `has_head`, `paths_under`, `drop_nested` |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/branch_ui.rs` | 257 | The branch picker's shape |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/scm_app.rs` | 4,818 | Key map, section layout, multi-repo commit boxes |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/gitdeco.rs` | 319 | Decoration rollup |

**Read `git.rs` yourself.** This table says where to look, not what it says.
The last session found three behaviours by reading it that no summary carried.

## Confirmed defects to fix first

These were verified against real git on 2026-09-20, not inferred.

**1. Staging a rename leaves a dangling deletion.** `packages/daemon/src/git.ts`
stages with `add -- <paths>` and passes only the path the user selected. Repro:

```sh
git init -q -b main && echo x > old.txt && git add -A && git commit -qm first
git mv old.txt new.txt && git reset -q HEAD -- .
# status is now:  D old.txt  and  ?? new.txt  — the rename has decomposed
git add -- new.txt
# result: A  new.txt  and  ' D old.txt'  — the delete is still unstaged
```

herdr-sidebar's `Git::stage` passes **both** paths (`add -A -- <path> <orig>`)
for exactly this. `GitFileEntry.origin` already carries the original path over
the wire; it is simply unused. Fix it there, and add the repro as a test.

**2. The Source Control panel does not scroll.** `packages/client/src/scm.ts`
draws rows until it runs out of height and stops. The cursor still moves onto
rows that were never drawn, so `Enter` can stage a file the user cannot see.
`packages/client/src/explorer.ts` has a working `syncScroll`; lift it into
something both panels use rather than writing it twice.

**3. `git status` is called without `--renames`.** herdr-sidebar passes it
explicitly. Rename detection is on by default for status, so this is probably
cosmetic — **verify** it rather than assuming, and either pass the flag or write
down why it is unnecessary.

## Deliverables

```
packages/daemon/src/git.ts        # branches, checkout, sync; rename-aware stage
packages/daemon/src/rpc/git.ts    # git.branches / git.checkout / git.sync
packages/client/src/scrollview.ts # shared viewport: offset, cursor-follow, bar
packages/client/src/scm.ts        # branch line is a picker; sync; scrolling
packages/client/src/branch.ts     # the branch picker overlay
```

**`sync` is `pull --rebase --autostash` then `push`.** That is what
herdr-sidebar does and it is not an accident: the autostash is what lets it work
with a dirty tree, which is the normal state of a tree you are looking at. Do
not substitute `pull` or `pull --ff-only` without saying why in the handoff.

**Every destructive or remote operation reports what it did.** `sync` can
rebase, and a rebase can conflict. Surfacing `git`'s own stderr into the panel
beats inventing messages — the last session's `gitFailed` path already does this.

**Keep the daemon stateless.** No cached status, no watchers holding a
repository open. `worktree.ts` explains why; this is the same rule.

## Acceptance criteria

1. `pnpm test` green.
2. The rename repro above is a test, and staging that file leaves **nothing**
   unstaged.
3. A repository with more changed files than the panel is tall: every file is
   reachable, the view follows the cursor, and the file staged is the file
   highlighted. Test at a small `rows` so the case is forced.
4. `git.branches` lists local and remote branches with the current one marked;
   `git.checkout` switches, and creates a local tracking branch from a remote.
5. The branch picker opens from the panel, filters as you type, and switching
   updates the panel's branch line without a manual refresh.
6. `git.sync` runs on a dirty tree without losing work, and reports a conflict
   as a conflict rather than as success.
7. Staging a directory from the Explorer stages the files under it and does not
   cross a nested repository boundary (`drop_nested` in `git.rs` is why).
8. No regression in `bench/RESULTS.md`.

## Do NOT do in this phase

- No search or quick open. Phase 8.
- No file preview, no icons, no settings UI. Phase 9.
- No commit history, file history, stashes, tags or remotes browsing. Later, if
  ever — they are the least-used third of `scm_app.rs`.
- No AI commit drafting (`suggest.rs`). Phase 9 at the earliest.
- No plugin host. Phase 10.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The three defects above: fixed, or still open with the reason
- The exact git invocations for stage / unstage / sync / checkout as they landed,
  and any that differ from herdr-sidebar's, with why
- Whether `--renames` turned out to matter, and how you established it
- Where the scroll viewport lives and which panels use it
- Anything you verified empirically that contradicted this document
