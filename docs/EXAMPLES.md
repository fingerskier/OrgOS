# Examples

> Practical recipes against a running OrgOS node, in two halves: **HTTP** —
> how scripts authenticate, produce events, and consume them; and **SQL** — a
> cookbook of folds over the `event` table for reading the log directly and
> building new projections. The API surface is described in
> [ARCHITECTURE.md](./ARCHITECTURE.md); columns in [SCHEMA.md](./SCHEMA.md);
> the seven registered event types in [EVENT-TYPES.md](./EVENT-TYPES.md).

Everything below runs against the beta as built. `BASE=http://localhost:8787`
throughout (see [DEVELOPMENT.md](./DEVELOPMENT.md) for bringing a node up).

---

## Part 1 — HTTP producers & consumers

### How a script authenticates

There is one credential: the signed `sid` cookie issued by the magic-link
callback. There are no API tokens or service accounts yet — that is
[roadmap](../ROADMAP.md).

**Dev mode** (`NODE_ENV != production`): `POST /auth/request` returns the
magic link in the response body as `devLink`, so login is fully scriptable —
extract the token and hit `GET /auth/callback` on the API port with a cookie
jar:

```sh
BASE=http://localhost:8787

TOKEN=$(curl -s $BASE/auth/request -H 'content-type: application/json' \
  -d '{"email":"bot@example.com"}' | jq -r .devLink | sed 's/.*token=//')
curl -s -c ~/.orgos.jar "$BASE/auth/callback?token=$TOKEN" -o /dev/null
# ~/.orgos.jar now holds the signed sid cookie — every later call uses -b ~/.orgos.jar
```

(The `devLink` points at the web origin, `:5173`; scripts skip the web app and
present the token straight to the API.)

**Production**: no `devLink`, and the only mailer is `ConsoleMailer` — the
magic link prints to server stdout. A headless producer therefore needs an
operator to copy the link off the server logs once. Awkward by design honesty:
cookie-only auth is a beta limitation; API tokens are on the
[roadmap](../ROADMAP.md).

Two properties of the cookie worth knowing before you wire it into cron:

- It never expires — no `maxAge`, no server-side session table. One login
  powers a bot indefinitely, until `SESSION_SECRET` rotates.
- It is the raw credential. Extract it from the jar with
  `awk '$6=="sid"{print $7}' ~/.orgos.jar` for non-curl clients, and treat it
  like a password.

### The append contract

Every write is `POST /events` with a JSON envelope:

```json
{
  "type": "chat.message.posted@1",
  "subjectId": "<uuid — what the event is about>",
  "streamId": "<uuid or null — consistency boundary>",
  "streamSeq": 7,
  "payload": { "body": "hello" },
  "metadata": { "source": "my-script" }
}
```

| Status | Meaning |
|--------|---------|
| `201` | Committed — body is `{"id":"<uuid>","seq":"<global seq>"}` |
| `400` | Unknown type, or payload failed the type's JSON Schema |
| `401` | Missing/invalid `sid` cookie |
| `403` | Beta authz: non-admins may append only `chat.*` and `identity.actor.registered@1` |
| `409` | `streamSeq` conflict — body carries `currentVersion`; refetch and retry |

Two gotchas the status table does not save you from:

- **All five envelope keys are mandatory** — `type`, `subjectId`, `streamId`,
  `streamSeq`, `payload` — but they fail differently when missing. Omitting
  `payload` (or sending it as `null`) is an ordinary `400`: ajv rejects
  non-objects before the insert. Omitting `type` is a `500` (a `TypeError` in
  the authz check, not a validation error). Omitting `subjectId`, `streamId`,
  or `streamSeq` is also a `500` — postgres.js refuses `undefined` values — so
  send explicit `null` where unused. Only `metadata` may be left out.
- **Never post `chat.message.posted@1` with `"streamId": null`.** The insert
  commits (NULLs never collide on `UNIQUE(stream_id, stream_seq)`), and then
  the chat projector fails folding it into `chat_message.thread_id NOT NULL`.
  The checkpoint stops advancing and subsequent appends return `500` until the
  poison event is repaired by hand.

