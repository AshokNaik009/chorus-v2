import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  describeFailure,
  MAX_PLUGIN_COMMANDS_IN_FLIGHT,
  PluginBusyError,
  PluginRunner,
  PLUGIN_OUTPUT_MAX_BYTES
} from './run.js'

const CWD = tmpdir()

function run(runner: PluginRunner, argv: readonly string[], timeoutMs?: number) {
  return runner.run({ argv, cwd: CWD, env: process.env, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
}

describe('the caps are herdr’s', () => {
  it('keeps herdr’s two numbers', () => {
    // `PLUGIN_COMMAND_OUTPUT_MAX_BYTES` and `MAX_PLUGIN_COMMANDS_IN_FLIGHT` in
    // herdr's `runtime.rs`. Orca reached the same shape independently; two projects
    // agreeing is the strongest evidence available for a number nobody can derive.
    expect(PLUGIN_OUTPUT_MAX_BYTES).toBe(64 * 1024)
    expect(MAX_PLUGIN_COMMANDS_IN_FLIGHT).toBe(32)
  })
})

describe('running a program', () => {
  it('captures stdout and the exit code', async () => {
    const outcome = await run(new PluginRunner(), ['sh', '-c', 'printf hello; exit 3'])
    expect(outcome.stdout).toBe('hello')
    expect(outcome.code).toBe(3)
    expect(outcome.truncated).toBe(false)
    expect(outcome.failure).toBeNull()
  })

  it('captures stderr separately', async () => {
    const outcome = await run(new PluginRunner(), ['sh', '-c', 'printf out; printf err >&2'])
    expect(outcome.stdout).toBe('out')
    expect(outcome.stderr).toBe('err')
  })

  it('reports a missing program as an outcome, not an exception', async () => {
    // A plugin's failure is not this host's exception: the caller has something to
    // report either way.
    const outcome = await run(new PluginRunner(), ['leap-chorus-no-such-program-xyz'])
    expect(outcome.failure).toBe('absent')
    expect(outcome.code).toBeNull()
  })

  it('decodes a multi-byte character split across two chunks', async () => {
    // A stateless `chunk.toString()` puts U+FFFD where a UTF-8 sequence straddles a
    // boundary; the decoder is stateful for exactly this.
    const text = '日本語'.repeat(4000)
    const outcome = await run(new PluginRunner({ maxBytes: 10 * 1024 * 1024 }), ['sh', '-c', `printf '%s' '${text}'`])
    expect(outcome.stdout).toBe(text)
    expect(outcome.stdout).not.toContain('�')
  })

  it('runs in the directory it was given', async () => {
    const outcome = await run(new PluginRunner(), ['sh', '-c', 'pwd'])
    // macOS resolves /tmp through a symlink, so compare the tail.
    expect(outcome.stdout.trim().endsWith(CWD.replace(/^\/private/u, ''))).toBe(true)
  })
})

describe('output is truncated, not buffered', () => {
  it('stops at the cap and says so', async () => {
    const runner = new PluginRunner({ maxBytes: 64 })
    const outcome = await run(runner, ['sh', '-c', 'printf "%01000d" 0'])
    expect(outcome.truncated).toBe(true)
    expect(outcome.stdout.length).toBe(64)
    // The program still finished. A chatty build is not a wrong build, so the cap
    // drops bytes rather than killing the child.
    expect(outcome.code).toBe(0)
  })

  it('shares one budget across stdout and stderr', async () => {
    // Otherwise a plugin doubles the cap by splitting its noise between the two.
    const runner = new PluginRunner({ maxBytes: 100 })
    const outcome = await run(runner, ['sh', '-c', 'printf "%0200d" 0; printf "%0200d" 0 >&2'])
    expect(outcome.stdout.length + outcome.stderr.length).toBe(100)
    expect(outcome.truncated).toBe(true)
  })

  it('does not report truncation when the output fits exactly', async () => {
    const runner = new PluginRunner({ maxBytes: 5 })
    const outcome = await run(runner, ['sh', '-c', 'printf hello'])
    expect(outcome.stdout).toBe('hello')
    expect(outcome.truncated).toBe(false)
  })

  it('keeps nothing past the cap, however much the program prints', async () => {
    // The assertion that distinguishes "truncated" from "buffered then trimmed": four
    // megabytes go past a 1 KiB cap and the result is 1 KiB.
    const runner = new PluginRunner({ maxBytes: 1024 })
    const outcome = await run(runner, ['sh', '-c', 'i=0; while [ $i -lt 4096 ]; do printf "%01000d" 0; i=$((i+1)); done'])
    expect(outcome.stdout.length).toBe(1024)
    expect(outcome.truncated).toBe(true)
  })
})

describe('time', () => {
  it('kills a program that runs too long and says which', async () => {
    const outcome = await run(new PluginRunner(), ['sh', '-c', 'sleep 30'], 150)
    expect(outcome.timedOut).toBe(true)
    expect(describeFailure(['sleep'], outcome)).toContain('too long')
  })
})

describe('the in-flight cap', () => {
  it('refuses a command past the cap rather than queueing it', async () => {
    const runner = new PluginRunner({ maxInFlight: 2 })
    const slow = [run(runner, ['sh', '-c', 'sleep 0.3']), run(runner, ['sh', '-c', 'sleep 0.3'])]
    await expect(run(runner, ['true'])).rejects.toBeInstanceOf(PluginBusyError)
    await Promise.all(slow)
  })

  it('frees a slot when a command finishes, including a failing one', async () => {
    const runner = new PluginRunner({ maxInFlight: 1 })
    await run(runner, ['leap-chorus-no-such-program-xyz'])
    expect(runner.inFlight).toBe(0)
    await expect(run(runner, ['true'])).resolves.toMatchObject({ code: 0 })
  })
})

describe('onLine', () => {
  it('reports complete lines as they arrive, and the last partial one at the end', async () => {
    const lines: string[] = []
    await new PluginRunner().run({
      argv: ['sh', '-c', 'printf "one\\ntwo\\nthree"'],
      cwd: CWD,
      env: process.env,
      onLine: (line) => lines.push(line)
    })
    expect(lines).toEqual(['one', 'two', 'three'])
  })
})

describe('describeFailure', () => {
  it('names a missing program plainly', () => {
    expect(
      describeFailure(['cargo'], { code: null, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, failure: 'absent' })
    ).toBe('cargo: no such program')
  })

  it('keeps the last few lines of stderr, which is where a build says why', () => {
    const stderr = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const message = describeFailure(['make'], {
      code: 2,
      signal: null,
      stdout: '',
      stderr,
      truncated: false,
      timedOut: false,
      failure: null
    })
    expect(message).toContain('line 19')
    expect(message).not.toContain('line 14')
  })
})
