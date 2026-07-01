# Event Types

> The event vocabulary: the naming grammar, the rules for evolving types, payload
> conventions, and the catalog of types shipped in the beta. Every event written
> to the log is validated against a registered type (`event_type` in
> [SCHEMA.md](./SCHEMA.md)), so this vocabulary is authoritative.

---

## Format

```
<domain>.<entity>.<verb>            name             (e.g. chat.message.posted)
<domain>.<entity>.<verb>@<version>  fully-qualified  (e.g. chat.message.posted@1)
```

Maps onto the registry columns:

| Segment          | Column                 | Example          |
|------------------|------------------------|------------------|
| `domain`         | `event_type.namespace` | `chat`           |
| `entity`.`verb`  | `event_type.name`      | `message.posted` |
| `version`        | `event_type.version`   | `1`              |

- Three dotted segments, lowercase, `snake_case` within a segment
  (`device.telemetry.received`, `task.item.assigned`).
- `domain` is one token; `entity` and `verb` are one token each. Keep the
  triple — don't collapse (`chat.posted`) or extend (`chat.message.text.posted`).
- Fully-qualified type for the wire / validation is `namespace.name@version`.

---

## Rules

**Past tense, always.** Events are facts that already happened —
`message.posted`, not `post.message` or `message.posting`.
The verb is the record of a completed change.
Commands/intents (future tense) are not events and don't go in the log.

**Names are stable.** A published `name` is a contract.
Never repurpose or silently change the meaning of an existing `namespace.name`.
Readers across the federation depend on it.

**Breaking schema changes create a new version.** Bump `version` when a change
would break existing readers (see [Versioning](#versioning)).
The old version stays registered and replayable.

**Deprecated events remain readable forever.** Mark a type `status =
'deprecated'` to stop new writes; never delete it.
The log is append-only and immutable — historical events of a deprecated type
must always fold correctly.
Deprecation is a writer-side signal, not a reader-side break.

**Organizations can define local namespaces.** Core namespaces
(`chat`, `identity`, …) are shared vocabulary.
An org extends with its own domain (`acme.invoice.issued`) or a reserved local
prefix (`x.*`, `local.*`) to avoid colliding with future core types.
Federated peers ignore namespaces they don't recognize.

**One verb, one fact.** An event records a single state transition. If a write
causes two independent facts, emit two events linked by `correlation_id` —
don't pack them into one compound verb.

---

## Versioning

`version` is an integer on `(namespace, name)`; `UNIQUE (namespace, name,
version)` lets multiple versions coexist.

- **Additive / non-breaking** (new optional field, looser constraint):
  edit the existing version's `schema` in place. Old payloads still validate.
- **Breaking** (rename/remove field, new required field, tightened type or
  constraint): register a **new version**. Leave the prior version `active` (or
  `deprecated`) so its historical events keep folding.
- Producers migrate forward at their own pace; consumers fold every version
  they've seen. There is **no rewrite** of old events — the log is immutable.

---

## Payload conventions

Defaults for the `payload` jsonb; each type's JSON Schema is authoritative.

- `snake_case` keys, consistent with column naming.
- IDs are `uuid`; reference other actors by id, not by handle.
- Timestamps are ISO-8601 `timestamptz` (UTC); prefer the log's
  `occurred_at`/`recorded_at` over duplicating time in the payload.
- Money as integer minor units + ISO-4217 `currency`, never floats.
- Payloads are self-contained: include what a reader needs to fold the event
  without resolving against mutable state.
- Causal/correlation/trace data lives in `event.metadata`, **not** `payload`.
- Corrections are new events, never updates — a payload that amends a prior
  event carries that event's id (e.g. `chat.message.edited@1` may carry
  `edits_event_id`).

---

## Shipped catalog

The seven types registered in the beta. Seeded by
`server/migrations/005_seed.sql` and mirrored in the `EVENT_TYPES` map in
`server/src/domain/eventTypes.ts` — those two files are the ground truth for
this table. All schemas are `additionalProperties: true` objects.

| Fully-qualified type            | Payload fields (**required**)                              |
|---------------------------------|------------------------------------------------------------|
| `identity.actor.registered@1`   | **handle**, **display_name**, **kind** (`human`\|`ai`\|`device`\|`org`\|`project`\|`workflow`), **email** |
| `identity.role.granted@1`       | **role**                                                   |
| `identity.role.revoked@1`       | **role**                                                   |
| `chat.thread.created@1`         | **title**                                                  |
| `chat.message.posted@1`         | **body**                                                   |
| `chat.message.edited@1`         | **body**, `edits_event_id` (optional; id of the posted event being amended) |
| `chat.message.deleted@1`        | *(none — empty object)*                                    |

Required string fields carry `minLength: 1`; `email` must be a valid email
format; `edits_event_id` is an unconstrained string.

### Adding a type today

Registering a new type is currently a **code-and-migration change, not an
admin action**:

1. Add the `event_type` row in a migration (as `005_seed.sql` does).
2. Add the matching entry to the hardcoded `EVENT_TYPES` map in
   `server/src/domain/eventTypes.ts` — the server compiles ajv validators from
   this map at startup and rejects unknown types **before** the database is
   ever consulted.
3. Restart the server.

Both registrations are required: the ajv layer gates the command path, and the
appender resolves `event_type_id` from the DB registry (which also enforces
the schema via `pg_jsonschema`). A runtime admin API for registering types
without a deploy is planned — see [ROADMAP.md](../ROADMAP.md).

---

## Proposed vocabulary

Earlier drafts sketched `task.*`, `device.*`, and `twin.*` catalogs. None of
these are registered — they are roadmap vocabulary, tracked in
[ROADMAP.md](../ROADMAP.md); the twin event model lives in
[docs/proposals/TWINS.md](./proposals/TWINS.md).

### Worked example: a vertical domain extends the vocabulary

The org-extension rule above is exactly how a vertical deployment adds its own
domain. A church deployment, for instance, registers a `church.*` namespace
alongside the core types:

```
church.prayer.requested
church.member.joined
church.event.scheduled
```

Same grammar, same rules (past tense, one verb one fact, versioned schemas),
registered the same way as any other type. Core readers ignore the namespace;
the vertical's own projections fold it. Nothing `church.*` ships in the base
registry — it's an example of the extension policy, not baseline vocabulary.

---

## Querying

Querying the event log is plain SQL — filter on the denormalized
`namespace` / `name` / `version` columns on `event` (no join to `event_type`
required for the common case):

```sql
SELECT * FROM event
WHERE namespace = 'chat' AND name = 'message.posted'
ORDER BY seq;
```

See [SCHEMA.md](./SCHEMA.md) for the log structure and
[EXAMPLES.md](./EXAMPLES.md) for producer/consumer patterns.
