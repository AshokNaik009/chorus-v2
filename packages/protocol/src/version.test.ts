import { describe, expect, it } from 'vitest'
import {
  legacyAdapterFor,
  lockFileName,
  negotiate,
  PROTOCOL_VERSION,
  registerLegacyAdapter,
  socketFileName
} from './version.js'

describe('protocol version', () => {
  it('names the endpoint after the generation', () => {
    expect(socketFileName(1)).toBe('daemon-v1.sock')
    expect(socketFileName(7)).toBe('daemon-v7.sock')
    expect(lockFileName(1)).toBe('daemon-v1.lock')
    expect(socketFileName()).toBe(`daemon-v${PROTOCOL_VERSION}.sock`)
  })

  it('accepts its own generation with no adapter', () => {
    expect(negotiate(PROTOCOL_VERSION)).toEqual({ ok: true, adapter: null })
  })

  it('refuses a client from the future', () => {
    expect(negotiate(PROTOCOL_VERSION + 1)).toEqual({ ok: false, reason: 'too-new' })
  })

  it('refuses a malformed version', () => {
    expect(negotiate('1').ok).toBe(false)
    expect(negotiate(0).ok).toBe(false)
    expect(negotiate(1.5).ok).toBe(false)
    expect(negotiate(undefined).ok).toBe(false)
  })

  it('offers a registration hook for serving an older generation', () => {
    // Generation 1 has no older peers yet, so this asserts the hook exists and resolves,
    // not that any translation happens.
    const clientVersion = 99
    registerLegacyAdapter({
      clientVersion,
      adaptRequest: (message) => message,
      adaptOutbound: (message) => message
    })
    expect(legacyAdapterFor(clientVersion)?.clientVersion).toBe(clientVersion)
    expect(legacyAdapterFor(clientVersion - 1)).toBeUndefined()
  })
})
