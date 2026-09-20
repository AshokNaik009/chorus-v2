# Phase 7 — Source control, finished ✅ **COMPLETE**

**Status: shipped at `a016c11`.** 7 of 8 criteria met; criterion 8 (no bench
regression) was not measurable on the machine that ran it. `../HANDOFF.md` is
this phase's handoff and is the authority on what landed.

**This document is kept for two things only:** the record of what the phase got
wrong about its own defects, and the **follow-ups** below — latent problems in
the shipped code that were found afterwards by reading orca. Do not re-run this
phase. Do the follow-ups as part of phase 8 or 9, whichever touches the file.

Phase 6 (remote SSH attach) is still reserved and unbuilt. Phases 8-9 do not
depend on it and it does not depend on them.

---

## What this phase claimed, and what was true

The doc opened with three confirmed defects. Two were real and fixed. **The
first one's prescribed fix does not work**, which is the single most important
thing this phase learned:

> **Defect 1 — staging a rename leaves a dangling deletion.** The doc said
> `GitFileEntry.origin` "already carries the original path over the wire; it is
> simply unused", and that passing both paths (herdr-sidebar's
> `add -A -- <path> <orig>`) is the fix.

It is not. Git only pairs a worktree-side rename when the **target is already
tracked**, and an untracked file is not — so in the doc's own repro `origin` is
`null` on both entries and there is no second path to pass. herdr-sidebar has
the same gap; its test for this feeds `parse_status` a synthetic ` R` record
that real git does not emit in that state.

What shipped instead: find the missing half by **blob identity** —
`git hash-object` for the working-tree side, `git ls-files -s` for the index —
guarded by exact content, exactly one candidate per side, and never the empty
blob. The `origin` fix shipped too, because it is right wherever status *does*
report a rename. The same defect existed on the unstage side and this doc never
mentioned it.

Defect 2 (the panel did not scroll) became `packages/client/src/scrollview.ts`.
Defect 3 (`--renames`) turned out to matter, but not cosmetically: the flag
overrides `status.renames=false`, so passing it makes output depend on the
repository rather than on the user's `~/.gitconfig`.

---

## What orca already knows — follow-ups against shipped code

Measured **2026-09-20** at orca `061a756b84`. Orca ships a git panel in
TypeScript against the same Node APIs, and it has already paid for five things
`packages/daemon/src/git.ts` has not. **Each item below was re-verified against
real git (2.54.0, Apple Git-157) here, not taken from orca on faith.** Where it
could not be verified on this machine, it says so.

| Orca file | Lines | What it knows |
|---|---|---|
| `src/relay/git-stdout-stream.ts` | 80+ | streaming git via `spawn`; `GIT_OPTIONAL_LOCKS`; `StringDecoder` across chunks |
| `src/shared/git-status-porcelain-parser.ts` | 237 | incremental `--porcelain=v2` parsing with an entry cap |
| `src/shared/git-output-locale.ts` | 12 | pinning git's output to untranslated English |
| `src/shared/git-credential-prompt-env.ts` | 120 | making git **fail** instead of blocking on a credential prompt |
| `src/relay/git-buffer-overflow.ts` | 11 | recognising an `ENOBUFS` / `maxBuffer` truncation for what it is |
| `src/relay/git-handler-status-ops.ts` | — | `-c core.quotePath=false`, a status limit, conflict detection split out |

### 1. `git.sync` can block on a credential prompt — **fix this first**

`../HANDOFF.md` leaves this open as "`git.sync` has no timeout of its own", and
a timeout is the wrong fix. The right one is orca's: make git unable to prompt.

```ts
GIT_TERMINAL_PROMPT: '0'
GIT_ASKPASS: env.GIT_ASKPASS ?? ''
SSH_ASKPASS: env.SSH_ASKPASS ?? ''
GCM_INTERACTIVE: 'never'          // Git Credential Manager ignores the two above
// plus, via GIT_CONFIG_KEY_n/VALUE_n so caller config is not clobbered:
credential.interactive=false
credential.guiPrompt=false
```

Cached credentials keep working; only the interactive fallback dies. This
matters more here than in orca: our `runGit` uses `execFile` with a timeout, so
a prompting git is killed at the timeout with no output and reports as a generic
failure — the user is told nothing about credentials.

**Not verified here.** An unreachable host fails at DNS before any prompt, so
reproducing this needs a host that resolves and demands auth. The mechanism is
git-documented; the fix should ship with a test that asserts the env, not the
hang.

### 2. Git's output is parsed in English and git translates itself

`parseBranch` matches the literal `No commits yet on `, and sync surfaces git's
stderr. A gettext-enabled git under a non-English locale translates both — even
the `fatal:` prefix. Orca pins:

```ts
{ LANGUAGE: 'en', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' }
```

