/**
 * Worktrees and integrations, against real git and a real filesystem.
 *
 * Real git on purpose. The worktree service is a thin wrapper whose entire risk is
 * whether it reads git's actual output correctly — a mocked `git` would test the mock.
 * `git worktree list --porcelain` is a stable interface; what it prints for a detached
 * head, a linked tree and a primary tree is not something to guess at.
 *
 * PHASE-5 criterion 4: create/list/open/remove works, and two agents in two worktrees
 * do not collide. Criterion 5: install writes the hooks correctly and is idempotent.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SessionStateSnapshot } from '@leap-chorus/protocol'
import type { DaemonClient } from '../src/client.js'
import { DaemonServer } from '../src/socket.js'
import { WorktreeService, defaultWorktreePath, parseWorktreeList } from '../src/worktree.js'
import {
  INTEGRATION_ASSET_VERSION,
  installedVersionOf
} from '../src/integration/assets.js'
import { hookCommand, installIntegrations, listIntegrations } from '../src/integration/install.js'
import { cleanupDataRoots, connectTo, testPaths } from './harness.js'

let scratch: string
let repo: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'lc-wt-'))
  repo = join(scratch, 'project')
  mkdirSync(repo)
  git(['init', '--initial-branch=main'], repo)
  // A repository with no identity cannot commit, and a worktree needs a commit.
  git(['config', 'user.email', 'test@example.invalid'], repo)
  git(['config', 'user.name', 'Test'], repo)
  writeFileSync(join(repo, 'README.md'), '# project\n')
  git(['add', '.'], repo)
  git(['commit', '-m', 'first'], repo)
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  cleanupDataRoots()
})

describe('parsing git worktree list', () => {
  it('reads the porcelain form, and calls the first record primary', () => {
    const records = parseWorktreeList(
      [
        'worktree /repo',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /repo-feature',
        'HEAD def456',
        'branch refs/heads/feature',
        ''
      ].join('\n')
    )
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ path: '/repo', branch: 'main', primary: true })
    expect(records[1]).toMatchObject({ path: '/repo-feature', branch: 'feature', primary: false })
  })

  it('reads a detached worktree as having no branch', () => {
    const records = parseWorktreeList(['worktree /repo', 'HEAD abc123', 'detached', ''].join('\n'))
    expect(records[0]?.branch).toBeNull()
  })

  it('tolerates a final record with no trailing blank line', () => {
    expect(parseWorktreeList('worktree /repo\nHEAD abc\nbranch refs/heads/main')).toHaveLength(1)
  })
})

describe('default paths', () => {
  it('puts a worktree beside its repository, never inside it', () => {
    // A worktree nested in its own repository shows up in every `git status`, every
    // ripgrep, and every agent's file walk — which is how one agent's checkout ends
    // up in another agent's context.
    const path = defaultWorktreePath('/src/project', 'feature/login')
    expect(path).toBe('/src/project-feature-login')
    expect(path.startsWith('/src/project/')).toBe(false)
  })
})

describe('the worktree service', () => {
  const service = new WorktreeService()

  afterEach(() => {
    // Leave only the primary tree behind, whatever a test made.
    for (const record of parseWorktreeList(git(['worktree', 'list', '--porcelain'], repo))) {
      if (record.primary) continue
      try {
        git(['worktree', 'remove', '--force', record.path], repo)
      } catch {
        // Already gone.
      }
    }
    git(['worktree', 'prune'], repo)
  })

  it('finds the repository from any path inside it', async () => {
    expect(await service.repoRoot(repo)).toBe(git(['rev-parse', '--show-toplevel'], repo).trim())
    expect(await service.repoRoot(scratch)).toBeNull()
  })

  it('lists the primary tree of a fresh repository', async () => {
    const listed = await service.list(repo)
    expect(listed.worktrees).toHaveLength(1)
    expect(listed.worktrees[0]?.primary).toBe(true)
    expect(listed.worktrees[0]?.branch).toBe('main')
  })

  it('refuses a path that is not in a repository', async () => {
    await expect(service.list(scratch)).rejects.toThrow(/not inside a git repository/u)
  })

  it('creates a worktree on a new branch', async () => {
    const created = await service.create({ repoPath: repo, branch: 'agent-a' })
    expect(created.created).toBe(true)
    expect(created.worktree.branch).toBe('agent-a')
    expect(existsSync(join(created.worktree.path, 'README.md'))).toBe(true)
    expect((await service.list(repo)).worktrees).toHaveLength(2)
  })

  it('is idempotent: creating the same worktree twice is one worktree', async () => {
    const first = await service.create({ repoPath: repo, branch: 'agent-a' })
    const second = await service.create({ repoPath: repo, branch: 'agent-a', path: first.worktree.path })
    expect(second.created).toBe(false)
    expect(second.worktree.path).toBe(first.worktree.path)
  })

  it('checks out an existing branch rather than failing', async () => {
    git(['branch', 'existing'], repo)
    const created = await service.create({ repoPath: repo, branch: 'existing' })
    expect(created.worktree.branch).toBe('existing')
  })

  /** PHASE-5 criterion 4: two agents in two worktrees do not collide. */
  it('gives two agents two independent checkouts', async () => {
    const a = await service.create({ repoPath: repo, branch: 'agent-a' })
    const b = await service.create({ repoPath: repo, branch: 'agent-b' })

    expect(a.worktree.path).not.toBe(b.worktree.path)
    writeFileSync(join(a.worktree.path, 'only-a.txt'), 'a')
    writeFileSync(join(b.worktree.path, 'only-b.txt'), 'b')

    // Each tree sees its own file and not the other's: separate working directories,
    // separate branches, one object store.
    expect(existsSync(join(a.worktree.path, 'only-b.txt'))).toBe(false)
    expect(existsSync(join(b.worktree.path, 'only-a.txt'))).toBe(false)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], a.worktree.path).trim()).toBe('agent-a')
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], b.worktree.path).trim()).toBe('agent-b')

    // And a commit in one does not touch the other's branch.
    git(['add', '.'], a.worktree.path)
    git(['commit', '-m', 'from a'], a.worktree.path)
    expect(git(['log', '--oneline'], a.worktree.path).trim().split('\n')).toHaveLength(2)
    expect(git(['log', '--oneline'], b.worktree.path).trim().split('\n')).toHaveLength(1)
  })

  it('removes a worktree, and can delete its branch with it', async () => {
    const created = await service.create({ repoPath: repo, branch: 'agent-a' })
    const removed = await service.remove({ path: created.worktree.path, deleteBranch: true })
    expect(removed).toMatchObject({ removed: true, branchDeleted: true })
    expect(existsSync(created.worktree.path)).toBe(false)
    expect(git(['branch', '--list', 'agent-a'], repo).trim()).toBe('')
  })

  it('refuses a dirty worktree without force, and obeys force', async () => {
    const created = await service.create({ repoPath: repo, branch: 'agent-a' })
    writeFileSync(join(created.worktree.path, 'uncommitted.txt'), 'work in progress')

    const refused = await service.remove({ path: created.worktree.path })
    expect(refused.removed).toBe(false)
    expect(refused.reason).not.toBeNull()
    expect(existsSync(created.worktree.path)).toBe(true)

    expect((await service.remove({ path: created.worktree.path, force: true })).removed).toBe(true)
  })

  it('refuses to remove the primary working tree', async () => {
    // git refuses too, but "is a main working tree" is not an error anyone reads as
    // "you asked to delete your repository".
    const removed = await service.remove({ path: repo, force: true })
    expect(removed.removed).toBe(false)
    expect(removed.reason).toMatch(/primary working tree/u)
    expect(existsSync(join(repo, 'README.md'))).toBe(true)
  })
})

