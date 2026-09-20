# Phase 8 — Search, navigation, and the activity bar

**Read `../PLAN.md`, `../HANDOFF.md` and `PARITY.md` first.**

**The port target is herdr-sidebar.** `PARITY.md` lists the rows this phase has
to turn green; `explorer_app.rs` is what they should look like and how they
should behave. Orca appears in this document only as a solutions library — when
a row needs building in Node, orca has usually already hit the traps. Read
herdr-sidebar for *what*, orca for *how*, and never let the second one decide
the first.

## Why this phase

The Explorer can only find a file you already know the path of. Search is the
third of herdr-sidebar's activity views and the one that changes how the panel
is used: quick open replaces a `cd` and an `ls`, content search replaces leaving
the terminal.

This phase also turns two panels that happen to share a dock into one panel with
views. Phase 7 leaves `C-b e` and `C-b g` opening separate objects that each
close the other by hand; a third view is the point at which that stops scaling.

## What parity means for this phase

From `PARITY.md`, the Search section — every row is this phase's:

| Row | herdr-sidebar's behaviour |
|---|---|
| Quick open (`Ctrl+P`) | filter as you type over the file list |
| Content search (`Ctrl+F`) | one submit per search, results grouped by file |
| Case / whole-word / regex | `Alt-C` / `Alt-W` / `Alt-R`, toggles redraw the result set |
| Include / exclude globs | comma-separated, their own focusable fields |
| Result caps | reported, never silent |

Plus one row from the chrome section: the **activity bar**, which is what makes
three views one panel. `1`/`2`/`3` already half-work by closing one panel and
opening another; this phase makes them a real switch that keeps each view's
cursor and scroll.

## Source material

### herdr-sidebar — the port target

Measured **2026-09-20** at herdr-sidebar `1a5d37e`. **Read `explorer_app.rs`
yourself**; this table says where to look, not what it says.

| File | Lines | What to take |
|---|---|---|
| `…/herdr-sidebar/src/explorer_app.rs` | 5,321 | `QuickOpen` (~204), `ContentSearch` (~212), `SearchOptions` (~231), `SearchFocus` (~238), `ContentSearchResult` (~270), the caps at 4,145 |
| `…/herdr-sidebar/src/tree.rs` | 307 | Tree model, if ours needs revisiting |
| `…/herdr-sidebar/src/ui.rs` | 999 | Activity bar and view switching |

Its caps and its keys, both worth keeping:

```rust
QUICK_OPEN_FILE_LIMIT      = 20_000
CONTENT_SEARCH_MATCH_LIMIT =  1_000
CONTENT_SEARCH_FILE_LIMIT  = 20_000
CONTENT_SEARCH_MAX_BYTES   = 1 MiB
```

`Alt-C` case, `Alt-W` whole word, `Alt-R` regex; `1`/`2`/`3` switch view in
VS Code's activity-bar order, and bare digits switch only while the search box
is *not* focused, because a focused box must be able to type `3`.

herdr-sidebar compiles ripgrep's `ignore` and `globset` crates **into** its
binary. We cannot and should not — there is no TypeScript equivalent worth the
dependency, and this project already delegates to installed tools. Shell out to
`rg`, and degrade honestly.

### What orca already knows — mechanics only

Measured **2026-09-20** at orca `061a756b84`. Orca is **not** a parity target
and its product shape is not ours; what it has is a working `rg` integration in
Node. Take the mechanics, decide the behaviour from herdr-sidebar. Every one of
the following is a mistake this phase would otherwise make.

| Orca file | Lines | What it knows |
|---|---|---|
| `src/shared/text-search.ts` | — | `buildRgArgs`, `ingestRgJsonLine`, every cap |
| `src/relay/fs-handler-utils.ts` | 233 | `searchWithRg` — why `spawn`, not `execFile` |
| `src/relay/fs-handler-list-files.ts` | 339 | `listFilesWithRg` for quick open |
| `src/relay/fs-list-files-fallback-chain.ts` | 109 | rg → `git ls-files` → readdir, and when each applies |
| `src/shared/ripgrep-process-availability.ts` | 146 | "rg is missing" vs "rg could not start" |
| `src/shared/quick-open-install-rg.ts` | 97 | the per-platform install line |
| `src/shared/text-search-match-accumulator.ts` | — | clipping a long line **around the match** |

