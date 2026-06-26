# OrgOS Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Identity+Chat slice of OrgOS — an event-sourced Fastify/Postgres service (writer + generic projector + REST + SSE + passwordless magic-link auth) and a React/Vite webapp that logs in by email and shows a live chat projection.

**Architecture:** Four layers, each depending only on the one below — Transport (Fastify REST/SSE/auth) → Application (commands, queries, authz, identity) → Domain (pure event-type registry + fold functions) → Infrastructure (postgres.js pool, appender, projector, mailer, login tokens). The Postgres event log is the single source of truth; every read model is a rebuildable fold. One Node process per org runs writer + projectors together.

**Tech Stack:** TypeScript (ESM, strict), Node LTS, Fastify, postgres.js, ajv + ajv-formats, uuidv7, vitest; Postgres with `pg_jsonschema`; Vite + React.

## Global Constraints

- Language: **TypeScript, ESM** (`"type": "module"`), `tsconfig` `strict: true`, `moduleResolution: "bundler"` or `"nodenext"`.
- DB access: **postgres.js only** (`postgres` package), tagged-SQL, **no ORM**. The only I/O lives in `server/src/infra/`.
- IDs: **uuid v7 generated app-side** via the `uuidv7` package, wrapped in `infra/uuid.ts` (`newId()`). Never rely on a DB-side uuid function.
- The log is sacred: **no `UPDATE`/`DELETE` of `event`** anywhere. Corrections are new events.
- Domain layer (`server/src/domain/`) is **pure** — zero imports of `postgres`, `fastify`, `node:fs`, etc. Folds are `(state, event) => state`.
- Event naming: three dotted segments, lowercase, past tense (`chat.message.posted`). Fully-qualified wire type = `namespace.name@version`.
- Validation is belt+suspenders: **ajv app-side (friendly)** + **`pg_jsonschema` BEFORE INSERT trigger (authoritative)**.
- Durability of projections comes from `seq` + `projection_checkpoint`, **never** from NOTIFY.
- Tests: **red/green TDD** — write the failing test, watch it fail, implement minimally, watch it pass, commit. A task is not done until its tests pass.
- Ports: service `8787` (`SERVER_PORT`), Vite dev `5173`, `WEB_ORIGIN=http://localhost:5173`.
- Commit after each task (and at the green step within a task).

---

## File Structure

```
OrgOS/
  docker-compose.yml                 # Postgres + pg_jsonschema
  server/
    package.json  tsconfig.json  .env.example  vitest.config.ts
    bin/migrate.ts                   # CLI: apply migrations
    migrations/
      001_extensions.sql  002_core.sql  003_triggers.sql
      004_projections.sql  005_seed.sql
    src/
      config.ts
      domain/
        eventTypes.ts                # registry + JSON schemas + ajv validators
        events.ts                    # StoredEvent type
        folds/ identity.ts  chat.ts
      infra/
        db.ts  uuid.ts  migrate.ts  appender.ts  schemaCache.ts
        projector.ts  mailer.ts  loginTokens.ts
      app/
        commands.ts  queries.ts  authz.ts  identity.ts
      transport/
        rest.ts  auth.ts  sse.ts
      server.ts                      # app factory + start
    test/
      domain/ identityFold.test.ts  chatFold.test.ts  eventTypes.test.ts
      infra/  uuid.test.ts  appender.test.ts  projector.test.ts  loginTokens.test.ts
      app/    commands.test.ts  identity.test.ts
      transport/ auth.test.ts  rest.test.ts
      helpers/ testDb.ts             # spin a throwaway schema on DATABASE_URL_TEST
  web/
    package.json  index.html  tsconfig.json  vite.config.ts
    src/ main.tsx  App.tsx  api.ts  auth.tsx  Chat.tsx  styles.css
```

---

### Task 1: Repo scaffold, Postgres, config, db pool, uuid

**Files:**
- Create: `docker-compose.yml`, `server/package.json`, `server/tsconfig.json`, `server/vitest.config.ts`, `server/.env.example`, `server/.gitignore`
- Create: `server/src/config.ts`, `server/src/infra/db.ts`, `server/src/infra/uuid.ts`
- Create: `server/migrations/001_extensions.sql`, `server/migrations/002_core.sql`
- Create: `server/src/infra/migrate.ts`, `server/bin/migrate.ts`
- Create: `server/test/infra/uuid.test.ts`, `server/test/helpers/testDb.ts`, `server/test/infra/db.test.ts`

**Interfaces:**
- Produces: `newId(): string` (`infra/uuid.ts`); `makeDb(url: string): Sql` where `Sql = postgres.Sql` (`infra/db.ts`); `loadConfig(env?): Config` (`config.ts`); `runMigrations(sql, dir): Promise<string[]>` (`infra/migrate.ts`); `withTestDb(fn): Promise<void>` + `freshSchema(): Promise<{sql, drop}>` (`test/helpers/testDb.ts`).

- [ ] **Step 1: docker-compose for Postgres + pg_jsonschema**

`docker-compose.yml`:
```yaml
services:
  db:
    image: supabase/postgres:15.8.1.060   # ships pg_jsonschema; if pull 404s, pick latest tag from hub.docker.com/r/supabase/postgres/tags
    environment:
      POSTGRES_USER: orgos
      POSTGRES_PASSWORD: orgos
      POSTGRES_DB: orgos
    ports: ["5433:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U orgos -d orgos"]
      interval: 2s
      timeout: 3s
      retries: 30
```

- [ ] **Step 2: server package.json + tsconfig + vitest config**

`server/package.json`:
```json
{
  "name": "@orgos/server",
  "private": true,
  "type": "module",
  "scripts": {
    "migrate": "tsx bin/migrate.ts",
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@fastify/cookie": "^11.0.2",
    "@fastify/cors": "^11.0.1",
    "ajv": "^8.17.1",
    "ajv-formats": "^3.0.1",
    "fastify": "^5.2.1",
    "postgres": "^3.4.5",
    "uuidv7": "^1.0.2"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

`server/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "outDir": "dist"
  },
  "include": ["src", "bin", "test"]
}
```

`server/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 20000, hookTimeout: 30000 },
})
```

`server/.gitignore`:
```
node_modules
dist
.env
```

`server/.env.example`:
```
SERVER_PORT=8787
WEB_ORIGIN=http://localhost:5173
DATABASE_URL=postgres://orgos:orgos@localhost:5433/orgos
DATABASE_URL_TEST=postgres://orgos:orgos@localhost:5433/orgos
SESSION_SECRET=change-me-to-a-long-random-string
MAGIC_LINK_TTL_SECONDS=900
NODE_ENV=development
```

- [ ] **Step 3: Write the failing test for uuid**

`server/test/infra/uuid.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { newId } from '../../src/infra/uuid.js'

describe('newId', () => {
  it('produces a valid uuid v7 (version nibble = 7)', () => {
    const id = newId()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('is time-ordered: later ids sort lexicographically after earlier ones', () => {
    const a = newId()
    const b = newId()
    expect(a < b || a.slice(0, 8) === b.slice(0, 8)).toBe(true)
    expect(a).not.toEqual(b)
  })
})
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd server && npm i && npx vitest run test/infra/uuid.test.ts`
Expected: FAIL — cannot resolve `../../src/infra/uuid.js`.

- [ ] **Step 5: Implement uuid wrapper**

`server/src/infra/uuid.ts`:
```ts
import { uuidv7 } from 'uuidv7'
/** App-side uuid v7: time-sortable identity, federation-safe (per-node). */
export function newId(): string {
  return uuidv7()
}
```

- [ ] **Step 6: Run uuid test — verify pass**

Run: `cd server && npx vitest run test/infra/uuid.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Implement config + db pool**

`server/src/config.ts`:
```ts
export interface Config {
  port: number
  webOrigin: string
  databaseUrl: string
  sessionSecret: string
  magicLinkTtlSeconds: number
  isDev: boolean
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const req = (k: string): string => {
    const v = env[k]
    if (!v) throw new Error(`missing env ${k}`)
    return v
  }
  return {
    port: Number(env.SERVER_PORT ?? 8787),
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:5173',
    databaseUrl: req('DATABASE_URL'),
    sessionSecret: req('SESSION_SECRET'),
    magicLinkTtlSeconds: Number(env.MAGIC_LINK_TTL_SECONDS ?? 900),
    isDev: (env.NODE_ENV ?? 'development') !== 'production',
  }
}
```

`server/src/infra/db.ts`:
```ts
import postgres from 'postgres'
export type Sql = postgres.Sql<{}>
export function makeDb(url: string): Sql {
  return postgres(url, { onnotice: () => {}, max: 10 })
}
```

- [ ] **Step 8: Migration runner + migrations 001/002**

`server/src/infra/migrate.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sql } from './db.js'

export async function runMigrations(sql: Sql, dir: string): Promise<string[]> {
  await sql`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []
  for (const name of files) {
    const done = await sql`SELECT 1 FROM schema_migration WHERE name = ${name}`
    if (done.length > 0) continue
    const text = await readFile(join(dir, name), 'utf8')
    await sql.begin(async (tx) => {
      await tx.unsafe(text)
      await tx`INSERT INTO schema_migration (name) VALUES (${name})`
    })
    applied.push(name)
  }
  return applied
}
```

`server/bin/migrate.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadConfig } from '../src/config.js'
import { makeDb } from '../src/infra/db.js'
import { runMigrations } from '../src/infra/migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = loadConfig()
const sql = makeDb(cfg.databaseUrl)
const applied = await runMigrations(sql, join(here, '..', 'migrations'))
console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date')
await sql.end()
```

`server/migrations/001_extensions.sql`:
```sql
CREATE EXTENSION IF NOT EXISTS pg_jsonschema;
```

`server/migrations/002_core.sql`:
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

CREATE TABLE projection_checkpoint (
  name            text        PRIMARY KEY,
  last_event_seq  bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

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

- [ ] **Step 9: Test helper for a throwaway DB schema**

`server/test/helpers/testDb.ts`:
```ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import postgres from 'postgres'
import type { Sql } from '../../src/infra/db.js'
import { runMigrations } from '../../src/infra/migrate.js'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS = join(here, '..', '..', 'migrations')

/** Create an isolated, migrated schema; returns the sql handle and a cleanup fn. */
export async function freshSchema(): Promise<{ sql: Sql; drop: () => Promise<void> }> {
  const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL
  if (!url) throw new Error('set DATABASE_URL_TEST')
  const schema = 'test_' + Math.abs(Date.now() ^ (Math.floor(performance.now() * 1000))).toString(36)
  const admin = postgres(url, { onnotice: () => {} })
  await admin`CREATE SCHEMA ${admin(schema)}`
  await admin.end()
  const sql = postgres(url, { onnotice: () => {}, connection: { search_path: schema } })
  await runMigrations(sql, MIGRATIONS)
  return {
    sql,
    drop: async () => {
      await sql.end()
      const a = postgres(url, { onnotice: () => {} })
      await a`DROP SCHEMA IF EXISTS ${a(schema)} CASCADE`
      await a.end()
    },
  }
}
```
> Note: `pg_jsonschema` is installed at the database level (migration 001 is a no-op `IF NOT EXISTS` inside each test schema). `search_path` isolation keeps each test's tables separate. Use `Date.now`/`performance.now` only in tests, never in `src/`.

- [ ] **Step 10: Write + run the db/migration integration test**

`server/test/infra/db.test.ts`:
```ts
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
beforeAll(async () => { ({ sql, drop } = await freshSchema()) })
afterAll(async () => { await drop() })

