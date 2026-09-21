/**
 * A plugin, as a real git repository on disk.
 *
 * PHASE-10 criterion 2 says `plugin install` is tested "against a **local fixture**
 * plugin, not the network". That is not a compromise: the installer's git path is the
 * same code for a local `file://` remote and a GitHub one, so a fixture exercises
 * `init`/`fetch --depth 1`/`checkout --detach`, the real `rev-parse`, the real content
 * hash and the real build — everything except DNS.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FixtureFile {
  readonly path: string
  readonly body: string
  readonly executable?: boolean
}

/** An identity, so the commit does not depend on the machine's git config. */
const GIT_IDENTITY = [
  '-c',
  'user.name=leap-chorus tests',
  '-c',
  'user.email=tests@example.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main'
]

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

/** Write files into a directory, creating parents and honouring the executable bit. */
export function writeFiles(root: string, files: readonly FixtureFile[]): void {
  for (const file of files) {
    const path = join(root, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.body)
    if (file.executable === true) chmodSync(path, 0o755)
  }
}

export interface FixtureRepo {
  readonly path: string
  /** Rewrite files and commit again, so a test can move a ref under a pin. */
  commit(files: readonly FixtureFile[], message?: string): string
  /** Move a tag onto HEAD — the "somebody rewrote the tag" case, exactly. */
  tag(name: string): void
  head(): string
}

export function createFixtureRepo(files: readonly FixtureFile[]): FixtureRepo {
  const path = mkdtempSync(join(tmpdir(), 'leap-plugin-src-'))
  git(path, ['init', '--quiet'])
  const repo: FixtureRepo = {
    path,
    commit(next, message = 'update') {
      writeFiles(path, next)
      git(path, ['add', '-A'])
      git(path, ['commit', '--quiet', '-m', message])
      return repo.head()
    },
    tag(name) {
      git(path, ['tag', '-f', name])
    },
    head() {
      return git(path, ['rev-parse', 'HEAD']).trim()
    }
  }
  repo.commit(files, 'initial')
  return repo
}

/**
 * The manifest most tests want: one pane, one action, one build step.
 *
 * `sh -c` throughout, because that is what herdr's own manifests and
 * `herdr-file-viewer`'s launchers use — a plugin that wants a shell says so in its
 * argv, and nothing here splits a string on the plugin's behalf.
 */
export function fixtureFiles(overrides: { manifest?: string; extra?: readonly FixtureFile[] } = {}): FixtureFile[] {
  const manifest =
    overrides.manifest ??
    `id = "fixture.viewer"
name = "Fixture Viewer"
version = "0.1.0"
description = "A plugin that exists to be installed"

[[build]]
command = ["sh", "-c", "printf built > built-marker"]

[[panes]]
id = "viewer"
title = "Fixture Viewer"
placement = "split"
command = ["sh", "-c", "printf 'viewer ready'; cat"]

[[actions]]
id = "echo-env"
title = "Echo the environment"
command = ["sh", "-c", "printf '%s\\n%s\\n' \\"$HERDR_PLUGIN_ID\\" \\"$HERDR_BIN_PATH\\""]
`
  return [
    { path: 'herdr-plugin.toml', body: manifest },
    { path: 'scripts/launch.sh', body: '#!/bin/sh\nexec "$HERDR_BIN_PATH" pane list --json\n', executable: true },
    ...(overrides.extra ?? [])
  ]
}
