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
package.json            # pnpm workspace, engines.node "24" (floor 22), vitest
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

These were verified against `@xterm/headless` 6.0.0 and `node-pty` 1.1.0 on
2026-09-19. Re-check them if you bump either.

**`@xterm/headless` does *not* need a `window` polyfill under plain Node.**
The bundle contains exactly one `window` reference, and it is guarded:

```js
t.IdleTaskQueue = !isNode && "requestIdleCallback" in window ? ... : ...
//                 ^^^^^^^ short-circuits before `window` is evaluated
const isNode = typeof process !== "undefined" && "title" in process
```

Confirmed by running a `Terminal` under Node 22 with `globalThis.window`
undefined: it constructs, parses, and switches buffers fine. Orca needs
`/Users/ashoknaik/claude-experiments/orca/src/main/daemon/xterm-env-polyfill.ts`
because Electron's `ELECTRON_RUN_AS_NODE` breaks that `isNode` probe. **We are
not Electron. Do not copy the polyfill.**

**`@xterm/headless` is CJS-only.** No `exports` map, `main` is
`lib-headless/xterm-headless.js`, and Node's ESM interop surfaces *only*
`default`. So:

```ts
import xterm from '@xterm/headless'      // works
const { Terminal } = xterm
import { Terminal } from '@xterm/headless'  // TypeError: not a constructor
```

**Set `allowProposedApi: true` on every `Terminal`.** `term.parser` throws
without it (`"You must set the allowProposedApi option to true"`), and phase 3
needs `parser.registerCsiHandler` to track keyboard protocol modes. Turning it
on in phase 1 costs nothing and avoids a later churn.

**`term.write()` is asynchronous.** Signature is
`write(data: string | Uint8Array, callback?: () => void): void`; the data goes
through an internal queue. A snapshot read on the line after a write can be
stale. Wrap it: `await new Promise(r => term.write(chunk, r))`, or drive
snapshots off `onWriteParsed`.

**Bytes: possible, but not the way node-pty's types claim.** `term.write()`
does accept `Uint8Array` directly — that part of the plan holds. node-pty does
not cooperate:

- Its typing is `readonly onData: IEvent<string>` — there is no byte-typed event.
- Passing `encoding: null` to `spawn()` makes the underlying stream emit
  `Buffer` on Unix, but the `.d.ts` still says `string`, so you need a cast at
  exactly one boundary — wrap it in `pty-host.ts` and nowhere else.
- On Windows the same option still yields a string
  ([node-pty#489](https://github.com/microsoft/node-pty/issues/489)). Windows is
  deferred to post-v1, but the wrapper must not assume `Buffer`.

So: `PtyBackend.onData` carries `Uint8Array`, and `pty-host.ts` is the single
place allowed to launder node-pty's lie. Prove it with a test that feeds a
split multi-byte UTF-8 sequence across two chunks and reads back one codepoint.

**node-pty's `handleFlowControl` is not backpressure.** Reading
`lib/terminal.js`, the option does exactly one thing: it makes
`pty.write('\x13')` call `pause()` and `pty.write('\x11')` call `resume()`,
instead of forwarding those bytes to the pty. It is a manual pause switch you
have to drive yourself from the consumer, and while enabled you can no longer
send a bare `^S`/`^Q` through to the program. Decide explicitly: either drive
`pause()`/`resume()` directly off socket backpressure (`socket.write()`
returning false, `'drain'`) and leave `handleFlowControl` off, or enable it and
accept the `^S`/`^Q` hole. Either way, a runaway agent flooding the socket is a
real failure mode and phase 1 must have *an* answer.

**Socket path carries the protocol version** (`daemon-v<N>.sock`). This is how
a new client finds a compatible daemon, and how an old daemon keeps serving old
clients. Read `/Users/ashoknaik/claude-experiments/orca/docs/reference/orcad-operations.md` "Two long-lived
processes" before writing `adopt.ts`.

**Budget the socket path against `sun_path`.** macOS caps a unix socket path at
**104 bytes** including the NUL (`sys/un.h`); Linux at 108. A data root under
`~/Library/Application Support/...` plus `daemon/daemon-v<N>.sock` gets close.
Assert the length at bind time and fail with a named error, rather than
discovering it as `ENAMETOOLONG` on someone else's machine.

**Detachment is not service isolation.** Under systemd, `KillMode=mixed` will
SIGKILL the whole cgroup regardless of detachment. Document this; do not try to
solve it in phase 1.

## Acceptance criteria

Each must be a test that passes, or a script that exits 0.

1. `pnpm test` green.
2. Spawn a PTY running `bash`, write `echo hello\n`, read back a snapshot whose
   text contains `hello`.
3. Spawn a PTY running a full-screen program (`vim` or equivalent alt-screen
   app). `term.buffer.active.type === 'alternate'`, the snapshot reflects the
   alternate screen, and `term.buffer.normal` still holds the pre-switch text.
   (Verified reachable: writing `CSI ? 1 0 4 9 h` flips `active.type` and
   `CSI ? 1 0 4 9 l` restores both the type and the original line.)
4. **The survival test.** Script that:
   - starts the daemon
   - spawns a PTY, runs a long-lived process, writes some output
   - kills the *client* (not the daemon)
   - starts a new client, reattaches to the same session id
   - asserts the process is still the same PID and the snapshot still shows the
     earlier output
5. Instance lock: a second daemon on the same data root refuses to start with a
   named error code, and does not corrupt the first.
6. Resize a PTY to 200x50, snapshot dimensions match (`term.cols`/`term.rows`
   and the emitted snapshot agree).
7. **UTF-8 chunk splitting.** Feed a multi-byte codepoint split across two
   `onData` chunks; the snapshot shows one character, not two replacements.
   This is the test that proves the `Uint8Array` boundary in `pty-host.ts` is
   real and not a `Buffer.toString()` in disguise.
8. **Backpressure.** A pane running `yes` does not grow the daemon's heap
   without bound while no client is reading. Whichever answer you picked for
   flow control, assert it: RSS stable over 30s, or a bounded queue that drops
   with a counter.
9. **Detachment.** Kill the process that *launched* the daemon (not the client,
   not the daemon) with SIGKILL; the daemon and its PTYs are still alive and
   the socket still accepts a connection.

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
- The exact socket path scheme and handshake sequence, and the measured
  worst-case path length against the 104-byte macOS `sun_path` cap
- The pinned `@xterm/headless` and `node-pty` versions, and anything about
  either that surprised you
- Which flow-control answer you chose, and what criterion 8 measured
- Any acceptance criterion you could not meet, and why
