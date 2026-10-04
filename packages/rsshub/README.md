# RSSHub

Upstream tagline: "Everything is RSSible".

`required: true` —— 核心插件：长尾 RSS 目录的唯一来源，产品离了它就没内容。UI 上开关锁定为开、
不可关闭。

## Runtime form

RSSHub runs in a WORKER THREAD, not a container and not in-process. It's the one plugin whose fetch
logic is foreign heavyweight code (3000+ routes, a global-fetch monkeypatch, on-first-hit route
compilation) — a worker gives it its own globals + event loop so none of that leaks into Stream,
while keeping cookie hot-reload a postMessage away. Wiring: `src/rsshub-adapter.ts` →
`src/rsshub-client.ts` (spawns) → `src/rsshub-worker.ts` (harness runs RSSHub). No `backend:` block:
there is no container. This runtime isn't a declared descriptor field yet (RSSHub is its sole user;
generalising a `worker:` schema for one occupant would be premature) — see rsshub-static-catalog.