### Producer: login, create a thread, post a message

The foundational non-browser producer, entirely curl + jq. A thread is a
stream: `subjectId = streamId =` a fresh uuid, `streamSeq` starts at 1. A
message is a new subject *inside* that stream, appended at
`streamVersion + 1`.

```sh
BASE=http://localhost:8787   # assumes ~/.orgos.jar from the login box above

# create a thread
T=$(uuidgen)
curl -s -b ~/.orgos.jar $BASE/events -H 'content-type: application/json' -d "{
  \"type\":\"chat.thread.created@1\",
  \"subjectId\":\"$T\",\"streamId\":\"$T\",\"streamSeq\":1,
  \"payload\":{\"title\":\"#ops\"}}"          # -> 201 {"id":"...","seq":"42"}

# post a message at the current stream version (409 means someone beat you — refetch, retry)
V=$(curl -s -b ~/.orgos.jar "$BASE/projections/chat?thread=$T" | jq .streamVersion)
curl -s -b ~/.orgos.jar $BASE/events -H 'content-type: application/json' -d "{
  \"type\":\"chat.message.posted@1\",
  \"subjectId\":\"$(uuidgen)\",\"streamId\":\"$T\",\"streamSeq\":$((V+1)),
  \"payload\":{\"body\":\"hello from curl\"},\"metadata\":{\"source\":\"cli\"}}"
```

### Producer: cron heartbeat bot

Appends a liveness ping into an `#ops` thread every five minutes, retrying
once on `409`.

Why does an ops heartbeat masquerade as a chat message? Two reasons, both
current-code facts: the beta authz policy allows non-admin actors only
`chat.*` (plus self-registration), and a new event type today requires a code
change — a seed row *and* an entry in the hardcoded `EVENT_TYPES` map in
`server/src/domain/eventTypes.ts`, then a restart. Runtime type registration
and a telemetry vocabulary are [roadmap](../ROADMAP.md).

```sh
#!/usr/bin/env sh
# /opt/orgos/heartbeat.sh    crontab: */5 * * * * /opt/orgos/heartbeat.sh
BASE=http://localhost:8787; JAR=$HOME/.orgos.jar; T=<ops-thread-uuid>
for try in 1 2; do   # on 409, loop refetches the fresh version and retries once
  V=$(curl -s -b $JAR "$BASE/projections/chat?thread=$T" | jq .streamVersion)
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b $JAR $BASE/events \
    -H 'content-type: application/json' -d "{
    \"type\":\"chat.message.posted@1\",
    \"subjectId\":\"$(uuidgen)\",\"streamId\":\"$T\",\"streamSeq\":$((V+1)),
    \"payload\":{\"body\":\"heartbeat ok — $(uptime -p), $(date -Is)\"},
    \"metadata\":{\"source\":\"cron-heartbeat\"}}")
  [ "$CODE" = 201 ] && exit 0
  [ "$CODE" = 409 ] || { echo "append failed: $CODE" >&2; exit 1; }
done
exit 1
```

### Producer: GitHub webhook → chat bridge

A ~35-line Node process that re-publishes push webhooks as chat messages, with
the same refetch-on-409 loop the web client uses. The bot identity is just
another magic-link email: log it in once with the shell recipe, export its
cookie, run the bridge.

