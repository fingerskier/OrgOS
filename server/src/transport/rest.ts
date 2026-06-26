import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ActorCtx } from '../app/authz.js'
import { AuthzError } from '../app/commands.js'
import { ValidationError, ConcurrencyError } from '../infra/appender.js'

interface RestDeps {
  commands: { appendEvent(actor: ActorCtx, req: any): Promise<{ id: string; seq: string }> }
  queries: ReturnType<typeof import('../app/queries.js').makeQueries>
  getActor(req: FastifyRequest): Promise<ActorCtx | null>
  sse: { register(reply: any): void }
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const requireActor = async (req: FastifyRequest): Promise<ActorCtx> => {
    const a = await deps.getActor(req)
    if (!a) { const e: any = new Error('unauthorized'); e.statusCode = 401; throw e }
    return a
  }

  app.post('/events', async (req, reply) => {
    const actor = await requireActor(req)
    try {
      const r = await deps.commands.appendEvent(actor, req.body as any)
      return reply.code(201).send(r)
    } catch (e) {
      if (e instanceof AuthzError) return reply.code(403).send({ error: e.message })
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message })
      if (e instanceof ConcurrencyError) return reply.code(409).send({ error: e.message, currentVersion: e.currentVersion })
      throw e
    }
  })

  app.get('/events', async (req, reply) => {
    const q = req.query as { subject?: string; after?: string }
    if (!q.subject) return reply.code(400).send({ error: 'subject required' })
    const rows = await deps.queries.eventsForSubject(q.subject, q.after ?? '0')
    return rows
  })

  app.get('/projections/actors', async () => deps.queries.listActors())
  app.get('/projections/threads', async () => deps.queries.listThreads())
  app.get('/projections/chat', async (req, reply) => {
    const thread = (req.query as { thread?: string }).thread
    if (!thread) return reply.code(400).send({ error: 'thread required' })
    return deps.queries.getThread(thread)
  })

  app.get('/twins/:id', async (_req, reply) => reply.code(501).send({ error: 'twins not in beta' }))

  app.get('/stream', async (req, reply) => {
    await requireActor(req)
    deps.sse.register(reply)
    return reply
  })
}
