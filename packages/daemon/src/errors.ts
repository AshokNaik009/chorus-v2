/**
 * Named startup failures.
 *
 * Every refusal the daemon can make before it serves a request has a stable code, so a
 * client (and a test) can distinguish "someone else owns this root" from "this root is
 * broken" without string matching. Code names follow orca's orcad lock vocabulary.
 */

export const DaemonErrorCodes = {
  /** The data root exists but belongs to another uid. */
  dataRootWrongOwner: 'leap_chorus_data_root_wrong_owner',
  /** The data root cannot be created, stat'd, or written. */
  dataRootUnusable: 'leap_chorus_data_root_unusable',
  /** Another live daemon owns this root at this protocol generation. */
  instanceLockHeld: 'leap_chorus_instance_lock_held',
  /** The lock record belongs to a different identity and is never reclaimed. */
  instanceLockForeignIdentity: 'leap_chorus_instance_lock_foreign_identity',
  /** The lock file itself could not be created or read. */
  instanceLockUnusable: 'leap_chorus_instance_lock_unusable',
  /** The endpoint path would not fit in `sun_path`. */
  socketPathTooLong: 'leap_chorus_socket_path_too_long',
  /** bind(2) failed for a reason other than path length. */
  socketBindFailed: 'leap_chorus_socket_bind_failed'
} as const

export type DaemonErrorCode = (typeof DaemonErrorCodes)[keyof typeof DaemonErrorCodes]

export class DaemonError extends Error {
  constructor(
    readonly code: DaemonErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options as ErrorOptions)
    this.name = 'DaemonError'
  }
}

export function isDaemonError(value: unknown): value is DaemonError {
  return value instanceof DaemonError
}

export function errnoOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    const code = (value as { code: unknown }).code
    if (typeof code === 'string') return code
  }
  return undefined
}
