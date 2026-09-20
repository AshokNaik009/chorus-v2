/**
 * The unix-socket endpoint.
 *
 * Startup order matters and is: make the directory private, take the instance lock,
 * check the path against `sun_path`, clear a stale socket file, bind. The lock is taken
 * *before* the socket is unlinked, so a daemon can never delete a live peer's endpoint —
 * holding the lock is the proof that no live peer exists.
 */

import { chmodSync, existsSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import {
  ErrorCodes,
  FramedConnection,
  PROTOCOL_VERSION,
  decodeWritePayload,
  isRequestMessage,
  negotiate,
  type DaemonInfo,
  type EventMessage,
  type MethodName,
  type MethodParams,
  type MethodResult,
  type RequestMessage,
  type ResponseMessage
} from '@leap-chorus/protocol'
import { configSearchPaths, loadConfig, type LoadedConfig } from '@leap-chorus/config-loader'
import { DaemonError, errnoOf } from './errors.js'
import { SessionRuntime, sessionFilePath } from './runtime.js'
import * as model from './rpc/session-model.js'
import type { AgentDetector } from '@leap-chorus/detect'

import * as agents from './rpc/agents.js'
import * as gitRpc from './rpc/git.js'
import * as worktrees from './rpc/worktrees.js'
import { GitService } from './git.js'
import { WorktreeService } from './worktree.js'
import type { IntegrationOptions } from './integration/install.js'
import { RequestError as ModelRequestError, type Params } from './rpc/params.js'
import { acquireInstanceLock, type InstanceLock } from './lock.js'
import { assertSocketPathFits, type DaemonPaths } from './paths.js'
import { ensurePrivateDirectory } from './lock.js'
import { SessionManager } from './sessions.js'

/** Re-exported from the rpc helpers so every handler throws the same type. */
const RequestError = ModelRequestError

interface ClientState {
  readonly connection: FramedConnection
  readonly subscriptions: Set<string>
  handshaken: boolean
  name: string
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError(ErrorCodes.badRequest, `\`${key}\` must be a non-empty string`)
  }
  return value
}

function requireSize(params: Record<string, unknown>, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    throw new RequestError(ErrorCodes.badRequest, `\`${key}\` must be a positive number`)
  }
  return Math.floor(value)
}

export interface DaemonServerOptions {
  readonly paths: DaemonPaths
  /** Called when a client asks the daemon to shut down. */
  onShutdownRequested?: () => void
  /** Read this config file instead of searching. Used by tests and by `--config`. */
  readonly configPath?: string
  /** Do not restore or write a session file. Used by tests that want a clean model. */
  readonly ephemeral?: boolean
  /** Written to the session file immediately rather than on a timer. Tests only. */
  readonly persistDebounceMs?: number
  /** Injected in tests, so a detection assertion does not depend on the host's `ps`. */
  readonly detector?: AgentDetector
  /** 0 turns the detection poll off, which is what a deterministic test wants. */
  readonly detectIntervalMs?: number
}

/**
 * Where a theme choice is written.
 *
 * The loader's own path when it found a file; otherwise the first place it looks, so
 * the first theme a user picks creates a config rather than being forgotten.
 */
function configPathOption(found: string | null): { configPath?: string } {
  const path = found ?? configSearchPaths()[0]
  return path === undefined ? {} : { configPath: path }
}

/** See `DaemonServer.detectInterval`. */
function detectIntervalOption(options: DaemonServerOptions): { detectIntervalMs?: number } {
  const value = DaemonServer.detectIntervalFor(options)
  return value === undefined ? {} : { detectIntervalMs: value }
}

export class DaemonServer {
  readonly sessions = new SessionManager()
  readonly startedAt = Date.now()
  /** Git worktrees. Stateless: every read shells out. See worktree.ts. */
  private readonly worktreeService = new WorktreeService()
  /** Working-tree git: status, staging, commits. Stateless for the same reason. */
  private readonly gitService = new GitService()

