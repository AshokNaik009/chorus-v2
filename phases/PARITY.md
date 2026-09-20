# herdr-sidebar parity — the checklist phases 7-9 are measured against

**The port target is herdr-sidebar.** This file is the inventory: every feature
it advertises, whether herdr-ts has it, and which phase owns it. Phases 7-9 are
*how* we get there; this is *what done means*.

Orca (`/Users/ashoknaik/claude-experiments/orca`, MIT) is **not** a parity
target and never appears in this table. It is a solutions library — when we need
to build one of these rows in Node, orca has often already solved the mechanics.
Nothing in orca's product shape belongs here.

Measured **2026-09-20** at herdr-sidebar `1a5d37e`, against herdr-ts `a016c11`.
Feature list taken from herdr-sidebar's own README, which is what it promises a
user, plus the view enums in `scm_app.rs` and `explorer_app.rs`.

## Scoring

- **done** — shipped and covered by tests
- **partial** — works, but not to herdr-sidebar's extent; the gap is named
- **phase N** — not built, and a phase owns it
- **orphan** — not built, and **no phase owns it**. These are the rows that
  matter; see the bottom of this file.
- **N/A** — a herdr plugin concern with no counterpart here (we are the host,
  not a plugin)

## Explorer

| Feature | Status | Notes |
|---|---|---|
| Expandable lazy tree | **done** | `explorer.ts`; children null until expanded |
| Git decorations on files | **done** | letter per file |
| Git decorations rolled up to folders | **done** | `·` when anything beneath is touched |
| Hidden-file toggle (`.`) | **done** | |
| Refresh (`r`) keeping subtrees open | **done** | `merge()` preserves `expanded` |
| Stage a file or folder from the tree (`s`) | **done** | stops at nested repos |
| Scrolling viewport + scrollbar | **done** | `scrollview.ts` |
| Open a file | **partial** | opens `$PAGER` in a split pane; herdr-sidebar opens a preview tab |
| File icons | phase 9 | ASCII only today, deliberately |
| Hover actions on a row | **orphan** | |
| Context menu (`m` / Ctrl+right-click) | **orphan** | `ContextMenu` widget already exists in `prompt.ts` |
| Follow a neighbouring pane's cwd | **done** | `resolveCwd` reads the shell's live cwd |
| Manually chosen folder stays put | **orphan** | we always follow the focused pane |

## Search

| Feature | Status | Notes |
|---|---|---|
| Quick open (`Ctrl+P`), filter as you type | phase 8 | |
| Content search (`Ctrl+F`) | phase 8 | |
| Case / whole-word / regex toggles | phase 8 | `Alt-C` / `Alt-W` / `Alt-R` |
| Include / exclude glob filters | phase 8 | |
| Result caps reported honestly | phase 8 | |
| Search-and-replace | — | herdr-sidebar does not have it either |

## Source Control

| Feature | Status | Notes |
|---|---|---|
| Stage / unstage / discard | **done** | rename-aware on both sides of the index |
| Commit | **done** | via the prompt line |
| Inspect diffs (`o`) | **partial** | opens a pager pane, not an in-panel diff |
| Sync with upstream (`S`) | **done** | `pull --rebase --autostash` then `push` |
| Branch switch from the panel header | **done** | `branch.ts` picker, filterable |
| Create a local tracking branch from a remote | **done** | |
| Scrolling changes list | **done** | |
| One commit box **per repository** (multi-repo) | **orphan** | we follow one pane into one repo |
| AI commit draft (`A`, ✧) via local `claude` CLI | phase 9 | `suggest.rs`, with filename fallback |
| Browse **commits** | **orphan** | `Drawer::Commits` |
| Browse **file history** | **orphan** | `Drawer::FileHistory` |
| Browse **graph** | **orphan** | `Drawer::Graph` |
| Browse **branches** (as a drawer, not the picker) | **orphan** | `Drawer::Branches` |
| Browse **worktrees** | **orphan** | RPCs already exist: `worktree.list/create/open/remove` |
| Browse **remotes** | **orphan** | `Drawer::Remotes` |
| Browse **stashes** | **orphan** | `Drawer::Stashes` |
| Browse **tags** | **orphan** | `Drawer::Tags` |
| Compact Git footer in every view | **orphan** | branch + sync visible outside the SCM view |
| Context menu (`m`) | **orphan** | |

## Preview

