# Handoff — end of Phase 7

**Read `PLAN.md` first, then `phases/PHASE-8.md`.** This file is the state of the world
as this session leaves it. Everything was measured on 2026-09-20, macOS (darwin 25.6.0,
arm64, Apple silicon, 10 cores), Node v22.1.0, pnpm 10.18.0, **git 2.54.0 (Apple Git-157)**.

## Status

- **Phase 7 complete: yes, on 7 of 8 criteria.** Criterion 8 is a measurement this
  machine could not make; see **Numbers**. Nothing is unimplemented.
- `pnpm test` is **959 tests**, up from 893. One fails in a full serial run
  (`client/test/multiplexer.test.ts`) and passes 16/16 alone — the flake the previous
  handoff already documented, unchanged and still undiagnosed.

| # | Criterion | Verdict | Where |
|---|---|---|---|
| 1 | `pnpm test` green | met, minus the known flake | see above |
| 2 | rename repro is a test; staging leaves nothing unstaged | met | `daemon/src/git.test.ts`, `describe('staging a rename')` |
| 3 | more files than the panel is tall: all reachable, view follows, right file staged | met | `client/test/source-control.test.ts`, `describe('a changes list taller than the panel')`, driven at `rows: 14` |
| 4 | `git.branches` lists local + remote, current marked; `git.checkout` switches and tracks | met | `git.test.ts`, `describe('branches, checkout and sync')` |
| 5 | picker opens from the panel, filters, branch line updates with no refresh | met | `client/src/branch.test.ts` + `source-control.test.ts`, `describe('the branch picker')` |
| 6 | `git.sync` on a dirty tree; a conflict reads as a conflict | met | both files, `describe('sync')` |
| 7 | staging a directory stops at a nested repository | met | `git.test.ts` + `client/test/explorer.test.ts`, `describe('staging from the explorer')` |
| 8 | no regression in `bench/RESULTS.md` | **not measurable here**; no regression shown by A/B | see **Numbers** |

## What exists now

Source control is usable for a day's work without reaching for the shell. The panel
scrolls, its branch line is a picker you can filter, `S` syncs, and staging is
rename-aware and nested-repository-aware on both sides of the index. The Explorer can
stage a directory. Two rename defects and one scrolling defect that PHASE-7 opened with
are closed and pinned by tests; the third item (`--renames`) turned out to matter for a
reason the doc did not give. The daemon is still stateless — every call shells out, and
nothing is cached.

## Deliverables, as they landed

| File | Lines | What |
|---|---|---|
| `packages/daemon/src/git.ts` | 662 (was 282) | rename-aware stage/unstage, directory staging, nested-repo boundary, `branches`, `checkout`, `sync` |
| `packages/daemon/src/rpc/git.ts` | 128 (was 95) | `git.branches` / `git.checkout` / `git.sync` |
| `packages/client/src/scrollview.ts` | 106 | the shared viewport: offset, cursor-follow, bar |
| `packages/client/src/scm.ts` | 386 (was 333) | scrolling, branch key, sync key, note line, click routing |
| `packages/client/src/branch.ts` | 200 | the branch picker overlay |
| `packages/client/src/explorer.ts` | 367 (was 346) | on `ScrollView`; `s` stages; errors wrap |

`wrapWords` moved from `scm.ts` to `chrome.ts` because the Explorer needed it too — see
**Surprises**.

## Types and contracts the next phase depends on

Three new methods on `AgentMethodMap`, all in `AGENT_METHODS`:

```ts
'git.branches': { params: GitStatusParams;   result: GitBranchesResult }
'git.checkout': { params: GitCheckoutParams; result: GitStatusResult }
'git.sync':     { params: GitStatusParams;   result: GitSyncResult }
```

```ts
interface GitBranch { name: string; current: boolean; remote: boolean }
interface GitBranchesResult { root: string; branches: readonly GitBranch[] }
interface GitCheckoutParams extends GitTargetParams { branch: string; remote?: boolean }
interface GitSyncResult { status: GitStatusResult; message: string }
```

