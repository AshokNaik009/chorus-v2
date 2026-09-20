# Phase 9 — Preview, icons, and settings

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase

Phases 7 and 8 make the panel work. This one makes it pleasant, and pays back
the two debts taken deliberately along the way: everything opens in a *new pane*,
and every glyph is ASCII.

Both were right at the time. Opening a pane means diffs and files go through the
pager the user already configured, which is why `viewer.rs` (4,082 lines) has no
counterpart here. ASCII means the panel is never broken out of the box. Neither
is the end state.

## Source material

Measured **2026-09-20** at herdr-sidebar `1a5d37e`.

| File | Lines | What to take |
|---|---|---|
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/viewer.rs` | 4,082 | Preview behaviour — **read for shape, do not port** |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/icons.rs` | 493 | The extension → glyph table |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/fontsetup.rs` | 844 | Why an icon theme needs a fallback, and how they detect |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/syntax.rs` | 211 | Highlighting seams |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/diffview.rs` | 335 | In-panel diff, if the pane version proves not enough |
| `/Users/ashoknaik/claude-experiments/herdr-sidebar/plugins/herdr-sidebar/src/suggest.rs` | 168 | AI commit drafting through the local `claude` CLI |

**`viewer.rs` is the largest single file in that project and we should not have
one.** It carries `syntect` grammars, `two-face`'s extended set, and `image`
decoding for seven formats. In a terminal multiplexer, `bat`, `glow` and `delta`
already do this and the user has already chosen them. The preview worth building
is an *embedded* one for glancing — a pane is still right for reading.

**The editor (`editor.rs`, 1,157 lines) is not planned.** herdr-sidebar labels it
experimental. This project launches `$EDITOR` in a pane, which is better than a
worse editor. If a future session disagrees, that is a decision to write down in
PLAN.md, not to slip into a phase.

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

**Never read a file into memory to decide whether to show it.** Sniff a bounded
prefix, cap the read, and refuse a binary with a message. A preview that opens a
2 GB core dump is a hang, and the panel holds the keyboard while it hangs.

**Settings persist through the config file that already exists.** `[sidebar]`
keys in `packages/core/src/config.ts`, written by the settings dialog the same
way the theme and sound sections already are. Do not invent a second store.

**AI commit drafting, if built, is opt-in and offline-capable.** `suggest.rs`
shells out to the local `claude` CLI and falls back to a filename-based message
when it is absent. Same rule as `rg` in Phase 8: absent is a message, not a
failure, and nothing leaves the machine unless the user asked for it.

## Acceptance criteria

1. `pnpm test` green.
2. Preview shows text, wraps, scrolls, and never reads more than its cap —
   tested with a file larger than the cap.
3. A binary file is refused with a message, not rendered as noise.
4. `bat` / `glow` / `delta` are used when present and the plain path is taken
   when absent; both branches tested by controlling `PATH`.
5. Icon themes: every glyph's measured width matches what the renderer assumed,
   asserted per theme. A click on a row lands on that row in all three.
6. `[sidebar]` settings round-trip: set in the dialog, written to the config
   file, survive a restart, and `C-b R` re-reads them without closing the panel.
7. Docking left or right, and unified or split Explorer/Source Control, both work
   at 80 columns without the panes collapsing.
8. No regression in `bench/RESULTS.md` — the preview is the first thing in this
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
- Whether the embedded preview made the pane-based one redundant. If it did, say
  so plainly — it would be the first thing in three phases to reverse a
  delegate-to-installed-tools decision, and the next session needs to know that
  line moved.
