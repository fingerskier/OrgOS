# OrgOS Beta — Design Spec

> Status: approved 2026-06-26. Scope: **Identity + Chat** slice of the OrgOS
> service plus a webapp with Google OAuth. Grounds out the architecture in
> [doc/ARCH.md](../../../doc/ARCH.md), [doc/SCHEMA.md](../../../doc/SCHEMA.md),
> [doc/TYPES.md](../../../doc/TYPES.md), [doc/QUERY.md](../../../doc/QUERY.md).

## Goal

Ship the smallest slice that exercises the full OrgOS loop end-to-end —
**append → authoritative validate → project → live tail** — behind a real
REST API, with a webapp that authenticates via Google OAuth and renders a live
chat projection. This is the foundation every later projection (task, twins,
federation) reuses unchanged.

## Scope

**In:**
- Event-sourced core: `actor`, `event_type`, `event`, `projection_checkpoint`.
- Writer (append path) with optimistic concurrency and authoritative DB-trigger
  validation.
- Generic projector runtime + two projections: `chat_message`, `actor_state`.
- REST/JSON API + SSE live tail.
- Google OAuth2 login → `identity.actor.registered` event → `actor` row;
  signed HTTP-only cookie session.
- React/Vite webapp: Google login, chat thread UI with live updates.

**Out (deferred, YAGNI for beta):** MCP transport, task/kanban, twins/devices,
federation, event signatures, full RBAC. Authz is scaffolded but permissive.

## Stack

| Concern        | Choice                                                    |
|----------------|-----------------------------------------------------------|
| Language       | TypeScript, ESM, `strict: true`                           |
| Service        | Fastify (Node LTS), one process                           |
| DB driver      | `postgres.js` tagged-SQL, no ORM                          |
| Validation     | `pg_jsonschema` trigger (authoritative) + `ajv` app-side (friendly) |
| IDs            | uuid v7 generated **app-side** (no PG18 / extension dep)  |
| Wake/fan-out   | `LISTEN/NOTIFY` (seq only)                                 |
| Webapp         | Vite + React + TypeScript                                  |
| Tests          | `vitest`; red/green TDD                                    |

**Infra dependency:** Postgres must have the `pg_jsonschema` extension. A
`docker-compose.yml` ships a Postgres image that includes it. uuid v7 is
generated in app code, so no `pg_uuidv7` / PG 18 requirement.

## Repository layout

```
OrgOS/
  docker-compose.yml          # Postgres + pg_jsonschema for local dev/test
  server/                     # Fastify TS service
    package.json  tsconfig.json  .env.example
    migrations/
      001_extensions.sql      # CREATE EXTENSION pg_jsonschema
      002_core.sql            # actor, event_type, event, projection_checkpoint
      003_triggers.sql        # event_validate (BEFORE INSERT), event_notify (AFTER INSERT)
      004_projections.sql     # chat_message, actor_state read models
      005_seed.sql            # local org actor + identity.* & chat.* event_types
    src/
      config.ts               # env load (DATABASE_URL, GOOGLE_*, SESSION_SECRET, WEB_ORIGIN)
      domain/                 # PURE — zero I/O, unit-testable
        eventTypes.ts         # registry: namespace.name@version → { tsType, jsonSchema }
        folds/
          chat.ts             # chat thread fold (posted/edited/deleted)
          actorState.ts       # identity.* fold → actor projection + grants
      infra/
        db.ts                 # postgres.js pool factory (injected)
        appender.ts           # INSERT event; optimistic concurrency → 409
        projector.ts          # generic: checkpoint→catch-up→fold→upsert→LISTEN
        schemaCache.ts        # event_type schema cache, invalidated on event_type.*
        uuid.ts               # uuid v7 generator
      app/
        commands.ts           # append use-case: authz + ajv friendly-validate + appender
        queries.ts            # read projections (chat thread, actors)
        authz.ts              # grant check from actor_state (permissive default)
      transport/
        rest.ts               # POST /events, GET /events, GET /projections/*, GET /twins/:id (stub)
        auth.ts               # /auth/google, /callback, /me, /logout; cookie session
        sse.ts                # GET /stream — NOTIFY-fed broadcast hub
      server.ts               # app factory: compose infra+app+transport via DI; listen
    test/
      domain/                 # pure fold unit tests (no DB)
      integration/            # append+project against throwaway PG (DATABASE_URL_TEST)
  web/                        # Vite + React + TS
    package.json  index.html  tsconfig.json
    src/
      main.tsx  App.tsx
      api.ts                  # fetch wrapper (credentials: 'include')
      auth.tsx                # "Sign in with Google", session/me state
      Chat.tsx                # thread list + messages + composer; SSE live tail
```

