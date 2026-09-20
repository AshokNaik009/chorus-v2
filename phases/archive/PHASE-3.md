# Phase 3 — Input parsing

**Read `../PLAN.md` and `../HANDOFF.md` first.**

## Why this phase exists as its own phase

This is ~7,000 lines of byte-level state machines, and it is the **one major
subsystem that neither reference project gives us for free**. Orca's client is
Electron — the browser hands it keyboard events. We are a terminal program, so
we parse the bytes ourselves.

It is also the lowest-risk phase: pure functions, no I/O, no concurrency,
fully testable offline. Long, not hard. Do not let it sprawl into other work.

## Source material

Port from herdr. These are the files, with measured sizes:

| herdr file | Lines | What |
|---|---|---|
| `/Users/ashoknaik/claude-experiments/herdr/src/raw_input.rs` | 2,748 | Byte framer, paste/mouse disambiguation |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/parse.rs` | 1,161 | CSI/SS3 sequence parsing |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/encode.rs` | 1,256 | Key -> bytes for the pane |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/model.rs` | 557 | Key/modifier model, protocol flags |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/mouse.rs` | 258 | Mouse event model |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/keybindings.rs` | 298 | Binding table |
| `/Users/ashoknaik/claude-experiments/herdr/src/input/lease.rs` | 452 | Input routing/ownership |

All seven line counts above were re-checked on 2026-09-19 and are exact.

**Their `#[cfg(test)] mod tests` blocks are the specification.** Transliterate
the test vectors first, then write the implementation against them.

The fixture files are worth converting too, but size your expectations: they
are small tables, not corpora —
`/Users/ashoknaik/claude-experiments/herdr/tests/fixtures/keyboard_protocol_corpus.tsv`
is 40 lines, `linux_terminal_variants.tsv` 22, `macos_terminal_variants.tsv` 18.
The ~1,500 lines of inline Rust test cases across `raw_input.rs`, `parse.rs`,
and `encode.rs` are the real specification; the TSVs are a cross-terminal
sanity check on top.

## Deliverables

```
packages/
  input/                    # ~7000 lines
    src/model.ts            # Key, Modifiers, MouseEvent, KeyProtocol
    src/framer.ts           # byte stream -> complete sequences; partial buffering
    src/parse-csi.ts        # CSI/SS3 dispatch
    src/paste.ts            # bracketed paste; complete-paste detection
    src/mouse.ts            # SGR + legacy X10 mouse; orphaned-tail timeout recovery
    src/kitty.ts            # kitty keyboard protocol
    src/modify-other-keys.ts# xterm modifyOtherKeys levels
    src/win32-input.ts      # win32-input-mode (Windows conhost)
    src/encode.ts           # Key -> bytes, per negotiated protocol
    src/keybindings.ts      # binding table + resolution
    src/lease.ts            # which consumer owns input right now
    test/vectors/           # transliterated from herdr
```

## The traps, named in advance

These are the parts that look simple and are not. herdr has explicit handling
for each; read the surrounding comments before porting.

- **Orphaned mouse tails.** A truncated SGR mouse report must not be flushed as
  text on idle. herdr keeps a `timed_out_mouse_prefix` and caps recovery at 32
  bytes (`MAX_ORPHANED_SGR_MOUSE_TAIL_BYTES`). Idle is *not* evidence a report ended.
- **Paste vs oversized input.** A complete bracketed paste and a protocol
  violation look alike until you check the terminator.
- **Escape ambiguity.** A lone `ESC` is either a key or the start of a sequence.
  Resolution is timeout-based and terminal-dependent.
- **Protocol negotiation.** Kitty keyboard, modifyOtherKeys, and legacy encodings
  produce different bytes for the same keypress. The pane's active mode decides.
  herdr patched libghostty-vt specifically to expose modifyOtherKeys as a scalar
  (`/Users/ashoknaik/claude-experiments/herdr/vendor/libghostty-vt.patches.md`,
  patch 0002). **This question is already answered for us — see below.**

