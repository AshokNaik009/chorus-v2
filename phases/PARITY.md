# herdr-sidebar parity — the checklist the sidebar phases are measured against

**The port target is herdr-sidebar.** This file is the inventory: every feature
it advertises, whether herdr-ts has it, and which phase owns it. Phases 7, 8, 9
and 11 are *how* we get there; this is *what done means*.

Orca (`/Users/ashoknaik/claude-experiments/orca`, MIT) is **not** a parity
target and never appears in this table. It is a solutions library — when we need
to build one of these rows in Node, orca has often already solved the mechanics.
Nothing in orca's product shape belongs here.

Measured **2026-09-20** at herdr-sidebar `1a5d37e`. Re-scored **2026-09-21** after
phase 9, against a working tree on top of herdr-ts `86fa8de`.
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
| Open a file | **done** | `$PAGER` in a pane, or the embedded preview with `[sidebar] preview` |
| Click a row to fold a folder or glance at a file | **done** | phase 10 fix; a click used only to move the highlight |
| File icons | **done** | `icons.ts`; three themes, `ascii` the default — see the divergences |
| Hover actions on a row | **orphan** | still unowned; the row menu covers the same actions |
| Context menu (`m` / Ctrl+right-click) | **done** | `m` opens it; entries differ for a file and a folder |
| Follow a neighbouring pane's cwd | **done** | `resolveCwd` reads the shell's live cwd |
| Manually chosen folder stays put | **partial** | `[sidebar] follow-pane` exists and is read; the pin is not wired |

## Search

| Feature | Status | Notes |
|---|---|---|
| Quick open (`Ctrl+P`), filter as you type | **done** | `search.ts`; one `search.files` call, filtered in the client |
| Content search (`Ctrl+F`) | **done** | shells out to `rg --json`; no engine of our own — see the divergences |
| Case / whole-word / regex toggles | **done** | `Alt-C` / `Alt-W` / `Alt-R`, each re-runs the search |
| Include / exclude glob filters | **done** | comma-separated, own focusable fields |
| Result caps reported honestly | **done** | matches / files / time, each named in the status line |
| Search-and-replace | — | herdr-sidebar does not have it either |

## Source Control

| Feature | Status | Notes |
|---|---|---|
| Stage / unstage / discard | **done** | rename-aware on both sides of the index |
| Commit | **done** | via the prompt line |
| Inspect diffs (`o`) | **partial** | opens a pager pane, not an in-panel diff |
| AI commit draft (`A`, ✧) via local `claude` CLI | **done** | `suggest.ts`, opt-in; filename draft is the default |
| Sync with upstream (`S`) | **done** | `pull --rebase --autostash` then `push` |
| Branch switch from the panel header | **done** | `branch.ts` picker, filterable |
| Create a local tracking branch from a remote | **done** | |
| Scrolling changes list | **done** | |
| One commit box **per repository** (multi-repo) | **orphan** | we follow one pane into one repo |
| Browse **commits** | phase 11 | `Drawer::Commits` |
| Browse **file history** | phase 11 | `Drawer::FileHistory` |
| Browse **graph** | phase 11 | `Drawer::Graph` |
| Browse **branches** (as a drawer, not the picker) | phase 11 | `Drawer::Branches` |
| Browse **worktrees** | phase 11 | RPCs already exist: `worktree.list/create/open/remove` |
| Browse **remotes** | phase 11 | `Drawer::Remotes` |
| Browse **stashes** | phase 11 | `Drawer::Stashes` |
| Browse **tags** | phase 11 | `Drawer::Tags` |
| Compact Git footer in every view | **done** | `[sidebar] git-footer`, off by default |
| Context menu (`m`) | phase 11 | drawer row menus; the changes-list menu is phase 9 |

## Preview