`GitStatusResult`, `GitFileEntry`, `GitPathsParams` and `FsListResult` are unchanged.
`git.stage` and `git.unstage` keep their signatures; only what they do with the paths
changed.

The shared viewport, which PHASE-8's own lists should use rather than copy:

```ts
class ScrollView {
  offset: number
  follow(cursor: number, count: number, height: number): number
  by(delta: number, count: number, height: number): void
  indexAt(row: number, top: number, count: number, height: number): number | null
}
function needsScrollbar(count: number, height: number): boolean
function renderScrollbar(buffer: ScreenBuffer, area: Rect, offset: number, count: number, palette: Palette): void
```

It holds **an offset and nothing else** — no cursor, no rows, no height. The cursor
belongs to the panel (it means different things in a tree and in a two-section list) and
the height is the renderer's, because a panel that has not been drawn has none. `follow`
is therefore called from `render`, which is how the Explorer's original `syncScroll`
already worked.

**Used by:** `ScmPanel`, `ExplorerPanel`, and `BranchPicker`. The old
`ExplorerPanel.syncScroll` and its private `scroll` field are gone.

### The exact git invocations

| Operation | Command | Differs from herdr-sidebar? |
|---|---|---|
| status | `status --porcelain -z --branch --renames --untracked-files=all` | no |
| stage | `add -A -- <paths…>`, in chunks of 64 | **enumerated, not passed through** — see below |
| unstage | `reset -q HEAD -- <paths…>` (or `-- .` for all) | yes: herdr uses `reset -q --` with an `rm --cached` fallback |
| discard (tracked) | `checkout -- <paths…>` | yes: herdr uses `clean -fd` for untracked; we `rm` in Node |
| commit | `commit -m <message>` | no |
| branches | `for-each-ref --sort=-committerdate --format=%(HEAD)%00%(refname:short)%00%(refname)%00%(symref) refs/heads refs/remotes` | no |
| checkout | `checkout <name>`, or `checkout --track <name>` when remote | no |
| sync | `pull --rebase --autostash`, **then** `push` | no |
| rename pairing | `hash-object -- <paths…>` and `ls-files -s -z -- <paths…>` | **ours; herdr has no equivalent** |

**`sync` is `pull --rebase --autostash` then `push`, unchanged from herdr-sidebar.** The
autostash is load-bearing, not a convenience: the tree a source-control panel is open
over is a dirty tree by definition, and `pull` or `pull --ff-only` refuses to start on
one. Substituting either would make the button work only in the state where nobody needs
it.

**Push does not run if the pull failed.** Verified: a stopped rebase leaves HEAD
detached, and `push` from there fails with `fatal: You are not currently on a branch`,
which describes nothing the user did.

**Two deviations from herdr-sidebar, both deliberate:**

1. **`unstage` uses `reset -q HEAD --`, not `reset -q --` with an `rm --cached`
   fallback.** herdr's fallback exists for an unborn branch. Verified on git 2.54:
   `reset -q HEAD -- <path>` **exits 0 on a repository with no commits**, so the
   fallback has nothing to catch here — and `rm --cached` on a repo that *does* have a
   HEAD stages a deletion instead of unstaging, which is why herdr guards it with
   `has_head()`. Not porting the fallback removes the need for the guard. If a git old
   enough to fail this ever matters, `has_head()` is the thing to port.
2. **`stage` enumerates instead of passing the path to `git add`.** Same reasoning as
   herdr's `stage_under`, applied to every stage rather than only to directories, so
   there is one code path. A file path expands to itself plus its rename partner; a
   directory expands to the working-tree entries beneath it; an empty path list expands
   to the whole repository.

### Where the scroll viewport lives, and which panels use it

`packages/client/src/scrollview.ts`. `ScmPanel` and `ExplorerPanel` both draw through
it, and `BranchPicker` uses it for its own list. The bar takes the panel's **last
column, and only when there is something to scroll** — reserving it unconditionally
would steal a column of filename from every panel that fits.

