# Handoff — end of Phase 10

**Read `PLAN.md` first, then `phases/PHASE-11.md` and `phases/PARITY.md`.** This file is
the state of the world as this session leaves it. Everything was measured on
**2026-09-21**, macOS (darwin 25.6.0, arm64, Apple silicon, 10 cores), Node v22.1.0,
pnpm 10.18.0, git 2.54.0 (Apple Git-157). **`rg`, `bat`, `glow` and `delta` are still not
installed on this machine** — unchanged from phase 9, see *Open threads*.

## Status

- **Phase 10 complete: yes, on all 10 criteria.** The phase was optional and was decided,
  not defaulted into; the four decisions it required are in `PLAN.md`'s key-decisions
  table, with the numbers next to them.
- `pnpm test` is **1,389 tests in 82 files, all green** on a full serial run at load
  average 16.85. Four full runs were made; the last was clean.
- **One of the two long-documented flakes is diagnosed and fixed** — see *Surprises*.

| # | Criterion | Verdict | Where |
|---|---|---|---|
| 1 | `pnpm test` green | met | 1,389/1,389 |
| 2 | `plugin install <owner/repo>` clones, builds, registers — against a **local fixture** | met | `daemon/test/plugin-install.test.ts`, `client/test/plugin-cli.test.ts` |
| 3 | a declared action opens in a split pane and in a tab, both idempotent | met | `daemon/test/plugins.test.ts` |
| 4 | `plugin list --json` matches the shape the launchers parse | met | `client/test/plugin-cli.test.ts` `describe('plugin list --json')` |
| 5 | the shim answers every command the launchers use | met — and it is **six**, not five | `client/src/compat.test.ts`, plus end-to-end through a real daemon |
| 6 | a failed build is reported and leaves nothing half-installed | met | `daemon/test/plugin-install.test.ts` `describe('a build that fails')` |
| 7 | output over the cap is truncated and reported, not buffered | met | `daemon/src/plugins/run.test.ts` |
| 8 | an install is pinned; a changed artifact at the same ref is refused | met | same file, `describe('pinning')` |
| 9 | the revocation decision is exercised by a test | met — the choice was "nothing", and the test says so | same file, `describe('revocation: what this host does not have')` |
| 10 | `herdr-file-viewer` installs and opens | met, on macOS | see **Which plugins were tested** |

## What exists now

`leap-chorus` is a herdr plugin host. `leap-chorus plugin install <owner>/<repo>` fetches
a shallow checkout over git, reads the plugin's `herdr-plugin.toml`, shows the user every
argv it is about to run and every manifest key it will ignore, runs the declared build,
refuses a manifest the build rewrote, and swaps the result into a store under the data
root with one rename and a way back. What it installed is **pinned**: the content hash of
the fetched source is recorded, and the same ref producing different bytes later is
refused rather than installed. A plugin's declared pane or action opens as an **ordinary
pane** — `pane.split` or `tab.create` with the plugin's argv — idempotently, so a second
open focuses the first. A plugin's own process gets herdr's environment variable names,
and `$HERDR_BIN_PATH` points at a generated wrapper called `herdr-compat` that translates
herdr's CLI into ours. **`herdr-file-viewer` v1.17.0 installs from GitHub and runs
unmodified**, including its own launch-or-focus-or-toggle logic.

Three sidebar bugs were also fixed, all reported from screenshots during the phase and
all in phase 7-9 code: a click on an Explorer row did nothing but move the highlight, the
Preview view said "nothing selected" while a file sat under the tree's cursor, and — after
the first fix went too far — a click on a file spawned a `$PAGER` pane per click.

## Deliverables, as they landed

