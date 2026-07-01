# OrgOS Beta — Developer Quickstart

This guide covers getting the OrgOS beta running locally from a clean checkout.

---

## Prerequisites

- **Docker** (with Compose v2) — used to run the Postgres container
- **Node.js LTS** (v20+) — for the server and web dev servers

---

## 1. Start Postgres

```bash
docker compose up -d
```

This starts `orgos-db-1`, a custom Postgres 16 image with `pg_jsonschema` pre-installed,
mapped to **host port 5433** (container port 5432).

> **Note (arm64 hosts):** `db/Dockerfile` installs a prebuilt `pg_jsonschema` `.deb`
> (v0.3.4, PG16) that is **amd64-specific**. On an arm64 host (e.g. Apple Silicon),
> swap the asset for the arm64 variant from the same release.

---

## 2. Server Setup

```bash
cd server
cp .env.example .env        # create your local env file (git-ignored)
npm i                        # install dependencies
npm run migrate              # run schema migrations against the DB
npm run dev                  # start Fastify on http://localhost:8787 (watch mode)
```

The server reads `server/.env` automatically (scripts use `tsx --env-file=.env`).

Key environment variables in `.env`:

| Key | Default value |
|-----|---------------|
| `SERVER_PORT` | `8787` |
| `WEB_ORIGIN` | `http://localhost:5173` |
| `DATABASE_URL` | `postgres://orgos:orgos@localhost:5433/orgos` |
| `SESSION_SECRET` | *(change before production)* |
| `MAGIC_LINK_TTL_SECONDS` | `900` |
| `NODE_ENV` | `development` |

---

## 3. Web App Setup

In a new terminal:

```bash
cd web
npm i
npm run dev      # Vite dev server on http://localhost:5173
```

The Vite dev server **proxies** the following prefixes to the server on `:8787`:
`/auth`, `/events`, `/projections`, `/stream`

Open **http://localhost:5173** in your browser.

---

## 4. Dev Magic-Link Auth Flow

1. Enter any email address in the sign-in form and submit.
2. In dev mode (`NODE_ENV=development`), the magic link is:
   - **Printed to the server console** by the dev mailer — look for a line like
     `[magic-link] to=<email>` followed by the URL on the next line
   - **Returned in the JSON response body** as `{ devLink: "http://..." }`, which the
     sign-in form also displays as a clickable link (no real email is sent)
3. Copy the link URL and open it in your browser (or click it from the UI). This sets your session cookie and logs you in.
4. `GET /auth/me` will now return your actor JSON.

---

## 5. First Admin

A fresh install has **no admin**: sign-in registers an actor with **no roles**, and
`identity.role.granted@1` may only be appended by an existing admin (`src/app/authz.ts`).
Bootstrap the first admin out-of-band — see the admin bootstrap walkthrough in
[EXAMPLES.md](EXAMPLES.md).

---

## 6. Try the Happy Path

1. **Create a thread** — use the UI or `POST /events` with `type: "chat.thread.created@1"`.
2. **Post a message** — use the UI or `POST /events` with `type: "chat.message.posted@1"`.
3. **See live updates** — open the same URL in a **second browser tab**. New messages appear in real time via SSE (`/stream`).
4. **Check the projection** — `GET /projections/chat?thread=<thread-id>` returns the full message list with `streamVersion`.

---

## 7. Running Tests

Both packages have their own Vitest suite.

### Server (`server/`)

`npm test` runs the whole `server/test/**` suite in a single Vitest run: pure
domain/fold unit tests (`test/domain/`) plus integration tests that hit a real
database (`test/infra/`, `test/transport/`, parts of `test/app/` — each creates
a fresh migrated schema via `test/helpers/testDb.ts`). Because the integration
tests are included, `npm test` needs the Docker Postgres container up
(`docker compose up -d`).

Vitest does **not** auto-load `.env`, so pass `DATABASE_URL_TEST` inline:

**bash / zsh:**
```bash
DATABASE_URL_TEST=postgres://orgos:orgos@localhost:5433/orgos npm test
```

**PowerShell:**
```powershell
$env:DATABASE_URL_TEST='postgres://orgos:orgos@localhost:5433/orgos'; npm test
```

The pure domain tests run without a database if you target them directly:

```bash
npx vitest run test/domain
```

### Web (`web/`)

The web suite (`web/src/*.test.*`) runs against jsdom with a fake `fetch` — no
database or server needed:

```bash
cd web
npm run test:run     # single run (CI mode)
npm test             # watch mode
```

---

## CI

`.github/workflows/ci.yml` runs two jobs on every push to `main` and on every
pull request:

| Job | Steps |
|-----|-------|
| `web` | `npm ci` → `npm run typecheck` → `npm run test:run` |
| `server` | build the `db/Dockerfile` Postgres image (pg_jsonschema), start it on port 5432, wait for `pg_isready`, then `npm ci` → `npm run typecheck` → `npm test` |

Lockfiles are committed, so CI uses `npm ci` with the npm cache keyed on each
package's `package-lock.json`.

---

## Ports at a Glance

| Service | URL |
|---------|-----|
| Fastify API server | http://localhost:8787 |
| React/Vite web app | http://localhost:5173 |
| Postgres (host) | localhost:5433 |
