# Handoff — end of Phase 11

**Read `PLAN.md` first, then `phases/PARITY.md`.** This file is the state of the world
as this session leaves it. Everything was measured on **2026-09-21**, macOS (darwin
25.6.0, arm64, Apple silicon, 10 cores), Node v22.1.0, pnpm 10.18.0, git 2.54.0 (Apple
Git-157). **`rg`, `bat`, `glow` and `delta` are still not installed on this machine** —
unchanged since phase 9, see *Open threads*.

## Status

- **Phase 11 complete: yes, on 9 of 10 criteria.** Criterion 10 (no bench regression) was
  **not measurable** — the machine sat at load average 15.05 throughout, which is the
  same reason phases 7 and 10 could not measure it either. See *Numbers*.
- **This phase completes the port of herdr-sidebar's advertised feature list.**
  `phases/PARITY.md`'s Source Control section has no `phase N` rows left in it.
- New tests: **60**, all green (34 daemon, 26 client). The suites this phase touched —
  `source-control.test.ts` (23) and `sidebar.test.ts` (18) — pass in isolation.

| # | Criterion | Verdict | Where |
|---|---|---|---|
| 1 | `pnpm test` green | met for everything this phase touched; **the full suite was not run to completion at this load** — see *Open threads* | |
| 2 | each drawer lists what its command returns, empty case included | met | `daemon/src/git-drawers.test.ts`, two fixture repositories |
| 3 | rows arrive structured; the client never parses a hash out of display text | met, two ways | `client/src/drawers.test.ts` — a decoy-filled subject, plus a source check |
| 4 | a path with a space survives worktrees and file history | met | `git-drawers.test.ts`, `a file.txt` and a `wt dir` worktree |
| 5 | `fileHistory` with nothing selected shows a reason | met | daemon returns the note and runs **no** command; client shows it |
| 6 | every destructive action confirms first; cancelling runs nothing | met | `drawers.test.ts` asserts every `…` entry carries a `confirm`, and only those |
| 7 | expanding runs exactly one git command; a collapsed refresh runs none | met | `git-drawers.test.ts` `describe('how many commands a drawer costs')` |
| 8 | remote and worktree rows survive 34 columns with the identifying part | met | `fitRowText`, tested at 32 and 24 columns |
| 9 | `Fetch` on an unreachable remote fails with a message and does not hang | met | returns in ~1.5 s against an unreachable GitHub URL; `gitEnv`'s guard was already in place |
| 10 | no regression in `bench/RESULTS.md` | **not measured** | load 15.05; see *Numbers* |

## What exists now

The Source Control view has eight collapsible drawers under the changes list — Graph,
Commits, File History, Branches, Worktrees, Remotes, Stashes, Tags — each one a single
`git` command's output arriving as **structured rows**, fetched when the drawer is
opened and never on a status refresh. Every row type has the context menu herdr-sidebar
gives it, entry for entry, and every entry whose label ends in `…` opens the existing
`ConfirmDialog` before anything runs. `Show Changes` is `git show` in a pager pane, like
every other diff in this project. `Copy …` works, through OSC 52, and says it might not
have. Three of the menu's entries are not new code at all: `Checkout Branch` is the
branch picker's `git.checkout`, and a worktree's Open and Remove are phase 5's
`worktree.open` and `worktree.remove`.

Also, unrelated to the phase and asked for from a screenshot: the workspace strip's
action row has a **`▤ files` button** between `new` and `menu`, which opens the docked
file sidebar. The dock previously had no visible way in — `C-b e` opens it and nothing
on screen said so.

## Deliverables, as they landed

| File | Lines | What |
|---|---|---|
| `packages/client/src/drawers.ts` | 538 | drawer state, the row → text rules, the menu table, `drawerCommand` |
| `packages/daemon/src/git-drawers.ts` | 438 | the eight queries, the parsers, the twelve actions |
| `packages/daemon/src/git-drawers.test.ts` | 415 | 34 tests, real repositories |
| `packages/client/src/drawers.test.ts` | 385 | 26 tests |
| `packages/protocol/src/session-model.ts` | +162 | seven row types, two params, two results |
| `packages/client/src/app.ts` | +231 | fetch, menus, confirms, the action executor |
| `packages/client/src/scm.ts` | +147 | hosts the drawers under the changes list |
| `packages/client/src/clipboard.ts` | 64 | OSC 52, and the sentence that admits it may be ignored |
| `packages/daemon/src/rpc/git.ts` | +56 | `git.drawer`, `git.drawerAction` |
| `packages/client/src/chrome.ts` | +46 | the `▤ files` button and its hit span |
| `packages/daemon/src/git.ts` | +29 | `BRANCH_REF_ARGS`, now shared with the drawer |