One panel-level rule lives in `ScmPanel.follow`, not in `ScrollView`, because it is
knowledge about headers: **when the cursor lands on the first row of a section, the
section header comes with it.** Without that, staging a file scrolls the view to the
file's new position and leaves `Staged Changes (1)` exactly one row above the top, which
reads as the file having moved into nothing. It was found by a test failing, not by
inspection.

### Key map changes in the Source Control panel

| Key | Was | Is |
|---|---|---|
| `b` | close (a second `q`) | **open the branch picker** |
| `S` | — | **sync** |
| `q`, `esc` | close | unchanged |

`b` was worth more as the branch key: closing already had two keys and switching branch
had none. `S` is capitalised deliberately, matching herdr-sidebar — sync talks to the
remote and can rebase, so it should not be one relaxed finger away. The Explorer keeps
`b` as a close alias; it has no branch line. Both hint strings are updated.

The Explorer gained **`s` = stage the selected path**, which is where criterion 7 lives:
a directory is a thing you can point at in a tree and cannot in the changes list.

## The three defects

### 1. Staging a rename left a dangling deletion — fixed, but **not the way PHASE-7 says**

This is the most important thing in this handoff. **The phase doc prescribes a fix that
does not close its own repro.**

The doc says `GitFileEntry.origin` "already carries the original path over the wire; it
is simply unused", and that passing both paths (herdr's `add -A -- <path> <orig>`) is
the fix. Verified against git 2.54.0, and it is not. Run the doc's own repro:

```sh
git mv old.txt new.txt && git reset -q HEAD -- .
git status --porcelain -z --renames | tr '\0' '|'
#  D old.txt| ?? new.txt|
```

Two unrelated entries, **`origin: null` on both**. Git only pairs a worktree-side rename
when the target is already tracked, and an untracked file is not. So there is no origin
to pass, and herdr-sidebar's `Git::stage` has exactly the same gap — its own test for
this (`stage_candidates_keep_both_sides_of_an_unstaged_rename`, `git.rs:1285`) feeds
`parse_status` a **synthetic** ` R src/new.rs\0src/old.rs\0` entry that real git does
not emit in this state.

What *does* close it: `git add -A -- old.txt new.txt` composes the two back into an `R`
once both land in the index together. So the missing half is found the way git itself
would — by blob identity:

- `git hash-object -- <untracked paths>` for the working-tree side
- `git ls-files -s -z -- <deleted paths>` for what the index holds

**Guarded three ways, because a stage must never stage work the user did not select:**
exact content (not similarity), **exactly one** candidate match on each side, and the
empty blob (`e69de29…`) never pairs — every `.gitkeep` in a repository hashes the same.
Both guards have tests. When no pair is found, behaviour falls back to the old one,
which is merely unhelpful rather than wrong.

The origin fix is **also** implemented, because it is right for the cases where status
*does* report a rename (`RM`, ` R`, and the whole staged side).

**The same defect exists on the unstage side and PHASE-7 does not mention it.** Verified:
a staged `R old -> new` reset by its new path alone leaves `D old.txt` still staged.
Fixed by the same expansion against the staged list.

### 2. The Source Control panel did not scroll — fixed

Lifted the Explorer's `syncScroll` into `scrollview.ts` rather than writing it twice,
as the phase asked. The consequence worth naming: the cursor used to move onto rows that
were never drawn, so `Enter` could stage a file the user could not see.

### 3. `--renames` — **it matters, and not for the reason you would guess**

The phase doc suspected it was cosmetic because rename detection is on by default.
Measured:

```
$ git status --porcelain -z --branch --untracked-files=all
## main|R  new.txt|old.txt|                      # rename detected
$ git -c status.renames=false status --porcelain -z --branch --untracked-files=all
## main|A  new.txt|D  old.txt|                   # decomposed
$ git -c status.renames=false status --porcelain -z --branch --renames --untracked-files=all
## main|R  new.txt|old.txt|                      # the flag overrides the config
```

So it is cosmetic **in a default configuration** and not otherwise: a user with
`status.renames = false` (or `diff.renames = false`, which it inherits from) changes what
the panel shows. The flag on the command line wins over both. Passing it makes the
daemon's output depend on the repository rather than on the user's `~/.gitconfig`, which
is the property worth having. Passed.

