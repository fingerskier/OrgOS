import type { Sql } from './db.js'
import { newId } from './uuid.js'
import { parseFqType } from '../domain/eventTypes.js'
import { loadSchemaCache } from './schemaCache.js'

export interface AppendInput {
  type: string
  actorId: string
  orgId: string
  subjectId: string | null
  streamId: string | null
  streamSeq: number | null
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export class ConcurrencyError extends Error {
  constructor(public currentVersion: string | null) { super('stream version conflict') }
}
export class ValidationError extends Error {}

export function makeAppender(sql: Sql) {
  let cache: Map<string, string> | null = null
  const typeId = async (fq: string): Promise<string> => {
    if (!cache) cache = await loadSchemaCache(sql)
    let id = cache.get(fq)
    if (!id) { cache = await loadSchemaCache(sql); id = cache.get(fq) }
    if (!id) throw new ValidationError(`unknown event_type ${fq}`)
    return id
  }
  return {
    async append(input: AppendInput): Promise<{ id: string; seq: string }> {
      const { namespace, name, version } = parseFqType(input.type)
      const etId = await typeId(input.type)
      const id = newId()
      try {
        const rows = await sql<{ id: string; seq: string }[]>`
          INSERT INTO event (id, event_type_id, namespace, name, version, actor_id, org_id,
                             subject_id, stream_id, stream_seq, payload, metadata)
          VALUES (${id}, ${etId}, ${namespace}, ${name}, ${version}, ${input.actorId}, ${input.orgId},
                  ${input.subjectId}, ${input.streamId}, ${input.streamSeq},
                  ${sql.json(input.payload as Parameters<typeof sql.json>[0])}, ${sql.json((input.metadata ?? {}) as Parameters<typeof sql.json>[0])})
          RETURNING id, seq::text`
        return rows[0]!
      } catch (err) {
        const e = err as { code?: string; message?: string }
        if (e.code === '23505') {
          // A stream_seq collision requires a stream. With a null streamId the
          // (stream_id, stream_seq) unique index cannot collide (NULL <> NULL),
          // so a 23505 here is some other constraint (e.g. a PK collision) —
          // propagate it rather than misdiagnosing it as a concurrency conflict.
          if (input.streamId == null) throw err
          const cur = await sql<{ v: string | null }[]>`
            SELECT max(stream_seq)::text AS v FROM event WHERE stream_id = ${input.streamId}`
          throw new ConcurrencyError(cur[0]?.v ?? null)
        }
        if (e.code === 'P0001') throw new ValidationError(e.message ?? 'payload validation failed')
        throw err
      }
    },
  }
}
