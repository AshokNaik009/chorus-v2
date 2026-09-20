import { describe, expect, it } from 'vitest'
import { identifyAgent, identifyAgentByPackagePath, identifyAgentInCommand, launcherName } from './agents.js'

describe('launcher names', () => {
  it('strips the directory and the extension', () => {
    // claude installs as `@anthropic-ai/claude-code/bin/claude.exe` — a native binary
    // with a `.exe` suffix, on macOS. Measured on this machine, 2026-09-20.
    expect(launcherName('/Users/x/.nvm/versions/node/v22.1.0/bin/claude')).toBe('claude')
    expect(launcherName('../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe')).toBe('claude')
    expect(launcherName('C:\\tools\\codex.cmd')).toBe('codex')
  })
})

describe('identifying by name', () => {
  it('accepts a known name, a path to one, and an alias', () => {
    expect(identifyAgent('claude')?.id).toBe('claude')
    expect(identifyAgent('/opt/homebrew/bin/opencode')?.id).toBe('opencode')
    expect(identifyAgent('open-code')?.id).toBe('opencode')
    expect(identifyAgent('CLAUDE')?.id).toBe('claude')
  })

  it('does not match a name that merely starts with one', () => {
    expect(identifyAgent('claude-wrapper')).toBeNull()
    expect(identifyAgent('codexify')).toBeNull()
  })

  it('has no opinion about a shell', () => {
    expect(identifyAgent('-bash')).toBeNull()
    expect(identifyAgent('')).toBeNull()
  })
})

describe('identifying by package path', () => {
  it('matches the installed package directory', () => {
    expect(identifyAgentByPackagePath('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')?.id).toBe('claude')
  })

  it('will not match a user whose home directory is named after an agent', () => {
    // The whole reason this is an exact component run and not a substring search.
    expect(identifyAgentByPackagePath('/Users/claude/projects/app/server.js')).toBeNull()
    expect(identifyAgentByPackagePath('/home/opencode/run.js')).toBeNull()
    expect(identifyAgentByPackagePath('/srv/claude-code/index.js')).toBeNull()
  })

  it('needs the components adjacent and in order', () => {
    expect(identifyAgentByPackagePath('/x/node_modules/other/@anthropic-ai/claude-code/cli.js')).toBeNull()
  })
})

describe('identifying from a whole command line', () => {
  it('reads the runtime and then the script', () => {
    expect(identifyAgentInCommand('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js')?.id).toBe('claude')
    expect(identifyAgentInCommand('/usr/bin/node --enable-source-maps /opt/bin/opencode')?.id).toBe('opencode')
  })

  it('takes argv[0] when argv[0] is the agent', () => {
    expect(identifyAgentInCommand('claude --resume')?.id).toBe('claude')
  })

  it('stops at an eval flag rather than reading its program text', () => {
    // `node -e '...' /tmp/claude` is not an agent, and herdr has a test per runtime
    // saying so. The token after the flag is code; anything after that is its argv.
    expect(identifyAgentInCommand("node -e setTimeout(()=>{},60000) /tmp/claude")).toBeNull()
    expect(identifyAgentInCommand('python3 -c import-time /tmp/codex')).toBeNull()
    expect(identifyAgentInCommand('bash -c sleep /tmp/codex')).toBeNull()
  })

  it('does not look inside a program that is not a generic runtime', () => {
    expect(identifyAgentInCommand('vim /tmp/claude')).toBeNull()
  })

  it('has no opinion about a bare shell', () => {
    expect(identifyAgentInCommand('-bash')).toBeNull()
    expect(identifyAgentInCommand('')).toBeNull()
  })
})
