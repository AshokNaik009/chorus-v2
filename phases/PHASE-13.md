# Phase 13 — The Changes overlay: what the agents actually did

**Status: ✅ shipped.** `HANDOFF.md` is the authority on what landed.

## Why this phase existed

The sidebar answers *which agent needs me*. Nothing answered **what did it change**.

The only route was `o` in the Source Control view, which spawned `git diff` into a new
pane: the dock collapsed, the layout changed, and the reader got a pager to quit out of.

That was not an oversight. It was deferred three times, each time with a reason:

- `PHASE-11.md`: *"No in-panel diff. Phase 9 owns that question."*
- `PARITY.md` scored `Inspect diffs (o)` **partial** — the only non-done row left in the
  Source Control table.
- `HANDOFF.md` (phase 12) open threads: *"`Show Changes` is still a pager pane."*

And the reason was right **about the dock**: thirty-four columns cannot hold a diff, and
a bad one there would help nobody. What had never been tried is the other surface — the
whole terminal, over the dock rather than instead of it.

## The three decisions this phase rests on

**1. Full-screen overlay, not a fifth view.** Side-by-side needs width the dock does not
have. The overlay follows the pattern `settings.ts`, `prompt.ts`, `confirm.ts` and
`branch.ts` already share: a nullable field on `App`, an `xxxArea(cols, rows)`,
`handleKey`/`handleClick`, and a `render` called in z-order. It draws **over** the dock,
so `esc` puts the reader back on the file they were on.

**2. Parse in the daemon, style in the client.** `preview.ts:296` already wrote the
constraint down: *this dock paints its own styles and cannot consume ANSI* — which is
why `bat` runs `--color=never`. So `git diff --no-color` is parsed into hunks and lines
server-side and painted here. This is also PHASE-11's rule in a new shape: rows arrive
structured, and the client never recovers meaning from its own display text.

**3. Colour by role, no new theme keys.** `scm.ts:letterStyle` already borrows
`palette.agent.done` for green and `palette.agent.blocked` for red. A `diff-add-fg` pair
would mean a `ThemeConfig` field, an entry in every named theme and a config-schema
change, to arrive at the same two colours.

## What came from `herdr-file-viewer`, and what did not

The plugin was read end to end. **It has no diff parser.** `src/render.rs:259` pipes raw
`git diff` into `delta` on stdin and converts the returned ANSI back into spans via
`ansi-to-tui`; there is no `Hunk` type, no `@@` handling and no intra-line diffing
anywhere in its `src/`. Taking that route would have meant writing an ANSI-to-cell
parser first — a bigger and less useful program than the one this phase wrote.

What it *does* have, and what was taken, is its git invocation discipline:

| From | Landed as | Why |
|---|---|---|
| `--no-ext-diff --no-textconv` (`git.rs:223`) | `SAFE_DIFF_ARGS` | `diff.external` is repository-controlled, and an agent's fresh clone is where that bites |
| `diff --no-index -- /dev/null <path>` (`git.rs:264`) | `DiffService.untracked` | `git diff` omits untracked files, so a file an agent just wrote would be invisible |
| Ignoring `--no-index`'s exit status (`git.rs:543`) | commented at the call site | it exits **1** whenever the inputs differ, i.e. always |
| `MAX_UNTRACKED_DIFF_FILES = 512` (`git.rs:49`) | `DIFF_MAX_UNTRACKED = 64` | a byte cap bounds bytes, not *process spawns*; 64 because this is an overlay, not a viewer |

Verified against real git rather than assumed. The load-bearing finding: a **binary**
file emits no `---`/`+++` pair at all — just the header, an `index` line and
`Binary files … differ` — which is the entire reason `headerPaths()` exists.

Not taken: `--attr-source` probing, filter-driver neutering, `-U1000000` full-context,
`DiffRenderMode`, and the `Baseline::Base` merge-base mode. `worktree.ts:gitEnv()`
already covers `GIT_OPTIONAL_LOCKS=0` and the credential and locale guards.

