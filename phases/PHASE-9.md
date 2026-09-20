# Phase 9 — Preview, icons, and settings

**Read `../PLAN.md`, `../HANDOFF.md` and `PARITY.md` first.**

**The port target is herdr-sidebar.** This phase owns the largest block of
still-red rows in `PARITY.md` — preview, icons, docking, `[sidebar]` settings
and the AI commit draft — and it is also where the **orphans** have to be
resolved one way or the other. Read that file's closing section before
planning. Orca appears below as a solutions library only.

## Why this phase

Phases 7 and 8 make the panel work. This one makes it pleasant, and pays back
the two debts taken deliberately along the way: everything opens in a *new pane*,
and every glyph is ASCII.

Both were right at the time. Opening a pane means diffs and files go through the
pager the user already configured, which is why `viewer.rs` (4,082 lines) has no
counterpart here. ASCII means the panel is never broken out of the box. Neither
is the end state.

## Source material

### herdr-sidebar — the shape

Measured **2026-09-20** at herdr-sidebar `1a5d37e`.

| File | Lines | What to take |
|---|---|---|
| `…/herdr-sidebar/src/viewer.rs` | 4,082 | Preview behaviour — **read for shape, do not port** |
| `…/herdr-sidebar/src/icons.rs` | 493 | The extension → glyph table |
| `…/herdr-sidebar/src/fontsetup.rs` | 844 | Why an icon theme needs a fallback, and how they detect |
| `…/herdr-sidebar/src/syntax.rs` | 211 | Highlighting seams |
| `…/herdr-sidebar/src/diffview.rs` | 335 | In-panel diff, if the pane version proves not enough |
| `…/herdr-sidebar/src/suggest.rs` | 168 | AI commit drafting through the local `claude` CLI |

**`viewer.rs` is the largest single file in that project and we should not have
one.** It carries `syntect` grammars, `two-face`'s extended set, and `image`
decoding for seven formats. In a terminal multiplexer, `bat`, `glow` and `delta`
already do this and the user has already chosen them. The preview worth building
is an *embedded* one for glancing — a pane is still right for reading.

**The editor (`editor.rs`, 1,157 lines) is not planned.** herdr-sidebar labels it
experimental. This project launches `$EDITOR` in a pane, which is better than a
worse editor. If a future session disagrees, that is a decision to write down in
PLAN.md, not to slip into a phase.

### What orca already knows — mechanics only

Measured **2026-09-20** at orca `061a756b84`. Not a parity target. Orca is
Electron, so it has nothing to say about terminal glyph widths or docking — the
icon work below is ours alone, and herdr-sidebar's `fontsetup.rs` is the
reference for it. What orca has is **reading files safely** and **not losing the
settings file**.

| Orca file | Lines | What it knows |
|---|---|---|
| `src/shared/node-bounded-file-reader.ts` | 70+ | reading to a cap without a TOCTOU hole |
| `src/relay/fs-handler-utils.ts` | 233 | binary sniffing from a bounded prefix; the size caps |
| `src/main/durable-file-write.ts` | — | why rename-without-fsync still loses a config file |

**1. Sniff a prefix; never read the file to decide about the file.** Orca's
`isBinaryFilePrefix` opens the file, reads `BINARY_PROBE_BYTES = 8192` into a
fixed buffer, and looks for a NUL. `isBinaryBuffer` scans at most 8192 bytes
even when handed more. A preview that reads a 2 GB core dump to discover it is
binary is a hang, and the panel holds the keyboard while it hangs.

**2. Stat-then-read is a race, and the fix is one extra byte.**
`readNodeFileWithinLimit` stats, rejects over the cap, allocates, reads — and
then **probes one byte past the stat size**, because the file can grow between
the stat and the read. Without that probe a file being appended to returns a
silently short buffer that looks complete. It also rejects a non-safe-integer or
negative `maxBytes` rather than treating it as "no limit".

**3. Orca's caps, as a starting point:**

```
MAX_TEXT_FILE_SIZE          = 10 MiB   // text preview
MAX_PREVIEWABLE_BINARY_SIZE = 50 MiB
BINARY_PROBE_BYTES          =  8 KiB
```

Ours should be far smaller — orca renders into Monaco, we render into a 34-column
dock — but the *shape* (a text cap, a separate binary cap, a probe size) is
right, and the error type should carry the observed size and the limit so the
message can say both.

