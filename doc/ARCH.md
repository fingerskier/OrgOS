# Core Architecture

> How the running system is built. [SCHEMA.md](./SCHEMA.md) defines *what is
> stored*; this document defines *what executes*. The stack is **TypeScript**
> (Node, ESM, strict) over **Postgres**. One org == one process talking to one
> database.

The whole system is three moving parts:

```
   clients ──HTTP/REST──┐
   AI agents ──MCP───────┼──▶  TypeScript Service  ──▶  Postgres
   devices ──HTTP────────┘        (append + project)      (log + projections)
                                         ▲                       │
                                         └────LISTEN/NOTIFY──────┘
```

The service is the operating system between the database and the world.
It owns no truth — Postgres holds the log, the service mediates access to it.

---

## Layers

Top to bottom, each layer depends only on the one below it.

```
┌───────────────────────────────────────────────┐
│  Transport      REST router · MCP server      │  framing, auth, content-type
├───────────────────────────────────────────────┤
│  Application    command handlers · queries    │  use-cases, validation, authz
├───────────────────────────────────────────────┤
│  Domain         event types · twin folds      │  pure functions, no I/O
├───────────────────────────────────────────────┤
│  Infrastructure pg pool · appender · projector│  the only code that does I/O
└───────────────────────────────────────────────┘
```

- **Domain is pure.**  Fold functions (`(state, event) => state`), payload
  schemas, and type definitions have zero I/O — they are unit-testable without a
  database and are the same code the projector runs.
- **Infrastructure is the only I/O.**  A single `pg` connection pool, the
  append path, and the projector runtime.  Everything else receives these as
  dependencies (constructor/closure injection) so the application layer tests
  against fakes.  (Same DI-for-testability pattern as `poemia-writer`'s app
  factory.)
- **No ORM.**  The schema is event-sourced, not relational-CRUD.  Use a thin
  query layer (`pg` + tagged SQL, e.g. `postgres.js` or `slonik`) over raw SQL. 
  Migrations via `node-pg-migrate` or plain numbered `.sql` files.

---

## The Service

A single long-lived Node process per org.
Internally it runs two cooperating roles that may share a process or split into separate deployments:

### Writer (the append path)

Every state change enters the world as an `event` INSERT. The writer is the
narrow waist every client crosses.

```
command ──▶ authz ──▶ resolve event_type ──▶ build row ──▶ INSERT event
                                                              │
                                          DB trigger validates payload (authoritative)
                                          UNIQUE(stream_id,stream_seq) enforces concurrency
```

- **Optimistic concurrency is the writer's job.** The caller asserts
  `stream_seq = N`; the DB's unique constraint rejects collisions; the writer
  catches the unique-violation and surfaces a `409 Conflict` (REST) /
  retryable error (MCP). The DB cannot infer the aggregate — the writer
  supplies `stream_id`/`stream_seq` (see SCHEMA → Optimistic concurrency).
- **Friendly validation app-side, authoritative validation in the trigger.**
  The service validates payloads against the cached `event_type.schema` for
  good error messages; the `BEFORE INSERT` trigger is the gate that makes
  invalid data impossible. Belt + suspenders — never rely on the app alone.
- **Schema cache.** `event_type` rows are slow-changing; cache them in-process
  keyed by `namespace.name@version`, invalidated on `event_type.*` events.
- **Append is the only write.** No `UPDATE`/`DELETE` of domain data ever leaves
  the service. Corrections are `*.corrected` / `*.archived` events.

### Projector (the read path)

Projections are rebuilt by folding the log.
The projector runtime is generic; each projection supplies a `(state, event) => state` fold and the event filter it cares about.

```
on startup / reconnect:
  1. read projection_checkpoint.last_event_seq
  2. CATCH-UP: SELECT * FROM event WHERE seq > checkpoint ORDER BY seq  ← correctness
  3. fold rows, upsert read model, advance checkpoint (same txn)
  4. LISTEN events                                                     ← latency only
  5. on NOTIFY(seq): goto 2
```

- **Durability comes from `seq` + checkpoint, never from NOTIFY.** NOTIFY is a
  wake signal carrying only the new `seq` (8 KB cap — never the payload).  A
  missed notification costs latency, not correctness: the next catch-up poll
  closes the gap.
- **Checkpoint advance is transactional** with the read-model upsert, so a
  projector crash mid-batch resumes cleanly (at-least-once fold; folds must be
  idempotent w.r.t. `last_event_seq`).
