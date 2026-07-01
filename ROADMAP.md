# OrgOS Roadmap

> The single home for everything aspirational. [README.md](README.md) and `docs/` describe only what
> runs today (plus clearly-flagged designs in `docs/proposals/` and the frozen `docs/archive/`); if a
> feature is not implemented, it lives here — as **Next**, **Later**, or **Ejected**.
> Ground truth is the code (`server/src`, `server/migrations`, `web/src`); when this file and the code
> disagree, the code wins.

## What "viable" means

OrgOS v1 is viable when two things are true:

1. **A small org runs it daily.** A ~10-person team uses identity + chat plus a couple more
   projections every day, with real email delivery, without an operator babysitting the process.
2. **A stranger integrates in an afternoon.** A third-party producer or consumer — a cron bot, a
   webhook bridge, a digest script — goes from zero to working against documented endpoints and
   documented error codes, without reading server source.

**The scoping principle is the narrow waist.** The core is exactly the machinery that makes the
event log trustworthy and consumable — append, validate, order, project, notify — plus the minimum
identity, authz, and ops needed to run it daily. Everything else must prove it can be built as a
*client* of the public contract (`POST /events`, projection reads, `GET /stream`) without touching
the kernel. If a feature exercises and hardens that contract for the target user, it is on this
roadmap. If it serves a niche, a vertical, or a different product, it is ejected to a satellite
project — or dropped.

## Built today

The shipped surface is the Identity + Chat beta: magic-link email auth (hashed single-use tokens,
signed session cookie), `POST /events` through the single writer path (authz → ajv → insert →
DB-trigger validation, `409` optimistic concurrency), `GET /events?subject=&after=` for per-subject
log reads, three hardcoded projection routes (`/projections/actors`, `/projections/threads`,
`/projections/chat?thread=`), an auth-gated SSE tail at `GET /stream` carrying bare `seq` numbers,
and a `501` stub at `GET /twins/:id`. One hardcoded org, one database, one process. Email delivery
is `ConsoleMailer` (stdout) only. CI typechecks and tests both packages; the server suite runs
against a real Postgres with `pg_jsonschema`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
as-built design and [docs/EXAMPLES.md](docs/EXAMPLES.md) for working producer/consumer recipes.

## Phased roadmap to v1

No dates. Phases 1–2 are **Next**; phases 3–4 are **Later**. Order within a phase is priority order.

### Phase 1 — Harden the narrow waist *(Next)*

"Integrate in an afternoon" dies the first time a malformed POST returns a 500 or wedges a
projection forever. This phase is entirely about making the existing contract trustworthy.

| Item | Today | Target |
|------|-------|--------|
| Envelope-level validation | Omitting an envelope key crashes the handler — `subjectId`/`streamSeq` reach postgres.js and throw `UNDEFINED_VALUE`, a missing `type` throws a `TypeError` in `canAppend` — either way `500` | Validate the envelope before the DB is touched → `400` with a useful message |
| Message ownership authz | Any authenticated actor can `chat.message.edited/deleted` anyone's message | Author-or-admin check in `canAppend` |
| Admin bootstrap | Chicken-and-egg: `identity.role.granted@1` is admin-gated and no code path grants the first admin (today: one-time `psql` side-door append) | A documented bootstrap path (first-registered-actor rule, env-designated admin email, or CLI) |
| Projection-wedge prevention/recovery | A bad-but-valid append (e.g. `chat.message.posted@1` with `streamId: null`) commits, then permanently wedges the chat projector on a `NOT NULL` column; checkpoint never advances | Reject at append time where possible; quarantine/skip-and-log at fold time otherwise; a documented recovery procedure |
| Real SMTP mailer | `ConsoleMailer` logs the magic link to stdout — daily use impossible | SMTP implementation behind the existing `Mailer` seam; zero other code changes |
| Session expiry | The signed cookie never expires — one login is a forever-credential until `SESSION_SECRET` rotates | `maxAge` + server-side session invalidation |
| Rate limiting | `POST /auth/request` is unthrottled — free email-send amplification once real mail ships | Per-IP/per-email rate limit |