**4. A `rename()` is atomic for readers and not durable.** This is the one that
applies to code already shipped. `packages/daemon/src/runtime.ts:548` writes the
session file to a sibling and renames it — correct against a mid-write kill, and
**not** correct against power loss. Orca's comment, from a real bug:

> rename() is atomic for readers but not durable. Without fsync on the file and
> its directory, a power loss after a successful rename can leave the old
> contents, or an empty inode — the same empty-file symptom as issue #1158, from
> a different cause.

So: fsync the file before the rename, fsync the containing directory after it
(best-effort — Windows cannot, some filesystems refuse), and keep a `.bak` ring.
The settings this phase writes are the user's config; losing it to an empty file
is worse than never having written it.

## Deliverables

```
packages/daemon/src/preview.ts     # bounded reads, binary sniffing, renderer choice
packages/daemon/src/rpc/preview.ts # preview.read
packages/client/src/preview.ts     # the embedded preview view
packages/client/src/icons.ts       # theme: ascii | emoji | nerd
packages/core/src/config.ts        # [sidebar] settings
```

**The icon theme defaults to `ascii` and stays there unless asked.** The reason
is in `packages/client/src/explorer.ts` and is not aesthetic: Nerd Font glyphs
live in the Private Use Area, `codePointWidth` in `packages/tui/src/width.ts`
measures them as one column, and a terminal that disagrees shifts every column
after them — taking the mouse hit regions with it. That is the same bug
`ui.pane-buttons = ascii` already exists to escape. Three themes, `ascii` the
default, and a test asserting every glyph in every theme measures the width the
renderer assumed.

**Detect external renderers the way phase 8 detects `rg`**, and reuse that code
rather than writing a second `onPath`. The same two distinctions apply: "not
installed" is not "not on the daemon's `PATH`", and a failed spawn is not a
missing binary.

**Settings persist through the config file that already exists.** `[sidebar]`
keys in `packages/core/src/config.ts`, written the same way the theme and sound
sections already are. Do not invent a second store — but do fix the write path
per item 4 above before putting the user's settings through it.

**AI commit drafting, if built, is opt-in and offline-capable.** `suggest.rs`
shells out to the local `claude` CLI and falls back to a filename-based message
when it is absent. Same rule as `rg` in phase 8: absent is a message, not a
failure, and nothing leaves the machine unless the user asked for it.

**Reconsider `git grep` here, or close it.** Phase 8 deliberately shipped content
search with no fallback and recorded orca's `git grep` args in `PHASE-8.md`. If
the missing-`rg` message turned out to annoy anyone, this is the phase to decide;
if it did not, say so and close the thread.

## Acceptance criteria

1. `pnpm test` green.
2. Preview shows text, wraps, scrolls, and never reads more than its cap —
   tested with a file larger than the cap.
3. A binary file is refused with a message, not rendered as noise — and the
   decision is made from a bounded prefix, asserted by a test that would fail if
   the whole file were read.
4. A file that **grows between the stat and the read** does not produce a
   silently short preview.
5. `bat` / `glow` / `delta` are used when present and the plain path is taken
   when absent; both branches tested by controlling `PATH`.
6. Icon themes: every glyph's measured width matches what the renderer assumed,
   asserted per theme. A click on a row lands on that row in all three.
7. `[sidebar]` settings round-trip: set in the dialog, written to the config
   file, survive a restart, and `C-b R` re-reads them without closing the panel.
8. The config write is durable: fsync'd, and a write interrupted at any point
   leaves either the old file or the new one, never an empty one.
9. Docking left or right, and unified or split Explorer/Source Control, both work
   at 80 columns without the panes collapsing.
10. No regression in `bench/RESULTS.md` — the preview is the first thing in this
    panel that renders arbitrary file content, so measure it.

## Do NOT do in this phase

- No editor.
- No image or video previews. They need terminal graphics protocols this project
  deliberately does not have (see PLAN.md on kitty graphics).
- No plugin host. Phase 10.

## Handoff

Write `../HANDOFF.md` from `HANDOFF-TEMPLATE.md`. Beyond the template:

- Which external renderers are used, how presence is detected, and what each
  absent one degrades to
- The preview caps, and what a file over each one looks like
- The icon theme table and how widths were verified
- Every `[sidebar]` config key, with its default
- What the config write does now, and whether the session file at
  `runtime.ts:548` was fixed with it or left alone
- Whether the embedded preview made the pane-based one redundant. If it did, say
  so plainly — it would be the first thing in three phases to reverse a
  delegate-to-installed-tools decision, and the next session needs to know that
  line moved.
