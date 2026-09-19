# herdr-ts — build plan

A terminal-native multiplexer for AI coding agents, in TypeScript.
Rewrite of `herdr` (Rust, Apache-2.0), using the runtime architecture proven by
`orca` (TypeScript, MIT).

**Read this file first in any new session.** Then read the current phase doc.

## Where this lives

This repo sits at `/Users/ashoknaik/claude-experiments/herdr/herdr-ts`, inside the
herdr checkout, but it is **its own git repository** with its own history. The
outer herdr repo does not track its contents — it sees only an untracked
directory. Do not commit herdr-ts changes to the herdr repo, and do not let
herdr's `CLAUDE.md` maintainer/release rules govern work here; they apply to
herdr, not to this project.

## Reference checkouts

| What | Path | License | Use it for |
|---|---|---|---|
| herdr | `/Users/ashoknaik/claude-experiments/herdr` | Apache-2.0 | Product logic, layout tree, input parsing, detection manifests |
| orca | `/Users/ashoknaik/claude-experiments/orca` | MIT | Runtime architecture: daemon, PTY ownership, process table, ssh2 |

Both are permissively licensed. Derive freely; keep attribution in `NOTICE`.

## What we are building

A TUI you run in a terminal (and over SSH) that runs many coding agents in
panes, tracks their status, and survives its own updates.

**Not** an Electron app. **Not** mobile. **Not** browser. Orca is our
architecture reference, not our product shape.

## The architecture, in one paragraph

Two long-lived processes. A **daemon** owns every PTY and the terminal state
(`node-pty` + `@xterm/headless`), and exposes a versioned unix socket. A **TUI
client** attaches, receives cell snapshots, renders them, and sends input. The
client can die, update, and reattach; the daemon and its PTYs survive. This is
Orca's `orcad` + terminal-daemon split, documented in
`/Users/ashoknaik/claude-experiments/orca/docs/reference/orcad-operations.md`.

This split is load-bearing. It is what makes live updates possible without
passing file descriptors over unix sockets, and it is what removes the entire
shared-mutex concurrency model that has no TypeScript equivalent.

## Key decisions already made (do not relitigate)

| Decision | Why |
|---|---|
| `@xterm/headless` for VT emulation, not libghostty-vt | Removes 355k lines of vendored Zig and a 201-function FFI surface. Orca runs this in production. |
| Detached versioned daemon, not `SCM_RIGHTS` fd passing | Node has no `sendmsg` control-message API. Orca solves it by never killing the PTY owner. |
| TTL-cached `ps` table, not `pgrep` per pane | See `/Users/ashoknaik/claude-experiments/orca/src/relay/pty-child-process-inspection.ts`. `pgrep -P` is ~4k file opens per call. |
| JSON-RPC, not bincode | No deployed clients to stay compatible with. bincode 2 varint has no TS implementation. |
| Own cell-buffer renderer, not Ink/OpenTUI | Ink caps ~30fps and re-renders on every state change. herdr uses only 20 ratatui imports; this layer is small. |
| No kitty graphics in v1 | 2,834 lines in herdr against a Ghostty-specific API. No TS path. Revisit later. |

## Phases

Run one phase per session. Clear context between phases. Each phase ends with
committed, verified code and a `HANDOFF.md` the next session reads.

| # | Phase | Proves | Est. |
|---|---|---|---|
| 1 | Daemon + PTY survival | The architecture works at all | 1-2 wk |
| 2 | TUI client + render + benchmark | It is fast enough | 2-3 wk |
| 3 | Input parsing | Real terminals work | 3-4 wk |
| 4 | Session model + API | It is a multiplexer | 4-6 wk |
| 5 | Agents + detection + packaging | It is *this* multiplexer | 3-4 wk |

Realistic total: **4-5 months focused**, ~45k lines TS.
Remote SSH attach is deliberately **phase 6**, not squeezed into 5.

Phases 1 and 2 carry all the architectural risk. If they succeed, the rest is
volume. If they fail, stop — and you will have spent 4 weeks, not 4 months.

## Rules for every phase

1. **Finish the phase before starting the next.** No partial phases.
2. **Acceptance criteria are mechanical.** A command exits 0, or it doesn't.
3. **Write `HANDOFF.md` at the end.** The next session has no memory of this one.
4. **Do not build ahead.** Each phase has a "Do NOT do" list. Respect it.
5. **Tests are not optional.** herdr has 3,751 of them for a reason.