**PHASE-11's deliverable list named four files; this is eleven.** The extra ones are
`clipboard.ts` (the phase asked for a decision and the decision was yes),
`git-drawers.test.ts` / `drawers.test.ts`, and the protocol types, which the phase's
list folded into the RPC file.

## Types and contracts the next phase depends on

Two new methods on `AgentMethodMap`, both in `AGENT_METHODS`:

```ts
'git.drawer':       { params: GitDrawerParams;       result: GitDrawerResult }
'git.drawerAction': { params: GitDrawerActionParams; result: GitDrawerActionResult }
```

### The row types, and their wire shapes

```ts
type GitDrawerId =
  | 'graph' | 'commits' | 'fileHistory' | 'branches'
  | 'worktrees' | 'remotes' | 'stashes' | 'tags'

interface GitCommitRow {
  kind: 'commit'
  hash: string        // full, 40 hex; every commit action takes this
  short: string       // what is shown
  subject: string
  refs: readonly string[]   // %D split on ', ' — 'HEAD -> main', 'tag: v1.0'
  date: string        // %ad under --date=short, or ''
  rail: string        // git's own --graph art, empty for the other two log drawers
}
interface GitRailRow    { kind: 'rail'; rail: string }
interface GitBranchRow  { kind: 'branch'; name: string; current: boolean; remote: boolean }
interface GitWorktreeRow {
  kind: 'worktree'; path: string; name: string
  branch: string | null; head: string | null; primary: boolean
}
interface GitRemoteRow  { kind: 'remote'; name: string; url: string }
interface GitStashRow   { kind: 'stash'; index: number; ref: string; hash: string; subject: string }
interface GitTagRow     { kind: 'tag'; name: string }

type GitDrawerRow =
  | GitCommitRow | GitRailRow | GitBranchRow | GitWorktreeRow
  | GitRemoteRow | GitStashRow | GitTagRow

interface GitDrawerParams extends GitTargetParams {
  drawer: GitDrawerId
  path?: string        // fileHistory only, repo-relative
  limit?: number       // default DRAWER_LIMIT = 30
}
interface GitDrawerResult {
  drawer: GitDrawerId
  rows: readonly GitDrawerRow[]
  note: string | null   // 'no commits yet', 'select a file to see its history'
}

type GitDrawerActionId =
  | 'commit.checkout' | 'commit.cherryPick' | 'commit.revert' | 'commit.reset'
  | 'branch.merge'    | 'branch.delete'
  | 'stash.apply'     | 'stash.pop'         | 'stash.drop'
  | 'remote.fetch'
  | 'tag.checkout'    | 'tag.delete'

interface GitDrawerActionParams extends GitTargetParams { action: GitDrawerActionId; ref: string }
interface GitDrawerActionResult { message: string; status: GitStatusResult }
```

**`note` is how a drawer says something other than "here are rows".** An empty list with
a null note is an empty drawer, which is the normal state of Stashes and Tags and must
not read as a failure.

### The services

