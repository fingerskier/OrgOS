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

      // Fast path: an already-registered actor resolves through the
      // unique-indexed projection — no lock, no transaction. This is the common
      // case (every repeat login) and keeps its cost a single indexed lookup.
      const existing = await sql<{ actor_id: string; handle: string }[]>`
        SELECT actor_id, handle FROM actor_state WHERE email = ${email}`
      if (existing[0]) return { actorId: existing[0].actor_id, handle: existing[0].handle }

      // First login: serialize per-email. Without this, two concurrent callers
      // (e.g. a double-clicked magic link) both see an empty projection and each
      // appends identity.actor.registered@1 with a distinct actor_id; the second
      // then violates actor_state.email UNIQUE inside the projector batch and
      // wedges the checkpoint. pg_advisory_xact_lock(hashtext(email)) is held to
      // tx end; the loser re-checks the event LOG — the source of truth, since
      // the projection has not been applied yet here — and returns the winner's
      // actor. The projector runs OUTSIDE this lock so the lock holder never
      // needs a second pooled connection while blocking the other waiters.
      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${email}))`
        const reg = await tx<{ actor_id: string; handle: string }[]>`
          SELECT stream_id AS actor_id, payload->>'handle' AS handle
          FROM event
          WHERE namespace = 'identity' AND name = 'actor.registered'
            AND payload->>'email' = ${email}
          LIMIT 1`
        if (reg[0]) return { actorId: reg[0].actor_id, handle: reg[0].handle, fresh: false }

        const actorId = newId()
        const handle = handleFromEmail(email)
        await appender.append({
          type: 'identity.actor.registered@1', actorId, orgId,
          subjectId: actorId, streamId: actorId, streamSeq: 1,
          payload: { handle, display_name: claim.name ?? handle, kind: 'human', email },
        })
        return { actorId, handle, fresh: true }
      })

      if (result.fresh) await syncProjections()
      return { actorId: result.actorId, handle: result.handle }
    },
  }
}
