import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { makeDb } from '../src/infra/db.js'
import { runMigrations } from '../src/infra/migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = loadConfig()
const sql = makeDb(cfg.databaseUrl)
const applied = await runMigrations(sql, join(here, '..', 'migrations'))
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date')
await sql.end()
