# The Organization Operating System (OrgOS)

> **An open-source, event-sourced operating system for organizations.**
>
> Chat is not the product. Tickets are not the product. Wikis are not the product.
> **Events are the product.**

Modern organizations scatter their reality across a dozen silos, each storing its own copy of the truth. OrgOS inverts this: there is exactly one truth — an append-only log of immutable events — and everything else (chat, membership, dashboards, whatever comes next) is a rebuildable projection of that log. If a view is wrong, delete it and replay. The history is never wrong.

---

## What Works Today

The Identity + Chat beta is implemented and tested:

- **Passwordless magic-link auth** — request a link by email, click, you're in (signed-cookie session)
- **Event append** — one `POST /events` path with authoritative JSON Schema validation enforced by a database trigger (`pg_jsonschema`), plus optimistic concurrency (`streamSeq` → `409` on conflict)
- **Projections** — identity (actors), chat threads, and chat messages, folded from the log by a checkpointed projector
- **SSE live tail** — a `/stream` feed announces each append's sequence number; clients catch up via `GET /events?subject=&after=` and refetch projections
- **React chat UI** — threads and messages; edit/delete correction events (`chat.message.edited`, `chat.message.deleted`) are validated and folded by the kernel but not yet surfaced in the UI
- **Single org per deployment** — multi-org and federation are roadmap, not reality
- **Dev-mode ConsoleMailer** — magic links print to the server console; no email credentials required

Run it locally: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

---

## First Principles

### Reality is Events

Nothing is updated in place. Only new events are recorded.

```
identity.actor.registered
chat.message.posted
issue.opened
invoice.paid
sensor.reading.received
```

The past is never rewritten. History is preserved forever.

### State is Derived

There is no "database record." Current state is computed from the event history.

```
Events → Projection → Current State
```

Need today's state? Replay the events. Need yesterday's? Replay to yesterday. Need to audit? Read the log.

### Everything is an Actor

Humans, AI agents, devices, and services are all actors with identity and permissions, and all speak the same language: events.

```
Alice                (human)
Ops Assistant        (AI)
Lobby Kiosk #3       (device)
CI Pipeline          (service)
```

### Immutability, Corrections as Events

Events cannot be modified or deleted. Mistakes are corrected by appending new events — `chat.message.edited`, `chat.message.deleted` — that projections fold over. Nothing disappears; everything is explainable.

### Permissions are Events

Grants and revocations are themselves events in the log, making authorization reproducible and auditable at any point in history.

### The Narrow Waist

There is exactly one way to write: the append endpoint, which authorizes the actor, validates the payload against the registered schema, and lets the database trigger have the final word. No privileged side door — not for admins, not for AI, not for internal services.

---

## Architecture

```
┌──────────────────────── Kernel ────────────────────────┐
│                                                        │
│  Append-only Event Log ── Type Registry (JSON Schema)  │
│            │                                           │
│        Projector ──► actor / thread / message tables   │
│            │                                           │
│        REST + SSE  (one append path, many reads)       │
└────────────────────────────┬───────────────────────────┘
                             │  plain HTTP clients
┌──────────────────────── Userland ──────────────────────┐
│  Web UI · custom projections · bots · bridges ·        │
│  automation — all built as clients of the kernel API   │
└────────────────────────────────────────────────────────┘
```

The kernel stays small: log, registry, projector, API. Everything else lives in userland and earns no special access.

---

## Vision

Next: AI actors joining over MCP with the same identity and permission machinery as humans, and more projections (timeline, kanban, knowledge) folded from the same log. Later: federation between sovereign org nodes, each owning its own history and choosing what to share. Offline/local-first client operation was considered for the beta and dropped. Details and status per item live in [ROADMAP.md](ROADMAP.md).

---

## Core Values

- Open Source
- Event Sourced
- Immutable
- AI Native
- Extensible
- Explainable
- Durable
- Decentralized & Federated *(roadmap — a deployment is one sovereign node today)*

---

## Docs

| Doc | Contents |
|-----|----------|
| [ROADMAP.md](ROADMAP.md) | What's next, what's someday, what's dropped |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Quickstart, testing, CI |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The system as built |
| [docs/SCHEMA.md](docs/SCHEMA.md) | Database schema reference |
| [docs/EVENT-TYPES.md](docs/EVENT-TYPES.md) | Event vocabulary and versioning rules |
| [docs/EXAMPLES.md](docs/EXAMPLES.md) | HTTP walkthrough + SQL fold cookbook |
| [docs/proposals/TWINS.md](docs/proposals/TWINS.md) | Digital-twin design (proposal, not implemented) |
| [docs/archive/2026-06-26-beta/](docs/archive/2026-06-26-beta/spec.md) | Frozen beta spec, plan, and progress ledger |
| [LICENSE](LICENSE) | Apache 2.0 |

---

## Motto

> **One history. Infinite presentations.**