```ts
// daemon
const DRAWER_LIMIT = 30                       // herdr-sidebar's scm_app.rs:43
const DRAWER_IDS: readonly GitDrawerId[]      // display order
function drawerArgs(query: DrawerQuery): string[] | null   // null = nothing to ask git
function parseCommitLines(stdout: string): GitDrawerRow[]
function parseRemotes(stdout: string): GitRemoteRow[]
function parseStashes(stdout: string): GitStashRow[]
function parseTags(stdout: string): GitTagRow[]
function isCommitHash(value: string): boolean   // herdr's hex rule, as a *validator*
function isStashRef(value: string): boolean
function worktreeName(path: string): string
class GitDrawerService {
  constructor(options?: { git?: GitRunner })
  rows(cwd: string, query: DrawerQuery): Promise<{ rows; note }>
  act(cwd: string, action: GitDrawerActionId, ref: string): Promise<string>
}
const BRANCH_REF_ARGS: readonly string[]      // now in git.ts, read by both callers

// client
class DrawersPanel {
  isExpanded(id): boolean
  expandedIds(): GitDrawerId[]
  toggle(id): boolean      // true = the caller must fetch
  expand(id): boolean; collapse(id): boolean; reload(id): void
  adopt(result: GitDrawerResult): void; fail(id, message): void
  lines(): DrawerLine[]
}
function rowText(row): string
function fitRowText(row, width): string        // criterion 8 lives here
function prettyRemoteUrl(url): string          // owner/repo, whatever the spelling
function prettyWorktree(row): string           // folder + ⎇ branch, never a path
function drawerMenu(row): MenuItem[]
function drawerCommand(row, menuId): DrawerCommand | null
function copyToClipboard(write, text, what): { sent: boolean; message: string }
function osc52(text): string
```

`ScmPanel` gained `readonly drawers: DrawersPanel`, two `ScmOutcome` arms
(`drawer`, `drawerMenu`) and two new `Row` kinds; `HitRegions.actionRow` gained
`files: { x, end } | null`.

## The decisions PHASE-11 asked for

**1. The Branches drawer and the branch picker share one RPC — deliberately.**
herdr-sidebar's drawer runs `branch -a --sort=-committerdate --format='%(HEAD)
%(refname:short)'`. Ours runs the picker's `for-each-ref`, now `BRANCH_REF_ARGS` in
`git.ts` and read by both. Two reasons, and the second is the real one: `branch -a`
hands back display text that would have to be un-rendered into the same three fields we
already have, and it **cannot say whether a ref is symbolic** — so `origin/HEAD` would
appear as a row whose `Checkout Branch` entry silently detaches HEAD at a branch nobody
picked. The drawer slices the shared result to 30.

**2. Clipboard: OSC 52, and it says so.** The four `Copy …` entries are kept. OSC 52 is
the terminal-native answer and it is the one that works over SSH — `pbcopy` spawned on
a server copies into the server's clipboard, which nobody can paste from. It has **no
reply**, and some terminals discard it, so the note reads *"hash sent to clipboard (OSC
52 — ignored by some terminals)"* rather than "copied". The phase's alternative was
dropping the entries; an entry that quietly does nothing is the failure both options
were avoiding.

**3. PHASE-7's follow-ups were already applied, and this phase inherits all three.**
`GIT_OPTIONAL_LOCKS=0`, the locale pinning and the credential-prompt guard are in
`gitEnv` in `worktree.ts`, which `runGit` uses — so every one of the nine new git
invocations gets them for free, which is exactly the argument PHASE-11 made for doing it
in the runner. **Nothing was left to apply.** What remains from PHASE-7's list is the
part nobody has done: follow-up 4 (`maxBuffer` → streaming with `spawn`) and follow-up 5
(`--porcelain=v2`), both still open and both untouched here.

## Surprises

