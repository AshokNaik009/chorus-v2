import type { DaemonClient } from '@leap-chorus/daemon'
import type { AgentFileActivity } from '@leap-chorus/protocol'
import { ExplorerPanel } from './explorer.js'
import { PreviewPanel } from './preview.js'

export class FileBrowser {
  readonly explorer = new ExplorerPanel()
  readonly preview = new PreviewPanel()
  paneId: string | null = null
  pinned = false
  followActivity = false
  private visible = false
  private previewColumns = 0
  private activitySeq = -1
  private restoredActivity = false
  private pendingActivity: AgentFileActivity[] = []
  private activityTimer: NodeJS.Timeout | null = null
  private expiryTimer: NodeJS.Timeout | null = null
  private activityRunning = false
  private client: Pick<DaemonClient, 'call'> | null = null
  private changed: () => void = () => {}
  private epoch = 0
  private sequence = 0
  private statusRequest = 0
  private listings = new Map<string, number>()
  private refreshing: Promise<void> | null = null

  connect(paneId: string, client: Pick<DaemonClient, 'call'>, changed: () => void): void {
    this.paneId = paneId
    this.client = client
    this.changed = changed
  }

  invalidate(): void {
    this.epoch += 1
    this.listings.clear()
    this.preview.reset()
  }

  async list(path: string, resolveRoot = false): Promise<void> {
    if (this.client === null || this.paneId === null) return
    const epoch = this.epoch
    const sequence = ++this.sequence
    const root = resolveRoot ? '' : this.explorer.root
    this.listings.set(path, sequence)
    try {
      const result = await this.client.call('fs.list', {
        paneId: this.paneId, path, ...(root === '' ? {} : { root })
      })
      if (epoch !== this.epoch || this.listings.get(path) !== sequence) return
      if (path !== '' && result.root !== this.explorer.root) return
      if (result.root !== this.explorer.root) this.invalidate()
      this.explorer.adopt(result.root, result.path, result.entries)
    } catch (error) {
      if (epoch === this.epoch && this.listings.get(path) === sequence) this.explorer.fail(String(error), path)
    }
    this.changed()
  }

  async status(): Promise<void> {
    const root = this.explorer.root
    if (this.client === null || root === '') return
    const epoch = this.epoch
    const request = ++this.statusRequest
    try {
      const status = await this.client.call('git.status', { cwd: root })
      if (epoch === this.epoch && request === this.statusRequest) this.explorer.status = status
    } catch {
      if (epoch === this.epoch && request === this.statusRequest) this.explorer.status = null
    }
    this.changed()
  }

  refresh(): Promise<void> {
    if (this.refreshing !== null) return this.refreshing
    this.refreshing = this.refreshTree().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  private async refreshTree(): Promise<void> {
    await this.list('', !this.pinned)
    const epoch = this.epoch
    for (const path of this.explorer.expandedPaths()) {
      if (epoch !== this.epoch) return
      await this.list(path)
    }
    if (epoch === this.epoch) await this.status()
  }

  async read(path: string, width: number, preservePosition = false): Promise<void> {
    const request = this.preview.request(path, preservePosition)
    const root = this.explorer.root
    const epoch = this.epoch
    this.changed()
    if (this.client === null || this.paneId === null || root === '') {
      this.preview.fail(path, 'Open a folder before previewing a file', request)
      this.changed()
      return
    }
    try {
      const result = await this.client.call('preview.read', { paneId: this.paneId, root, path, width, raw: !/\.(md|markdown)$/iu.test(path) })
      if (epoch === this.epoch) this.preview.adopt(result, request)
    } catch (error) {
      if (epoch === this.epoch) this.preview.fail(path, String(error), request)
    }
    this.changed()
  }

  async restoreActivity(): Promise<void> {
    if (this.restoredActivity || this.client === null || this.paneId === null) return
    this.restoredActivity = true
    try {
      const { events } = await this.client.call('agent.activity', { paneId: this.paneId })
      for (const event of events) if (Date.now() - event.at < 4_000) this.noteActivity(event)
    } catch {}
  }

  setVisible(visible: boolean, previewColumns = 0): void {
    this.visible = visible
    this.previewColumns = previewColumns
    if (!visible && this.activityTimer !== null) {
      clearTimeout(this.activityTimer)
      this.activityTimer = null
    }
    if (visible) this.scheduleActivity()
  }

  noteActivity(activity: AgentFileActivity): void {
    if (activity.paneId !== this.paneId || activity.seq <= this.activitySeq) return
    this.activitySeq = activity.seq
    this.pendingActivity = [...this.pendingActivity, activity].slice(-64)
    this.scheduleActivity()
  }

  private scheduleActivity(): void {
    if (!this.visible || this.activityTimer !== null || this.activityRunning || this.pendingActivity.length === 0) return
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null
      this.activityRunning = true
      void this.flushActivity().finally(() => {
        this.activityRunning = false
        this.scheduleActivity()
      })
    }, 200)
    this.activityTimer.unref()
  }

  private relative(path: string | undefined): string | null {
    if (path === undefined || this.explorer.root === '') return null
    const prefix = this.explorer.root.endsWith('/') ? this.explorer.root : `${this.explorer.root}/`
    return path.startsWith(prefix) && path.length > prefix.length ? path.slice(prefix.length) : null
  }

  private async flushActivity(): Promise<void> {
    const events = this.pendingActivity
    this.pendingActivity = []
    const writes = events.some((event) => event.kind !== 'read')
    if (writes || this.explorer.root === '') await this.refresh()
    if (!this.visible) return
    for (const event of events) {
      const path = this.relative(event.path)
      if (path !== null && event.kind !== 'refresh' && Date.now() - event.at < 4_000) {
        this.explorer.activity.delete(path)
        this.explorer.activity.set(path, event.kind)
      }
    }
    while (this.explorer.activity.size > 64) this.explorer.activity.delete(this.explorer.activity.keys().next().value as string)
    const epoch = this.epoch
    const last = [...events].reverse().find((event) => this.relative(event.path) !== null && Date.now() - event.at < 4_000)
    const target = this.relative(last?.path)
    if (target !== null && last !== undefined) {
      this.explorer.activityNote = `${last.agent} ${last.kind}: ${target}`
      if (this.followActivity && last.seq === this.activitySeq) await this.reveal(target, last.seq)
    }
    if (!this.visible || epoch !== this.epoch) return
    if (writes && this.previewColumns > 0 && this.preview.path !== null && this.preview.pending === null) {
      await this.read(this.preview.path, this.previewColumns, true)
    }
    if (!this.visible || epoch !== this.epoch) return
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(() => {
      this.explorer.activity.clear()
      this.explorer.activityNote = ''
      this.expiryTimer = null
      this.changed()
    }, 4_000)
    this.expiryTimer.unref()
    this.changed()
  }

  dispose(): void {
    this.setVisible(false)
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    this.pendingActivity = []
    this.invalidate()
    this.client = null
    this.paneId = null
    this.changed = () => {}
  }

  async reveal(path: string, activitySeq?: number): Promise<void> {
    const epoch = this.epoch
    const current = (): boolean => epoch === this.epoch && (activitySeq === undefined ||
      (this.followActivity && this.visible && activitySeq === this.activitySeq))
    const parts = path.split('/')
    if (current() && !this.explorer.rows().some((row) => row.node.path === parts[0])) await this.list('')
    for (let i = 1; i < parts.length; i++) {
      if (!current()) return
      await this.list(parts.slice(0, i).join('/'))
    }
    if (!current()) return
    this.explorer.reveal(path)
    this.changed()
  }
}