| File | Lines | What |
|---|---|---|
| `packages/daemon/src/plugins/manifest.ts` | 392 | `herdr-plugin.toml`: the subset honoured, and every key that is not |
| `packages/daemon/src/plugins/install.ts` | 451 | fetch, preview, build, pin, atomic swap, rollback |
| `packages/daemon/src/plugins/registry.ts` | 277 | the on-disk store, the two content hashes, `verify` |
| `packages/daemon/src/plugins/run.ts` | 258 | bounded output, bounded time, bounded concurrency |
| `packages/daemon/src/rpc/plugins.ts` | 335 | `plugin.list`, `plugin.pane.open`, `plugin.action.invoke` |
| `packages/client/src/plugin-cli.ts` | 568 | `plugin install/list/verify/remove/config-dir/shim/pane/action` |
| `packages/client/src/compat.ts` | 281 | the herdr translation table, and the shim's text |
| `scripts/herdr-compat.mjs` | 44 | the `$HERDR_BIN_PATH` shim for a source checkout |
| `packages/daemon/src/plugins/manifest.test.ts` | 303 | 40 tests |
| `packages/daemon/test/plugin-install.test.ts` | 367 | 34 tests, real git |
| `packages/client/src/compat.test.ts` | 233 | 34 tests |
| `packages/daemon/test/plugins.test.ts` | 417 | 29 tests, real daemon |
| `packages/daemon/src/plugins/registry.test.ts` | 243 | 25 tests |
| `packages/client/test/plugin-cli.test.ts` | 338 | 19 tests, real child processes |
| `packages/daemon/src/plugins/run.test.ts` | 160 | 16 tests |
| `packages/daemon/test/plugin-fixture.ts` | 118 | a plugin as a real git repository |
| `packages/client/src/explorer.test.ts` | 59 | 3 tests, the click fix |

**`install.ts` is a fifth file the phase's deliverable list did not name.** It was going
to be half of `registry.ts`, and separating "what is installed" from "how something gets
installed" is worth one extra file: the store is read on every plugin launch and the
installer runs once, in a different process.

## The four decisions, and where they landed

All four are in `PLAN.md`'s key-decisions table, which is where the phase asked for them.
Short forms:

1. **Does `leap-chorus` execute code fetched from a URL on a user's say-so? Yes.** The
   number the phase asked to be written next to it: orca's yes is **9,914 non-test
   lines**; ours is **~1,400** including tests. The difference is the security model —
   no capability set, no consent fingerprint, no kill list, no worker isolation.
2. **Pinned.** Content hash of the fetched source; a changed artifact at the same ref is
   refused; `--update` to accept, `--pin` to verify a first install against a published
   hash.
3. **Revocation: nothing happens.** Written down rather than discovered later. See below.
4. **The shim is honest.** No binary named `herdr` is shipped.

## What a user is trusting, in plain words

`plugin install` runs **an arbitrary program from a stranger's repository, as the user,
with the user's filesystem, network and credentials**. For `herdr-file-viewer` that
program is `scripts/fetch-or-build.sh`, which downloads a prebuilt binary or falls back
to `cargo build`.

What is actually defended:

- **Nothing runs before it has been shown.** The manifest is read from the fetched
  checkout and printed — id, version, every build argv, every entrypoint argv, every
  ignored key — and the build runs only after a yes. `--yes` is required when stdin is
  not a terminal, so this is not something a script can do to a user.
- **The manifest cannot change under its own build.** herdr's
  `ensure_manifest_unchanged_after_build`, and the attack is sharp: without it a build
  script appends `[[actions]]` to the file the preview rendered and the host registers
  what nobody saw.
- **The artifact is pinned**, as above.
- **A failed install leaves nothing.** Everything happens in a temp directory under the
  data root; the store is touched by one rename, with the previous checkout kept aside
  until the registry write succeeds.
- **Output and concurrency are bounded** — 64 KiB, 32 in flight, herdr's numbers.

**None of that is a sandbox**, and the phase was explicit that the handoff must not imply
it is. Bounding output is not a security boundary. A plugin can read every file the user
can read and open every socket the user can open, before and after the confirmation.

## Revocation: what this does not have

There is **no kill list**. No signed list, no fetch, no revocation at a distance. If a
plugin turns out to be malicious after a hundred people installed it, **a hundred people
each have to run `leap-chorus plugin remove`**. `daemon/test/plugin-install.test.ts` has
a test that says exactly this, because the phase asked for the gap to be exercised rather
than quietly dropped.

What exists instead, and what it is worth:

