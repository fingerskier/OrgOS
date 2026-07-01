# Architecture

> How the running system is built — **as built**, not as imagined.
> [SCHEMA.md](./SCHEMA.md) defines *what is stored*; this document defines
> *what executes*; anything unbuilt lives in [ROADMAP.md](../ROADMAP.md).
> The stack is **TypeScript** (Node, ESM, strict) over **Postgres**.
> One org == one process talking to one database.

The whole system is three moving parts:

```
   web app ──────HTTP/REST──┐
   any client ──HTTP────────┼──▶  Fastify service   ──▶  Postgres
        ▲                   │    (append + project)      (log + projections)
        └───SSE (seq tail)──┘            ▲                       │
                                         └─────LISTEN/NOTIFY─────┘
```

The service is the operating system between the database and the world.
It owns no truth — Postgres holds the log, the service mediates access to it.

---

## Layers

Higher layers depend on lower ones — never the reverse, with one deliberate
exception: infra's projector executes the domain's folds. Domain stays pure.
`server/src/` mirrors this layout.

```
┌──────────────────────────────────────────────────────┐
│  Transport      REST routes · auth routes · SSE hub  │  transport/
├──────────────────────────────────────────────────────┤
│  Application    commands · queries · authz · identity│  app/
├──────────────────────────────────────────────────────┤
│  Domain         event types · folds                  │  domain/  — pure, no I/O
├──────────────────────────────────────────────────────┤
│  Infrastructure postgres.js · appender · projector   │  infra/   — the only I/O
└──────────────────────────────────────────────────────┘
```

- **Domain is pure.** Fold functions (`(state, event) => state`), payload
  schemas, and type definitions have zero I/O — unit-testable without a
  database, and the same code the projector runs.
- **Infrastructure is the only I/O.** One `postgres.js` tagged-SQL client
  (`infra/db.ts`), the append path, the projector runtime, login tokens, and
  the mailer. Everything else receives these as dependencies.
- **No ORM.** Raw tagged SQL via `postgres.js`. Migrations are numbered `.sql`
  files under `server/migrations/`, applied in order by
  `src/infra/migrate.ts` (`npm run migrate`), each in its own transaction,
  tracked in a `schema_migration` table.
- **DI via `buildApp(cfg, inject)`.** The server is a factory; tests inject a
  throwaway `sql` handle and run against isolated Postgres schemas. `Mailer`
  and the identity provider are explicit seams (see Identity below).

---

## The Service

A single long-lived Node process per org, running the writer and the
projector in-process.

### Writer (the append path)

Every state change enters the world as an `event` INSERT. The writer is the
narrow waist every client crosses.

```
POST /events ─▶ session cookie → actor ─▶ canAppend (authz) ─▶ ajv validate ─▶ INSERT event
                                                                       │
                                     BEFORE INSERT trigger: pg_jsonschema (authoritative)
                                     UNIQUE(stream_id, stream_seq): optimistic concurrency
                                     AFTER  INSERT trigger: pg_notify('events', seq)
```

- **Authz runs before the append, always.** `canAppend(actor, type)` gates the
  command layer; a refusal never reaches the database.
- **Dual validation — ajv friendly, pg_jsonschema authoritative.** The app
  validates against the compiled schema for good error messages; the
  `BEFORE INSERT` trigger is the gate that makes invalid data impossible.
  The trigger must call `public.jsonb_matches_schema(schema::json, NEW.payload)`
  — schema-qualified *and* cast. Both are empirically required: the extension
  installs into `public` (invisible under a test-schema `search_path`), and
  the function takes `json`, not `jsonb` (see `003_triggers.sql`).
- **Optimistic concurrency is the writer's job.** The caller asserts
  `streamSeq = N`; `UNIQUE(stream_id, stream_seq)` rejects collisions; the
  appender maps the `23505` to a `ConcurrencyError` carrying the stream's
  current version, surfaced as `409`. A `null` `streamId` (firehose event)
  can never collide — NULLs are distinct under the constraint.
- **Schema cache.** The appender caches `namespace.name@version → event_type.id`
  in-process and reloads once on a miss. Types are registered by seed
  migration today — seven of them; the vocabulary is
  [EVENT-TYPES.md](./EVENT-TYPES.md).
- **Append is the only write.** No `UPDATE`/`DELETE` of domain data ever
  leaves the service. Corrections are new events (`chat.message.edited@1`,
  `chat.message.deleted@1`).

### Projector (the read path)

Projections are rebuilt by folding the log. The runtime (`infra/projector.ts`)
is generic; each projection supplies a namespace filter and a fold. Two exist:
`identity` → `actor_state`, `chat` → `chat_thread` + `chat_message`.

