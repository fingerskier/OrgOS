import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender } from '../../src/infra/appender.js'
import { makeProjector, identityProjection, chatProjection } from '../../src/infra/projector.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-00000000c0de'
const ACT = '00000000-0000-7000-8000-0000000000bb'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(fileURLToPath(new URL('../../migrations/005_seed.sql', import.meta.url)))
})
afterEach(async () => { await drop() })

describe('projector', () => {
  it('materializes a chat thread + message after tick()', async () => {
    const app = makeAppender(sql)
    const thread = '00000000-0000-7000-8000-0000000000d1'
    const msg = '00000000-0000-7000-8000-0000000000d2'
    await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG, subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 'general' } })
    await app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG, subjectId: msg, streamId: thread, streamSeq: 2, payload: { body: 'hi' } })

    const proj = makeProjector(sql, [chatProjection])
    await proj.tick()

    const threads = await sql`SELECT * FROM chat_thread`
    const msgs = await sql`SELECT * FROM chat_message`
    expect(threads).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ body: 'hi', thread_id: thread })
    const cp = await sql`SELECT last_event_seq FROM projection_checkpoint WHERE name='chat'`
    expect(BigInt(cp[0].last_event_seq)).toBeGreaterThan(0n)
  })

  it('rebuild from zero reproduces identical state', async () => {
    const app = makeAppender(sql)
    const thread = '00000000-0000-7000-8000-0000000000e1'
    await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG, subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 't' } })
    const proj = makeProjector(sql, [chatProjection])
    await proj.tick()
    await sql`TRUNCATE chat_thread, chat_message`
    await sql`UPDATE projection_checkpoint SET last_event_seq = 0 WHERE name='chat'`
    await proj.tick()
    const threads = await sql`SELECT * FROM chat_thread`
    expect(threads).toHaveLength(1)
  })

  it('identity projection registers an actor', async () => {
    const app = makeAppender(sql)
    const a = '00000000-0000-7000-8000-0000000000f1'
    await app.append({ type: 'identity.actor.registered@1', actorId: a, orgId: ORG, subjectId: a, streamId: a, streamSeq: 1, payload: { handle: 'matt', display_name: 'Matt', kind: 'human', email: 'm@x.io' } })
    const proj = makeProjector(sql, [identityProjection])
    await proj.tick()
    const rows = await sql`SELECT * FROM actor_state WHERE email='m@x.io'`
    expect(rows[0]).toMatchObject({ handle: 'matt' })
  })
})
