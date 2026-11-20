# agent-browser bench (spike)

Compares two ways to drive the same Chromium for the browser recipes:

- **relay path** — what ships today: `CdpRelayOps` (the CDP binding) + the shared
  `PageDriver` (`shared/browser-relay/ext-page.ts`), i.e. the same command stream
  the backend sends to an extension, landed on a plain Chromium.
- **delegate path** — the same tasks expressed through an external
  [`agent-browser`](https://agent-browser.dev) CLI attached to that browser with
  `--cdp <port>`.

Nothing here is wired into a product path. The prototype in `delegate.ts` is
imported only by `bench.ts` and `delegate.test.ts`.

## Pinned versions

| What | Version | How |
| --- | --- | --- |
| agent-browser | **0.41.2** (released 2026-11-03) | `npm install --prefix ~/.local/ab-bench agent-browser@0.41.2` |
| Chromium | Chrome for Testing **159.0.8154.6** | playwright-core cache (`~/.cache/ms-playwright/chromium-1255/…`) |
| Node | 22.23.4 | repo runtime |

`agent-browser install` (which downloads its own Chrome for Testing) is **not**
used; the bench attaches to the browser it starts, so one browser serves both
paths. Override locations with `AGENT_BROWSER_BIN` and
`AGENT_BROWSER_BENCH_CHROME`.

## Run

```sh
pnpm exec tsx spike/agent-browser-bench/bench.ts --iterations 3
pnpm exec vitest run spike/agent-browser-bench/delegate.test.ts
```

`bench.ts` writes `spike/agent-browser-bench/results/bench-<timestamp>.json` and
prints a per-task summary. Both scripts start their own headless Chromium on
127.0.0.1 with a throwaway profile, serve the fixtures from `server.mjs`, and
close everything they started (browser, fixture server, the CLI's session
daemon) on success and on failure.

## Fixtures

`server.mjs` renders six pages offline, shaped like the pages the shipped
recipes drive:

| Page | Shape | Task |
| --- | --- | --- |
| `/search?q=` | SSR result list (10 cards: `h3`, `a[href]`, `[data-sncf]`) | read the list |
| `/form` | labelled inputs + a button that reveals a receipt | fill 3 fields, submit |
| `/feed` | 30 cards, last 10 land at 1.5 s, 16-hex card ids | locate card 27 and click |
| `/overlay` | consent banner covering the button | click must fail loudly, then succeed after dismissing |
| `/churn` | list replaced by fresh clones at 800 ms | click after the DOM change |
| `/states` | enabled / disabled / hidden buttons | click must not report success |

## Safety

- Only a browser this script starts is ever attached to; no `--auto-connect`,
  no `--profile`, no user profile, no account login.
- Every CLI call runs with `AGENT_BROWSER_NO_VERSION_CHECK=1`, so the only
  outbound request the tool would make (the Chrome CVE check) is off.
- `delegate.ts` refuses any CDP endpoint that is not loopback.
- The bench records whether the Chromium PID survived the CLI attach, which is
  the property "attaching does not take ownership of the browser".

## Reference

The report that cites these numbers lives outside this repository.
