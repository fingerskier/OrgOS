import _Ajv, { type ValidateFunction } from 'ajv'
import _addFormats from 'ajv-formats'

// ajv and ajv-formats are CJS packages whose .d.ts use `export default`, which
// NodeNext types as the module namespace (not constructable/callable). Re-bind
// through `.default` — a type-only fix; the runtime values already work via tsx.
const Ajv = _Ajv as unknown as typeof _Ajv.default
const addFormats = _addFormats as unknown as typeof _addFormats.default

export interface EventTypeDef {
  namespace: string
  name: string
  version: number
  schema: Record<string, unknown>
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object', additionalProperties: true, properties: props, required,
})

export const EVENT_TYPES = {
  'identity.actor.registered@1': {
    namespace: 'identity', name: 'actor.registered', version: 1,
    schema: obj({
      handle: { type: 'string', minLength: 1 },
      display_name: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['human', 'ai', 'device', 'org', 'project', 'workflow'] },
      email: { type: 'string', format: 'email' },
    }, ['handle', 'display_name', 'kind', 'email']),
  },
  'identity.role.granted@1': {
    namespace: 'identity', name: 'role.granted', version: 1,
    schema: obj({ role: { type: 'string', minLength: 1 } }, ['role']),
  },
  'identity.role.revoked@1': {
    namespace: 'identity', name: 'role.revoked', version: 1,
    schema: obj({ role: { type: 'string', minLength: 1 } }, ['role']),
  },
  'chat.thread.created@1': {
    namespace: 'chat', name: 'thread.created', version: 1,
    schema: obj({ title: { type: 'string', minLength: 1 } }, ['title']),
  },
  'chat.message.posted@1': {
    namespace: 'chat', name: 'message.posted', version: 1,
    schema: obj({ body: { type: 'string', minLength: 1 } }, ['body']),
  },
  'chat.message.edited@1': {
    namespace: 'chat', name: 'message.edited', version: 1,
    schema: obj({ body: { type: 'string', minLength: 1 }, edits_event_id: { type: 'string' } }, ['body']),
  },
  'chat.message.deleted@1': {
    namespace: 'chat', name: 'message.deleted', version: 1,
    schema: obj({}, []),
  },
} as const satisfies Record<string, EventTypeDef>

export type FqType = keyof typeof EVENT_TYPES

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validators = new Map<string, ValidateFunction>()
for (const [fq, def] of Object.entries(EVENT_TYPES)) {
  validators.set(fq, ajv.compile(def.schema))
}

export function parseFqType(fq: string): { namespace: string; name: string; version: number } {
  const m = /^([a-z0-9_]+)\.([a-z0-9_]+\.[a-z0-9_]+)@(\d+)$/.exec(fq)
  if (!m) throw new Error(`malformed type: ${fq}`)
  return { namespace: m[1]!, name: m[2]!, version: Number(m[3]) }
}

export function validatePayload(fq: string, payload: unknown):
  | { ok: true } | { ok: false; errors: string[] } {
  const v = validators.get(fq)
  if (!v) return { ok: false, errors: [`unknown event_type ${fq}`] }
  if (v(payload)) return { ok: true }
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) }
}
