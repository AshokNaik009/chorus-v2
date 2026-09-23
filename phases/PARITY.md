# herdr-sidebar parity — the checklist the sidebar phases are measured against

**The port target is herdr-sidebar.** This file is the inventory: every feature
it advertises, whether herdr-ts has it, and which phase owns it. Phases 7, 8, 9
and 11 are *how* we get there; this is *what done means*.

Orca (`/Users/ashoknaik/claude-experiments/orca`, MIT) is **not** a parity
target and never appears in this table. It is a solutions library — when we need
to build one of these rows in Node, orca has often already solved the mechanics.
Nothing in orca's product shape belongs here.

Measured **2026-09-20** at herdr-sidebar `1a5d37e`. Re-scored **2026-09-21** after
phase 9, and again after **phase 11**, against a working tree on top of herdr-ts
`489c86a`.
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
| Copy a hash / branch / URL / path | **done** | OSC 52, and it says so — see the divergences |
| AI commit draft (`A`, ✧) via local `claude` CLI | **done** | `suggest.ts`, opt-in; filename draft is the default |
| Sync with upstream (`S`) | **done** | `pull --rebase --autostash` then `push` |
| Branch switch from the panel header | **done** | `branch.ts` picker, filterable |
| Create a local tracking branch from a remote | **done** | |
| Scrolling changes list | **done** | |
| One commit box **per repository** (multi-repo) | **orphan** | we follow one pane into one repo |
| Browse **commits** | **done** | `git-drawers.ts`; `log --format=…`, structured rows |
| Browse **file history** | **done** | `--follow` with a `:(top)` pathspec, so it works from a subdirectory |
| Browse **graph** | **done** | git's own `--graph` rails, drawn as given; no DAG of ours |
| Browse **branches** (as a drawer, not the picker) | **done** | shares the picker's `for-each-ref` query — see the handoff |
| Browse **worktrees** | **done** | folder name + `⎇ branch`; Open and Remove are the phase-5 RPCs |
| Browse **remotes** | **done** | fetch lines only, rendered `owner/repo` |
| Browse **stashes** | **done** | apply / pop / drop, drop asks first |
| Browse **tags** | **done** | `--sort=-creatordate` |
| Compact Git footer in every view | **done** | `[sidebar] git-footer`, off by default |
| Context menu (`m`) | **done** | seven row menus, herdr-sidebar's table entry for entry |

## Preview

| Feature | Status | Notes |
|---|---|---|
| Text preview | **done** | `preview.ts`, both halves; bounded reads, binary refused |
| Markdown preview (via `glow`) | **done** | and `bat` / `delta`; absent is the plain path, not a failure |
| Image preview | — | needs terminal graphics; PLAN.md rules it out |
| Video poster frames (via `ffmpeg`) | — | same |
| Ephemeral tab, double-click to pin | — | **closed as a divergence**, see below |
| A narrow tree **beside** a wide viewer | **done** | the Preview view widens the dock to half the screen and keeps the tree on the left when ≥107 columns; clicking a row previews it beside itself |
| Mouse selection + clipboard copy in preview | **orphan** | the clipboard half exists now (`clipboard.ts`); the selection half does not |
| `w` wrap toggle, arrows / PageUp / PageDown | **done** | plus `←→` panning by display column |
| Built-in editor (`e`) | — | **deliberately never.** We launch `$EDITOR` in a pane |

## Chrome, settings, keys

| Feature | Status | Notes |
|---|---|---|
| A visible way into the dock | **done** | `▤ files` on the workspace strip's action row; `C-b e` was the only way in and nothing on screen said so |
| Branch and ahead/behind under each workspace | **done** | `git.summary`, one `status -uno` per workspace, fetched when the workspace list changes — never polled |
| Agents listed by workspace, then state · tool | **done** | phase 12: the **workspace** is the identity line, the tool is the dim one. Phase 11's `task · tool` used the pane title, and a pane title is not an identity |
| `grouped` toggle on the agents list | **orphan** | herdr groups agents by workspace; we list them worst-state first |
| Activity bar switching three views | **done** | `panel.ts`; word chips, clickable |
| `1` / `2` / `3` switch view | **done** | a real switch that keeps each view's cursor and scroll |
| Unified vs separate Explorer / Source Control | **done** | `[sidebar] layout`; `tab` moves between the halves |
| Dock left or right | **done** | `[sidebar] dock`; the grip and `«` move to the inner edge |
| Preferred width | **done** | `ui.sidebarWidth`, draggable; the default moved 22 → 30 in phase 12 |
| Rounded pane borders | **done** | phase 12: `ui.pane-borders = "round"`, and the default. `true` still means the square set |
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

