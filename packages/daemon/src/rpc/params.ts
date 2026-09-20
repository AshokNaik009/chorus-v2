/**
 * Reading untrusted params.
 *
 * Every handler goes through these rather than casting, because the socket is a trust
 * boundary even when the only thing on the other side is our own client: a client one
 * version ahead, or a script poking at the endpoint, must get an error naming the field
 * rather than an exception naming a line number.
 */

import { ErrorCodes } from '@leap-chorus/protocol'

export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RequestError'
  }
}

export type Params = Record<string, unknown>

export function badRequest(message: string): RequestError {
  return new RequestError(ErrorCodes.badRequest, message)
}

export function requireString(params: Params, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`\`${key}\` must be a non-empty string`)
  }
  return value
}

export function optionalString(params: Params, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw badRequest(`\`${key}\` must be a string`)
  return value
}

export function optionalBoolean(params: Params, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw badRequest(`\`${key}\` must be true or false`)
  return value
}

export function requireNumber(params: Params, key: string): number {
  const value = params[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw badRequest(`\`${key}\` must be a number`)
  }
  return value
}

export function optionalNumber(params: Params, key: string): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`\`${key}\` must be a number`)
  return value
}

export function requireIndex(params: Params, key: string): number {
  const value = requireNumber(params, key)
  if (value < 0) throw badRequest(`\`${key}\` must not be negative`)
  return Math.floor(value)
}

export function requireEnum<T extends string>(params: Params, key: string, allowed: readonly T[]): T {
  const value = params[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw badRequest(`\`${key}\` must be one of ${allowed.join(', ')}`)
  }
  return value as T
}

export function optionalEnum<T extends string>(
  params: Params,
  key: string,
  allowed: readonly T[]
): T | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  return requireEnum(params, key, allowed)
}

export function optionalStringArray(params: Params, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw badRequest(`\`${key}\` must be an array of strings`)
  return value.map((entry) => String(entry))
}

export function requireStringArray(params: Params, key: string): string[] {
  const value = optionalStringArray(params, key)
  if (value === undefined) throw badRequest(`\`${key}\` is required`)
  return value
}

export function optionalEnv(params: Params, key: string): Record<string, string> | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest(`\`${key}\` must be a table`)
  const out: Record<string, string> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) out[name] = String(entry)
  return out
}

/** A layout path: an array of booleans naming which child to take at each split. */
export function requireBooleanPath(params: Params, key: string): boolean[] {
  const value = params[key]
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'boolean')) {
    throw badRequest(`\`${key}\` must be an array of booleans`)
  }
  return value as boolean[]
}

export interface Point {
  readonly row: number
  readonly col: number
}

export function requirePoint(params: Params, key: string): Point {
  const value = params[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw badRequest(`\`${key}\` must be a { row, col } table`)
  }
  const point = value as Record<string, unknown>
  if (typeof point['row'] !== 'number' || typeof point['col'] !== 'number') {
    throw badRequest(`\`${key}\` must have numeric \`row\` and \`col\``)
  }
  return { row: Math.max(0, Math.floor(point['row'])), col: Math.max(0, Math.floor(point['col'])) }
}

export function optionalRange(params: Params, key: string): { start: Point; end: Point } | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest(`\`${key}\` must be a range`)
  const range = value as Params
  return { start: requirePoint(range, 'start'), end: requirePoint(range, 'end') }
}

export interface Viewport {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** A client's content area, for the three methods whose answer depends on geometry. */
export function optionalViewport(params: Params, key = 'viewport'): Viewport | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw badRequest(`\`${key}\` must be a table`)
  const viewport = value as Record<string, unknown>
  const cols = viewport['cols']
  const rows = viewport['rows']
  if (typeof cols !== 'number' || typeof rows !== 'number' || cols < 1 || rows < 1) {
    throw badRequest(`\`${key}\` must have positive \`cols\` and \`rows\``)
  }
  return { x: 0, y: 0, width: Math.floor(cols), height: Math.floor(rows) }
}
