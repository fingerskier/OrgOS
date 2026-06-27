import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { fileURLToPath } from 'node:url'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender } from '../../src/infra/appender.js'
import { makeProjector, identityProjection } from '../../src/infra/projector.js'
import { makeIdentity } from '../../src/app/identity.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-00000000c0de'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(fileURLToPath(new URL('../../migrations/005_seed.sql', import.meta.url)))
})
afterEach(async () => { await drop() })

describe('resolveActor', () => {
  it('registers a new actor on first sight, returns the same on second', async () => {
    const appender = makeAppender(sql)
    const proj = makeProjector(sql, [identityProjection])
    const identity = makeIdentity({ sql, appender, syncProjections: () => proj.tick(), orgId: ORG })

    const a = await identity.resolveActor({ email: 'matt@x.io' })
    expect(a.actorId).toMatch(/-7[0-9a-f]{3}-/)
    const rows = await sql`SELECT * FROM actor_state WHERE email='matt@x.io'`
    expect(rows).toHaveLength(1)

    const b = await identity.resolveActor({ email: 'matt@x.io' })
    expect(b.actorId).toBe(a.actorId)              // no duplicate registration
    const after = await sql`SELECT count(*)::int AS n FROM event WHERE namespace='identity'`
    expect(after[0]!.n).toBe(1)
  })

  it('serializes concurrent first-login for one email (no double registration)', async () => {
    const appender = makeAppender(sql)
    const proj = makeProjector(sql, [identityProjection])
    const identity = makeIdentity({ sql, appender, syncProjections: () => proj.tick(), orgId: ORG })

    // Two callers race on the same brand-new email (e.g. a double-clicked magic
    // link). Without per-email serialization both see an empty projection, both
    // append identity.actor.registered@1, and the second collides on
    // actor_state.email UNIQUE inside the projector — wedging the checkpoint.
    const [a, b] = await Promise.all([
      identity.resolveActor({ email: 'race@x.io' }),
      identity.resolveActor({ email: 'race@x.io' }),
    ])

    expect(a.actorId).toBe(b.actorId)              // both callers converge on one actor
    const actors = await sql`SELECT * FROM actor_state WHERE email='race@x.io'`
    expect(actors).toHaveLength(1)
    const regs = await sql`SELECT count(*)::int AS n FROM event
      WHERE namespace='identity' AND name='actor.registered'`
    expect(regs[0]!.n).toBe(1)
  })
})
