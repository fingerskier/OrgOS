import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { makeDb, type Sql } from './infra/db.js'
import { makeAppender } from './infra/appender.js'
import { makeProjector, identityProjection, chatProjection } from './infra/projector.js'
import { makeQueries } from './app/queries.js'
import { makeCommands } from './app/commands.js'
import { makeIdentity } from './app/identity.js'
import { makeLoginTokens } from './infra/loginTokens.js'
import { ConsoleMailer } from './infra/mailer.js'
import { makeSseHub } from './transport/sse.js'
import { registerRest } from './transport/rest.js'
import { registerAuth } from './transport/auth.js'
import type { ActorCtx } from './app/authz.js'

const ORG_ID = '00000000-0000-7000-8000-00000000c0de'
const SID = 'sid'

export async function buildApp(cfg: Config, inject?: { sql?: Sql }):
  Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const sql = inject?.sql ?? makeDb(cfg.databaseUrl)

  const appender = makeAppender(sql)
  const projector = makeProjector(sql, [identityProjection, chatProjection])
  await projector.tick()
  const queries = makeQueries(sql)
  const commands = makeCommands({ appender, syncProjections: () => projector.tick() })
  const identity = makeIdentity({ sql, appender, syncProjections: () => projector.tick(), orgId: ORG_ID })
  const loginTokens = makeLoginTokens(sql, cfg.magicLinkTtlSeconds)
  const mailer = new ConsoleMailer()
  const sse = makeSseHub()

  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: cfg.sessionSecret })
  await app.register(cors, { origin: cfg.webOrigin, credentials: true })

  const getActor = async (req: FastifyRequest): Promise<ActorCtx | null> => {
    const raw = req.cookies[SID]
    if (!raw) return null
    const unsigned = app.unsignCookie(raw)
    if (!unsigned.valid || !unsigned.value) return null
    const rows = await sql<{ actor_id: string; roles: string[] }[]>`
      SELECT actor_id, roles FROM actor_state WHERE actor_id = ${unsigned.value}`
    if (!rows[0]) return null
    return { actorId: rows[0].actor_id, orgId: ORG_ID, roles: rows[0].roles }
  }

  registerAuth(app, { identity, loginTokens, mailer, sql, cfg, sessionCookie: SID })
  registerRest(app, { commands, queries, getActor, sse })

  // live tail: broadcast every committed seq to SSE clients (skip when sql injected w/o real conn)
  let sub: any = null
  if (!inject?.sql || cfg.databaseUrl) {
    try { sub = await sse.listenFromDb(sql) } catch { /* tests w/o LISTEN */ }
  }

  return {
    app,
    close: async () => {
      try { if (sub) await sub.unlisten() } catch {}
      await projector.stop()
      await app.close()
      if (!inject?.sql) await sql.end()
    },
  }
}

// entrypoint — robust on Windows: compare canonical native paths, not a
// `file://`+argv string (argv[1] is backslash-separated on Windows and may be
// relative, so the old string compare never matched and the server never listened).
const isMain = ((): boolean => {
  const arg = process.argv[1]
  if (!arg) return false
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(arg) }
  catch { return false }
})()
if (isMain) {
  const cfg = loadConfig()
  const { app } = await buildApp(cfg)
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`OrgOS server on :${cfg.port}`)
}
