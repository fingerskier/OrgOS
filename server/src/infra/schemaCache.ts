import type { Sql } from './db.js'
import { EVENT_TYPES, parseFqType } from '../domain/eventTypes.js'

/** Map fully-qualified type → event_type.id (cached in-process). */
export async function loadSchemaCache(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; namespace: string; name: string; version: number }[]>`
    SELECT id, namespace, name, version FROM event_type`
  const byKey = new Map<string, string>()
  for (const r of rows) byKey.set(`${r.namespace}.${r.name}@${r.version}`, r.id)
  // sanity: every registered type should exist in the DB after seeding
  for (const fq of Object.keys(EVENT_TYPES)) {
    const { namespace, name, version } = parseFqType(fq)
    const id = byKey.get(`${namespace}.${name}@${version}`)
    if (id) byKey.set(fq, id)
  }
  return byKey
}
