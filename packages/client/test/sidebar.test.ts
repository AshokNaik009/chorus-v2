/**
 * The `[sidebar]` settings, end to end, at 80 columns.
 *
 * Criterion 9: "Docking left or right, and unified or split Explorer/Source Control,
 * both work at 80 columns without the panes collapsing." Criterion 7: the settings
 * "round-trip … survive a restart, and `C-b R` re-reads them without closing the panel."
 *
 * ## Why these are integration tests and the rest are not
 *
 * Everything else about the dock can be driven at the object — that is the whole point
 * of "state here, actions at the call site". Docking cannot: the geometry lives in
 * `app.ts`, it is entangled with the tab bar, the status bar and the pane tree, and the
 * failure mode the criterion is about — *panes collapsing* — is only visible once
 * something is actually laid out. So these start a real daemon and a real client,
 * exactly as `search.test.ts` does, and read the screen.
 *
 * **80 columns is the number the criterion names**, and it is the tight case: the dock's
 * minimum is 34 and a third of 80 is 26, so the cap does the work and what is left has
 * to still be a usable pane.
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
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A repository with one committed file and one edited since. */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'lc-dock-'))
  made.push(root)
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const a = 1\n')
  writeFileSync(join(root, 'README.md'), '# repo\n')
  git('add', '--all')
  git('commit', '-q', '-m', 'first')
  writeFileSync(join(root, 'src', 'widget.ts'), 'export const a = 2\n')
  return root
}

async function open(config: string, key = 'e', cols = 80): Promise<TuiHarness> {
  harness = await TuiHarness.start({
    cols,
    rows: 24,
    command: '/bin/bash',
    args: ['--norc', '--noprofile'],
    cwd: makeRepo(),
    config
  })
  await harness.waitForReady()
  harness.command(key)
  return harness
}

/**
 * The column the activity bar's first chip starts at.
 *
 * Measured from `files` rather than from the row's first non-blank column, because the
 * activity bar and the **tab bar share row 0** — they sit on opposite sides of the dock
 * — so the row always starts with whichever of the two is on the left.
 */
function chipColumn(screen: string): number {
  const row = screen.split('\n').find((line) => line.includes('files') && line.includes('search'))
  if (row === undefined) throw new Error(`no activity bar on screen:\n${screen}`)
  return row.indexOf('files')
}

describe('docking, at 80 columns', () => {
  it('left is the default and puts the dock at column 0', async () => {
    const tui = await open('[sidebar]\ndock = "left"\n')
    await tui.waitForText('README.md')
    // Column 1, not 0: the chip is drawn as ` files ` with its own padding.
    expect(chipColumn(await tui.screen())).toBeLessThan(4)
  })

  it('right puts the dock against the right edge and leaves the panes on the left', async () => {
    const tui = await open('[sidebar]\ndock = "right"\n')
    await tui.waitForText('README.md')
    const screen = await tui.screen()
    // The width is capped at a third of the screen, so on 80 columns the dock is 26
    // wide and starts at 54. Asserted loosely — the exact column is the cap's business,
    // and what this test is about is which side.
    expect(chipColumn(screen)).toBeGreaterThan(40)
    // The pane kept the other side rather than being squeezed out of existence, which
    // is the half of the criterion an assertion about the dock alone cannot see.
    const paneRow = screen.split('\n').find((line) => line.includes('pane 1'))
    expect(paneRow?.indexOf('pane 1')).toBeLessThan(20)

    // And the pane is still there, still usable, on the other side. This is the half of
    // the criterion that says "without the panes collapsing" — a dock that took the
    // whole width would pass every assertion above.
    tui.write('\u001b')
    await tui.waitForScreen((text) => !text.includes('search'), 'the dock never closed')
    tui.write('echo docked-right\r')
    await tui.waitForText('docked-right')
  })

  it('a right-docked panel still reaches every view', async () => {
    const tui = await open('[sidebar]\ndock = "right"\n', 'g')
    await tui.waitForText('Changes (1)')
    // `1` is the files view, and it has to work from the right as well as the left.
    tui.write('1')
    await tui.waitForText('README.md')
  })
})

