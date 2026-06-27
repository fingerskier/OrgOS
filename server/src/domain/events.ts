export interface StoredEvent {
  id: string
  seq: string            // bigint as string
  namespace: string
  name: string
  version: number
  actorId: string
  orgId: string
  subjectId: string | null
  streamId: string | null
  streamSeq: string | null
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}