  private gitContext(): gitRpc.GitContext {
    return { git: this.gitService, paneCwdInput: (paneId) => this.runtime.paneCwdInput(paneId) }
  }
  /** The session model: workspaces, tabs, panes. See runtime.ts. */
  readonly runtime: SessionRuntime
  private config: LoadedConfig

  private readonly clients = new Set<ClientState>()
  private unsubscribeSessions: (() => void) | null = null
  private closing = false

  private constructor(
    readonly paths: DaemonPaths,
    private readonly server: Server,
    private readonly lock: InstanceLock,
    private readonly options: DaemonServerOptions
  ) {
    this.config = loadConfig(options.configPath === undefined ? {} : { path: options.configPath })
    this.runtime = SessionRuntime.create({
      sessions: this.sessions,
      socketPath: paths.socketPath,
      // Where `config.set_theme` writes. The loader's own path when it found a file,
      // else the place it would look first, so a first theme choice creates one.
      ...configPathOption(this.config.path),
      ...(options.ephemeral === true ? {} : { sessionPath: sessionFilePath(paths.daemonDir) }),
      ...(options.persistDebounceMs === undefined ? {} : { persistDebounceMs: options.persistDebounceMs }),
      ...(this.config.config.general.cwd.length === 0 ? {} : { defaultCwd: this.config.config.general.cwd }),
      ...(this.config.config.general.shell.length === 0 ? {} : { shell: this.config.config.general.shell }),
      scrollback: this.config.config.general.scrollback,
      ...(options.detector === undefined ? {} : { detector: options.detector }),
      ...detectIntervalOption(options),
      onChange: (revision) => this.broadcastAll({ type: 'event', event: 'state.changed', revision })
    })

    this.unsubscribeSessions = this.sessions.subscribe({
      output: (id, sequence) => this.broadcast(id, { type: 'event', event: 'session.output', id, sequence }, true),
      exit: (id, exit) => {
        this.broadcast(id, { type: 'event', event: 'session.exit', id, exit }, false)
        // The model learns a pane died from the runtime, not from whichever client
        // happened to be watching that session.
        this.runtime.noteSessionExit(id)
      },
      title: (id, title) => {
        this.broadcast(id, { type: 'event', event: 'session.title', id, title }, false)
        this.runtime.noteSessionTitle(id, title)
      }
    })
    server.on('connection', (socket) => this.acceptClient(socket))
  }

  /**
   * How often to poll for agent state.
   *
   * `LEAP_CHORUS_DETECT_INTERVAL_MS=0` turns detection off entirely. That exists for
   * one reason worth stating: PHASE-5 criterion 6 asks whether detection moves frame
   * time, and the only way to answer is to measure the same benchmark with it on and
   * off. An option nothing can set is an assertion, not a measurement.
   */
  static detectIntervalFor(options: DaemonServerOptions): number | undefined {
    if (options.detectIntervalMs !== undefined) return options.detectIntervalMs
    const raw = process.env['LEAP_CHORUS_DETECT_INTERVAL_MS']
    if (raw === undefined || raw.length === 0) return undefined
    const parsed = Number.parseInt(raw, 10)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
  }

  get loadedConfig(): LoadedConfig {
    return this.config
  }

