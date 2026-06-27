import type { Sql } from '../infra/db.js'
import type { AppendInput } from '../infra/appender.js'
import { newId } from '../infra/uuid.js'

interface Appender { append(i: AppendInput): Promise<{ id: string; seq: string }> }
interface Deps { sql: Sql; appender: Appender; syncProjections: () => Promise<void>; orgId: string }

const handleFromEmail = (email: string): string => email.split('@')[0]!.replace(/[^a-z0-9_.-]/gi, '').toLowerCase() || 'user'

export function makeIdentity({ sql, appender, syncProjections, orgId }: Deps) {
  return {
    async resolveActor(claim: { email: string; name?: string }): Promise<{ actorId: string; handle: string }> {
      const email = claim.email.trim().toLowerCase()
      const existing = await sql<{ actor_id: string; handle: string }[]>`
        SELECT actor_id, handle FROM actor_state WHERE email = ${email}`
      if (existing[0]) return { actorId: existing[0].actor_id, handle: existing[0].handle }

      const actorId = newId()
      const handle = handleFromEmail(email)
      await appender.append({
        type: 'identity.actor.registered@1', actorId, orgId,
        subjectId: actorId, streamId: actorId, streamSeq: 1,
        payload: { handle, display_name: claim.name ?? handle, kind: 'human', email },
      })
      await syncProjections()
      return { actorId, handle }
    },
  }
}