## Architecture (layers — each depends only on the one below)

1. **Transport** — Fastify routes (REST), SSE hub, OAuth routes. Framing, auth,
   content-type. Translates a request into a *command* (→ writer) or *query*
   (→ read model).
2. **Application** — command handlers (append use-case), queries, authz checks.
3. **Domain** — pure: the event-type registry (TS payload types + JSON Schemas)
   and fold functions `(state, event) => state`. No I/O. The same fold code the
   projector runs; unit-tested without a database.
4. **Infrastructure** — `postgres.js` pool, appender, generic projector,
   schema cache, uuid. The only code that does I/O. Injected via the app
   factory (DI-for-testability, same pattern as `poemia-writer`).

## Data model (deltas from SCHEMA.md, beta subset)

- `actor`, `event_type`, `event`, `projection_checkpoint` exactly as SCHEMA.md.
- `event` carries denormalized `namespace`/`name`/`version`, `subject_id`,
  `stream_id`/`stream_seq` (nullable), `payload` jsonb. `UNIQUE(stream_id,
  stream_seq)` enforces concurrency; `UNIQUE(seq)` is the replay order.
- Read models:
  - `chat_message(message_id PK, thread_id, author_id, body, posted_at,
    edited_at, deleted bool, last_event_seq)` — folded from `chat.message.*`.
  - `actor_state(actor_id PK, handle, display_name, kind, status,
    google_sub UNIQUE, roles text[], last_event_seq)` — folded from
    `identity.*`. `google_sub` indexes the OAuth identity → actor mapping.

## Event types (seeded registry)

- `identity.actor.registered@1` — payload `{handle, display_name, kind,
  google_sub, email}`. subject = actor id.
- `identity.role.granted@1` / `identity.role.revoked@1` — payload `{role}`.
  subject = actor id. (Scaffolds authz; not exercised by the beta UI.)
- `chat.thread.created@1` — payload `{title}`. subject = stream = thread id.
- `chat.message.posted@1` — payload `{body}`. subject = message id, stream =
  thread id.
- `chat.message.edited@1` — payload `{body, edits_event_id}`. subject = message.
- `chat.message.deleted@1` — payload `{}`. subject = message, stream = thread.

Each registered with its JSON Schema; `ajv` compiles the same schemas app-side.

## Append path (writer)

```
POST /events { type, subject_id, stream_id, stream_seq, payload }
  → transport: authenticate actor from session cookie
  → application: authz (may actor append this type to this stream?) + ajv friendly-validate
  → infra/appender: build row (uuid v7, denormalized name parts) → INSERT event
       └ BEFORE INSERT trigger validates payload vs event_type.schema (authoritative)
       └ UNIQUE(stream_id, stream_seq) enforces optimistic concurrency
  → COMMIT → AFTER INSERT trigger pg_notify('events', seq)
```

- The appender catches the unique-violation (SQLSTATE `23505` on the stream
  constraint) → surfaces `409 Conflict` with the current stream version.
- `stream_id`/`stream_seq` are writer-imposed (default `stream_id = subject_id`).
  Firehose events (none in beta) would leave them NULL.

## Projector (read path)

Generic runtime; each projection supplies a filter + a fold + an upsert.

```
on startup / reconnect:
  1. read projection_checkpoint.last_event_seq
  2. catch-up: SELECT * FROM event WHERE seq > checkpoint ORDER BY seq LIMIT N (loop)
  3. fold rows, upsert read model, advance checkpoint — same transaction
  4. LISTEN events
  5. on NOTIFY(seq): goto 2
```

- Durability from `seq` + checkpoint; NOTIFY is latency-only. Folds idempotent
  w.r.t. `last_event_seq` (skip events `seq <= last_event_seq`).
- Rebuild = truncate read model + reset checkpoint to 0 + replay.
- Beta runs the chat + actor_state projectors in the same process as the writer
  (single Node process per org). Split is a later deployment concern only.

## REST surface

| Verb & path                          | Maps to                                  |
|--------------------------------------|------------------------------------------|
| `POST /events`                       | append (writer)                          |
| `GET  /events?subject=&after=seq`    | replay/tail the log for a subject        |
| `GET  /projections/chat?thread=`     | chat thread read model                   |
| `GET  /projections/actors`           | actor_state read model                   |
| `GET  /twins/:id`                    | stub (501 / empty) — placeholder for later |
| `GET  /stream` (SSE)                 | NOTIFY-fed live tail                      |
| `GET  /auth/google`                  | begin OAuth (302 to Google)              |
| `GET  /auth/google/callback`         | finish OAuth, set session, 302 to web    |
| `GET  /auth/me`                      | current actor (or 401)                   |
| `POST /auth/logout`                  | clear session cookie                     |

