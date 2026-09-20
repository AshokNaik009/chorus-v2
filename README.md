# leap-chorus

A terminal-native multiplexer for AI coding agents, in TypeScript. A rewrite of
[herdr](https://github.com/herdrdev/herdr) (Rust, Apache-2.0), using the runtime
architecture proven by orca (TypeScript, MIT). See `NOTICE` for attribution.

**Status: phase 5 of 5 done.** It is an *agent* multiplexer: every pane knows which
agent is running in it and whether that agent is idle, working, blocked on you, or
done, and the sidebar says so at a glance. It creates git worktrees so two agents do
not fight over one checkout, installs agent hooks, and packages into platform tarballs
that run on a machine with no Node. Read `PLAN.md`, then `HANDOFF.md`.

Phases 1–4 shipped as `herdr-ts`; the rename to `leap-chorus` landed in phase 5
alongside packaging. A pre-rename data root is migrated on first start.

## The architecture, in one paragraph

Two long-lived processes. A **daemon** owns every PTY and the terminal state
(`node-pty` + `@xterm/headless`) and exposes a versioned unix socket. A **client**
attaches, pulls cell snapshots, renders them, and sends input. The client can die,
update, and reattach; the daemon and its PTYs survive. That split is what makes live
updates possible without passing file descriptors over unix sockets — which Node cannot
do — and it is proven by the phase-1 survival test and by phase 5's version-bump test.

## Requirements

- Node >= 22 (developed on 22; `.nvmrc` pins 24, the Active LTS)
- pnpm 10
- macOS or Linux. **Windows is deliberately not supported** — see `phases/PHASE-5.md`.

## Development

```bash
pnpm install     # also repairs node-pty's spawn-helper permissions
pnpm build
pnpm test
```

`pnpm test` builds first, because the integration tests run a real detached daemon from
`dist/`, not from the TypeScript sources — what they prove is about process lifetime.

Phase 1's flood test takes 30 seconds by design. `LEAP_CHORUS_BACKPRESSURE_SECONDS=5`
shortens it while iterating; do not commit a shorter default.

### Running it

```bash
node packages/client/dist/main.js              # a shell in one pane
node packages/client/dist/main.js -- /bin/bash # pick the program
node packages/client/dist/main.js --config ./my.toml
node packages/client/dist/main.js kill-server  # stop the daemon and every pane
```

Detaching (`C-b d`) leaves the daemon and its PTYs running — that is the point of the
architecture — so `kill-server` is how you stop one. It will not start a daemon just
to kill it.

The prefix is `Ctrl-B`, as in tmux, and every binding below is configurable:

| Key | What it does |
|---|---|
| `C-b %` / `C-b "` | split left/right, split top/bottom |
| `C-b h j k l` | move focus |
| `C-b H J K L` | move the divider |
| `C-b { }` | swap the focused pane with its neighbour |
| `C-b o` / `C-b Tab` | next pane |
| `C-b z` | zoom the focused pane (the rest stop rendering) |
| `C-b x` | close the focused pane |
| `C-b c` / `C-b &` | new tab / close tab |
| `C-b n` / `C-b p` | next / previous tab |
| `C-b w` | new workspace |
| `C-b )` / `C-b (` | next / previous workspace |
| `C-b s` | show or hide the sidebar |
| `C-b PgUp` / `PgDn` / `End` | scroll this pane's history |
| `C-b r` / `C-b R` | force a repaint / reload the config |
| `C-b d` | detach — the daemon and every pane keep running |
| `C-b q` | quit, killing the panes |
| `C-b C-b` | send a literal `Ctrl-B` |
| click | focus a pane, a workspace in the sidebar, or a tab |
| wheel | scroll a pane that has not asked for mouse reports |

Mouse reporting and bracketed paste are asked for on the outer terminal and turned off
again on every exit path. `--no-mouse` skips the request, as does `mouse = false`.

**Hover highlighting is opt-in** (`mouse-hover = true`). It needs the terminal's
any-motion reporting (DEC 1003), which sends an event for every cell the pointer
crosses; clicking needs none of that, so the default does not pay for it.

If clicks do nothing at all, the terminal is not forwarding them: macOS Terminal.app
needs *View → Allow Mouse Reporting*, and an outer multiplexer will eat them first.

## Agents

Each pane's agent and its state are discovered by the daemon and reach every attached
client on the session snapshot, so two clients always agree about them.

| Badge | Meaning |
|---|---|
| `claude ·` | idle — at its prompt, nothing happening |
| `claude *` | working |
| `claude !` | **blocked on you** — a permission prompt, a question |
| `claude ✓` | done — the agent process exited, the pane is still open |
| `claude ?` | running, but its state could not be read |

A glyph and not just a colour, so it survives a monochrome terminal and colour
blindness. The workspace row in the sidebar shows the worst state inside it, which is
how a blocked agent in a workspace you cannot see gets noticed.

State comes from three sources, in this order of authority:

1. **an installed hook** — the agent tells us, and it costs nothing per byte
2. **the screen**, matched against a per-agent manifest of rules
3. **the process table**, which is the only thing that can say `done`

The screen overrules a live hook in exactly one case: a *visible* blocker. A missed
permission-prompt event would otherwise leave a pane showing `working` while it
silently waits for you.

Bundled agents: `claude`, `codex`, `opencode`. Adding one is a TOML file, not code.

### Fixing a detection rule

Rules go stale the day an agent ships a new spinner, so they are data and reloadable:

```bash
# what the engine actually sees, and which rules fired against which region
leap-chorus agent read <pane> --source detection
leap-chorus agent explain <pane>

# edit, then reload without restarting the daemon or losing a pane
$EDITOR ~/.config/leap-chorus/agent-detection/claude.toml
leap-chorus agent reload-manifests
```

A broken override falls back to the bundled manifest and says why, rather than leaving
you with no detection while you are mid-edit.

## Worktrees

`worktree.create/list/open/remove` put each agent in its own checkout, so two agents
never fight over one working tree. New worktrees go *beside* the repository, never
inside it — a nested checkout shows up in every `git status`, every ripgrep and every
agent's file walk.

Git is the state and is never cached: every read shells out, because you can
`git worktree add` in a pane we are showing you.

## Integrations

`integration.install` writes each agent's hook and registers it in that agent's own
settings file. Installing twice changes nothing. Your settings file is yours — entries
we did not write are never removed, and a file we cannot parse is reported rather than
overwritten.

### Config

TOML, read by the *daemon* from `$LEAP_CHORUS_CONFIG`, else
`$XDG_CONFIG_HOME/leap-chorus/config.toml`, else `~/.config/leap-chorus/config.toml`. A
missing file is normal; an unreadable one starts on the defaults and says why in the
status bar. `C-b R` re-reads it without disturbing a single pane.

```toml
[general]
shell = "/bin/zsh"     # empty: the login shell
scrollback = 20000
mouse = true
mouse-hover = false    # highlight the sidebar row under the pointer (needs DEC 1003)

[ui]
sidebar = true
sidebar-width = 22
tab-bar = true

[theme]
focus-border = 6        # palette index, or -1 for the terminal's default
agent-blocked = 1       # the state that is waiting on you

[keys]
prefix = "C-a"

[keys.bindings]         # added to the defaults; "" unbinds
"|" = "pane.split-right"
"%" = ""
```

### Benchmark

```bash
node bench/dist/render-scale.js [--seconds N]
```

Writes `bench/RESULTS.md`: frame times at 1 and 15 panes, and hidden versus visible
panes under a flood. Do not run two at once — they compete for the machine and the
numbers become nonsense.

## Packaging

```bash
node scripts/build-app.mjs                    # bundle, node-pty externalized
node scripts/package-tarball.mjs --slot <id> --node-dir <pinned node>
sh scripts/smoke-tarball.sh <tarball>         # prove it runs with nothing installed
```

Six slots, not four — a glibc binary does not load on Alpine:

```
linux-x64-glibc   linux-arm64-glibc
linux-x64-musl    linux-arm64-musl
darwin-x64        darwin-arm64
```

Each tarball carries the app, a pinned Node runtime, and the one native addon its slot
can load. The glibc floor is **2.31** (Ubuntu 20.04), asserted in CI by reading the
shipped `.node`'s symbol versions — a green build on a newer runner is not evidence.

## Packages

| Package | What it is |
|---|---|
| `@leap-chorus/core` | the session model as pure data: state, layout tree, actions, persistence, config schema, invariants. **Zero runtime dependencies**, asserted by a test |
| `@leap-chorus/config-loader` | TOML text -> object, and the config search path. Owns the parser so `core` can stay dependency-free |
| `@leap-chorus/detect` | the agent detection engine: manifests, regions, rule gates, the shared process table |
| `@leap-chorus/protocol` | wire messages, NDJSON framing, version negotiation |
| `@leap-chorus/daemon` | PTY ownership, terminal emulation, snapshots, the session model, worktrees, integrations, the socket endpoint |
| `@leap-chorus/input` | terminal input: framing, key and mouse parsing, encoding, keybinding tables |
| `@leap-chorus/tui` | cell buffer, widgets, frame diff, ANSI encoder, raw terminal |
| `@leap-chorus/client` | attach, compose snapshots into frames, the multiplexer app and its chrome |

## Layout on disk

```
$LEAP_CHORUS_DATA_DIR, else $XDG_DATA_HOME/leap-chorus, else ~/.leap-chorus
├── daemon/
│   ├── daemon-v1.sock    endpoint for protocol generation 1 (0600)
│   ├── daemon-v1.lock    instance lock for that generation (0600)
│   ├── daemon-v1.log     one JSON line per event
│   └── session-v1.json   workspaces, tabs, panes and their layout (0600)
└── integrations/         agent hooks we wrote, rewritten on version bumps
```

The protocol version is in the file name so a new daemon can bind a new endpoint while
an old one keeps serving old clients.

Every pane gets `LEAP_CHORUS=1`, `LEAP_CHORUS_PANE_ID` and `LEAP_CHORUS_SOCKET_PATH`,
which is how an agent's hook knows where to report and needs no discovery.
