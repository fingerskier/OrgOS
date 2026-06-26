import type { StoredEvent } from '../events.js'

export interface ChatThread {
  thread_id: string; title: string; created_by: string
  created_at: string; last_event_seq: string
}
export interface ChatMessage {
  message_id: string; thread_id: string; author_id: string; body: string
  posted_at: string; edited_at: string | null; deleted: boolean; last_event_seq: string
}

const seen = (last: string | undefined, e: StoredEvent): boolean =>
  last != null && BigInt(e.seq) <= BigInt(last)

export function foldChatThread(state: ChatThread | null, e: StoredEvent): ChatThread | null {
  if (seen(state?.last_event_seq, e)) return state
  if (e.name === 'thread.created') {
    return {
      thread_id: e.subjectId!, title: (e.payload as { title: string }).title,
      created_by: e.actorId, created_at: e.occurredAt, last_event_seq: e.seq,
    }
  }
  return state ? { ...state, last_event_seq: e.seq } : state
}

export function foldChatMessage(state: ChatMessage | null, e: StoredEvent): ChatMessage | null {
  if (seen(state?.last_event_seq, e)) return state
  if (e.name === 'message.posted') {
    return {
      message_id: e.subjectId!, thread_id: e.streamId!, author_id: e.actorId,
      body: (e.payload as { body: string }).body, posted_at: e.occurredAt,
      edited_at: null, deleted: false, last_event_seq: e.seq,
    }
  }
  if (state == null) return state
  if (e.name === 'message.edited') {
    return { ...state, body: (e.payload as { body: string }).body, edited_at: e.occurredAt, last_event_seq: e.seq }
  }
  if (e.name === 'message.deleted') {
    return { ...state, deleted: true, last_event_seq: e.seq }
  }
  return { ...state, last_event_seq: e.seq }
}