```js
// bridge.mjs — node bridge.mjs   (point the GitHub webhook at http://host:9090/)
import { createServer } from 'node:http'
const BASE = 'http://localhost:8787'
const THREAD = process.env.ORGOS_THREAD                 // #github thread uuid
const COOKIE = 'sid=' + process.env.ORGOS_SID           // value from the cookie jar

async function post(body) {
  for (let i = 0; i < 3; i++) {                         // OCC: refetch + retry on 409
    const view = await (await fetch(`${BASE}/projections/chat?thread=${THREAD}`,
      { headers: { cookie: COOKIE } })).json()
    const r = await fetch(`${BASE}/events`, {
      method: 'POST',
      headers: { cookie: COOKIE, 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'chat.message.posted@1',
        subjectId: crypto.randomUUID(), streamId: THREAD, streamSeq: view.streamVersion + 1,
        payload: { body }, metadata: { source: 'github-webhook' },
      }),
    })
    if (r.status === 201) return
    if (r.status !== 409) throw new Error(`append ${r.status}: ${await r.text()}`)
  }
}

createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c
  const e = JSON.parse(raw || '{}')
  if (req.headers['x-github-event'] === 'push')
    await post(`push ${e.repository?.full_name} by ${e.pusher?.name}: ${e.head_commit?.message ?? ''}`)
  res.writeHead(204).end()
}).listen(9090)
```

Before production use, verify `x-hub-signature-256` on the incoming webhook —
and note the leaked-cookie blast radius: the bridge's cookie never expires,
and beta authz has no ownership check, so any authenticated actor can edit or
delete anyone's messages.

### Producer: admin bootstrap + role grants

`identity.role.granted@1` is a first-class event, folded into
`actor_state.roles` — but it is admin-gated, and no code path grants the
*first* admin. Bootstrap is a one-time side-door append with psql; the
`BEFORE INSERT` trigger still validates the payload, so the log stays
well-formed. Everything after goes through the front door.

```sql
-- STEP 1 (one-time, psql). The target must have logged in once (actor_state row exists).
INSERT INTO event (id, event_type_id, namespace, name, version, actor_id, org_id,
                   subject_id, stream_id, stream_seq, payload)
SELECT gen_random_uuid(), et.id, 'identity', 'role.granted', 1,
       a.actor_id, '00000000-0000-7000-8000-00000000c0de',
       a.actor_id, NULL, NULL, '{"role":"admin"}'
FROM actor_state a, event_type et
WHERE a.email = 'you@example.com'
  AND et.namespace = 'identity' AND et.name = 'role.granted' AND et.version = 1;
```

```sh
# STEP 2 (repeatable, front door — requires the admin's cookie jar).
BASE=http://localhost:8787
curl -s -b ~/.orgos.jar $BASE/events -H 'content-type: application/json' -d "{
  \"type\":\"identity.role.granted@1\",
  \"subjectId\":\"$TARGET_ACTOR_ID\",\"streamId\":null,\"streamSeq\":null,
  \"payload\":{\"role\":\"admin\"},\"metadata\":{\"reason\":\"ops bootstrap\"}}"
```

Three precise notes:

- **The grant projects lazily.** The projector ticks at boot and after each
  API append — it is not subscribed to the log (`projector.start()` is never
  called). A psql-appended event notifies SSE clients immediately but does not
  reach `actor_state.roles` until the next API append or a server restart.
- **`subjectId` is the TARGET actor's id.** The identity fold keys
  `actor_state` on `subject_id`; `actor_id` records who granted.
- **Ids are normally app-generated uuid v7** (`uuidv7` npm package — PG16 has
  no `uuidv7()`). `gen_random_uuid()` above is v4, acceptable for a one-off
  side-door row; don't build tooling on it.

### Consumer: SSE terminal notifier

`GET /stream` is an auth-gated SSE feed, but it carries **bare sequence
numbers only** (`event: append` / `data: <seq>` — no payloads) and there is no
fetch-event-by-seq endpoint. So the consumer pattern is: on every append
notification, refetch the projection — exactly what the web app does. There is
no server heartbeat and no `Last-Event-ID` resume, so bring your own reconnect
loop. Smoke test: `curl -N -b ~/.orgos.jar http://localhost:8787/stream`.

