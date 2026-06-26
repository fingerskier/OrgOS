# Querying the Event Log

> The `event` table is the source of truth; everything else is a **projection**
> — a fold over events you can compute on the fly in SQL or materialize into a
> read model. This page is a cookbook of those folds. See [SCHEMA.md](./SCHEMA.md)
> for column definitions and [TYPES.md](./TYPES.md) for event names.

All examples are plain Postgres. `seq` (strict total order) drives replay;
`subject_id` groups by *what the event is about*; `stream_id` is the
consistency/aggregate boundary.

---

## 1. Filter by type

The `event` row denormalizes `namespace` / `name` / `version`, so the common
case needs no join to `event_type`:

```sql
SELECT seq, actor_id, subject_id, payload, occurred_at
FROM event
WHERE namespace = 'chat' AND name = 'message.posted'
ORDER BY seq;
```

Pin a version when readers care; omit it to fold every version:

```sql
WHERE namespace = 'chat' AND name = 'message.posted' AND version = 1
```

A whole domain:

```sql
SELECT seq, name, payload FROM event
WHERE namespace = 'task'
ORDER BY seq;
```

---

## 2. Timeline for a subject

Everything that ever happened to one thing, in order — the universal "history"
view (an audit trail, a twin's lifecycle, a record's changelog):

```sql
SELECT seq, namespace, name, actor_id, payload, occurred_at
FROM event
WHERE subject_id = $1            -- the message / task / twin / actor id
ORDER BY seq;
```

---

## 3. Fold to current state (latest-wins)

Many projections are "the most recent event of a kind per subject." `DISTINCT
ON` over descending `seq` is the idiomatic fold:

```sql
-- current state of every twin, from its latest state-changing event
SELECT DISTINCT ON (subject_id)
       subject_id AS twin_id,
       payload    AS state,
       seq        AS last_event_seq
FROM event
WHERE namespace = 'twin' AND name IN ('instance.created', 'state.updated')
ORDER BY subject_id, seq DESC;
```

For a single subject, just `... WHERE subject_id = $1 ORDER BY seq DESC LIMIT 1`.

---

## 4. Chat projection (messages in a thread)

The conversation is the `stream_id`; each message is a `subject_id`. Show a
thread with edits folded in (latest body per message):

```sql
SELECT DISTINCT ON (subject_id)
       subject_id AS message_id,
       actor_id   AS author_id,
       payload ->> 'body' AS body,
       occurred_at
FROM event
WHERE stream_id = $1                       -- the thread/conversation
  AND namespace = 'chat'
  AND name IN ('message.posted', 'message.edited')
  AND subject_id NOT IN (                    -- drop deleted messages
    SELECT subject_id FROM event
    WHERE stream_id = $1 AND name = 'message.deleted'
  )
ORDER BY subject_id, seq DESC;
```

---

## 5. Kanban projection (current column per task)

Fold `task.item.moved` to the latest column, joined to creation:

```sql
WITH created AS (
  SELECT subject_id AS task_id,
         payload ->> 'title' AS title,
         seq
  FROM event
  WHERE namespace = 'task' AND name = 'item.created'
),
latest_move AS (
  SELECT DISTINCT ON (subject_id)
         subject_id AS task_id,
         payload ->> 'to_column' AS column,
         seq
  FROM event
  WHERE namespace = 'task' AND name = 'item.moved'
  ORDER BY subject_id, seq DESC
)
SELECT c.task_id, c.title,
       COALESCE(m.column, 'backlog') AS column
FROM created c
LEFT JOIN latest_move m USING (task_id)
WHERE c.task_id NOT IN (
  SELECT subject_id FROM event
  WHERE namespace = 'task' AND name = 'item.archived'
)
ORDER BY c.seq;
```

---

## 6. actor_state / grant (roles minus revocations)

Effective roles = granted, with later revocations removed. Pair each grant
with the matching revoke by `(actor, role)` and keep only un-revoked grants:

```sql
WITH grants AS (
  SELECT subject_id AS actor_id,
         payload ->> 'role' AS role,
         seq
  FROM event
  WHERE namespace = 'identity' AND name = 'role.granted'
),
revokes AS (
  SELECT subject_id AS actor_id,
         payload ->> 'role' AS role,
         seq
  FROM event
  WHERE namespace = 'identity' AND name = 'role.revoked'
)
SELECT g.actor_id, g.role
FROM grants g
WHERE NOT EXISTS (
  SELECT 1 FROM revokes r
  WHERE r.actor_id = g.actor_id
    AND r.role = g.role
    AND r.seq  > g.seq            -- revoked *after* this grant
);
```

---

## 7. Catch-up poll (projector durability)

The delivery contract: a projector advances past its checkpoint by `seq`. This
is the query behind every materialized read model (see SCHEMA §Validation &
Fan-out):

```sql
SELECT seq, namespace, name, subject_id, stream_id, payload
FROM event
WHERE seq > $1                    -- projection_checkpoint.last_event_seq
ORDER BY seq
LIMIT 1000;                       -- batch; loop until fewer than LIMIT rows
```

After applying a batch, advance the checkpoint:

```sql
UPDATE projection_checkpoint
SET last_event_seq = $1, updated_at = now()
WHERE name = $2;
```

---

## 8. Causal chains (correlation / causation)

`metadata` carries `correlation_id` (the saga) and `causation_id` (the direct
parent). Pull a whole workflow:

```sql
SELECT seq, namespace, name, actor_id,
       metadata ->> 'causation_id' AS caused_by
FROM event
WHERE metadata ->> 'correlation_id' = $1
ORDER BY seq;
```

Direct effects of one event:

```sql
SELECT seq, namespace, name FROM event
WHERE metadata ->> 'causation_id' = $1::text
ORDER BY seq;
```

---

## 9. Digging into `jsonb` payloads

```sql
-- scalar extraction
SELECT payload ->> 'body' FROM event WHERE name = 'message.posted';

-- filter on a nested field
SELECT * FROM event
WHERE namespace = 'device' AND name = 'telemetry.received'
  AND (payload -> 'reading' ->> 'celsius')::numeric > 80;

-- containment (GIN-indexable)
SELECT * FROM event
WHERE namespace = 'task'
  AND payload @> '{"priority": "high"}';
```

> Index hot payload paths: `CREATE INDEX ON event USING gin (payload jsonb_path_ops);`
> or expression indexes on specific extracted fields.

---

## 10. Firehose aggregation (telemetry)

Firehose events leave `stream_id`/`stream_seq` NULL and rely on global `seq`.
Aggregate them like any time series — here, hourly average per device:

```sql
SELECT subject_id AS device_id,
       date_trunc('hour', occurred_at) AS hour,
       avg((payload -> 'reading' ->> 'celsius')::numeric) AS avg_c,
       count(*) AS samples
FROM event
WHERE namespace = 'device' AND name = 'telemetry.received'
  AND occurred_at >= now() - interval '24 hours'
GROUP BY device_id, hour
ORDER BY device_id, hour;
```

---

## 11. Inspecting stream concurrency

The current version of an aggregate = its highest `stream_seq`. Useful for the
optimistic-append "expected version" check:

```sql
SELECT stream_id, max(stream_seq) AS current_version, count(*) AS events
FROM event
WHERE stream_id = $1
GROUP BY stream_id;
```

Detect gaps (should never exist within a stream if writers behave):

```sql
SELECT stream_id, stream_seq,
       stream_seq - lag(stream_seq) OVER (PARTITION BY stream_id ORDER BY stream_seq) AS gap
FROM event
WHERE stream_id = $1
ORDER BY stream_seq;
```

---

## 12. Rebuilding a projection from scratch

Because the log is the source of truth, any read model is disposable. Drop and
replay from `seq = 0`:

```sql
TRUNCATE twin;                                   -- or DELETE WHERE ...
UPDATE projection_checkpoint SET last_event_seq = 0 WHERE name = 'twin';
-- then run the §7 catch-up loop, applying each event's fold
```

This is the core guarantee of the architecture: **no projection holds state the
log cannot reconstruct.**

---

## Federation note

`seq` is local to each database. When querying across replicated foreign
events, order by `occurred_at`, break ties with `id` (uuid v7), and trust
`signature` — never assume another org's `seq` aligns with yours. Filter origin
with `org_id`.
