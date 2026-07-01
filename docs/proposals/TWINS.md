# Digital Twins

> **STATUS: Proposal — not implemented.** GET /twins/:id returns 501; no
> `twin` / `twin_type` tables exist in the migrations. Kept as a design
> proposal; buildable as a satellite package against the public event API.
> See [ROADMAP.md](../../ROADMAP.md).

> A **digital twin** is the live, server-side representation of a real-world
> object — a sensor, a room, a vehicle, a pump. It is a **projection**: its
> `state` is folded from events whose `subject_id` is the twin's `id`. Nothing
> about a twin is authoritative except the events behind it; the `twin` row can
> be dropped and rebuilt at any time. See [SCHEMA.md](../SCHEMA.md) for the
> event log tables this builds on and [EXAMPLES.md](../EXAMPLES.md) for the
> fold patterns.

Two registry/projection halves:

- **`twin_type`** (registry) — the *class*: a namespace, a name, and a JSON
  Schema describing what a valid `twin.state` looks like.
- **`twin`** (projection) — an *instance*: a folded `state`, a `last_event_seq`
  high-water mark, and a `parent_id` for containment.

---

## Proposed tables

Neither table exists in the migrations; these are the proposed shapes.

### `twin_type` (registry)

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

### `twin` (projection)

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

## Fix before building

- **`uuidv7()` does not exist on the deployed `postgres:16` image.** The SQL
  examples below call it for convenience; in practice ids must be
  app-generated (as the server already does for events) and passed in as
  parameters.
- **The raw `INSERT INTO event` examples depict the writer's *internal* step.**
  All appends must go through the append path — authorization and payload
  validation included — never direct SQL against the log.
- **The `last_event_seq` guard is redelivery-safe, not out-of-order-safe.**
  With a shallow `jsonb` merge, a stale-but-newer-seq event can still
  partially overwrite fresher fields. Ordered delivery (or a per-field fold)
  is still required; see the softened note in §3.

---

## 1. Register a twin type

A type is a slow-changing registry row — defined once by administration, like
an `event_type`.
Here, a temperature/humidity sensor:

```sql
INSERT INTO twin_type (id, namespace, name, schema, status, created_at)
VALUES (
  uuidv7(),
  'facility', 'sensor',
  '{
     "type": "object",
     "properties": {
       "celsius":      { "type": "number" },
       "humidity_pct": { "type": "number", "minimum": 0, "maximum": 100 },
       "online":       { "type": "boolean" },
       "last_seen":    { "type": "string", "format": "date-time" }
     },
     "required": ["online"]
   }'::jsonb,
  'active', now()
);
```

The `schema` is what `twin.state` is validated against whenever the projection
folds an event forward.

---

## 2. Create a twin instance

Creation is an **event**, not a bare row insert — the row is derived from it.
Emit `twin.instance.created` with `subject_id` = the new twin's id:

```sql
-- one twin id, reused as the event subject and the projection PK
WITH new_twin AS (SELECT uuidv7() AS id)
INSERT INTO event (
  id, event_type_id, namespace, name, version,
  actor_id, org_id, subject_id, stream_id, stream_seq,
  payload, occurred_at
)
SELECT
  uuidv7(),
  (SELECT id FROM event_type WHERE namespace='twin' AND name='instance.created' AND version=1),
  'twin', 'instance.created', 1,
  $actor_id, $org_id,
  nt.id, nt.id, 1,                          -- subject = stream = the twin; first version
  jsonb_build_object(
    'twin_type', 'facility.sensor',
    'external_ref', 'SENSOR-A14',           -- serial / MAC / asset tag
    'display_name', 'Lab A — bench sensor',
    'parent_id', $room_twin_id              -- contained in a 'room' twin
  ),
  now()
FROM new_twin nt;
```

The projector reacts to this event by inserting the `twin` row:

```sql
INSERT INTO twin (
  id, twin_type_id, org_id, external_ref, display_name,
  parent_id, state, last_event_seq, updated_at
)
VALUES (
  $subject_id,
  (SELECT id FROM twin_type WHERE namespace='facility' AND name='sensor'),
  $org_id, 'SENSOR-A14', 'Lab A — bench sensor',
  $room_twin_id,
  '{"online": false}'::jsonb,               -- seed state (must satisfy twin_type.schema)
  $event_seq, now()
);
```

---

## 3. Update twin state

Updates are events too.
A device reports telemetry; the twin folds it.
The **device events feed the twin** — they share the same `subject_id`:

```sql
-- a reading arrives (firehose: no stream_seq needed)
INSERT INTO event (id, event_type_id, namespace, name, version,
                   actor_id, org_id, subject_id, payload, occurred_at)
VALUES (
  uuidv7(),
  (SELECT id FROM event_type WHERE namespace='device' AND name='telemetry.received' AND version=1),
  'device', 'telemetry.received', 1,
  $device_actor_id, $org_id,
  $sensor_twin_id,                          -- subject = the twin
  '{"celsius": 21.4, "humidity_pct": 38, "online": true}'::jsonb,
  now()
);
```