describe('the worktree endpoint', () => {
  let server: DaemonServer
  let client: DaemonClient

  beforeEach(async () => {
    server = await DaemonServer.start({ paths: testPaths(), ephemeral: true, detectIntervalMs: 0 })
    ;({ client } = await connectTo(server.paths))
    await client.call('workspace.create', { cwd: repo, focus: true })
  })

  afterEach(async () => {
    client.close()
    await server.close('test')
    for (const record of parseWorktreeList(git(['worktree', 'list', '--porcelain'], repo))) {
      if (record.primary) continue
      try {
        git(['worktree', 'remove', '--force', record.path], repo)
      } catch {
        // Already gone.
      }
    }
    git(['worktree', 'prune'], repo)
  })

  it(`defaults to the focused pane's repository`, async () => {
    const listed = await client.call('worktree.list', {})
    expect(listed.repo).not.toBeNull()
    expect(listed.worktrees.some((entry) => entry.primary)).toBe(true)
  })

  it('reports which panes are in which worktree', async () => {
    const created = await client.call('worktree.create', { repo, branch: 'agent-a' })
    await client.call('worktree.open', { path: created.worktree.path })

    const listed = await client.call('worktree.list', { repo })
    const opened = listed.worktrees.find((entry) => entry.path === created.worktree.path)
    expect(opened?.paneIds).toHaveLength(1)
    // And the primary tree still holds the pane the session started in.
    expect(listed.worktrees.find((entry) => entry.primary)?.paneIds).toHaveLength(1)
  })

  it('opens a worktree as a workspace named after its branch', async () => {
    const created = await client.call('worktree.create', { repo, branch: 'agent-a' })
    const opened = await client.call('worktree.open', { path: created.worktree.path })
    expect(opened.workspaceId).not.toBeNull()

    const { state } = await client.call('state.get', {})
    const workspace = (state as SessionStateSnapshot).workspaces.find(
      (entry) => entry.workspaceId === opened.workspaceId
    )
    expect(workspace?.label).toBe('agent-a')
    expect(workspace?.cwd).toBe(created.worktree.path)
  })

  it('opens a worktree as a tab when asked', async () => {
    const created = await client.call('worktree.create', { repo, branch: 'agent-a' })
    const opened = await client.call('worktree.open', { path: created.worktree.path, target: 'tab' })
    expect(opened.tabId).not.toBeNull()
    expect(opened.workspaceId).toBeNull()
  })

  it('refuses to remove a worktree that still has panes in it', async () => {
    // Removing the directory out from under a running agent leaves it writing into a
    // tree that is no longer there.
    const created = await client.call('worktree.create', { repo, branch: 'agent-a' })
    await client.call('worktree.open', { path: created.worktree.path })

    const removed = await client.call('worktree.remove', { path: created.worktree.path })
    expect(removed.removed).toBe(false)
    expect(removed.reason).toMatch(/pane/u)
    expect(existsSync(created.worktree.path)).toBe(true)
  })
})

