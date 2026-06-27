import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, validatePayload, parseFqType } from '../../src/domain/eventTypes.js'

describe('event type registry', () => {
  it('lists all beta types', () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual([
      'chat.message.deleted@1', 'chat.message.edited@1', 'chat.message.posted@1',
      'chat.thread.created@1', 'identity.actor.registered@1',
      'identity.role.granted@1', 'identity.role.revoked@1',
    ])
  })
  it('parses a fully-qualified type', () => {
    expect(parseFqType('chat.message.posted@1')).toEqual({
      namespace: 'chat', name: 'message.posted', version: 1 })
  })
  it('accepts a valid chat.message.posted payload', () => {
    expect(validatePayload('chat.message.posted@1', { body: 'hi' })).toEqual({ ok: true })
  })
  it('rejects a chat.message.posted payload missing body', () => {
    const r = validatePayload('chat.message.posted@1', {})
    expect(r.ok).toBe(false)
  })
  it('rejects an unknown type', () => {
    const r = validatePayload('nope.no.no@1', {})
    expect(r.ok).toBe(false)
  })
})