```js
// notify.mjs — node notify.mjs   (ORGOS_SID from: awk '$6=="sid"{print $7}' ~/.orgos.jar)
const BASE = 'http://localhost:8787'
const THREAD = process.env.ORGOS_THREAD
const COOKIE = 'sid=' + process.env.ORGOS_SID
const seen = new Set()

async function refresh() {
  const t = await (await fetch(`${BASE}/projections/chat?thread=${THREAD}`,
    { headers: { cookie: COOKIE } })).json()
  for (const m of t.messages) if (!seen.has(m.message_id)) {
    seen.add(m.message_id)
    console.log(`[${m.posted_at}] ${m.author_id.slice(0, 8)}: ${m.body}`)
  }
}

for (;;) {                       // reconnect loop — no server heartbeat, no resume
  try {
    const res = await fetch(`${BASE}/stream`,
      { headers: { cookie: COOKIE, accept: 'text/event-stream' } })
    await refresh()
    const dec = new TextDecoder()
    let buf = ''
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true })   // chunks are Uint8Array, not text
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {           // one SSE frame per blank line
        const frame = buf.slice(0, i); buf = buf.slice(i + 2)
        if (frame.includes('event: append')) await refresh()  // seq only; must refetch
      }
    }
  } catch { /* server restart / network blip */ }
  await new Promise((r) => setTimeout(r, 2000))
}
```

Note the stream is org-wide: every append wakes every client, with no
per-thread filter. Fine at beta scale; a refetch storm later
([roadmap](../ROADMAP.md)).

### Consumer: daily digest cron

Walks `GET /projections/threads`, pulls each thread, filters the last 24h.
Timestamps serialize as UTC ISO strings, so they compare lexically. Deleted
messages are already filtered server-side (`deleted = false`), so they
silently vanish from the digest.

```sh
#!/usr/bin/env sh
# digest.sh — crontab: 0 7 * * * /opt/orgos/digest.sh | mail -s 'OrgOS digest' you@example.com
BASE=http://localhost:8787; JAR=$HOME/.orgos.jar
SINCE=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%S)   # macOS: date -u -v-24H ...

curl -s -b $JAR $BASE/projections/threads |
  jq -r '.[] | "\(.thread_id)\t\(.title)"' |
  while IFS="$(printf '\t')" read -r T TITLE; do
    curl -s -b $JAR "$BASE/projections/chat?thread=$T" |
      jq --arg s "$SINCE" --arg title "$TITLE" -r '
        [.messages[] | select(.posted_at >= $s)] |
        if length > 0 then
          "## \($title) — \(length) new\n" + (map("  - \(.body)") | join("\n"))
        else empty end'
  done
```

### Consumer: actor audit tail

The one raw-log read endpoint is `GET /events?subject=<uuid>&after=<seq>`.
Since an actor's registration and every role grant/revoke all carry
`subject_id = actor_id`, this is a ready-made "who granted what, when" feed —
keep a cursor file and pull incrementally.

```sh
#!/usr/bin/env sh
# audit.sh <actor_id> — prints new identity events for that actor since last run
BASE=http://localhost:8787; JAR=$HOME/.orgos.jar
A=$1; CUR="$HOME/.orgos-audit-$A.seq"
AFTER=$(cat "$CUR" 2>/dev/null || echo 0)

curl -s -b $JAR "$BASE/events?subject=$A&after=$AFTER" | jq -c '.[]' |
while read -r e; do
  echo "$e" | jq -r '"seq \(.seq)  \(.namespace).\(.name)@\(.version)  by \(.actor_id[0:8])  \(.payload)"'
  echo "$e" | jq -r .seq > "$CUR"       # cursor = last seq seen
done
```

Know the boundaries: **`subject` is the only filter.** You cannot tail a
thread this way (messages carry `subject_id = message_id`, and `stream_id` is
not queryable over HTTP), and there is no global firehose read — `GET /events`
without `subject=` is a `400`. A log archiver needs direct Postgres today.
Also, `after` must be numeric — a non-numeric value `500`s.

### Consumer: watch-style terminal dashboard

The simplest read-model consumer: a `watch` loop over the two list
projections.

