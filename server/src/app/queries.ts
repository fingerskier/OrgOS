import type { Sql } from '../infra/db.js'

export function makeQueries(sql: Sql) {
  return {
    async listActors() {
      return sql`SELECT actor_id, handle, display_name, kind, status, email, roles
                 FROM actor_state ORDER BY handle`
    },
    async listThreads() {
      return sql`SELECT thread_id, title, created_by, created_at FROM chat_thread ORDER BY created_at`
    },
    async getThread(threadId: string) {
      const messages = await sql`
        SELECT message_id, thread_id, author_id, body, posted_at, edited_at, deleted
        FROM chat_message WHERE thread_id = ${threadId} AND deleted = false
        ORDER BY posted_at`
      const head = await sql<{ v: string | null }[]>`
        SELECT max(stream_seq)::text AS v FROM event WHERE stream_id = ${threadId}`
      return { threadId, streamVersion: Number(head[0]?.v ?? 0), messages }
    },
    async eventsForSubject(subject: string, after: string) {
      return sql`SELECT seq::text, namespace, name, version, actor_id, subject_id, stream_id,
                 stream_seq::text, payload, occurred_at FROM event
                 WHERE subject_id = ${subject} AND seq > ${after} ORDER BY seq`
    },
  }
}
