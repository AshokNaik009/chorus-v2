# Phase 11 — The Source Control drawers

**Read `../PLAN.md`, `PARITY.md` and `../HANDOFF.md` first.**

## Why this phase exists

It exists because `PARITY.md` found a hole. PHASE-7 wrote:

> No commit history, file history, stashes, tags or remotes browsing. Later, if
> ever — they are the least-used third of `scm_app.rs`.

Reasonable for phase 7. But herdr-sidebar's README lists them as a headline
feature — *"Browse commits, file history, branches, worktrees, remotes,
stashes, and tags"* — and phases 8, 9 and 10 never picked them up. As the plan
stood they would never be built, and nobody would ever have decided not to
build them. This phase is that decision going the other way.

**This phase completes the herdr-sidebar port.** When it is done, `PARITY.md`
has no orphans left in the Source Control section. It is independent of phase 10
(the optional plugin host) and can run before it.

## What this is, in one line

Eight read-mostly lists under the changes list, each one a `git` command's
output parsed into rows, with a context menu per row type. That is genuinely
all it is — the risk here is not difficulty, it is **scope creep into a git
client**.

## Source material

Measured **2026-09-20** at herdr-sidebar `1a5d37e`.

| File | Lines | What to take |
|---|---|---|
| `…/herdr-sidebar/src/scm_app.rs` | 4,818 | `Drawer` (l.83), `DrawerPanel`/`DrawerRef` (l.124-150), `parse_drawer_ref` (l.204), the context menus (l.1715-1775) |
| `…/herdr-sidebar/src/git.rs` | 1,663 | the drawer queries, l.350-445 |

### The exact commands — all eight

Taken from `git.rs`; `DRAWER_LIMIT` is **30** in `scm_app.rs:43`.

| Drawer | Command |
|---|---|
| Graph | `log --graph --oneline --decorate=short -<n>` |
| Commits | `log --oneline --decorate=short --date=short -<n>` |
| File History | `log --oneline --follow -<n> -- <path>` |
| Branches | `branch -a --sort=-committerdate --format=%(HEAD) %(refname:short)` |
| Worktrees | `worktree list` |
| Remotes | `remote -v`, keeping only ` (fetch)` lines, tab → two spaces |
| Stashes | `stash list` |
| Tags | `tag --sort=-creatordate` |

Note **Branches here is a different query from the picker's.** Phase 7 already
ships `git.branches` via `for-each-ref … %(symref)` because the picker must drop
symbolic remote HEADs. The drawer is display-only and uses `branch -a`. Decide
deliberately whether to serve both from the existing RPC; do not add a second
one by accident.

`file_history` needs a selected path, so the drawer is empty with a reason when
nothing is selected — not hidden, which reads as broken.

### What a row points at

`DrawerRef` is the whole model, and it is worth copying rather than inventing:

```rust
enum DrawerRef { None, Commit(String), Stash(usize), Branch { name, current },
                 Remote { name, url }, Tag(String), Worktree(String) }
```

`parse_drawer_ref` recovers it from the rendered line. **Do not do that.** It is
an artifact of `git.rs` returning `Vec<String>`; we control both ends, so the
daemon should return structured rows and the client should never re-parse its
own display text. Two of herdr-sidebar's parsing rules survive as *display*
helpers, and both are worth keeping because a 34-column dock is unforgiving:

- `pretty_worktree_line` — show the folder **name** plus `⎇ branch`, not the
  absolute path, which "clipped uselessly in a narrow pane".
- `pretty_remote_line` / `pretty_remote_url` — `git@host:owner/repo` and
  `https://host/owner/repo` both render as `owner/repo`; a local-path remote
  renders as its folder name.

Its commit-hash rule — first whitespace token of ≥7 lowercase hex characters —
is a good *validator* for a hash we already have, and a bad way to find one.

### The context menus, per row type

This is where the actions live, and where the scope discipline has to be.

