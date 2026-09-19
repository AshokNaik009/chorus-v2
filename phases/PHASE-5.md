# Phase 5 — Agents, detection, and shipping

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase

Phase 4 produced a multiplexer. This phase makes it an *agent* multiplexer —
the thing that distinguishes it from tmux — and gets it onto a machine that
isn't yours.

## Part A — Agent detection

The feature: each pane knows whether its agent is idle, working, blocked on
input, or done, and the UI shows it.

**Take herdr's design, Orca's mechanics.**

herdr's detection engine (`/Users/ashoknaik/claude-experiments/herdr/src/detect/`, 5,291 lines) is manifest-driven:
TOML files per agent in `/Users/ashoknaik/claude-experiments/herdr/src/detect/manifests/`, with explicit
AND/OR/NOT gates over screen regions. That design is good and portable — keep it.

There are **22 manifests** as of 2026-09-19: `amp`, `antigravity`, `claude`,
`cline`, `codex`, `cursor`, `devin`, `droid`, `gemini`, `github-copilot`
(not `copilot` — the filename matters), `grok`, `hermes`, `kilo`, `kimi`,
`kiro`, `letta`, `maki`, `muse`, `opencode`, `pi`, `qodercli`, `qwen`.
Port the engine and the schema; port manifests on demand, starting with the
three you will actually verify live.

But herdr reads those signals through Ghostty's API and its own process
inspection. Use Orca's mechanics instead:

| Need | Orca source |
|---|---|
| Foreground process name | `/Users/ashoknaik/claude-experiments/orca/src/relay/pty-shell-utils.ts` |
| Does the shell have children | `/Users/ashoknaik/claude-experiments/orca/src/relay/pty-child-process-inspection.ts` |
| Shared process table | `/Users/ashoknaik/claude-experiments/orca/src/shared/process-table-index.ts`, `process-table-snapshot-reader.ts` |
| cwd / title from OSC | `/Users/ashoknaik/claude-experiments/orca/src/main/daemon/terminal-osc-cwd-title-scanner.ts` |

**The performance rule, stated once:** detection runs per pane on a poll. Use
ONE TTL-cached `ps` snapshot with a memoized parent/child index, shared across
all panes. Do not fork `pgrep` per pane. Orca measured `pgrep -P` at ~4k file
opens per call on a 690-process host at up to 8 forks/sec. A `fresh` opt-out is
required for destructive decisions (closing a pane) because a poll can tolerate
a stale table and a kill cannot.

**Prefer hooks over screen-scraping where the agent supports it.** An agent that
emits status over OSC costs nothing per byte; screen matching costs a snapshot
scan per poll. Treat hook signals as authoritative and screen matching as the
fallback, not the reverse.

## Part B — Worktrees and integrations

- `worktree.create/list/open/remove` — take from Orca, which has a mature
  worktree lifecycle (`git worktree` per agent, branch isolation).
- `integration.install/list` — take from herdr (`/Users/ashoknaik/claude-experiments/herdr/src/integration/`,
  11,662 lines): installs agent hooks, with version markers and migration.
  Note herdr's rule: integration asset versions are migration versions relative
  to the last release, not per-commit counters.

## Part C — Packaging and update

This is the part of the plan with the most ways to ship something that does not
start on a stranger's machine. Read all of it before writing the build.

**node-pty is the only ABI-sensitive dependency.** Everything else is pure JS.
That is the good news and it is also why every problem below is a node-pty
problem.

**Upstream stable has no Linux prebuilds.** Checked on 2026-09-19:

| node-pty | prebuilds shipped |
|---|---|
| `1.1.0` (latest stable) | `darwin-arm64`, `darwin-x64`, `win32-arm64`, `win32-x64` |
| `1.2.0-beta.15` (2026-08-03) | the above **plus `linux-x64`, `linux-arm64`** |

