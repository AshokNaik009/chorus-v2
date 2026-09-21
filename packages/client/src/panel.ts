/**
 * The dock: one panel, four views, an activity bar across the top.
 *
 * herdr-sidebar's chrome (MIT), reduced to what a docked column can carry. See
 * `NOTICE`.
 *
 * ## Why this exists at all
 *
 * Before this, `C-b e` and `C-b g` opened two separate objects that each closed the
 * other by hand, and `1` / `2` worked by doing exactly that. Two views can be managed
 * that way; three cannot, because "keep each view's cursor and scroll across a switch"
 * stops being free the moment switching means constructing a new panel. So the
 * container holds all of them for as long as the dock is open, and switching is a field
 * assignment.
 *
 * ## What the container owns, and what it does not
 *
 * It owns: which view is active, the dock's minimum width, the activity bar and its
 * hit zones, the Git footer, the keys that are about the *panel* rather than about a
 * view (`1`-`4`, `Ctrl+P`, `Ctrl+F`), the body area, and the status-bar hint. It also
 * owns the `[sidebar]` settings, because every one of them is a statement about the
 * dock rather than about anything inside it.
 *
 * Each view keeps its own state and its own `handleKey` returning its own outcome
 * type. The container does not unify those: a stage, an expand and an open are not
 * three cases of one thing, and flattening them would move source-control knowledge
 * into a file that has no business holding any. Routing is therefore a tagged result
 * the app switches on, exactly as it already did with two panels.
 *
 * ## Phase 9's addition, and why it fits the shape the contract predicted
 *
 * The previous handoff wrote down what adding a view would cost: "a field, a `CHIPS`
 * entry, a case in four `switch`es, and one arm on `PanelOutcome`; the compiler names
 * all of them." That turned out to be exactly right, and it is the reason there is no
 * `PanelView` interface here — the fourth view cost four compiler errors, each of them
 * a place a decision genuinely had to be made.
 */

import { ScreenBuffer, truncate, type Rect } from '@leap-chorus/tui'
import type { SidebarConfig } from '@leap-chorus/core'
import type { Palette } from './chrome.js'
import { EXPLORER_HINT, ExplorerPanel, type ExplorerOutcome } from './explorer.js'
import { iconTheme, type IconTheme } from './icons.js'
import { PreviewPanel, type PreviewOutcome } from './preview.js'
import { MIN_SCM_WIDTH, SCM_HINT, ScmPanel, renderScmPanel, type ScmOutcome } from './scm.js'
import { SearchPanel, type PanelKey, type SearchOutcome } from './search.js'

/** VS Code's activity-bar order, which is the order `1` `2` `3` `4` follow. */
export type ViewId = 'explorer' | 'search' | 'scm' | 'preview'

export const VIEW_ORDER: readonly ViewId[] = ['explorer', 'search', 'scm', 'preview']

/** What the container did, or what the active view asked the app to do. */
export type PanelOutcome =
  | { readonly view: 'explorer'; readonly outcome: ExplorerOutcome }
  | { readonly view: 'search'; readonly outcome: SearchOutcome }
  | { readonly view: 'scm'; readonly outcome: ScmOutcome }
  | { readonly view: 'preview'; readonly outcome: PreviewOutcome }
  /** Handled here. `switched` means the app should refresh whatever the new view needs. */
  | { readonly view: 'panel'; readonly outcome: 'none' | 'close' | 'switched' }

const NOTHING: PanelOutcome = { view: 'panel', outcome: 'none' }

/** The activity bar's chips, in order. Words rather than icons: they must not shift. */
const CHIPS: readonly { readonly id: ViewId; readonly label: string }[] = [
  { id: 'explorer', label: 'files' },
  { id: 'search', label: 'search' },
  { id: 'scm', label: 'git' },
  { id: 'preview', label: 'view' }
]

/**
 * In `unified` layout, `git` is not its own chip — the tree and the changes list share
 * one view, so a chip for the half that is always on screen would switch to nothing.
 */
const UNIFIED_CHIPS: readonly ViewId[] = ['explorer', 'search', 'preview']

export interface ActivityZone {
  readonly id: ViewId
  readonly x: number
  /** One past the last column of the chip. */
  readonly end: number
}