## Keyboard protocol state: answered

`@xterm/headless` 6.0.0's `term.modes` (`IModes`) exposes exactly ten modes:

```
applicationCursorKeysMode  applicationKeypadMode  bracketedPasteMode
insertMode  mouseTrackingMode  originMode  reverseWraparoundMode
sendFocusMode  synchronizedOutputMode  wraparoundMode
```

Useful — `applicationCursorKeysMode`, `bracketedPasteMode`, and
`mouseTrackingMode` are three of the things we would otherwise have to track by
hand. But **neither modifyOtherKeys nor the kitty keyboard protocol is in
there.** We track those two ourselves, in the daemon, off the emulator's parser
hooks. Verified working (Node 22, `allowProposedApi: true`):

```ts
term.parser.registerCsiHandler({ prefix: '>', final: 'm' }, p => { /* XTMODKEYS  */ return true })
term.parser.registerCsiHandler({ prefix: '>', final: 'u' }, p => { /* kitty push */ return true })
term.parser.registerCsiHandler({ prefix: '=', final: 'u' }, p => { /* kitty set  */ return true })
term.parser.registerCsiHandler({ prefix: '<', final: 'u' }, p => { /* kitty pop  */ return true })
```

Feeding `ESC[>4;2m ESC[>1u ESC[=5;1u ESC[<1u` fires all four with params
`[4,2]`, `[1]`, `[5,1]`, `[1]` respectively. So:

- **Keyboard protocol state is daemon-side, not client-side.** It belongs next
  to the emulator that saw the sequence, per pane, and rides the snapshot to
  the client. `encode.ts` is a pure function of `(Key, protocol flags)`; the
  flags are an input, not ambient state.
- Kitty's flag *stack* is ours to model — `>` pushes, `<` pops, `=` sets the
  current entry. xterm does not keep one for us.
- Returning `true` from a handler tells xterm the sequence is fully handled.
  Return `true` for all four: these are keyboard-protocol negotiation, and
  letting xterm's default `CSI m`/`CSI u` handling also see them is wrong.
- `term.parser` throws unless the `Terminal` was constructed with
  `allowProposedApi: true` (phase 1 already sets it).

## Acceptance criteria

1. `pnpm test` green, with the transliterated vectors passing.
2. All three herdr fixture tables pass (keyboard protocol, linux + macos
   variants) — 80 rows total.
3. modifyOtherKeys and kitty keyboard flags are tracked per pane off the
   emulator's CSI handlers, survive a client detach/reattach, and reach
   `encode()` as explicit parameters. Test the kitty push/pop stack, including
   a pop on an empty stack.
4. Round-trip property test: `encode(parse(bytes)) === bytes` for every vector
   in the corpus where a round trip is defined.
5. Mouse works in the phase-2 client: click to focus a pane, drag to select.
6. Paste of a 1MB block arrives as one paste event, not N key events.
7. A `vim` session in a pane handles arrows, function keys, and modified keys
   identically to running `vim` outside the multiplexer. Verify by hand on at
   least: iTerm2, Ghostty, Alacritty, and one Linux terminal.
8. No regression in `bench/RESULTS.md` numbers from phase 2.

## Do NOT do in this phase

- No new UI. Wire input into the phase-2 client as-is.
- No workspaces/tabs/panes model work. Phase 4.
- No copy mode or selection UI — mouse *events* only, not the selection feature.
- No Windows-specific work beyond `win32-input.ts` parsing. Full Windows
  support is phase 5+.

## Handoff

Write `HANDOFF.md`:
- Which terminals were verified, at which versions, and which key combinations
  are known-broken
- Any herdr test vector you could not make pass, and why
- The `Key`/`MouseEvent` type shape (phase 4 binds actions to these)
- The keyboard-protocol state type and where it lives on the snapshot