| | Catches | Does not catch |
|---|---|---|
| `plugin verify` | a file changed in the store after the install | a plugin that was malicious the day it was published |
| the pin | a rewritten tag, an account takeover upgrading an installed plugin | the first install of a bad plugin |
| `plugin list --json` | publishes the commit and hash, so a user can compare against an advisory | nothing, on its own — it needs someone to read it |

Orca's `plugin-kill-list.ts` is the shape of the thing that is missing, including the
detail worth copying if it is ever built: refuse a list whose `generatedAt` is more than
24 hours ahead of the clock, or a far-future entry disables revocation permanently.

## The manifest subset honoured, and what is ignored

| Key | Honoured |
|---|---|
| `id` `name` `version` `description` | yes, validated |
| `platforms` | yes — an entry not for this platform is never offered |
| `[[build]]` | yes, at install, in the fetched checkout, bounded |
| `[[actions]]` | yes — argv, runnable headless or in a pane |
| `[[panes]]` | yes — argv, opened in a split or a tab |
| `[[events]]` | **no** |
| `[[startup]]` | **no** |
| `[[link_handlers]]` | **no** |
| `min_herdr_version` | **no** — a claim about a program this is not |
| an action's `contexts` | **no** — it picks a herdr menu we do not have |
| a pane's `width` / `height` | **no** — they size a popup we do not have |

**Every ignored key is named, never dropped.** `manifest.ignored` collects them, the
install preview prints them with the line "this host does not run those; the plugin may
not work as written", and `plugin list` keeps them. An unknown key is reported too, and
marked `(unknown)`, so a typo in `platforms` is distinguishable from a feature we skipped.
This is the same failure mode the phase's notes on orca's capability set warn about: a
plugin that appears installed and quietly does nothing.

**Placements.** herdr has five; this multiplexer has one kind of pane. `split` and `tab`
are honoured; `overlay`, `popup` and `zoomed` fall back to `split`, and the fallback is
reported in `placementFallbackFrom` rather than hidden.

**Ids are validated harder than herdr's.** A plugin id becomes a directory name; herdr
percent-encodes whatever it is given, and we refuse anything that is not already a safe
path component. The encoder is a second place for a traversal bug to hide.

## Types and contracts the next phase depends on

Three new methods on `AgentMethodMap`, all in `AGENT_METHODS`:

```ts
'plugin.list':          { params: PluginListParams;         result: PluginListResult }
'plugin.pane.open':     { params: PluginPaneOpenParams;     result: PluginPaneOpenResult }
'plugin.action.invoke': { params: PluginActionInvokeParams; result: PluginActionInvokeResult }
```

```ts
type PluginPlatform = 'linux' | 'macos' | 'windows'
type PluginPlacement = 'split' | 'tab'
type PluginDeclaredPlacement = 'overlay' | 'popup' | 'split' | 'tab' | 'zoomed'
type PluginEntrypointKind = 'pane' | 'action'

interface PluginEntrypointInfo {
  id: string; title: string; description: string | null
  kind: PluginEntrypointKind
  placement: PluginPlacement
  placementFallbackFrom: PluginDeclaredPlacement | null
  command: readonly string[]          // argv; never run through a shell
  platforms: readonly PluginPlatform[] // empty means every platform
}

interface PluginPin {
  source: string          // 'owner/repo[/subdir]' or a local path, as typed
  ref: string | null      // null when the remote's default HEAD was taken
  commit: string
  contentHash: string     // sha256 over the *fetched source*, `.git` excluded
}

interface InstalledPluginInfo {
  id; name; version; description: string | null
  root; manifestPath; configDir; stateDir: string
  platforms: readonly PluginPlatform[]
  entrypoints: readonly PluginEntrypointInfo[]
  ignored: readonly string[]
  pin: PluginPin
  installedHash: string   // sha256 over the *built store*, what `verify` compares
  installedAt: number
  missing: boolean        // registered, but its files are gone
}
```

**Two hashes, because there are two questions.** `pin.contentHash` answers "did the remote
hand me the same bytes as last time?" and is taken before the build. `installedHash`
answers "has anything changed under my feet since?" and is taken after. One hash cannot do
both: a build writes into its own checkout, so a pin taken after it would differ on every
machine, and a check that always fires is a check nobody reads.

