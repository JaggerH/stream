# Stream app

React + Vite unified inbox over the Stream backend. A **backend-agnostic API client** — talks
HTTP/WS to a Stream backend (local or remote). Scaffold/glass chrome adapted from snapick.

## Build

The UI ships as the panel bundles the backend serves from `/panel/*` — there is no dev server for
them, you build and the backend picks the new files up:

```bash
cd app && npm run build:panel            # all entries
cd app && npm run build:panel -- movie   # just one
```

Point a browser at `http://127.0.0.1:8900` (the backend is the door; see the repo root `CONTRIBUTING.md`
/ `docs/DEVELOPMENT.md`).

`src/lib/api.ts`'s `LOCAL` connection defaults to a same-origin relative base (`baseUrl: ''`),
resolved against wherever the page is served from. For a remote self-hosted backend, point it
at the remote URL + token instead.

## Layout

```
src/
  lib/api.ts        backend-agnostic REST client + ws url
  lib/types.ts      shared types
  hooks/useWs.ts    live WS with reconnect
  hooks/useInbox.ts streams + items + health, applies WS deltas
  components/       StreamsRail / ItemList / Detail / ControlPanel
  panel/            the panel bundle entries built into dist-panel/
```

## Notes

- Read-only v1 — no reply composer yet (the Detail pane reserves the spot).
- Glass: only the body is translucent; panels/controls stay solid.
