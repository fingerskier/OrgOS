import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender, ConcurrencyError, ValidationError } from '../../src/infra/appender.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-0000000000aa'
const ACT = '00000000-0000-7000-8000-0000000000bb'

beforeAll(async () => {
  ;({ sql, drop } = await freshSchema())
  // seed the two types this test uses. ON CONFLICT keeps this idempotent once
  // 005_seed.sql exists (freshSchema applies every migration, including the seed
  // that registers these same types) — without it the insert would 23505.
  await sql`INSERT INTO event_type (id, namespace, name, version, schema) VALUES
    (gen_random_uuid(), 'chat', 'thread.created', 1,
     '{"type":"object","properties":{"title":{"type":"string","minLength":1}},"required":["title"]}'::jsonb),
    (gen_random_uuid(), 'chat', 'message.posted', 1,
     '{"type":"object","properties":{"body":{"type":"string","minLength":1}},"required":["body"]}'::jsonb)
    ON CONFLICT (namespace, name, version) DO NOTHING`
})
afterAll(async () => { await drop() })

describe('appender', () => {
  it('appends a valid event and returns id+seq', async () => {
    const app = makeAppender(sql)
    const r = await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG,
      subjectId: '00000000-0000-7000-8000-0000000000c1', streamId: '00000000-0000-7000-8000-0000000000c1',
      streamSeq: 1, payload: { title: 'general' } })
    expect(r.id).toMatch(/-7[0-9a-f]{3}-/)
    expect(BigInt(r.seq)).toBeGreaterThan(0n)
  })
  it('rejects a schema-invalid payload (trigger) as ValidationError', async () => {
    const app = makeAppender(sql)
    await expect(app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: '00000000-0000-7000-8000-0000000000c2', streamId: '00000000-0000-7000-8000-0000000000c2',
      streamSeq: 1, payload: { body: '' } })).rejects.toBeInstanceOf(ValidationError)
  })
  it('rejects a colliding stream_seq as ConcurrencyError', async () => {
    const app = makeAppender(sql)
    const stream = '00000000-0000-7000-8000-0000000000c3'
    await app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: stream, streamId: stream, streamSeq: 1, payload: { body: 'a' } })
    await expect(app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: stream, streamId: stream, streamSeq: 1, payload: { body: 'b' } }))
      .rejects.toBeInstanceOf(ConcurrencyError)
  })
})