```
tick():
  1. read projection_checkpoint.last_event_seq
  2. SELECT * FROM event WHERE seq > checkpoint AND namespace = ANY(filter)
     ORDER BY seq LIMIT 1000
  3. fold rows, upsert read model, advance checkpoint — one transaction
  4. if the filter matched nothing, fast-forward the checkpoint to the
     global head seq
```

- **Durability comes from `seq` + checkpoint, never from NOTIFY.** NOTIFY
  carries only the new `seq`; a missed notification costs latency, not
  correctness — the next catch-up closes the gap.
- **Checkpoints fast-forward past filtered events.** A projection's checkpoint
  advances to the global head even when its namespace filter skipped every
  row, so `seq > checkpoint` never re-scans foreign namespaces.
- **Checkpoint advance is transactional** with the read-model upsert; a fold
  error rolls the batch back and leaves the checkpoint untouched. Folds are
  idempotent via each row's `last_event_seq`.
- **Single-node today, and deliberately so.** The projector ticks at boot and
  synchronously after every API append — so a `201` from `POST /events` means
  the projections already reflect it (read-your-writes). `start()`
  (tick + `LISTEN`) exists for a future split deployment but is never called.
  Consequence: events appended out-of-band (e.g. via `psql`) project only on
  the next API append or restart.
- **Rebuild = truncate the read model + reset the checkpoint to 0 + tick.**
  Any projection can be thrown away and replayed from the log. New projections
  must seed a `projection_checkpoint` row (see [EXAMPLES.md](./EXAMPLES.md)).

---

## API Surface

One transport: REST over HTTP/JSON, plus an SSE tail. Reads hit projections;
only `POST /events` touches the log. **Every event and projection route
requires the signed session cookie** — there is no unauthenticated read.