```sh
# dash.sh — refreshes every 5s
watch -n 5 '
  echo "=== actors ===";
  curl -s -b ~/.orgos.jar http://localhost:8787/projections/actors |
    jq -r ".[] | \"\(.handle)  <\(.email)>  [\(.roles | join(\",\"))]  \(.status)\"";
  echo; echo "=== threads ===";
  curl -s -b ~/.orgos.jar http://localhost:8787/projections/threads |
    jq -r ".[] | \"\(.created_at)  \(.title)  (\(.thread_id[0:8]))\""'
```

Terminal and server-side consumers work anywhere; a *browser* dashboard on
another host does not — CORS is pinned to the single `WEB_ORIGIN` with
credentialed cookies, so browser clients must be served from (or proxied
through) the web origin. And note the read model is all-or-nothing: any
authenticated actor sees every actor's email and every thread. Scoping is
[roadmap](../ROADMAP.md).

---

## Part 2 — SQL cookbook

> The `event` table is the source of truth; everything else is a projection —
> a fold over events you can compute on the fly in SQL or materialize into a
> read model. See [SCHEMA.md](./SCHEMA.md) for columns and
> [EVENT-TYPES.md](./EVENT-TYPES.md) for the registered vocabulary.

All examples are plain Postgres. `seq` (strict total order) drives replay;
`subject_id` groups by *what the event is about*; `stream_id` is the
consistency/aggregate boundary. Event `id`s are app-generated uuid v7 — PG16
ships no `uuidv7()`, so don't expect to mint them in SQL.

### 1. Filter by type

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
WHERE namespace = 'identity'
ORDER BY seq;
```

### 2. Timeline for a subject

Everything that ever happened to one thing, in order — the universal "history"
view (a message's changelog, an actor's role history):

```sql
SELECT seq, namespace, name, actor_id, payload, occurred_at
FROM event
WHERE subject_id = $1            -- the message / actor id
ORDER BY seq;
```

This is exactly what `GET /events?subject=` serves over HTTP.

### 3. Fold to current state (latest-wins)

Many projections are "the most recent event of a kind per subject."
`DISTINCT ON` over descending `seq` is the idiomatic fold:

```sql
-- current body of every message, edits folded in
SELECT DISTINCT ON (subject_id)
       subject_id AS message_id,
       payload ->> 'body' AS body,
       seq        AS last_event_seq
FROM event
WHERE namespace = 'chat' AND name IN ('message.posted', 'message.edited')
ORDER BY subject_id, seq DESC;
```

For a single subject, just `... WHERE subject_id = $1 ORDER BY seq DESC LIMIT 1`.

### 4. Time travel: state as of seq N

Any latest-wins fold becomes an as-of query by capping `seq`. State at
sequence `$2` is simply "latest wins, ignoring everything after `$2`":

```sql
SELECT DISTINCT ON (subject_id)
       subject_id AS message_id,
       payload ->> 'body' AS body
FROM event
WHERE namespace = 'chat' AND name IN ('message.posted', 'message.edited')
  AND seq <= $2                  -- the moment in history
ORDER BY subject_id, seq DESC;
```

Because the log is append-only, this is exact and repeatable — the same `$2`
always yields the same answer.

### 5. Chat thread fold (messages in a thread)

The conversation is the `stream_id`; each message is a `subject_id`. Show a
thread with edits folded in and deletions dropped:

```sql
SELECT DISTINCT ON (subject_id)
       subject_id AS message_id,
       actor_id   AS author_id,
       payload ->> 'body' AS body,
       occurred_at
FROM event
WHERE stream_id = $1                       -- the thread
  AND namespace = 'chat'
  AND name IN ('message.posted', 'message.edited')
  AND subject_id NOT IN (                  -- drop deleted messages
    SELECT subject_id FROM event
    WHERE stream_id = $1 AND name = 'message.deleted'
  )