### Phase 2 — Integration surface *(Next)*

Everything a headless producer or consumer hits today that forces a workaround.

| Item | Today | Target |
|------|-------|--------|
| API tokens / service actors | Cookie-only auth; in production the magic link only reaches server logs, so a headless producer needs an operator to copy it out — and a leaked cookie is a forever-credential | Token-based auth for non-browser clients, revocable per actor |
| Non-human actor kinds | `resolveActor` hardcodes `kind: 'human'`; the `kind` enum (`human`, `ai`, `device`, …) exists in schema but has no front door | Register and authenticate `ai`/`device`/service actors through the public surface |
| Dynamic event-type registration | A new type = seed migration + the hardcoded `EVENT_TYPES` map + a restart (see "Adding a type today" in [docs/EVENT-TYPES.md](docs/EVENT-TYPES.md)) | Registration becomes an admin action, not a deploy: an admin API inserts into `event_type` and refreshes the app-side schema cache at runtime |
| Global log read | `GET /events` requires `subject=`; there is no firehose read and `stream_id` is not queryable — a log archiver is impossible over HTTP | `GET /events?after=` without subject, plus a `?stream=` filter |
| SSE quality | No heartbeat, no `Last-Event-ID` resume, no filtering — every append wakes every client into a full refetch | Heartbeat, resume-from-seq, and stream/subject filtering |

### Phase 3 — Prove generality *(Later)*

The claim is "one history, infinite presentations." Prove it with folds that are shaped differently
from chat.

- **Task/kanban projection** — first, because it is a latest-state-per-subject fold where chat is an
  append-list fold; the fold sketch already exists in [docs/EXAMPLES.md](docs/EXAMPLES.md). Then
  **wiki/notes**. Stop at three-to-four projections; resist the ten-app catalog.
- **Generic `GET /projections/:name`** plus a projection-registration convention (fold module +
  checkpoint seed + route) — when the fourth projection lands and the hardcoded-route pattern
  visibly hurts. Must document the checkpoint-seed gotcha: an unseeded projection silently replays
  the full log every tick.
- **Notifications / outbound webhooks** — SSE only serves open browser tabs; daily-use orgs need
  push. A webhook dispatcher is just another checkpointed projector, which makes it the first
  out-of-process consumer and the forcing function for finally calling `projector.start()`.

### Phase 4 — Grow *(Later)*

- **MCP transport for AI actors** — a thin wrapper over the existing command/query layer
  (`append_event`, `query_projection`, `list_event_types`; projections as resources). AI agents are
  ordinary actors through the same writer path: no privileged side door.
- **Full RBAC / membership scoping** — today any authenticated actor reads every actor's email and
  every message. Fine for one mutually-trusting team, disqualifying beyond it. The authz-as-events
  kernel (roles folded from `identity.role.granted/revoked`) is the foundation; thread membership,
  per-subject read scoping, and invites build on it.
- **Additional identity providers** — Google OAuth etc. behind the existing `IdentityProvider` seam
  (`resolveActor` takes a verified email regardless of transport). Demand-driven, not scheduled.
- **Point-in-time query API** — the log already guarantees as-of-seq replay
  (`AND seq <= $N` over the fold); an endpoint is a convenience wrapper. Build it when a concrete
  audit/dispute/restore need appears.

## Ejected from core

Concepts deliberately moved out of core scope. Each must be buildable (or was dropped) as a client
of the public contract.

