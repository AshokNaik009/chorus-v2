# HANDOFF — phase 5 done, plus an unphased sidebar slice

**Read `PLAN.md` first.** This file is the state of the world as this session leaves it.
Everything was measured on 2026-09-20, macOS (darwin 26.6.2, arm64, Apple silicon),
Node v22.1.0, pnpm 10.18.0.

The project is now **leap-chorus**. `herdr-ts` was the working name for phases 1–4 and
survives only in provenance comments and `NOTICE`.

## Since phase 5: the sidebar slice, built outside the phase system

A later session ported the first slice of **herdr-sidebar**
(`/Users/ashoknaik/claude-experiments/herdr-sidebar`, MIT, measured at `1a5d37e`) without a
phase doc. It is committed, tested and pushed. **Phases 7-10 now exist to finish it
properly — read `phases/PHASE-7.md` next.** Phase 6 (SSH) is still reserved and unbuilt;
7-9 neither depend on it nor block it.

`pnpm test` is **893 tests** as this session ends, up from 805.

### What landed

| Area | Files | What it does |
|---|---|---|
| Working-tree git | `packages/daemon/src/git.ts` (282) | status, stage, unstage, discard, commit. Porcelain parsing ported from herdr-sidebar's `git.rs` |
| Live cwd | `packages/daemon/src/cwd.ts` (87) | the shell's *real* directory: procfs on Linux, `lsof` on macOS |
| Filesystem | `packages/daemon/src/fs.ts` (108) | `fs.list`, the daemon's first fs surface; containment checked after symlinks resolve |
| Source Control | `packages/client/src/scm.ts` (333) | `C-b g`. Changes list, stage/unstage, commit, discard, diff in a pane |
| Explorer | `packages/client/src/explorer.ts` (346) | `C-b e`. Lazy tree, git decorations, scrolling |
| Pane CLI | `packages/client/src/main.ts` | `pane list/open/focus/zoom/close`, shaped like herdr's |

New methods: `fs.list`, `git.status`, `git.stage`, `git.unstage`, `git.discard`,
`git.commit`. All take `paneId` (preferred) or `cwd`.

```ts
interface GitFileEntry { path: string; origin: string | null; letter: string }
interface GitStatusResult {
  root: string; branch: string
  staged: readonly GitFileEntry[]; unstaged: readonly GitFileEntry[]
  ahead: number; behind: number; hasUpstream: boolean
}
interface FsListResult { root: string; path: string; entries: readonly FsEntry[] }
interface FsEntry { name: string; kind: 'dir' | 'file' | 'other'; link: boolean }
```

### Two confirmed defects, both left open on purpose

Verified against real git on 2026-09-20. Repros and fixes are in `phases/PHASE-7.md`.

1. **Staging a rename leaves a dangling deletion.** `git.ts` stages only the selected
   path; herdr-sidebar passes the origin too. `GitFileEntry.origin` is on the wire and
   unused.
2. **The Source Control panel does not scroll.** It draws until it runs out of height,
   but the cursor keeps moving — so `Enter` can stage a file you cannot see. The
   Explorer got a viewport and the changes list never did.

### Things established by running them, not by reasoning

Recorded because each one cost a wrong assumption first:

- `git restore --staged` fails `fatal: could not resolve 'HEAD'` on a repo with no
  commits. Unstage therefore uses `reset -q HEAD --`.
- `-z` porcelain v1 writes renames **target first**: `XY PATH\0ORIG_PATH\0`. Confirmed
  against git's docs and raw bytes.
- `pane.cwd` is the *spawn* directory. `cd` updates nothing and announces nothing, so
  anything wanting the live directory must read the process.
- The client's `this.call` catches errors into the status bar. A panel that needs its
  own error must call `options.client.call` directly.
- **`packages/client/test/multiplexer.test.ts` is flaky** — roughly 2 runs in 3, a
  different test each time. Reproduced on a stashed, clean tree: it predates all of the
  above. Not yet diagnosed.

## Status: phase 5 complete on eight of ten criteria; two need a machine this is not

`pnpm test`: **805 of 806 pass**. Phase 4 left 608; this session added 198.

The one failure is phase 1's flood test (`backpressure.test.ts`, "holds RSS steady
across 30s of `yes`"), and it is **environmental, not a regression**. It passes alone
in 40.3 s, twice verified. It times out only in a full serial run on this machine,
which spent the session under a load average of 6-10 with an unrelated macOS process
(`BTLEServer`) pinned at 100% CPU. The measurement that settles it: a 970-second run
used 49 seconds of CPU — 5%. The suite was starved, not slow. **Check `uptime` before
believing any timing from this suite**, and re-run that test alone before filing it as
a bug.

