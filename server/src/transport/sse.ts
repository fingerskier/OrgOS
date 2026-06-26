import type { FastifyReply } from 'fastify'
import type { Sql } from '../infra/db.js'

export function makeSseHub() {
  const clients = new Set<FastifyReply>()
  return {
    register(reply: FastifyReply): void {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      reply.raw.write(': connected\n\n')
      clients.add(reply)
      reply.raw.on('close', () => clients.delete(reply))
    },
    broadcast(seq: string): void {
      for (const c of clients) {
        try { c.raw.write(`event: append\ndata: ${seq}\n\n`) } catch { clients.delete(c) }
      }
    },
    async listenFromDb(sql: Sql) {
      return sql.listen('events', (payload) => this.broadcast(payload))
    },
  }
}
