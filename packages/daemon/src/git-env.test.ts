/**
 * The environment every git call runs under — PHASE-7's three follow-ups.
 *
 * That document said "fix this first" about the credential prompt, and added that the
 * fix "should ship with a test that asserts the env, not the hang". Phase 8 did not
 * touch `worktree.ts`, so all three landed here.
 *
 * ## Why most of these assert the environment rather than the behaviour
 *
 * Each of the three protects against a state this machine cannot produce:
 *
 * - **Credentials.** Reproducing the hang needs a host that resolves DNS and then
 *   demands auth; an unreachable one fails before git ever considers prompting.
 * - **Translation.** Apple Git 2.54.0 ships no gettext catalogues, so a localized
 *   `fatal:` cannot be produced here at all. Most Linux distribution builds are
 *   gettext-enabled, which is where this bites.
 * - **`index.lock` contention.** Forcing the race reliably is a scheduling exercise.
 *
 * All three mechanisms are git-documented, and the last test below checks the part that
 * *is* checkable on any machine: that real git accepts the spelling. A test asserting a
 * flag that git silently ignores would be worse than no test.
 */

import { execFile } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { gitBufferOverflowMessage, gitEnv } from './worktree.js'

describe('git cannot be made to prompt', () => {
  it('kills every interactive path, not just the obvious one', () => {
    const env = gitEnv({ PATH: '/usr/bin' })
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(env['GIT_ASKPASS']).toBe('')
    expect(env['SSH_ASKPASS']).toBe('')
    // Git Credential Manager ignores the two askpass variables, which is exactly the
    // kind of gap that makes "we set GIT_TERMINAL_PROMPT" a false sense of safety.
    expect(env['GCM_INTERACTIVE']).toBe('never')
  })

  it('turns off interactive credential helpers through GIT_CONFIG, not -c', () => {
    const env = gitEnv({})
    // Through the environment so it applies to everything git spawns for itself —
    // submodule commands, credential helpers — without every call site remembering.
    expect(env['GIT_CONFIG_COUNT']).toBe('2')
    expect(env['GIT_CONFIG_KEY_0']).toBe('credential.interactive')
    expect(env['GIT_CONFIG_VALUE_0']).toBe('false')
    expect(env['GIT_CONFIG_KEY_1']).toBe('credential.guiPrompt')
    expect(env['GIT_CONFIG_VALUE_1']).toBe('false')
  })

  it('drops a caller GIT_CONFIG_* rather than half-honouring it', () => {
    // A caller with its own `GIT_CONFIG_COUNT=1` and a `KEY_0` would have its key
    // silently replaced by ours and its count overwritten — so git would read our key
    // twice and theirs never. Dropping them is the honest half of the trade.
    const env = gitEnv({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'someone',
      HOME: '/home/me'
    })
    expect(env['GIT_CONFIG_VALUE_0']).toBe('false')
    expect(env['GIT_CONFIG_COUNT']).toBe('2')
    // Everything unrelated survives untouched.
    expect(env['HOME']).toBe('/home/me')
  })

  it('keeps the rest of the caller environment', () => {
    const env = gitEnv({ PATH: '/opt/bin', SSH_AUTH_SOCK: '/tmp/agent' })
    // Cached credentials keep working: only the *interactive* fallback dies, so an ssh
    // agent and a stored token are both still reachable.
    expect(env['PATH']).toBe('/opt/bin')
    expect(env['SSH_AUTH_SOCK']).toBe('/tmp/agent')
  })
})

describe('git output does not depend on who is running it', () => {
  it('pins the locale to untranslated English, in UTF-8', () => {
    const env = gitEnv({ LANG: 'de_DE.UTF-8', LC_ALL: 'de_DE.UTF-8' })
    // `LANGUAGE` outranks `LC_ALL` in gettext's lookup, so pinning only the latter
    // leaves a German `fatal:` reaching `parseBranch` and the sync message.
    expect(env['LANGUAGE']).toBe('en')
    expect(env['LC_ALL']).toBe('en_US.UTF-8')
    expect(env['LANG']).toBe('en_US.UTF-8')
  })

  it('English UTF-8 rather than plain C, so hooks keep a usable LC_CTYPE', () => {
    // `LC_ALL=C` would also untranslate git, and would hand every hook git spawns an
    // ASCII locale — which is how a commit hook starts mangling non-ASCII paths.
    expect(gitEnv({})['LC_ALL']).not.toBe('C')
    expect(gitEnv({})['LC_ALL']).toMatch(/UTF-8$/u)
  })
})

describe('reads never take index.lock', () => {
  it('sets GIT_OPTIONAL_LOCKS=0', () => {
    // The panel is docked next to a shell the user runs git in. `git status` takes the
    // lock to write back a refreshed index, so the panel's own polling can lose — or
    // cause — a race against the command they just typed.
    expect(gitEnv({})['GIT_OPTIONAL_LOCKS']).toBe('0')
  })
})

describe('real git accepts this environment', () => {
  // The one thing that IS checkable here, and the reason the assertions above are worth
  // anything: a flag git silently ignores would make every test in this file a lie.
  it('reads back the config we set, and still runs a plain command', async () => {
    const env = gitEnv(process.env)
    const value = await run(['config', '--get', 'credential.interactive'], env)
    expect(value.stdout.trim()).toBe('false')

    const version = await run(['--version'], env)
    expect(version.code).toBe(0)
    expect(version.stdout).toMatch(/^git version /u)
  })

  it('GIT_OPTIONAL_LOCKS=0 does not change what a status prints', async () => {
    const locked = await run(['status', '--porcelain', '--branch'], { ...process.env, GIT_OPTIONAL_LOCKS: '1' })
    const unlocked = await run(['status', '--porcelain', '--branch'], gitEnv(process.env))
    expect(unlocked.code).toBe(locked.code)
    // The flag is about whether the *index* is written back, not about output. If that
    // ever stops being true, this catches it before a user does.
    expect(unlocked.stdout.split('\n')[0]).toBe(locked.stdout.split('\n')[0])
  })
})

describe('a buffer overflow says what actually happened', () => {
  it('names the cap rather than blaming the command', () => {
    // The old message was the bare words "git status failed", because an `execFile`
    // killed at `maxBuffer` leaves stderr empty and every call site fell back to
    // `stderr || '<command> failed'`. PHASE-7 measured exactly this.
    const message = gitBufferOverflowMessage('git status')
    expect(message).toContain('git status')
    expect(message).toMatch(/8 MB buffer/u)
    expect(message).not.toBe('git status failed')
  })
})

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; code: number }> {
  return new Promise((resolvePromise) => {
    execFile('git', args, { cwd: process.cwd(), encoding: 'utf8', env }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1
      resolvePromise({ stdout, code })
    })
  })
}
