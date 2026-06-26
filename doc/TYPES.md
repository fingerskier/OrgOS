# Common Event Types/Names

> The central **event type registry** (`event_type` in [SCHEMA.md](./SCHEMA.md)).
> Editable by administration. Every event written to the log is validated
> against the matching registered type, so the registry is the authoritative
> vocabulary of the system.

---

## Format

```
<domain>.<entity>.<verb>          name      (e.g. chat.message.posted)
<domain>.<entity>.<verb>@<version> fully-qualified (e.g. chat.message.posted@1)
```

Maps onto the registry columns:

| Segment   | Column               | Example     |
|-----------|----------------------|-------------|
| `domain`  | `event_type.namespace` | `chat`    |
| `entity`.`verb` | `event_type.name`| `message.posted` |
| `version` | `event_type.version` | `1`         |

- Three dotted segments, lowercase, `snake_case` within a segment
  (`device.telemetry.received`, `task.item.assigned`).
- `domain` is one token; `entity` and `verb` are one token each. Keep the
  triple — don't collapse (`chat.posted`) or extend (`chat.message.text.posted`).
- Fully-qualified type for the wire / validation is `namespace.name@version`.

---

## Rules

**Past tense, always.** Events are facts that already happened —
`message.posted`, not `post.message` or `message.posting`. The verb is the
record of a completed change. Commands/intents (future tense) are not events
and don't go in the log.

**Names are stable.** A published `name` is a contract. Never repurpose or
silently change the meaning of an existing `namespace.name`. Readers across
the federation depend on it.

**Breaking schema changes create a new version.** Bump `version` when a change
would break existing readers (see [Versioning](#versioning)). The old version
stays registered and replayable.

**Deprecated events remain readable forever.** Mark a type `status =
'deprecated'` to stop new writes; never delete it. The log is append-only and
immutable — historical events of a deprecated type must always fold correctly.
Deprecation is a writer-side signal, not a reader-side break.

**Organizations can define local namespaces.** Core namespaces
(`chat`, `task`, `identity`, `device`, …) are shared vocabulary. An org
extends with its own domain (`acme.invoice.issued`) or a reserved local prefix
(`x.*`, `local.*`) to avoid colliding with future core types. Federated peers
ignore namespaces they don't recognize.

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
- IDs are `uuid`; reference other actors/twins by id, not by handle.
- Timestamps are ISO-8601 `timestamptz` (UTC); prefer the log's
  `occurred_at`/`recorded_at` over duplicating time in the payload.
- Money as integer minor units + ISO-4217 `currency`, never floats.
- Payloads are self-contained: include what a reader needs to fold the event
  without resolving against mutable state.
- Causal/correlation/trace data lives in `event.metadata`, **not** `payload`.
- `*.corrected` / `*.archived` payloads carry the `id` (and `seq`) of the event
  they amend — corrections are new events, never updates.

---

## Defaults

Common cross-org types shipped with the base registry. Not exhaustive — apps
register their own; these are the shared baseline.

### `chat`
```
chat.message.posted
chat.message.edited
chat.message.deleted
chat.thread.created
chat.reaction.added
```

### `task`
```
task.item.created
task.item.assigned
task.item.moved          -- kanban column / status change
task.item.completed
task.item.archived
```

### `identity`
```
identity.actor.registered
identity.role.granted
identity.role.revoked
identity.access.revoked
identity.key.rotated
```

### `device`
```
device.telemetry.received
device.state.changed
device.alert.raised
device.command.acknowledged
```

### `twin`
```
twin.instance.created
twin.state.updated
twin.instance.retired
```

### `church`
```
church.prayer.requested
church.member.joined
church.event.scheduled
```

> Each app/domain extends this list by registering new `event_type` rows.
> Adding a type is an admin action, not a schema migration.

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

See [SCHEMA.md](./SCHEMA.md) for the log structure and [QUERY.md](./QUERY.md)
for query patterns.