English **UTF-8** rather than plain `C`, so hooks git spawns keep a UTF-8
`LC_CTYPE`; `LANGUAGE` outranks `LC_ALL` in gettext's lookup, so it is pinned
too. Same argument as `--renames`: output should depend on the repository, not
on the user's environment.

**Not verified here.** Apple Git 2.54.0 ships no translations, so a localized
`fatal:` cannot be produced on this machine. Most Linux distribution builds are
gettext-enabled, which is where this bites.

### 3. `git status` fights the user's own shell over `index.lock`

This one is specific to our design and orca hit it first. `git status` takes
`index.lock` to write back a refreshed index. The panel is docked *next to a
shell the user runs git in*, so the panel's own status call can lose — or cause
— a lock race against the command they just typed. Orca sets
`GIT_OPTIONAL_LOCKS=0` on every status-like read, with the comment "status
polling is read-like; avoid racing terminal Git on `.git/worktrees/*/index.lock`".

**Verified accepted here:** `GIT_OPTIONAL_LOCKS=0 git status --porcelain=v2`
works normally. The contention itself was not reproduced — forcing it reliably
is a scheduling exercise — but the flag is git-documented and costs nothing.

### 4. `execFile`'s `maxBuffer` turns a big repository into a wrong message

Measured here, with our exact `runGit` rule:

```
err.code  = ERR_CHILD_PROCESS_STDIO_MAXBUFFER
our code  = 1          (the rule is "numeric code, else 1")
stdout    = 512 bytes  — partial, not empty
```

Every read site in `git.ts` checks `code !== 0`, so this is **not** silent
truncation — good. But `status()` throws `gitFailed` with `stderr.trim() ||
'git status failed'`, and stderr is empty, so a repository that emits more than
8 MB of status tells the user *"git status failed"* and nothing else. Orca's
`isGitBufferOverflowError` exists to name this case (`ENOBUFS`, or `/maxBuffer/`
in the message); the honest message is "this repository's status output exceeds
the daemon's buffer".

One place it degrades quietly by design: `worktreeBlobs` and `indexBlobs` return
an empty `Map` on any nonzero code, so an overflow there silently disables
rename pairing and falls back to the old behaviour. That is the documented
fallback, but it now has a second cause worth knowing about.

Orca's real answer is to stop buffering: stream with `spawn`, parse
incrementally, and stop git once an entry cap is crossed — because "a repo with
an enormous un-ignored folder can emit a status listing too large to buffer into
one string (it overflows V8's max string length and crashes the process)".

### 5. `--porcelain=v2` — take it for the record shape, **not** as a rename fix

Orca parses v2. It is better structured: one type-2 record carries the rename
score and both paths, and index vs worktree status are separate characters
rather than a two-letter code.

```
2 R. N... 100644 100644 100644 <hash> <hash> R100 new.txt\told.txt
```

**But it does not fix defect 1, and I checked before writing that down.** In the
untracked-target state, v2 reports exactly the same decomposition as v1:

```
### v1 -z:   ## main| D old.txt|?? new.txt|
### v2:      1 .D N... … old.txt
             ? new.txt
```

Rename detection requires a tracked target in both formats. The blob-identity
pairing stays necessary. Adopt v2 for the parse, not for the bug.

**One trap if v2 is adopted:** v2 records are newline-delimited, so you lose
`-z`, and without `-z` git octal-escapes non-ASCII paths. Verified here:

```
v1 with -z            →  ?? café-ü.txt
v1 without -z         →  ?? "caf\303\251-\303\274.txt"
v2 (no flag)          →  ?  "caf\303\251-\303\274.txt"
v2 -c core.quotePath=false →  ?  café-ü.txt
```

That is why orca passes `-c core.quotePath=false`. Our current `-z` parser is
already safe; the flag only becomes necessary if v2 is adopted. And when parsing
a stream, decode with `StringDecoder` — a UTF-8 filename can be split across
chunk boundaries.

---

## The shipped contracts

See `../HANDOFF.md` for the full list. In brief: three new RPCs (`git.branches`,
`git.checkout`, `git.sync`), `ScrollView` shared by `ScmPanel`, `ExplorerPanel`
and `BranchPicker`, and `App.typedChar(key)` because `key.char` is the
*unshifted* codepoint and the panels could not tell `s` from `S`.

## Still open from this phase

- **Criterion 8.** Re-run `node bench/dist/render-scale.js --seconds 15` on a
  quiet machine and commit the result. That instruction is now four handoffs old.
- `hash-object` does not apply `.gitattributes` filters, so rename pairing
  quietly does not fire under `text=auto` with CRLF content.
- Similarity-based rename detection is deliberately not attempted.
- The panel does not poll; a `git` command run in a pane behind it needs `r`.
- Multi-repo (herdr-sidebar's `discover_all`) is not ported.
