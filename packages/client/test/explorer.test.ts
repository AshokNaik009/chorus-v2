/**
 * The file explorer, end to end.
 *
 * Real client, real daemon, real directories. The cases that matter are the ones the
 * tree model cannot be trusted on alone: that expanding actually fetches, that a
 * refresh does not fold everything back up, and that git decorations land on the right
 * rows.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TuiHarness } from './harness.js'

let harness: TuiHarness | null = null
const made: string[] = []

afterEach(async () => {
  await harness?.stop()
  harness = null
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-exp-'))
  made.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src/app.ts'), 'original\n')
  writeFileSync(join(root, 'README.md'), '# hi\n')
  writeFileSync(join(root, '.hidden'), 'x\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  return root
}

async function openExplorer(cwd: string): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols: 110,
    rows: 30,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cwd
  })
  await harness.waitForReady()
  harness.command('e')
  return harness
}

/** The panel's own column, read back as lines. */
function panelLines(screen: string, width = 34): string[] {
  return screen.split('\n').map((line) => line.slice(0, width).trimEnd())
}

describe('the file explorer', () => {
  it('lists the repository root, directories first', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    const lines = panelLines(await tui.screen()).filter((line) => line.length > 0)
    const src = lines.findIndex((line) => line.includes('src/'))
    const readme = lines.findIndex((line) => line.includes('README.md'))
    expect(src).toBeGreaterThan(0)
    expect(src).toBeLessThan(readme)
  })

  it('hides dotfiles until . is pressed', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('README.md')
    expect(await tui.screen()).not.toContain('.hidden')
    tui.write('.')
    await tui.waitForText('.hidden')
  })

  it('expands a directory and fetches its children', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    // The root listing does not contain app.ts; expanding has to go and get it.
    expect(await tui.screen()).not.toContain('app.ts')
    tui.write('\r')
    await tui.waitForText('app.ts')
  })

  it('folds a directory again', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    tui.write('\r')
    await tui.waitForText('app.ts')
    tui.write('h')
    await tui.waitForScreen((s) => !s.includes('app.ts'), 'the directory never folded')
  })

  it('marks a modified file and the directory above it', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src/app.ts'), 'edited\n')
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    // The folded directory carries a marker for what is under it.
    await tui.waitForScreen(
      (screen) => panelLines(screen).some((line) => line.includes('src/') && line.trimEnd().endsWith('·')),
      'the directory never showed a marker'
    )
    tui.write('\r')
    await tui.waitForScreen(
      (screen) => panelLines(screen).some((line) => line.includes('app.ts') && line.trimEnd().endsWith('M')),
      'the file never showed its status letter'
    )
  })

  it('keeps expanded directories open across a refresh', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    tui.write('\r')
    await tui.waitForText('app.ts')
    tui.write('r')
    // A refresh that folds the tree back up would make the key useless.
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(await tui.screen()).toContain('app.ts')
  })

  it('switches to source control with 2 and back with 1', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src/app.ts'), 'edited\n')
    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    tui.write('2')
    await tui.waitForText('Changes (1)')
    tui.write('1')
    await tui.waitForText('src/')
  })

  it('works outside a repository, rooted at the shell directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'lc-plain-'))
    made.push(plain)
    writeFileSync(join(plain, 'loose.txt'), '')
    const tui = await openExplorer(plain)
    await tui.waitForText('loose.txt')
  })

  it('closes on escape and gives the keyboard back', async () => {
    const root = makeRepo()
    const tui = await openExplorer(root)
    await tui.waitForText('README.md')
    tui.write('\u001b')
    await tui.waitForScreen((s) => !s.includes('README.md'), 'the panel never closed')
    tui.write('echo back-to-shell\r')
    await tui.waitForText('back-to-shell')
  })
})

/**
 * PHASE-7 criterion 7: staging from the tree.
 *
 * A directory is a thing you can point at here and cannot in the changes list, which is
 * why staging lives in both panels. The boundary case is the one that matters: `git add
 * -- vendor` with an unregistered repository inside it records a **gitlink** — a single
 * index entry naming a commit, in a repository with no submodule config to resolve it.
 * The daemon enumerates the paths instead; see `drop_nested` in herdr-sidebar's
 * `git.rs`, and `nestedRootsFor` in ours.
 */
describe('staging from the explorer', () => {
  function staged(root: string): string[] {
    const out = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' })
    return out.split('\n').filter((line) => line.length > 0).sort()
  }

  it('stages one file on s, and marks it staged in the tree', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'README.md'), '# edited\n')
    const tui = await openExplorer(root)
    await tui.waitForText('README.md')
    // src/ sorts first; one step down lands on README.md.
    tui.write('j')
    tui.write('s')

    await tui.waitForScreen(() => staged(root).length > 0, 'the file was never staged')
    expect(staged(root)).toEqual(['README.md'])
  })

  it('stages every changed file under a directory, and nothing beside it', async () => {
    const root = makeRepo()
    writeFileSync(join(root, 'src/app.ts'), 'edited\n')
    writeFileSync(join(root, 'src/added.ts'), 'new\n')
    writeFileSync(join(root, 'README.md'), '# edited\n')

    const tui = await openExplorer(root)
    await tui.waitForText('src/')
    tui.write('s')

    await tui.waitForScreen(() => staged(root).length > 0, 'the directory was never staged')
    expect(staged(root)).toEqual(['src/added.ts', 'src/app.ts'])
  })

  it('does not cross into a nested repository, and says why when that is all there was', async () => {
    const root = makeRepo()
    mkdirSync(join(root, 'vendor'))
    writeFileSync(join(root, 'vendor/own.ts'), 'mine\n')
    const inner = join(root, 'vendor/inner')
    mkdirSync(inner)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, stdio: 'pipe' })
    writeFileSync(join(inner, 'theirs.ts'), 'theirs\n')

    const tui = await openExplorer(root)
    await tui.waitForText('vendor/')
    // src/ then vendor/, both directories, before the files.
    tui.write('j')
    tui.write('s')

    await tui.waitForScreen(() => staged(root).length > 0, 'the directory was never staged')
    expect(staged(root)).toEqual(['vendor/own.ts'])
    // The gitlink git would have recorded for the inner repository is not in the index.
    expect(staged(root)).not.toContain('vendor/inner')
  })

  it('reports a stage that was entirely inside a nested repository', async () => {
    const root = makeRepo()
    const inner = join(root, 'inner')
    mkdirSync(inner)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: inner, stdio: 'pipe' })
    writeFileSync(join(inner, 'theirs.ts'), 'theirs\n')

    const tui = await openExplorer(root)
    await tui.waitForText('inner/')
    tui.write('s')

    await tui.waitForScreen(
      (screen) => panelLines(screen).join(' ').includes('nested repository'),
      'the panel never said why nothing was staged'
    )
    expect(staged(root)).toEqual([])
  })
})
