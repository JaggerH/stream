## Purpose

登录态怎么解析出来：可插拔的凭证 provider、adapter 与凭证来源解耦、缺凭证时给出可执行的错误、cookie 注入自描述。

## Requirements

### Requirement: Resolve auth via pluggable providers
A `CredentialResolver` SHALL satisfy a manifest's `auth` declaration by consulting configured `CredentialProvider`s and producing the env injection an adapter needs. The cookie provider (backed by the login-state snapshot the backend pulls from the user's browser) is provider #1; a BYOK token provider is #2.

#### Scenario: Cookie auth resolved from the snapshot
- **WHEN** a source declares `auth: cookie:bilibili.com` and the cookie provider holds a bilibili.com cookie
- **THEN** the resolver produces the RSSHub env injection for that cookie

#### Scenario: Auth none needs no credential
- **WHEN** a source declares `auth: none`
- **THEN** the resolver returns no injection and the adapter runs without credentials

### Requirement: Adapters are credential-source agnostic
Adapters SHALL receive only the resolved credential injection and never reference a specific provider. Swapping the provider implementation SHALL NOT require adapter changes. The resolved credential MAY be injected into an adapter's owned sidecar process (e.g. `sidecar.start(creds)`) in addition to `adapter.init` env, so that a sidecar needing the same credential (such as a logged-in browser context) receives it through the same seam.

#### Scenario: Provider swap leaves adapter unchanged
- **WHEN** the configured provider is swapped for another one that yields the same cookie
- **THEN** the adapter behaves identically with no code change

#### Scenario: Credential injected into a sidecar
- **WHEN** a sidecar-backed adapter declares it needs the resolved cookie and the provider holds it
- **THEN** the resolver's injection is passed into the sidecar's start, and the adapter still references no specific provider

### Requirement: Missing credential surfaces an actionable error
When a required credential cannot be resolved, the resolver SHALL surface a clear error identifying the source and the missing credential.

#### Scenario: Required cookie absent
- **WHEN** a source requires a cookie for a domain the provider has no cookie for
- **THEN** the resolver fails with an error naming the source and the missing domain

### Requirement: Cookie credential injection is self-describing

A cookie `AuthSpec` SHALL carry how its credential is injected, not merely which domain it belongs to. The resolver SHALL produce the adapter's env overrides from that description alone, without consulting a hardcoded domain→env-var table.

The `AuthSpec.inject` descriptor SHALL be one of:
- `{ kind: 'env', name }` — the resolved cookies for the spec's domain are joined into a cookie string and assigned to the single env var `name`.
- `{ kind: 'transform', ref }` — a named transform (from a small registry) computes the env overrides from the resolved cookies, for cases a static env var cannot express.

#### Scenario: Env-kind inject maps cookies to the named var
- **WHEN** a source's `AuthSpec` is `{ type:'cookie', domain:'xueqiu.com', inject:{ kind:'env', name:'XUEQIU_COOKIES' } }` and the provider holds cookies for `xueqiu.com`
- **THEN** `resolve()` returns env overrides `{ XUEQIU_COOKIES: "<cookie string>" }` with no table lookup

#### Scenario: Transform-kind inject applies the named transform
- **WHEN** a source's `AuthSpec` is `{ type:'cookie', domain:'bilibili.com', inject:{ kind:'transform', ref:'bilibili' } }` and the cookies contain `DedeUserID=2267573`
- **THEN** the `bilibili` transform produces `{ BILIBILI_COOKIE_2267573: "<cookie string>" }`

#### Scenario: No matching cookies resolves to null
- **WHEN** a cookie `AuthSpec`'s domain has no cookies in the snapshot
- **THEN** `resolve()` returns null (no env overrides), unchanged from prior behavior

#### Scenario: Existing login sources keep resolving
- **WHEN** bilibili / weibo / zhihu / xiaohongshu sources are resolved after the change
- **THEN** each produces the exact same env overrides it produced before the change (regression baseline)
