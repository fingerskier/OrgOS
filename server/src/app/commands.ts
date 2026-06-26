import type { AppendInput } from '../infra/appender.js'
import { ValidationError } from '../infra/appender.js'
import { validatePayload } from '../domain/eventTypes.js'
import { canAppend, type ActorCtx } from './authz.js'

export class AuthzError extends Error {}

interface Appender { append(i: AppendInput): Promise<{ id: string; seq: string }> }
interface Deps { appender: Appender; syncProjections: () => Promise<void> }

export interface AppendRequest {
  type: string
  subjectId: string | null
  streamId: string | null
  streamSeq: number | null
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function makeCommands({ appender, syncProjections }: Deps) {
  return {
    async appendEvent(actor: ActorCtx, req: AppendRequest): Promise<{ id: string; seq: string }> {
      if (!canAppend(actor, req.type)) throw new AuthzError(`not permitted to append ${req.type}`)
      const v = validatePayload(req.type, req.payload)
      if (!v.ok) throw new ValidationError(v.errors.join('; '))
      const r = await appender.append({
        type: req.type, actorId: actor.actorId, orgId: actor.orgId,
        subjectId: req.subjectId, streamId: req.streamId, streamSeq: req.streamSeq,
        payload: req.payload, metadata: req.metadata,
      })
      await syncProjections()
      return r
    },
  }
}