| Concept | Why it left | Where it lives now |
|---------|-------------|--------------------|
| Digital twins | A twin is "just a projection" — buildable entirely outside core against `POST /events` + the projection contract; zero core code beyond the `501` stub | [docs/proposals/TWINS.md](docs/proposals/TWINS.md); future `orgos-twins` satellite |
| Federation | Multiplies every hard problem (identity, trust, ordering, schema governance) before one org runs daily; the federation worker is "just another projector re-appending foreign events" — an external process | Satellite/future work; the contracts it motivated stay (see below) |
| Event signatures / PKI identity | Federation was its only real customer, and it contradicts the shipped magic-link identity — nothing signs or verifies anything | Falls with federation; the nullable `signature`/`public_key` columns remain as zero-cost affordances |
| MQTT/PLC/IoT bridges | Edge adapters are the canonical client of the narrow waist: MQTT on one side, `POST /events` on the other, zero kernel changes | Separate bridge projects; the **"devices are actors"** identity model stays core |
| CRM / Knowledge Graph / Dashboard / AI Workspace | Full applications with their own domain models, not projections; listing them as core misled readers into believing they exist | Ecosystem tier, built by others on the projection contract; **AI-nativeness itself stays core** (actor `kind: 'ai'`, MCP transport) |
| Rules engine + integrations catalog (GitHub, Stripe, LLM, email-in, …) | Every integration is an external producer/consumer of the REST surface; a workflow DSL does not belong in the kernel | Userland/community adapter projects |
| Separate `grant` table | Roles fold into `actor_state.roles text[]`, already enforced by `canAppend`; a dedicated read model is speculative until resource-scoped grant events exist (and `grant` is a reserved word) | Dropped; design a proper RBAC read model with Phase 4 if needed |
| Snapshot tables | `last_event_seq` on every read model *is* the live snapshot; as-of-seq replay covers point-in-time | Dropped; org admins can build their own materialized views |
| Client local-first / offline | **Dropped**, not deferred: disconnected client writers are irreconcilable with `UNIQUE(stream_id, stream_seq)` optimistic concurrency — a different sync design entirely. Node-level sovereignty (each org node runs without the network) stays true | Nowhere; a future plugin would need its own sync design |
| `church.*` baseline vocabulary | A vertical domain inside the shared baseline violates the extension policy in [docs/EVENT-TYPES.md](docs/EVENT-TYPES.md) | Becomes the first example org-extension package, doubling as the dynamic-type-registration demo |

### Preserved federation contracts

Federation left core scope, but it is the recorded rationale for standing contracts that must
survive it. Do not "fix" these away:

- **`seq` is local, never global** — cross-node ordering can never assume a shared sequence.
- **One org = one database, one process** — no in-DB multi-tenancy, no RLS; a second org is a
  second deployment.
- **`org_id` provenance column on every event** — cheap, already paid for, required the day rows
  ever ship between nodes.
- **App-side uuidv7 event IDs** — per-node ID minting with no DB round-trip (and no dependence on a
  DB-native `uuidv7()`, which the pinned Postgres 16 lacks).

## Known minor issues

Still-open minors carried forward from the beta ledger
([docs/archive/2026-06-26-beta/progress.md](docs/archive/2026-06-26-beta/progress.md)), plus one
verified since. All are acceptable at beta scale; none block daily use by one team.

| Issue | Detail |
|-------|--------|
| SSE refetch storm | The web client refetches the thread list *and* the open thread on every broadcast `seq`, relevant or not — O(events) refetches at scale. Fixed properly by Phase 2 SSE filtering. |
| `projector.start()` inert | Never called; projections tick at boot and after API appends only, so out-of-band appends (e.g. `psql`) don't project until the next append or restart. Becomes real work when the first second writer appears (Phase 3 webhooks). |
| Chat draft loss on failed send | `Chat.tsx` clears the draft before posting; a non-`409` failure (or a second `409`) loses the typed message with no recovery. |
| Login form error feedback | A failed `POST /auth/request` leaves the login form frozen with no error state. |
| Collision-prone web fallback uuid | `Chat.tsx`'s `uuid()` fallback is a fixed prefix plus the hex millisecond timestamp — deterministic, collides for same-millisecond calls; even the primary `crypto.randomUUID()` path emits v4, not the v7 the schema convention promises. Adopt the `uuidv7` package in `web/` as the server already does. |
