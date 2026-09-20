/**
 * Protocol versioning and socket naming.
 *
 * The protocol version is carried *in the socket file name*, not only in the
 * handshake. That is what lets a new daemon bind a new socket while an old daemon
 * keeps serving old clients from its own: two generations coexist on one data root.
 *
 * Derived from orca's daemon endpoint scheme (MIT, Lovecast Inc. 2026):
 * `<data-root>/daemon/daemon-v<N>.sock`.
 */

/** Wire version of this build. herdr (Rust) is at 22; this is a new protocol, so it starts at 1. */
export const PROTOCOL_VERSION = 1

/**
 * Oldest client version this daemon will serve directly. Anything between this and
 * PROTOCOL_VERSION must either be wire-identical or routed through a legacy adapter.
 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1

/** Socket file name for a protocol generation. */
export function socketFileName(protocolVersion: number = PROTOCOL_VERSION): string {
  return `daemon-v${protocolVersion}.sock`
}

/** Lock file name for a protocol generation. One live daemon per generation per data root. */
export function lockFileName(protocolVersion: number = PROTOCOL_VERSION): string {
  return `daemon-v${protocolVersion}.lock`
}

/**
 * A hook for serving an older client generation from a newer daemon. Nothing implements
 * one yet — generation 1 is the only generation — but the negotiation path is written to
 * consult the table so adding one later does not mean rewriting the handshake.
 */
export interface LegacyAdapter {
  /** Client protocol version this adapter serves. */
  readonly clientVersion: number
  /** Translate an inbound client message into a current-generation message. */
  adaptRequest(message: unknown): unknown
  /** Translate an outbound current-generation message into what the old client expects. */
  adaptOutbound(message: unknown): unknown
}

const legacyAdapters = new Map<number, LegacyAdapter>()

export function registerLegacyAdapter(adapter: LegacyAdapter): void {
  legacyAdapters.set(adapter.clientVersion, adapter)
}

export function legacyAdapterFor(clientVersion: number): LegacyAdapter | undefined {
  return legacyAdapters.get(clientVersion)
}

export type Negotiation =
  | { readonly ok: true; readonly adapter: LegacyAdapter | null }
  | { readonly ok: false; readonly reason: 'too-old' | 'too-new' | 'malformed' }

/** Decide whether this daemon can serve a client claiming `clientVersion`. */
export function negotiate(clientVersion: unknown): Negotiation {
  if (typeof clientVersion !== 'number' || !Number.isInteger(clientVersion) || clientVersion < 1) {
    return { ok: false, reason: 'malformed' }
  }
  if (clientVersion === PROTOCOL_VERSION) {
    return { ok: true, adapter: null }
  }
  if (clientVersion > PROTOCOL_VERSION) {
    return { ok: false, reason: 'too-new' }
  }
  const adapter = legacyAdapterFor(clientVersion)
  if (adapter) {
    return { ok: true, adapter }
  }
  if (clientVersion >= MIN_SUPPORTED_PROTOCOL_VERSION) {
    // In range and wire-identical: no translation needed.
    return { ok: true, adapter: null }
  }
  return { ok: false, reason: 'too-old' }
}