/**
 * Where each chip sits, derived from the area rather than remembered from a render.
 *
 * A click can arrive before the first paint of a resized dock, and a hit zone stored
 * during the last one would then be a column off. Both the renderer and the click
 * handler call this, so they cannot disagree.
 */
export function activityZones(area: Rect, layout: SidebarConfig['layout'] = 'separate'): ActivityZone[] {
  const zones: ActivityZone[] = []
  let x = area.x
  for (const chip of CHIPS) {
    if (layout === 'unified' && !UNIFIED_CHIPS.includes(chip.id)) continue
    const width = chip.label.length + 2
    if (x + width > area.x + area.width) break
    zones.push({ id: chip.id, x, end: x + width })
    x += width
  }
  return zones
}

/**
 * The `[sidebar]` settings the container honours.
 *
 * Taken as a whole rather than key by key so `C-b R` can hand over a freshly loaded
 * config in one call, without the container having to know which keys changed.
 */
export type PanelSettings = Pick<SidebarConfig, 'layout' | 'icons' | 'gitFooter' | 'preview'>

const DEFAULT_SETTINGS: PanelSettings = {
  layout: 'separate',
  icons: 'ascii',
  gitFooter: false,
  preview: false
}

/**
 * The `[sidebar]` keys the container cares about, pulled out of a whole `Config`.
 *
 * A function rather than a spread at each call site, so adding a key to `PanelSettings`
 * is one edit instead of three and cannot be half-done.
 */
export function panelSettings(config: { sidebar: SidebarConfig }): PanelSettings {
  return {
    layout: config.sidebar.layout,
    icons: config.sidebar.icons,
    gitFooter: config.sidebar.gitFooter,
    preview: config.sidebar.preview
  }
}

/** Which half of a `unified` body has the keyboard. */
export type UnifiedFocus = 'tree' | 'changes'

/**
 * How wide a file wants to be read at.
 *
 * Eighty columns, because that is what text is written to. The dock's other three
 * views are lists of paths and are fine in thirty-four; the Preview is the one view
 * whose content was authored at a width, and drawing it in a list's column turns every
 * line into an ellipsis. That was the state this fixed: a file open in the dock beside
 * two idle shells, unreadable, with three quarters of the screen empty.
 */
const READABLE_WIDTH = 80

/**
 * The narrowest preview that is still worth putting the tree beside.
 *
 * Below this the split costs more than it gives — a tree you were not reading against
 * a file you now cannot. So the tree comes back only when it is effectively free.
 */
const TREE_BESIDE_PREVIEW_MIN = 72

export class SidebarPanels {
  readonly explorer = new ExplorerPanel()
  readonly scm = new ScmPanel()
  readonly search = new SearchPanel()
  readonly preview = new PreviewPanel()

  private view: ViewId
  private settings: PanelSettings = DEFAULT_SETTINGS
  private icons: IconTheme = iconTheme('ascii')
  /** In `unified` layout, which of the two stacked lists the keys go to. */
  private unifiedFocus: UnifiedFocus = 'tree'
  /**
   * Where `Ctrl+P` was pressed, so escaping quick open goes back there.
   *
   * Quick open is a gesture you make *from* somewhere. Dropping the whole dock when it
   * closes would make `Ctrl+P` a one-way door out of the tree you were reading. The
   * preview uses the same field for the same reason: you opened it from a row, and
   * `Esc` should put you back on that row.
   */
  private returnTo: ViewId | null = null

  constructor(initial: ViewId = 'explorer', settings?: PanelSettings) {
    this.view = initial
    if (settings !== undefined) this.applySettings(settings)
  }

  /**
   * Take a new `[sidebar]` block.
   *
   * Called on construction and again on every `client.reload-config`, which is what
   * makes `C-b R` change the dock without closing it. Nothing here is reconstructed, so
   * every view keeps its cursor and its scroll across a reload as well as across a
   * switch.
   */
  applySettings(settings: PanelSettings): void {
    this.settings = settings
    this.icons = iconTheme(settings.icons)
    this.explorer.icons = this.icons
    // A layout change can leave the active view unreachable: `git` has no chip when the
    // tree and the changes list share one. Landing on the view that now contains it is
    // less surprising than leaving a view on screen the activity bar cannot return to.
    if (settings.layout === 'unified' && this.view === 'scm') {
      this.view = 'explorer'
      this.unifiedFocus = 'changes'
    }
  }

