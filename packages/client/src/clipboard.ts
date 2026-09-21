/**
 * Copy to the system clipboard, the only way a terminal can: OSC 52.
 *
 * PHASE-11 asks for this to be decided rather than defaulted into, because four drawer
 * menus have a `Copy …` entry and this project had no clipboard path at all.
 *
 * ## Why OSC 52 and not `pbcopy` / `xclip` / `wl-copy`
 *
 * The client is the process attached to the terminal, and the terminal may be on a
 * different machine: `leap-chorus` over SSH draws on a laptop and runs on a server,
 * and a `pbcopy` spawned there copies into the *server's* clipboard, which nobody can
 * paste from. OSC 52 is an escape sequence the terminal emulator itself acts on, so it
 * lands on the machine with the keyboard. That is the reason to prefer it, and it is
 * the reason herdr and every other TUI does the same.
 *
 * ## And why the caller has to say it might not have worked
 *
 * There is **no reply**. A terminal that does not implement OSC 52 — or implements it
 * and has clipboard writes disabled, which is the default in xterm and in some
 * configurations of others — silently discards the sequence. There is nothing to wait
 * for and nothing to check. So `copyToClipboard` returns the sentence the caller must
 * show: it names what was copied *and* says it may have been ignored. A copy that
 * cannot be confirmed must say so rather than appear to work; the alternative PHASE-11
 * offers is dropping the `Copy` entries, and a menu entry that silently does nothing
 * is the outcome both of us are avoiding.
 */

/**
 * The largest string this will send.
 *
 * Base64 of 8 KiB is 11 KiB of escape sequence, which is already generous for a hash,
 * a branch name or a path — the four things that reach this. The bound exists because
 * some terminals cap the sequence length and truncate silently, and a *half* copied
 * path is worse than a refusal.
 */
export const OSC52_MAX_BYTES = 8192

/** The escape sequence itself: `ESC ] 52 ; c ; <base64> BEL`. */
export function osc52(text: string): string {
  return `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`
}

export interface CopyOutcome {
  /** Whether the sequence was written at all. */
  readonly sent: boolean
  /** What to put in front of the user. Always says what is uncertain. */
  readonly message: string
}

/**
 * Write `text` to the terminal's clipboard and report honestly.
 *
 * `what` names the thing — "hash", "path" — so the message reads as a sentence about
 * what just happened rather than as a generic acknowledgement.
 */
export function copyToClipboard(write: (data: string) => void, text: string, what: string): CopyOutcome {
  if (text.length === 0) return { sent: false, message: `nothing to copy` }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > OSC52_MAX_BYTES) {
    return { sent: false, message: `${what} is too long to copy (${bytes} bytes)` }
  }
  write(osc52(text))
  return { sent: true, message: `${what} sent to clipboard (OSC 52 — ignored by some terminals)` }
}
