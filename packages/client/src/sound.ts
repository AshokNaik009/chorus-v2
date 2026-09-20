/**
 * Notification sounds for agent state changes.
 *
 * Derived from herdr's `src/sound.rs`: a bundled audio file handed to whatever player
 * the platform already has — `afplay` on macOS, one of several on Linux.
 *
 * ## Why not the terminal bell
 *
 * This used to write `\x07` and let the terminal decide, on the reasoning that a
 * multiplexer has no business acquiring an audio device. The reasoning was sound and
 * the result was silence: VS Code's integrated terminal ignores BEL by default, as do
 * most modern terminals, so the feature was off for most users with no way to tell.
 * herdr reached the same conclusion and ships real audio. The bell survives as the
 * fallback for when no player exists.
 *
 * ## Why fire-and-forget
 *
 * Playback happens on the render path. Nothing here may block a frame, reject, or hold
 * the event loop open: the child is detached, its output discarded, and its handle
 * unref'd. A missing player is not an error worth telling anyone about — it is why the
 * caller keeps the bell.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Which of the two notifications to play. */
export type SoundKind = 'done' | 'blocked'

/** Set to any value to silence playback entirely, as herdr's `HERDR_DISABLE_SOUND` does. */
const DISABLE_ENV = 'LEAP_CHORUS_DISABLE_SOUND'

interface Player {
  readonly program: string
  readonly args: readonly string[]
}

/**
 * Players to try, in order, for the current platform.
 *
 * Deliberately no bare `aplay`: it does not decode MP3 and would play the bytes as raw
 * PCM, which is loud noise rather than a notification. That warning is inherited from
 * herdr, which found it the hard way.
 */
function playersFor(platform: NodeJS.Platform): readonly Player[] {
  if (platform === 'darwin') return [{ program: 'afplay', args: [] }]
  if (platform === 'win32') return []
  return [
    { program: 'paplay', args: [] },
    { program: 'pw-play', args: [] },
    { program: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet'] },
    { program: 'mpg123', args: ['-q'] },
    { program: 'mpv', args: ['--no-video', '--really-quiet'] }
  ]
}

/** The file each kind plays, using herdr's names. */
const ASSET: Readonly<Record<SoundKind, string>> = {
  done: 'done.mp3',
  blocked: 'request.mp3'
}

/**
 * Find `assets/sounds` by walking up from this module.
 *
 * One mechanism covers all three layouts, because in each of them the directory is at
 * or above the running file: `packages/client/dist/` reaches the repo root, the bundle
 * in `dist-app/` and the tarball's `lib/` both carry their own copy alongside.
 */
function assetDir(): string | null {
  let here = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(here, 'assets', 'sounds')
    if (existsSync(candidate)) return candidate
    const parent = dirname(here)
    if (parent === here) break
    here = parent
  }
  return null
}

let cachedAssetDir: string | null | undefined

/**
 * Expand a leading `~`.
 *
 * A config file is a place people write `~/sounds/ding.mp3`, and `resolve` would turn
 * that into a directory literally named `~`.
 */
function expandHome(path: string): string {
  if (path !== '~' && !path.startsWith('~/')) return path
  const home = homedir()
  return path === '~' ? home : join(home, path.slice(2))
}

/** The file to play for `kind`, preferring a configured override. Null if there is none. */
export function soundPath(kind: SoundKind, custom?: string | undefined): string | null {
  if (custom !== undefined && custom !== '') {
    const path = resolve(expandHome(custom))
    if (existsSync(path)) return path
    // A configured path that is not there is the user's typo, and falling back to the
    // bundled sound is friendlier than silence they have to debug.
  }
  if (cachedAssetDir === undefined) cachedAssetDir = assetDir()
  if (cachedAssetDir === null) return null
  const path = join(cachedAssetDir, ASSET[kind])
  return existsSync(path) ? path : null
}

/**
 * Is `program` on `$PATH`?
 *
 * Looked up rather than discovered by spawning, because a missing binary reports
 * itself asynchronously — `spawn` of a program that is not there throws nothing and
 * emits `error` later, so a try/catch around the spawn cannot pick the next player.
 */
function onPath(program: string): boolean {
  const path = process.env['PATH']
  if (path === undefined || path === '') return false
  return path.split(':').some((dir) => dir !== '' && existsSync(join(dir, program)))
}

/** The first installed player, or null when the machine has none. */
function availablePlayer(platform: NodeJS.Platform): Player | null {
  return playersFor(platform).find((player) => onPath(player.program)) ?? null
}

/** Is playback possible at all? The caller rings the bell when it is not. */
export function canPlay(platform: NodeJS.Platform = process.platform): boolean {
  if (process.env[DISABLE_ENV] !== undefined) return false
  return availablePlayer(platform) !== null
}

/**
 * Play a notification, if anything on this machine can.
 *
 * Returns whether a player was started — not whether a sound was heard, which nothing
 * in this process can know. A false return is the caller's cue to fall back.
 */
export function playSound(kind: SoundKind, custom?: string | undefined): boolean {
  if (process.env[DISABLE_ENV] !== undefined) return false
  const player = availablePlayer(process.platform)
  if (player === null) return false
  const path = soundPath(kind, custom)
  if (path === null) return false

  try {
    const child = spawn(player.program, [...player.args, path], {
      stdio: 'ignore',
      detached: true
    })
    // A player that is on PATH can still fail to start. The event has no listener by
    // default and an unhandled `error` on a ChildProcess takes the process down, so
    // this handler is what keeps a broken audio setup from killing the client.
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}
