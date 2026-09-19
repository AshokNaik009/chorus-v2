# Phase 1 — Daemon + PTY survival

**Read `../PLAN.md` first.** This phase assumes no prior context.

## Why this phase is first

Two claims make or break this project:

1. `@xterm/headless` can hold terminal state server-side well enough to render from.
2. A detached daemon can keep PTYs alive across a client restart, so live updates
   do not need `SCM_RIGHTS` file-descriptor passing (which Node cannot do).

Both are proven in `/Users/ashoknaik/claude-experiments/orca`. Neither is proven *for us*. Prove them in ~3-5k
lines before committing to 45k.

## Goal

A daemon process that owns PTYs and serves terminal snapshots over a versioned
unix socket, plus a throwaway CLI that attaches to it. Killing and restarting
the CLI must not disturb a running program in a PTY.

## Deliverables

```
package.json            # pnpm workspace, node >=20, vitest
tsconfig.base.json
packages/
  protocol/             # ~600 lines
    src/messages.ts     # request/response/event types, discriminated unions
    src/codec.ts        # newline-delimited JSON framing over a socket
    src/version.ts      # PROTOCOL_VERSION, negotiation + legacy adapter hook
  daemon/               # ~2500 lines
    src/socket.ts       # unix socket at <data-root>/daemon/daemon-v<N>.sock
    src/lock.ts         # instance lock; refuse on wrong owner / held / unusable
    src/pty-host.ts     # node-pty spawn/write/resize/kill, Uint8Array in/out
    src/emulator.ts     # @xterm/headless per pane; feed bytes, read buffer
    src/snapshot.ts     # cell-grid snapshot: chars, fg, bg, attrs, cursor
    src/sessions.ts     # id -> {pty, emulator}; lifecycle
    src/adopt.ts        # detach, survive parent exit, adopt on reconnect
    src/main.ts         # entrypoint: `herdr-tsd`
  cli-probe/            # ~400 lines, THROWAWAY — replaced in phase 2
    src/index.ts        # attach, spawn, write, dump snapshot as text
```

## Critical implementation notes

**`@xterm/headless` needs a `window` global** when run under plain Node.
See `/Users/ashoknaik/claude-experiments/orca/src/main/daemon/xterm-env-polyfill.ts` — import the polyfill
*before* any `@xterm/headless` import.

**Bytes, not strings.** `PtyBackend.onData` must carry `Uint8Array`, not
`string`. A string boundary forces a UTF-8 decode per chunk and then a re-encode
into the emulator. `term.write()` accepts `Uint8Array` directly.

**Enable node-pty flow control.** A runaway agent will otherwise flood the
socket. See node-pty's `handleFlowControl`.

**Socket path carries the protocol version** (`daemon-v<N>.sock`). This is how
a new client finds a compatible daemon, and how an old daemon keeps serving old
clients. Read `/Users/ashoknaik/claude-experiments/orca/docs/reference/orcad-operations.md` "Two long-lived
processes" before writing `adopt.ts`.

**Detachment is not service isolation.** Under systemd, `KillMode=mixed` will
SIGKILL the whole cgroup regardless of detachment. Document this; do not try to
solve it in phase 1.

## Acceptance criteria

Each must be a test that passes, or a script that exits 0.

1. `pnpm test` green.
2. Spawn a PTY running `bash`, write `echo hello\n`, read back a snapshot whose
   text contains `hello`.
3. Spawn a PTY running a full-screen program (`vim` or equivalent alt-screen
   app). Snapshot reflects the alternate screen, not the primary buffer.
4. **The survival test.** Script that:
   - starts the daemon
   - spawns a PTY, runs a long-lived process, writes some output
   - kills the *client* (not the daemon)
   - starts a new client, reattaches to the same session id
   - asserts the process is still the same PID and the snapshot still shows the
     earlier output
5. Instance lock: a second daemon on the same data root refuses to start with a
   named error code, and does not corrupt the first.
6. Resize a PTY to 200x50, snapshot dimensions match.

Criterion 4 is the phase. If it does not pass, the architecture is wrong and
nothing later matters.

## Do NOT do in this phase

- No TUI rendering. `cli-probe` dumps plain text and gets deleted in phase 2.
- No input parsing (no mouse, no kitty keyboard). Raw stdin passthrough only.
- No workspaces, tabs, panes, or layout.
- No agent detection.
- No SSH.
- No packaging or binaries.
- No performance work. Phase 2 measures; phase 1 only needs correctness.

## Handoff

Write `HANDOFF.md` at repo root containing:
- What the snapshot type actually looks like (phase 2 renders it)
- The exact socket path scheme and handshake sequence
- Anything about `@xterm/headless` that surprised you
- Any acceptance criterion you could not meet, and why
