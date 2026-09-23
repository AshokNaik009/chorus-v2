/**
 * Which editor a terminal belongs to.
 *
 * A table test against fake environments, because the thing being decided is a table
 * and the real answer depends on which application launched the terminal — which a
 * test cannot arrange. The one real environment this was checked against is recorded
 * in `editor.ts`'s header and reproduced below as `VSCODE_MACOS`.
 */

import { describe, expect, it } from 'vitest'
import { MIN_SCM_WIDTH } from './scm.js'
import { editorArgs, explainNoEditor, installedEditor, resolveExternalEditor } from './editor.js'

/** Everything on `PATH`, which is the interesting half of most of these. */
const anything = (): boolean => true
const nothing = (): boolean => false

/** Exactly what a VS Code 1.135.0 integrated terminal exported here on 2026-09-22. */
const VSCODE_MACOS: NodeJS.ProcessEnv = {
  TERM: 'xterm-256color',
  TERM_PROGRAM: 'vscode',
  TERM_PROGRAM_VERSION: '1.135.0',
  __CFBundleIdentifier: 'com.microsoft.VSCode',
  VSCODE_INJECTION: '1',
  VSCODE_GIT_ASKPASS_NODE:
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)',
  GIT_ASKPASS: '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/git/dist/askpass.sh'
  // Note what is NOT here: VSCODE_IPC_HOOK_CLI. See `editor.ts`.
}

describe('the terminal this is attached to', () => {
  it('recognises a real VS Code terminal by its bundle id', () => {
    expect(resolveExternalEditor(VSCODE_MACOS, { exists: anything })).toEqual({
      cli: 'code',
      name: 'VS Code',
      source: 'bundle-id'
    })
  })

  it('does not depend on VSCODE_IPC_HOOK_CLI, which was absent in that terminal', () => {
    // The variable every write-up names. If detection ever starts requiring it, this
    // test fails and the machine that proved it unreliable is named in the comment.
    expect(VSCODE_MACOS['VSCODE_IPC_HOOK_CLI']).toBeUndefined()
    expect(resolveExternalEditor(VSCODE_MACOS, { exists: anything })).not.toBeNull()
  })

  it('tells the forks apart, which TERM_PROGRAM alone cannot', () => {
    // Cursor and Windsurf both report `TERM_PROGRAM=vscode`; only the bundle id and
    // the askpass path say which one.
    const cursor = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }
    expect(resolveExternalEditor(cursor, { exists: anything })).toMatchObject({ cli: 'cursor', name: 'Cursor' })

    const windsurf = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.exafunction.windsurf' }
    expect(resolveExternalEditor(windsurf, { exists: anything })).toMatchObject({ cli: 'windsurf' })
  })

  it('reads the application name out of the askpass path, which is the Linux route', () => {
    // No bundle id on Linux. The askpass helper's path carries the name instead.
    const linux = {
      TERM_PROGRAM: 'vscode',
      VSCODE_GIT_ASKPASS_NODE: '/usr/share/code/code'
    }
    expect(resolveExternalEditor(linux, { exists: anything })).toEqual({
      cli: 'code',
      name: 'VS Code',
      source: 'askpass'
    })

    const cursorLinux = {
      TERM_PROGRAM: 'vscode',
      GIT_ASKPASS: '/opt/cursor/resources/app/extensions/git/dist/askpass.sh'
    }
    expect(resolveExternalEditor(cursorLinux, { exists: anything })).toMatchObject({ cli: 'cursor' })
  })

  it('falls back to a generic `code` when only TERM_PROGRAM says anything', () => {
    expect(resolveExternalEditor({ TERM_PROGRAM: 'vscode' }, { exists: anything })).toEqual({
      cli: 'code',
      name: 'VS Code',
      source: 'term-program'
    })
  })

  it('says no for a plain terminal, which is most of them', () => {
    expect(resolveExternalEditor({ TERM: 'xterm-256color', TERM_PROGRAM: 'iTerm.app' }, { exists: anything })).toBeNull()
    expect(resolveExternalEditor({}, { exists: anything })).toBeNull()
    // An SSH session into a box that has `code` installed is still not an editor's
    // terminal, and opening a GUI there would be opening it on the wrong machine.
    expect(resolveExternalEditor({ SSH_TTY: '/dev/pts/3', TERM: 'screen' }, { exists: anything })).toBeNull()
  })

  it('refuses rather than opening the wrong editor when the fork is not installed', () => {
    // A Cursor terminal on a machine where only `code` exists. Opening `code` would
    // look like it worked and put the file in a window nobody is watching.
    const cursor = { TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }
    expect(resolveExternalEditor(cursor, { exists: (cli) => cli === 'code' })).toBeNull()
  })
})

describe('[sidebar] open-with', () => {
  it('off means off, in an editor terminal too', () => {
    expect(resolveExternalEditor(VSCODE_MACOS, { configured: 'off', exists: anything })).toBeNull()
  })

  it('a command is used everywhere, including a plain terminal', () => {
    expect(resolveExternalEditor({ TERM: 'xterm' }, { configured: 'subl', exists: anything })).toEqual({
      cli: 'subl',
      name: 'subl',
      source: 'config'
    })
  })

  it('a command that is not installed is a no, not a silent fallback', () => {
    // A typo in the config must report itself. Falling back to detection here would
    // open a different editor than the one that was asked for.
    expect(resolveExternalEditor(VSCODE_MACOS, { configured: 'coed', exists: nothing })).toBeNull()
  })

  it('auto is the default and means detect', () => {
    expect(resolveExternalEditor(VSCODE_MACOS, { configured: 'auto', exists: anything })).toMatchObject({ cli: 'code' })
    expect(resolveExternalEditor(VSCODE_MACOS, { exists: anything })).toMatchObject({ cli: 'code' })
  })
})