| # | Criterion | Verdict | Where |
|---|---|---|---|
| 1 | `pnpm test` green | met, with one load-induced timeout | see above |
| 2 | detection live for 3 agents, all 4 states, versions recorded | **not met** | only `claude` is installed on this machine |
| 3 | 15 panes polling → one `ps` per TTL, proven by a counter | met | `detect/src/process-table.test.ts`, `daemon/test/agents.test.ts` |
| 4 | worktree create/list/open/remove; two agents do not collide | met | `daemon/test/worktrees.test.ts` |
| 5 | integration install is correct and idempotent | met | same file |
| 6 | bench re-run with detection; p99 unmoved | met | `bench/RESULTS.md`, and the A/B below |
| 7 | tarballs build per slot and run on a clean machine | **1 of 6 slots** | darwin-arm64 verified here; no Docker, no Linux |
| 8 | glibc floor asserted in CI | code + unit tests, **never executed** | `scripts/check-glibc-floor.mjs`, `daemon/test/glibc-floor.test.ts` |
| 9 | survival across a real client version bump | met | `daemon/test/update-survival.test.ts` |
| 10 | rebrand complete | met | `grep -ri herdr` returns only provenance |

Criteria 2, 7 and 8 are blocked on hardware, not on unwritten code. Everything they
need exists and is unit-tested; what is missing is a Linux box, a container runtime,
and `codex`/`opencode` installed. **Do not mark them done without running them.**

## The four bugs that only running things found

Every one of these passed code review and unit tests. They were found by executing the
built artifact, which is the lesson worth carrying into phase 6.

1. **The release tarball did nothing.** `import.meta.url` resolves symlinks;
   `process.argv[1]` does not. On macOS `/tmp` and `/var` are symlinks into
   `/private`, so the `import.meta.url === file://${argv[1]}` entrypoint guard was
   false for every install under either — the client started, printed nothing, and
   exited 0. Fixed by `isEntrypoint()` in `adopt.ts`, which compares real paths.
   Pinned by a test.
2. **`worktree.remove` ran `git branch -D` in the directory it had just deleted.**
   `rev-parse --show-toplevel` inside a linked worktree returns *that worktree*, so
   `repo` was the thing being removed. Now every git call after the removal runs from
   the primary tree.
3. **Pane↔worktree matching never matched.** git prints real paths, a pane's cwd is
   whatever the user typed. Same symlink root cause as (1); fixed with
   `canonicalPath()` on both sides.
4. **A detached daemon could not be stopped.** Detaching leaves it running by design,
   but there was no command to end one — found by leaving an orphan running for 75
   minutes, where it quietly competed with every benchmark on the machine and made
   "detection off" look slower than "detection on". `leap-chorus kill-server` now
   exists, and does not start a daemon in order to kill it.
5. **Hover could never have worked.** The client asked for `?1002h` (button tracking)
   and `?1006h` (SGR) but never `?1003h` (any-motion). Clicks worked all along; motion
   with no button held was never reported. Now opt-in via `[general] mouse-hover`.

## Detection: the design, and what is different from herdr

`@leap-chorus/detect` is 2,942 lines. The manifest design is herdr's and was ported
deliberately: rules are TOML data with AND/OR/NOT gates over named screen regions, so
a vendor shipping a new spinner is a file edit, not a release.

Three of the four bundled sources of truth:

| Source | Cost | Authority |
|---|---|---|
| an installed hook | nothing per byte | highest, for 30 s after it arrives |
| the screen, via a manifest | one region scan per pane per poll | fallback |
| the process table | one shared `ps` per 500 ms TTL | says *which* agent, and `done` |

**`done` is ours, not herdr's.** herdr has four states; a pane whose agent has *exited*
draws the same transcript as one sitting idle, and no screen rule can separate them.
The process table can, so `done` comes from there and nothing else may claim it — an
integration reporting `state: "done"` is rejected at the endpoint.

**The screen overrules a live hook in exactly one case**: a visible blocker. A missed
permission-prompt event otherwise leaves a pane reading `working` while it silently
waits for the user, which is the worst failure this feature has.

### Porting Rust regexes to JavaScript

The one genuinely tricky part, all of it in `detect/src/regex.ts`:

| Rust | JavaScript | What we do |
|---|---|---|
| `(?i)` `(?m)` `(?s)` | not supported | lift a **leading** flag group to `RegExp` flags |
| `\x{2733}` | needs `u` | rewrite to `\uXXXX`, which needs nothing |
| `\A` / `\z` | not supported | rewrite to `(?<![\s\S])` / `(?![\s\S])` |
| `\p{L}` | needs `u` | set `u`, and switch `\x{}` to `\u{}` to match |

