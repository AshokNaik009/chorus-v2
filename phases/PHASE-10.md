# Phase 10 — herdr plugin host (optional)

**Read `../PLAN.md` and `../HANDOFF.md` first.**

**This phase is optional and should be decided, not defaulted into.** Phases 7-9
port one plugin's *features* natively — `PARITY.md` tracks how far that has
got. This one instead runs herdr's plugins unmodified. They are alternatives,
and doing both means maintaining both.

If phases 7-9 reach parity, this phase's original motivation is mostly gone:
herdr-sidebar *is* the plugin we wanted, and we would have it natively. What
survives is the general case — some other plugin, later.

## Why this phase might be worth it

A user asked for `https://github.com/smarzban/herdr-file-viewer`. Investigating it
on 2026-09-20 turned up something that makes a host cheaper than it looks: the
plugin does not link against herdr. Its launcher scripts shell out to the `herdr`
**binary**, found through `$HERDR_BIN_PATH`:

```
herdr pane list --json          herdr plugin pane open <placement>
herdr pane zoom <id> --on/--off herdr plugin config-dir
herdr pane close <id>
```

Five commands. `leap-chorus pane list/open/focus/zoom/close` already exist and
already mirror herdr's shapes — that was the point of building them
(`packages/client/src/main.ts`). A shim on `$HERDR_BIN_PATH` that translates the
remaining two would let herdr plugins run here unchanged.

## Why it might not be

herdr's own plugin system is **8,882 lines of Rust**, measured 2026-09-19 at
herdr `3f2a6e74`:

