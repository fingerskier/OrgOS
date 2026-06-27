import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { buildApp } from '../../src/server.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>, close: () => Promise<void>, app: any
const SECRET = 'unit-secret-unit-secret-unit-secret'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(fileURLToPath(new URL('../../migrations/005_seed.sql', import.meta.url)))
  ;({ app, close } = await buildApp({ port: 0, webOrigin: 'http://localhost:5173', databaseUrl: '',
    sessionSecret: SECRET, magicLinkTtlSeconds: 900, isDev: true }, { sql }))
})
afterEach(async () => { await close(); await drop() })

describe('magic-link auth', () => {
  it('request returns a dev link; callback logs in and registers the actor', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'New@X.io' } })
    expect(req.statusCode).toBe(200)
    expect(req.json().ok).toBe(true)
    const token = new URL(req.json().devLink).searchParams.get('token')!

    const cb = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    expect(cb.statusCode).toBe(302)
    expect(cb.headers.location).toBe('http://localhost:5173')

    const rows = await sql`SELECT * FROM actor_state WHERE email='new@x.io'`  // normalized lowercase
    expect(rows).toHaveLength(1)
  })
  it('request never enumerates (always 200) and a bad token is 400', async () => {
    const ok = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'x@y.io' } })
    expect(ok.statusCode).toBe(200)
    const bad = await app.inject({ method: 'GET', url: '/auth/callback?token=nope' })
    expect(bad.statusCode).toBe(400)
  })
  it('me is 401 without a cookie', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(me.statusCode).toBe(401)
  })
  it('me returns the actor with a valid signed cookie, and 401 if it is tampered', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'sess@x.io' } })
    const token = new URL(req.json().devLink).searchParams.get('token')!
    const cb = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    const sid = (cb.cookies as Array<{ name: string; value: string }>).find((c) => c.name === 'sid')!
    expect(sid.value).toBeTruthy()

    const ok = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sid: sid.value } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().actor.email).toBe('sess@x.io')

    // corrupting the signature must reject — the cookie is the only credential
    const bad = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sid: `${sid.value}x` } })
    expect(bad.statusCode).toBe(401)
  })
  it('me is 401 for a validly-signed cookie whose actor does not exist', async () => {
    // a correctly-signed sid carrying an actor_id with no actor_state row must
    // not authenticate — unsignSid succeeds but the lookup misses
    const signed = app.signCookie('00000000-0000-7000-8000-0000deadbeef')
    const res = await app.inject({ method: 'GET', url: '/auth/me', cookies: { sid: signed } })
    expect(res.statusCode).toBe(401)
  })
})