describe('integrations', () => {
  let home: string
  let hookDir: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lc-home-'))
    hookDir = join(home, 'integrations')
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  const options = () => ({ hookDir, home })

  it('reports what is available before anything is installed', () => {
    const listed = listIntegrations(options())
    expect(listed.map((entry) => entry.agent)).toContain('claude')
    expect(listed.every((entry) => !entry.installed)).toBe(true)
    expect(listed.every((entry) => entry.availableVersion === INTEGRATION_ASSET_VERSION)).toBe(true)
  })

  it('writes an executable hook carrying its version marker', () => {
    const [outcome] = installIntegrations(options(), { agents: ['claude'] })
    expect(outcome?.installed).toBe(true)
    expect(outcome?.result).toBe('installed')

    const contents = readFileSync(outcome?.hookPath as string, 'utf8')
    expect(installedVersionOf(contents)).toBe(INTEGRATION_ASSET_VERSION)
    expect(contents.startsWith('#!/bin/sh')).toBe(true)
    // The hook must refuse to do anything outside a pane, or a stray invocation from
    // the user's own shell would try to connect to a socket that is not there.
    expect(contents).toContain('LEAP_CHORUS_PANE_ID')
    expect(contents).toContain('LEAP_CHORUS_SOCKET_PATH')
  })

  it(`registers the hook in the agent's own settings file`, () => {
    installIntegrations(options(), { agents: ['claude'] })
    const settings = JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(Object.keys(settings.hooks)).toContain('Stop')
    expect(settings.hooks['Stop']?.[0]?.hooks[0]?.command).toContain('idle')
  })

  /** PHASE-5 criterion 5: install is idempotent. */
  it('installing twice changes nothing the second time', () => {
    installIntegrations(options(), { agents: ['claude'] })
    const settingsPath = join(home, '.claude/settings.json')
    const afterFirst = readFileSync(settingsPath, 'utf8')
    const hookPath = join(hookDir, 'claude', 'leap-chorus-agent-state.sh')
    const hookAfterFirst = readFileSync(hookPath, 'utf8')

    const [second] = installIntegrations(options(), { agents: ['claude'] })
    expect(second?.result).toBe('unchanged')
    expect(readFileSync(settingsPath, 'utf8')).toBe(afterFirst)
    expect(readFileSync(hookPath, 'utf8')).toBe(hookAfterFirst)
  })

  it(`keeps the user's own settings and their own hooks`, () => {
    // The settings file is theirs. We add entries; we never take any away that we did
    // not write.
    const settingsPath = join(home, '.claude/settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: 'opus',
          permissions: { allow: ['Bash(ls:*)'] },
          hooks: { Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook' }] }] }
        },
        null,
        2
      )
    )

    installIntegrations(options(), { agents: ['claude'] })
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      model: string
      permissions: { allow: string[] }
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(settings.model).toBe('opus')
    expect(settings.permissions.allow).toEqual(['Bash(ls:*)'])
    const stopCommands = (settings.hooks['Stop'] ?? []).map((entry) => entry.hooks[0]?.command)
    expect(stopCommands).toContain('/usr/local/bin/my-own-hook')
    expect(stopCommands.some((command) => command?.includes('leap-chorus-agent-state.sh'))).toBe(true)
  })

  it('replaces its own entry from a previous install at another path', () => {
    const settingsPath = join(home, '.claude/settings.json')
    installIntegrations(options(), { agents: ['claude'] })
    const first = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(first.hooks['Stop']).toHaveLength(1)

    // Same agent, different hook directory: the old entry is ours, so it goes.
    const moved = { hookDir: join(home, 'elsewhere'), home }
    installIntegrations(moved, { agents: ['claude'] })
    const second = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const commands = (second.hooks['Stop'] ?? []).map((entry) => entry.hooks[0]?.command)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('elsewhere')
  })

  it('rewrites a hook whose version marker is older', () => {
    const [first] = installIntegrations(options(), { agents: ['claude'] })
    const hookPath = first?.hookPath as string
    writeFileSync(hookPath, '#!/bin/sh\n# LEAP_CHORUS_INTEGRATION_VERSION=0\nexit 0\n')

    const [second] = installIntegrations(options(), { agents: ['claude'] })
    expect(second?.result).toBe('updated')
    expect(installedVersionOf(readFileSync(hookPath, 'utf8'))).toBe(INTEGRATION_ASSET_VERSION)
  })

  it('refuses to guess at an agent it has no integration for', () => {
    const [outcome] = installIntegrations(options(), { agents: ['codex'] })
    expect(outcome?.installed).toBe(false)
    expect(outcome?.result).toMatch(/no integration/u)
  })

  it('reports a settings file it cannot parse rather than overwriting it', () => {
    // Overwriting a config we failed to understand is how a user loses their
    // permissions list.
    const settingsPath = join(home, '.claude/settings.json')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(settingsPath, '{ this is not json')

    const [outcome] = installIntegrations(options(), { agents: ['claude'] })
    expect(outcome?.installed).toBe(true)
    expect(outcome?.warning).toMatch(/could not be updated/u)
    expect(readFileSync(settingsPath, 'utf8')).toBe('{ this is not json')
  })

  it('quotes a hook path containing a space', () => {
    expect(hookCommand('/Users/a b/hook.sh', 'idle')).toBe("'/Users/a b/hook.sh' idle")
  })
})
