import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import type { Sql } from '../../src/infra/db.js'
import { runMigrations } from '../../src/infra/migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', '..', 'migrations')

/** Create an isolated, migrated schema; returns the sql handle and a cleanup fn. */
export async function freshSchema(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
  if (!url) throw new Error('set DATABASE_URL_TEST')
  const schema = 'test_' + Math.abs(Date.now() ^ (Math.floor(performance.now() * 1000))).toString(36)
  const admin = postgres(url, { onnotice: () => {} })
  await admin`CREATE SCHEMA ${admin(schema)}`
  await admin.end()
  const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })
  await runMigrations(sql, MIGRATIONS)
  return {
    sql,
    drop: async () => {
      await sql.end()
      const a = postgres(url, { onnotice: () => {} })
      await a`DROP SCHEMA IF EXISTS ${a(schema)} CASCADE`
      await a.end()
    },
  }
}