  /** Whether `⏎` on a file previews it here rather than opening a pane. */
  previewOnEnter(): boolean {
    return this.settings.preview
  }

  active(): ViewId {
    return this.view
  }

  layout(): SidebarConfig['layout'] {
    return this.settings.layout
  }

  /** Narrower than this and a path is a column of truncation. Same bound for all views. */
  minWidth(): number {
    return MIN_SCM_WIDTH
  }

  /**
   * How wide the dock should be, for the view that is showing.
   *
   * Three of the four views are lists and take the configured width, capped at a third
   * of the screen so docking can never collapse the panes. **The Preview is not a
   * list**, and capping it the same way is what made it useless: herdr-sidebar is a
   * narrow tree *plus a wide viewer*, and porting the viewer into the tree's column
   * kept the geometry and lost the point of it.
   *
   * So Preview asks for enough to read at — the tree's width plus eighty columns when
   * the screen is large enough to hold the pair, eighty when it is not — and is capped
   * at **half** the screen rather than a third, because a multiplexer whose panes are
   * a third of the screen is a file viewer with a terminal attached. It never returns
   * less than the other views would, so switching to it never makes the dock narrower.
   */
  preferredWidth(cols: number, configured: number): number {
    const normal = Math.min(Math.max(configured, this.minWidth()), Math.max(this.minWidth(), Math.floor(cols / 3)))
    if (this.view !== 'preview') return normal
    const ideal = MIN_SCM_WIDTH + 1 + READABLE_WIDTH
    return Math.max(normal, Math.min(Math.floor(cols / 2), ideal))
  }

  /**
   * How a Preview body divides: the tree on the left when there is room, the file on
   * the right, and the whole body for the file when there is not.
   *
   * This is the shape `PARITY.md` has carried as its largest remaining orphan — "a
   * narrow tree *plus* a wide viewer" — and it is worth having because of what it does
   * to the mouse: clicking a row in that tree previews it beside itself, which is the
   * gesture the Explorer's click already produced and had nowhere to put.
   */
  previewAreas(body: Rect): { tree: Rect | null; preview: Rect } {
    if (body.width < MIN_SCM_WIDTH + 1 + TREE_BESIDE_PREVIEW_MIN) return { tree: null, preview: body }
    const treeWidth = MIN_SCM_WIDTH
    return {
      tree: { x: body.x, y: body.y, width: treeWidth, height: body.height },
      preview: {
        x: body.x + treeWidth + 1,
        y: body.y,
        width: body.width - treeWidth - 1,
        height: body.height
      }
    }
  }

  /** The columns the file itself gets — what the daemon should wrap and render to. */
  previewWidth(area: Rect): number {
    return this.previewAreas(this.bodyArea(area)).preview.width
  }

  /**
   * One row at the bottom when `[sidebar] git-footer` is on and there is a branch.
   *
   * Conditional on there *being* a status, not just on the setting: an empty footer
   * would take a row of tree from somebody outside a repository who turned the option on
   * once and forgot.
   */
  footerRows(): number {
    return this.settings.gitFooter && this.scm.status !== null ? 1 : 0
  }

  /** The area the active view draws into: the dock minus the activity bar and footer. */
  bodyArea(area: Rect): Rect {
    return {
      x: area.x,
      y: area.y + 1,
      width: area.width,
      height: Math.max(0, area.height - 1 - this.footerRows())
    }
  }