| Feature | Status | Notes |
|---|---|---|
| Text preview | **done** | `preview.ts`, both halves; bounded reads, binary refused |
| Markdown preview (via `glow`) | **done** | and `bat` / `delta`; absent is the plain path, not a failure |
| Image preview | — | needs terminal graphics; PLAN.md rules it out |
| Video poster frames (via `ffmpeg`) | — | same |
| Ephemeral tab, double-click to pin | — | **closed as a divergence**, see below |
| Mouse selection + clipboard copy in preview | **orphan** | |
| `w` wrap toggle, arrows / PageUp / PageDown | **done** | plus `←→` panning by display column |
| Built-in editor (`e`) | — | **deliberately never.** We launch `$EDITOR` in a pane |

## Chrome, settings, keys

| Feature | Status | Notes |
|---|---|---|
| Activity bar switching three views | **done** | `panel.ts`; word chips, clickable |
| `1` / `2` / `3` switch view | **done** | a real switch that keeps each view's cursor and scroll |
| Unified vs separate Explorer / Source Control | **done** | `[sidebar] layout`; `tab` moves between the halves |
| Dock left or right | **done** | `[sidebar] dock`; the grip and `«` move to the inner edge |
| Preferred width | **done** | `ui.sidebarWidth`, draggable |
| Icon theme (material / emoji / ascii) | **done** | `ascii` / `emoji` / `nerd`, width-checked per theme |
| Colour theme | **done** | `resolveTheme`, plus `[theme]` overrides |
| Settings persist across restarts | **done** | `[sidebar]` section; the write is now atomic and fsync'd |
| Auto-open / strict toggle / focus-on-open | **partial** | `remember-view` shipped; auto-open and strict are herdr-hook concerns |
| Per-tab "user hid it here" markers | N/A | `snooze.rs` — a herdr ensure-hook concern |
| Host keybindings → `show-explorer` etc. | **partial** | `C-b e` / `C-b g` / `C-b f` exist; quick open is `Ctrl+P` inside the dock only |

## Not applicable — we are the host, not a plugin

`launch.rs` (1,652), `ensure.rs` (527), `ipc.rs` (326), `main.rs` (483),
`lib.rs` (25), `snooze.rs` (45) are all about living inside herdr: pane
creation over herdr's socket API, docking, redeploy, and reopening after a
focus event. herdr-ts owns its own panes, so roughly **3,000 lines of
herdr-sidebar have no counterpart here by construction.** That is the single
biggest reason the port is smaller than the 26,496-line source.

**Phase 10 did not change a single row above, and that is the correct outcome.**
It built a *host* for herdr's plugins — `plugin install`, a manifest reader, a
pinned store, and a `$HERDR_BIN_PATH` shim — which is the other side of the line
this section draws. herdr-sidebar is what we are porting; `herdr-file-viewer` is
somebody else's plugin that now runs here unmodified. Neither fact scores against
the other, and a plugin is not a parity row. See `HANDOFF.md`.

One thing it did move, and it belongs in the Explorer table above rather than
here: clicking a row used only to move the highlight, so a folder looked inert
and a mouse user could not nest anything. A click now folds a directory and
previews a file.

## The orphans — what is still unowned

**Two rows above are still orphans, down from eight.** Phase 9 closed four of the
six it was expected to and turned the fifth into a divergence; the sixth is
half-built and named below.

Phase 9 closed: the Explorer context menu (`m`), the compact Git footer, the icon
themes and the docking/layout settings. It closed the ephemeral-preview-tab
question as a **divergence** rather than building it. It left `follow-pane`
readable but unwired, which is the honest half of "partial".

The largest cluster used to be the eight Source Control drawers. PHASE-7 ruled
them out explicitly —

> No commit history, file history, stashes, tags or remotes browsing. Later, if
> ever — they are the least-used third of `scm_app.rs`.

— which was reasonable for phase 7 and was not a reasonable resting place for
the port, because herdr-sidebar's README lists them as a headline feature and
phases 8-10 never picked them up. **Resolved: they are now `PHASE-11.md`**, a
phase whose whole job is to turn those rows green and which is independent of
phase 10.

What remains unowned, and what each one probably needs:

| Orphan | Where it likely belongs |
|---|---|
| Sidebar and preview visible at once | genuinely unowned, and the largest remaining shape difference. herdr-sidebar is a narrow tree *plus* a wide viewer; our dock shows one view at a time in ~34 columns, and the wide viewer is a `$PAGER` pane. Reported from a screenshot during phase 10 and written down here rather than answered. |
| A tabbed file header over the preview | genuinely unowned. Follows from the row above; there is nowhere to put tabs while the dock is one view. |
| Explorer hover actions | genuinely unowned. Every action a hover would offer is on the `m` menu now, which is most of the value for none of the mouse-tracking cost — so this may be worth closing rather than scheduling. |
| Mouse selection + clipboard copy in preview | blocked on the clipboard decision `PHASE-11.md` also raises (OSC 52) |

**Half-built, and named so it does not become an orphan again:**

| Row | What is missing |
|---|---|
| Manually chosen folder stays put | `[sidebar] follow-pane` is defined, validated and read, and **nothing acts on it**. The dock still follows the focused pane whatever it says. What it needs is a remembered root on `SidebarPanels` and a `resolveRoot` that prefers it — an afternoon, in whichever phase next touches `app.ts`'s geometry. |
| Auto-open / strict toggle / focus-on-open | `remember-view` shipped. The other two are herdr ensure-hook concerns with no host-side counterpart; see the N/A section. |

**Multi-repo is settled: it is a divergence, not a gap.** `HANDOFF.md` argued
that following the focused pane into exactly one repository is the right shape
for a multiplexer, where switching pane switches repository. Nothing in phases 8
or 9 found a case that argument does not cover, and the row has moved to the
divergences below. It was only ever an orphan because nobody had written the
decision down.

## Deliberate divergences from herdr-sidebar

Keep this list short and keep it honest. Every row here is a place a user coming
from herdr-sidebar will notice a difference.

| What | Why |
|---|---|
| No built-in editor | We launch `$EDITOR` in a pane, which beats a worse editor. `editor.rs` is 1,157 lines and labelled experimental upstream. |
| No image or video preview | Needs terminal graphics protocols PLAN.md rules out. |
| Diffs and files open in a pager pane | The user has already chosen `bat` / `delta` / `less`. **Phase 9 revisited this and did not reverse it**: the embedded preview is opt-in (`[sidebar] preview`, off) and is for glancing. `⏎` still opens a pane by default, and `⏎` inside the preview hands the file to `$PAGER`. |
| No syntax highlighting, even with `bat` installed | The dock paints its own styles and cannot consume ANSI, so `bat` is run with `--color=never`. What it contributes is the user's own wrapping, tab and encoding handling; the colour is the part that does not survive the trip. |
| ASCII glyphs by default | Nerd Font glyphs are Private Use Area; `codePointWidth` measures them as one column and a disagreeing terminal shifts every hit region. `[sidebar] icons` now offers `emoji` and `nerd` for anybody who knows their font. |
| One repository, not multi-repo | Switching pane switches repository, which is the right shape for a multiplexer. **Settled in phase 9**; it was an orphan only for want of a written decision. |
| No ephemeral preview tab | herdr-sidebar's preview is a tab you double-click to pin. **Settled in phase 9 as a divergence**: this project has no tab model for the dock and does not want one — the dock has views, and a view that is sometimes a tab would be a second concept for one feature. The preview is a view, reachable by `4` and by `⏎` when it is switched on. |
| Search needs `rg` installed | herdr-sidebar compiles ripgrep's `ignore` and `globset` crates in; there is no TypeScript equivalent worth the dependency. Quick open falls back to `git ls-files` inside a repository; content search says what to install. |
| Search is not incremental | herdr-sidebar re-runs content search on a debounce as you type. Ours runs on `⏎`. One submit per search is what its own parity row says, and a debounce over a shelled-out `rg` needs cancellation of the in-flight child first, which phase 9 did not build. |
| No search-and-replace | herdr-sidebar carries a `replace` field it never applies either. |