**1. `--json` is the answer to "unambiguous output".** Not `--vimgrep`, whose
`path:line:col:text` is ambiguous for a path containing a colon. rg's JSON Lines
give `data.path.text`, `data.line_number`, `data.lines.text` and
`data.submatches[]` as structured fields. (For the *file list*, `rg --files` is
enough.)

**2. `spawn`, never `execFile`.** Orca's comment is explicit: `execFile` buffers
stdout internally and kills the child at `maxBuffer` *even with `data` listeners
attached*, and its silent buffer-exceeded error resolves the result as
`truncated: false` **despite dropping matches**. Under rg's verbose `--json` a
50 MB buffer fills well before the match cap. A capped search that reports
`truncated: false` is the one lie this feature must not tell. Note our existing
`runGit` is `execFile` with an 8 MB cap — search cannot reuse it.

**3. The exact argv.** Orca's `buildRgArgs`, which is the thing to port:

```ts
['--json', '--hidden', '--glob', '!.git',
 '--max-count', String(MAX_MATCHES_PER_FILE),     // 100, per file
 '--max-filesize', '5M',
 ...(caseSensitive ? [] : ['--ignore-case']),
 ...(wholeWord     ? ['--word-regexp'] : []),
 ...(useRegex      ? [] : ['--fixed-strings']),
 ...include.flatMap((p) => ['--glob', p]),
 ...exclude.flatMap((p) => ['--glob', `!${p}`]),
 '--', query, target]
```

`--` before the query, or a query starting with `-` parses as a flag.
`--max-count` is **per file**, so it does not replace a global cap. For the
file listing, orca adds `--no-messages` (permission-denied noise on `.ssh` and
root-owned mounts would otherwise flood stderr) and spawns with `cwd: rootPath`,
because root-relative exclude globs are evaluated against rg's working
directory — without the `cwd`, nested exclusions silently stop working.

**4. A failed spawn is not a missing binary.** Orca keeps
`RipgrepUnavailableError` and `RipgrepLaunchFailureError` apart, and treats
`EAGAIN`, `EMFILE`, `ENFILE`, `ENOMEM`, `ETXTBSY` as transient — fork/exec
pressure is not evidence that ripgrep is uninstalled. Telling someone to
`brew install ripgrep` when they are out of file descriptors is wrong advice.
Two more traps in that file: a spawn that failed has `child.pid === undefined`,
and **calling `.kill()` on that handle signals your own process group**; and a
queued spawn `error` can arrive after you have already settled, so it needs a
no-op listener or it takes the process down.

**5. The install line is per-platform**, not "install ripgrep":
`brew install ripgrep` on darwin; on linux, parse `ID` and `ID_LIKE` from
`/etc/os-release` for apt / dnf / pacman / apk, with a generic fallback.
Take `detectInstallCommand()` almost verbatim.

**6. Clip a long line *around the match*, not from the start.** Orca's
`clampLineContext` at `MAX_LINE_CONTENT_LENGTH = 500` centres a window on the
match, prefixes and suffixes `…`, and keeps the **true** column separate from
the **display** column so "open at that line" still lands correctly. A minified
file's one 200 KB line matched at column 150,000 shows nothing useful if you
clip the first 500 characters.

**7. Decode chunks with `StringDecoder`.** A UTF-8 filename can be split across
a stream chunk boundary; stateful decoding keeps the JSON record intact. Orca
hit this on git's porcelain stream and the same applies to rg's.

**8. Orca's caps, for comparison with herdr's:**

```
MAX_MATCHES_PER_FILE  = 100          SEARCH_TIMEOUT_MS      = 15_000
SEARCH_MAX_FILE_SIZE  = 5 MiB        LIST_FILES_TIMEOUT_MS  = 25_000
MAX_LINE_CONTENT_LENGTH = 500        DEFAULT_MAX_RESULTS    = 2_000
```

A **timeout that marks the result truncated** and kills the child is a cap this
phase would otherwise forget. Set `truncated = true` in the same tick you decide
to stop — orca documents that as an invariant, because a caller that resolves
first reports a capped search as complete.

## Deliverables

```
packages/daemon/src/search.ts       # rg invocation, parsing, limits
packages/daemon/src/rpc/search.ts   # search.files / search.content
packages/client/src/search.ts       # both search views
packages/client/src/panel.ts        # the container: views, activity bar, switching
```

**The activity bar is a refactor, so do it first.** Moving `ScmPanel` and
`ExplorerPanel` behind a container before adding two more views is much cheaper
than after. The container owns: which view is active, the dock width, the
keyboard capture, and the status-bar hint. Each view keeps its own state and its
own `handleKey` returning an outcome — that split already works, do not undo it.

