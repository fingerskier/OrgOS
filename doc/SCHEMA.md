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

- `id` — `uuid v7` on **every** table (time-sortable prefix ⇒ btree insert
  locality, per-node generation ⇒ federation-safe). DB-native `uuidv7()` on
  Postgres 18+, else app-generated.
- `seq` — `bigint` strict total order, DB-assigned (identity/`bigserial`).
  Lives **only on `event`** as the canonical replay order; `id` (v7) is not a
  substitute — same-ms / cross-node events have no defined order.
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
  id              uuid          PK            -- uuid v7 (identity)
  seq             bigint        UNIQUE        -- strict total replay order (identity/bigserial)
  event_type_id   uuid          FK -> event_type.id
  namespace       text                        -- denormalized for query/partition
  name            text
  version         int

  actor_id        uuid          FK -> actor.id   -- who/what emitted it
  org_id          uuid          FK -> actor.id   -- federation / tenancy boundary

  subject_id      uuid                          -- semantic: what the event is about (projection/timeline grouping)
  stream_id       uuid          NULL            -- consistency boundary; writer-imposed, defaults to subject_id, NULL for firehose
  stream_seq      bigint        NULL            -- writer-assigned expected-next-version within the stream

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
- **`subject_id` vs `stream_id` are different axes.** `subject_id` = *what the
  event is about* (grouping). `stream_id` = *the consistency/ordering unit*.
  They usually coincide, so the convention is `stream_id = subject_id` by
  default — but the writer overrides when the aggregate is coarser than the
  subject (e.g. a `chat.message.posted` whose subject is the message but whose
  stream is the conversation).
- **Optimistic concurrency.** An append is a conditional write: the writer
  asserts `stream_seq = N` expecting the stream is at `N-1`. The server only
  enforces `UNIQUE (stream_id, stream_seq)`, so concurrent appends at the same
  version collide → one fails → retry. `stream_id`/`stream_seq` are therefore
  **writer-imposed, not server-derived** — the DB can't infer the aggregate.
- **Firehose.** Events needing no conditional append (telemetry, sensor
  readings) leave `stream_id` / `stream_seq` NULL and rely on global `seq`
  only; NULLs never collide under the unique constraint.
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

## Validation & Fan-out

Three distinct roles — do not conflate them.

### 1. Validation — DB trigger (correctness)

The trigger is the only chokepoint every writer crosses (humans, AI, devices,
federated imports). In an append-only log, invalid data is permanent, so
validation must be authoritative at the log, not just at the client.

```
-- requires the pg_jsonschema extension
CREATE FUNCTION event_validate() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  SELECT schema INTO s FROM event_type WHERE id = NEW.event_type_id;
  IF s IS NULL THEN
    RAISE EXCEPTION 'unknown event_type %', NEW.event_type_id;
  END IF;
  IF NOT jsonb_matches_schema(s, NEW.payload) THEN
    RAISE EXCEPTION 'payload fails schema for %', NEW.event_type_id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_validate_trg
  BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_validate();
```

- Cache/denormalize `event_type.schema` to avoid a lookup per insert on the
  hot path.
- Do **friendly** validation app-side for UX; the trigger is the
  **authoritative** gate for integrity. Belt + suspenders.

### 2. Fan-out — LISTEN/NOTIFY (wake signal only)

`AFTER INSERT` trigger emits the new `seq` (NOTIFY has an 8 KB cap — **never
ship the payload**, only the cursor).

```
CREATE FUNCTION event_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events', NEW.seq::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify_trg
  AFTER INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_notify();
```

> NOTIFY fires on COMMIT (no phantom wakes on rollback) but is **not durable** —
> only currently-connected listeners receive it. Never treat it as delivery.

### 3. Delivery — `seq` + checkpoint (durability)

Durability comes from the log, not the notification. A projector:

1. On (re)connect, **catch-up poll first**:
   `SELECT … FROM event WHERE seq > last_event_seq ORDER BY seq` — covers any
   down-window the NOTIFY missed.
2. `LISTEN events`; on wake, pull new rows the same way and advance
   `projection_checkpoint.last_event_seq`.

NOTIFY only removes polling latency while the projector is up; correctness
never depends on it.

> **Scaling path:** NOTIFY is single-node, modest fan-out. When projectors or
> federation outgrow it, swap the wake mechanism for logical replication / WAL
> (`wal2json`, Debezium) — same `seq` + checkpoint model, durable stream.

---

## Federation

Each `org_id` is a sovereign boundary. Events replicate between orgs by
shipping rows from `event` (append-only ⇒ safe to merge). `seq` is local;
cross-org ordering uses `occurred_at` + `signature` + `id`. Orgs choose which
namespaces/streams to share.

---

## Open Questions

- ~~**id strategy**~~ — **Resolved:** `uuid v7` for `id` on all tables;
  `bigint seq` on `event` only, as canonical replay order. Complementary,
  not either/or — v7 gives identity + index locality, `seq` gives strict
  total order replay can't get from v7's same-ms/cross-node ties.
- ~~**Payload validation**~~ — **Resolved:** authoritative JSON Schema
  validation via `BEFORE INSERT` trigger (`pg_jsonschema`); LISTEN/NOTIFY as
  wake signal (seq only); `seq` + checkpoint for durable delivery. See
  [Validation & Fan-out](#validation--fan-out).
- ~~**Stream definition**~~ — **Resolved:** `stream_id` is the consistency
  boundary, **writer-imposed**, defaulting to `subject_id` but overridable to a
  coarser aggregate (thread, order, saga); NULL for firehose events. Distinct
  axis from `subject_id` (semantic grouping). Concurrency enforced solely by
  `UNIQUE (stream_id, stream_seq)`.
- **Multi-tenancy** — `org_id` column + RLS vs schema-per-org vs DB-per-org.
- **Snapshots** — store periodic folded snapshots to bound twin/projection
  replay cost?