The projector folds the new event into `state` and advances the high-water
mark — a shallow merge of the payload here, but the fold logic is per-type:

```sql
UPDATE twin
SET state = state || $payload,              -- jsonb merge: overlay new fields
    last_event_seq = $event_seq,
    updated_at = now()
WHERE id = $sensor_twin_id
  AND $event_seq > last_event_seq;          -- idempotent: skip redelivered events
```

> The `last_event_seq` guard makes the fold **redelivery-safe** — a
> re-delivered or already-applied event is skipped, exactly as a catch-up poll
> requires. It is **not** out-of-order-safe: with a shallow `jsonb` merge, an
> event that is stale in wall-clock terms but carries a newer `seq` can still
> partially overwrite fresher fields. Feed the fold in `seq` order (or fold
> per-field, latest-writer-wins) — the guard alone does not guarantee this.

A semantic state change uses `device.state.changed` / `twin.state.updated`;
telemetry uses `device.telemetry.received`.
Same fold, different verbs by intent.

---

## 4. Query a twin's current state

The materialized projection is a plain row lookup:

```sql
SELECT id, display_name, state, last_event_seq, updated_at
FROM twin
WHERE id = $1;

-- or by stable real-world identity
SELECT * FROM twin
WHERE org_id = $org_id
  AND twin_type_id = (SELECT id FROM twin_type WHERE namespace='facility' AND name='sensor')
  AND external_ref = 'SENSOR-A14';
```

Filter on folded state via `jsonb` (index hot paths with GIN):

```sql
-- every sensor currently reporting too hot
SELECT id, display_name, state ->> 'celsius' AS celsius
FROM twin
WHERE twin_type_id = (SELECT id FROM twin_type WHERE namespace='facility' AND name='sensor')
  AND (state ->> 'celsius')::numeric > 30
  AND (state ->> 'online')::boolean;
```

### State without the projection (fold on the fly)

Because `twin` is disposable, you can recompute state straight from the log —
the latest-wins fold. Useful for rebuilds, audits, or point-in-time queries:

```sql
-- current state by replaying the twin's own events
SELECT jsonb_object_agg(key, value) AS state
FROM (
  SELECT DISTINCT ON (kv.key) kv.key, kv.value
  FROM event e,
       LATERAL jsonb_each(e.payload) AS kv(key, value)
  WHERE e.subject_id = $1
  ORDER BY kv.key, e.seq DESC               -- last writer per field wins
) latest;
```

Point-in-time ("what did it look like at seq N?") is the same query with
`AND e.seq <= $N` — a built-in time machine, no snapshot table required.

---

## 5. Containment hierarchy

`parent_id` makes twins a tree — device in room in building. Walk it with a
recursive CTE:

```sql
-- everything contained (transitively) under a building twin
WITH RECURSIVE contained AS (
  SELECT id, display_name, parent_id, 0 AS depth
  FROM twin WHERE id = $building_id
  UNION ALL
  SELECT t.id, t.display_name, t.parent_id, c.depth + 1
  FROM twin t JOIN contained c ON t.parent_id = c.id
)
SELECT depth, id, display_name FROM contained ORDER BY depth;
```

---

## 6. Retire a twin

Twins are never hard-deleted — that would orphan their events.
Emit `twin.instance.retired`; the projector marks the row terminal but keeps it (and the full event history) readable:

```sql
INSERT INTO event (id, event_type_id, namespace, name, version,
                   actor_id, org_id, subject_id, stream_id, stream_seq,
                   payload, occurred_at)
VALUES (
  uuidv7(),
  (SELECT id FROM event_type WHERE namespace='twin' AND name='instance.retired' AND version=1),
  'twin', 'instance.retired', 1,
  $actor_id, $org_id,
  $sensor_twin_id, $sensor_twin_id, $next_stream_seq,
  '{"reason": "decommissioned"}'::jsonb,
  now()
);

-- projector
UPDATE twin
SET state = state || '{"online": false, "retired": true}'::jsonb,
    last_event_seq = $event_seq, updated_at = now()
WHERE id = $sensor_twin_id;
```

---

## Lifecycle summary

```
twin_type registered          (registry, admin)
        │
        ▼
twin.instance.created    ──▶  twin row inserted          (state seeded)
        │
   device.telemetry.received
   device.state.changed   ──▶  fold into twin.state       (last_event_seq ↑)
   twin.state.updated
        │
twin.instance.retired    ──▶  twin marked terminal        (history retained)
```

The twin row is only ever a **cache of the fold**.
Drop it, replay the events, get the identical state — that invariant is the whole point.
