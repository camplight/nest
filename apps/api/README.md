# Nest API

Hono-based HTTP + WebSocket server with SQLite single-writer access.

## Run

```bash
npm run dev --workspace @nest/api
```

## Key endpoints

- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/events`
- `GET /api/events`
- `GET /ws`

## Environment

- `PORT` (default: 8787)
- `NEST_ADMIN_USER` / `NEST_ADMIN_PASS`
- `NEST_RUNNER_TOKEN`
- `NEST_MASTER_KEY`
- `NEST_PROJECT_ROOT` (optional monorepo root override)
- `NEST_COOKIE_SECURE` (`auto|always|never`, default: `auto`)
- `NEST_EVENT_MAX_FAILURES` (default: `25`)
- `NEST_EVENT_SHAPES_CACHE_TTL_MS` (default: `3000`)
- `NEST_RUNNER_ONLINE_THRESHOLD_MS` (default: `15000`)