**Quick open filters in the client, not the daemon.** One `search.files` call on
open, then filter the cached list as the user types. An RPC per keystroke over a
20,000-entry list is a round trip for something that is a string compare.
Content search is the opposite: one RPC per submit.

**`rg` is optional, and its absence is a message, not a crash.** `git ls-files
-z --cached --others --exclude-standard` is a reasonable quick-open fallback
inside a repository. Detect the repository with `git rev-parse
--is-inside-work-tree`, **not** by looking for a `.git` entry — orca's comment
says why: the latter fails from a subdirectory of a checkout and falls through
to a listing full of ignored build artifacts.

**Content search has no fallback.** Orca ships a `git grep` one
(`buildGitGrepArgs`: `-n -I --null --no-color --untracked
--no-recurse-submodules`, `--null` for colon-containing paths,
`-c submodule.recurse=false` because `submodule.recurse=true` conflicts with
`--untracked`). **We are not porting it in this phase** — two engines that
disagree on regex dialect (`git grep` needs `--extended-regexp`) means results
differ by machine, which is worse than an honest "install ripgrep". The args are
recorded here so phase 9 can reconsider without re-deriving them.

**Bound every result set in the daemon, not the client.** Cap results, cap line
length, cap time, and report which cap was hit.

**Search runs against the panel's root**, which Phase 7 established as the
repository, or the pane's live cwd outside one. Reuse `resolveCwd` in
`rpc/git.ts` rather than inventing a second notion of "where".

## Environment note for whoever runs this

**`rg` is not installed on the development machine as of 2026-09-20.** `which
rg` finds only a zsh shim that proxies to the `claude` binary; `execFile('rg')`
from Node gets `ENOENT`. Two consequences:

- Criterion 6 (rg absent) is the path that tests for free here.
- The rg-**present** paths need an injectable runner, the way `GitService` takes
  a `GitRunner`. Do that from the start; do not discover it at test time.
- The daemon's `PATH` is not the user's interactive `PATH`. A daemon spawned
  outside a login shell may not see a `rg` the user can run — orca augments
  `PATH` with `~/.local/bin`, `~/.cargo/bin`, Homebrew and friends for exactly
  this. "Not installed" and "not on *our* `PATH`" are different claims and the
  message should not confuse them.

## Acceptance criteria

1. `pnpm test` green.
2. Quick open lists files under the root, filters as you type, and opens the
   selection in a pane. Ignored files are absent.
3. Content search returns file, line number and the matching line; opening a
   result opens that file **at that line** in the user's pager.
4. Case-sensitivity, whole-word, regex, and include/exclude filters each change
   the result set, each covered by a test.
5. A search whose results exceed the cap reports that it was capped. Test with a
   deliberately tiny cap rather than a huge repository. **Also test the timeout
   cap**, and assert `truncated` is true in both.
6. With `rg` absent from `PATH`: quick open still works inside a repository via
   the fallback, content search says what is missing **with the platform's
   install line**, and neither throws. Test by controlling `PATH`, the way
   `packages/client/src/sound.ts` is tested.
7. A transient spawn failure (`EMFILE`) is **not** reported as "ripgrep is not
   installed". One test, against the classifier.
8. A matching line longer than the clip cap is windowed around the match, and
   opening that result still lands on the right line.
9. The activity bar switches Explorer, Search and Source Control; `1` `2` `3`
   do the same; each view keeps its cursor and scroll across a switch.
10. No regression in `bench/RESULTS.md`.

## Do NOT do in this phase

- No file preview and no syntax highlighting. Phase 9.
- No icons. Phase 9.
- No editor. Not planned at all — see PHASE-9's note.
- No search-and-replace. herdr-sidebar does not have it either.
- No `git grep` fallback. Recorded above for phase 9 to reconsider.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The exact `rg` invocation as it landed, and how the JSON is parsed
- The caps you chose, what happens at each one, and how `truncated` is set
- What quick open does without `rg`, and what content search does
- How "rg missing" is told apart from "rg failed to start", and what each says
- The container's contract: how a view is registered, what it owns, what the
  container owns
- Whether any view needed to break the "state here, actions at the call site"
  split, and why
- **Anything orca was wrong about, or that did not transfer.** The section above
  is this phase's biggest untested assumption: it is orca's code read, not
  orca's code run.