So on `1.1.0` a Linux install runs `node scripts/prebuild.js || node-gyp
rebuild` and compiles from source, needing python and a C++ toolchain — exactly
what acceptance criterion 7 forbids on the target machine. Either build the
Linux binaries yourself in CI (orca's approach, and the safe one) or move to
the 1.2.0 beta line with eyes open. Decide this before the build script, not
after.

**The glibc floor is a real, shipped outage, not a theoretical risk.** A
`.node` links against the glibc of whatever compiled it. glibc's 2.32–2.34
libpthread/libutil merge relocated three symbols node-pty uses:

| Symbol | New version | node-pty use |
|---|---|---|
| `pthread_sigmask` | `GLIBC_2.32` | reset child signal mask |
| `openpty` | `GLIBC_2.34` | allocate the pty |
| `forkpty` | `GLIBC_2.34` | fork the shell |

Compile on a current CI runner and the loader refuses it on Ubuntu 20.04 /
Debian 11 / RHEL 9 with `version 'GLIBC_2.34' not found`. Orca shipped that and
broke launch (their #9902). Their fix is `config/patches/node-pty@1.1.0.patch`:
`.symver` pins on those three symbols plus `--no-as-needed` ldflags to keep
libutil/libpthread in `DT_NEEDED`. Read
`/Users/ashoknaik/claude-experiments/orca/docs/reference/linux-glibc-compatibility.md`
and take the patch. Pick a floor (orca's is glibc 2.31 / `GLIBCXX_3.4.28`) and
*verify* it in CI rather than hoping.

**The matrix is six slots, not four.** Orca's:

```
linux-x64-glibc   linux-arm64-glibc
linux-x64-musl    linux-arm64-musl
darwin-x64        darwin-arm64
```

"Linux x64" is not one target. A glibc binary does not load on Alpine. Either
ship the musl slots or state in the README that musl is unsupported — but do
not discover it from a bug report. Each slot is built inside a container that
owns that libc/arch; the libc label comes from the container, not from runtime
detection. See `/Users/ashoknaik/claude-experiments/orca/config/scripts/build-orcad-prebuilds.mjs`.

**Bun `--compile`: right conclusion, wrong reason.** Bun's docs do say `.node`
files can be embedded in a standalone executable. The actual blocker is how
node-pty finds its binary — `lib/utils.js`:

```js
const dirs = ['build/Release', 'build/Debug', `prebuilds/${process.platform}-${process.arch}`]
// ...
return { dir, module: require(dir + "/" + name + ".node") }
```

That require path is computed at runtime from `process.platform`. No bundler —
Bun, esbuild, webpack, ncc — can resolve it statically. The same fact means
**node-pty must be marked external in whatever bundler we use for the Node
build too**, and its `prebuilds/` tree copied next to the output. Stay on Node;
this is not a Bun-specific trap, Bun just can't paper over it.

- Build: `pnpm build` produces a runnable Node app, node-pty externalized.
- Ship: platform tarballs carrying the app, a pinned Node runtime, and the
  node-pty binary for that slot.
- **Windows is explicitly deferred** — it is 8,398 lines in herdr
  (`platform/windows.rs` 4,490 + `client/input/windows_vti.rs` 3,908), plus
  ConPTY policy. Note also that node-pty's `encoding: null` still yields a
  string on Windows ([node-pty#489](https://github.com/microsoft/node-pty/issues/489)),
  so the phase-1 byte boundary needs a Windows branch whenever this is picked
  up. Do not half-ship it.
- Update: the daemon's versioned socket from phase 1 is what makes this safe.
  A client update replaces the client; the daemon keeps running; the new client
  attaches to `daemon-v<N>.sock` and adopts the session. A daemon update spawns
  the new version alongside and migrates sessions. Re-verify the phase-1
  survival test against a real version bump.

## Acceptance criteria

1. `pnpm test` green.
2. Status detection works live for at least 3 real agents (claude, codex, and
   one more). Verify each state: idle, working, blocked, done. Record the agent
   CLI versions tested — detection is a compatibility claim, not a unit test.
3. Detection costs are measured: with 15 panes polling, the process table is
   captured once per TTL window, not 15 times. Prove it with a counter in a test.
4. Worktree create/list/open/remove works; two agents in two worktrees do not
   collide.
5. Integration install writes agent hooks correctly and is idempotent.
6. `bench/RESULTS.md` re-run with detection active. Detection must not move
   p99 frame time measurably.
7. Tarballs build for every slot in the chosen matrix and run on a clean
   machine (no node, no pnpm, no python, no C++ toolchain). "Clean" means a
   stock container image of the *oldest* distro in the stated floor — Ubuntu
   20.04 for glibc, Alpine for musl — not the CI runner that built it.
8. The glibc floor is asserted in CI: a check that the shipped Linux `.node`
   references no symbol version above the floor. A green build on a newer
   runner is not evidence.
9. The phase-1 survival test passes across an actual client version bump.

## Do NOT do in this phase

- No Windows. Deferred, deliberately.
- No SSH / remote attach. That is phase 6.
- No kitty graphics / inline images.
- No plugin system.
- No mobile, no browser, no cloud. Ever, for this project.

## Handoff — and the v1 decision

Write `HANDOFF.md` with the usual, plus: the node-pty version and patch state
you shipped, the matrix slots you actually built, the glibc floor you committed
to, and an honest v1 scope statement —
what ships, what is missing versus herdr, and whether phase 6 (SSH) is worth
starting. By this point you will have ~4-5 months and ~45k lines of evidence
about your own throughput on this codebase. Use it.

## Phase 6, for reference (not in this plan)

Remote SSH attach. ~5k lines, ~1 month. Take wholesale from Orca:
`orcad-remote-deploy.ts`, `orcad-remote-launch.ts`, `orcad-remote-rollback.ts`,
`orcad-activation-gate.ts`, `orcad-local-build-hash.ts`, `orcad-remote-gc.ts`,
`orcad-update-plan.ts`, `orcad-state-snapshot.ts`, over `ssh2`.