**Phase 11 turned nine rows green, which was its whole purpose.** The eight Source
Control drawers and the row context menu are shipped and tested; the Source Control
section now has no `phase N` left in it, and **the port of herdr-sidebar's advertised
feature list is complete** apart from the named orphans and divergences below. One row
was added rather than turned: copy-to-clipboard, which the drawers needed and which
this project had never had at all.

**Phase 12 turned no row above, and that was its whole point.** It is a design phase —
a spacing unit, a type hierarchy, and a rule for what colour means — and none of that is
a feature this table can score. Two rows' *notes* changed because their implementation
did (the agents list and the default width), and one row was added for the rounded
borders, which is a `ui` key and not a herdr-sidebar feature. **Nothing in this file
measures what a surface looks like when it is all drawn at once**, which is exactly the
hole PHASE-12 exists to fill and why it has a rendered-buffer test suite instead of a row
here.

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

**Two rows above are still orphans, down from eight** — unchanged in count by phase
11, which closed nine rows that were *owned* rather than orphaned. One orphan did stop
being blocked: see the clipboard note in the table below.

Phase 9 closed four of the six it was expected to and turned the fifth into a
divergence; the sixth is half-built and named below.

Phase 9 closed: the Explorer context menu (`m`), the compact Git footer, the icon
themes and the docking/layout settings. It closed the ephemeral-preview-tab
question as a **divergence** rather than building it. It left `follow-pane`
readable but unwired, which is the honest half of "partial".

The largest cluster was the eight Source Control drawers. PHASE-7 ruled them out
explicitly —

> No commit history, file history, stashes, tags or remotes browsing. Later, if
> ever — they are the least-used third of `scm_app.rs`.

— which was reasonable for phase 7 and was not a reasonable resting place for
the port, because herdr-sidebar's README lists them as a headline feature and
phases 8-10 never picked them up. **Resolved, and now shipped:** `PHASE-11.md`
built all eight, and the rows above are green. The thing worth keeping from this
episode is not the drawers — it is that a deferral written in a "Do NOT do" list and
nowhere else survives exactly as long as nobody reads that phase document again.

What remains unowned, and what each one probably needs:

**A ninth row that this file cannot score, and that is the point.** Put our dock beside
herdr's and it still reads as a different class of program, while every row above says
done. Nothing here measures spacing, weight or what a colour means, so the gap was
invisible to the scoreboard until somebody looked at the two side by side. It is now
`PHASE-12.md`, which closes no row in this table on purpose.

| Orphan | Where it likely belongs |
|---|---|
| ~~Sidebar and preview visible at once~~ | **closed.** It was the largest remaining shape difference and it was a geometry bug, not a missing feature: the dock was capped at a third of the screen for every view, so the Preview drew a file in a list's column and truncated every line. The Preview view now asks for half the screen and puts the tree beside the file when there is room. |
| A tabbed file header over the preview | genuinely unowned. There is still nowhere to put tabs, but the row above no longer blocks it. |
| `grouped` on the agents list | genuinely unowned. Low value next to the rows it sits under. |
| Explorer hover actions | genuinely unowned. Every action a hover would offer is on the `m` menu now, which is most of the value for none of the mouse-tracking cost — so this may be worth closing rather than scheduling. |
| Mouse selection + clipboard copy in preview | **no longer blocked.** Phase 11 made the clipboard decision and shipped it: `clipboard.ts`, OSC 52, with a message that says a copy may have been ignored. What is missing is only the *selection* half — a drag in the preview that marks a range. Still unowned. |

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
| The dock hands the keyboard to what it opens | herdr-sidebar is its own pane, so this question does not arise there. Here the dock captured every keystroke for as long as it was open, which meant a file it opened in `$PAGER` could not be scrolled. It now dims and releases the keyboard when it opens a pane, and `C-b e` / a click take it back. |
| A worktree's menu says **Open Worktree**, not *Reveal in File Explorer* | There is no file explorer in a terminal multiplexer and no GUI to hand a path to. The intent — go and look at it — is a pane in that directory, which `worktree.open` has done since phase 5. |
| A copy says it might not have worked | OSC 52 has no reply and some terminals discard it silently. The alternative was dropping the four `Copy …` entries; a menu entry that quietly does nothing is worse than one that is honest about its uncertainty. |
| Drawers are collapsed until you open one | herdr-sidebar fetches its drawers alongside the status. Eight `git` invocations on every refresh, in a panel docked next to the shell you run git in, is how a sidebar becomes the reason a repository feels slow. |