### The services

```ts
class PluginStore {
  constructor(dataRoot: string)
  readonly pluginsDir, registryPath, storeDir, tmpDir, binDir, shimPath: string
  rootFor(id): string; configDirFor(id): string; stateDirFor(id): string
  ensureUserDirs(id): void
  list(): InstalledPluginInfo[]
  get(id): InstalledPluginInfo | null
  save(record: PluginRecord): void
  remove(id, options?: { purge?: boolean }): boolean
  verify(id): PluginVerifyReport | null    // 'ok' | 'changed' | 'missing'
}
function hashDirectory(root: string): string   // sorted, exec-bit only, symlinks unfollowed

class PluginInstaller {
  constructor(store: PluginStore, options?: { runner?; now?; platform? })
  install(options: InstallOptions): Promise<InstallOutcome>
}
function parsePluginSource(raw: string): PluginSource   // 'owner/repo[/sub]' or a local path
function remoteUrlFor(source: PluginSource): string     // a path becomes file://

class PluginRunner {
  constructor(options?: { maxBytes?; maxInFlight?; spawnFn? })
  run(request: PluginRunRequest): Promise<PluginRunOutcome>   // rejects only on the in-flight cap
  get inFlight(): number
}
const PLUGIN_OUTPUT_MAX_BYTES = 65536
const MAX_PLUGIN_COMMANDS_IN_FLIGHT = 32

function parsePluginManifest(text: string): PluginManifest
function loadPluginManifest(path: string): { manifest; manifestPath; root }
function currentPluginPlatform(p?: NodeJS.Platform): PluginPlatform | null
function effectivePlatforms(entry, plugin): readonly PluginPlatform[]
function platformAllows(platforms, current): boolean

// client
function translateHerdrArgv(argv, env?): Translation      // { argv, notes }
function shimScript(execPath: string, entry: string | null): string
function writeShim(shimPath: string, options?): string
function herdrPluginListJson(plugins, shimPath): Record<string, unknown>
```

### What changed outside the plugin code

```ts
interface TabCreateParams {          // gained command/args, mirroring workspace.create
  ...
  command?: string
  args?: readonly string[]
}

type ExplorerOutcome =
  | ...
  | { kind: 'preview'; path: string }   // new: a click, which is not `⏎`

class ExplorerPanel {
  activate(): ExplorerOutcome                          // was private
  clickRow(row: number, area: Rect): ExplorerOutcome   // was `: boolean`
}
class SidebarPanels {
  previewTarget(): string | null   // the file to seed an empty preview with
}
```

`leap-chorus pane list` gained `tabId` and `workspaceId`, and a `--herdr-json` flag. There
is a new `leap-chorus tab list|focus|close`. Both are explained under *Surprises*.

## The data root

```
<dataRoot>/plugins/
  registry.json     what is installed, and what it is pinned to (durable, one .bak)
  store/<id>/       the checkout, as fetched and built
  config/<id>/      HERDR_PLUGIN_CONFIG_DIR — the user's; kept on uninstall
  state/<id>/       HERDR_PLUGIN_STATE_DIR
  bin/herdr-compat  the $HERDR_BIN_PATH shim, rewritten on every `plugin …` call
  tmp/              install scratch; nothing here survives a failed install
```

The registry is written by the **client** during `plugin install` and re-read by the
daemon on every use. Install means a `git fetch` and then a stranger's build script, which
has no business inside the process that owns every PTY, and the confirmation it must ask
for is on a terminal the daemon does not have. herdr splits it the same way and for the
same reason. A cached store in the daemon would go stale the moment a user installed
something; the file is a few hundred bytes.

## Which plugins were tested, at which versions

| Plugin | Version | How |
|---|---|---|
| `smarzban/herdr-file-viewer` | **1.17.0**, commit `c237626260478d5f2d788149fc741ddf3c3588ba` | installed from GitHub on macOS arm64. `scripts/fetch-or-build.sh` took the fast path: "installed prebuilt v1.17.0 (aarch64-apple-darwin), verified SHA-256" — **no Rust toolchain was needed** |
| a local fixture | n/a | `daemon/test/plugin-fixture.ts`, a real git repository; everything in CI uses this |

