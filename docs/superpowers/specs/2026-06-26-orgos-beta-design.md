# OrgOS Beta — Design Spec

> Status: approved 2026-06-26. Scope: **Identity + Chat** slice of the OrgOS
> service plus a webapp with passwordless **email magic-link** auth. Grounds out
> the architecture in [doc/ARCH.md](../../../doc/ARCH.md),
> [doc/SCHEMA.md](../../../doc/SCHEMA.md), [doc/TYPES.md](../../../doc/TYPES.md),
> [doc/QUERY.md](../../../doc/QUERY.md).

## Goal

Ship the smallest slice that exercises the full OrgOS loop end-to-end —
**append → authoritative validate → project → live tail** — behind a real
REST API, with a webapp that authenticates via an email magic-link and renders
a live chat projection. This is the foundation every later projection (task,
twins, federation) reuses unchanged.

## Scope

**In:**
- Event-sourced core: `actor`, `event_type`, `event`, `projection_checkpoint`.
- Writer (append path) with optimistic concurrency and authoritative DB-trigger validation.
- Generic projector runtime + two projections: `chat_message`, `actor_state`.
- REST/JSON API + SSE live tail.
- Passwordless email magic-link login → `identity.actor.registered` event →
  `actor` row; signed HTTP-only cookie session. Auth sits behind an
  `IdentityProvider` seam so Google OAuth (or others) drop in later untouched.
- React/Vite webapp: email login, chat thread UI with live updates.

**Out (deferred, YAGNI for beta):** Google OAuth / other federated identity,
real email delivery (dev-mode console only), MCP transport, task/kanban,
twins/devices, federation, event signatures, full RBAC. Authz is scaffolded but
permissive.

## Stack

| Concern        | Choice                                                    |
|----------------|-----------------------------------------------------------|
| Language       | TypeScript, ESM, `strict: true`                           |
| Service        | Fastify (Node LTS), one process                           |
| DB driver      | `postgres.js` tagged-SQL, no ORM                          |
| Validation     | `pg_jsonschema` trigger (authoritative) + `ajv` app-side (friendly) |
| IDs            | uuid v7 generated **app-side** (no PG18 / extension dep)  |
| Wake/fan-out   | `LISTEN/NOTIFY` (seq only)                                 |
| Auth           | email magic-link (dev-mode console `Mailer`); cookie session |
| Webapp         | Vite + React + TypeScript                                  |
| Tests          | `vitest`; red/green TDD                                    |

**Infra dependency:** Postgres must have the `pg_jsonschema` extension. A
`docker-compose.yml` ships a Postgres image that includes it. uuid v7 is
generated in app code, so no `pg_uuidv7` / PG 18 requirement. **No external auth
provider is required** — the beta runs end-to-end with zero third-party creds.

## Repository layout

```
OrgOS/
  docker-compose.yml          # Postgres + pg_jsonschema for local dev/test
  server/                     # Fastify TS service
    package.json  tsconfig.json  .env.example
    migrations/
      001_extensions.sql      # CREATE EXTENSION pg_jsonschema
      002_core.sql            # actor, event_type, event, projection_checkpoint, login_token
      003_triggers.sql        # event_validate (BEFORE INSERT), event_notify (AFTER INSERT)
      004_projections.sql     # chat_message, actor_state read models
      005_seed.sql            # local org actor + identity.* & chat.* event_types
    src/
      config.ts               # env load (DATABASE_URL, SESSION_SECRET, WEB_ORIGIN, SERVER_PORT, MAGIC_LINK_TTL)
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
        mailer.ts             # Mailer interface + ConsoleMailer (logs/returns the link)
        loginTokens.ts        # issue/verify/consume single-use magic-link tokens (login_token table)
      app/
        commands.ts           # append use-case: authz + ajv friendly-validate + appender
        queries.ts            # read projections (chat thread, actors)
        authz.ts              # grant check from actor_state (permissive default)
        identity.ts           # IdentityProvider seam + find-or-register actor by email
      transport/
        rest.ts               # POST /events, GET /events, GET /projections/*, GET /twins/:id (stub)
        auth.ts               # POST /auth/request, GET /auth/callback, GET /auth/me, POST /auth/logout
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
      auth.tsx                # email-entry form, "check your email" state, session/me state
      Chat.tsx                # thread list + messages + composer; SSE live tail
```

