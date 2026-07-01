# Database Schema

> Postgres 16. The **event log is the source of truth**; every other read table
> is a projection that can be dropped and rebuilt by replaying events.
>
> Tables divide into four layers:
> 1. **Log** — append-only, immutable, never updated or deleted (`event`).
> 2. **Registry** — slow-changing definitions (`event_type`, `actor`).
> 3. **Projections** — derived, rebuildable read models (`actor_state`,
>    `chat_thread`, `chat_message`, `projection_checkpoint`).
> 4. **Operational** — ephemeral plumbing, deliberately *not* event-sourced
>    (`login_token`).
>
> This document mirrors `server/migrations/001_extensions.sql` …
> `005_seed.sql` exactly. When in doubt, the migrations win.

| Migration | Creates |
|---|---|
| `001_extensions.sql` | `pg_jsonschema` extension |
| `002_core.sql` | `actor`, `event_type`, `event` (+ indexes), `projection_checkpoint`, `login_token` |
| `003_triggers.sql` | `event_validate` (BEFORE INSERT), `event_notify` (AFTER INSERT) |
| `004_projections.sql` | `actor_state`, `chat_thread`, `chat_message` |
| `005_seed.sql` | org root actor, the 7 beta event types, projector checkpoints |

---

## Conventions

- `id` — `uuid v7` wherever a table has a surrogate `id` (`actor`,
  `event_type`, `event`; time-sortable prefix ⇒ btree insert locality,
  per-node generation ⇒ federation-safe). **App-generated**
  (`server/src/infra/uuid.ts`, the `uuidv7` npm package) — Postgres 16 has no
  native `uuidv7()`. Projections key on the entity uuid (`actor_id`,
  `thread_id`, `message_id`); operational/checkpoint tables use natural text
  keys (`token_hash`, `name`).
- `seq` — `bigint` strict total order, DB-assigned
  (`GENERATED ALWAYS AS IDENTITY`). Lives **only on `event`** as the canonical
  replay order; `id` (v7) is not a substitute — same-ms / cross-node events
  have no defined order.
- Timestamps are `timestamptz`, UTC.
- Structured payloads are `jsonb`.
- Naming: `snake_case` columns, singular table names.

---

## Log

### `event`

Append-only. Immutable. The single source of truth.

```sql
CREATE TABLE event (
  id             uuid        PRIMARY KEY,
  seq            bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  event_type_id  uuid        NOT NULL REFERENCES event_type(id),
  namespace      text        NOT NULL,
  name           text        NOT NULL,
  version        int         NOT NULL,
  actor_id       uuid        NOT NULL,
  org_id         uuid        NOT NULL,
  subject_id     uuid,
  stream_id      uuid,
  stream_seq     bigint,
  payload        jsonb       NOT NULL,
  metadata       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  signature      text,
  UNIQUE (stream_id, stream_seq)
);
CREATE INDEX event_subject_idx ON event (subject_id, seq);
CREATE INDEX event_ns_name_idx ON event (namespace, name, seq);
CREATE INDEX event_stream_idx  ON event (stream_id, stream_seq);
```

- **Never** `UPDATE` or `DELETE`. Corrections are new events
  (`chat.message.edited`, `chat.message.deleted`, …).
- `seq` gives total order for replay; `stream_seq` gives per-aggregate order.
- **The only foreign key is `event_type_id`.** `actor_id` and `org_id` are
  plain `NOT NULL uuid` — no `REFERENCES actor(id)`. This is a deliberate
  append-path choice: an FK lookup per insert taxes the hot path, and
  federated imports would carry actors that have no local `actor` row.
  Referential integrity for actors is enforced at the writer (the server
  resolves the acting identity from `actor_state` before appending), not by
  the DDL.
- **`subject_id` vs `stream_id` are different axes.** `subject_id` = *what the
  event is about* (grouping, timelines). `stream_id` = *the
  consistency/ordering unit*. They usually coincide, so the convention is
  `stream_id = subject_id` by default — but the writer overrides when the
  aggregate is coarser than the subject (e.g. a `chat.message.posted` whose
  subject is the message but whose stream is the thread).