The viewer was driven **through its own launcher scripts**, not through our RPC:
`scripts/open-file-viewer.sh` opened it in a split, a second run closed it again (its own
`--launch-decision` returning `CLOSE`), and `scripts/open-file-viewer-tab.sh` opened it in
a tab. It rendered this repository's tree with git decorations and the branch name in its
footer. **This is the only criterion requiring the network**, and it is the one that found
the two things below.

## Surprises

- **It is six commands, not five — and translating commands is not enough.** The phase
  counted five from `herdr-file-viewer`'s description. Reading its launcher scripts found
  `tab focus <tab_id>`, which the tab launcher uses to switch to an existing viewer tab
  instead of opening a second one; `leap-chorus` had no `tab` command at all. Worse, the
  *output* is part of the contract: `open-file-viewer.sh` pipes `pane list` straight into
  the viewer binary's own Rust `launch_decision`, which deserializes
  `{result:{panes:[{pane_id,label,focused,tab_id}]}}` and **answers `OPEN` for anything it
  cannot parse**. Our `pane list` printed a bare camelCase array and carried no `tab_id` at
  all — close enough to look right, and different enough that the plugin would have worked
  while silently losing focus-and-close forever, opening a new viewer on every keypress.
  Hence `pane list --herdr-json`, which only the shim sets. **A compatibility shim that
  only translates argv is a shim that half works, and the half that fails is silent.**
- **A plugin starts in its own directory, not the user's.** `herdr-file-viewer`'s manifest
  is `command = ["./target/release/herdr-file-viewer"]` — a *relative* program. This host
  had copied the obvious-looking thing, the focused pane's cwd, and it survived every
  fixture because a fixture declares an absolute `sh`. Started in the user's repository
  the program is not there, the pane's process dies immediately, and the pane closes
  itself a frame later: indistinguishable from a plugin that opened and instantly crashed,
  with nothing on screen to read. herdr's `plugin_pane_cwd` defaults to `plugin_root` and
  so does its action runner. A plugin that wants the user's directory reads
  `focused_pane_cwd` out of `HERDR_PLUGIN_CONTEXT_JSON`, which is what that field is for —
  and it is how the viewer shows the right tree while running from somewhere else.
- **`survival.test.ts`'s flake was never the survival assertion.** Three handoffs called
  it undiagnosed. It is `ENOTEMPTY: directory not empty, rmdir …/daemon` out of
  `cleanupDataRoots`: `stop()` sent SIGKILL after a 5 s SIGTERM timeout and then
  **returned without waiting**, so teardown deleted the data root while a live daemon was
  still writing its session file into it. `rmSync` walks the tree, the daemon puts a file
  back, `rmdir` fails — and a teardown failure fails the *test*, which is how a harness
  race looked like a product bug for three phases. Fixed by waiting for the SIGKILL to
  land, plus a bounded retry in `cleanupDataRoots` as a backstop. It went from 1/5 to 6/6
  in isolation at load 18.
- **The click gesture was wrong, and the first fix was wrong in the other direction.**
  Reported from a screenshot: folders "not getting nested". A click on an Explorer row
  only moved the cursor — it never expanded anything — so a folder looked inert to anyone
  using a mouse. The first fix made a click mean `⏎`, which with `[sidebar] preview` off
  hands the file to `$PAGER` **in a new pane**: clicking down a tree left one pane per
  click, and since the dock holds the keyboard none of them could even be scrolled. A
  click and `⏎` are not the same request. A click now folds a directory and previews a
  file in the dock; `⏎` is unchanged.
- **The preview's empty state was a lie about its own state.** Switching to the Preview
  view with a file highlighted in the tree said "nothing selected", because only `⏎` and
  the row menu had ever handed it a path. It now seeds from the tree's cursor, and still
  says nothing is selected when that cursor is on a directory.