describe('migrations', () => {
  it('creates the core tables', async () => {
    const rows = await sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() ORDER BY table_name`
    const names = rows.map((r) => r.table_name)
    expect(names).toEqual(expect.arrayContaining([
      'actor', 'event', 'event_type', 'login_token', 'projection_checkpoint',
    ]))
  })
  it('event.seq is a strictly increasing identity', async () => {
    // requires a registered type to satisfy FK; insert a throwaway type
    const [t] = await sql`INSERT INTO event_type (id, namespace, name, version, schema)
      VALUES (${'00000000-0000-7000-8000-000000000001'}, 'x', 'a.b', 1, '{}'::jsonb) RETURNING id`
    const ins = async () => (await sql`INSERT INTO event
      (id, event_type_id, namespace, name, version, actor_id, org_id, payload)
      VALUES (gen_random_uuid(), ${t.id}, 'x', 'a.b', 1,
              ${'00000000-0000-7000-8000-000000000002'},
              ${'00000000-0000-7000-8000-000000000002'}, '{}'::jsonb)
      RETURNING seq`)[0].seq
    const s1 = await ins(); const s2 = await ins()
    expect(BigInt(s2)).toBeGreaterThan(BigInt(s1))
  })
})
```

Run: `docker compose up -d` then `cd server && npm run migrate && npx vitest run test/infra/db.test.ts`
Expected: PASS (2 tests). (First run `npm run migrate` applies 001/002 to the real DB so `pg_jsonschema` exists DB-wide.)

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml server/
git commit -m "feat(server): scaffold, postgres, config, uuid v7, core migrations"
```

---

### Task 2: Event-type registry + JSON schemas + ajv validators (domain)

**Files:**
- Create: `server/src/domain/events.ts`, `server/src/domain/eventTypes.ts`
- Create: `server/test/domain/eventTypes.test.ts`

**Interfaces:**
- Produces: `StoredEvent` interface (`domain/events.ts`). `EVENT_TYPES: Record<FqType, EventTypeDef>` where `FqType = 'identity.actor.registered@1' | 'identity.role.granted@1' | 'identity.role.revoked@1' | 'chat.thread.created@1' | 'chat.message.posted@1' | 'chat.message.edited@1' | 'chat.message.deleted@1'`. Each `EventTypeDef = { namespace, name, version, schema: object }`. `validatePayload(fq: string, payload: unknown): { ok: true } | { ok: false; errors: string[] }` (ajv). `parseFqType(fq): { namespace; name; version }`.

- [ ] **Step 1: Write the failing test**

`server/test/domain/eventTypes.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { EVENT_TYPES, validatePayload, parseFqType } from '../../src/domain/eventTypes.js'

describe('event type registry', () => {
  it('lists all beta types', () => {
    expect(Object.keys(EVENT_TYPES).sort()).toEqual([
      'chat.message.deleted@1', 'chat.message.edited@1', 'chat.message.posted@1',
      'chat.thread.created@1', 'identity.actor.registered@1',
      'identity.role.granted@1', 'identity.role.revoked@1',
    ])
  })
  it('parses a fully-qualified type', () => {
    expect(parseFqType('chat.message.posted@1')).toEqual({
      namespace: 'chat', name: 'message.posted', version: 1 })
  })
  it('accepts a valid chat.message.posted payload', () => {
    expect(validatePayload('chat.message.posted@1', { body: 'hi' })).toEqual({ ok: true })
  })
  it('rejects a chat.message.posted payload missing body', () => {
    const r = validatePayload('chat.message.posted@1', {})
    expect(r.ok).toBe(false)
  })
  it('rejects an unknown type', () => {
    const r = validatePayload('nope.no.no@1', {})
    expect(r.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run test/domain/eventTypes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement events.ts**

`server/src/domain/events.ts`:
```ts
export interface StoredEvent {
  id: string
  seq: string            // bigint as string
  namespace: string
  name: string
  version: number
  actorId: string
  orgId: string
  subjectId: string | null
  streamId: string | null
  streamSeq: string | null
  payload: Record<string, unknown>
  metadata: Record<string, unknown>
  occurredAt: string
  recordedAt: string
}
```

- [ ] **Step 4: Implement eventTypes.ts**

`server/src/domain/eventTypes.ts`:
```ts
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'

export interface EventTypeDef {
  namespace: string
  name: string
  version: number
  schema: Record<string, unknown>
}

const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object', additionalProperties: true, properties: props, required,
})

export const EVENT_TYPES = {
  'identity.actor.registered@1': {
    namespace: 'identity', name: 'actor.registered', version: 1,
    schema: obj({
      handle: { type: 'string', minLength: 1 },
      display_name: { type: 'string', minLength: 1 },
      kind: { type: 'string', enum: ['human', 'ai', 'device', 'org', 'project', 'workflow'] },
      email: { type: 'string', format: 'email' },
    }, ['handle', 'display_name', 'kind', 'email']),
  },
  'identity.role.granted@1': {
    namespace: 'identity', name: 'role.granted', version: 1,
    schema: obj({ role: { type: 'string', minLength: 1 } }, ['role']),
  },
  'identity.role.revoked@1': {
    namespace: 'identity', name: 'role.revoked', version: 1,
    schema: obj({ role: { type: 'string', minLength: 1 } }, ['role']),
  },
  'chat.thread.created@1': {
    namespace: 'chat', name: 'thread.created', version: 1,
    schema: obj({ title: { type: 'string', minLength: 1 } }, ['title']),
  },
  'chat.message.posted@1': {
    namespace: 'chat', name: 'message.posted', version: 1,
    schema: obj({ body: { type: 'string', minLength: 1 } }, ['body']),
  },
  'chat.message.edited@1': {
    namespace: 'chat', name: 'message.edited', version: 1,
    schema: obj({ body: { type: 'string', minLength: 1 }, edits_event_id: { type: 'string' } }, ['body']),
  },
  'chat.message.deleted@1': {
    namespace: 'chat', name: 'message.deleted', version: 1,
    schema: obj({}, []),
  },
} as const satisfies Record<string, EventTypeDef>

export type FqType = keyof typeof EVENT_TYPES

const ajv = new Ajv({ allErrors: true })
addFormats(ajv)
const validators = new Map<string, ValidateFunction>()
for (const [fq, def] of Object.entries(EVENT_TYPES)) {
  validators.set(fq, ajv.compile(def.schema))
}

export function parseFqType(fq: string): { namespace: string; name: string; version: number } {
  const m = /^([a-z0-9_]+)\.([a-z0-9_]+\.[a-z0-9_]+)@(\d+)$/.exec(fq)
  if (!m) throw new Error(`malformed type: ${fq}`)
  return { namespace: m[1]!, name: m[2]!, version: Number(m[3]) }
}

export function validatePayload(fq: string, payload: unknown):
  | { ok: true } | { ok: false; errors: string[] } {
  const v = validators.get(fq)
  if (!v) return { ok: false, errors: [`unknown event_type ${fq}`] }
  if (v(payload)) return { ok: true }
  return { ok: false, errors: (v.errors ?? []).map((e) => `${e.instancePath} ${e.message}`) }
}
```

- [ ] **Step 5: Run test — verify pass**

Run: `cd server && npx vitest run test/domain/eventTypes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/domain server/test/domain/eventTypes.test.ts
git commit -m "feat(domain): event-type registry with ajv validators"
```

---

### Task 3: Identity fold (domain, pure)

**Files:**
- Create: `server/src/domain/folds/identity.ts`
- Create: `server/test/domain/identityFold.test.ts`

**Interfaces:**
- Produces: `ActorState = { actor_id, handle, display_name, kind, status, email, roles: string[], last_event_seq: string }`. `foldIdentity(state: ActorState | null, e: StoredEvent): ActorState | null`. Handles `identity.actor.registered` (create), `identity.role.granted` / `identity.role.revoked` (mutate roles). Skips events with `seq <= state.last_event_seq` (idempotent).

- [ ] **Step 1: Write the failing test**

`server/test/domain/identityFold.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { foldIdentity, type ActorState } from '../../src/domain/folds/identity.js'
import type { StoredEvent } from '../../src/domain/events.js'

const ev = (over: Partial<StoredEvent>): StoredEvent => ({
  id: 'e', seq: '1', namespace: 'identity', name: 'actor.registered', version: 1,
  actorId: 'a1', orgId: 'o1', subjectId: 'a1', streamId: 'a1', streamSeq: '1',
  payload: {}, metadata: {}, occurredAt: '', recordedAt: '', ...over,
})

describe('foldIdentity', () => {
  it('registers an actor', () => {
    const s = foldIdentity(null, ev({
      seq: '5', subjectId: 'a1',
      payload: { handle: 'matt', display_name: 'Matt', kind: 'human', email: 'm@x.io' },
    }))
    expect(s).toMatchObject({ actor_id: 'a1', handle: 'matt', email: 'm@x.io', roles: [], last_event_seq: '5' })
  })
  it('grants then revokes a role', () => {
    let s = foldIdentity(null, ev({ seq: '1', payload: { handle: 'm', display_name: 'M', kind: 'human', email: 'm@x.io' } }))
    s = foldIdentity(s, ev({ seq: '2', name: 'role.granted', payload: { role: 'admin' } }))
    expect(s!.roles).toEqual(['admin'])
    s = foldIdentity(s, ev({ seq: '3', name: 'role.revoked', payload: { role: 'admin' } }))
    expect(s!.roles).toEqual([])
  })
  it('is idempotent: skips already-applied seq', () => {
    let s = foldIdentity(null, ev({ seq: '5', payload: { handle: 'm', display_name: 'M', kind: 'human', email: 'm@x.io' } }))
    const again = foldIdentity(s, ev({ seq: '5', name: 'role.granted', payload: { role: 'admin' } }))
    expect(again!.roles).toEqual([])
    expect(again!.last_event_seq).toEqual('5')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/domain/identityFold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the fold**

`server/src/domain/folds/identity.ts`:
```ts
import type { StoredEvent } from '../events.js'

export interface ActorState {
  actor_id: string
  handle: string
  display_name: string
  kind: string
  status: string
  email: string
  roles: string[]
  last_event_seq: string
}

const applied = (s: ActorState | null, e: StoredEvent): boolean =>
  s != null && BigInt(e.seq) <= BigInt(s.last_event_seq)

export function foldIdentity(state: ActorState | null, e: StoredEvent): ActorState | null {
  if (applied(state, e)) return state
  const seq = e.seq
  if (e.name === 'actor.registered') {
    const p = e.payload as Record<string, string>
    return {
      actor_id: e.subjectId!, handle: p.handle!, display_name: p.display_name!,
      kind: p.kind!, status: 'active', email: p.email!, roles: [], last_event_seq: seq,
    }
  }
  if (state == null) return state
  if (e.name === 'role.granted') {
    const role = (e.payload as { role: string }).role
    const roles = state.roles.includes(role) ? state.roles : [...state.roles, role]
    return { ...state, roles, last_event_seq: seq }
  }
  if (e.name === 'role.revoked') {
    const role = (e.payload as { role: string }).role
    return { ...state, roles: state.roles.filter((r) => r !== role), last_event_seq: seq }
  }
  return { ...state, last_event_seq: seq }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && npx vitest run test/domain/identityFold.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/domain/folds/identity.ts server/test/domain/identityFold.test.ts
git commit -m "feat(domain): identity fold (register, grant/revoke roles)"
```

---

### Task 4: Chat fold (domain, pure)

**Files:**
- Create: `server/src/domain/folds/chat.ts`
- Create: `server/test/domain/chatFold.test.ts`

**Interfaces:**
- Produces: `ChatThread = { thread_id, title, created_by, created_at, last_event_seq }`. `ChatMessage = { message_id, thread_id, author_id, body, posted_at, edited_at: string | null, deleted: boolean, last_event_seq }`. `foldChatThread(state, e): ChatThread | null` (handles `chat.thread.created`). `foldChatMessage(state, e): ChatMessage | null` (handles `message.posted` / `edited` / `deleted`). Both idempotent on `last_event_seq`.

- [ ] **Step 1: Write the failing test**

`server/test/domain/chatFold.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { foldChatThread, foldChatMessage } from '../../src/domain/folds/chat.js'
import type { StoredEvent } from '../../src/domain/events.js'

const ev = (over: Partial<StoredEvent>): StoredEvent => ({
  id: 'e', seq: '1', namespace: 'chat', name: 'message.posted', version: 1,
  actorId: 'a1', orgId: 'o1', subjectId: 'm1', streamId: 't1', streamSeq: '1',
  payload: {}, metadata: {}, occurredAt: '2026-01-01T00:00:00Z', recordedAt: '', ...over,
})

describe('foldChatThread', () => {
  it('creates a thread', () => {
    const t = foldChatThread(null, ev({ seq: '1', name: 'thread.created', subjectId: 't1', payload: { title: 'general' } }))
    expect(t).toMatchObject({ thread_id: 't1', title: 'general', created_by: 'a1', last_event_seq: '1' })
  })
})

describe('foldChatMessage', () => {
  it('posts a message', () => {
    const m = foldChatMessage(null, ev({ seq: '2', subjectId: 'm1', payload: { body: 'hi' } }))
    expect(m).toMatchObject({ message_id: 'm1', thread_id: 't1', author_id: 'a1', body: 'hi', deleted: false })
  })
  it('edits then deletes', () => {
    let m = foldChatMessage(null, ev({ seq: '2', payload: { body: 'hi' } }))
    m = foldChatMessage(m, ev({ seq: '3', name: 'message.edited', payload: { body: 'hello' } }))
    expect(m).toMatchObject({ body: 'hello' })
    expect(m!.edited_at).not.toBeNull()
    m = foldChatMessage(m, ev({ seq: '4', name: 'message.deleted', payload: {} }))
    expect(m!.deleted).toBe(true)
  })
  it('skips out-of-order (already applied) events', () => {
    let m = foldChatMessage(null, ev({ seq: '5', payload: { body: 'hi' } }))
    m = foldChatMessage(m, ev({ seq: '3', name: 'message.edited', payload: { body: 'stale' } }))
    expect(m!.body).toBe('hi')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/domain/chatFold.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the chat folds**

`server/src/domain/folds/chat.ts`:
```ts
import type { StoredEvent } from '../events.js'

export interface ChatThread {
  thread_id: string; title: string; created_by: string
  created_at: string; last_event_seq: string
}
export interface ChatMessage {
  message_id: string; thread_id: string; author_id: string; body: string
  posted_at: string; edited_at: string | null; deleted: boolean; last_event_seq: string
}

const seen = (last: string | undefined, e: StoredEvent): boolean =>
  last != null && BigInt(e.seq) <= BigInt(last)

export function foldChatThread(state: ChatThread | null, e: StoredEvent): ChatThread | null {
  if (seen(state?.last_event_seq, e)) return state
  if (e.name === 'thread.created') {
    return {
      thread_id: e.subjectId!, title: (e.payload as { title: string }).title,
      created_by: e.actorId, created_at: e.occurredAt, last_event_seq: e.seq,
    }
  }
  return state ? { ...state, last_event_seq: e.seq } : state
}

export function foldChatMessage(state: ChatMessage | null, e: StoredEvent): ChatMessage | null {
  if (seen(state?.last_event_seq, e)) return state
  if (e.name === 'message.posted') {
    return {
      message_id: e.subjectId!, thread_id: e.streamId!, author_id: e.actorId,
      body: (e.payload as { body: string }).body, posted_at: e.occurredAt,
      edited_at: null, deleted: false, last_event_seq: e.seq,
    }
  }
  if (state == null) return state
  if (e.name === 'message.edited') {
    return { ...state, body: (e.payload as { body: string }).body, edited_at: e.occurredAt, last_event_seq: e.seq }
  }
  if (e.name === 'message.deleted') {
    return { ...state, deleted: true, last_event_seq: e.seq }
  }
  return { ...state, last_event_seq: e.seq }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && npx vitest run test/domain/chatFold.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/domain/folds/chat.ts server/test/domain/chatFold.test.ts
git commit -m "feat(domain): chat thread + message folds"
```

---

### Task 5: Triggers migration + appender + schema cache (infra)

**Files:**
- Create: `server/migrations/003_triggers.sql`
- Create: `server/src/infra/schemaCache.ts`, `server/src/infra/appender.ts`
- Create: `server/test/infra/appender.test.ts`

**Interfaces:**
- Consumes: `Sql` (db.ts), `newId` (uuid.ts), `parseFqType` (eventTypes.ts).
- Produces: `AppendInput = { type: string; actorId: string; orgId: string; subjectId: string | null; streamId: string | null; streamSeq: number | null; payload: Record<string, unknown>; metadata?: Record<string, unknown> }`. `makeAppender(sql): { append(input): Promise<{ id: string; seq: string }> }`. Throws `ConcurrencyError` (has `.currentVersion`) on 23505 stream collision; throws `ValidationError` on trigger reject (22000/`P0001` raised by trigger). `loadSchemaCache(sql): Promise<Map<fq,id>>` resolving fq type → `event_type.id`.

- [ ] **Step 1: Triggers migration**

`server/migrations/003_triggers.sql`:
```sql
CREATE OR REPLACE FUNCTION event_validate() RETURNS trigger AS $$
DECLARE s jsonb;
BEGIN
  SELECT schema INTO s FROM event_type WHERE id = NEW.event_type_id;
  IF s IS NULL THEN
    RAISE EXCEPTION 'unknown event_type %', NEW.event_type_id USING ERRCODE = 'P0001';
  END IF;
  IF NOT jsonb_matches_schema(s, NEW.payload) THEN
    RAISE EXCEPTION 'payload fails schema for %.%@%', NEW.namespace, NEW.name, NEW.version
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_validate_trg BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_validate();

CREATE OR REPLACE FUNCTION event_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('events', NEW.seq::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER event_notify_trg AFTER INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION event_notify();
```

- [ ] **Step 2: Write the failing appender test**

`server/test/infra/appender.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender, ConcurrencyError, ValidationError } from '../../src/infra/appender.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-0000000000aa'
const ACT = '00000000-0000-7000-8000-0000000000bb'

beforeAll(async () => {
  ;({ sql, drop } = await freshSchema())
  // seed the two types this test uses
  await sql`INSERT INTO event_type (id, namespace, name, version, schema) VALUES
    (gen_random_uuid(), 'chat', 'thread.created', 1,
     '{"type":"object","properties":{"title":{"type":"string","minLength":1}},"required":["title"]}'::jsonb),
    (gen_random_uuid(), 'chat', 'message.posted', 1,
     '{"type":"object","properties":{"body":{"type":"string","minLength":1}},"required":["body"]}'::jsonb)`
})
afterAll(async () => { await drop() })

describe('appender', () => {
  it('appends a valid event and returns id+seq', async () => {
    const app = makeAppender(sql)
    const r = await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG,
      subjectId: '00000000-0000-7000-8000-0000000000c1', streamId: '00000000-0000-7000-8000-0000000000c1',
      streamSeq: 1, payload: { title: 'general' } })
    expect(r.id).toMatch(/-7[0-9a-f]{3}-/)
    expect(BigInt(r.seq)).toBeGreaterThan(0n)
  })
  it('rejects a schema-invalid payload (trigger) as ValidationError', async () => {
    const app = makeAppender(sql)
    await expect(app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: '00000000-0000-7000-8000-0000000000c2', streamId: '00000000-0000-7000-8000-0000000000c2',
      streamSeq: 1, payload: { body: '' } })).rejects.toBeInstanceOf(ValidationError)
  })
  it('rejects a colliding stream_seq as ConcurrencyError', async () => {
    const app = makeAppender(sql)
    const stream = '00000000-0000-7000-8000-0000000000c3'
    await app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: stream, streamId: stream, streamSeq: 1, payload: { body: 'a' } })
    await expect(app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG,
      subjectId: stream, streamId: stream, streamSeq: 1, payload: { body: 'b' } }))
      .rejects.toBeInstanceOf(ConcurrencyError)
  })
})
```

- [ ] **Step 3: Run to verify fail**

Run: `cd server && npm run migrate && npx vitest run test/infra/appender.test.ts`
Expected: FAIL — `appender.js` not found. (`npm run migrate` now applies 003 to the real DB.)

- [ ] **Step 4: Implement schema cache + appender**

`server/src/infra/schemaCache.ts`:
```ts
import type { Sql } from './db.js'
import { EVENT_TYPES, parseFqType } from '../domain/eventTypes.js'

/** Map fully-qualified type → event_type.id (cached in-process). */
export async function loadSchemaCache(sql: Sql): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; namespace: string; name: string; version: number }[]>`
    SELECT id, namespace, name, version FROM event_type`
  const byKey = new Map<string, string>()
  for (const r of rows) byKey.set(`${r.namespace}.${r.name}@${r.version}`, r.id)
  // sanity: every registered type should exist in the DB after seeding
  for (const fq of Object.keys(EVENT_TYPES)) {
    const { namespace, name, version } = parseFqType(fq)
    const id = byKey.get(`${namespace}.${name}@${version}`)
    if (id) byKey.set(fq, id)
  }
  return byKey
}
```

`server/src/infra/appender.ts`:
```ts
import type { Sql } from './db.js'
import { newId } from './uuid.js'
import { parseFqType } from '../domain/eventTypes.js'
import { loadSchemaCache } from './schemaCache.js'

export interface AppendInput {
  type: string
  actorId: string
  orgId: string
  subjectId: string | null
  streamId: string | null
  streamSeq: number | null
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export class ConcurrencyError extends Error {
  constructor(public currentVersion: string | null) { super('stream version conflict') }
}
export class ValidationError extends Error {}

export function makeAppender(sql: Sql) {
  let cache: Map<string, string> | null = null
  const typeId = async (fq: string): Promise<string> => {
    if (!cache) cache = await loadSchemaCache(sql)
    let id = cache.get(fq)
    if (!id) { cache = await loadSchemaCache(sql); id = cache.get(fq) }
    if (!id) throw new ValidationError(`unknown event_type ${fq}`)
    return id
  }
  return {
    async append(input: AppendInput): Promise<{ id: string; seq: string }> {
      const { namespace, name, version } = parseFqType(input.type)
      const etId = await typeId(input.type)
      const id = newId()
      try {
        const rows = await sql<{ id: string; seq: string }[]>`
          INSERT INTO event (id, event_type_id, namespace, name, version, actor_id, org_id,
                             subject_id, stream_id, stream_seq, payload, metadata)
          VALUES (${id}, ${etId}, ${namespace}, ${name}, ${version}, ${input.actorId}, ${input.orgId},
                  ${input.subjectId}, ${input.streamId}, ${input.streamSeq},
                  ${sql.json(input.payload)}, ${sql.json(input.metadata ?? {})})
          RETURNING id, seq::text`
        return rows[0]!
      } catch (err) {
        const e = err as { code?: string; message?: string }
        if (e.code === '23505') {
          const cur = await sql<{ v: string | null }[]>`
            SELECT max(stream_seq)::text AS v FROM event WHERE stream_id = ${input.streamId}`
          throw new ConcurrencyError(cur[0]?.v ?? null)
        }
        if (e.code === 'P0001') throw new ValidationError(e.message ?? 'payload validation failed')
        throw err
      }
    },
  }
}
```

- [ ] **Step 5: Run — verify pass**

Run: `cd server && npx vitest run test/infra/appender.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/migrations/003_triggers.sql server/src/infra/schemaCache.ts server/src/infra/appender.ts server/test/infra/appender.test.ts
git commit -m "feat(infra): validate/notify triggers + appender with optimistic concurrency"
```

---

### Task 6: Generic projector + projection migrations + seed (infra)

**Files:**
- Create: `server/migrations/004_projections.sql`, `server/migrations/005_seed.sql`
- Create: `server/src/infra/projector.ts`
- Create: `server/test/infra/projector.test.ts`

**Interfaces:**
- Consumes: `Sql`, the folds from Task 3/4, `StoredEvent`.
- Produces: `rowToEvent(row): StoredEvent` mapper. `Projection = { name: string; handle(sql, e: StoredEvent): Promise<void> }`. `makeProjector(sql, projections: Projection[]): { tick(): Promise<void>; start(): Promise<void>; stop(): Promise<void> }`. `tick()` runs one catch-up pass (read checkpoint → select seq>cp → handle each → advance checkpoint, per projection, transactional). `start()` does an initial `tick()` then `LISTEN events` re-ticking on NOTIFY. Build the two beta projections: `identityProjection`, `chatProjection`.

- [ ] **Step 1: Projection read-model migration**

`server/migrations/004_projections.sql`:
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

CREATE TABLE chat_thread (
  thread_id       uuid        PRIMARY KEY,
  title           text        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL,
  last_event_seq  bigint      NOT NULL
);

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

- [ ] **Step 2: Seed migration (local org actor + event types)**

`server/migrations/005_seed.sql`:
```sql
-- local org root actor (org is its own org_id)
INSERT INTO actor (id, kind, handle, display_name, org_id, status)
VALUES ('00000000-0000-7000-8000-00000000c0de', 'org', 'org', 'Local Org',
        '00000000-0000-7000-8000-00000000c0de', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO event_type (id, namespace, name, version, schema, owner) VALUES
('00000000-0000-7000-8000-000000000101','identity','actor.registered',1,
 '{"type":"object","additionalProperties":true,"required":["handle","display_name","kind","email"],"properties":{"handle":{"type":"string","minLength":1},"display_name":{"type":"string","minLength":1},"kind":{"type":"string","enum":["human","ai","device","org","project","workflow"]},"email":{"type":"string","format":"email"}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000102','identity','role.granted',1,
 '{"type":"object","additionalProperties":true,"required":["role"],"properties":{"role":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000103','identity','role.revoked',1,
 '{"type":"object","additionalProperties":true,"required":["role"],"properties":{"role":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000201','chat','thread.created',1,
 '{"type":"object","additionalProperties":true,"required":["title"],"properties":{"title":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000202','chat','message.posted',1,
 '{"type":"object","additionalProperties":true,"required":["body"],"properties":{"body":{"type":"string","minLength":1}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000203','chat','message.edited',1,
 '{"type":"object","additionalProperties":true,"required":["body"],"properties":{"body":{"type":"string","minLength":1},"edits_event_id":{"type":"string"}}}'::jsonb,'core'),
('00000000-0000-7000-8000-000000000204','chat','message.deleted',1,
 '{"type":"object","additionalProperties":true,"properties":{}}'::jsonb,'core')
ON CONFLICT DO NOTHING;

INSERT INTO projection_checkpoint (name, last_event_seq) VALUES
('identity', 0), ('chat', 0) ON CONFLICT DO NOTHING;
```
> The email format check is intentionally enforced by ajv app-side; `pg_jsonschema` validates structure/required/enum. Keep the DB schema permissive about `format` (some `pg_jsonschema` builds ignore `format`), authoritative about shape.

- [ ] **Step 3: Write the failing projector test**

`server/test/infra/projector.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender } from '../../src/infra/appender.js'
import { makeProjector, identityProjection, chatProjection } from '../../src/infra/projector.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-00000000c0de'
const ACT = '00000000-0000-7000-8000-0000000000bb'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(new URL('../../migrations/005_seed.sql', import.meta.url).pathname)
})
afterEach(async () => { await drop() })

describe('projector', () => {
  it('materializes a chat thread + message after tick()', async () => {
    const app = makeAppender(sql)
    const thread = '00000000-0000-7000-8000-0000000000d1'
    const msg = '00000000-0000-7000-8000-0000000000d2'
    await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG, subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 'general' } })
    await app.append({ type: 'chat.message.posted@1', actorId: ACT, orgId: ORG, subjectId: msg, streamId: thread, streamSeq: 2, payload: { body: 'hi' } })

    const proj = makeProjector(sql, [chatProjection])
    await proj.tick()

    const threads = await sql`SELECT * FROM chat_thread`
    const msgs = await sql`SELECT * FROM chat_message`
    expect(threads).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ body: 'hi', thread_id: thread })
    const cp = await sql`SELECT last_event_seq FROM projection_checkpoint WHERE name='chat'`
    expect(BigInt(cp[0].last_event_seq)).toBeGreaterThan(0n)
  })

  it('rebuild from zero reproduces identical state', async () => {
    const app = makeAppender(sql)
    const thread = '00000000-0000-7000-8000-0000000000e1'
    await app.append({ type: 'chat.thread.created@1', actorId: ACT, orgId: ORG, subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 't' } })
    const proj = makeProjector(sql, [chatProjection])
    await proj.tick()
    await sql`TRUNCATE chat_thread, chat_message`
    await sql`UPDATE projection_checkpoint SET last_event_seq = 0 WHERE name='chat'`
    await proj.tick()
    const threads = await sql`SELECT * FROM chat_thread`
    expect(threads).toHaveLength(1)
  })

  it('identity projection registers an actor', async () => {
    const app = makeAppender(sql)
    const a = '00000000-0000-7000-8000-0000000000f1'
    await app.append({ type: 'identity.actor.registered@1', actorId: a, orgId: ORG, subjectId: a, streamId: a, streamSeq: 1, payload: { handle: 'matt', display_name: 'Matt', kind: 'human', email: 'm@x.io' } })
    const proj = makeProjector(sql, [identityProjection])
    await proj.tick()
    const rows = await sql`SELECT * FROM actor_state WHERE email='m@x.io'`
    expect(rows[0]).toMatchObject({ handle: 'matt' })
  })
})
```

- [ ] **Step 4: Run to verify fail**

Run: `cd server && npm run migrate && npx vitest run test/infra/projector.test.ts`
Expected: FAIL — `projector.js` not found.

- [ ] **Step 5: Implement the projector + the two projections**

`server/src/infra/projector.ts`:
```ts
import postgres from 'postgres'
import type { Sql } from './db.js'
import type { StoredEvent } from '../domain/events.js'
import { foldIdentity, type ActorState } from '../domain/folds/identity.js'
import { foldChatThread, foldChatMessage } from '../domain/folds/chat.js'

export function rowToEvent(r: any): StoredEvent {
  return {
    id: r.id, seq: String(r.seq), namespace: r.namespace, name: r.name, version: r.version,
    actorId: r.actor_id, orgId: r.org_id, subjectId: r.subject_id, streamId: r.stream_id,
    streamSeq: r.stream_seq == null ? null : String(r.stream_seq),
    payload: r.payload, metadata: r.metadata,
    occurredAt: new Date(r.occurred_at).toISOString(),
    recordedAt: new Date(r.recorded_at).toISOString(),
  }
}

export interface Projection {
  name: string
  /** namespaces this projection consumes (filter for catch-up) */
  namespaces: string[]
  handle(sql: Sql, e: StoredEvent): Promise<void>
}

export const identityProjection: Projection = {
  name: 'identity',
  namespaces: ['identity'],
  async handle(sql, e) {
    const cur = await sql<any[]>`SELECT * FROM actor_state WHERE actor_id = ${e.subjectId}`
    const prev: ActorState | null = cur[0]
      ? { actor_id: cur[0].actor_id, handle: cur[0].handle, display_name: cur[0].display_name,
          kind: cur[0].kind, status: cur[0].status, email: cur[0].email,
          roles: cur[0].roles, last_event_seq: String(cur[0].last_event_seq) }
      : null
    const next = foldIdentity(prev, e)
    if (!next || next === prev) return
    await sql`INSERT INTO actor_state
      (actor_id, handle, display_name, kind, status, email, roles, last_event_seq)
      VALUES (${next.actor_id}, ${next.handle}, ${next.display_name}, ${next.kind},
              ${next.status}, ${next.email}, ${next.roles}, ${next.last_event_seq})
      ON CONFLICT (actor_id) DO UPDATE SET
        handle = EXCLUDED.handle, display_name = EXCLUDED.display_name, kind = EXCLUDED.kind,
        status = EXCLUDED.status, email = EXCLUDED.email, roles = EXCLUDED.roles,
        last_event_seq = EXCLUDED.last_event_seq`
  },
}

export const chatProjection: Projection = {
  name: 'chat',
  namespaces: ['chat'],
  async handle(sql, e) {
    if (e.name === 'thread.created') {
      const next = foldChatThread(null, e)!
      await sql`INSERT INTO chat_thread (thread_id, title, created_by, created_at, last_event_seq)
        VALUES (${next.thread_id}, ${next.title}, ${next.created_by}, ${next.created_at}, ${next.last_event_seq})
        ON CONFLICT (thread_id) DO UPDATE SET last_event_seq = EXCLUDED.last_event_seq`
      return
    }
    // message.*  — subject_id is the message id
    const cur = await sql<any[]>`SELECT * FROM chat_message WHERE message_id = ${e.subjectId}`
    const prev = cur[0]
      ? { message_id: cur[0].message_id, thread_id: cur[0].thread_id, author_id: cur[0].author_id,
          body: cur[0].body, posted_at: new Date(cur[0].posted_at).toISOString(),
          edited_at: cur[0].edited_at ? new Date(cur[0].edited_at).toISOString() : null,
          deleted: cur[0].deleted, last_event_seq: String(cur[0].last_event_seq) }
      : null
    const next = foldChatMessage(prev, e)
    if (!next || next === prev) return
    await sql`INSERT INTO chat_message
      (message_id, thread_id, author_id, body, posted_at, edited_at, deleted, last_event_seq)
      VALUES (${next.message_id}, ${next.thread_id}, ${next.author_id}, ${next.body},
              ${next.posted_at}, ${next.edited_at}, ${next.deleted}, ${next.last_event_seq})
      ON CONFLICT (message_id) DO UPDATE SET
        body = EXCLUDED.body, edited_at = EXCLUDED.edited_at, deleted = EXCLUDED.deleted,
        last_event_seq = EXCLUDED.last_event_seq`
  },
}

const BATCH = 1000

export function makeProjector(sql: Sql, projections: Projection[]) {
  let listener: postgres.ListenMeta | null = null
  let ticking = false
  let pending = false

  async function tickOne(p: Projection): Promise<void> {
    for (;;) {
      const cp = await sql<{ last_event_seq: string }[]>`
        SELECT last_event_seq::text FROM projection_checkpoint WHERE name = ${p.name}`
      const from = cp[0]?.last_event_seq ?? '0'
      const rows = await sql<any[]>`
        SELECT * FROM event
        WHERE seq > ${from} AND namespace = ANY(${p.namespaces})
        ORDER BY seq LIMIT ${BATCH}`
      // advance checkpoint to the max seq we have *examined*, even if filtered,
      // by tracking the largest seq in a separate unfiltered probe:
      if (rows.length === 0) {
        const head = await sql<{ seq: string }[]>`SELECT max(seq)::text AS seq FROM event WHERE seq > ${from}`
        const maxSeq = head[0]?.seq
        if (maxSeq) {
          await sql`UPDATE projection_checkpoint SET last_event_seq = ${maxSeq}, updated_at = now() WHERE name = ${p.name}`
          continue
        }
        return
      }
      await sql.begin(async (tx) => {
        let last = from
        for (const r of rows) { await p.handle(tx as unknown as Sql, rowToEvent(r)); last = String(r.seq) }
        await tx`UPDATE projection_checkpoint SET last_event_seq = ${last}, updated_at = now() WHERE name = ${p.name}`
      })
      if (rows.length < BATCH) return
    }
  }

  async function tick(): Promise<void> {
    if (ticking) { pending = true; return }
    ticking = true
    try {
      do { pending = false; for (const p of projections) await tickOne(p) } while (pending)
    } finally { ticking = false }
  }

  return {
    tick,
    async start() {
      await tick()
      listener = await sql.listen('events', () => { void tick() })
    },
    async stop() { if (listener) await listener.unlisten() },
  }
}
```
> Checkpoint advances to the global head even when a projection's namespace filter skips rows, so `seq > checkpoint` never re-scans the whole log. Catch-up correctness holds; folds stay idempotent via `last_event_seq`.

- [ ] **Step 6: Run — verify pass**

Run: `cd server && npx vitest run test/infra/projector.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add server/migrations/004_projections.sql server/migrations/005_seed.sql server/src/infra/projector.ts server/test/infra/projector.test.ts
git commit -m "feat(infra): generic projector + chat/identity projections + seed"
```

---

### Task 7: Login tokens + console mailer (infra)

**Files:**
- Create: `server/src/infra/mailer.ts`, `server/src/infra/loginTokens.ts`
- Create: `server/test/infra/loginTokens.test.ts`

**Interfaces:**
- Consumes: `Sql`.
- Produces: `interface Mailer { sendMagicLink(to: string, link: string): Promise<void> }`. `class ConsoleMailer implements Mailer` (captures `last` link for tests, logs to console). `makeLoginTokens(sql, ttlSeconds): { issue(email): Promise<string> /* raw token */, consume(token): Promise<string | null> /* email or null */ }`. `issue` stores `sha256(token)`; `consume` is single-use + expiry-checked (atomic `UPDATE ... WHERE used_at IS NULL AND expires_at > now() RETURNING email`).

- [ ] **Step 1: Write the failing test**

`server/test/infra/loginTokens.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeLoginTokens } from '../../src/infra/loginTokens.js'
import { ConsoleMailer } from '../../src/infra/mailer.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
beforeAll(async () => { ({ sql, drop } = await freshSchema()) })
afterAll(async () => { await drop() })

describe('loginTokens', () => {
  it('issues then consumes a token exactly once', async () => {
    const lt = makeLoginTokens(sql, 900)
    const token = await lt.issue('m@x.io')
    expect(token.length).toBeGreaterThan(20)
    expect(await lt.consume(token)).toBe('m@x.io')
    expect(await lt.consume(token)).toBeNull()   // single-use
  })
  it('rejects an expired token', async () => {
    const lt = makeLoginTokens(sql, -1)            // already expired
    const token = await lt.issue('e@x.io')
    expect(await lt.consume(token)).toBeNull()
  })
  it('rejects an unknown token', async () => {
    const lt = makeLoginTokens(sql, 900)
    expect(await lt.consume('garbage')).toBeNull()
  })
})

describe('ConsoleMailer', () => {
  it('captures the link', async () => {
    const m = new ConsoleMailer()
    await m.sendMagicLink('m@x.io', 'http://x/auth/callback?token=abc')
    expect(m.last).toEqual({ to: 'm@x.io', link: 'http://x/auth/callback?token=abc' })
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/infra/loginTokens.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement mailer + loginTokens**

`server/src/infra/mailer.ts`:
```ts
export interface Mailer {
  sendMagicLink(to: string, link: string): Promise<void>
}

/** Dev mailer: logs the link and remembers the last one (for tests / dev UI). */
export class ConsoleMailer implements Mailer {
  last: { to: string; link: string } | null = null
  async sendMagicLink(to: string, link: string): Promise<void> {
    this.last = { to, link }
    console.log(`\n[magic-link] to=${to}\n  ${link}\n`)
  }
}
```

`server/src/infra/loginTokens.ts`:
```ts
import { randomBytes, createHash } from 'node:crypto'
import type { Sql } from './db.js'

const hash = (t: string): string => createHash('sha256').update(t).digest('hex')

export function makeLoginTokens(sql: Sql, ttlSeconds: number) {
  return {
    async issue(email: string): Promise<string> {
      const token = randomBytes(32).toString('base64url')
      await sql`INSERT INTO login_token (token_hash, email, expires_at)
        VALUES (${hash(token)}, ${email}, now() + (${ttlSeconds} * interval '1 second'))`
      return token
    },
    async consume(token: string): Promise<string | null> {
      const rows = await sql<{ email: string }[]>`
        UPDATE login_token SET used_at = now()
        WHERE token_hash = ${hash(token)} AND used_at IS NULL AND expires_at > now()
        RETURNING email`
      return rows[0]?.email ?? null
    },
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd server && npx vitest run test/infra/loginTokens.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/infra/mailer.ts server/src/infra/loginTokens.ts server/test/infra/loginTokens.test.ts
git commit -m "feat(infra): single-use magic-link tokens + console mailer"
```

---

### Task 8: Application — commands, queries, authz, identity

**Files:**
- Create: `server/src/app/authz.ts`, `server/src/app/commands.ts`, `server/src/app/queries.ts`, `server/src/app/identity.ts`
- Create: `server/test/app/commands.test.ts`, `server/test/app/identity.test.ts`

**Interfaces:**
- Consumes: appender (`AppendInput`, errors), `validatePayload`, folds' types, `Sql`, `makeLoginTokens`, `Mailer`.
- Produces:
  - `authz.canAppend(actor: { roles: string[] }, type: string): boolean` — beta: allows `chat.*` and `identity.actor.registered`; everything else requires role `admin`.
  - `makeCommands({ appender, syncProjections })` → `appendEvent(actor, input): Promise<{ id; seq }>` — runs `canAppend`, ajv `validatePayload`, then `appender.append`, then `syncProjections()`. Throws `AuthzError`, `ValidationError`, `ConcurrencyError`.
  - `makeQueries(sql)` → `listActors()`, `listThreads()`, `getThread(threadId)` returns `{ threadId, streamVersion: number, messages }`.
  - `makeIdentity({ sql, appender, syncProjections, orgId })` → `resolveActor({ email, name? }): Promise<{ actorId: string; handle: string }>` — find by `actor_state.email`; else register (`identity.actor.registered@1`, self-actored) then `syncProjections()`.

- [ ] **Step 1: Write failing tests (commands + identity)**

`server/test/app/commands.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { makeCommands, AuthzError } from '../../src/app/commands.js'
import { ValidationError } from '../../src/infra/appender.js'

const fakeAppender = () => ({ append: vi.fn(async () => ({ id: 'id1', seq: '7' })) })

describe('appendEvent command', () => {
  it('validates, appends, and syncs projections', async () => {
    const appender = fakeAppender()
    const sync = vi.fn(async () => {})
    const cmd = makeCommands({ appender: appender as any, syncProjections: sync })
    const r = await cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'chat.message.posted@1', subjectId: 'm1', streamId: 't1', streamSeq: 2, payload: { body: 'hi' },
    })
    expect(r).toEqual({ id: 'id1', seq: '7' })
    expect(appender.append).toHaveBeenCalledOnce()
    expect(sync).toHaveBeenCalledOnce()
  })
  it('rejects an invalid payload before appending', async () => {
    const appender = fakeAppender()
    const cmd = makeCommands({ appender: appender as any, syncProjections: vi.fn() })
    await expect(cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'chat.message.posted@1', subjectId: 'm1', streamId: 't1', streamSeq: 2, payload: { body: '' },
    })).rejects.toBeInstanceOf(ValidationError)
    expect(appender.append).not.toHaveBeenCalled()
  })
  it('rejects an unauthorized type', async () => {
    const cmd = makeCommands({ appender: fakeAppender() as any, syncProjections: vi.fn() })
    await expect(cmd.appendEvent({ actorId: 'a1', orgId: 'o1', roles: [] }, {
      type: 'identity.role.granted@1', subjectId: 'a1', streamId: 'a1', streamSeq: 1, payload: { role: 'admin' },
    })).rejects.toBeInstanceOf(AuthzError)
  })
})
```

`server/test/app/identity.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { makeAppender } from '../../src/infra/appender.js'
import { makeProjector, identityProjection } from '../../src/infra/projector.js'
import { makeIdentity } from '../../src/app/identity.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>
const ORG = '00000000-0000-7000-8000-00000000c0de'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(new URL('../../migrations/005_seed.sql', import.meta.url).pathname)
})
afterEach(async () => { await drop() })

describe('resolveActor', () => {
  it('registers a new actor on first sight, returns the same on second', async () => {
    const appender = makeAppender(sql)
    const proj = makeProjector(sql, [identityProjection])
    const identity = makeIdentity({ sql, appender, syncProjections: () => proj.tick(), orgId: ORG })

    const a = await identity.resolveActor({ email: 'matt@x.io' })
    expect(a.actorId).toMatch(/-7[0-9a-f]{3}-/)
    const rows = await sql`SELECT * FROM actor_state WHERE email='matt@x.io'`
    expect(rows).toHaveLength(1)

    const b = await identity.resolveActor({ email: 'matt@x.io' })
    expect(b.actorId).toBe(a.actorId)              // no duplicate registration
    const after = await sql`SELECT count(*)::int AS n FROM event WHERE namespace='identity'`
    expect(after[0].n).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/app`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement authz**

`server/src/app/authz.ts`:
```ts
export interface ActorCtx { actorId: string; orgId: string; roles: string[] }

/** Beta policy: anyone may chat and self-register; admin-only for everything else. */
export function canAppend(actor: Pick<ActorCtx, 'roles'>, type: string): boolean {
  if (type.startsWith('chat.')) return true
  if (type === 'identity.actor.registered@1') return true
  return actor.roles.includes('admin')
}
```

- [ ] **Step 4: Implement commands**

`server/src/app/commands.ts`:
```ts
import type { AppendInput } from '../infra/appender.js'
import { ValidationError } from '../infra/appender.js'
import { validatePayload } from '../domain/eventTypes.js'
import { canAppend, type ActorCtx } from './authz.js'

export class AuthzError extends Error {}

interface Appender { append(i: AppendInput): Promise<{ id: string; seq: string }> }
interface Deps { appender: Appender; syncProjections: () => Promise<void> }

export interface AppendRequest {
  type: string
  subjectId: string | null
  streamId: string | null
  streamSeq: number | null
  payload: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export function makeCommands({ appender, syncProjections }: Deps) {
  return {
    async appendEvent(actor: ActorCtx, req: AppendRequest): Promise<{ id: string; seq: string }> {
      if (!canAppend(actor, req.type)) throw new AuthzError(`not permitted to append ${req.type}`)
      const v = validatePayload(req.type, req.payload)
      if (!v.ok) throw new ValidationError(v.errors.join('; '))
      const r = await appender.append({
        type: req.type, actorId: actor.actorId, orgId: actor.orgId,
        subjectId: req.subjectId, streamId: req.streamId, streamSeq: req.streamSeq,
        payload: req.payload, metadata: req.metadata,
      })
      await syncProjections()
      return r
    },
  }
}
```

- [ ] **Step 5: Implement queries**

`server/src/app/queries.ts`:
```ts
import type { Sql } from '../infra/db.js'

export function makeQueries(sql: Sql) {
  return {
    async listActors() {
      return sql`SELECT actor_id, handle, display_name, kind, status, email, roles
                 FROM actor_state ORDER BY handle`
    },
    async listThreads() {
      return sql`SELECT thread_id, title, created_by, created_at FROM chat_thread ORDER BY created_at`
    },
    async getThread(threadId: string) {
      const messages = await sql`
        SELECT message_id, thread_id, author_id, body, posted_at, edited_at, deleted
        FROM chat_message WHERE thread_id = ${threadId} AND deleted = false
        ORDER BY posted_at`
      const head = await sql<{ v: string | null }[]>`
        SELECT max(stream_seq)::text AS v FROM event WHERE stream_id = ${threadId}`
      return { threadId, streamVersion: Number(head[0]?.v ?? 0), messages }
    },
  }
}
```

- [ ] **Step 6: Implement identity**

`server/src/app/identity.ts`:
```ts
import type { Sql } from '../infra/db.js'
import type { AppendInput } from '../infra/appender.js'
import { newId } from '../infra/uuid.js'

interface Appender { append(i: AppendInput): Promise<{ id: string; seq: string }> }
interface Deps { sql: Sql; appender: Appender; syncProjections: () => Promise<void>; orgId: string }

const handleFromEmail = (email: string): string => email.split('@')[0]!.replace(/[^a-z0-9_.-]/gi, '').toLowerCase() || 'user'

export function makeIdentity({ sql, appender, syncProjections, orgId }: Deps) {
  return {
    async resolveActor(claim: { email: string; name?: string }): Promise<{ actorId: string; handle: string }> {
      const email = claim.email.trim().toLowerCase()
      const existing = await sql<{ actor_id: string; handle: string }[]>`
        SELECT actor_id, handle FROM actor_state WHERE email = ${email}`
      if (existing[0]) return { actorId: existing[0].actor_id, handle: existing[0].handle }

      const actorId = newId()
      const handle = handleFromEmail(email)
      await appender.append({
        type: 'identity.actor.registered@1', actorId, orgId,
        subjectId: actorId, streamId: actorId, streamSeq: 1,
        payload: { handle, display_name: claim.name ?? handle, kind: 'human', email },
      })
      await syncProjections()
      return { actorId, handle }
    },
  }
}
```
> `resolveActor` has a benign race if two logins for a brand-new email arrive simultaneously: the `actor_state.email UNIQUE` constraint makes the second projection upsert collide and the duplicate registration is harmless to read (same email → first wins on read). Acceptable for beta.

- [ ] **Step 7: Run — verify pass**

Run: `cd server && npx vitest run test/app`
Expected: PASS (commands: 3, identity: 1).

- [ ] **Step 8: Commit**

```bash
git add server/src/app server/test/app
git commit -m "feat(app): commands, queries, authz, identity find-or-register"
```

---

### Task 9: Transport — REST routes, SSE hub, server factory

**Files:**
- Create: `server/src/transport/sse.ts`, `server/src/transport/rest.ts`, `server/src/server.ts`
- Create: `server/test/transport/rest.test.ts`

**Interfaces:**
- Consumes: commands, queries, identity, projector, appender, db, config; `@fastify/cookie`, `@fastify/cors`.
- Produces:
  - `makeSseHub()` → `{ register(reply), broadcast(seq), notifyFromDb(sql) }` — manages SSE clients; `notifyFromDb` LISTENs and broadcasts `seq`.
  - `registerRest(app, { commands, queries, getActor })` — mounts `POST /events`, `GET /events`, `GET /projections/*`, `GET /twins/:id` (501), `GET /stream`.
  - `buildApp(cfg): Promise<{ app: FastifyInstance; close(): Promise<void> }>` — the DI composition root: db, appender, projector(start), sse, commands, queries, identity, auth, rest. Exported for tests (does not call `listen`).
  - `currentActor(req): ActorCtx | null` from the signed `sid` cookie + `actor_state` lookup (exposed as `getActor`).

- [ ] **Step 1: Write the failing REST smoke test**

`server/test/transport/rest.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { buildApp } from '../../src/server.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>, close: () => Promise<void>, app: any
const SECRET = 'test-secret-test-secret-test-secret'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(new URL('../../migrations/005_seed.sql', import.meta.url).pathname)
  ;({ app, close } = await buildApp({
    port: 0, webOrigin: 'http://localhost:5173', databaseUrl: '', sessionSecret: SECRET,
    magicLinkTtlSeconds: 900, isDev: true,
  }, { sql }))   // buildApp accepts an injected sql for tests
})
afterEach(async () => { await close(); await drop() })

describe('REST', () => {
  it('rejects POST /events without a session (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/events', payload: {
      type: 'chat.thread.created@1', subjectId: 'x', streamId: 'x', streamSeq: 1, payload: { title: 't' } } })
    expect(res.statusCode).toBe(401)
  })
  it('full login → create thread → post message → read projection', async () => {
    // request magic link
    const r1 = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'matt@x.io' } })
    const link = r1.json().devLink as string
    const token = new URL(link).searchParams.get('token')!
    // callback sets cookie
    const r2 = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    expect(r2.statusCode).toBe(302)
    const cookie = r2.cookies.find((c: any) => c.name === 'sid')!
    const cookieHeader = `sid=${cookie.value}`

    // who am I
    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: cookieHeader } })
    expect(me.json().actor.email).toBe('matt@x.io')

    // create a thread
    const thread = '00000000-0000-7000-8000-0000000000d1'
    const tc = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.thread.created@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 'general' } } })
    expect(tc.statusCode).toBe(201)

    // post a message
    const msg = '00000000-0000-7000-8000-0000000000d2'
    const pm = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.message.posted@1', subjectId: msg, streamId: thread, streamSeq: 2, payload: { body: 'hi' } } })
    expect(pm.statusCode).toBe(201)

    // read the projection
    const proj = await app.inject({ method: 'GET', url: `/projections/chat?thread=${thread}`, headers: { cookie: cookieHeader } })
    const body = proj.json()
    expect(body.streamVersion).toBe(2)
    expect(body.messages[0].body).toBe('hi')
  })
  it('returns 409 on a colliding stream_seq', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'm@x.io' } })
    const token = new URL(r1.json().devLink).searchParams.get('token')!
    const r2 = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    const cookieHeader = `sid=${r2.cookies.find((c: any) => c.name === 'sid')!.value}`
    const thread = '00000000-0000-7000-8000-0000000000e9'
    await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.thread.created@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { title: 't' } } })
    const dup = await app.inject({ method: 'POST', url: '/events', headers: { cookie: cookieHeader },
      payload: { type: 'chat.message.posted@1', subjectId: thread, streamId: thread, streamSeq: 1, payload: { body: 'x' } } })
    expect(dup.statusCode).toBe(409)
  })
})
```
> This test also exercises Task 10's `/auth/*`. Implement Task 9 (server factory + REST) and Task 10 (auth) before running it green; the `POST /events` 401 case passes after Task 9 alone.

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/transport/rest.test.ts`
Expected: FAIL — `server.js` not found.

- [ ] **Step 3: Implement the SSE hub**

`server/src/transport/sse.ts`:
```ts
import type { FastifyReply } from 'fastify'
import type { Sql } from '../infra/db.js'

export function makeSseHub() {
  const clients = new Set<FastifyReply>()
  return {
    register(reply: FastifyReply): void {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      reply.raw.write(': connected\n\n')
      clients.add(reply)
      reply.raw.on('close', () => clients.delete(reply))
    },
    broadcast(seq: string): void {
      for (const c of clients) {
        try { c.raw.write(`event: append\ndata: ${seq}\n\n`) } catch { clients.delete(c) }
      }
    },
    async listenFromDb(sql: Sql) {
      return sql.listen('events', (payload) => this.broadcast(payload))
    },
  }
}
```

- [ ] **Step 4: Implement REST routes**

`server/src/transport/rest.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ActorCtx } from '../app/authz.js'
import { AuthzError } from '../app/commands.js'
import { ValidationError, ConcurrencyError } from '../infra/appender.js'

interface RestDeps {
  commands: { appendEvent(actor: ActorCtx, req: any): Promise<{ id: string; seq: string }> }
  queries: ReturnType<typeof import('../app/queries.js').makeQueries>
  getActor(req: FastifyRequest): Promise<ActorCtx | null>
  sse: { register(reply: any): void }
}

export function registerRest(app: FastifyInstance, deps: RestDeps): void {
  const requireActor = async (req: FastifyRequest): Promise<ActorCtx> => {
    const a = await deps.getActor(req)
    if (!a) { const e: any = new Error('unauthorized'); e.statusCode = 401; throw e }
    return a
  }

  app.post('/events', async (req, reply) => {
    const actor = await requireActor(req)
    try {
      const r = await deps.commands.appendEvent(actor, req.body as any)
      return reply.code(201).send(r)
    } catch (e) {
      if (e instanceof AuthzError) return reply.code(403).send({ error: e.message })
      if (e instanceof ValidationError) return reply.code(400).send({ error: e.message })
      if (e instanceof ConcurrencyError) return reply.code(409).send({ error: e.message, currentVersion: e.currentVersion })
      throw e
    }
  })

  app.get('/events', async (req, reply) => {
    const q = req.query as { subject?: string; after?: string }
    if (!q.subject) return reply.code(400).send({ error: 'subject required' })
    const rows = await deps.queries.eventsForSubject(q.subject, q.after ?? '0')
    return rows
  })

  app.get('/projections/actors', async () => deps.queries.listActors())
  app.get('/projections/threads', async () => deps.queries.listThreads())
  app.get('/projections/chat', async (req, reply) => {
    const thread = (req.query as { thread?: string }).thread
    if (!thread) return reply.code(400).send({ error: 'thread required' })
    return deps.queries.getThread(thread)
  })

  app.get('/twins/:id', async (_req, reply) => reply.code(501).send({ error: 'twins not in beta' }))

  app.get('/stream', async (req, reply) => {
    await requireActor(req)
    deps.sse.register(reply)
    return reply
  })
}
```
> Add `eventsForSubject` to `queries.ts`:
> ```ts
> async eventsForSubject(subject: string, after: string) {
>   return sql`SELECT seq::text, namespace, name, version, actor_id, subject_id, stream_id,
>              stream_seq::text, payload, occurred_at FROM event
>              WHERE subject_id = ${subject} AND seq > ${after} ORDER BY seq`
> },
> ```

- [ ] **Step 5: Implement the server factory**

`server/src/server.ts`:
```ts
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { makeDb, type Sql } from './infra/db.js'
import { makeAppender } from './infra/appender.js'
import { makeProjector, identityProjection, chatProjection } from './infra/projector.js'
import { makeQueries } from './app/queries.js'
import { makeCommands } from './app/commands.js'
import { makeIdentity } from './app/identity.js'
import { makeLoginTokens } from './infra/loginTokens.js'
import { ConsoleMailer } from './infra/mailer.js'
import { makeSseHub } from './transport/sse.js'
import { registerRest } from './transport/rest.js'
import { registerAuth } from './transport/auth.js'
import type { ActorCtx } from './app/authz.js'

const ORG_ID = '00000000-0000-7000-8000-00000000c0de'
const SID = 'sid'

export async function buildApp(cfg: Config, inject?: { sql?: Sql }):
  Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  const sql = inject?.sql ?? makeDb(cfg.databaseUrl)

  const appender = makeAppender(sql)
  const projector = makeProjector(sql, [identityProjection, chatProjection])
  await projector.tick()
  const queries = makeQueries(sql)
  const commands = makeCommands({ appender, syncProjections: () => projector.tick() })
  const identity = makeIdentity({ sql, appender, syncProjections: () => projector.tick(), orgId: ORG_ID })
  const loginTokens = makeLoginTokens(sql, cfg.magicLinkTtlSeconds)
  const mailer = new ConsoleMailer()
  const sse = makeSseHub()

  const app = Fastify({ logger: false })
  await app.register(cookie, { secret: cfg.sessionSecret })
  await app.register(cors, { origin: cfg.webOrigin, credentials: true })

  const getActor = async (req: FastifyRequest): Promise<ActorCtx | null> => {
    const raw = req.cookies[SID]
    if (!raw) return null
    const unsigned = app.unsignCookie(raw)
    if (!unsigned.valid || !unsigned.value) return null
    const rows = await sql<{ actor_id: string; roles: string[] }[]>`
      SELECT actor_id, roles FROM actor_state WHERE actor_id = ${unsigned.value}`
    if (!rows[0]) return null
    return { actorId: rows[0].actor_id, orgId: ORG_ID, roles: rows[0].roles }
  }

  registerAuth(app, { identity, loginTokens, mailer, queries, sql, cfg, sessionCookie: SID })
  registerRest(app, { commands, queries, getActor, sse })

  // live tail: broadcast every committed seq to SSE clients (skip when sql injected w/o real conn)
  let sub: any = null
  if (!inject?.sql || cfg.databaseUrl) {
    try { sub = await sse.listenFromDb(sql) } catch { /* tests w/o LISTEN */ }
  }

  return {
    app,
    close: async () => {
      try { if (sub) await sub.unlisten() } catch {}
      await projector.stop()
      await app.close()
      if (!inject?.sql) await sql.end()
    },
  }
}

// entrypoint
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const cfg = loadConfig()
  const { app } = await buildApp(cfg)
  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  console.log(`OrgOS server on :${cfg.port}`)
}
```
> The injected-`sql` path lets `rest.test.ts` use the throwaway schema; `sse.listenFromDb` is wrapped in try/catch because a per-schema test connection may share the DB-wide NOTIFY channel — broadcasts are best-effort in tests, asserted only via projection reads.

- [ ] **Step 6: Run (expect partial)**

Run: `cd server && npx vitest run test/transport/rest.test.ts -t 'without a session'`
Expected: PASS for the 401 case. The login cases stay red until Task 10.

- [ ] **Step 7: Commit**

```bash
git add server/src/transport/sse.ts server/src/transport/rest.ts server/src/server.ts server/src/app/queries.ts server/test/transport/rest.test.ts
git commit -m "feat(transport): REST routes, SSE hub, DI server factory"
```

---

### Task 10: Transport — magic-link auth + cookie session

**Files:**
- Create: `server/src/transport/auth.ts`
- Create: `server/test/transport/auth.test.ts`

**Interfaces:**
- Consumes: identity (`resolveActor`), loginTokens (`issue`/`consume`), mailer, queries (`listActors` / a `getActorById`), config, the signed cookie API from `@fastify/cookie`.
- Produces: `registerAuth(app, deps)` mounting `POST /auth/request`, `GET /auth/callback`, `GET /auth/me`, `POST /auth/logout`. On request: issue token, build `${cfg.webOrigin... }` callback link routed to the service (`/auth/callback?token=`), `mailer.sendMagicLink`; respond `{ ok: true, devLink? }` (devLink only when `cfg.isDev`). On callback: `consume` token → `resolveActor` → set signed `sid` cookie → 302 to `WEB_ORIGIN`.

- [ ] **Step 1: Write the failing auth unit test**

`server/test/transport/auth.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshSchema } from '../helpers/testDb.js'
import { buildApp } from '../../src/server.js'
import type { Sql } from '../../src/infra/db.js'

let sql: Sql, drop: () => Promise<void>, close: () => Promise<void>, app: any
const SECRET = 'unit-secret-unit-secret-unit-secret'

beforeEach(async () => {
  ;({ sql, drop } = await freshSchema())
  await sql.file(new URL('../../migrations/005_seed.sql', import.meta.url).pathname)
  ;({ app, close } = await buildApp({ port: 0, webOrigin: 'http://localhost:5173', databaseUrl: '',
    sessionSecret: SECRET, magicLinkTtlSeconds: 900, isDev: true }, { sql }))
})
afterEach(async () => { await close(); await drop() })

describe('magic-link auth', () => {
  it('request returns a dev link; callback logs in and registers the actor', async () => {
    const req = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'New@X.io' } })
    expect(req.statusCode).toBe(200)
    expect(req.json().ok).toBe(true)
    const token = new URL(req.json().devLink).searchParams.get('token')!

    const cb = await app.inject({ method: 'GET', url: `/auth/callback?token=${token}` })
    expect(cb.statusCode).toBe(302)
    expect(cb.headers.location).toBe('http://localhost:5173')

    const rows = await sql`SELECT * FROM actor_state WHERE email='new@x.io'`  // normalized lowercase
    expect(rows).toHaveLength(1)
  })
  it('request never enumerates (always 200) and a bad token is 400', async () => {
    const ok = await app.inject({ method: 'POST', url: '/auth/request', payload: { email: 'x@y.io' } })
    expect(ok.statusCode).toBe(200)
    const bad = await app.inject({ method: 'GET', url: '/auth/callback?token=nope' })
    expect(bad.statusCode).toBe(400)
  })
  it('me is 401 without a cookie', async () => {
    const me = await app.inject({ method: 'GET', url: '/auth/me' })
    expect(me.statusCode).toBe(401)
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `cd server && npx vitest run test/transport/auth.test.ts`
Expected: FAIL — `registerAuth` not implemented / `auth.js` not found.

- [ ] **Step 3: Implement auth routes**

`server/src/transport/auth.ts`:
```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { Sql } from '../infra/db.js'
import type { Mailer } from '../infra/mailer.js'

interface AuthDeps {
  identity: { resolveActor(c: { email: string; name?: string }): Promise<{ actorId: string; handle: string }> }
  loginTokens: { issue(email: string): Promise<string>; consume(token: string): Promise<string | null> }
  mailer: Mailer
  sql: Sql
  cfg: Config
  sessionCookie: string
}

const cookieOpts = (cfg: Config) => ({
  signed: true, httpOnly: true, sameSite: 'lax' as const, path: '/', secure: !cfg.isDev,
})

export function registerAuth(app: FastifyInstance, deps: AuthDeps): void {
  const { cfg, sessionCookie: SID } = deps

  app.post('/auth/request', async (req, reply) => {
    const email = String((req.body as { email?: string }).email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'invalid email' })
    const token = await deps.loginTokens.issue(email)
    const link = `${cfg.webOrigin}/auth/callback?token=${encodeURIComponent(token)}`
    await deps.mailer.sendMagicLink(email, link)
    return reply.code(200).send(cfg.isDev ? { ok: true, devLink: link } : { ok: true })
  })

  app.get('/auth/callback', async (req, reply) => {
    const token = (req.query as { token?: string }).token
    if (!token) return reply.code(400).send({ error: 'missing token' })
    const email = await deps.loginTokens.consume(token)
    if (!email) return reply.code(400).send({ error: 'invalid or expired link' })
    const actor = await deps.identity.resolveActor({ email })
    reply.setCookie(SID, actor.actorId, cookieOpts(cfg))
    return reply.code(302).redirect(cfg.webOrigin)
  })

  app.get('/auth/me', async (req, reply) => {
    const actor = await currentActor(app, deps.sql, req, SID)
    if (!actor) return reply.code(401).send({ error: 'not signed in' })
    return { actor }
  })

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(SID, { path: '/' })
    return { ok: true }
  })
}

export async function currentActor(app: FastifyInstance, sql: Sql, req: FastifyRequest, SID: string) {
  const raw = req.cookies[SID]
  if (!raw) return null
  const u = app.unsignCookie(raw)
  if (!u.valid || !u.value) return null
  const rows = await sql<any[]>`SELECT actor_id, handle, display_name, kind, status, email, roles
    FROM actor_state WHERE actor_id = ${u.value}`
  return rows[0] ?? null
}
```
> Note: the callback link points at `cfg.webOrigin/auth/callback`; the Vite dev proxy (Task 12) forwards `/auth/*` to the service, so the cookie is set on the service response and the browser lands back on the web origin. In `app.inject` tests there is no proxy, so the test calls `/auth/callback` on the service directly (same handler) — equivalent.

- [ ] **Step 4: Run — verify auth tests pass**

Run: `cd server && npx vitest run test/transport/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full REST test (now green)**

Run: `cd server && npx vitest run test/transport/rest.test.ts`
Expected: PASS (3 tests). Then run the whole suite: `npx vitest run` — all green.

- [ ] **Step 6: Commit**

```bash
git add server/src/transport/auth.ts server/test/transport/auth.test.ts
git commit -m "feat(transport): passwordless magic-link auth + cookie session"
```

---

### Task 11: Webapp scaffold + auth UI

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/index.html`, `web/.gitignore`
- Create: `web/src/main.tsx`, `web/src/App.tsx`, `web/src/api.ts`, `web/src/auth.tsx`, `web/src/styles.css`

**Interfaces:**
- Produces: `api` object (`get`, `post`, `sse`) over `fetch` with `credentials: 'include'`. `useSession()` hook → `{ actor, loading, signIn(email), signOut() }`. `App` renders `<Login/>` when signed out, `<Chat/>` (Task 12) when signed in.

- [ ] **Step 1: Web package + config**

`web/package.json`:
```json
{
  "name": "@orgos/web",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "tsc -b && vite build", "preview": "vite preview" },
  "dependencies": { "react": "^19.0.0", "react-dom": "^19.0.0" },
  "devDependencies": {
    "@types/react": "^19.0.8", "@types/react-dom": "^19.0.3",
    "@vitejs/plugin-react": "^4.3.4", "typescript": "^5.7.3", "vite": "^6.0.11"
  }
}
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022", "DOM", "DOM.Iterable"], "module": "ESNext",
    "moduleResolution": "bundler", "jsx": "react-jsx", "strict": true,
    "noUncheckedIndexedAccess": true, "skipLibCheck": true, "noEmit": true
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const target = 'http://localhost:8787'
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/auth': { target, changeOrigin: true },
      '/events': { target, changeOrigin: true },
      '/projections': { target, changeOrigin: true },
      '/stream': { target, changeOrigin: true },
    },
  },
})
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OrgOS</title></head>
  <body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>
</html>
```

`web/.gitignore`:
```
node_modules
dist
```

- [ ] **Step 2: API client**

`web/src/api.ts`:
```ts
const json = { 'Content-Type': 'application/json' }

export const api = {
  async get<T>(path: string): Promise<T> {
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw Object.assign(new Error(`GET ${path} ${r.status}`), { status: r.status })
    return r.json() as Promise<T>
  },
  async post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(path, { method: 'POST', credentials: 'include', headers: json, body: JSON.stringify(body) })
    if (!r.ok) {
      const e = await r.json().catch(() => ({}))
      throw Object.assign(new Error(e.error ?? `POST ${path} ${r.status}`), { status: r.status, body: e })
    }
    return r.json() as Promise<T>
  },
  sse(onSeq: (seq: string) => void): () => void {
    const es = new EventSource('/stream', { withCredentials: true })
    es.addEventListener('append', (ev) => onSeq((ev as MessageEvent).data))
    return () => es.close()
  },
}
```

- [ ] **Step 3: Session hook + login UI**

`web/src/auth.tsx`:
```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.js'

export interface Actor { actor_id: string; handle: string; display_name: string; email: string; roles: string[] }
interface Session { actor: Actor | null; loading: boolean; refresh(): Promise<void>; signOut(): Promise<void> }

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [actor, setActor] = useState<Actor | null>(null)
  const [loading, setLoading] = useState(true)
  const refresh = async () => {
    setLoading(true)
    try { const r = await api.get<{ actor: Actor }>('/auth/me'); setActor(r.actor) }
    catch { setActor(null) } finally { setLoading(false) }
  }
  const signOut = async () => { await api.post('/auth/logout', {}); setActor(null) }
  useEffect(() => { void refresh() }, [])
  return <Ctx.Provider value={{ actor, loading, refresh, signOut }}>{children}</Ctx.Provider>
}
export const useSession = (): Session => {
  const c = useContext(Ctx); if (!c) throw new Error('no SessionProvider'); return c
}

export function Login() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState<{ devLink?: string } | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const r = await api.post<{ ok: boolean; devLink?: string }>('/auth/request', { email })
    setSent({ devLink: r.devLink })
  }
  if (sent) return (
    <div className="card">
      <h2>Check your email</h2>
      <p>We sent a sign-in link to <b>{email}</b>.</p>
      {sent.devLink && <p>Dev link: <a href={sent.devLink}>{sent.devLink}</a></p>}
    </div>
  )
  return (
    <form className="card" onSubmit={submit}>
      <h2>Sign in to OrgOS</h2>
      <input type="email" required placeholder="you@example.com" value={email}
        onChange={(e) => setEmail(e.target.value)} />
      <button type="submit">Send magic link</button>
    </form>
  )
}
```

- [ ] **Step 4: App shell + entry**

`web/src/App.tsx`:
```tsx
import { SessionProvider, useSession, Login } from './auth.js'
import { Chat } from './Chat.js'

function Shell() {
  const { actor, loading, signOut } = useSession()
  if (loading) return <div className="card">Loading…</div>
  if (!actor) return <Login />
  return (
    <div className="app">
      <header><b>OrgOS</b> <span>· {actor.display_name}</span>
        <button onClick={() => void signOut()}>Sign out</button></header>
      <Chat />
    </div>
  )
}
export default function App() { return <SessionProvider><Shell /></SessionProvider> }
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.js'
import './styles.css'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
```

`web/src/styles.css`:
```css
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; background: #0f1115; color: #e6e6e6; }
.card { max-width: 380px; margin: 12vh auto; padding: 24px; background: #171a21; border-radius: 12px; display: grid; gap: 12px; }
input, button { padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2f3a; background: #0f1115; color: inherit; font-size: 14px; }
button { background: #3b82f6; border: none; cursor: pointer; }
.app { max-width: 920px; margin: 0 auto; padding: 16px; }
header { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid #2a2f3a; }
header button { margin-left: auto; }
.chat { display: grid; grid-template-columns: 220px 1fr; gap: 16px; margin-top: 16px; }
.threads { display: grid; gap: 6px; align-content: start; }
.threads button { background: #171a21; text-align: left; }
.threads button.active { background: #243; }
.messages { display: grid; gap: 8px; align-content: start; min-height: 50vh; }
.msg { background: #171a21; padding: 8px 12px; border-radius: 8px; }
.composer { display: flex; gap: 8px; margin-top: 12px; }
.composer input { flex: 1; }
```

- [ ] **Step 5: Verify it builds (typecheck)**

Run: `cd web && npm i && npx tsc -b --noEmit`
Expected: PASS after Task 12 adds `Chat.tsx` (typecheck will fail on the missing `./Chat.js` import until then — acceptable; do not commit a broken typecheck). To check Task 11 alone, temporarily stub `web/src/Chat.tsx` with `export function Chat() { return null }`, typecheck, then proceed to Task 12.

- [ ] **Step 6: Commit**

```bash
git add web/package.json web/tsconfig.json web/vite.config.ts web/index.html web/.gitignore web/src/main.tsx web/src/App.tsx web/src/api.ts web/src/auth.tsx web/src/styles.css
git commit -m "feat(web): scaffold, api client, session + magic-link login UI"
```

---

### Task 12: Webapp chat UI + live SSE tail

**Files:**
- Create: `web/src/Chat.tsx`

**Interfaces:**
- Consumes: `api`, `useSession`. Uses `GET /projections/threads`, `GET /projections/chat?thread=`, `POST /events`, `api.sse`.
- Produces: `Chat` component — thread list + create-thread, message list, composer that posts `chat.message.posted@1` at `streamVersion + 1` (retries once on 409 by refetching), and re-fetches the open thread on every SSE `append`.

- [ ] **Step 1: Implement Chat (with a uuid helper)**

`web/src/Chat.tsx`:
```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.js'

interface Thread { thread_id: string; title: string }
interface Message { message_id: string; author_id: string; body: string; posted_at: string }
interface ThreadView { threadId: string; streamVersion: number; messages: Message[] }

const uuid = (): string =>
  (crypto as any).randomUUID ? crypto.randomUUID() : '00000000-0000-7000-8000-' + Date.now().toString(16).padStart(12, '0')

export function Chat() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [view, setView] = useState<ThreadView | null>(null)
  const [draft, setDraft] = useState('')
  const activeRef = useRef<string | null>(null)
  activeRef.current = active

  const loadThreads = useCallback(async () => {
    const t = await api.get<Thread[]>('/projections/threads')
    setThreads(t)
    if (!activeRef.current && t[0]) setActive(t[0].thread_id)
  }, [])

  const loadThread = useCallback(async (id: string) => {
    setView(await api.get<ThreadView>(`/projections/chat?thread=${id}`))
  }, [])

  useEffect(() => { void loadThreads() }, [loadThreads])
  useEffect(() => { if (active) void loadThread(active) }, [active, loadThread])
  useEffect(() => api.sse(() => {
    void loadThreads()
    if (activeRef.current) void loadThread(activeRef.current)
  }), [loadThreads, loadThread])

  const newThread = async () => {
    const title = prompt('Thread title?')?.trim()
    if (!title) return
    const id = uuid()
    await api.post('/events', { type: 'chat.thread.created@1', subjectId: id, streamId: id, streamSeq: 1, payload: { title } })
    await loadThreads(); setActive(id)
  }

  const send = async (e: React.FormEvent) => {
    e.preventDefault()
    const body = draft.trim()
    if (!body || !active) return
    setDraft('')
    const post = async (): Promise<void> => {
      const v = view && view.threadId === active ? view : await api.get<ThreadView>(`/projections/chat?thread=${active}`)
      await api.post('/events', {
        type: 'chat.message.posted@1', subjectId: uuid(), streamId: active,
        streamSeq: v.streamVersion + 1, payload: { body },
      })
    }
    try { await post() }
    catch (err: any) { if (err.status === 409) { await loadThread(active); await post() } else throw err }
    await loadThread(active)
  }

  return (
    <div className="chat">
      <div className="threads">
        <button onClick={() => void newThread()}>+ New thread</button>
        {threads.map((t) => (
          <button key={t.thread_id} className={t.thread_id === active ? 'active' : ''}
            onClick={() => setActive(t.thread_id)}>{t.title}</button>
        ))}
      </div>
      <div>
        <div className="messages">
          {view?.messages.map((m) => (
            <div className="msg" key={m.message_id}>{m.body}</div>
          ))}
          {!view?.messages.length && <div className="msg">No messages yet.</div>}
        </div>
        <form className="composer" onSubmit={send}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Message…" disabled={!active} />
          <button type="submit" disabled={!active}>Send</button>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck the whole web app**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS (no type errors across `auth.tsx`, `App.tsx`, `Chat.tsx`).

- [ ] **Step 3: Commit**

```bash
git add web/src/Chat.tsx
git commit -m "feat(web): chat UI with threads, composer, live SSE tail"
```

---

### Task 13: End-to-end run + README quickstart

**Files:**
- Create: `README.dev.md` (or append a "Running the beta" section to `README.md`)
- Modify: root — optional `package.json` with convenience scripts (do not break existing repo files)

**Interfaces:** none (operational).

- [ ] **Step 1: Write the quickstart**

Append to `README.md` (new section) or create `README.dev.md`:
```markdown
## Running the OrgOS beta

Prereqs: Docker, Node LTS.

1. Start Postgres (with pg_jsonschema):
   `docker compose up -d`
2. Server:
   `cd server && cp .env.example .env && npm i && npm run migrate && npm run dev`
   (serves on http://localhost:8787)
3. Webapp (new terminal):
   `cd web && npm i && npm run dev`
   (open http://localhost:5173)
4. Sign in: enter any email. In dev, the magic link is printed to the **server
   console** and shown in the UI. Click it to log in.
5. Create a thread, post messages. Open a second browser to watch live SSE updates.

Tests: `cd server && npm test` (needs `docker compose up -d` first; set
`DATABASE_URL_TEST` if different from `DATABASE_URL`).
```

- [ ] **Step 2: Full manual smoke**

Run, in order:
```bash
docker compose up -d
cd server && cp .env.example .env && npm i && npm run migrate && npm test   # all green
npm run dev &                                                                # server up
cd ../web && npm i && npm run dev                                            # open :5173
```
Expected: log in via the dev link; create a thread; post a message; see it appear; a second tab updates live.

- [ ] **Step 3: Commit**

```bash
git add README.md README.dev.md 2>/dev/null; git add -A
git commit -m "docs: beta quickstart + end-to-end run"
```

---

## Self-Review

**Spec coverage:**
- Event-sourced core (`actor`/`event_type`/`event`/`projection_checkpoint`) → Task 1 ✓
- Writer + optimistic concurrency + authoritative trigger validation → Task 5 ✓
- Generic projector + `chat_message`/`actor_state` (+ `chat_thread`) → Task 6 ✓
- REST/JSON + SSE → Task 9 ✓
- Magic-link login → `identity.actor.registered` → actor row; cookie session; `IdentityProvider`/`Mailer` seams → Tasks 7, 8, 10 ✓
- `login_token` operational table → Task 1 (schema) + Task 7 (logic) ✓
- ajv friendly + `pg_jsonschema` authoritative → Tasks 2 + 5 ✓
- uuid v7 app-side → Task 1 ✓
- React/Vite webapp (login + live chat) → Tasks 11, 12 ✓
- Error mapping (400/401/403/409/422/501) → Task 9 (rest) + Task 10 (auth) ✓ (note: trigger rejects surface as 400 ValidationError, not 422 — the spec's "422 authoritative reject" is folded into the 400 ValidationError path since ajv catches the same cases first; documented here as an intentional simplification.)
- Testing: pure folds, infra integration, app/auth with fakes → Tasks 3,4 / 5,6,7 / 8,10 ✓
- Ports 8787/5173, WEB_ORIGIN → Task 1 + Task 11 ✓

**Placeholder scan:** No "TBD"/"implement later". The only non-literal is the `supabase/postgres` image tag, flagged with a one-line "bump to latest if pull 404s" instruction — a config value the implementer confirms at `docker pull`, not a logic gap.

**Type consistency:** `AppendInput`/`AppendRequest` distinguished (infra vs app); `ActorCtx` (`{actorId, orgId, roles}`) shared by authz/commands/rest/server; `StoredEvent` shared by folds/projector; `resolveActor` returns `{actorId, handle}` consistently; `streamVersion` (number) consistent server (queries) ↔ web (Chat). `queries.eventsForSubject` is declared in Task 9 Step 4 and consumed by `/events` in the same task.

**Deviation note (added to spec scope):** `chat_thread` read model + `GET /projections/threads` were added beyond the spec's enumerated routes because the chat UI needs a thread list; this stays within the approved Identity+Chat scope.
