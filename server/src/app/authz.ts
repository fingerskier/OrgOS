export interface ActorCtx { actorId: string; orgId: string; roles: string[] }

/** Beta policy: anyone may chat and self-register; admin-only for everything else. */
export function canAppend(actor: Pick<ActorCtx, 'roles'>, type: string): boolean {
  if (type.startsWith('chat.')) return true
  if (type === 'identity.actor.registered@1') return true
  return actor.roles.includes('admin')
}