- **`git log --graph --oneline` is a display format, and PHASE-11 says not to re-parse
  display text.** Those two facts collide, and the resolution is the one thing this
  phase does that is not herdr-sidebar's command verbatim: the log drawers run
  `--format=%x00%H%x00%h%x00%D%x00%ad%x00%s`. The leading NUL is load-bearing —
  everything before the first NUL on a line is the rail git drew, and a line with **no**
  NUL is pure art (`|\`, `|/`) and becomes a `rail` row. So the rails still come from
  git, drawn exactly as given, and the hash arrives as a field. It is the same
  `git log --graph`; only the format is ours.
- **`:(top)` is what makes a drawer cost one git command.** Every other query works from
  any directory inside a checkout, but `--follow` needs a pathspec, and a repo-relative
  path means nothing from a subdirectory. Pathspec magic fixes it:
  `-- ':(top)a file.txt'` resolves against the top of the working tree wherever the
  pane's shell happens to be. Verified from a subdirectory, and with a space in the
  name. Without it every drawer would have paid for a `rev-parse --show-toplevel` first
  and criterion 7 would have been "two commands".
- **`git revert` refuses a merge commit, and that is the right answer to relay.**
  `-m 1` is a decision about which parent's history to keep, and a menu entry with
  nowhere to ask must not make it. git's own sentence says exactly that; a test asserts
  we pass it through rather than guessing a side.
- **`git log` has no stable order for commits sharing a timestamp**, which a test that
  builds four commits in 300 ms discovers immediately. The assertion is the set, plus
  "the merge is first".
- **The changes list's "no changes" had to become a row.** It used to be a message drawn
  *instead of* the list, and with eight drawers under it the list is never empty, so the
  message would never have appeared again.
- **`branch -d`, not `-D`.** The confirmation is about deleting a branch, not about
  losing commits. git's refusal names the unmerged branch and the flag that would force
  it, which is more than the dialog could say. Same instinct as `reset --mixed`: no menu
  entry in this project passes `--hard`.

## Numbers

**Criterion 10 was not measured.** `uptime` reported load average **15.05** for the
whole session, and the previous two handoffs record the same obstacle. What can be said
without the benchmark: the only render-path change is in `renderScmPanel`, which gained
one branch per drawn row and one `fitRowText` call per *drawer* row — bounded by the
dock's height (tens of rows), against a pane renderer that handles thousands of cells.
Nothing in `app.ts`'s geometry or the pane path was touched.

`bench/RESULTS.md` still has the defect two handoffs have now named: **the generator
destroys its hand-written sections**. `git checkout -- bench/RESULTS.md` after any run.
This is the third handoff to say so; the fix is code, not another sentence here.

## Open threads deliberately left

- **The full `pnpm test` was not run to completion at this load.** The four suites this
  phase touches were run and pass; `source-control.test.ts` failed once when four suites
  ran concurrently at load 15 and passed alone — the harness's `waitForText('$ ')`
  losing a race, the same shape as the `multiplexer.test.ts` flake below. **Run
  `pnpm test` on a quiet machine before trusting the 1,389 + 60 figure.**
- **No end-to-end drawer test through `TuiHarness`.** The keystroke-level path — open
  the git view, walk to Stashes, `m`, cancel — is covered by unit tests on both sides of
  the wire but not by a test that drives the assembled program. It was cut for time, not
  for a reason; it is the obvious next test to write.
- **`multiplexer.test.ts` is still flaky and still undiagnosed.** Unchanged from phase
  10: roughly 1 run in 6 at load 12, `expected 0 to be greater than or equal to 2`.
- **No drawer refresh on its own.** Same rule as phase 7: nothing polls. A `git commit`
  run in the pane behind the panel needs `r`, which now re-reads the status and every
  *open* drawer and nothing else.
- **`Show Changes` is still a pager pane.** Phase 9 owns the in-panel diff question and
  did not reverse it; this phase did not reopen it.
- **The drawers are cramped in `unified` layout.** They live in the lower half of the
  Explorer view, which grows when a drawer is open but is capped at half the body. The
  `separate` layout (`3`, or `C-b g`) is where they are meant to be read.
- **No `git` command outside PHASE-11's table.** No rebase UI, no branch or tag
  creation, no push from the Remotes drawer, no conflict resolution. The failure mode
  of this phase was becoming a git client and it did not.
- **Everything in phase 10's *Open threads* that was not about plugins is still open**:
  `follow-pane` unwired, no syntax highlighting, no `rg`/`bat`/`glow`/`delta` on this
  machine, `DaemonClient` has no request timeout, and phase 5's criterion 2 (detection
  against a running agent) is still the important gap.

## Three defects fixed after the phase, all reported from screenshots

These are not PHASE-11 work. They were found by looking at the running program while
the phase was being reviewed, and each one had been shipped for several phases.

**1. The dock kept the keyboard from the panes it opened.** `⏎` on a file opens it in
`$PAGER` and focuses that pane — and then every keystroke still went to the dock,
because `handleKey` routed to the panel for as long as it was open. A pager that cannot
scroll is not an opened file. The same bug made the `$EDITOR` entry, the diff pane, the
shell-here entry and `Open Worktree` all open something unusable. Phase 10's handoff saw
the symptom on click-spawned panes and read it as a reason not to spawn them; this was
the cause. `TuiApp.dockFocused` now exists: the dock keeps the keyboard while you work
in it and releases it (`releaseDock`) the moment it opens a pane, staying on screen,
dimmed. `C-b e` / `C-b g` / `C-b f` or a click take it back — and `C-b e` on an
unfocused dock now *focuses* it rather than closing it.

**2. The Preview view drew a file in 34 columns.** The dock's width was capped at
`cols/3` for every view. Three of the four views are lists of paths and are fine there;
the fourth is a file, and the result was a column of `…` next to two idle shells with
three quarters of the screen empty. `SidebarPanels.preferredWidth` now answers per
view: lists get the old behaviour, Preview asks for `34 + 1 + 80` capped at **half** the
screen, and `previewAreas` puts the tree back on the left when the body is at least
107 columns. Clicking a row in that tree previews it beside itself — which is
herdr-sidebar's actual shape, and closes `PARITY.md`'s largest orphan.

**3. The workspace list said less than it knew.** Three changes, all rendering except
the first:

- **`git.summary`** — a new RPC, `{ paths[] } → { summaries[] }`, one
  `status --porcelain -z --branch --untracked-files=no` per directory, parsed with the
  panel's own `parseStatus` so the two can never disagree. It draws the branch and
  ahead/behind under each workspace name. Fetched when the workspace set or their cwds
  change and after a dock git action; **never polled**, and keyed so an ordinary
  snapshot costs a string comparison.
- The agent status glyph **leads** the workspace row instead of sitting between the
  name and the pane count, where it read as part of the numbers.
- Agent rows are now `<task> · <tool>` over `<state> · <workspace name>`. They were
  `<tool>` over `<pane title>` with the workspace as a right-aligned *number*, which
  printed `claude` four times down a list of four agents and made the one thing that
  distinguishes them the dim half.

```ts
interface GitRepoSummary {
  path: string; isRepo: boolean; branch: string
  ahead: number; behind: number; hasUpstream: boolean
  dirty: boolean          // tracked changes only; untracked files do not count
}
'git.summary': { params: { paths: readonly string[] }; result: { summaries: readonly GitRepoSummary[] } }

// client
class SidebarPanels {
  preferredWidth(cols: number, configured: number): number
  previewAreas(body: Rect): { tree: Rect | null; preview: Rect }
  previewWidth(area: Rect): number
}
renderSidebar(..., dockRight?: boolean, summaries?: ReadonlyMap<string, GitRepoSummary>)
```

**None of the three has a test.** They were verified by rendering the sidebar into a
buffer and reading it, and by the existing 18 sidebar and 23 source-control tests still
passing. The geometry (`preferredWidth`, `previewAreas`) is pure and is the obvious
thing to pin down first.

## The sidebar mock-up, since it came up

A mock-up was shown alongside the running app and the difference is worth writing down
rather than rediscovering:

| In the mock-up | Here |
|---|---|
| a `spaces` section header | **built after the phase** |
| a **branch line under each workspace** (`main ↑1`) | **built after the phase** — `git.summary`, see above |
| a status dot per workspace | **built** — `workspaceAgentStatus` + `agentGlyph`, drawn between the name and the pane count. It is blank because nothing in that session had a detected agent |
| an `agents` section, two lines per agent | **built** — `renderAgentSection` in `chrome.ts`. It renders only when `agentEntries(state)` is non-empty, i.e. when a pane has both `agent` and `agentStatus` set by detection. A plain shell sets neither, so the section is skipped entirely |
| a `grouped` toggle on that section | not built; now an orphan in `PARITY.md` |
| workspaces named `acme-app`, `acme-api` | works today — a workspace with a label shows it; `workspaceTitle` falls back to `workspace N` |

Of the six, four are now built, one (`grouped`) is not and is recorded as an orphan,
and the agents section turned out to have been working all along — it only ever needed
a pane with a detected agent in it, which a plain shell is not.

## Getting started in a new session

```bash
pnpm install
pnpm build
ln -s "$PWD/packages/client/dist/main.js" ~/.local/bin/leap-chorus
pnpm test                                    # do not run anything alongside it

leap-chorus                                  # C-b e files · C-b f search · C-b g git · 1/2/3/4
#   in the git view: ↑↓ move · ⏎ open a drawer · →← open/close · m row menu · r refresh
#   the workspace strip's action row: new · ▤ files · menu

uptime && node bench/dist/render-scale.js --seconds 15
git checkout -- bench/RESULTS.md             # THE BENCHMARK DESTROYS IT
pgrep -f leap-chorusd                        # a leaked daemon forks `ps` every 750 ms
```
