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

herdr's detection engine (`/Users/ashoknaik/claude-experiments/herdr/src/detect/`, 4,504 lines) is manifest-driven:
TOML files per agent in `/Users/ashoknaik/claude-experiments/herdr/src/detect/manifests/` (claude, codex, cursor,
gemini, amp, cline, devin, droid, copilot, antigravity...) with explicit AND/OR/NOT
gates over screen regions. That design is good and portable — keep it.

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
  11,182 lines): installs agent hooks, with version markers and migration.
  Note herdr's rule: integration asset versions are migration versions relative
  to the last release, not per-commit counters.

## Part C — Packaging and update

- Build: `pnpm build` produces a runnable Node app. Do **not** attempt Bun
  `--compile` — native addon support is its known weak spot, and we depend on
  node-pty.
- Ship: platform tarballs carrying the app plus prebuilt node-pty binaries for
  the target. See `/Users/ashoknaik/claude-experiments/orca/config/scripts/build-orcad-prebuilds.mjs`.
- Targets for v1: macOS arm64, macOS x64, Linux x64, Linux arm64.
  **Windows is explicitly deferred** — it is 8,400+ lines in herdr
  (`platform/windows.rs` 4,490 + `client/input/windows_vti.rs` 3,908), plus
  ConPTY policy. Do not half-ship it.
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
7. Tarballs build for all four targets and run on a clean machine (no node,
   no pnpm, no build tools).
8. The phase-1 survival test passes across an actual client version bump.

## Do NOT do in this phase

- No Windows. Deferred, deliberately.
- No SSH / remote attach. That is phase 6.
- No kitty graphics / inline images.
- No plugin system.
- No mobile, no browser, no cloud. Ever, for this project.

## Handoff — and the v1 decision

Write `HANDOFF.md` with the usual, plus an honest v1 scope statement:
what ships, what is missing versus herdr, and whether phase 6 (SSH) is worth
starting. By this point you will have ~4-5 months and ~45k lines of evidence
about your own throughput on this codebase. Use it.

## Phase 6, for reference (not in this plan)

Remote SSH attach. ~5k lines, ~1 month. Take wholesale from Orca:
`orcad-remote-deploy.ts`, `orcad-remote-launch.ts`, `orcad-remote-rollback.ts`,
`orcad-activation-gate.ts`, `orcad-local-build-hash.ts`, `orcad-remote-gc.ts`,
`orcad-update-plan.ts`, `orcad-state-snapshot.ts`, over `ssh2`.