describe('the argv', () => {
  it('uses --goto, which is what makes `:42` a line and not a filename', () => {
    expect(editorArgs('/repo/src/app.ts', 42)).toEqual(['--goto', '/repo/src/app.ts:42'])
  })

  it('leaves the line off when there is none, rather than saying :1', () => {
    expect(editorArgs('/repo/src/app.ts', null)).toEqual(['--goto', '/repo/src/app.ts'])
    expect(editorArgs('/repo/src/app.ts', 0)).toEqual(['--goto', '/repo/src/app.ts'])
  })

  it('never passes --reuse-window', () => {
    // VS Code's own `window.openFilesInNewWindow` already decides this. Forcing `-r`
    // would override a preference the user has expressed, to solve a problem they may
    // not have.
    expect(editorArgs('/a/b.ts', 1)).not.toContain('--reuse-window')
    expect(editorArgs('/a/b.ts', 1)).not.toContain('-r')
  })

  it('carries a path with a space through as one argument', () => {
    // argv, never a shell string — so a space needs no quoting and cannot split.
    expect(editorArgs('/repo/a file.ts', 7)).toEqual(['--goto', '/repo/a file.ts:7'])
  })
})

// ---------------------------------------------------------------------------
// Saying why there is no editor
// ---------------------------------------------------------------------------

describe('a click that opens nothing says why', () => {
  const plain: NodeJS.ProcessEnv = { TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }

  it('names an editor that is actually installed, so the fix is one copyable line', () => {
    const why = explainNoEditor(plain, { exists: (cli) => cli === 'code' })
    expect(why).toBe('set [sidebar] open-with = "code"')
  })

  it('falls back to a placeholder when it can suggest nothing', () => {
    expect(explainNoEditor(plain, { exists: nothing })).toBe('set [sidebar] open-with = <cmd>')
  })

  it('distinguishes a detected fork whose CLI was never installed', () => {
    const cursor: NodeJS.ProcessEnv = { __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }
    // The failure `resolveExternalEditor` refuses to paper over: opening `code` here
    // would put the file in the other editor, so the message names the command that is
    // missing rather than suggesting a different editor.
    expect(explainNoEditor(cursor, { exists: (cli) => cli === 'code' })).toBe('cursor is not on PATH')
  })

  it('reports a typo in the config rather than staying quiet about it', () => {
    expect(explainNoEditor(VSCODE_MACOS, { configured: 'coed', exists: nothing })).toBe('not on PATH: coed')
  })

  it('puts the conclusion first for the one message with an unbounded tail', () => {
    // `open-with` echoes whatever the config file says, so this is the only message
    // whose length is not ours to control. Leading with the verdict means truncation
    // eats the value the user typed — which they can see in their own config — rather
    // than the reason.
    const why = explainNoEditor(VSCODE_MACOS, { configured: 'a'.repeat(80), exists: nothing }) as string
    expect(why.slice(0, 'not on PATH'.length)).toBe('not on PATH')
  })

  it('every message fits the dock, because a note is truncated and not wrapped', () => {
    // The first version of these did not, and the terminal showed
    // `no editor for this terminal — set…`: the diagnosis survived and the fix, which
    // is the only actionable half, was behind the ellipsis.
    const everyMessage = [
      explainNoEditor(plain, { exists: (cli) => cli === 'code' }),
      explainNoEditor(plain, { exists: nothing }),
      explainNoEditor({ __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92' }, { exists: nothing }),
      explainNoEditor(VSCODE_MACOS, { configured: 'code-insiders', exists: nothing })
    ]
    for (const message of everyMessage) {
      expect(message, `"${message}" is wider than the dock`).not.toBeNull()
      expect((message as string).length, `"${message}"`).toBeLessThanOrEqual(MIN_SCM_WIDTH)
    }
  })

  it('says nothing at all when there is nothing to say', () => {
    // Off was asked for; a working editor needs no explanation.
    expect(explainNoEditor(plain, { configured: 'off', exists: anything })).toBeNull()
    expect(explainNoEditor(VSCODE_MACOS, { exists: anything })).toBeNull()
    expect(explainNoEditor(plain, { configured: 'subl', exists: anything })).toBeNull()
  })

  it('explains exactly when resolution fails, and stays quiet exactly when it does not', () => {
    // The two must never disagree: a null editor with a null reason is the silent
    // click this whole section exists to remove.
    const cases: Array<[NodeJS.ProcessEnv, string]> = [
      [plain, 'auto'],
      [VSCODE_MACOS, 'auto'],
      [VSCODE_MACOS, 'coed'],
      [plain, 'subl']
    ]
    for (const [env, configured] of cases) {
      const exists = (cli: string): boolean => cli === 'code' || cli === 'subl'
      const editor = resolveExternalEditor(env, { configured, exists })
      const why = explainNoEditor(env, { configured, exists })
      expect(editor === null, `${configured} in ${env['TERM_PROGRAM']}`).toBe(why !== null)
    }
  })

  it('installedEditor prefers the commonest command it can find', () => {
    expect(installedEditor(() => true)).toBe('code')
    expect(installedEditor((cli) => cli === 'windsurf')).toBe('windsurf')
    expect(installedEditor(() => false)).toBeNull()
  })
})
