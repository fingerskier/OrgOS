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
   - **Printed to the server console** (look for `devLink: http://...`)
   - **Returned in the JSON response body** as `{ devLink: "http://..." }` (no real email is sent)
3. Copy the `devLink` URL and open it in your browser (or click it from the UI). This sets your session cookie and logs you in.
4. `GET /auth/me` will now return your actor JSON.

---

## 5. Try the Happy Path

1. **Create a thread** — use the UI or `POST /events` with `type: "chat.thread.created@1"`.
2. **Post a message** — use the UI or `POST /events` with `type: "chat.message.posted@1"`.
3. **See live updates** — open the same URL in a **second browser tab**. New messages appear in real time via SSE (`/stream`).
4. **Check the projection** — `GET /projections/chat?thread=<thread-id>` returns the full message list with `streamVersion`.

---

## 6. Running Tests

Tests require the Docker Postgres container to be up (`docker compose up -d`).

Vitest does **not** auto-load `.env`, so pass `DATABASE_URL_TEST` inline:

**bash / zsh:**
```bash
DATABASE_URL_TEST=postgres://orgos:orgos@localhost:5433/orgos npm test
```

**PowerShell:**
```powershell
$env:DATABASE_URL_TEST='postgres://orgos:orgos@localhost:5433/orgos'; npm test
```

All tests are in `server/`. The test suite covers pure event-fold unit tests,
infra integration tests (real DB), and app/auth tests with service fakes.

---

## Ports at a Glance

| Service | URL |
|---------|-----|
| Fastify API server | http://localhost:8787 |
| React/Vite web app | http://localhost:5173 |
| Postgres (host) | localhost:5433 |
