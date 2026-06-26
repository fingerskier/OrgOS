import { describe, it, expect } from 'vitest'
import { foldIdentity, type ActorState } from '../../src/domain/folds/identity.js'
import type { StoredEvent } from '../../src/domain/events.js'

const ev = (over: Partial<StoredEvent>): StoredEvent => ({
  id: 'e', seq: '1', namespace: 'identity', name: 'actor.registered', version: 1,
  actorId: 'a1', orgId: 'o1', subjectId: 'a1', streamId: 'a1', streamSeq: '1',
  payload: {}, metadata: {}, occurredAt: '', recordedAt: '', ...over,
})

describe('foldIdentity', () => {
  it('registers an actor', () => {
    const s = foldIdentity(null, ev({
      seq: '5', subjectId: 'a1',
      payload: { handle: 'matt', display_name: 'Matt', kind: 'human', email: 'm@x.io' },
    }))
    expect(s).toMatchObject({ actor_id: 'a1', handle: 'matt', email: 'm@x.io', roles: [], last_event_seq: '5' })
  })
  it('grants then revokes a role', () => {
    let s = foldIdentity(null, ev({ seq: '1', payload: { handle: 'm', display_name: 'M', kind: 'human', email: 'm@x.io' } }))
    s = foldIdentity(s, ev({ seq: '2', name: 'role.granted', payload: { role: 'admin' } }))
    expect(s!.roles).toEqual(['admin'])
    s = foldIdentity(s, ev({ seq: '3', name: 'role.revoked', payload: { role: 'admin' } }))
    expect(s!.roles).toEqual([])
  })
  it('is idempotent: skips already-applied seq', () => {
    let s = foldIdentity(null, ev({ seq: '5', payload: { handle: 'm', display_name: 'M', kind: 'human', email: 'm@x.io' } }))
    const again = foldIdentity(s, ev({ seq: '5', name: 'role.granted', payload: { role: 'admin' } }))
    expect(again!.roles).toEqual([])
    expect(again!.last_event_seq).toEqual('5')
  })
})