  /**
   * How a `unified` body divides between the tree and the changes list.
   *
   * The changes list gets what it needs and no more — two rows of chrome plus one row
   * per change — capped at half the body, and the tree takes the rest. A repository with
   * nothing changed therefore costs the tree three rows rather than half of it, which is
   * the state the dock is in most of the time.
   */
  unifiedAreas(body: Rect): { tree: Rect; changes: Rect } {
    const changeRows = (this.scm.status?.staged.length ?? 0) + (this.scm.status?.unstaged.length ?? 0)
    const headers = changeRows === 0 ? 0 : 2
    // An *open* drawer asks for room; eight collapsed ones do not. Counting the eight
    // headers unconditionally would take half the tree away from everybody who has
    // never opened a drawer, and they are still reachable by scrolling the lower half.
    const drawerRows = this.scm.drawers.expandedIds().length === 0 ? 0 : this.scm.drawers.lines().length
    const wanted = Math.min(2 + headers + changeRows + drawerRows, Math.floor(body.height / 2))
    const changesHeight = Math.max(3, Math.min(wanted, Math.max(0, body.height - 4)))
    const treeHeight = Math.max(0, body.height - changesHeight)
    return {
      tree: { x: body.x, y: body.y, width: body.width, height: treeHeight },
      changes: { x: body.x, y: body.y + treeHeight, width: body.width, height: changesHeight }
    }
  }

  /**
   * Switch view.
   *
   * Nothing is reconstructed, which is the whole point: each view still holds the
   * cursor and scroll offset it had when it was last on screen.
   */
  show(id: ViewId): PanelOutcome {
    this.returnTo = null
    // `scm` in unified layout is the changes half of the Explorer view, not a view.
    if (this.settings.layout === 'unified' && id === 'scm') {
      this.unifiedFocus = 'changes'
      return this.view === 'explorer' ? NOTHING : this.show('explorer')
    }
    if (this.view === id) return NOTHING
    this.view = id
    // Arriving at Search from the activity bar leaves its boxes unfocused, so the
    // digits stay a switcher. `Ctrl+F` is how you say you meant to type. See `search.ts`.
    if (id === 'search') this.search.blur()
    return { view: 'panel', outcome: 'switched' }
  }

  /** `Ctrl+P` from any view. Returns the search view's own outcome, which fetches the list. */
  quickOpen(): PanelOutcome {
    if (this.view !== 'search') this.returnTo = this.view
    this.view = 'search'
    return { view: 'search', outcome: this.search.openQuick() }
  }

  /** `Ctrl+F` from any view: the Search view, caret in the query box. */
  contentSearch(): PanelOutcome {
    this.returnTo = null
    this.view = 'search'
    return { view: 'search', outcome: this.search.openContent() }
  }

  /**
   * Show the preview view, remembering where it was opened from.
   *
   * The app calls this when a row is activated and `[sidebar] preview` is on. `Esc`
   * then returns to the tree or the result list rather than closing the dock, because a
   * glance you cannot back out of is a detour.
   */
  /**
   * The file the preview should show when it is opened with nothing in it.
   *
   * Switching to the Preview view with `4` or the activity bar used to say "nothing
   * selected" while a file sat highlighted in the Explorer one keystroke away, because
   * only `⏎` and the row menu ever handed the preview a path. A view that has a
   * cursor on a file and claims nothing is selected is wrong about its own state.
   *
   * Null when the preview already has something (the user's last glance wins over the
   * tree's cursor), when the cursor is on a directory, or when the tree has not been
   * listed yet.
   */
  previewTarget(): string | null {
    if (this.preview.result !== null || this.preview.pending !== null || this.preview.error !== null) return null
    const node = this.explorer.selected()
    return node !== null && node.kind === 'file' && node.path !== '' ? node.path : null
  }

  showPreview(path: string): PanelOutcome {
    if (this.view !== 'preview') this.returnTo = this.view
    this.view = 'preview'
    this.preview.request(path)
    return { view: 'panel', outcome: 'none' }
  }

  handleKey(key: PanelKey): PanelOutcome {
    // `Ctrl+1..4` always switch, as they do in an editor. Bare digits switch only where
    // they are not text: a focused search box has to be able to type `3`.
    const digit = key.char !== undefined && key.char >= '1' && key.char <= '4' ? key.char : null
    if (digit !== null && !key.alt) {
      const bare = !key.ctrl && !this.typing()
      if (key.ctrl || bare) {
        return this.show(VIEW_ORDER[Number(digit) - 1] as ViewId)
      }
    }
    if (key.ctrl && !key.alt && key.char === 'p') return this.quickOpen()
    if (key.ctrl && !key.alt && key.char === 'f') return this.contentSearch()

    switch (this.view) {
      case 'explorer':
        return this.explorerKey(key)
      case 'scm':
        return { view: 'scm', outcome: this.scm.handleKey(key.name, key.char) }
      case 'preview': {
        const outcome = this.preview.handleKey(key, this.lastBody)
        if (outcome.kind === 'close' && this.returnTo !== null) return this.goBack()
        return { view: 'preview', outcome }
      }
      case 'search': {
        const outcome = this.search.handleKey(key)
        // Escaping quick open returns to where it was opened from rather than closing
        // the dock, which is what makes it a peek instead of a detour.
        if (outcome.kind === 'close' && this.returnTo !== null) return this.goBack()
        return { view: 'search', outcome }
      }
    }
  }

