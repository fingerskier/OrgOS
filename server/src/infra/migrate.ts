import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sql } from './db.js'

export async function runMigrations(sql: Sql, dir: string): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const name of files) {
    const done = await sql`SELECT 1 FROM schema_migration WHERE name = ${name}`
    if (done.length > 0) continue
    const text = await readFile(join(dir, name), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`INSERT INTO schema_migration (name) VALUES (${name})`
    })
    applied.push(name)
  }
  return applied
}
