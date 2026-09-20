/**
 * Attaching to the daemon.
 *
 * Thin on purpose: `ensureDaemon` and `DaemonClient` already exist and already define the
 * handshake. What this adds is the client's own vocabulary — pane-shaped calls rather than
 * session-shaped ones — and a single place that knows the client's name on the wire.
 */

import {
  DaemonClient,
  ensureDaemon,
  resolveDaemonPaths,
  type DaemonPaths
} from '@leap-chorus/daemon'
import { encodeWritePayload } from '@leap-chorus/protocol'
import type { DaemonInfo, EventMessage, SessionInfo, TerminalSnapshot } from '@leap-chorus/protocol'

export const CLIENT_NAME = 'leap-chorus-tui'

export interface AttachOptions {
  readonly dataRoot?: string
  readonly clientName?: string
  /** Fail instead of starting a daemon. Used where a caller manages the daemon itself. */
  readonly noSpawn?: boolean
}

export interface Attachment {
  readonly client: DaemonClient
  readonly daemon: DaemonInfo
  readonly paths: DaemonPaths
}

export async function attach(options: AttachOptions = {}): Promise<Attachment> {
  const paths = resolveDaemonPaths(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot })
  if (options.noSpawn !== true) await ensureDaemon({ paths })
  const { client, daemon } = await DaemonClient.connect({
    socketPath: paths.socketPath,
    clientName: options.clientName ?? CLIENT_NAME
  })
  return { client, daemon, paths }
}

/** A session as the TUI uses it: create, write, resize, snapshot. */
export class PaneSession {
  constructor(
    private readonly client: DaemonClient,
    readonly info: SessionInfo
  ) {}

  get id(): string {
    return this.info.id
  }

  static async create(
    client: DaemonClient,
    params: { cols: number; rows: number; command?: string; args?: readonly string[]; cwd?: string }
  ): Promise<PaneSession> {
    const { session } = await client.call('session.create', params)
    await client.call('session.subscribe', { id: session.id })
    return new PaneSession(client, session)
  }

  /**
   * Send bytes to the pane.
   *
   * Bytes, not a string: what a terminal hands us is not always valid UTF-8 (a legacy
   * X10 mouse report and a Latin-1 paste both carry high bytes), and decoding it to
   * re-encode it destroys exactly those cases. `encodeWritePayload` keeps the ASCII
   * common case at one byte on the wire.
   */
  write(bytes: Uint8Array): Promise<unknown> {
    return this.client.call('session.write', { id: this.id, ...encodeWritePayload(bytes) })
  }

  /** Send text. A convenience over `write` for callers that genuinely have a string. */
  writeText(text: string): Promise<unknown> {
    return this.write(Buffer.from(text, 'utf8'))
  }

  resize(cols: number, rows: number): Promise<unknown> {
    return this.client.call('session.resize', { id: this.id, cols, rows })
  }

  async snapshot(): Promise<TerminalSnapshot> {
    const { snapshot } = await this.client.call('session.snapshot', { id: this.id })
    return snapshot
  }

  kill(): Promise<unknown> {
    return this.client.call('session.kill', { id: this.id })
  }
}

export type { EventMessage }
