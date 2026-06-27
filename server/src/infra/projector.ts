import postgres from 'postgres'
import type { Sql } from './db.js'
import type { StoredEvent } from '../domain/events.js'
import { foldIdentity, type ActorState } from '../domain/folds/identity.js'
import { foldChatThread, foldChatMessage } from '../domain/folds/chat.js'

export function rowToEvent(r: any): StoredEvent {
  return {
    id: r.id, seq: String(r.seq), namespace: r.namespace, name: r.name, version: r.version,
    actorId: r.actor_id, orgId: r.org_id, subjectId: r.subject_id, streamId: r.stream_id,
    streamSeq: r.stream_seq == null ? null : String(r.stream_seq),
    payload: r.payload, metadata: r.metadata,
    occurredAt: new Date(r.occurred_at).toISOString(),
    recordedAt: new Date(r.recorded_at).toISOString(),
  }
}

export interface Projection {
  name: string
  /** namespaces this projection consumes (filter for catch-up) */
  namespaces: string[]
  handle(sql: Sql, e: StoredEvent): Promise<void>
}

export const identityProjection: Projection = {
  name: 'identity',
  namespaces: ['identity'],
  async handle(sql, e) {
    const cur = await sql<any[]>`SELECT * FROM actor_state WHERE actor_id = ${e.subjectId}`
    const prev: ActorState | null = cur[0]
      ? { actor_id: cur[0].actor_id, handle: cur[0].handle, display_name: cur[0].display_name,
          kind: cur[0].kind, status: cur[0].status, email: cur[0].email,
          roles: cur[0].roles, last_event_seq: String(cur[0].last_event_seq) }
      : null
    const next = foldIdentity(prev, e)
    if (!next || next === prev) return
    await sql`INSERT INTO actor_state
      (actor_id, handle, display_name, kind, status, email, roles, last_event_seq)
      VALUES (${next.actor_id}, ${next.handle}, ${next.display_name}, ${next.kind},
              ${next.status}, ${next.email}, ${next.roles}, ${next.last_event_seq})
      ON CONFLICT (actor_id) DO UPDATE SET
        handle = EXCLUDED.handle, display_name = EXCLUDED.display_name, kind = EXCLUDED.kind,
        status = EXCLUDED.status, email = EXCLUDED.email, roles = EXCLUDED.roles,
        last_event_seq = EXCLUDED.last_event_seq`
  },
}

export const chatProjection: Projection = {
  name: 'chat',
  namespaces: ['chat'],
  async handle(sql, e) {
    if (e.name === 'thread.created') {
      const next = foldChatThread(null, e)!
      await sql`INSERT INTO chat_thread (thread_id, title, created_by, created_at, last_event_seq)
        VALUES (${next.thread_id}, ${next.title}, ${next.created_by}, ${next.created_at}, ${next.last_event_seq})
        ON CONFLICT (thread_id) DO UPDATE SET last_event_seq = EXCLUDED.last_event_seq`
      return
    }
    // message.*  — subject_id is the message id
    const cur = await sql<any[]>`SELECT * FROM chat_message WHERE message_id = ${e.subjectId}`
    const prev = cur[0]
      ? { message_id: cur[0].message_id, thread_id: cur[0].thread_id, author_id: cur[0].author_id,
          body: cur[0].body, posted_at: new Date(cur[0].posted_at).toISOString(),
          edited_at: cur[0].edited_at ? new Date(cur[0].edited_at).toISOString() : null,
          deleted: cur[0].deleted, last_event_seq: String(cur[0].last_event_seq) }
      : null
    const next = foldChatMessage(prev, e)
    if (!next || next === prev) return
    await sql`INSERT INTO chat_message
      (message_id, thread_id, author_id, body, posted_at, edited_at, deleted, last_event_seq)
      VALUES (${next.message_id}, ${next.thread_id}, ${next.author_id}, ${next.body},
              ${next.posted_at}, ${next.edited_at}, ${next.deleted}, ${next.last_event_seq})
      ON CONFLICT (message_id) DO UPDATE SET
        body = EXCLUDED.body, edited_at = EXCLUDED.edited_at, deleted = EXCLUDED.deleted,
        last_event_seq = EXCLUDED.last_event_seq`
  },
}

const BATCH = 1000

export function makeProjector(sql: Sql, projections: Projection[]) {
  let listener: postgres.ListenMeta | null = null
  let ticking = false
  let pending = false

  async function tickOne(p: Projection): Promise<void> {
    for (;;) {
      const cp = await sql<{ last_event_seq: string }[]>`
        SELECT last_event_seq::text FROM projection_checkpoint WHERE name = ${p.name}`
      const from = cp[0]?.last_event_seq ?? '0'
      const rows = await sql<any[]>`
        SELECT * FROM event
        WHERE seq > ${from} AND namespace = ANY(${p.namespaces})
        ORDER BY seq LIMIT ${BATCH}`
      // advance checkpoint to the max seq we have *examined*, even if filtered,
      // by tracking the largest seq in a separate unfiltered probe:
      if (rows.length === 0) {
        const head = await sql<{ seq: string }[]>`SELECT max(seq)::text AS seq FROM event WHERE seq > ${from}`
        const maxSeq = head[0]?.seq
        if (maxSeq) {
          await sql`UPDATE projection_checkpoint SET last_event_seq = ${maxSeq}, updated_at = now() WHERE name = ${p.name}`
          continue
        }
        return
      }
      await sql.begin(async (tx) => {
        let last = from
        for (const r of rows) { await p.handle(tx as unknown as Sql, rowToEvent(r)); last = String(r.seq) }
        await tx`UPDATE projection_checkpoint SET last_event_seq = ${last}, updated_at = now() WHERE name = ${p.name}`
      })
      if (rows.length < BATCH) return
    }
  }

  async function tick(): Promise<void> {
    if (ticking) { pending = true; return }
    ticking = true
    try {
      do { pending = false; for (const p of projections) await tickOne(p) } while (pending)
    } finally { ticking = false }
  }

  return {
    tick,
    async start() {
      await tick()
      listener = await sql.listen('events', () => { void tick() })
    },
    async stop() { if (listener) await listener.unlisten() },
  }
}
