/**
 * A typed RPC client for the daemon endpoint.
 *
 * It lives beside the daemon rather than in `protocol` because it is a *use* of the
 * wire format, not part of it. The TUI client and the tests share it so there is exactly
 * one definition of the handshake sequence.
 */

import { connect, type Socket } from 'node:net'
import {
  FramedConnection,
  PROTOCOL_VERSION,
  isEventMessage,
  isResponseMessage,
  type DaemonInfo,
  type EventMessage,
  type MethodName,
  type MethodParams,
  type MethodResult
} from '@leap-chorus/protocol'

export class DaemonRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'DaemonRequestError'
  }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

export interface ConnectOptions {
  readonly socketPath: string
  readonly clientName?: string
  readonly connectTimeoutMs?: number
}

export class DaemonClient {
  private readonly pending = new Map<number, Pending>()
  private readonly eventListeners = new Set<(event: EventMessage) => void>()
  private nextId = 1
  private connection!: FramedConnection
  private closedError: Error | null = null

  private constructor(socket: Socket) {
    this.connection = new FramedConnection(socket, {
      onMessage: (message) => this.receive(message),
      onClose: () => this.failAllPending(new Error('daemon connection closed'))
    })
  }

  /** Open a connection and complete the handshake. */
  static async connect(options: ConnectOptions): Promise<{ client: DaemonClient; daemon: DaemonInfo }> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(options.socketPath)
      const timeout = setTimeout(() => {
        s.destroy()
        reject(new Error(`Timed out connecting to ${options.socketPath}`))
      }, options.connectTimeoutMs ?? 5_000)
      timeout.unref()
      s.once('connect', () => {
        clearTimeout(timeout)
        s.off('error', onError)
        resolve(s)
      })
      const onError = (error: Error): void => {
        clearTimeout(timeout)
        reject(error)
      }
      s.once('error', onError)
    })

    const client = new DaemonClient(socket)
    const hello = await client.call('hello', {
      protocolVersion: PROTOCOL_VERSION,
      clientName: options.clientName ?? 'leap-chorus-client'
    })
    return { client, daemon: hello.daemon }
  }

  private receive(message: unknown): void {
    if (isResponseMessage(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        pending.reject(new DaemonRequestError(message.error.code, message.error.message))
      }
      return
    }
    if (isEventMessage(message)) {
      for (const listener of this.eventListeners) listener(message)
    }
  }

  private failAllPending(error: Error): void {
    this.closedError = error
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }

  call<M extends MethodName>(method: M, params: MethodParams<M>): Promise<MethodResult<M>> {
    if (this.closedError) return Promise.reject(this.closedError)
    const id = this.nextId++
    return new Promise<MethodResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
      this.connection.send({ type: 'req', id, method, params })
    })
  }

  /** Bytes the daemon has sent this client. Used by the render benchmark. */
  get bytesReceived(): number {
    return this.connection.bytesReceived
  }

  /** Bytes this client has sent the daemon. */
  get bytesSent(): number {
    return this.connection.bytesSent
  }

  onEvent(listener: (event: EventMessage) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Resolve when a matching event arrives, or reject on timeout. */
  waitForEvent(predicate: (event: EventMessage) => boolean, timeoutMs = 10_000): Promise<EventMessage> {
    return new Promise<EventMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error('Timed out waiting for event'))
      }, timeoutMs)
      const off = this.onEvent((event) => {
        if (!predicate(event)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  }

  close(): void {
    this.failAllPending(new Error('client closed'))
    this.connection.close()
  }
}