| Verb & path                        | Auth   | Behavior                                                        |
|------------------------------------|--------|------------------------------------------------------------------|
| `POST /events`                     | cookie | append `{type, subjectId, streamId, streamSeq, payload, metadata?}` → `201 {id, seq}` |
| `GET /events?subject=&after=`      | cookie | timeline for one subject; `subject` is **required** (no global log read); `after` defaults to 0 |
| `GET /projections/actors`          | cookie | `actor_state` list                                               |
| `GET /projections/threads`         | cookie | `chat_thread` list                                               |
| `GET /projections/chat?thread=`    | cookie | thread messages + `streamVersion` (feeds the next append's `streamSeq`) |
| `GET /twins/:id`                   | —      | `501` — twins are a proposal ([proposals/TWINS.md](./proposals/TWINS.md)) |
| `GET /stream`                      | cookie | SSE live tail (below)                                            |
| `POST /auth/request`               | none   | issue magic link; `200` for any well-formed email (no account enumeration), malformed → `400`; dev mode returns `devLink` |
| `GET /auth/callback?token=`        | none   | consume token → resolve actor → set session cookie → `302` to the web app |
| `GET /auth/me`                     | cookie | current actor's `actor_state` row, else `401`                    |
| `POST /auth/logout`                | none   | clear the session cookie                                         |

The three projection routes are hardcoded; a generic `/projections/:name` is
roadmap, not reality.

**SSE contract:** the hub `LISTEN`s on the `events` channel and, per committed
append, writes `event: append` with the bare `seq` as data — no payload, no
heartbeat, no resume/`Last-Event-ID`. Clients treat it as a wake signal and
refetch the projections they care about.

---

## Identity & Sessions

Magic-link email, not passwords and not public keys.

- **`login_token` is deliberately NOT event-sourced.** Auth plumbing, like the
  session cookie itself — not domain truth. Only `sha256(token)` is stored;
  consumption is a single atomic `UPDATE … WHERE used_at IS NULL AND
  expires_at > now() RETURNING email` (single-use by construction); TTL
  defaults to 15 minutes. The actor's *registration* IS an event.
- **Session = signed cookie.** HTTP-only, `SameSite=Lax`, `Secure` in
  production, carrying the `actor_id`. `unsignSid` (`transport/auth.ts`) is
  the **single trusted gate** from cookie to identity — every code path that
  turns a request into an actor goes through it. A valid signature naming an
  unknown actor is still a `401`.
- **First login is an event.** `resolveActor({email})` finds the actor in
  `actor_state` or appends `identity.actor.registered@1` (subject = stream =
  the new actor id, `streamSeq` 1); the identity projection creates the row.
  Concurrent first logins for one email are serialized with
  `pg_advisory_xact_lock(hashtext(email))`; the loser re-checks the log and
  returns the winner's actor.
- **Seams for later.** `resolveActor` is the IdentityProvider seam — Google
  OAuth would supply the same verified-email claim from an `id_token`. The
  `Mailer` interface ships as `ConsoleMailer` (logs the link); real delivery
  drops in behind it. Neither swap touches the core.
- The `actor.public_key` and `event.signature` columns exist but are unused —
  schema affordances for future signed events, nothing more.

---

## Authorization

Permissions are events, checked app-side before the writer appends.

- **Beta policy** (`app/authz.ts`): any authenticated actor may append
  `chat.*` and `identity.actor.registered@1`; every other type requires the
  `admin` role. Full RBAC is roadmap.
- **Roles fold from the log.** `identity.role.granted@1` / `identity.role.revoked@1`
  fold into `actor_state.roles` — authorization is reproducible from the log
  like everything else.

---

## Error Contract

| Status | Condition                                                                 | Source                        |
|--------|---------------------------------------------------------------------------|-------------------------------|
| `401`  | missing/invalid session cookie, or a valid cookie naming an unknown actor | `requireActor`                |
| `403`  | `canAppend` refused the event type                                         | `AuthzError`                  |
| `400`  | ajv rejects the payload · unknown event type · DB trigger rejects (`P0001`) · missing required query param · malformed email · bad/expired magic link | `ValidationError` + route checks |
| `409`  | `stream_seq` collision (`23505`) — body carries `currentVersion`, the stream's max `stream_seq` | `ConcurrencyError`            |

The beta spec's `422` for trigger rejects was folded into `400`: ajv catches
the same cases first, so both validators surface as one `ValidationError`
(recorded deviation — see the
[archived spec](./archive/2026-06-26-beta/spec.md)).

---

## Request Lifecycle (end to end)

A chat message, start to finish:

```
1. POST /events { type: "chat.message.posted@1", subjectId: <msg>,
                  streamId: <thread>, streamSeq: 42, payload: { body } }
2. transport   unsignSid verifies the cookie → actor_state lookup → ActorCtx
3. app         canAppend(actor, type) → ajv validates the payload
4. infra       INSERT event — BEFORE trigger validates (pg_jsonschema),
               UNIQUE(stream) enforces the version, AFTER trigger NOTIFYs
5. app         synchronous projector tick folds the row into chat_message
6. transport   201 { id, seq } — projections already current
7. SSE hub     LISTEN 'events' wakes → broadcasts `event: append` + seq
8. web         each connected client refetches its thread projection
```

One append, many projections — *one history, infinite presentations.*

---

## Stack & Conventions

| Concern         | Choice                                                                 |
|-----------------|------------------------------------------------------------------------|
| Language        | TypeScript, ESM, `strict: true`                                        |
| Runtime         | Node (LTS); one Fastify process per org, port 8787                     |
| DB driver       | `postgres.js` tagged SQL — no ORM, no separate pool layer              |
| Migrations      | numbered `.sql` in `server/migrations/`, run by `src/infra/migrate.ts` |
| Database        | `postgres:16` + `pg_jsonschema` v0.3.4 (custom image, `db/Dockerfile`) |
| Payload schemas | JSON Schema — ajv app-side, `pg_jsonschema` trigger authoritative      |
| IDs             | uuid v7, app-generated (`uuidv7` npm; PG16 has no native `uuidv7()`)   |
| Wake/fan-out    | `LISTEN/NOTIFY` carrying only the `seq`                                |
| Web             | React + Vite (5173); dev proxy keeps cookies same-origin               |
| Tests           | vitest, red/green TDD; pure folds unit-tested; integration against throwaway PG schemas |

- **The log is sacred.** No code path `UPDATE`s or `DELETE`s `event`. Every
  feature is "define an event type, append events, write a fold." If a
  feature seems to need mutation, it needs a new event instead.
- **Zero external credentials.** The beta runs end-to-end with only
  `DATABASE_URL` and `SESSION_SECRET` — see
  [DEVELOPMENT.md](./DEVELOPMENT.md).

---

## Tenancy & Provenance

**One org == one database.** No in-DB multi-tenancy, no RLS, no shared-schema
discriminator. The schema still honors three federation-era contracts, cheap
now and load-bearing later:

- `seq` is **local** — canonical replay order within this database, never
  compared across databases.
- `org_id` on every event is **provenance**, not a tenancy filter. Today it is
  one constant seeded org.
- IDs are **uuid v7 minted app-side**, so any node can generate them without
  coordination.

---

## Future

MCP transport for AI actors, federation by shipping `event` rows between
databases, event signatures, a generic `/projections/:name`, and logical
replication at scale are all deliberately unbuilt — see
[ROADMAP.md](../ROADMAP.md). The digital-twin design is preserved as a
proposal at [proposals/TWINS.md](./proposals/TWINS.md); the beta's frozen
spec, plan, and build ledger live under
[archive/2026-06-26-beta/](./archive/2026-06-26-beta/spec.md).