| Path | Lines |
|---|---|
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/mod.rs` | 4,057 |
| `/Users/ashoknaik/claude-experiments/herdr/src/cli/plugin.rs` | 1,855 |
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/manifest.rs` | 608 |
| `/Users/ashoknaik/claude-experiments/herdr/src/api/schema/plugins.rs` | 469 |
| `/Users/ashoknaik/claude-experiments/herdr/src/persist/plugin_registry.rs` | 439 |
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/context.rs` | 410 |
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/panes.rs` | 359 |
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/runtime.rs` | 311 |
| `/Users/ashoknaik/claude-experiments/herdr/src/plugin_command.rs` | 207 |
| `/Users/ashoknaik/claude-experiments/herdr/src/plugin_paths.rs` | 137 |
| `/Users/ashoknaik/claude-experiments/herdr/src/app/api/plugins/env.rs` | 30 |

A **useful subset** is far smaller, because `herdr-file-viewer` declares no event
hooks — it is "activated only through explicit keybinding". Event dispatch,
invocation contexts and most of `mod.rs` are for plugins that do more.

The real cost is elsewhere: installing means running an arbitrary build script
from a git repository. `scripts/fetch-or-build.sh` fetches a prebuilt binary or
falls back to `cargo build`. That means a Rust toolchain requirement this project
does not otherwise have, and a supply-chain decision this project has not made.

## What orca already knows — and it is the reason to think twice

Measured **2026-09-20** at orca `061a756b84`. **Orca already answered decision 1
below with "yes", and the price is on disk: 9,914 non-test lines** across
`src/main/plugins/` and `src/shared/plugins/` (14,001 + 4,093 including tests).
That is not a plugin *loader*. That is what "yes" costs once it is taken
seriously, and it is the single most useful number in this document — bigger
than herdr's own 8,882 lines of Rust, in the same language we would write.

What the 9,914 lines are spent on is the part worth reading before deciding:

| Concern | Orca files |
|---|---|
| Capability model, declared in the manifest and enforced at every boundary | `plugin-capabilities.ts`, `plugin-capability-gate.ts` |
| User consent, fingerprinted so a changed manifest re-asks | `plugin-consent-request.ts`, `plugin-consent-fingerprint.ts` |
| Install trust, provenance, content hashing, lockfiles | `plugin-install-trust.ts`, `plugin-install-provenance.ts`, `plugin-content-hash.ts`, `plugin-install-lockfile.ts` |
| Revoking a plugin **after** it is installed | `plugin-kill-list.ts`, `plugin-kill-list-service.ts` |
| Out-of-process workers: slot pools, restart loops, output budgets, supervision | `plugin-worker-*.ts` (14 files) |
| Audit log, secrets store, path safety | `plugin-audit-log.ts`, `plugin-secrets-store.ts`, `plugin-path-safety.ts` |

Three specifics that are cheap to copy and expensive to invent:

- **A closed set of capability kinds, not an open string.** Orca's v0 is seven
  unscoped kinds (`workspace:read`, `terminal:send`, `notifications:show`,
  `storage`, `secrets`, `events:subscribe`, `settings:own`), each shipped with
  one plain-language line shown verbatim in the consent dialog. A typo, or a
  capability from a newer version, **fails manifest validation instead of
  silently granting nothing** — the failure mode an open set gives you is a
  plugin that appears to work and quietly cannot.
- **Consent is fingerprinted over a canonical encoding.** `canonicalizeCapabilitySet`
  sorts and de-duplicates so reformatting the manifest does not re-prompt, and
  key-sorts so no two encodings of the same grant can exist. Without that, "we
  asked the user" is not a claim you can check.
- **A kill list is how a bad plugin stops running on machines you do not own.**
  Orca fetches a signed, versioned list and refuses entries newer than 24 hours
  ahead of the clock — "a far-future `generatedAt` makes every genuine later
  list look older and disables revocation permanently". If there is no kill
  list, the honest statement in the handoff is that a compromised plugin stays
  installed until each user removes it by hand.

**None of this makes a case against the phase.** It makes the case that the
phase's real content is the security model, not the five shim commands — and
that a `plugin install` without an answer to revocation is `curl | sh` with a
progress bar. If that is the chosen trade-off, it should be written down as
such, not discovered later.

## Decide these before writing code

1. **Does `leap-chorus` execute code fetched from a URL on a user's say-so?**
   Every plugin manager answers yes; this project has never had to. Orca's yes
   is ~10k lines. Write the answer in PLAN.md as a key decision, whichever way
   it goes, **with the number next to it.**
2. **Pinning and verification.** herdr-file-viewer's tags carry SHA-256-verified
   binaries. If installs are unpinned, `plugin install` is `curl | sh` with extra
   steps. Orca's `plugin-content-hash.ts` and `plugin-install-lockfile.ts` are
   the shape of "pinned".
3. **Revocation.** Not in the original three, and it should have been. If a
   plugin turns out to be malicious after a hundred people installed it, what
   happens? "Nothing" is an acceptable answer only if it is written down.
4. **Is the `herdr` shim honest?** A binary named `herdr` that is not herdr will
   confuse someone eventually. A `--compat herdr` flag on our own binary, with
   `$HERDR_BIN_PATH` pointed at a small generated wrapper, is the same mechanism
   without the impersonation.

## Deliverables, if it proceeds

```
packages/daemon/src/plugins/manifest.ts   # herdr-plugin.toml, the subset we honour
packages/daemon/src/plugins/registry.ts   # installed plugins, on disk
packages/daemon/src/plugins/run.ts        # spawn an action, bounded output
packages/client/src/main.ts               # plugin install/list/remove; plugin pane open
scripts/herdr-compat.mjs                  # the $HERDR_BIN_PATH shim
```

**Bound plugin output and lifetime.** herdr caps at 64 KiB and 32 in-flight
commands (`PLUGIN_COMMAND_OUTPUT_MAX_BYTES`, `MAX_PLUGIN_COMMANDS_IN_FLIGHT` in
`runtime.rs`). Those numbers exist because a plugin is someone else's code.
Orca reached the same place independently — `plugin-worker-output-buffer.ts`,
`plugin-worker-output-retention.ts`, `plugin-worker-restart-loop.ts` — which is
about as strong as agreement gets on a number nobody can derive.

**A plugin's pane is an ordinary pane.** `pane.split` with a command already does
this. Do not grow a second kind of pane.

## Acceptance criteria

1. `pnpm test` green.
2. `leap-chorus plugin install <owner/repo>` clones, runs the declared build, and
   registers — tested against a **local fixture** plugin, not the network.
3. A declared action opens in a split pane and in a tab, both idempotent.
4. `leap-chorus plugin list --json` matches the shape the launcher scripts parse.
5. The shim answers all five commands the launchers use.
6. A plugin whose build fails is reported and leaves nothing half-installed.
7. Output over the cap is truncated and reported, not buffered.
8. An install is pinned: the same `plugin install` twice fetches the same bytes,
   and a changed artifact at the same ref is refused rather than installed.
   (Skip only if decision 2 was answered "unpinned" — and then say so here.)
9. Whatever decision 3 chose about revocation is exercised by a test, including
   when the choice was "nothing happens": a test that documents the gap is worth
   more than a criterion quietly dropped.
10. `herdr-file-viewer` installs and opens on macOS or Linux. This is the only
    criterion requiring the network; say in the handoff what version was tested.

## Do NOT do in this phase

- No event hooks or plugin-invoked RPCs beyond the five commands, until a plugin
  needs them.
- No Windows. The project does not support it.
- No plugin sandboxing claims. Bounding output is not a security boundary, and
  the handoff must not imply it is.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- The answers to the four decisions above, and where they landed in PLAN.md
- The manifest subset honoured, and what is ignored
- Exactly what `plugin install` executes, and what a user is trusting
- Which plugins were tested, at which versions
- If the phase was started and abandoned: **why**, in enough detail that the next
  session does not rediscover it. That is the most useful possible outcome of an
  optional phase.