- Stateless request/response; auth checked on every protected call. Live updates
  ride SSE, one NOTIFY-fed broadcast per connected client. Only `POST /events`
  touches the log; reads hit projections.

## Google OAuth flow

1. `GET /auth/google` — generate `state` + PKCE verifier, store in a short-lived
   signed cookie, 302 to Google's consent URL (`scope=openid email profile`).
2. `GET /auth/google/callback?code&state` — verify `state`, exchange `code`
   (with PKCE verifier) for tokens, verify the `id_token` signature/audience,
   extract `{ sub, email, name }`.
3. Resolve actor: look up `actor_state.google_sub = sub`. If absent, append
   `identity.actor.registered@1` (handle derived from email, `kind='human'`,
   `google_sub`, `email`) — the projector inserts the `actor` row.
4. Set a signed, HTTP-only, `SameSite=Lax` session cookie carrying `actor_id`;
   302 back to `WEB_ORIGIN`.
5. `GET /auth/me` returns the actor from the session; `POST /auth/logout` clears
   the cookie.

**Testability:** the Google token verifier and code-exchange are injected
(interface `GoogleVerifier`), so unit tests substitute a fake that returns a
fixed `{sub,email,name}` — no live Google calls. The actor-resolution logic
(find-or-register) is the unit under test.

## Authz (beta)

`actor_state.roles` is folded from `identity.role.*`. `app/authz.ts` exposes
`canAppend(actor, type, stream)` — beta default: any authenticated actor may
append `chat.*` and `identity.actor.registered`; role grants/revokes are
honored if present but no UI drives them. Full RBAC is deferred.

## Webapp

- `auth.tsx` — calls `GET /auth/me`; if 401 shows a "Sign in with Google" button
  linking to `GET /auth/google`. On return, `/auth/me` populates session state.
- `Chat.tsx` — lists threads (`GET /projections/actors` for names,
  `GET /projections/chat?thread=` for messages), a composer that `POST /events`
  a `chat.message.posted@1` with the client-asserted `stream_seq`, and an
  `EventSource('/stream')` subscription that re-fetches/patches the thread on new
  `seq`. All fetches use `credentials: 'include'`.
- Vite dev server proxies `/auth`, `/events`, `/projections`, `/stream` to the
  Fastify service so cookies stay same-origin in dev.

## Error handling

- Append: ajv failure → `400` with field detail; trigger failure → `422`
  (authoritative reject); unique-violation → `409` with current stream version;
  unknown `event_type` → `400`.
- Auth: bad/expired `state` → `400`; token verify failure → `401`; missing
  session on protected route → `401`.
- Projector: a fold error logs and halts that projector (does not advance
  checkpoint) so it can be fixed and resumed; the log is untouched.
- SSE: dropped client connections are pruned from the broadcast hub.

## Testing strategy (red/green TDD)

1. **Domain (pure, no DB):** fold unit tests — chat (posted→edited→deleted
   sequences, idempotent replay, out-of-order skip via `last_event_seq`) and
   actor_state (register, grant, revoke).
2. **Infra integration (throwaway PG, `DATABASE_URL_TEST`):** appender
   round-trips, optimistic-concurrency 409 on colliding `stream_seq`, trigger
   rejects schema-invalid payload, projector catch-up + checkpoint advance +
   rebuild-from-zero.
3. **Application:** command authz + validate with a fake appender; auth
   find-or-register with a fake `GoogleVerifier`.
4. Each unit is built test-first; the task is not done until its tests pass.

## Milestones (implementation order)

1. Repo scaffold: `server/` + `web/` packages, tsconfig, docker-compose, migrations 001–002.
2. Domain: event-type registry + folds (chat, actor_state) — test-first.
3. Infra: db, uuid, appender (+ triggers migration 003), schema cache — integration tests.
4. Infra: generic projector + projections migration 004 + seed 005 — integration tests.
5. Application: commands, queries, authz — tests with fakes.
6. Transport: REST + SSE — wire app factory; integration smoke test.
7. Transport: Google OAuth (`/auth/*`) + cookie session — tests with fake verifier.
8. Webapp: auth + chat UI + SSE; Vite proxy.
9. End-to-end manual run via docker-compose; README quickstart.

## Open dependencies the user provides

- Google Cloud OAuth **Client ID + Secret** (and authorized redirect URI
  `http://localhost:8787/auth/google/callback`), pasted into `server/.env`.

## Ports (defaults)

- Service (Fastify): `8787` (`SERVER_PORT`).
- Webapp (Vite dev): `5173`, proxying `/auth`, `/events`, `/projections`,
  `/stream` to `http://localhost:8787`.
- `WEB_ORIGIN=http://localhost:5173` for the post-login redirect and CORS.
