import { describe, it, expect } from 'vitest'
import { foldChatThread, foldChatMessage } from '../../src/domain/folds/chat.js'
import type { StoredEvent } from '../../src/domain/events.js'

const ev = (over: Partial<StoredEvent>): StoredEvent => ({
  id: 'e', seq: '1', namespace: 'chat', name: 'message.posted', version: 1,
  actorId: 'a1', orgId: 'o1', subjectId: 'm1', streamId: 't1', streamSeq: '1',
  payload: {}, metadata: {}, occurredAt: '2026-01-01T00:00:00Z', recordedAt: '', ...over,
})

describe('foldChatThread', () => {
  it('creates a thread', () => {
    const t = foldChatThread(null, ev({ seq: '1', name: 'thread.created', subjectId: 't1', payload: { title: 'general' } }))
    expect(t).toMatchObject({ thread_id: 't1', title: 'general', created_by: 'a1', last_event_seq: '1' })
  })
})

describe('foldChatMessage', () => {
  it('posts a message', () => {
    const m = foldChatMessage(null, ev({ seq: '2', subjectId: 'm1', payload: { body: 'hi' } }))
    expect(m).toMatchObject({ message_id: 'm1', thread_id: 't1', author_id: 'a1', body: 'hi', deleted: false })
  })
  it('edits then deletes', () => {
    let m = foldChatMessage(null, ev({ seq: '2', payload: { body: 'hi' } }))
    m = foldChatMessage(m, ev({ seq: '3', name: 'message.edited', payload: { body: 'hello' } }))
    expect(m).toMatchObject({ body: 'hello' })
    expect(m!.edited_at).not.toBeNull()
    m = foldChatMessage(m, ev({ seq: '4', name: 'message.deleted', payload: {} }))
    expect(m!.deleted).toBe(true)
  })
  it('skips out-of-order (already applied) events', () => {
    let m = foldChatMessage(null, ev({ seq: '5', payload: { body: 'hi' } }))
    m = foldChatMessage(m, ev({ seq: '3', name: 'message.edited', payload: { body: 'stale' } }))
    expect(m!.body).toBe('hi')
  })
})