  /**
   * Keys in the Explorer view, which in `unified` layout is two lists.
   *
   * `Tab` moves between them, and every other key goes to whichever has focus. The two
   * halves keep separate cursors because they already did — this is the same
   * `ExplorerPanel` and `ScmPanel` as in `separate` layout, drawn in two rectangles
   * instead of one.
   */
  private explorerKey(key: PanelKey): PanelOutcome {
    if (this.settings.layout !== 'unified') {
      return { view: 'explorer', outcome: this.explorer.handleKey(key.name, key.char) }
    }
    if (key.name === 'tab') {
      this.unifiedFocus = this.unifiedFocus === 'tree' ? 'changes' : 'tree'
      return NOTHING
    }
    if (this.unifiedFocus === 'changes') {
      const outcome = this.scm.handleKey(key.name, key.char)
      // `Esc` in the lower half returns the keyboard to the tree before it closes the
      // dock; with two lists on screen, one `Esc` per list is what a reader expects.
      if (outcome.kind === 'close') {
        this.unifiedFocus = 'tree'
        return NOTHING
      }
      return { view: 'scm', outcome }
    }
    return { view: 'explorer', outcome: this.explorer.handleKey(key.name, key.char) }
  }

  private goBack(): PanelOutcome {
    const back = this.returnTo
    this.returnTo = null
    if (back !== null) this.view = back
    return { view: 'panel', outcome: 'switched' }
  }

  /** Is a keystroke text right now? Only the search view ever says yes. */
  private typing(): boolean {
    return this.view === 'search' && this.search.textFocused()
  }

  // -------------------------------------------------------------------------
  // Mouse
  // -------------------------------------------------------------------------

  /**
   * The last body rectangle the container was drawn with.
   *
   * The preview needs a height to page by and a width to wrap to, and a keystroke
   * arrives with neither. Remembered from the render rather than recomputed, because
   * the render is the only place that knows what the dock actually got.
   */
  private lastBody: Rect = { x: 0, y: 0, width: MIN_SCM_WIDTH, height: 20 }

  /** A click in the dock. The activity bar is checked first; it sits above every view. */
  handleClick(row: number, column: number, area: Rect): PanelOutcome {
    if (row === area.y) {
      const zone = activityZones(area, this.settings.layout).find(
        (entry) => column >= entry.x && column < entry.end
      )
      return zone === undefined ? NOTHING : this.show(zone.id)
    }
    const body = this.bodyArea(area)
    // A click on the footer is the branch button, the same gesture the Source Control
    // header already offers. Cheapest possible way to reach the branch picker from a
    // view that is not Source Control.
    if (this.footerRows() > 0 && row === body.y + body.height) {
      return { view: 'scm', outcome: { kind: 'branches' } }
    }
    switch (this.view) {
      case 'explorer': {
        if (this.settings.layout === 'unified') {
          const { tree, changes } = this.unifiedAreas(body)
          if (row >= changes.y) {
            this.unifiedFocus = 'changes'
            return { view: 'scm', outcome: this.scm.handleClick(row, changes) }
          }
          this.unifiedFocus = 'tree'
          return { view: 'explorer', outcome: this.explorer.clickRow(row, tree) }
        }
        return { view: 'explorer', outcome: this.explorer.clickRow(row, body) }
      }
      case 'scm':
        return { view: 'scm', outcome: this.scm.handleClick(row, body) }
      case 'search':
        this.search.clickRow(row, body)
        return NOTHING
      case 'preview': {
        // A click in the tree half previews what it hits, right beside itself.
        const { tree } = this.previewAreas(body)
        if (tree === null || column >= tree.x + tree.width) return NOTHING
        return { view: 'explorer', outcome: this.explorer.clickRow(row, tree) }
      }
    }
  }