| Row | Menu |
|---|---|
| Commit | Show Changes · Checkout (Detached) · Cherry-Pick · Revert · Reset Current Branch Here… · Copy Hash |
| Branch (current) | Show Tip Commit · Copy Branch Name |
| Branch (other) | Checkout Branch · Merge into Current Branch · Delete Branch… · Copy Branch Name |
| Stash | Show Changes · Apply Stash · Pop Stash · Drop Stash… |
| Remote | Fetch · Copy URL |
| Tag | Show Changes · Checkout Tag · Delete Tag… · Copy Tag Name |
| Worktree | Reveal in File Explorer · Copy Path · Remove Worktree… |

An `…` suffix means it asks first, and herdr-sidebar is consistent about it:
every destructive entry has one. Keep that exactly — `ConfirmDialog` already
exists.

## Deliverables

```
packages/daemon/src/git-drawers.ts      # the eight queries, structured rows
packages/daemon/src/rpc/git.ts          # git.drawer / git.drawerAction
packages/client/src/drawers.ts          # the collapsible sections + menus
packages/client/src/scm.ts              # hosts them under the changes list
```

**Reuse what phase 7 and 8 already built.** `ScrollView` for the lists,
`ContextMenu` from `prompt.ts` for the menus, `ConfirmDialog` for the `…`
entries, and `worktree.list` / `worktree.remove` for the Worktrees drawer —
those RPCs already ship and this phase should not grow a second way to list a
worktree.

**Drawers are collapsed by default and fetched only when opened.** Eight `git`
invocations on every status refresh, in a panel that already runs one, is how a
sidebar becomes the reason the repository feels slow. Fetch on expand, cache
nothing (`git.ts`'s standing rule), and re-fetch on `r`.

**Apply phase 7's follow-ups here.** This phase adds eight new `git`
invocations, so it is the natural place to finally fix what `PHASE-7.md` lists:
`GIT_OPTIONAL_LOCKS=0` on the read-only queries, the locale pinning, and the
credential-prompt guard on `Fetch`. Doing it once in the runner covers all of
them.

**`Show Changes` opens a pager pane**, like every other diff in this project,
until phase 9 decides otherwise. Do not build a second diff viewer here.

**Copy-to-clipboard needs a decision.** Four menus have a `Copy …` entry and
this project has no clipboard path. OSC 52 is the terminal-native answer and
works over SSH, which is the reason to prefer it — but it is silently dropped by
some terminals, so a copy that cannot be confirmed must say so rather than
appear to work. If that is too much for this phase, drop the `Copy` entries and
record it; a menu entry that silently does nothing is worse than an absent one.

## Do NOT do in this phase

- **No `git` command not listed above.** No rebase UI, no interactive rebase, no
  branch creation, no tag creation, no push-to-remote from the Remotes drawer,
  no conflict resolution. herdr-sidebar does not have them either, and the
  failure mode of this phase is becoming a git client.
- No graph *rendering*. `--graph` emits ASCII rails and we draw the line as
  given. Drawing our own DAG is a project, not a row.
- No commit-message editing or amending.
- No in-panel diff. Phase 9 owns that question.
- No polling. Same rule as phase 7.

## Acceptance criteria

1. `pnpm test` green.
2. Each of the eight drawers lists what its command returns, against a fixture
   repository built in the test — including the empty case for each, which is
   the common one (no stashes, no tags, one worktree).
3. Rows arrive **structured** from the daemon. A test asserts the client never
   parses a hash out of a display string.
4. A path with a space in it survives every drawer that can carry one
   (worktrees, file history).
5. `file_history` with nothing selected shows a reason, not an empty list.
6. Every destructive action confirms first, and cancelling runs no git command —
   asserted by a runner that records invocations.
7. Expanding a drawer runs exactly one git command; a status refresh with all
   drawers collapsed runs none.
8. Remote and worktree rows render in 34 columns without losing the identifying
   part (`owner/repo`, the folder name).
9. `Fetch` on an unreachable remote fails with a message and does not hang —
   the credential-prompt guard from `PHASE-7.md` is in place.
10. No regression in `bench/RESULTS.md`.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The row types and their wire shapes
- Which of phase 7's follow-ups were applied, and which remain
- What happened with the clipboard decision
- Whether the Branches drawer and the branch picker ended up sharing an RPC
- **Update `PARITY.md`.** This phase's whole purpose is to turn those rows
  green; a handoff that does not update the scoreboard leaves the next session
  in exactly the position that created this phase.
