import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { buildApp } from '../../src/server.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>, close: () => Promise<void>, app: any
const SECRET = 'test-secret-test-secret-test-secret'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(fileURLToPath(new URL('../../migrations/005_seed.sql', import.meta.url)))
  ;({ app, close } = await buildApp({
    port: 0, webOrigin: 'http://localhost:5173', databaseUrl: '', sessionSecret: SECRET,
    magicLinkTtlSeconds: 900, isDev: true,
  }, { sql }))   // buildApp accepts an injected sql for tests
})
afterEach(async () => { await close(); await drop() })

describe('REST', () => {
  it('rejects POST /events without a session (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/events', payload: {
      type: 'chat.thread.created@1', subjectId: 'x', streamId: 'x', streamSeq: 1, payload: { title: 't' } } })
    expect(res.statusCode).toBe(401)
  })
  it('rejects unauthenticated reads (401) on events + projection routes', async () => {
    for (const url of ['/events?subject=x', '/projections/actors', '/projections/threads', '/projections/chat?thread=x']) {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(401)
    }
  })
  it('full login → create thread → post message → read projection', async () => {
    // request magic link
    const r1 = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'matt@x.io' } })
    const link = r1.json().devLink as string
    const token = new URL(link).searchParams.get('token')!
    // callback sets cookie
    const r2 = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    expect(r2.statusCode).toBe(302)
    const cookie = r2.cookies.find((c: any) => c.name === 'sid')!
    const cookieHeader = `sid=${cookie.value}`

    // who am I
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieHeader } })
    expect(me.json().actor.email).toBe('matt@x.io')

    // create a thread
    const thread = '00000000-0000-7000-8000-0000000000d1'
    const tc = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.thread.created@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 'general' } } })
    expect(tc.statusCode).toBe(201)

    // post a message
    const msg = '00000000-0000-7000-8000-0000000000d2'
    const pm = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.message.posted@1', subjectId: msg, streamId: thread, streamSeq: 2, payload: { body: 'hi' } } })
    expect(pm.statusCode).toBe(201)

    // read the projection
    const proj = await app.inject({ method: 'GET', url: `/projections/chat?thread=${thread}`, headers: { cookie: cookieHeader } })
    const body = proj.json()
    expect(body.streamVersion).toBe(2)
    expect(body.messages[0].body).toBe('hi')
  })
  it('returns 409 on a colliding stream_seq', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'm@x.io' } })
    const token = new URL(r1.json().devLink).searchParams.get('token')!
    const r2 = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    const cookieHeader = `sid=${r2.cookies.find((c: any) => c.name === 'sid')!.value}`
    const thread = '00000000-0000-7000-8000-0000000000e9'
    await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.thread.created@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 't' } } })
    const dup = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.message.posted@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { body: 'x' } } })
    expect(dup.statusCode).toBe(409)
  })
})