  static async start(options: DaemonServerOptions): Promise<DaemonServer> {
    const { paths } = options
    ensurePrivateDirectory(paths.daemonDir)
    assertSocketPathFits(paths.socketPath)

    const lock = acquireInstanceLock({
      lockPath: paths.lockPath,
      socketPath: paths.socketPath,
      protocolVersion: paths.protocolVersion
    })

    try {
      // Holding the lock proves no live daemon owns this endpoint, so a socket file left
      // behind by a crash is ours to clear.
      if (existsSync(paths.socketPath)) unlinkSync(paths.socketPath)

      const server = createServer()
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown): void => {
          server.off('listening', onListening)
          reject(
            new DaemonError(
              errnoOf(error) === 'ENAMETOOLONG' ? 'leap_chorus_socket_path_too_long' : 'leap_chorus_socket_bind_failed',
              `Cannot bind ${paths.socketPath}: ${String(error)}`,
              { cause: error }
            )
          )
        }
        const onListening = (): void => {
          server.off('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(paths.socketPath)
      })

      // The endpoint carries live terminals; it is for this user only.
      if (process.platform !== 'win32') chmodSync(paths.socketPath, 0o600)

      return new DaemonServer(paths, server, lock, options)
    } catch (error) {
      lock.release()
      throw error
    }
  }

  info(): DaemonInfo {
    return {
      protocolVersion: this.paths.protocolVersion,
      pid: process.pid,
      dataRoot: this.paths.dataRoot,
      socketPath: this.paths.socketPath,
      startedAt: this.startedAt,
      nodeVersion: process.version,
      sessionCount: this.sessions.list().length
    }
  }

  get clientCount(): number {
    return this.clients.size
  }

  /**
   * Fan out an event to the clients subscribed to that session.
   *
   * `droppable` marks events whose only content is "there is more output" — those are
   * skipped for a client whose socket is already saturated, because delivering a stale
   * notification late is worse than delivering the next one on time. Lifecycle events
   * (exit, title) are never dropped.
   */
  private broadcast(sessionId: string, event: EventMessage, droppable: boolean): void {
    for (const client of this.clients) {
      if (!client.handshaken || client.connection.isClosed) continue
      if (!client.subscriptions.has(sessionId)) continue
      if (droppable && client.connection.saturated) continue
      client.connection.send(event)
    }
  }

  /**
   * Fan out an event every client cares about.
   *
   * Session events are addressed by subscription because a client only wants output
   * from panes it is drawing. The session *model* is not like that: a client that does
   * not know a workspace was created cannot draw the sidebar, so it goes to everyone.
   */
  private broadcastAll(event: EventMessage): void {
    for (const client of this.clients) {
      if (!client.handshaken || client.connection.isClosed) continue
      client.connection.send(event)
    }
  }

  private acceptClient(socket: Socket): void {
    socket.setNoDelay(true)
    const state: ClientState = {
      connection: null as unknown as FramedConnection,
      subscriptions: new Set<string>(),
      handshaken: false,
      name: 'unknown'
    }
    const connection = new FramedConnection(socket, {
      onMessage: (message) => void this.handleMessage(state, message),
      onError: (error) => {
        // One malformed frame is not a dead connection; the decoder resynchronizes.
        console.warn(`[leap-chorusd] framing error from ${state.name}: ${error.message}`)
      },
      onClose: () => {
        this.clients.delete(state)
      }
    })
    ;(state as { connection: FramedConnection }).connection = connection
    this.clients.add(state)
  }

  private async handleMessage(state: ClientState, message: unknown): Promise<void> {
    if (!isRequestMessage(message)) {
      // Not addressable to a request id, so there is nothing to answer.
      return
    }
    const request = message as RequestMessage
    let response: ResponseMessage
    try {
      const result = await this.dispatch(state, request)
      response = { type: 'res', id: request.id, ok: true, result }
    } catch (error) {
      const code = error instanceof RequestError ? error.code : ErrorCodes.internal
      const text = error instanceof Error ? error.message : String(error)
      response = { type: 'res', id: request.id, ok: false, error: { code, message: text } }
    }
    state.connection.send(response)
  }

  private async dispatch(state: ClientState, request: RequestMessage): Promise<MethodResult<MethodName>> {
    const params = request.params as Record<string, unknown>

    if (request.method === 'hello') {
      const negotiation = negotiate(params['protocolVersion'])
      if (!negotiation.ok) {
        throw new RequestError(
          ErrorCodes.protocolMismatch,
          `Client protocol ${String(params['protocolVersion'])} is ${negotiation.reason}; this daemon speaks ${PROTOCOL_VERSION}`
        )
      }
      state.handshaken = true
      state.name = typeof params['clientName'] === 'string' ? params['clientName'] : 'unknown'
      return { daemon: this.info() } satisfies MethodResult<'hello'>
    }

    if (!state.handshaken) {
      throw new RequestError(ErrorCodes.notHandshaken, 'Send `hello` before any other request')
    }

    switch (request.method) {
      case 'daemon.info':
        return this.info()

      case 'daemon.shutdown': {
        // Answer before tearing down, so the caller sees the ack rather than a reset.
        setTimeout(() => this.options.onShutdownRequested?.(), 0).unref()
        return { ok: true }
      }

      case 'session.create': {
        const options: Parameters<SessionManager['create']>[0] = {
          cols: requireSize(params, 'cols'),
          rows: requireSize(params, 'rows'),
          ...(typeof params['id'] === 'string' ? { id: params['id'] } : {}),
          ...(typeof params['command'] === 'string' ? { command: params['command'] } : {}),
          ...(Array.isArray(params['args'])
            ? { args: (params['args'] as unknown[]).map((arg) => String(arg)) }
            : {}),
          ...(typeof params['cwd'] === 'string' ? { cwd: params['cwd'] } : {}),
          ...(typeof params['env'] === 'object' && params['env'] !== null
            ? { env: params['env'] as Record<string, string> }
            : {})
        }
        let session
        try {
          session = this.sessions.create(options)
        } catch (error) {
          throw new RequestError(ErrorCodes.spawnFailed, error instanceof Error ? error.message : String(error))
        }
        // Creating a session implies interest in it; otherwise the creator has to race
        // its own first output.
        state.subscriptions.add(session.id)
        return { session: session.info() } satisfies MethodResult<'session.create'>
      }

      case 'session.list':
        return { sessions: this.sessions.list().map((session) => session.info()) }

      case 'session.get':
        return { session: this.requireSession(requireString(params, 'id')).info() }

      case 'session.write': {
        const session = this.requireSession(requireString(params, 'id'))
        if (!session.alive) throw new RequestError(ErrorCodes.sessionExited, `Session ${session.id} has exited`)
        // `data` may legitimately be empty — a client can flush nothing — so it is read
        // directly rather than through requireString, which rejects empty strings.
        const data = params['data']
        if (typeof data !== 'string') {
          throw new RequestError(ErrorCodes.badRequest, '`data` must be a string')
        }
        const encoding = params['encoding']
        if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
          throw new RequestError(ErrorCodes.badRequest, '`encoding` must be "utf8" or "base64"')
        }
        session.write(decodeWritePayload(data, encoding))
        return { ok: true }
      }

      case 'session.resize': {
        const session = this.requireSession(requireString(params, 'id'))
        session.resize(requireSize(params, 'cols'), requireSize(params, 'rows'))
        return { ok: true }
      }

      case 'session.kill': {
        const session = this.requireSession(requireString(params, 'id'))
        session.kill(typeof params['signal'] === 'string' ? params['signal'] : undefined)
        return { ok: true }
      }

      case 'session.snapshot': {
        const session = this.requireSession(requireString(params, 'id'))
        const selector = params['buffer'] === 'normal' ? 'normal' : 'active'
        // Settle first: term.write() is queued, so a snapshot taken without waiting can
        // miss output the client has already been told about.
        await session.settle()
        // How far back the pane is scrolled is session state, not a per-client view:
        // `pane.scroll` moved it, and every attached client sees the same history.
        const pane = this.runtime.paneForSession(session.id)
        return { id: session.id, snapshot: session.snapshot(selector, pane?.scrollOffset ?? 0) }
      }

      case 'session.subscribe': {
        const session = this.requireSession(requireString(params, 'id'))
        state.subscriptions.add(session.id)
        return { ok: true }
      }

      case 'session.unsubscribe': {
        state.subscriptions.delete(requireString(params, 'id'))
        return { ok: true }
      }

      case 'session.destroy': {
        const id = requireString(params, 'id')
        if (!this.sessions.remove(id)) throw new RequestError(ErrorCodes.sessionNotFound, `No session ${id}`)
        for (const client of this.clients) client.subscriptions.delete(id)
        return { ok: true }
      }

      // --- the session model ------------------------------------------------
      case 'state.get':
        return model.stateGet(this.modelContext())
      case 'config.get':
        return this.configResult()
      case 'workspace.create':
        return model.workspaceCreate(this.modelContext(), params)
      case 'workspace.close':
        return model.workspaceClose(this.modelContext(), params)
      case 'workspace.focus':
        return model.workspaceFocus(this.modelContext(), params)
      case 'workspace.rename':
        return model.workspaceRename(this.modelContext(), params)
      case 'workspace.move':
        return model.workspaceMove(this.modelContext(), params)
      case 'workspace.move_block':
        return model.workspaceMoveBlock(this.modelContext(), params)
      case 'tab.create':
        return model.tabCreate(this.modelContext(), params)
      case 'tab.close':
        return model.tabClose(this.modelContext(), params)
      case 'tab.focus':
        return model.tabFocus(this.modelContext(), params)
      case 'tab.rename':
        return model.tabRename(this.modelContext(), params)
      case 'tab.move':
        return model.tabMove(this.modelContext(), params)
      case 'pane.split':
        return model.paneSplit(this.modelContext(), params)
      case 'pane.close':
        return model.paneClose(this.modelContext(), params)
      case 'pane.focus':
        return model.paneFocus(this.modelContext(), params)
      case 'pane.focus_direction':
        return model.paneFocusDirection(this.modelContext(), params)
      case 'pane.resize':
        return model.paneResize(this.modelContext(), params)
      case 'pane.swap':
        return model.paneSwap(this.modelContext(), params)
      case 'pane.zoom':
        return model.paneZoom(this.modelContext(), params)
      case 'pane.rename':
        return model.paneRename(this.modelContext(), params)
      case 'pane.scroll':
        return model.paneScroll(this.modelContext(), params)
      case 'pane.input.set':
        return model.paneInputSet(this.modelContext(), params)
      case 'pane.link.activate':
        return model.paneLinkActivate(this.modelContext(), params)
      case 'pane.edit_scrollback':
        return model.paneEditScrollback(this.modelContext(), params)
      case 'pane.copy_motion':
        return model.paneCopyMotion(this.modelContext(), params)
      case 'pane.copy_search':
        return model.paneCopySearch(this.modelContext(), params)
      case 'pane.selection.read':
        return model.paneSelectionRead(this.modelContext(), params)
      case 'layout.set_split_ratio':
        return model.layoutSetSplitRatio(this.modelContext(), params)
      case 'server.reload_config':
        return this.reloadConfig(params)

      // --- agents (PHASE-5 Part A) ------------------------------------------
      case 'agent.report':
        return agents.agentReport(this.modelContext(), params)
      case 'agent.read':
        return agents.agentRead(this.modelContext(), params)
      case 'agent.explain':
        return agents.agentExplain(this.modelContext(), params)
      case 'agent.reload_manifests':
        return agents.agentReloadManifests(this.modelContext(), params)
      case 'config.set': {
        const result = agents.configSet(this.modelContext(), params)
        this.config = loadConfig(this.options.configPath === undefined ? {} : { path: this.options.configPath })
        this.broadcastAll({ type: 'event', event: 'config.changed', path: this.config.path })
        return { ...result, config: this.config.config }
      }
      case 'config.set_theme': {
        const result = agents.configSetTheme(this.modelContext(), params)
        // Re-read so every attached client sees the same config, and tell them.
        this.config = loadConfig(this.options.configPath === undefined ? {} : { path: this.options.configPath })
        this.broadcastAll({ type: 'event', event: 'config.changed', path: this.config.path })
        return { ...result, config: this.config.config }
      }

      // --- worktrees and integrations (PHASE-5 Part B) ----------------------
      case 'git.status':
        return gitRpc.gitStatus(this.gitContext(), params)
      case 'git.stage':
        return gitRpc.gitStage(this.gitContext(), params)
      case 'git.unstage':
        return gitRpc.gitUnstage(this.gitContext(), params)
      case 'git.discard':
        return gitRpc.gitDiscard(this.gitContext(), params)
      case 'git.commit':
        return gitRpc.gitCommit(this.gitContext(), params)
      case 'worktree.list':
        return worktrees.worktreeList(this.worktreeContext(), params)
      case 'worktree.create':
        return worktrees.worktreeCreate(this.worktreeContext(), params)
      case 'worktree.open':
        return worktrees.worktreeOpen(this.worktreeContext(), params)
      case 'worktree.remove':
        return worktrees.worktreeRemove(this.worktreeContext(), params)
      case 'integration.list':
        return worktrees.integrationList(this.worktreeContext())
      case 'integration.install':
        return worktrees.integrationInstall(this.worktreeContext(), params)

      default:
        throw new RequestError(ErrorCodes.unknownMethod, `Unknown method: ${String(request.method)}`)
    }
  }

  private modelContext(): model.ModelContext {
    return { runtime: this.runtime, sessions: this.sessions }
  }

  private worktreeContext(): worktrees.WorktreeContext {
    return { ...this.modelContext(), worktrees: this.worktreeService, integrations: this.integrationOptions() }
  }

  /**
   * Hooks live under the data root, not under `~/.config`.
   *
   * They are ours to rewrite on every version bump, and an executable script that a
   * user might reasonably edit does not belong in a directory they curate. Keeping
   * them beside the socket also means one `LEAP_CHORUS_DATA_DIR` isolates a test
   * completely.
   */
  private integrationOptions(): IntegrationOptions {
    return {
      hookDir: join(this.paths.dataRoot, 'integrations'),
      // An ephemeral daemon is a test's daemon. Its data root is a temp directory that
      // will be deleted, so registering a hook from it in the user's *real* agent
      // settings leaves a dangling path that breaks every later agent session with a
      // "no such file or directory" startup error. That is not hypothetical: a routing
      // test that called every method with empty params wrote seven such entries into
      // a real `~/.claude/settings.json`, and they had to be removed by hand.
      //
      // So an ephemeral daemon keeps its hooks entirely inside its own root.
      ...(this.options.ephemeral === true ? { home: this.paths.dataRoot } : {})
    }
  }

  private configResult() {
    return {
      path: this.config.path,
      config: this.config.config as unknown,
      problems: this.config.problems.map((problem) => ({ ...problem })),
      errors: [...this.config.errors]
    }
  }

  /**
   * Re-read the config file.
   *
   * Nothing is torn down. The config decides how new panes are spawned and how the
   * client draws, and neither is a reason to disturb a running terminal — so a reload
   * changes the daemon's defaults, tells every client, and leaves every pane exactly
   * where it was. `paneCount` is in the answer so a caller can assert that.
   */
  private reloadConfig(params: Record<string, unknown>) {
    const path = typeof params['path'] === 'string' ? params['path'] : this.options.configPath
    this.config = loadConfig(path === undefined ? {} : { path })
    // The *requested* path, not the loaded one: `loadConfig` reports null for a file
    // that does not exist, and "--config ./new.toml" still names where a write goes.
    this.runtime.setConfigPath(path ?? this.config.path)
    this.broadcastAll({ type: 'event', event: 'config.changed', path: this.config.path })
    return {
      ...this.configResult(),
      paneCount: this.runtime.state.panes.size
    }
  }

  private requireSession(id: string) {
    const session = this.sessions.get(id)
    if (!session) throw new RequestError(ErrorCodes.sessionNotFound, `No session ${id}`)
    return session
  }

  /** Tell every client the daemon is going away, then stop listening. */
  async close(reason = 'shutdown'): Promise<void> {
    if (this.closing) return
    this.closing = true

    for (const client of this.clients) {
      client.connection.send({ type: 'event', event: 'daemon.shutdown', reason })
      client.connection.close()
    }
    this.clients.clear()
    this.unsubscribeSessions?.()
    this.unsubscribeSessions = null
    // Write the model before the sessions go, so a restart finds the arrangement that
    // was on screen rather than one mid-teardown.
    this.runtime.dispose()
    this.sessions.disposeAll()

    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    try {
      if (existsSync(this.paths.socketPath)) unlinkSync(this.paths.socketPath)
    } catch {
      // A missing or already-replaced socket file is not a shutdown failure.
    }
    this.lock.release()
  }
}

/** Type-safe request builder, so clients and tests share one definition of a call. */
export function request<M extends MethodName>(id: number, method: M, params: MethodParams<M>): RequestMessage<M> {
  return { type: 'req', id, method, params }
}