- **Optimistic concurrency.** An append is a conditional write: the writer
  asserts `stream_seq = N` expecting the stream is at `N-1`. The server only
  enforces `UNIQUE (stream_id, stream_seq)`, so concurrent appends at the same
  version collide → one fails → retry (surfaced as HTTP 409, see
  [ARCHITECTURE.md](./ARCHITECTURE.md)). `stream_id`/`stream_seq` are
  therefore **writer-imposed, not server-derived** — the DB can't infer the
  aggregate.
- **Firehose.** Events needing no conditional append (telemetry, sensor
  readings) leave `stream_id` / `stream_seq` NULL and rely on global `seq`
  only; NULLs never collide under the unique constraint.
- **`occurred_at` defaults to `now()`** — same as `recorded_at`. The deployed
  writer (`server/src/infra/appender.ts`) does not pass it, so today the two
  are effectively identical (server clock). The column exists so clients and
  federated imports can supply actor-clock time; nothing does yet.
- `correlation_id` / `causation_id` in `metadata` link cause→effect chains.
- `signature` is nullable and unused — signing left core scope with
  federation; the column remains as a zero-cost affordance (see
  [ROADMAP.md](../ROADMAP.md)).
- Known redundancy: `event_stream_idx` duplicates the index that
  `UNIQUE (stream_id, stream_seq)` already creates. Harmless, costs one extra
  btree per insert; a future migration can drop it.

---

## Registry

### `event_type`

The vocabulary registry. Versioned; deprecated types remain readable forever
(see [EVENT-TYPES.md](./EVENT-TYPES.md)).

```sql
CREATE TABLE event_type (
  id          uuid        PRIMARY KEY,
  namespace   text        NOT NULL,
  name        text        NOT NULL,
  version     int         NOT NULL,
  schema      jsonb       NOT NULL,
  owner       text,
  status      text        NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (namespace, name, version)
);
```

- Fully-qualified type = `namespace.name@version`, e.g. `chat.message.posted@1`.
- Every payload written to `event` is validated against the matching `schema`
  by the DB trigger (below).
- Today the registry is populated only by `005_seed.sql` (7 types); there is
  no admin API yet, and the server additionally hardcodes the known types in
  `server/src/domain/eventTypes.ts`.

### `actor`

Everything that emits events is an Actor: humans, AI agents, devices,
organizations, projects, workflows.

```sql
CREATE TABLE actor (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL,
  handle        text        NOT NULL,
  display_name  text        NOT NULL,
  org_id        uuid        NOT NULL,
  public_key    text,
  status        text        NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (org_id, handle)
);
```

- `org_id` is a plain uuid (no FK — same append/federation rationale as
  `event`); the org root actor is its own org (`org_id = id`).
- **In the beta this table holds exactly one row**: the org root seeded by
  `005_seed.sql` (`kind='org'`, `handle='org'`). The server never reads or
  writes it. Live actors are created by `identity.actor.registered@1` events
  and folded into `actor_state` — the *projection* is the working registry of
  people; this table is the durable anchor for the org identity.
- Permissions, roles, and trust are **not** columns here — they are events
  (`identity.role.granted@1`, `identity.role.revoked@1`) projected into
  `actor_state.roles`.

---

## Projections

Rebuildable views over the log, maintained by the projectors in
`server/src/infra/projector.ts` folding the domain folds in
`server/src/domain/folds/`. Reading and rebuilding them is covered in
[EXAMPLES.md](./EXAMPLES.md).

### `actor_state`

Folded from `identity.*` events. The live actor registry: session resolution,
authz roles, and the actor list all read from here.

```sql
CREATE TABLE actor_state (
  actor_id        uuid    PRIMARY KEY,
  handle          text    NOT NULL,
  display_name    text    NOT NULL,
  kind            text    NOT NULL,
  status          text    NOT NULL,
  email           text    UNIQUE,
  roles           text[]  NOT NULL DEFAULT '{}',
  last_event_seq  bigint  NOT NULL
);
```