## Architecture (layers — each depends only on the one below)

1. **Transport** — Fastify routes (REST), SSE hub, auth routes. Framing, auth,
   content-type. Translates a request into a *command* (→ writer) or *query*
   (→ read model).
2. **Application** — command handlers (append use-case), queries, authz checks,
   identity (find-or-register).
3. **Domain** — pure: the event-type registry (TS payload types + JSON Schemas)
   and fold functions `(state, event) => state`. No I/O. The same fold code the
   projector runs; unit-tested without a database.
4. **Infrastructure** — `postgres.js` pool, appender, generic projector,
   schema cache, uuid, mailer, login-token store. The only code that does I/O.
   Injected via the app factory (DI-for-testability, same pattern as
   `poemia-writer`).

## Data model (deltas from SCHEMA.md, beta subset)

- `actor`, `event_type`, `event`, `projection_checkpoint` exactly as SCHEMA.md.
- `event` carries denormalized `namespace`/`name`/`version`, `subject_id`,
  `stream_id`/`stream_seq` (nullable), `payload` jsonb. `UNIQUE(stream_id,
  stream_seq)` enforces concurrency; `UNIQUE(seq)` is the replay order.
- `login_token(token_hash PK, email, expires_at, used_at, created_at)` — an
  **operational, ephemeral** table (single-use, expiring magic-link tokens).
  Deliberately *not* event-sourced: it is auth plumbing, same category as the
  session cookie, not domain truth. The token value is never stored — only its
  hash. Registration of the actor *is* an event.
- Read models:
  - `chat_message(message_id PK, thread_id, author_id, body, posted_at,
    edited_at, deleted bool, last_event_seq)` — folded from `chat.message.*`.
  - `actor_state(actor_id PK, handle, display_name, kind, status,
    email UNIQUE, roles text[], last_event_seq)` — folded from `identity.*`.
    `email` indexes the login identity → actor mapping.

## Event types (seeded registry)

- `identity.actor.registered@1` — payload `{handle, display_name, kind, email}`.
  subject = actor id.
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

| Verb & path                          | Maps to                                    |
|--------------------------------------|--------------------------------------------|
| `POST /events`                       | append (writer)                            |
| `GET  /events?subject=&after=seq`    | replay/tail the log for a subject          |
| `GET  /projections/chat?thread=`     | chat thread read model                     |
| `GET  /projections/actors`           | actor_state read model                     |
| `GET  /twins/:id`                    | stub (501 / empty) — placeholder for later |
| `GET  /stream` (SSE)                 | NOTIFY-fed live tail                       |
| `POST /auth/request`                 | begin login: issue magic-link for an email |
| `GET  /auth/callback?token=`         | verify token, set session, 302 to web      |
| `GET  /auth/me`                      | current actor (or 401)                     |
| `POST /auth/logout`                  | clear session cookie                       |

- Stateless request/response; auth checked on every protected call. Live updates
  ride SSE, one NOTIFY-fed broadcast per connected client. Only `POST /events`
  touches the log; reads hit projections.

## Magic-link auth flow

1. `POST /auth/request { email }` — normalize the email; issue a random
   single-use token; store `sha256(token)` + `email` + `expires_at`
   (`MAGIC_LINK_TTL`, default 15 min) in `login_token`. Build the link
   `WEB_ORIGIN/auth/callback?token=<token>` (callback proxied to the service)
   and hand it to the injected `Mailer`. The **`ConsoleMailer`** logs the full
   link to the server console and, in dev, the endpoint returns it in the JSON
   response for convenience. Always responds `200` regardless of whether the
   email is known (no account enumeration).