  scrollBy(delta: number, area: Rect): void {
    const body = this.bodyArea(area)
    if (this.view === 'explorer') {
      if (this.settings.layout === 'unified') {
        const { tree, changes } = this.unifiedAreas(body)
        if (this.unifiedFocus === 'changes') this.scm.scrollBy(delta, changes)
        else this.explorer.scrollBy(delta, tree)
        return
      }
      this.explorer.scrollBy(delta, body)
    } else if (this.view === 'scm') this.scm.scrollBy(delta, body)
    else if (this.view === 'preview') this.preview.scrollBy(delta, body)
    else this.search.scrollBy(delta, body)
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  render(buffer: ScreenBuffer, area: Rect, palette: Palette, focused: boolean): void {
    buffer.fill(area, ' ', palette.sidebar)
    const right = area.x + area.width
    for (const zone of activityZones(area, this.settings.layout)) {
      const chip = CHIPS.find((entry) => entry.id === zone.id)
      if (chip === undefined) continue
      const on = zone.id === this.view
      const style = on ? palette.sidebarActive : (palette.agent['idle'] ?? palette.sidebar)
      buffer.writeString(zone.x, area.y, truncate(` ${chip.label} `, zone.end - zone.x), style, right)
    }

    const body = this.bodyArea(area)
    // The preview pages and wraps against its *own* rectangle, which is not the body
    // once the tree is beside it.
    this.lastBody = this.view === 'preview' ? this.previewAreas(body).preview : body
    if (this.footerRows() > 0) this.renderFooter(buffer, area, palette)
    if (body.height <= 0) return
    switch (this.view) {
      case 'explorer': {
        if (this.settings.layout === 'unified') {
          const { tree, changes } = this.unifiedAreas(body)
          this.explorer.renderInto(buffer, tree, palette)
          renderScmPanel(buffer, changes, this.scm, palette, focused && this.unifiedFocus === 'changes')
          return
        }
        this.explorer.renderInto(buffer, body, palette)
        return
      }
      case 'scm':
        renderScmPanel(buffer, body, this.scm, palette, focused)
        return
      case 'search':
        this.search.renderInto(buffer, body, palette, focused)
        return
      case 'preview': {
        const { tree, preview } = this.previewAreas(body)
        if (tree !== null) this.explorer.renderInto(buffer, tree, palette)
        this.preview.renderInto(buffer, preview, palette, focused)
        return
      }
    }
  }

  /**
   * The Git footer: branch, and how far from the remote, on the dock's last row.
   *
   * herdr-sidebar's compact footer, and the argument for it is that the two facts worth
   * knowing continuously are the ones you otherwise have to switch view to see. Kept to
   * one row and truncated rather than wrapped — it leads with the branch, which is the
   * half that matters when there is not room for both.
   */
  private renderFooter(buffer: ScreenBuffer, area: Rect, palette: Palette): void {
    const status = this.scm.status
    if (status === null) return
    const y = area.y + area.height - 1
    const counts = !status.hasUpstream
      ? ''
      : `${status.ahead > 0 ? ` ↑${status.ahead}` : ''}${status.behind > 0 ? ` ↓${status.behind}` : ''}`
    const changed = status.staged.length + status.unstaged.length
    const dirty = changed === 0 ? '' : ` ●${changed}`
    const text = `⎇ ${status.branch || 'detached'}${counts}${dirty}`
    buffer.fill({ x: area.x, y, width: area.width, height: 1 }, ' ', palette.sidebarActive)
    buffer.writeString(area.x, y, truncate(text, area.width), palette.sidebarActive, area.x + area.width)
  }

  /** The status bar's right-hand side while the dock has the keyboard. */
  hint(): string {
    if (this.view === 'explorer') {
      return this.settings.layout === 'unified'
        ? `${this.unifiedFocus === 'changes' ? SCM_HINT : EXPLORER_HINT} · tab other list`
        : EXPLORER_HINT
    }
    if (this.view === 'scm') return SCM_HINT
    if (this.view === 'preview') return this.preview.hint()
    return this.search.hint()
  }
}