> **Caveat — `UNIQUE (email)` is load-bearing.** Projections are nominally
> disposable, but this constraint enforces an invariant the log itself does
> not: one actor per email. The registration path
> (`server/src/app/identity.ts`) relies on it as the last line of defense
> against concurrent first-logins racing to register the same email. That
> means (a) a rebuild must keep the constraint, and (b) if the log ever
> acquires two `actor.registered` events for one email (e.g. a careless
> federated import), replay *fails* instead of silently folding. The invariant
> really belongs in the write path per the event-sourcing catechism; for the
> beta it lives here, deliberately.

### `chat_thread`

Folded from `chat.thread.created@1`.

```sql
CREATE TABLE chat_thread (
  thread_id       uuid        PRIMARY KEY,
  title           text        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL,
  last_event_seq  bigint      NOT NULL
);
```

### `chat_message`

Folded from `chat.message.posted/edited/deleted@1`. Deletes are soft
(`deleted` flag) — the log keeps everything.

```sql
CREATE TABLE chat_message (
  message_id      uuid        PRIMARY KEY,
  thread_id       uuid        NOT NULL,
  author_id       uuid        NOT NULL,
  body            text        NOT NULL,
  posted_at       timestamptz NOT NULL,
  edited_at       timestamptz,
  deleted         boolean     NOT NULL DEFAULT false,
  last_event_seq  bigint      NOT NULL
);
CREATE INDEX chat_message_thread_idx ON chat_message (thread_id, posted_at);
```

### `projection_checkpoint`

One row per projector; how far each has folded the log.

```sql
CREATE TABLE projection_checkpoint (
  name            text        PRIMARY KEY,
  last_event_seq  bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
```

`005_seed.sql` seeds `('identity', 0)` and `('chat', 0)`. A new projection
needs its checkpoint row seeded before its projector will run.

The digital-twin read model (`twin_type`, `twin`) is a **proposal, not
schema** — no twin tables exist in any migration. See
[proposals/TWINS.md](./proposals/TWINS.md). A `grant`/delegation read model is
likewise future work — see [ROADMAP.md](../ROADMAP.md).

---

## Operational

### `login_token`

Magic-link auth plumbing. **Deliberately not event-sourced**: tokens are
short-lived secrets with no historical value, and credentials do not belong in
an immutable log. This is the one table that is neither log, registry, nor
rebuildable — and losing it costs nothing but pending logins.

```sql
-- operational, ephemeral; NOT event-sourced (auth plumbing)
CREATE TABLE login_token (
  token_hash  text        PRIMARY KEY,
  email       text        NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_token_email_idx ON login_token (email);
```

- Only the **hash** of the token is stored; the raw token exists once, in the
  magic link.
- Single-use (`used_at`), time-boxed (`expires_at`).

---

## Validation & Fan-out

Three distinct roles — do not conflate them.

### 1. Validation — DB trigger (correctness)

The trigger is the only chokepoint every writer crosses (humans, AI, devices,
federated imports). In an append-only log, invalid data is permanent, so
validation must be authoritative at the log, not just at the client.

Deployed code, verbatim from `003_triggers.sql` — the qualification and cast
are load-bearing, per the migration's own comments:

```sql
CREATE OR REPLACE FUNCTION event_validate() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  SELECT schema INTO s FROM event_type WHERE id = NEW.event_type_id;
  IF s IS NULL THEN
    RAISE EXCEPTION 'unknown event_type %', NEW.event_type_id USING ERRCODE = 'P0001';
  END IF;
  -- pg_jsonschema signature is jsonb_matches_schema(schema json, instance jsonb);
  -- event_type.schema is jsonb, so cast s::json (VERIFIED — passing jsonb errors "function does not exist").
  -- Schema-qualify as public.jsonb_matches_schema: the extension installs into public, but
  -- integration tests run with search_path = <test_schema> only (no public), so an unqualified
  -- call would error "function does not exist" inside a test schema (VERIFIED empirically).
  -- The SELECT above stays unqualified so it resolves event_type in the caller's schema.
  IF NOT public.jsonb_matches_schema(s::json, NEW.payload) THEN
    RAISE EXCEPTION 'payload fails schema for %.%@%', NEW.namespace, NEW.name, NEW.version
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_validate_trg BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_validate();
```

