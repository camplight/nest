# Nest Admin UI

React + Tailwind admin SPA for Nest.

## Run

```bash
npm run dev --workspace @nest/admin-ui
```

The UI proxies `/api` and `/ws` to the API server.

## Environment

- `VITE_API_BASE_URL` (optional; default: `/api`; supports relative or absolute URL)
- `VITE_WS_BASE_URL` (optional; default: derived from `VITE_API_BASE_URL` when absolute, otherwise `/ws`; supports `ws(s)://`, `http(s)://`, or relative path)

Runtime override (optional, useful without rebuilding):

```html
<script>
  window.__NEST_UI_CONFIG__ = {
    apiBaseUrl: "https://nest.example.com/api",
    wsBaseUrl: "wss://nest.example.com/ws"
  };
</script>
```

The SPA uses configured API/WS bases for all calls. In dev, Vite still proxies `/api` and `/ws` to `http://localhost:8787` by default when using relative paths.
