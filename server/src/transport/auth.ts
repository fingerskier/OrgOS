import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Sql } from '../infra/db.js'
import type { Mailer } from '../infra/mailer.js'

interface AuthDeps {
  identity: { resolveActor(c: { email: string; name?: string }): Promise<{ actorId: string; handle: string }> }
  loginTokens: { issue(email: string): Promise<string>; consume(token: string): Promise<string | null> }
  mailer: Mailer
  sql: Sql
  cfg: Config
  sessionCookie: string
}

const cookieOpts = (cfg: Config) => ({
  signed: true, httpOnly: true, sameSite: 'lax' as const, path: '/', secure: !cfg.isDev,
})

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { cfg, sessionCookie: SID } = deps

  app.post('/auth/request', async (req, reply) => {
    const email = String((req.body as { email?: string }).email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'invalid email' })
    const token = await deps.loginTokens.issue(email)
    const link = `${cfg.webOrigin}/auth/callback?token=${encodeURIComponent(token)}`
    await deps.mailer.sendMagicLink(email, link)
    return reply.code(200).send(cfg.isDev ? { ok: true, devLink: link } : { ok: true })
  })

  app.get('/auth/callback', async (req, reply) => {
    const token = (req.query as { token?: string }).token
    if (!token) return reply.code(400).send({ error: 'missing token' })
    const email = await deps.loginTokens.consume(token)
    if (!email) return reply.code(400).send({ error: 'invalid or expired link' })
    const actor = await deps.identity.resolveActor({ email })
    reply.setCookie(SID, actor.actorId, cookieOpts(cfg))
    return reply.code(302).redirect(cfg.webOrigin)
  })

  app.get('/auth/me', async (req, reply) => {
    const actor = await currentActor(app, deps.sql, req, SID)
    if (!actor) return reply.code(401).send({ error: 'not signed in' })
    return { actor }
  })

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SID, { path: '/' })
    return { ok: true }
  })
}

export async function currentActor(app: FastifyInstance, sql: Sql, req: FastifyRequest, SID: string) {
  const raw = req.cookies[SID]
  if (!raw) return null
  const u = app.unsignCookie(raw)
  if (!u.valid || !u.value) return null
  const rows = await sql<any[]>`SELECT actor_id, handle, display_name, kind, status, email, roles
    FROM actor_state WHERE actor_id = ${u.value}`
  return rows[0] ?? null
}
