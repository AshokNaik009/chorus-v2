import { isAbsolute, resolve } from 'node:path'
import { ErrorCodes, type AgentFileActivity } from '@leap-chorus/protocol'
import { RequestError, requireEnum, requireNumber, requireString, type Params } from './rpc/params.js'

export function parseAgentActivity(params: Params): AgentFileActivity | null {
  const value = params['activity']
  if (value === undefined) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(ErrorCodes.badRequest, 'activity must be an object')
  }
  const input = value as Params
  const kind = requireEnum(input, 'kind', ['read', 'write', 'refresh'] as const)
  const cwd = requireString(input, 'cwd')
  const path = kind === 'refresh' ? undefined : requireString(input, 'path')
  if (!isAbsolute(cwd) || [cwd, path ?? ''].some((part) => part.length > 4096 || part.includes('\0'))) {
    throw new RequestError(ErrorCodes.badRequest, 'activity paths must be bounded and cwd must be absolute')
  }
  return {
    paneId: requireString(params, 'paneId'),
    agent: requireString(params, 'agent'),
    seq: requireNumber(params, 'seq'),
    at: Date.now(), kind, cwd: resolve(cwd),
    ...(path === undefined ? {} : { path: resolve(cwd, path) })
  }
}