A flag group anywhere but position 0 is a **compile error**, not a best guess: Rust
scopes it to the enclosing group and a lifted flag would apply to the whole pattern,
which silently turns a precise blocker rule into one that matches prose. All three
bundled manifests put them first. Not translated, and recorded as a known gap: `\d`
`\w` `\s` are Unicode-aware in Rust and ASCII-only in JS without `u`.

`bundled.test.ts` compiles every shipped manifest, which is what proves the
translation actually works on herdr's real rules — including claude's multi-line MCP
matcher.

### What is deliberately not ported

**herdr's remote manifest catalog.** It is a supply chain: a rule file fetched over the
network decides what runs a regex against the user's terminal, and it needs signing,
pinning and a rollback story first. The local override path is what makes the
development loop work, and that is the half that earns its keep.

## Manifests, and how bundling works

Manifests live in `packages/detect/manifests/*.toml` and are compiled into
`src/bundled.ts` by `scripts/generate-bundled-manifests.mjs`, with a test that fails if
the two disagree. They are **string constants, not files read at runtime**, for the
same reason node-pty is externalized: the shipped app goes through a bundler, and a
path computed at runtime is the one thing a bundler cannot follow. User overrides are
still read from disk, because their path cannot be known at build time.

Bundled today: `claude`, `codex`, `opencode`. herdr has 22; port on demand.

## Packaging

`pnpm build` → `tsc`. `node scripts/build-app.mjs` → two ESM bundles plus node-pty.

**ESM, not CJS**, and this is load-bearing: a CJS bundle empties `import.meta.url`,
which is how the client finds its daemon. esbuild warns about it; the warning was
right.

**node-pty is external and always will be.** Its `lib/utils.js` computes
`prebuilds/${process.platform}-${process.arch}` at runtime. No bundler can resolve
that — not esbuild, not webpack, not ncc, and not Bun's `--compile`. PHASE-5 called
this correctly.

Six slots. A tarball carries the app, a **pinned Node** (~50 MB, and the reason
criterion 7 is satisfiable at all), and only the one prebuild its slot can load —
pruning the others took the tree from 62 MB to 4.1 MB.

### node-pty and the glibc floor

**Shipped state: node-pty 1.1.0, with `patches/node-pty@1.1.0.patch` applied.**
Upstream 1.1.0 has **no Linux prebuilds** (verified 2026-09-19: darwin-arm64,
darwin-x64, win32-arm64, win32-x64 only), so every Linux slot compiles its own in its
own container. We did **not** move to the 1.2.0 beta line.

The patch is orca's, reduced: `.symver` pins on `openpty`, `forkpty` and
`pthread_sigmask`, plus `--no-as-needed` ldflags to keep libutil/libpthread in
`DT_NEEDED`. **The floor committed to is glibc 2.31** (Ubuntu 20.04).

`scripts/check-glibc-floor.mjs` parses `.gnu.version_r` out of the ELF directly — no
`readelf`, because the musl smoke image has no binutils and macOS has no ELF at all.
It is unit-tested against synthetic ELFs, **including the failing case** a post-2.34
build produces. It has never run against a real Linux binary.

### What was actually verified here

```
sh scripts/smoke-tarball.sh dist-release/leap-chorus-0.0.0-darwin-arm64.tar.gz
```

passes all four stages: the launcher execs the pinned node with `/usr/bin:/bin` as the
entire `PATH`, `--help` prints, the daemon starts, and **it forks a real PTY** — which
is the first call into `forkpty` and therefore the first thing a mispinned symbol
would break.

## Benchmark (criterion 6)

Detection runs in the daemon on a 750 ms poll. The A/B below was run **sequentially,
with nothing else on the machine**, because the first attempt was contaminated —
running the test suite alongside it produced a "detection off" column *slower* than
"detection on" in every scenario, which detection cannot cause.

**Do not run two benchmarks at once, and do not run one alongside the test suite.**
That mistake has now produced bad numbers twice across two phases.

See `bench/RESULTS.md` for the committed run. p99 at fifteen panes is well inside the
16 ms budget with detection live.

## What phase 6 should know

- `packages/detect/src/detector.ts` is where the three evidence sources meet. Any new
  signal goes there, not into the manifests.
- `SessionRuntime.detectOnce()` is the poll, and it is public so a test never waits on
  a timer. `LEAP_CHORUS_DETECT_INTERVAL_MS=0` turns it off.