## The file index, and why the overlay is two columns

A patch is a document; *what an agent touched* is a list. Showing only the document
means a twenty-one file change has no shape — you cannot see what was involved without
scrolling past all of it, and you cannot reach the ninth file except through the eighth.

So the overlay divides the way `panel.ts:previewAreas` already divides the dock: a
narrow list beside a wide viewer. The index carries a status letter and a head-elided
path, it shares the patch's cursor (`]`, `[` and a click all move one thing), and
clicking a row scrolls the patch to that file.

Three details that are decisions rather than defaults:

- **It gives way rather than being squeezed.** Below `INDEX_WIDTH + 1 + MIN_PATCH_WIDTH`
  it is dropped entirely: half an index beside half a patch is two things nobody can
  read. `i` also hides it, which is how a wide terminal gets the columns back for
  side-by-side.
- **A click sets the offset, it does not `follow` it.** `follow` moves the view as
  little as possible, so clicking a file already on screen would scroll nothing and the
  click would look broken. The file goes to the top row, or as near as the end allows.
- **The dividing rule disappears when the index scrolls.** `renderScrollbar`'s *track*
  is also a `│`, one column left, and the pair reads as a double rule.

Two helpers were exported rather than copied: `tail` from `preview.ts` (there were
already three private copies of those four lines) and `letterStyle` from `scm.ts`, so
the index and the Source Control list cannot disagree about what colour a `U` is.

## Five ways in, four of them clickable

A feature reachable only from `C-b D` is one most people never find. The sidebar had
already solved this once, with the `▤` files button, so this follows that shape:

| Where | What |
|---|---|
| `C-b D` | `client.changes`. `D` because `d` is detach |
| Sidebar action row | `± changes`, beside `▤ files` |
| A dirty workspace's branch line | the `*` that already means *uncommitted work here* |
| A hovered agent row | a `±`, revealed the way the pane count and `x` are |
| The dock's activity bar | a `diff` chip |
| Source Control branch line | a `±`, flush right |

Two width decisions are load-bearing and were both caught by existing tests:

- **The action row's ladder degrades `changes` before `files`.** Phase 12 fixed 22
  columns as the width where `▤ files` still reads as a word; a narrow form that cost
  `files` its label would have quietly undone that.
- **The chip is labelled `diff`, not `changes`.** The four existing chips spend 26 of the
  dock's 34-column minimum, so `changes` would have pushed the row to 35 and
  `activityZones` would have dropped the chip entirely at the default width.

`±` is U+00B1, Latin-1 Supplement, unambiguously **Narrow**. `▤` is East-Asian
*Ambiguous* and was accepted anyway; one such gamble in this strip is enough.

## What is deliberately not here

- **No merge-base baseline.** The overlay shows the working tree against `HEAD`, which is
  the same data the Source Control list shows — so the list and the diff cannot disagree.
  It therefore shows **nothing for an agent that commits as it goes**, which Claude Code
  does. `herdr-file-viewer`'s `b` key (`Baseline::Base`, `git merge-base <base> HEAD`) is
  the fix and is the single most valuable follow-up. The plumbing is in place: it is a
  `baseline` field on `GitDiffParams` and an `against` ref in `DiffService.diff`.
- **No full-file diff** (`-U1000000`). Cheap: the `context` param already exists.
- **No intra-line highlighting.** `delta` does this; nothing here does. It needs a word
  diff of its own.
- **No staging from inside the overlay.** `s` toggles which side is *shown*; it does not
  stage. Staging stays in the Source Control view, which is built for it.
- **`Show Changes` on the commits and stashes drawers is still a pager pane.** Retargeting
  it needs a commit-range baseline, which is the same missing piece as the first item.
- **No syntax highlighting**, which remains a `PARITY.md` divergence for the same reason
  as everywhere else in the dock.