ORDER BY subject_id, seq DESC;
```

(The materialized version — `chat_message` — keeps deletions as a `deleted`
flag instead of dropping the row; the API filters on it.)

### 6. Kanban fold — proposed `task.*` vocabulary

> **Not yet registered.** No `task.*` types exist in the beta seed; this shows
> the shape a board projection takes once the vocabulary lands
> ([roadmap](../ROADMAP.md)).

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
         payload ->> 'to_column' AS "column",
         seq
  FROM event
  WHERE namespace = 'task' AND name = 'item.moved'
  ORDER BY subject_id, seq DESC
)
SELECT c.task_id, c.title,
       COALESCE(m."column", 'backlog') AS "column"
FROM created c
LEFT JOIN latest_move m USING (task_id)
WHERE c.task_id NOT IN (
  SELECT subject_id FROM event
  WHERE namespace = 'task' AND name = 'item.archived'
)
ORDER BY c.seq;
```

(The `"column"` quoting is for readability around the keyword — Postgres
accepts it unquoted in these positions.)

### 7. Effective roles (grants minus revocations)

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

This is the fold behind `actor_state.roles`.

### 8. Catch-up poll (the projector contract)

A projector advances past its checkpoint by `seq`. This is the query behind
every materialized read model (see [SCHEMA.md](./SCHEMA.md)):

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

> **Gotcha — seed the checkpoint before wiring a new projection.** The
> built-in projector (`server/src/infra/projector.ts`) `UPDATE`s its
> checkpoint but never inserts it. Without a row, the read of
> `last_event_seq` falls back to `0` *every* tick and the `UPDATE` silently
> affects zero rows — so the projection either replays the whole log on each
> tick or, when its namespaces match no new rows while newer events exist,
> loops in the fast-forward branch without terminating. Ticks run inline after
> every API append, so that loop blocks writes. Insert the row first, exactly
> as the seed migration does for `identity` and `chat`:
>
> ```sql
> INSERT INTO projection_checkpoint (name, last_event_seq) VALUES ('myproj', 0);
> ```

### 9. Causal chains (correlation / causation)

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

### 10. Digging into `jsonb` payloads

```sql
-- scalar extraction
SELECT payload ->> 'body' FROM event
WHERE namespace = 'chat' AND name = 'message.posted';

-- filter on the free-form metadata envelope (who produced this?)
SELECT seq, namespace, name FROM event
WHERE metadata ->> 'source' = 'github-webhook'
ORDER BY seq;

-- containment (GIN-indexable)
SELECT * FROM event
WHERE namespace = 'identity'
  AND payload @> '{"role": "admin"}';
```

> Index hot payload paths: `CREATE INDEX ON event USING gin (payload jsonb_path_ops);`
> or expression indexes on specific extracted fields.

### 11. Firehose aggregation — future vocabulary

The schema already supports stream-less "firehose" events (`stream_id` /
`stream_seq` NULL, ordered only by global `seq` — see
[SCHEMA.md](./SCHEMA.md)), but no telemetry types are registered yet; a
`device.*` vocabulary is [roadmap](../ROADMAP.md). When it lands, aggregation
is ordinary time-series SQL over §10-style extraction:

```sql
-- proposed device.telemetry.received@1 — type not yet registered
SELECT subject_id AS device_id,
       date_trunc('hour', occurred_at) AS hour,
       avg((payload -> 'reading' ->> 'celsius')::numeric) AS avg_c
FROM event
WHERE namespace = 'device' AND name = 'telemetry.received'
  AND occurred_at >= now() - interval '24 hours'
GROUP BY device_id, hour
ORDER BY device_id, hour;
```

### 12. Inspecting stream concurrency

The current version of an aggregate = its highest `stream_seq`. This is
exactly the `streamVersion` that `GET /projections/chat` returns for the
optimistic-append check:

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

### 13. Rebuilding a projection from scratch

Because the log is the source of truth, any read model is disposable. The
`chat` checkpoint covers both chat tables:

```sql
TRUNCATE chat_message, chat_thread;
UPDATE projection_checkpoint SET last_event_seq = 0 WHERE name = 'chat';
```

Then restart the server — the boot-time tick replays the log through the
folds (any API append triggers a tick too). This is the core guarantee of the
architecture: **no projection holds state the log cannot reconstruct.**
