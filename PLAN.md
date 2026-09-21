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
| herdr-sidebar | `/Users/ashoknaik/claude-experiments/herdr-sidebar` | MIT | **The port target for phases 7-9 and 11.** Explorer, Search and Source Control — what each feature should do |
| orca | `/Users/ashoknaik/claude-experiments/orca` | MIT | Runtime architecture (phases 1-5), and the *mechanics* of building a subsystem in Node — see below |

All three are permissively licensed. Derive freely; keep attribution in `NOTICE`.

Every line count and file path quoted in these phase docs was checked against
these two checkouts on **2026-09-19**, at herdr `3f2a6e74`
(`preview-2026-09-16-2c29fb29e302-20-g3f2a6e74`) and orca `061a756b84`. Both
move. Re-measure before you trust a number; do not re-copy one.

Apache-2.0 requires retaining herdr's license text and any attribution notices
in derived files — herdr ships no `NOTICE`, so reproducing `LICENSE` plus a
per-file provenance line is enough. MIT requires orca's copyright notice
(Lovecast Inc., 2026).

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
| `@xterm/headless` for VT emulation, not libghostty-vt | Removes a vendored Zig tree and a large FFI surface (`src/ghostty/bindings.rs` alone is 5,284 lines). Orca runs `@xterm/headless` in production. Pin **6.0.0** — latest stable, 2025-12-22; orca is on the `6.1.0-beta.x` train. |
| Detached versioned daemon, not `SCM_RIGHTS` fd passing | Node has no `sendmsg` control-message API. Orca solves it by never killing the PTY owner. |
| TTL-cached `ps` table, not `pgrep` per pane | See `/Users/ashoknaik/claude-experiments/orca/src/relay/pty-child-process-inspection.ts`. `pgrep -P` is ~4k file opens per call. |
| JSON-RPC, not bincode | No deployed clients to stay compatible with (herdr's `PROTOCOL_VERSION` is 22; ours starts at 1). The only TS bincode codec on npm is `bincode-ts` — 3 versions, last published 2025-07-17, ~1.7k downloads/month. It exists; it is not something to bet a wire format on. |
| Own cell-buffer renderer, not Ink/OpenTUI | Ink's refresh rate is locked to 30fps and it rebuilds the whole output on every state change. herdr's entire ratatui surface is **24 unique identifiers**; this layer is small. See `phases/archive/PHASE-2.md` for the full list and the OpenTUI numbers. |
| No kitty graphics in v1 | `src/kitty_graphics.rs` is 1,509 lines, plus call sites in ~20 other files, all against Ghostty's API. No TS path. Revisit later. |
| Node 24, not Node 20 | Node 20 reached EOL on **2026-04-30**. Node 24 is Active LTS, 22 is Maintenance LTS, 26 is Current. Pin `engines.node: "24"` (orca does) and set the floor at 22. |
| **Yes, `plugin install` executes code fetched from a URL** | Phase 10. A plugin host that cannot install a plugin is not one. The price is written down rather than assumed: orca's "yes" to the same question is **9,914 non-test lines** of capability model, consent fingerprinting, install trust and worker supervision, and **this is ~1,400**. The difference is precisely the security model we do not have. What exists instead: a confirmation showing every argv before anything runs, a pinned content hash, a manifest that cannot change under its own build, and an audit command. None of that is a sandbox, and the handoff says so in those words. |
| **Installs are pinned, and a changed artifact is refused** | The content hash of the fetched source tree is recorded. Re-installing the same ref with different bytes *fails* — a rewritten tag or a taken-over account cannot silently upgrade an installed plugin — and `--update` is how a user says they meant it. `--pin sha256:…` checks a first install against a hash published elsewhere. Without this, `plugin install` is `curl \| sh` with a progress bar. |
| **There is no revocation. Nothing happens.** | No kill list, no signing key, no distribution endpoint. Orca fetches a signed, versioned list; inventing that for a host with one known plugin is the wrong order of work, and a kill list nobody publishes to is theatre. **If a plugin turns out to be malicious after a hundred people installed it, a hundred people each have to run `leap-chorus plugin remove`.** What is offered instead is an audit a user can act on: `plugin verify` re-hashes the installed tree against the install, and `plugin list --json` publishes the pinned commit and hash to compare against an advisory. That catches a local change; it cannot catch a plugin that was malicious the day it was published. A test documents the gap (`daemon/test/plugin-install.test.ts`). |
| **No binary named `herdr` is shipped** | `$HERDR_BIN_PATH` points at a generated wrapper called `herdr-compat`, three lines of `sh` around `leap-chorus --compat herdr`. Same mechanism, no impersonation: a plugin that goes looking for `herdr` on `PATH` finds the user's real herdr, or nothing, which is the truth either way. |
| Ship as `leap-chorus`, but rename in **phase 5**, not now | `herdr-ts` is the working name for phases 1-4. The name is baked into package names, the data root, env vars, and error codes — cheap to change before anyone has installed it, expensive after. Renaming before packaging would mean renaming twice. See `phases/archive/PHASE-5.md` Part D for the full checklist. |

## Phases

Run one phase per session. Clear context between phases. Each phase ends with
committed, verified code and a `HANDOFF.md` the next session reads.

| # | Phase | Proves | Est. |
|---|---|---|---|
| 1-5 | *shipped* — see `phases/archive/` | | |
| 6 | Remote SSH attach | It works away from the machine | reserved |
| 7 | Source control, finished | The panel survives a working day | **done** |
| 8 | Search, navigation, activity bar | You stop leaving the terminal | 2-3 wk |
| 9 | Preview, icons, settings | It is pleasant, not just correct | 2-3 wk |
| 10 | herdr plugin host | *Optional.* It proceeded — see the four decisions above | **done** |
| 11 | Source Control drawers | herdr-sidebar parity is actually reached | 1-2 wk |

`phases/` holds only the live phases. Phases 1-5 are done and their docs moved to
`phases/archive/`, which has a README saying what each one produced and which
parts of this file still cite them. Do not run an archived phase.

Realistic total: **4-5 months focused**, ~45k lines TS — but see `phases/archive/PHASE-4.md`: the
herdr subsystems it ports measure ~55k lines of Rust, not the ~32k an earlier
draft of that table claimed, so the 15k budget for `core/` is the softest
number in this plan.
Remote SSH attach is deliberately **phase 6**, not squeezed into 5.

Phases 7-9 and 11 port **herdr-sidebar** — a file explorer and source-control panel —
onto the multiplexer. A first slice landed outside the phase system; `HANDOFF.md` says
what, and what it got wrong. They do not depend on phase 6 and phase 6 does not depend
on them. Phase 10 is an alternative to their approach, not a continuation of it: read
its opening before starting it.

**Phase 10 happened, and it is not an alternative to 7-9 after all.** Its opening
framed it as the road not taken — run herdr's plugins instead of porting one plugin's
features. In practice the two do not compete: the sidebar is ours and native, and the
host runs *other people's* plugins. `herdr-file-viewer` installs from GitHub and runs
unmodified, which is the general case the phase said would survive even if 7-9 reached
parity. `PARITY.md` is unchanged by it; a plugin is not a parity row.

**Phase 11 finishes the port.** It exists because `PARITY.md` found that
herdr-sidebar's eight Source Control drawers — commits, file history, graph,
branches, worktrees, remotes, stashes, tags — were a headline feature that
PHASE-7 deferred and no later phase picked up. It is independent of phase 10
and can run before it. The sidebar port is phases **7, 8, 9 and 11**; phase 10
is the road not taken.

**`phases/PARITY.md` is the scoreboard.** It lists every feature herdr-sidebar
advertises, whether herdr-ts has it, and which phase owns it. "The sidebar
phases are done" is not the same claim as "we have parity", and that file is
where the difference is tracked — including the eight rows **no phase currently
owns**.

### herdr-sidebar is the target; orca is a solutions library

Keep these two roles apart, because conflating them is how the port drifts:

- **herdr-sidebar decides *what* we build.** It is the product being ported and
  the only thing `PARITY.md` scores against. When its behaviour and orca's
  disagree, herdr-sidebar wins by default.
- **Orca shows *how* to build it in Node,** and nothing more. Its product shape,
  its feature set and its architecture beyond phases 1-5 are not targets.

**Orca was treated as an architecture reference for phases 1-5 and as nothing at
all for 7-10. That half was a mistake, and it cost phase 7 real bugs.** Orca is a
production TypeScript application whose *implementation* of a git panel, quick
open, content search and bounded file reads already hit the traps ours will:
`execFile` silently truncating at `maxBuffer`, git translating its own `fatal:`
under a non-English locale, `git status` fighting a user's shell over
`index.lock`, a spawn failure read as a missing binary, UTF-8 filenames split
across stream chunks. None of that is visible in Rust source, and all of it is in
orca with a comment explaining why.

**So: read herdr-sidebar for the feature, then grep orca for the mechanics.**
Each live phase doc has a "What orca already knows" section, scoped to mechanics.
Measured **2026-09-20** at orca `061a756b84`; orca moves, so re-measure before
trusting a line number — and verify empirically either way, because checking
orca's `--porcelain=v2` usage showed it does *not* fix the rename defect that a
summary would have claimed it did.

Phases 1 and 2 carry all the architectural risk. If they succeed, the rest is
volume. If they fail, stop — and you will have spent 4 weeks, not 4 months.

## Rules for every phase

1. **Finish the phase before starting the next.** No partial phases.
2. **Acceptance criteria are mechanical.** A command exits 0, or it doesn't.
3. **Write `HANDOFF.md` at the end.** The next session has no memory of this one.
4. **Do not build ahead.** Each phase has a "Do NOT do" list. Respect it.
5. **Tests are not optional.** herdr has 3,751 of them for a reason.