2. `GET /auth/callback?token` — hash the token, look up an unexpired, unused
   `login_token`; mark it `used_at = now()` atomically (single-use). On miss /
   expiry → `400`.
3. Resolve actor via the `IdentityProvider`: look up `actor_state.email`. If
   absent, append `identity.actor.registered@1` (handle derived from the email
   local-part, `kind='human'`, `email`) — the projector inserts the `actor` row.
4. Set a signed, HTTP-only, `SameSite=Lax` session cookie carrying `actor_id`;
   302 back to `WEB_ORIGIN`.
5. `GET /auth/me` returns the actor from the session; `POST /auth/logout` clears
   the cookie.

**`IdentityProvider` seam.** `app/identity.ts` exposes
`resolveActor(claim: { email, name? }) → actor_id`, doing find-or-register
against `actor_state`. Magic-link supplies the verified `email`; a future
`GoogleProvider` would supply the same shape from an `id_token`. The transport
verb differs per provider; the find-or-register core is shared and is the unit
under test.

**Testability.** `Mailer` and the token store are injected. Unit tests use a
fake `Mailer` (captures the link, asserts no real send) and exercise
issue→verify→consume + find-or-register with an in-memory/throwaway store. No
network calls anywhere in the auth path.

## Authz (beta)

`actor_state.roles` is folded from `identity.role.*`. `app/authz.ts` exposes
`canAppend(actor, type, stream)` — beta default: any authenticated actor may
append `chat.*` and `identity.actor.registered`; role grants/revokes are
honored if present but no UI drives them. Full RBAC is deferred.

## Webapp

- `auth.tsx` — calls `GET /auth/me`; if 401 shows an email-entry form that
  `POST /auth/request`s, then a "check your email" state (in dev, surfaces the
  returned link directly). After the callback redirect, `/auth/me` populates
  session state.
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
- Auth: `POST /auth/request` always `200` (no enumeration); invalid / expired /
  already-used token at callback → `400`; missing session on a protected route
  → `401`.
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
   rebuild-from-zero, login-token issue/expire/single-use semantics.
3. **Application:** command authz + validate with a fake appender; identity
   find-or-register and the full magic-link issue→verify→consume cycle with a
   fake `Mailer`.
4. Each unit is built test-first; the task is not done until its tests pass.

## Milestones (implementation order)

1. Repo scaffold: `server/` + `web/` packages, tsconfig, docker-compose, migrations 001–002.
2. Domain: event-type registry + folds (chat, actor_state) — test-first.
3. Infra: db, uuid, appender (+ triggers migration 003), schema cache — integration tests.
4. Infra: generic projector + projections migration 004 + seed 005 — integration tests.
5. Application: commands, queries, authz, identity — tests with fakes.
6. Transport: REST + SSE — wire app factory; integration smoke test.
7. Transport + infra: magic-link auth (`/auth/*`, `mailer`, `loginTokens`) + cookie session — tests with fake Mailer.
8. Webapp: auth + chat UI + SSE; Vite proxy.
9. End-to-end manual run via docker-compose; README quickstart.

## Open dependencies the user provides

- **None for auth** — the beta runs with the dev-mode console mailer out of the
  box. `server/.env` only needs `DATABASE_URL` and a `SESSION_SECRET` (any random
  string; `.env.example` provides a placeholder). Real email delivery and Google
  OAuth are post-beta and slot in behind the `Mailer` / `IdentityProvider` seams.

## Ports (defaults)

- Service (Fastify): `8787` (`SERVER_PORT`).
- Webapp (Vite dev): `5173`, proxying `/auth`, `/events`, `/projections`,
  `/stream` to `http://localhost:8787`.
- `WEB_ORIGIN=http://localhost:5173` for the post-login redirect and CORS.