| Feature | Status | Notes |
|---|---|---|
| Text preview | phase 9 | |
| Markdown preview (via `glow`) | phase 9 | |
| Image preview | — | needs terminal graphics; PLAN.md rules it out |
| Video poster frames (via `ffmpeg`) | — | same |
| Ephemeral tab, double-click to pin | **orphan** | needs a tab model we may not want |
| Mouse selection + clipboard copy in preview | **orphan** | |
| `w` wrap toggle, arrows / PageUp / PageDown | phase 9 | |
| Built-in editor (`e`) | — | **deliberately never.** We launch `$EDITOR` in a pane |

## Chrome, settings, keys

| Feature | Status | Notes |
|---|---|---|
| Activity bar switching three views | phase 8 | |
| `1` / `2` / `3` switch view | **partial** | works today by closing one panel and opening another |
| Unified vs separate Explorer / Source Control | phase 9 | |
| Dock left or right | phase 9 | sidebar is hard-coded to `x: 0` |
| Preferred width | **done** | `ui.sidebarWidth`, draggable |
| Icon theme (material / emoji / ascii) | phase 9 | |
| Colour theme | **done** | `resolveTheme`, plus `[theme]` overrides |
| Settings persist across restarts | **partial** | config file exists; no `[sidebar]` section |
| Auto-open / strict toggle / focus-on-open | **orphan** | |
| Per-tab "user hid it here" markers | N/A | `snooze.rs` — a herdr ensure-hook concern |
| Host keybindings → `show-explorer` etc. | **partial** | `C-b e` / `C-b g` exist; no `show-search`, no `quick-open` |

## Not applicable — we are the host, not a plugin

`launch.rs` (1,652), `ensure.rs` (527), `ipc.rs` (326), `main.rs` (483),
`lib.rs` (25), `snooze.rs` (45) are all about living inside herdr: pane
creation over herdr's socket API, docking, redeploy, and reopening after a
focus event. herdr-ts owns its own panes, so roughly **3,000 lines of
herdr-sidebar have no counterpart here by construction.** That is the single
biggest reason the port is smaller than the 26,496-line source.

## The orphans — read this before planning phase 9

**Nineteen rows above are marked orphan, and the largest cluster is the eight
Source Control drawers.** They are not an oversight of this table; PHASE-7 ruled
them out explicitly:

> No commit history, file history, stashes, tags or remotes browsing. Later, if
> ever — they are the least-used third of `scm_app.rs`.

That was a reasonable call for phase 7 and it is **not** a reasonable resting
place for the port, because herdr-sidebar's README lists them as a headline
feature: *"Browse commits, file history, branches, worktrees, remotes, stashes,
and tags."* Phases 8, 9 and 10 do not mention them. As the plan stands, they
never get built and nobody ever decides not to build them.

Three ways out, and one of them has to be chosen rather than defaulted into:

1. **Fold the drawers into phase 9.** They are mostly read-only `git log` /
   `git stash list` / `git tag` views over a list widget that already exists,
   and `worktree.*` RPCs are already shipped. Cheapest in code, but phase 9 is
   already the largest of the three.
2. **Add a phase 11.** Honest about the size; delays "parity" by one phase.
3. **Declare them out of scope for v1** in PLAN.md's key-decisions table, with
   the reasoning, so a future reader knows it was weighed and not forgotten.

The other orphans are smaller and mostly cluster in phase 9's territory
(context menus, hover actions, the Git footer, auto-open behaviour). Multi-repo
is the exception: `HANDOFF.md` already argues that following the focused pane
into exactly one repository is *the right shape for a multiplexer*, which is a
deliberate divergence, not a gap. If that argument holds, move that row from
orphan to a recorded divergence in PLAN.md.

## Deliberate divergences from herdr-sidebar

Keep this list short and keep it honest. Every row here is a place a user coming
from herdr-sidebar will notice a difference.

| What | Why |
|---|---|
| No built-in editor | We launch `$EDITOR` in a pane, which beats a worse editor. `editor.rs` is 1,157 lines and labelled experimental upstream. |
| No image or video preview | Needs terminal graphics protocols PLAN.md rules out. |
| Diffs and files open in a pager pane | The user has already chosen `bat` / `delta` / `less`. Phase 9 revisits whether an embedded preview replaces this. |
| ASCII glyphs by default | Nerd Font glyphs are Private Use Area; `codePointWidth` measures them as one column and a disagreeing terminal shifts every hit region. |
| One repository, not multi-repo | Switching pane switches repository. **Pending confirmation** — see the orphans section. |