- **A plugin's pane needed no new pane type, exactly as the phase said.** `pane.split` and
  `tab.create` with an argv, and the only thing missing was `command`/`args` on
  `tab.create` — which `workspace.create` has had since phase 4 and `pane.split` since
  before that. Three lines in the reducer.
- **Idempotency is per entrypoint, not per placement**, and that turned out to be the
  reading the plugin's own launcher agrees with: asking for the viewer in a tab when it is
  already open in a split focuses the split. The thing the user wants is the viewer, not
  another one.

## Open threads deliberately left

- **`multiplexer.test.ts` is still flaky and is a different cause.** Roughly 1 run in 6 at
  load 12, failing on `expected 0 to be greater than or equal to 2` — a timing assertion,
  not a teardown race. It passes in isolation. Unchanged by this phase and still
  undiagnosed; the `survival.test.ts` fix does not touch it.
- **No event hooks, no startup commands, no link handlers**, per the phase's "do NOT do"
  list. The manifest reader parses and names them; nothing fires them. A plugin whose whole
  behaviour is event hooks will install cleanly and do nothing, and the install preview
  says so.
- **No `plugin enable`/`disable`.** herdr has both. `plugin list --json` reports
  `enabled: true` for anything whose files are present, so a script that filters on it
  sees every plugin it can run rather than none.
- **No plugin log.** herdr keeps a ring of command logs (`plugin log list`); an action's
  output comes back to the caller here and is not retained.
- **Windows is not supported**, per the phase and per PLAN.md. `windows` *parses* in a
  manifest — refusing the word would make every cross-platform plugin uninstallable here —
  and nothing declared `windows`-only is ever offered.
- **Sidebar and preview cannot be visible at once**, and that is the largest remaining
  shape difference from herdr-sidebar. Now an orphan in `PARITY.md` with a tabbed file
  header beside it; neither is owned by a phase.
- **Still no syntax highlighting.** Unchanged from phase 9: the dock paints its own styles
  and cannot consume ANSI, so `bat` runs `--color=never`. It needs an ANSI-to-`Style`
  parser, which is real work and not a renderer swap.
- **`follow-pane` still does not work.** Named in phase 9 and in `PARITY.md`; nothing in
  this phase touched `app.ts`'s geometry.
- **Nothing has run against a real `rg`, `bat`, `glow` or `delta`.** Unchanged and still
  the cheapest available coverage win — `brew install ripgrep bat glow git-delta`, then
  re-run `daemon/src/preview.test.ts` and `client/test/search.test.ts`.
- **`DaemonClient` still has no request timeout**, unchanged since phase 4.
- **`bench/RESULTS.md` was not regenerated.** Phase 10 touched no render-path code — the
  dock's only change is what a click means — so there was nothing to measure, and the
  generator still silently destroys the hand-written sections. `git checkout --
  bench/RESULTS.md` after any run. **Two handoffs have now said this; the fix is code.**
- **Criterion 2 of phase 5 is still the important gap** — detection has never been checked
  against a running agent, and three of six platform slots have never been built.

## Getting started in a new session

```bash
pnpm install
pnpm build
ln -s "$PWD/packages/client/dist/main.js" ~/.local/bin/leap-chorus
pnpm test                                    # 1,389 tests; do not run anything alongside it
leap-chorus                                  # C-b e files · C-b f search · C-b g git · 1/2/3/4

# the plugin host
leap-chorus plugin install smarzban/herdr-file-viewer --yes
leap-chorus plugin list --json
leap-chorus plugin verify
leap-chorus plugin shim                      # what $HERDR_BIN_PATH points at
leap-chorus plugin pane open --plugin herdr-file-viewer --entrypoint file-viewer

# and what a plugin's own launcher does, by hand
HERDR_BIN_PATH=$(leap-chorus plugin shim) \
  bash ~/.leap-chorus/plugins/store/herdr-file-viewer/scripts/open-file-viewer.sh

brew install ripgrep bat glow git-delta      # then re-run search and preview tests
uptime && node bench/dist/render-scale.js --seconds 15
git checkout -- bench/RESULTS.md             # THE BENCHMARK DESTROYS IT
pgrep -f leap-chorusd                        # a leaked daemon forks `ps` every 750 ms
```
