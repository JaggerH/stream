## Purpose

Stream 自己的出站请求走一条自有通道：不被内嵌 facility 改写、不受装载顺序影响，SSRF 守卫钉在这条通道上而不是散在各站点的补丁里。

## Requirements

### Requirement: Stream's own outbound requests are not rewritten by an embedded facility

Stream's own outbound HTTP SHALL be issued through a channel that an embedded facility cannot intercept, and SHALL be unaffected by the embedded RSSHub request-rewriter — which, on load, replaces `globalThis.fetch`, `Headers`, `FormData`, `Request`, `Response` and the `get`/`request` methods of `node:http` and `node:https`, and injects a self-origin `Referer` on requests that carry none. The facility's own routes MAY continue to use its rewriter; this requirement constrains only Stream's own traffic.

#### Scenario: 改写器已生效时，owned 通道仍未被改写
- **WHEN** 内嵌 facility 的改写器已经打过补丁，Stream 经 owned 通道发出一个不带 Referer 的请求
- **THEN** 该请求发出时不带被注入的 self-origin `Referer`，也不经过该 facility 的传输实现

#### Scenario: facility 自己的路由不受影响
- **WHEN** 一条 RSSHub 路由发出它自己的请求
- **THEN** 它仍走 RSSHub 的改写器，行为不变

### Requirement: Outbound behaviour does not depend on facility load order

Stream's outbound behaviour SHALL NOT depend on whether an embedded facility has been loaded yet. The facility is imported lazily on first use of one of its routes, so without this rule the same call issues a rewritten request or an untouched one depending on whether a route happened to be hit earlier in the process's life — a difference invisible to tests (which never load the facility) and reproducible only under specific production timing.

#### Scenario: 加载前后行为一致
- **WHEN** 同一个 Stream 出站调用分别在 facility 加载前、加载后执行
- **THEN** 两次请求的传输行为一致

### Requirement: One owned channel, not per-site workarounds

Escaping a facility's rewriter SHALL be a single owned mechanism with an explicit startup-time ordering guarantee, not an ad-hoc trick repeated per call site. Capturing original bindings by importing earlier than the facility SHALL NOT be relied upon as the guarantee, because that is a property of import order rather than a stated contract.

#### Scenario: 新增出站需求不需要再发明绕法
- **WHEN** 一处新代码需要发出不被改写的请求
- **THEN** 它使用既有的 owned 通道，无需自行捕获绑定或依赖 import 顺序

### Requirement: The SSRF guard runs on the owned channel

The project's SSRF-guarded fetch SHALL issue its requests over the owned channel while keeping its guard semantics unchanged. A guard that validates a URL and then hands the request to a third-party-controlled transport does not deliver what its name promises.

#### Scenario: 守卫语义不变，传输可信
- **WHEN** SSRF 守卫拒绝一个私网 URL
- **THEN** 拒绝行为与本 change 之前完全一致

#### Scenario: 放行的请求走 owned 通道
- **WHEN** SSRF 守卫放行一个公网 URL
- **THEN** 该请求经 owned 通道发出，不经 facility 改写器
