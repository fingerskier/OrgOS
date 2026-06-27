import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
beforeAll(async () => { ({ sql, drop } = await freshSchema()) })
afterAll(async () => { await drop() })

describe('migrations', () => {
  it('creates the core tables', async () => {
    const rows = await sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() ORDER BY table_name`
    const names = rows.map((r) => r.table_name)
    expect(names).toEqual(expect.arrayContaining([
      'actor', 'event', 'event_type', 'login_token', 'projection_checkpoint',
    ]))
  })
  it('event.seq is a strictly increasing identity', async () => {
    // requires a registered type to satisfy FK; insert a throwaway type
    const [t] = await sql`INSERT INTO event_type (id, namespace, name, version, schema)
      VALUES (${'00000000-0000-7000-8000-000000000001'}, 'x', 'a.b', 1, '{}'::jsonb) RETURNING id`
    const ins = async () => (await sql`INSERT INTO event
      (id, event_type_id, namespace, name, version, actor_id, org_id, payload)
      VALUES (gen_random_uuid(), ${t!.id}, 'x', 'a.b', 1,
              ${'00000000-0000-7000-8000-000000000002'},
              ${'00000000-0000-7000-8000-000000000002'}, '{}'::jsonb)
      RETURNING seq`)[0]!.seq
    const s1 = await ins(); const s2 = await ins()
    expect(BigInt(s2)).toBeGreaterThan(BigInt(s1))
  })
})