## Numbers

**Criterion 8 could not be measured on this machine, and `bench/RESULTS.md` is left at
the committed run rather than overwritten with a contaminated one.**

The machine sat at load average **8–23 for the whole session** (10 cores), from Chrome,
VS Code, `PerfPowerServices` and `BTLEServer` — the last of which is the *same*
unrelated macOS process the previous handoff blamed for spoiling its measurements. It
was polled every 25 s for eight minutes and never dropped below 7.7.

A plain run produced `Realistic 15` frame p99 of **21.06 ms** against the committed
3.24 ms, which would have recorded criterion 7 as a FAIL. It was reverted
(`git checkout bench/RESULTS.md`) rather than committed, and an **A/B** run instead —
the same benchmark against the pre-phase-7 tree and the phase-7 tree, back to back:

| Scenario | p50 before | p50 after | paint p50 before | paint p50 after | p99 before | p99 after |
|---|---|---|---|---|---|---|
| Single active | 0.55 ms | 0.45 ms | 0.43 ms | 0.39 ms | 4.43 ms | 10.32 ms |
| Realistic 15 | 2.04 ms | 2.07 ms | 0.53 ms | 0.53 ms | 10.38 ms | 15.64 ms |
| Stress, visible | 3.63 ms | 3.63 ms | 0.55 ms | 0.56 ms | 23.80 ms | 32.10 ms |
| Stress, 14 hidden | 3.29 ms | 3.26 ms | 0.36 ms | 0.36 ms | 16.05 ms | 15.41 ms |

Load average was **~10 during the "before" arm and ~23 during the "after" arm**, so the
p99 columns are not comparable and are printed only so nobody re-derives them and thinks
they were hidden.

**What the A/B does establish:**

- **`p50` is unmoved** — within 0.03 ms on three of four scenarios, and *faster* on the
  fourth. `paint p50`, which is this client's own CPU and the only thing phase 7 could
  have touched, is identical to two decimal places on three of four.
- **The committed p99 numbers are not reproducible on this machine at any tree**, phase 7
  or not: the pre-phase-7 baseline also missed the 16 ms budget (10.38 ms is inside it,
  but `Stress, visible` at 23.80 ms is not). That is the load, not the code.
- In both arms the p99 blowup is almost entirely in **`fetch`** — time spent waiting on
  the daemon over the socket — which is the signature of a descheduled process, not of
  work being done.

**By construction there is nothing for a regression to come from.** With no panel open,
`render()` gained one `this.branches !== null` null check and `statusContent()` one
ternary. Every other change is in `git.*` RPCs, which the benchmark never calls.

**Do not accept this as done.** Re-run `node bench/dist/render-scale.js --seconds 15` on
a quiet machine — `uptime` first, and nothing else running, including the test suite —
and commit the result. That instruction is now three handoffs old.

## Surprises

Things that contradicted a document or cost a wrong assumption first:

- **PHASE-7's stated fix for its own defect 1 does not work**, and neither does
  herdr-sidebar's, whose test for it is synthetic. Fully written up above. This is the
  one thing in this handoff that changes what a reader believes.
- **`reset -q HEAD -- <path>` exits 0 on an unborn branch** on git 2.54. The previous
  handoff recorded that `restore --staged` fails there and that `reset` was chosen
  because of it; what it did not record is that herdr's `rm --cached` fallback is
  therefore dead code in our port.
- **`%(HEAD)` in `for-each-ref` is `*` or a *single space*, never empty**, so the field
  has to be trimmed before comparing. A real clone does carry a symbolic
  `refs/remotes/origin/HEAD`, so the symref filter is not defensive — without it the
  picker offers a branch called `origin` that checks out detached.
- **A rebase conflict holds the dirty tree in the autostash and leaves it off disk.**
  The work is not lost — `rebase --continue` or `--abort` brings it back — but "sync did
  not lose your work" and "your edits are still in the file" are different claims, and
  only the first is true mid-conflict. git's own hint block says which command restores
  it, which is the argument for surfacing stderr verbatim.