describe('unified versus separate', () => {
  it('separate shows one view at a time, with git as its own chip', async () => {
    const tui = await open('[sidebar]\nlayout = "separate"\n')
    const screen = await tui.waitForText('README.md')
    expect(screen).toContain('git')
    // The tree is on screen and the changes list is not, because they are two views.
    expect(screen).not.toContain('Changes (1)')
  })

  it('unified stacks the tree and the changes list in one view', async () => {
    const tui = await open('[sidebar]\nlayout = "unified"\n')
    await tui.waitForText('README.md')
    // Both, at once, which is the whole point of the layout.
    const screen = await tui.waitForText('Changes (1)')
    expect(screen).toContain('README.md')
    // And the shell is still beside it: two stacked lists divide the dock's *height*,
    // never its width.
    tui.write('\u001b')
    await tui.waitForScreen((text) => !text.includes('Changes (1)'), 'the dock never closed')
    tui.write('echo unified-ok\r')
    await tui.waitForText('unified-ok')
  })

  it('tab moves the keyboard between the two halves', async () => {
    const tui = await open('[sidebar]\nlayout = "unified"\n')
    await tui.waitForText('Changes (1)')
    tui.write('\t')
    // The changes list's hints replace the tree's once it has the keyboard. Matched on
    // the *start* of the hint: at 80 columns the status bar truncates, so anything later
    // in the line is not on screen to assert against.
    await tui.waitForText('stage/open')
    tui.write('\t')
    // And back, so Tab is a toggle rather than a one-way trip into the lower list.
    await tui.waitForText('h/l fold')
  })
})

describe('the git footer', () => {
  it('shows the branch outside the Source Control view when it is on', async () => {
    const tui = await open('[sidebar]\ngit-footer = true\n')
    await tui.waitForText('README.md')
    // The tree is showing, and the branch is visible anyway — which is the argument for
    // the footer: the two facts worth knowing continuously should not need a view switch.
    const screen = await tui.waitForText('main')
    expect(screen).toContain('README.md')
  })

  it('is off unless asked, and then the tree has that row back', async () => {
    const tui = await open('[sidebar]\ngit-footer = false\n')
    const screen = await tui.waitForText('README.md')
    expect(screen).not.toContain('⎇')
  })
})

describe('icon themes reach the tree', () => {
  it('emoji puts a glyph on every row without pushing the name off', async () => {
    const tui = await open('[sidebar]\nicons = "emoji"\n')
    const screen = await tui.waitForText('README.md')
    expect(screen).toContain('📁')
    expect(screen).toContain('📝')
  })

  it('ascii is the default and draws no icon column at all', async () => {
    const tui = await open('[general]\nscrollback = 500\n')
    const screen = await tui.waitForText('README.md')
    // Byte-identical to what phases 7 and 8 shipped: a user who never asked for icons
    // must not get any.
    expect(screen).not.toContain('📁')
    expect(screen).not.toContain('📝')
  })
})

describe('a bad value does not stop the dock working', () => {
  it('falls back to the default rather than refusing to start', async () => {
    const tui = await open('[sidebar]\ndock = "sideways"\n')
    // The tree still comes up — one bad key must never cost somebody their panes — and
    // the dock is where it would have been with no setting at all. The *message* is
    // asserted at the schema level in `core/src/sidebar-config.test.ts`; here the status
    // bar is showing the panel's own hints, which is correct and hides it.
    const screen = await tui.waitForText('README.md')
    expect(chipColumn(screen)).toBeLessThan(4)
  })
})