- **Rebuild = drop read model + reset checkpoint to 0.** Any projection can be
  thrown away and replayed from the log.  This is the core operational
  superpower and the reason the read side carries no irreplaceable state.
- **Twins are projections too** — folded over events whose `subject_id =
  twin.id`, validated against `twin_type.schema`.  See [TWINS.md](./TWINS.md).

---

## API Surface

Two transports, one application core.
Both are thin adapters that translate a request into either a *command* (→ writer) or a *query* (→ read model).

### REST (HTTP/JSON) — for humans & conventional clients

| Verb & path                         | Maps to                                   |
|-------------------------------------|-------------------------------------------|
| `POST /events`                      | append (body carries type, payload, stream assertion) |
| `GET  /events?subject=…&after=seq`  | tail/replay the log for a subject         |
| `GET  /twins/:id`                   | read a twin projection                    |
| `GET  /projections/:name/…`         | read any named projection (chat, kanban…) |
| `GET  /stream` (SSE)                | server-sent live tail, backed by LISTEN   |

- Stateless request/response; auth on every call.  Live updates ride **SSE**
  (one NOTIFY-fed broadcast per connected client) rather than bespoke sockets.
- Reads hit projections (fast, indexed); only `POST /events` touches the log.

### MCP — for AI actors

The same commands and queries exposed as MCP **tools** (`append_event`, `query_projection`, `read_twin`, `list_event_types`) and **resources** (projections as readable URIs).
AI agents are first-class actors: they append events through the identical writer path, subject to the same authz, validation, and concurrency rules as humans.
No privileged side door.

---

## Identity, Authz & Federation

- **Identity** — every request resolves to an `actor`.  Signatures verify
  against `actor.public_key`; events may be signed for non-repudiation.
- **Authz** — permissions are *events*, projected into `actor_state` / `grant`
  read models.  The application layer checks the projected grant before the
  writer appends.  Authorization is therefore itself reproducible from the log.
- **Federation = shipping `event` rows between databases.**  A federation worker
  is just another projector that reads selected namespaces/streams and re-appends
  foreign events locally, tagged with their origin `org_id`.  Append-only rows
  merge safely — nothing is mutated.  `seq` is local; cross-org order uses
  `occurred_at` + `signature` + `id`.  **One org == one database** (no in-DB
  multi-tenancy).  See SCHEMA → Federation & Tenancy.

---

## Stack & Conventions

| Concern         | Choice                                                       |
|-----------------|--------------------------------------------------------------|
| Language        | TypeScript, ESM, `strict: true`                              |
| Runtime         | Node (LTS); single process per org                           |
| DB driver       | `pg` pool via tagged-SQL layer (`postgres.js` / `slonik`) — no ORM |
| Migrations      | numbered SQL (`node-pg-migrate` or raw `.sql`)               |
| Payload schemas | JSON Schema, authoritative via `pg_jsonschema` trigger       |
| IDs             | uuid v7 (DB-native on PG 18+, else app-generated)            |
| Wake/fan-out    | `LISTEN/NOTIFY` now; logical replication (`wal2json`/Debezium) at scale |
| Tests           | red/green TDD; pure folds unit-tested; append/project against a throwaway PG |

- **Scaling path is built in, not bolted on.**  Single-node NOTIFY → logical replication keeps the same `seq` + checkpoint contract, so projectors don't change.  Partition `event` by `recorded_at` / `org_id` when volume demands it.
- **The log is sacred.**  No code path `UPDATE`s or `DELETE`s `event`.  Every feature is "define an event type, append events, write a fold."  If a feature seems to need mutation, it needs a new event instead.

---

## Request Lifecycle (end to end)

A chat message, start to finish:

```
1. POST /events  { type: "chat.message.posted@1", subject: <msg>, stream: <convo>, stream_seq: 42, payload: {...} }
2. transport      authenticate actor, parse body
3. application    check grant (actor may post to convo?), friendly-validate payload
4. writer         INSERT event …  ── trigger validates ──  UNIQUE(stream) enforced
5. Postgres       COMMIT → NOTIFY('events', seq)
6. chat projector LISTEN wakes → SELECT seq>checkpoint → fold → upsert chat read model
7. SSE clients    broadcast new row to connected chat UIs
```

One append, many projections — *one history, infinite presentations.*
