# Database Schema

> Postgres. The **event log is the source of truth**; every other table is a
> projection that can be dropped and rebuilt by replaying events.
>
> Tables divide into three layers:
> 1. **Log** — append-only, immutable, never updated or deleted (`event`).
> 2. **Registry** — slow-changing definitions (`event_type`, `twin_type`, `actor`).
> 3. **Projections** — derived, rebuildable read models (`twin`, `actor_state`, ...).

---

## Conventions

- `id` — `uuid` (v7 preferred, time-sortable), application- or DB-generated.
- `seq` — `bigint` global monotonic order, DB-assigned (`bigserial`/identity).
- Timestamps are `timestamptz`, UTC.
- Structured payloads are `jsonb`.
- Naming: `snake_case` columns, singular table names.

---

## Actors

Everything that emits events is an Actor: humans, AI agents, devices,
organizations, projects, workflows.

```
actor {
  id            uuid          PK
  kind          text          -- 'human' | 'ai' | 'device' | 'org' | 'project' | 'workflow'
  handle        text          -- unique within org, human-readable
  display_name  text
  org_id        uuid          FK -> actor.id   -- owning organization (self for org root)
  public_key    text          -- identity / signature verification
  status        text          -- 'active' | 'suspended' | 'retired'
  created_at    timestamptz
  metadata      jsonb
  UNIQUE (org_id, handle)
}
```

> Permissions, roles, and trust are **not** columns here — they are events
> (`identity.role.granted`, `identity.access.revoked`) projected into
> `actor_state` / `grant` read models.

---

## Event Types (Registry)

The central registry. Editable by administration. Versioned; deprecated
types remain readable forever (see [TYPES.md](./TYPES.md)).

```
event_type {
  id          uuid          PK
  namespace   text          -- domain, e.g. 'chat', 'task', 'identity', 'device'
  name        text          -- '<entity>.<verb>', e.g. 'message.posted'
  version     int           -- breaking change => new version
  schema      jsonb         -- JSON Schema for the payload
  owner       text          -- owning team/actor
  status      text          -- 'active' | 'deprecated'
  created_at  timestamptz
  UNIQUE (namespace, name, version)
}
```

- Fully-qualified type = `namespace.name@version`, e.g. `chat.message.posted@1`.
- Payloads written to `event` are validated against the matching schema.

---

## Event (The Log)

Append-only. Immutable. The single source of truth.

```
event {
  id              uuid          PK            -- uuid v7
  seq             bigint        UNIQUE        -- global monotonic order (bigserial)
  event_type_id   uuid          FK -> event_type.id
  namespace       text                        -- denormalized for query/partition
  name            text
  version         int

  actor_id        uuid          FK -> actor.id   -- who/what emitted it
  org_id          uuid          FK -> actor.id   -- federation / tenancy boundary

  subject_id      uuid                          -- primary entity the event is about (twin, actor, ...)
  stream_id       uuid                          -- aggregate/stream for ordering & concurrency
  stream_seq      bigint                        -- position within stream (optimistic concurrency)

  payload         jsonb                         -- validated against event_type.schema
  metadata        jsonb                         -- correlation_id, causation_id, trace, source

  occurred_at     timestamptz                   -- when it happened (actor clock)
  recorded_at     timestamptz   DEFAULT now()   -- when the log accepted it
  signature       text                          -- optional, signed with actor.public_key

  UNIQUE (stream_id, stream_seq)                -- enforces per-stream concurrency
}
```

- **Never** `UPDATE` or `DELETE`. Corrections are new events
  (`*.corrected`, `*.archived`).
- `seq` gives total order for replay; `stream_seq` gives per-aggregate order.
- `correlation_id` / `causation_id` in `metadata` link cause→effect chains.
- Partition by `recorded_at` (range) and/or `org_id` (federation) at scale.

---

## Twin Types (Registry)

Defines a class of digital twin — the schema for a kind of real-world object.

```
twin_type {
  id          uuid    PK
  namespace   text                -- e.g. 'facility', 'fleet'
  name        text                -- e.g. 'sensor', 'room', 'vehicle'
  schema      jsonb               -- JSON Schema for twin.state
  status      text                -- 'active' | 'deprecated'
  created_at  timestamptz
  UNIQUE (namespace, name)
}
```

---

## Twin (Projection)

A digital representation of a real-world object, evolving through events.
**Derived** — rebuilt by folding events whose `subject_id` = `twin.id`.

```
twin {
  id              uuid          PK
  twin_type_id    uuid          FK -> twin_type.id
  org_id          uuid          FK -> actor.id
  external_ref    text          -- serial number, MAC, asset tag
  display_name    text
  parent_id       uuid          FK -> twin.id      -- containment (device in room in building)
  state           jsonb         -- current folded state (validated vs twin_type.schema)
  last_event_seq  bigint        -- high-water mark; how far this twin is replayed
  updated_at      timestamptz
  UNIQUE (org_id, twin_type_id, external_ref)
}
```

---

## Projections (Read Models)

Rebuildable views over the log. Examples — not exhaustive; each app defines
its own. All carry a `last_event_seq` checkpoint so they can resume.

```
projection_checkpoint {
  name            text    PK     -- projector identity, e.g. 'chat-ui', 'kanban'
  last_event_seq  bigint         -- last event applied
  updated_at      timestamptz
}
```

| Projection      | Built from                                   |
|-----------------|----------------------------------------------|
| `actor_state`   | `identity.*`, `permission.*` events          |
| `grant`         | role/permission delegation events            |
| chat            | `chat.message.*`                             |
| kanban          | `task.item.*`                                |
| timeline        | all events for a subject                     |
| twin            | events grouped by `subject_id` + `twin_type` |

Querying the log is plain SQL — see [QUERY.md](./QUERY.md).

---

## Federation

Each `org_id` is a sovereign boundary. Events replicate between orgs by
shipping rows from `event` (append-only ⇒ safe to merge). `seq` is local;
cross-org ordering uses `occurred_at` + `signature` + `id`. Orgs choose which
namespaces/streams to share.

---

## Open Questions

- **id strategy** — uuid v7 (time-sortable, no extra `seq` needed) vs
  bigserial `seq` + random uuid. Listed both above; pick one.
- **Payload validation** — enforce JSON Schema in app layer, DB trigger, or
  a deferred validator projection?
- **Stream definition** — is `stream_id` always the subject, or a separate
  aggregate concept (e.g. a conversation thread spanning many subjects)?
- **Multi-tenancy** — `org_id` column + RLS vs schema-per-org vs DB-per-org.
- **Snapshots** — store periodic folded snapshots to bound twin/projection
  replay cost?