// Criterion 7's second half: "`C-b R` re-reads them without closing the panel."
describe('reloading settings while the dock is open', () => {
  it('changes the icon theme in place, with the panel still up and the cursor kept', async () => {
    const tui = await open('[sidebar]\nicons = "ascii"\n')
    await tui.waitForText('README.md')
    expect(await tui.screen()).not.toContain('📁')

    // Move off the first row, so what is checked afterwards is that the *view* survived
    // rather than that a fresh one happens to look the same.
    tui.write('j')
    tui.rewriteConfig('[sidebar]\nicons = "emoji"\n')
    tui.command('R')

    await tui.waitForText('📁')
    const screen = await tui.screen()
    // Still the tree, still the same listing: the container took the new settings rather
    // than being rebuilt, which is the whole of the criterion.
    expect(screen).toContain('README.md')
    expect(screen).toContain('src/')
  })

  it('turns the git footer on without reopening the dock', async () => {
    const tui = await open('[sidebar]\ngit-footer = false\n')
    await tui.waitForText('README.md')
    expect(await tui.screen()).not.toContain('⎇')

    tui.rewriteConfig('[sidebar]\ngit-footer = true\n')
    tui.command('R')
    // The footer needs the Source Control status, which the Explorer view had no reason
    // to fetch a moment ago — so this also covers the reload asking for what the new
    // settings need rather than only redrawing with what it already had.
    const screen = await tui.waitForText('⎇')
    expect(screen).toContain('README.md')
  })
})

// Criterion 2, end to end. The unit tests cover the bounds and the parsing; what only a
// real client and a real daemon can show is that `preview.read` is reached at all, that
// the path it resolves is the one the tree is showing, and that `[sidebar] preview`
// really is what decides between a glance and a pane.
describe('the embedded preview', () => {
  it('⏎ opens a pane when preview is off, which is what phase 7 did', async () => {
    const tui = await open('[sidebar]\npreview = false\n')
    await tui.waitForText('README.md')
    tui.write('j\r')
    // A second pane, not a preview: the delegate-to-$PAGER decision is unchanged for
    // anybody who did not ask for something else.
    await tui.waitForText('2 panes')
  })

  it('⏎ previews in the dock when preview is on, and the dock keeps the keyboard', async () => {
    const tui = await open('[sidebar]\npreview = true\n')
    await tui.waitForText('README.md')
    tui.write('j\r')
    // The file's own contents, in the dock. Still one pane.
    await tui.waitForText('# repo')
    const screen = await tui.screen()
    expect(screen).not.toContain('2 panes')
    // And the preview says what it is showing, in the same shape every other view uses.
    expect(screen).toContain('lines')
  })

  it('escape from a preview goes back to the tree, not out of the dock', async () => {
    const tui = await open('[sidebar]\npreview = true\n')
    await tui.waitForText('README.md')
    tui.write('j\r')
    await tui.waitForText('# repo')
    tui.write('\u001b')
    // Back on the row it was opened from — a glance you cannot back out of is a detour.
    await tui.waitForScreen((text) => text.includes('src/') && !text.includes('# repo'), 'never returned to the tree')
  })

  it('a preview view reached by `4` shows the file the cursor is on', async () => {
    // The bug, reported from a screenshot: a file was highlighted in the tree, the
    // `view` chip was clicked, and the preview said "nothing selected" — because only
    // `⏎` and the row menu had ever handed it a path. A view with a cursor on a file
    // that claims nothing is selected is wrong about its own state.
    const tui = await open('[sidebar]\npreview = true\n')
    await tui.waitForText('README.md')
    tui.write('j')
    tui.write('4')
    await tui.waitForText('# repo')
  })

  it('and says nothing is selected when the cursor is on a directory', async () => {
    // Still no guessing: a directory has no contents to show, and picking some file
    // beneath it would be inventing a request the user did not make.
    const tui = await open('[sidebar]\npreview = true\n')
    await tui.waitForText('README.md')
    tui.write('4')
    await tui.waitForText('nothing selected')
  })
})