- The server also validates app-side (AJV) for **friendly** errors; the
  trigger is the **authoritative** gate for integrity. Belt + suspenders.
- Trigger rejections surface as HTTP 400 — see
  [ARCHITECTURE.md](./ARCHITECTURE.md) for the error mapping.

### 2. Fan-out — LISTEN/NOTIFY (wake signal only)

The `AFTER INSERT` trigger emits the new `seq` (NOTIFY has an 8 KB cap —
**never ship the payload**, only the cursor). Verbatim from
`003_triggers.sql`:

```sql
CREATE OR REPLACE FUNCTION event_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events', NEW.seq::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify_trg AFTER INSERT ON event
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

## Tenancy

**One org == one database.** There is no in-database multi-tenancy: no RLS, no
shared-schema discriminator. Each org is a sovereign node — the database *is*
the org boundary.

- The **local org** is the single seeded `actor` of `kind='org'`; its events
  carry `org_id = <local org>` by default.
- `org_id` is therefore **federation provenance** — it tags the *origin* org
  of an event — not a tenancy filter; every row in this DB belongs to this
  org's world.
- Federation by shipping append-only `event` rows between databases is future
  work — see [ROADMAP.md](../ROADMAP.md).

---

## Seed (`005_seed.sql`)

| Row | Value |
|---|---|
| Org root actor | `00000000-0000-7000-8000-00000000c0de`, `kind='org'`, `org_id = id` |
| Event types | `identity.actor.registered@1`, `identity.role.granted@1`, `identity.role.revoked@1`, `chat.thread.created@1`, `chat.message.posted@1`, `chat.message.edited@1`, `chat.message.deleted@1` |
| Checkpoints | `identity` and `chat`, both at `0` |

All inserts are `ON CONFLICT DO NOTHING` — the seed is idempotent. Payload
schemas for the 7 types are catalogued in [EVENT-TYPES.md](./EVENT-TYPES.md).

---

## Design Decisions

All resolved; kept here as rationale.

- ~~**id strategy**~~ — **Resolved:** `uuid v7` wherever a table has a
  surrogate `id` (`actor`, `event_type`, `event`),
  app-generated (PG16 has no native `uuidv7()`); `bigint seq` on `event` only,
  as canonical replay order. Complementary, not either/or — v7 gives identity
  + index locality, `seq` gives strict total order replay can't get from v7's
  same-ms/cross-node ties.
- ~~**Payload validation**~~ — **Resolved:** authoritative JSON Schema
  validation via `BEFORE INSERT` trigger (`pg_jsonschema`); LISTEN/NOTIFY as
  wake signal (seq only); `seq` + checkpoint for durable delivery. See
  [Validation & Fan-out](#validation--fan-out).
- ~~**Stream definition**~~ — **Resolved:** `stream_id` is the consistency
  boundary, **writer-imposed**, defaulting to `subject_id` but overridable to a
  coarser aggregate (thread, order, saga); NULL for firehose events. Distinct
  axis from `subject_id` (semantic grouping). Concurrency enforced solely by
  `UNIQUE (stream_id, stream_seq)`.
- ~~**Multi-tenancy**~~ — **Resolved:** none. **One org == one database**
  (DB-per-org); no RLS / shared-schema tenancy. `org_id` is federation
  provenance, not a tenancy discriminator. See [Tenancy](#tenancy).
- ~~**Foreign keys on the log**~~ — **Resolved:** `event.actor_id`,
  `event.org_id`, and `actor.org_id` carry no `REFERENCES` — append-path cost
  and federated imports outweigh DDL-level integrity; the writer is the gate.
  Only `event.event_type_id` is a real FK, because validation *requires* the
  registry row to exist.
- ~~**Auth tokens**~~ — **Resolved:** `login_token` is operational state, not
  event-sourced. Short-lived secrets have no place in an immutable log; the
  durable identity facts (`actor.registered`, `role.granted`) are events.
- ~~**Snapshots**~~ — **Resolved:** not a core concern. Projections plus their
  `last_event_seq` high-water marks already act as live snapshots;
  point-in-time replay optimization is **deferred to the org admin**, who can
  add their own views or snapshot tables as needed. Not built into the base
  schema.
