## Purpose

recipe 可以携带纯计算片段，跑在零能力的 isolate 里：能力是装载期校验的白名单、堆与墙钟有硬上限、只回 JSON、I/O 留在引擎、平台签名绝不伪造。

## Requirements

### Requirement: A recipe may carry pure-computation snippets, run in a zero-capability isolate

A plain-HTTP recipe MAY declare a compute hook carrying author-written snippets that compute values — sign request parameters, derive fill-ins, decrypt a response body. Each snippet SHALL run in an isolated VM heap that has no host globals whatsoever: no `fetch`, no `process`, no `crypto`, no `require`, no filesystem, no host object graph. The snippet's only inputs SHALL be the JSON payload the engine hands in plus the capabilities it declared.

This is what makes a shared recipe safe to run: the guarantee comes from the snippet having no capability to abuse, not from reviewing what the snippet says.

#### Scenario: 沙箱里没有宿主全局
- **WHEN** 一段 recipe 代码求值 `typeof fetch` / `typeof process` / `typeof crypto` / `typeof require`
- **THEN** 每一个都是 `undefined`

#### Scenario: 逃逸尝试拿不到能力
- **WHEN** 一段 recipe 代码走构造器逃逸（例如 `this.constructor.constructor('return process')()`）去够宿主
- **THEN** 该次执行以错误结束，调用方按「recipe 执行失败」处理，绝不返回一个宿主对象

### Requirement: Capabilities are a whitelist, declared per recipe and checked at load

The sandbox SHALL be able to call only host-implemented pure functions injected by name from a fixed whitelist, and only those names the recipe itself declared. A recipe's declared capability list SHALL be validated when the recipe is loaded — the review point for a shared recipe — not on first use. Every whitelisted capability SHALL be a pure function of its arguments: no network, no filesystem, no ambient secret, no mutable host state, because an untrusted snippet chooses the arguments. Adding a name to the whitelist is therefore a security decision, not a convenience.

#### Scenario: 没声明的能力就不存在
- **WHEN** 一段 snippet 求值一个白名单里有、但本 recipe 未声明的能力名
- **THEN** 该名字在沙箱里是 `undefined`；声明过的名字才可调用并返回其结果

#### Scenario: 白名单外的能力名在装载时被拒
- **WHEN** 一份 recipe 声明了宿主不认识的能力名
- **THEN** 装载该 recipe 即报错并指出这个名字，不进入运行期

#### Scenario: 能力清单必须存在且是数组
- **WHEN** 一份带 compute 钩子的 recipe 没有给出 `capabilities` 数组
- **THEN** 装载失败

### Requirement: Hard heap and wall-clock limits, enforced by the VM

Every snippet execution SHALL be bounded by a wall-clock timeout and a heap cap enforced by the isolate itself. A snippet that loops forever or allocates without bound SHALL be killed and surfaced as a recipe failure. Every failure mode — isolation breach attempt, timeout, out-of-memory, syntax error, a capability throwing — SHALL surface as one recipe-level error type, never as a host crash and never as a silently empty result.

#### Scenario: CPU 炸弹被墙钟砍掉
- **WHEN** 一段 snippet 死循环
- **THEN** 超过墙钟限额即被终止，调用方收到 recipe 级错误

#### Scenario: 内存炸弹被堆上限砍掉
- **WHEN** 一段 snippet 不断分配内存
- **THEN** 超过堆上限即被终止，宿主进程不受影响

#### Scenario: 语法错误也是 recipe 失败
- **WHEN** 一段 snippet 根本不是合法 JS
- **THEN** 报同一种 recipe 级错误，不崩宿主

### Requirement: The sandbox returns JSON and only JSON

A snippet SHALL yield a JSON value; nothing crosses the boundary by reference. Inputs SHALL be deep-copied in and results copied out, so no live host object ever enters the heap and no sandbox object ever escapes into the host.

#### Scenario: 输入是拷贝，结果是拷贝
- **WHEN** 引擎把一个 JSON 负载交给 snippet 并取回它的返回值
- **THEN** 进出两侧都是结构化拷贝的 JSON 值，宿主函数体和对象引用都不进入沙箱

### Requirement: I/O stays in the engine

The sandbox SHALL perform no I/O. Every request a computation depends on — the extra requests whose responses feed the snippets, and the main request itself — SHALL be issued by the engine through its guarded outbound path, so the SSRF guard and the cookie-domain binding apply to them exactly as they apply to a compute-free recipe. The engine SHALL hand results in as data (bound under the names the recipe declared), and SHALL merge what the snippet returns back into the outgoing request or the decoded body. A snippet SHALL also have no clock of its own: any timestamp it needs SHALL be passed in.

#### Scenario: 计算所依赖的额外请求由引擎发
- **WHEN** 一份 recipe 声明了喂给 snippet 的前置请求
- **THEN** 这些请求由引擎发出，与主请求走同一道 SSRF 与 cookie 绑定守卫，响应以数据形式绑给 snippet

#### Scenario: 签名的结果只是数据
- **WHEN** 一段 sign snippet 返回 url / headers / body 的补丁
- **THEN** 引擎把它并进外发请求后自己发出；snippet 从头到尾没有发出任何网络请求的手段

#### Scenario: 时间由引擎注入
- **WHEN** 一段 snippet 需要时间戳
- **THEN** 时间戳由引擎作为输入传入，沙箱里没有时钟

### Requirement: Platform signatures are never forged

The compute hook SHALL NOT be used to forge a platform's own request signature. Where a platform (a first-party video/content site) requires its page's JS to sign the request, that Source SHALL route to a browser kind and let the page compute it. The hook's legitimate targets are third-party tools whose signatures the tool's own developer added to protect their own endpoint — computing those is not impersonating a platform.

#### Scenario: 平台签名不走沙箱
- **WHEN** 目标站是要求页面自签的一线平台
- **THEN** 该 Source 走浏览器 kind，由页面自己算签名；不得把该签名算法搬进 compute 钩子

#### Scenario: 第三方工具站的自签名可以算
- **WHEN** 目标站是第三方工具自身给自己接口加的签名/加密
- **THEN** 该 Source 可用 compute 钩子在零能力沙箱里算，不必上浏览器