- `packages/daemon/src/worktree.ts` never caches. Keep it that way.
- The ten new methods are in `AGENT_METHODS`; `agents.test.ts` walks it and asserts
  none answers `unknown_method`.

## Open threads

- **Nothing is committed.** Still. The working tree remains the only copy, now ~30,150
  lines. This has been a deliberate instruction every session, but a backup was taken
  to the scratchpad before the rename and that is not a substitute.
- **Criterion 2 is the important gap.** Detection is a compatibility claim about three
  vendors' CLIs and none of it has been checked against a running agent. The engine is
  proven; the rules are inherited from herdr at a commit from 2026-09-19 and may
  already be stale.
- **`codex` has no integration**, deliberately: it has no user-configurable command
  hook, so it would install as a no-op that reports nothing and looks broken.
- **`DaemonClient` still has no request timeout.** Unchanged from phase 4, and input
  is still serialized behind the current command's round trip.
- **Test files are still not typechecked.** Pre-existing since phase 1; it cost time
  again this session.
- **The human terminal check is partly closed.** Mouse click and hover were driven by
  hand in a real terminal this session. vim-in-a-pane, iTerm2/Ghostty/Alacritty and a
  Linux terminal remain unchecked.
- **`agent.explain` takes a fresh `ps`** on every call. That is right for a human
  asking a question and wrong if anything ever calls it in a loop.
- **The suite turns detection off** (`LEAP_CHORUS_DETECT_INTERVAL_MS=0`, set in
  `vitest.config.ts`). Nothing is lost — `detectOnce()` is public and the tests that
  care call it — but a future test that wants to exercise the *timer* has to opt back
  in.
- **A leaked daemon is expensive now.** It used to idle; since phase 5 it forks `ps`
  every 750 ms forever. Nine accumulated from manual probes during this session and
  quietly spoiled three benchmark runs before being noticed. `kill-server` is the
  cure; `pgrep -f leap-chorusd` is the check.
- **A daemon reached the real `~/.leap-chorus` during a test run**, reproducing phase
  4's unexplained thread — same shape, one pane at `cwd: "/"` running `/bin/bash`. The
  caller is still unidentified. A global `LEAP_CHORUS_DATA_DIR` guard was tried and
  **made things worse** (every file then contended for one instance lock), so it was
  reverted. Whoever picks this up: find the caller, do not redirect the destination.

## The v1 decision

**What ships.** A terminal multiplexer that knows what its agents are doing:
workspaces, tabs, panes, a layout tree, a persistent session, TOML config with
hot-reload, mouse, copy mode over the API, agent detection for three agents through a
manifest engine, git worktrees, agent hook installation, and tarballs that run on a
machine with nothing installed.

**What is missing versus herdr.** Windows (8,398 lines, deliberately deferred). Kitty
graphics (1,509 lines, no TS path). Plugins (~5,400 lines, post-v1). Nineteen of
twenty-two detection manifests. A remote manifest catalog. Modals, drag-to-resize, and
`pane.move` between tabs.

**Is phase 6 (SSH) worth starting?** The throughput evidence: five phases, ~30,150
lines of TypeScript including tests, against PLAN.md's estimate of ~45k lines over 4–5
months. The `core` package came in at a quarter of its 15k budget because four
subsystems were explicitly out of scope; `detect` came in at 2,942 lines against
herdr's 5,291 for the same job, which is the honest ratio for a port that keeps the
design and changes the plumbing.

On that evidence phase 6's ~5k lines and ~1 month is credible, and orca's remote
deploy files are a genuine wholesale take. **But it should not be started yet.**
Criterion 2 is unmet, and three of six platform slots have never been built, let alone
run. Shipping v1 means a stranger installs it on Linux and points it at their agents —
both of the things v1 does that phases 1–4 did not are exactly the two things this
session could not verify. Finish those on a Linux box with the agents installed, then
start phase 6.

## Getting started in a new session

```bash
pnpm install
pnpm build
ln -s "$PWD/packages/client/dist/main.js" ~/.local/bin/leap-chorus   # or pnpm link --global
pnpm test                                    # 893 tests; do not run anything alongside it
LEAP_CHORUS_DISABLE_SOUND=1 pnpm test        # the suite must not spawn afplay
leap-chorus                                  # drive it yourself
node scripts/build-app.mjs && node scripts/package-tarball.mjs --node-dir <node>
sh scripts/smoke-tarball.sh dist-release/*.tar.gz
node bench/dist/render-scale.js --seconds 15 # alone, or the numbers are fiction
```
