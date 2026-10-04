## Purpose

定义「要接入一个新 Source 时该走哪条落地手段」：按成本阶梯就近取最便宜的一档，且同一个目标的侦察只做一次、归属单一。

## Requirements

### Requirement: Cheapest-path acquisition routing

Given a needed Source, the acquisition router SHALL recon the target and select the cheapest working acquisition path, evaluated in order: (1) an existing stable source, (2) a **plain-HTTP recipe** (`kind: 'http'` — just a request to an endpoint, no browser) when the data is retrievable without running page JS, optionally with cookies, (3) a browser recipe when the data requires a real browser — Tier-B in-page XHR replay when the page's own XHR is replayable, else Tier-C DOM harvest. The router SHALL dispatch to the corresponding builder skill and SHALL NOT itself build the artifact.

Tier 2 SHALL NOT route to an external-repository contribution path. A Source produced at tier 2 SHALL be a recipe — user-owned data that travels with a shared Channel/Stream — so that sharing never depends on an upstream merge.

#### Scenario: Data reachable by a plain server-side fetch
- **WHEN** recon shows the target's data is retrievable by a server-side HTTP fetch (optionally with cookies) without executing page JS
- **THEN** the router routes to the plain-HTTP recipe builder, producing a `kind: 'http'` recipe

#### Scenario: Request-signed or login-gated, but page-internal XHR is replayable
- **WHEN** recon shows the data is not fetchable from outside (request-signed / login-gated) but the logged-in page's own XHR returns it
- **THEN** the router routes to the browser-recipe builder on the Tier-B (in-page XHR replay) path

#### Scenario: Feed XHR opaque but the rendered DOM carries the data
- **WHEN** recon shows the page's data XHR is signed AND its body is encrypted/opaque, while the rendered DOM shows the target items
- **THEN** the router routes to the browser-recipe builder on the Tier-C (DOM harvest) path

#### Scenario: An existing source already resolves the intent
- **WHEN** a stable source already resolves the intent
- **THEN** the router selects it via `building-targets` and does not invoke a builder

#### Scenario: 裸 HTTP 可达但需要登录态
- **WHEN** recon 显示目标不跑页面 JS 即可取数，但需要登录 cookie
- **THEN** 路由仍落在 tier 2 的 `kind: 'http'` recipe（声明 `cookieDomain`，经 `cookieFor` 注入 cookie），不升级到浏览器

### Requirement: Single-owner recon, no duplicated capture

XHR-capture recon SHALL be owned by the acquisition router. Builder skills SHALL consume the router's recon evidence and SHALL NOT re-capture network traffic themselves.

#### Scenario: Browser-recipe builder consumes router evidence
- **WHEN** the router has dispatched to `building-browser-recipes` with recon evidence
- **THEN** the builder templatizes the recipe from that evidence and does not run its own XHR capture step
