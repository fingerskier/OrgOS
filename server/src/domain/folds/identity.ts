import type { StoredEvent } from '../events.js'

export interface ActorState {
  actor_id: string
  handle: string
  display_name: string
  kind: string
  status: string
  email: string
  roles: string[]
  last_event_seq: string
}

const applied = (s: ActorState | null, e: StoredEvent): boolean =>
  s != null && BigInt(e.seq) <= BigInt(s.last_event_seq)

export function foldIdentity(state: ActorState | null, e: StoredEvent): ActorState | null {
  if (applied(state, e)) return state
  const seq = e.seq
  if (e.name === 'actor.registered') {
    const p = e.payload as Record<string, string>
    return {
      actor_id: e.subjectId!, handle: p.handle!, display_name: p.display_name!,
      kind: p.kind!, status: 'active', email: p.email!, roles: [], last_event_seq: seq,
    }
  }
  if (state == null) return state
  if (e.name === 'role.granted') {
    const role = (e.payload as { role: string }).role
    const roles = state.roles.includes(role) ? state.roles : [...state.roles, role]
    return { ...state, roles, last_event_seq: seq }
  }
  if (e.name === 'role.revoked') {
    const role = (e.payload as { role: string }).role
    return { ...state, roles: state.roles.filter((r) => r !== role), last_event_seq: seq }
  }
  return { ...state, last_event_seq: seq }
}