- **`key.char` is the *unshifted* codepoint.** `S` arrives as `{char: 's', MOD_SHIFT,
  shiftedChar: 'S'}` (`input/src/parse-csi.ts:416`, deliberate, so a binding written `H`
  fires under both the legacy and kitty protocols). The panels were being handed
  `key.char` directly, so `s` and `S` were indistinguishable to them and the sync key
  silently could not work. There is now one `App.typedChar(key)` and the prompt, the
  picker and both panels share it.
- **The Explorer clipped its errors where the panel wrapped them.** "nothing staged:
  those paths belong to a nested repository, not this one" became "nothing staged: those
  paths belong" in 34 columns — the half that names no reason. `wrapWords` moved from
  `scm.ts` to `chrome.ts` (which both panels already import for `Palette`) and the
  Explorer now wraps too. Found by a test failing for the wrong reason.
- **Staging a file whose section header is the row above scrolls the header off.** See
  **Types and contracts**. Not a `ScrollView` bug; a missing panel-level rule.
- **`ScmPanel.clickRow` and `ExplorerPanel.clickRow` were dead code** — written in the
  unphased slice, never called from `app.ts`. Both are live now via `handlePanelClick`,
  which also gave the branch line its click (herdr-sidebar opens its picker that way and
  has no key for it).

## Open threads deliberately left

- **Criterion 8.** Above. It is a machine, not a task.
- **Picking `origin/x` when a local `x` already exists fails** with git's
  `fatal: a branch named 'x' already exists`. herdr-sidebar behaves identically and the
  message says exactly what to pick instead, so it was kept rather than papered over.
  Deduping the picker, or falling back to `checkout x`, is the fix if it annoys anyone.
- **`hash-object` does not apply `.gitattributes` filters.** A repository with
  `text=auto` and CRLF working-tree content can hash differently from what `git add`
  would store, so the rename pairing quietly does not fire. The failure mode is the old
  behaviour, not a wrong stage. `--path` would fix it at the cost of one invocation per
  file.
- **Similarity-based rename detection is not attempted.** `git mv` followed by an edit
  decomposes and stays decomposed. Exact content only, deliberately: a looser rule
  stages work the user did not select.
- **The panel does not poll.** A `git` command run in a pane behind it still needs `r`.
  Same reason the daemon caches nothing; a watcher is a phase-9 conversation.
- **No commit history, file history, stashes, tags or remotes browsing**, per the
  phase's "Do NOT do" list. Also no search or quick open (phase 8), no preview, icons or
  settings UI (phase 9), no AI commit drafting, no plugin host.
- **`git.sync` has no timeout of its own.** It inherits `runGit`'s, which means a push
  to an unreachable remote blocks that long. `DaemonClient` still has no request timeout
  either — unchanged from phase 4.
- **Multi-repo is not ported.** herdr-sidebar's `discover_all` finds child repositories
  two levels down and gives each its own commit box; ours follows the focused pane into
  exactly one repository. That is the right shape for a multiplexer where switching pane
  switches repository, but it is a real difference from the source material.
- **`client/test/multiplexer.test.ts` is still flaky** and still undiagnosed. Passes
  alone; a different test fails each full run. Predates all sidebar work.
- **Criterion 2 of phase 5 is still the important gap** — detection has never been
  checked against a running agent, and three of six platform slots have never been
  built. Nothing in phase 7 moved that.

## Getting started in a new session

```bash
pnpm install
pnpm build
ln -s "$PWD/packages/client/dist/main.js" ~/.local/bin/leap-chorus
pnpm test                                    # 959 tests; do not run anything alongside it
LEAP_CHORUS_DISABLE_SOUND=1 pnpm test        # the suite must not spawn afplay
leap-chorus                                  # C-b g for source control, C-b e for the tree
uptime && node bench/dist/render-scale.js --seconds 15   # alone, or the numbers are fiction
pgrep -f leap-chorusd                        # a leaked daemon forks `ps` every 750 ms
```
