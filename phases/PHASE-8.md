# Phase 8 — Search, navigation, and the activity bar

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase

The Explorer can only find a file you already know the path of. Search is the
third of herdr-sidebar's activity views and the one that changes how the panel
is used: quick open replaces a `cd` and an `ls`, content search replaces leaving
the terminal.

This phase also turns two panels that happen to share a dock into one panel with
views. Phase 7 leaves `C-b e` and `C-b g` opening separate objects that each
close the other by hand; a third view is the point at which that stops scaling.

## Source material

Measured **2026-09-20** at herdr-sidebar `1a5d37e`.

| File | Lines | What to take |
|---|---|---|
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/explorer_app.rs` | 5,321 | `QuickOpen` (line ~204), `ContentSearch` (~212), `SearchOptions` (~231), `SearchFocus` (~238), `ContentSearchResult` (~270) |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/tree.rs` | 307 | Tree model, if ours needs revisiting |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/ui.rs` | 999 | Activity bar and view switching |

herdr-sidebar compiles ripgrep's `ignore` and `globset` crates *into* its binary
so quick open honours ignore files without an `rg` executable. **We cannot and
should not.** There is no equivalent TypeScript library worth the dependency, and
this project already delegates to installed tools — `git diff` for diffs, the
user's pager for files. Shell out to `rg`, and degrade honestly when it is
absent (see below).

## Deliverables

```
packages/daemon/src/search.ts       # rg invocation, parsing, limits
packages/daemon/src/rpc/search.ts   # search.files / search.content
packages/client/src/search.ts       # both search views
packages/client/src/panel.ts        # the container: views, activity bar, switching
```

**`rg` is optional, and its absence is a message, not a crash.** Check once per
call, and when it is missing say so in the panel with the install line. A quick
open that silently returns nothing is indistinguishable from a repository with no
files. `git ls-files` is a reasonable fallback for *quick open* inside a
repository — it is already there and already honours `.gitignore` — but there is
no fallback for content search worth shipping; say so rather than grepping the
tree by hand.

**Bound every result set in the daemon, not the client.** A content search for
`e` across a monorepo is millions of matches, and a client that receives them has
already lost. Cap results, cap line length, and report that the cap was hit.
`PLUGIN_COMMAND_OUTPUT_MAX_BYTES` in herdr is the same idea.

**Search runs against the panel's root**, which Phase 7 established as the
repository, or the pane's live cwd outside one. Resolve it the same way
(`resolveCwd` in `rpc/git.ts`) rather than inventing a second notion of "where".

**The activity bar is a refactor, so do it first.** Moving `ScmPanel` and
`ExplorerPanel` behind a container before adding two more views is much cheaper
than after. The container owns: which view is active, the dock width, the
keyboard capture, and the status-bar hint. Each view keeps its own state and its
own `handleKey` returning an outcome — that split already works, do not undo it.

## Acceptance criteria

1. `pnpm test` green.
2. Quick open lists files under the root, filters as you type, and opens the
   selection in a pane. Ignored files are absent.
3. Content search returns file, line number and the matching line; opening a
   result opens that file **at that line** in the user's pager.
4. Case-sensitivity, whole-word, regex, and include/exclude filters each change
   the result set, each covered by a test.
5. A search whose results exceed the cap reports that it was capped. Test with a
   deliberately tiny cap rather than a huge repository.
6. With `rg` absent from `PATH`: quick open still works inside a repository via
   the fallback, content search says what is missing, and neither throws. Test by
   controlling `PATH`, the way `packages/client/src/sound.ts` is tested.
7. The activity bar switches Explorer, Search and Source Control; `1` `2` `3`
   do the same; each view keeps its cursor and scroll across a switch.
8. No regression in `bench/RESULTS.md`.

## Do NOT do in this phase

- No file preview and no syntax highlighting. Phase 9.
- No icons. Phase 9.
- No editor. Not planned at all — see PHASE-9's note.
- No search-and-replace. herdr-sidebar does not have it either.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The exact `rg` invocation and how results are parsed, including which flag
  makes the output unambiguous for paths with colons in them
- The caps you chose, and what happens at each one
- What quick open does without `rg`, and what content search does
- The container's contract: how a view is registered, what it owns, what the
  container owns
- Whether any view needed to break the "state here, actions at the call site"
  split, and why
