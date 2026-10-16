# Device Execution — Linux Device Agent Implementation Plan (2/3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一台 Linux 机器（NAS）上的 `stream-desktop` 以「设备模式」运行：首次启动用配对码无人值守配对，之后凭保存的 device token 连上主实例，声明 `http.fetch` 并替主实例发 HTTP 请求——设备侧再校验允许主机、始终拒绝私网目标。

**Architecture:** 设备模式由环境变量 `STREAM_BACKEND_URL` 触发，只在 `cfg(target_os = "linux")` 编入。WS 客户端、`host-relay.v2` 协议、监督循环沿用 `main.rs` 现有那一份——`run_session` 改为吃一个 `Session`（url / token / hello / 可选 fetcher / 是否配对），本机模式与设备模式只在这几个值上不同。`http.fetch` 每个请求一个 tokio 任务（不阻塞会话循环），用 reqwest + rustls，自定义 DNS resolver 在连接前检查每个解析结果，重定向由我们自己逐跳处理，每一跳重复主机与地址两道检查。

**Tech Stack:** Rust（edition 2021，rustc ≥ 1.88）、tokio 1.53、tokio-tungstenite 0.24、reqwest 0.12（rustls、无系统代理）、serde_json、base64 0.22。

**Spec:** `openspec/changes/device-execution/`——本计划实现 `specs/linux-device-agent/spec.md` 的前两条 Requirement（Linux 无界面 agent、无人值守配对）与 `specs/device-http-fetch/spec.md` 的设备侧部分（线上语义、允许主机的设备侧校验与 `ALLOW_HOSTS`、私网拒绝）。设计依据 `design.md` D5、D6、D8、D9。

**本计划不含（后续计划）：**
- 计划 3/3 — 浏览器转发（D7）与 `stream-node` 镜像：agent 本机 8900 转发、`browser` op、Chromium + 扩展 + noVNC 镜像、x86_64/aarch64 多架构构建、`docs/ops/nas-device.md`。
- 设备侧的取消帧：后端在请求发出后中止时，今天判为 `device-lost`（状态未知、不重试）；agent 不需要也收不到取消。设备模式不发 `abort` 帧，所以 `abortEpoch` 在这里只读不用。
- 后端改动：计划 1 已交付后端全部所需（配对带平台、`linux` hello、`fetchOp`、错误帧 `code`）。本计划**不改 `src/`**。

## Global Constraints

- 工具链：rustc ≥ 1.88（现有依赖 `ort-sys 2.0.0-rc.13` 要求；box 自带的 `/usr/bin/cargo` 是 1.85，编不过）。box 上用 rustup 装到 `~/.cargo`，命令前加 `export PATH="$HOME/.cargo/bin:$PATH"`。
- 设备模式只在 `cfg(target_os = "linux")` 编入：`device.rs`、`httpfetch.rs`、`netguard.rs` 三个模块与 `reqwest`、`url`、tungstenite 的 TLS 特性都挂在 linux target 下。**Windows / macOS 桌面构建的依赖集合不变。**
- 环境变量名（逐字）：`STREAM_BACKEND_URL`（主实例的 http(s) 基址，触发设备模式）、`STREAM_PAIRING_CODE`、`STREAM_AGENT_DATA`（状态目录）、`STREAM_DEVICE_NAME`、`ALLOW_HOSTS`（逗号分隔；spec 原文就是这个名字，不加 `STREAM_` 前缀）。
- 状态目录缺省：`STREAM_AGENT_DATA` → `$XDG_DATA_HOME/stream-agent` → `$HOME/.local/share/stream-agent`。配对状态文件 `<状态目录>/device.json`，权限 0600，内容 `{"deviceId":"linux:<uuid>","deviceToken":"…"}`。只存 id 与 token，**不存后端地址**——地址每次取环境变量（主实例换了 IP，token 照样有效）。
- 配对：`POST <backend>/api/devices/pair`，body `{"code","name","platform":"linux"}`，成功回 `{deviceId: "linux:<uuid>", deviceToken}`。回复里的 `deviceId` 不以 `linux:` 开头即视为失败（老后端会忽略 `platform` 发 `android:` id）。
- 已保存的配对优先于环境变量里的配对码：有 `device.json` 就**不碰** `STREAM_PAIRING_CODE`。
- 被拒的配对码不重试：4xx（或 2xx 但回复不对）→ 打日志后挂起（每小时重打一行），等用户换码重启。网络错误 / 5xx → 按 `relay::Supervisor` 的退避（1s 起、翻倍、30s 封顶）重试。
- WS：`<backend 换成 ws/wss>/api/host`，子协议头 `host-relay.v2, <deviceToken>`。首帧 hello：`{type:"hello", deviceId, platform:"linux", name, agentVersion: CARGO_PKG_VERSION, ops:["http.fetch"]}`。`name` = `STREAM_DEVICE_NAME` → 主机名 → `"Linux"`。
- 撤销：配对会话上握手 401 或收到关闭码 4003 = 撤销 → `device.json` 改名为 `device.json.revoked`，再走配对流程（通常是挂起等新码）。共享 token 会话上的 401 仍是原来的 `Rejected`（退避重试）。
- `http.fetch` 线上形状（与后端 `src/http/host-relay.ts` 的 `HttpFetchArgs` / `HttpFetchResult` 一致）：
  - args `{method, url, headers: [string,string][], body?: base64, redirect: "manual"|"follow", timeoutMs, allowHosts: string[]}`
  - 成功回 `{id, result: {status, headers: [string,string][], body: base64, url}}`
  - 失败回 `{id, error: "<code>: <message>", code}`，`code` 只取 `host-not-allowed` | `private-target` | `timeout` | `network` | `too-large`。
- 响应体上限 `10 * 1024 * 1024` 字节（解压后），超出为 `too-large`。`follow` 最多 20 跳，超出为 `network`。`timeoutMs` 限在 `[1, 120000]`，覆盖整个请求（含全部跳转与读 body），到点为 `timeout`。
- 主机匹配与后端 `src/devices/run-context.ts` 的 `hostAllowed` 同一条规则：两边先 `trim`、小写、去掉一个前导点和一个尾点；`h == d || h.ends_with("." + d)`；空条目不匹配任何主机。
- `ALLOW_HOSTS` 非空时**整个替换**下发的 `allowHosts`（不是取交集，也不是合并）。
- 私网拒绝的地址段：IPv4 `0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.168/16`、`224/3`（组播、保留、广播）；IPv6 `::`、`::1`、`fe80::/10`、`fec0::/10`、`fc00::/7`、`ff00::/8`，以及内嵌 IPv4 的 `::ffff:0:0/96`、`::/96`、`64:ff9b::/96`、`2002::/16`（按内嵌的 v4 再判一次）。DNS 解析结果**任一**落在其中就整体拒绝。
- 私网拒绝不可关闭：二进制里没有关掉它的路——放行 loopback 的那一档构造函数只在 `#[cfg(test)]` 下存在，没有环境变量、没有参数。
- 不走系统代理：所有 reqwest 客户端都 `.no_proxy()`（走了代理，resolver 解析的就是代理地址，私网检查形同虚设）。
- 日志只记 `method host → status|code (ms)`；不记请求头、响应头、请求体、响应体，也不记 URL 的路径与查询串。
- 跨源跳转删掉 `authorization`、`proxy-authorization`、`cookie`；301/302 的 POST 与 303 的非 GET/HEAD 改为无 body 的 GET 并删掉 `content-type`、`content-encoding`、`content-language`、`content-location`（Fetch 规范的做法）。
- 请求头里不转发 `host`、`content-length`、`connection`、`transfer-encoding`、`keep-alive`、`upgrade`、`proxy-connection`、`te`、`trailer`、`accept-encoding`——这些由 reqwest 按真实请求算（`accept-encoding` 由 reqwest 声明它自己解得开的编码，并自动解压）。
- 注释与日志沿用本仓风格：中文、解释「为什么」，不写装饰性注释。编辑文件用 Edit；不用 `sed -i`。
- 测试命令：`cargo test --manifest-path app/host-agent/Cargo.toml <过滤词>`（在 worktree 根目录执行）。

## Review Focus

1. **NAS / 容器里设了 `HTTP_PROXY` / `HTTPS_PROXY`**——reqwest 缺省会走代理，这时 resolver 解析的是代理主机，目标的私网检查被整个绕过。期望：设备请求直连，代理收不到任何连接。Task 2 的 `system_proxy_env_is_ignored` 钉住。
2. **跨源跳转带走 cookie**——东财某个接口 302 到另一个允许的主机，后端为原主机放进来的 `Cookie` 头不能跟着去。期望：同源跳转保留，跨源跳转删掉。Task 2 的 `cross_origin_redirect_drops_cookie` 与 `same_origin_redirect_keeps_cookie` 钉住。
3. **包代码自己设了 `Accept-Encoding: gzip`**（模仿浏览器的请求头很常见）——对端回 gzip，若设备原样回传，后端构造的 `Response` 里是压缩字节，`res.text()` 是乱码且不报错。期望：设备解压，回传的头里没有 `content-encoding`。Task 2 的 `gzip_response_is_decoded` 钉住。
4. **容器重启循环带着一个用过的配对码**——`restart: always` 下每次启动都拿旧码去配，后端在连续失败后会作废**当前**有效的码，用户刚生成的新码在改环境变量之前就被烧掉。期望：被拒的码不重试，进程挂起不退出。Task 4 的 `a_rejected_code_parks_and_an_unreachable_backend_retries` 钉住策略，`pair` 的 403 测试钉住分类。
5. **一个慢请求挡住同一台设备上的其他请求**——会话循环若内联执行 `http.fetch`，跨洋或对端卡住的请求会让后面所有帧（包括同一任务的下一笔）排到它超时为止。期望：并发执行，快的先回。Task 3 的 `a_slow_fetch_does_not_hold_up_the_next_one` 钉住。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `app/host-agent/src/netguard.rs`（新） | 纯函数：主机后缀匹配、`ALLOW_HOSTS` 解析与生效清单、私网地址判定 |
| `app/host-agent/src/httpfetch.rs`（新） | `http.fetch` op：线上类型、带检查的 DNS resolver、逐跳重定向、10MB 上限、超时、回复帧 |
| `app/host-agent/src/device.rs`（新） | 设备模式：环境变量、配对状态文件、`pair` 请求、启动决策、配对失败策略、URL 推导、hello |
| `app/host-agent/src/relay.rs` | `SessionEnd::Revoked` |
| `app/host-agent/src/main.rs` | `Session` 结构；`run_session` / `supervise` 改吃 `Session`；`http.fetch` 并发执行；设备模式入口 `run_device_mode` |
| `app/host-agent/Cargo.toml` | linux target 下的 `reqwest`、`url`、tungstenite TLS 特性；linux dev-dep `flate2` |
| `app/host-agent/README.md` | 「设备模式（Linux）」一节 |
| `.github/workflows/test.yml` | `host-agent` job：`cargo test` |
| `openspec/changes/device-execution/tasks.md` | 计划 2 的勾选清单 |

---

### Task 0: 工具链与基线

**Files:** 无（只读）

- [ ] **Step 1: 装 rustup stable（用户级）**

Run: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup-init.sh` 然后 `sh /tmp/rustup-init.sh -y --profile minimal --no-modify-path`
Expected: `~/.cargo/bin/cargo` 存在；`export PATH="$HOME/.cargo/bin:$PATH"; cargo --version` 报 1.88 或更新。已经装过就跳过。

- [ ] **Step 2: 基线**

Run: `export PATH="$HOME/.cargo/bin:$PATH"; cargo test --manifest-path app/host-agent/Cargo.toml 2>&1 | tail -30`
Expected: 编译通过、测试全部 PASS。若有失败（例如 OCR golden 测试缺模型文件），记下失败用例名——它们是否自带跳过决定 Task 5 的 CI job 怎么写；后续任务只对比新增失败。

---

### Task 1: `netguard` —— 主机匹配与私网判定

**Files:**
- Create: `app/host-agent/src/netguard.rs`
- Modify: `app/host-agent/src/main.rs`（`mod` 声明）

**Interfaces:**
- Produces:
  - `pub fn host_allowed(host: &str, allow: &[String]) -> bool`
  - `pub fn parse_allow_hosts(raw: Option<&str>) -> Option<Vec<String>>`（空 / 全空白 → `None`）
  - `pub fn effective_allow<'a>(device: Option<&'a [String]>, sent: &'a [String]) -> &'a [String]`
  - `pub fn is_blocked_ip(ip: std::net::IpAddr) -> bool`

- [ ] **Step 1: 写失败的测试**

Create `app/host-agent/src/netguard.rs`，先只放测试与空签名（`todo!()` 体），确认测试红：

```rust
//! `http.fetch` 在设备侧的两道闸门：目标主机在不在允许清单里、目标地址是不是私网。
//!
//! 全是纯函数，与 OS 无关——每个地址段都在 Linux 上的 `cargo test` 里钉住。
//! 权威：openspec/changes/device-execution/design.md D6、specs/device-http-fetch/spec.md。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub fn host_allowed(host: &str, allow: &[String]) -> bool { todo!() }
pub fn parse_allow_hosts(raw: Option<&str>) -> Option<Vec<String>> { todo!() }
pub fn effective_allow<'a>(device: Option<&'a [String]>, sent: &'a [String]) -> &'a [String] { todo!() }
pub fn is_blocked_ip(ip: IpAddr) -> bool { todo!() }

#[cfg(test)]
mod tests {
    use super::*;

    fn list(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn suffix_matches_the_domain_and_its_subdomains_only() {
        let allow = list(&["eastmoneysec.com"]);
        assert!(host_allowed("eastmoneysec.com", &allow));
        assert!(host_allowed("jywg.eastmoneysec.com", &allow));
        assert!(host_allowed("JYWG.EastMoneySec.com.", &allow), "大小写与尾点不影响");
        // 后缀伪装：不是子串匹配。
        assert!(!host_allowed("evil-eastmoneysec.com", &allow));
        assert!(!host_allowed("eastmoneysec.com.evil.io", &allow));
        assert!(!host_allowed("push2.eastmoney.com", &allow));
    }

    #[test]
    fn entries_are_normalised_like_the_backend_and_empty_ones_match_nothing() {
        assert!(host_allowed("a.example.com", &list(&[" .Example.COM. "])));
        assert!(!host_allowed("example.com", &list(&["", "  ", "."])));
        assert!(!host_allowed("example.com", &[]));
        assert!(host_allowed("10.0.0.5", &list(&["10.0.0.5"])), "IP 字面量按相等匹配");
    }

    #[test]
    fn allow_hosts_env_is_parsed_and_blank_means_unset() {
        assert_eq!(parse_allow_hosts(None), None);
        assert_eq!(parse_allow_hosts(Some("")), None);
        assert_eq!(parse_allow_hosts(Some(" , ,")), None);
        assert_eq!(parse_allow_hosts(Some("eastmoneysec.com, eastmoney.com ")), Some(list(&["eastmoneysec.com", "eastmoney.com"])));
    }

    /// spec「设备侧清单优先」：设备配了 ALLOW_HOSTS，下发的清单再宽也不算数。
    #[test]
    fn the_device_list_replaces_the_sent_one() {
        let device = list(&["eastmoneysec.com"]);
        let sent = list(&["eastmoneysec.com", "eastmoney.com"]);
        let allow = effective_allow(Some(&device), &sent);
        assert!(!host_allowed("push2.eastmoney.com", allow));
        assert!(host_allowed("push2.eastmoney.com", effective_allow(None, &sent)));
    }

    #[test]
    fn private_and_special_ipv4_ranges_are_blocked() {
        for s in [
            "0.0.0.0", "0.1.2.3", "10.0.0.5", "10.255.255.255", "127.0.0.1", "127.8.8.8",
            "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} 应被拒");
        }
    }

    #[test]
    fn public_ipv4_neighbours_of_the_blocked_ranges_are_allowed() {
        for s in ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "169.255.0.1", "223.255.255.255"] {
            assert!(!is_blocked_ip(ip(s)), "{s} 是公网地址");
        }
    }

    #[test]
    fn private_and_special_ipv6_ranges_are_blocked() {
        for s in ["::", "::1", "fe80::1", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1"] {
            assert!(is_blocked_ip(ip(s)), "{s} 应被拒");
        }
    }

    /// 借 IPv6 外壳套一个内网 v4：映射、兼容、NAT64、6to4 都要按里面的 v4 再判一次。
    #[test]
    fn ipv6_forms_embedding_a_private_ipv4_are_blocked() {
        for s in ["::ffff:10.0.0.5", "::ffff:127.0.0.1", "::10.0.0.5", "64:ff9b::a00:5", "64:ff9b::c0a8:101", "2002:c0a8:101::1", "2002:7f00:1::"] {
            assert!(is_blocked_ip(ip(s)), "{s} 内嵌的是私网 v4");
        }
        for s in ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111", "2400:3200::1"] {
            assert!(!is_blocked_ip(ip(s)), "{s} 是公网地址");
        }
    }
}
```

- [ ] **Step 2: 挂上模块并确认测试红**

在 `app/host-agent/src/main.rs` 的 `mod` 列表里按字母序加（`mod launch;` 之后、`#[cfg(target_os = "macos")] mod macos;` 之前）：

```rust
#[cfg(target_os = "linux")]
mod netguard;
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml netguard`
Expected: FAIL（`not yet implemented` panic）。未使用警告可以忽略。

- [ ] **Step 3: 实现**

把四个 `todo!()` 换成：

```rust
/// 与后端 `src/devices/run-context.ts` 的 `norm` 同一条规则：去空白、小写、去掉一个前导点和一个尾点。
/// 两边规则不一致的后果是「后端放行、设备拒绝」或反过来——同一份声明在两处得出两个答案。
fn norm(s: &str) -> String {
    let lower = s.trim().to_ascii_lowercase();
    let mut t: &str = &lower;
    if let Some(r) = t.strip_prefix('.') {
        t = r;
    }
    if let Some(r) = t.strip_suffix('.') {
        t = r;
    }
    t.to_string()
}

/// 主机名后缀匹配。**不是子串**：`evil-eastmoneysec.com` 不算 `eastmoneysec.com`。
pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let h = norm(host);
    allow.iter().any(|d| {
        let s = norm(d);
        !s.is_empty() && (h == s || h.ends_with(&format!(".{s}")))
    })
}

/// `ALLOW_HOSTS=a.com,b.com`。去空白、丢空项；一项都不剩就当没配——空清单不能变成「全部拒绝」
/// 这种看起来像配置、其实是手滑的状态。
pub fn parse_allow_hosts(raw: Option<&str>) -> Option<Vec<String>> {
    let list: Vec<String> = raw?
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() { None } else { Some(list) }
}

/// 设备配了 `ALLOW_HOSTS` 就以它为准，**整个替换**后端下发的清单（D6）：这道闸门是给不信任后端的
/// 运维者用的，和后端清单取并集就等于没有。
pub fn effective_allow<'a>(device: Option<&'a [String]>, sent: &'a [String]) -> &'a [String] {
    device.unwrap_or(sent)
}

/// 这个地址能不能连。D6 列的段（loopback / RFC1918 / 链路本地 / CGNAT / ULA）之外，还拒
/// `0/8`（Linux 上连 0.0.0.0 就是连本机）与组播、保留段（不是一个能发 HTTP 的公网主机）。
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => blocked_v6(v6),
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (b & 0xc0) == 64) // 100.64/10：CGNAT，Tailscale 的地址就在这里
        || (a == 169 && b == 254)
        || (a == 172 && (b & 0xf0) == 16)
        || (a == 192 && b == 168)
        || a >= 224
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return true;
    }
    let s = ip.segments();
    if (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0 {
        return true; // 链路本地；站点本地（已废弃，但仍是内网）
    }
    if (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xff00) == 0xff00 {
        return true; // ULA；组播
    }
    embedded_v4(&s).is_some_and(blocked_v4)
}

/// IPv6 外壳里的 IPv4。不拆开判，`::ffff:10.0.0.5` 这种写法就能把内网地址带过 v6 那几条规则。
fn embedded_v4(s: &[u16; 8]) -> Option<Ipv4Addr> {
    let v4 = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    // ::ffff:a.b.c.d（映射）与 ::a.b.c.d（兼容，已废弃）
    if s[..5].iter().all(|&x| x == 0) && (s[5] == 0xffff || s[5] == 0) {
        return Some(v4(s[6], s[7]));
    }
    // 64:ff9b::a.b.c.d（NAT64 公认前缀：网关会替你连到那个 v4）
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|&x| x == 0) {
        return Some(v4(s[6], s[7]));
    }
    // 2002:AABB:CCDD::/48（6to4）
    if s[0] == 0x2002 {
        return Some(v4(s[1], s[2]));
    }
    None
}
```

- [ ] **Step 4: 测试转绿**

Run: `cargo test --manifest-path app/host-agent/Cargo.toml netguard`
Expected: 8 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add app/host-agent/src/netguard.rs app/host-agent/src/main.rs
git commit -m "feat(host-agent): device-side host allow-list and private-address checks"
```

---

### Task 2: `httpfetch` —— 设备侧的 `http.fetch`

**Files:**
- Create: `app/host-agent/src/httpfetch.rs`
- Modify: `app/host-agent/Cargo.toml`、`app/host-agent/src/main.rs`（`mod` 声明）

**Interfaces:**
- Consumes: `netguard::{host_allowed, effective_allow, is_blocked_ip}`（Task 1）
- Produces:
  - `pub struct Guard`；`Guard::strict()`；`#[cfg(test)] Guard::loopback_ok()`；`fn blocks(&self, IpAddr) -> bool`
  - `pub struct Fetcher`；`Fetcher::new(guard: Guard, device_allow: Option<Vec<String>>) -> Result<Fetcher, String>`
  - `pub async fn Fetcher::reply(&self, id: serde_json::Value, args: &serde_json::Value) -> serde_json::Value`（整帧回复，`{id,result}` 或 `{id,error,code}`）
  - `pub async fn Fetcher::fetch(&self, args: FetchArgs) -> Result<FetchResult, FetchError>`
  - `FetchArgs`、`FetchResult`、`FetchError { code: &'static str, message: String }`、`RedirectMode`、`MAX_BODY`

- [ ] **Step 1: 加依赖**

在 `app/host-agent/Cargo.toml` 末尾（macOS 那一段之后）追加：

```toml
# 设备模式（`device.rs` / `httpfetch.rs`）只在 Linux 构建里：NAS 上的执行端替主实例发 HTTP。
# 挂在 linux target 下，Windows / macOS 桌面构建的依赖集合因此一个都不变。
#
# reqwest：rustls（镜像里不带系统 CA 也能用，webpki 根证书随二进制走）；**不开 default-features**，
# 于是没有 native-tls、没有系统代理探测之外的多余东西——代理在代码里显式 `.no_proxy()` 关掉
# （走代理时 resolver 解析的是代理地址，私网检查就被绕过了）。gzip/brotli/deflate：包代码常常
# 自己带 `Accept-Encoding`，对端回压缩体时必须在这里解开，后端构造的 Response 不会替你解。
[target.'cfg(target_os = "linux")'.dependencies]
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "http2", "gzip", "brotli", "deflate", "json"] }
url = "2"
# 主实例走公网 HTTPS 时设备要连 wss://。
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots"] }

[target.'cfg(target_os = "linux")'.dev-dependencies]
flate2 = "1"
```

Run: `cargo build --manifest-path app/host-agent/Cargo.toml`
Expected: 编译通过。若某个新拉进来的依赖要求比当前工具链更新的 rustc，按报错提示用 `cargo update <name>@<ver> --precise <兼容版本>` 降到兼容版本，并把这次降级写进提交信息。

- [ ] **Step 2: 写失败的测试**

Create `app/host-agent/src/httpfetch.rs`：先写下面完整的类型、`Guard`、`GuardedResolver`、`Fetcher::new`，`Fetcher::fetch` / `reply` 的体先放 `todo!()`；测试模块整段写全。

```rust
//! `http.fetch` 的设备侧实现：后端经 `/api/host` 派来一个 HTTP 请求，这里替它在本机发出。
//!
//! 线上形状与后端 `src/http/host-relay.ts` 的 `HttpFetchArgs` / `HttpFetchResult` 一一对应；
//! 语义见 openspec/changes/device-execution/specs/device-http-fetch/spec.md。每一跳都过三道闸门：
//! 允许主机（`ALLOW_HOSTS` 优先于下发清单）→ 私网地址（不可关闭）→ 10MB 上限。
//! cookie 由后端放进请求头；这里不存任何状态——请求之间没有 cookie jar、没有会话。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{Host, Url};

use crate::netguard;

/// 与后端 `src/devices/fetch.ts` 的 `MAX_DEVICE_BODY` 同值。量的是解压后的字节——调用方拿到的就是它。
pub const MAX_BODY: usize = 10 * 1024 * 1024;
/// 与 Fetch 规范（undici）同值。
pub const MAX_REDIRECTS: usize = 20;
/// 后端下发固定 30s（`fetch.ts` 的 `DEFAULT_TIMEOUT_MS`）；这里只防一个离谱的值把任务挂住。
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RedirectMode {
    Manual,
    Follow,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchArgs {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    pub redirect: RedirectMode,
    pub timeout_ms: u64,
    #[serde(default)]
    pub allow_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FetchResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// base64
    pub body: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FetchError {
    pub code: &'static str,
    pub message: String,
}

impl FetchError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 哪些地址不许连。生产只有一种（[`Guard::strict`]）；放行 loopback 的那档只在 `cfg(test)` 下存在
/// ——测试要连本机的假服务器，而「私网拒绝不可配置」的意思是二进制里根本没有关掉它的路。
#[derive(Debug, Clone, Copy)]
pub struct Guard {
    loopback_ok: bool,
}

impl Guard {
    pub fn strict() -> Self {
        Self { loopback_ok: false }
    }
    #[cfg(test)]
    pub fn loopback_ok() -> Self {
        Self { loopback_ok: true }
    }
    pub fn blocks(&self, ip: IpAddr) -> bool {
        netguard::is_blocked_ip(ip) && !(self.loopback_ok && ip.is_loopback())
    }
}

/// resolver 拒绝时塞进 reqwest 错误链里的那一环；[`classify`] 顺着 `source()` 把它认回来。
#[derive(Debug)]
struct PrivateTarget(String);

impl std::fmt::Display for PrivateTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} 解析到私网地址", self.0)
    }
}

impl std::error::Error for PrivateTarget {}

/// 解析 DNS，并在**连接之前**检查每一个结果：任一落在私网就整体拒绝（不是挑一个公网的连）。
/// reqwest 只会连这里交回去的地址，所以检查过的就是要连的——DNS rebinding 换不了中间那一下。
struct GuardedResolver {
    guard: Guard,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let guard = self.guard;
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if let Some(bad) = addrs.iter().find(|a| guard.blocks(a.ip())) {
                let e: Box<dyn std::error::Error + Send + Sync> = Box::new(PrivateTarget(format!("{host}（{}）", bad.ip())));
                return Err(e);
            }
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

pub struct Fetcher {
    client: reqwest::Client,
    guard: Guard,
    /// `ALLOW_HOSTS`；`None` = 没配，按后端下发的。
    device_allow: Option<Vec<String>>,
}

impl Fetcher {
    pub fn new(guard: Guard, device_allow: Option<Vec<String>>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .dns_resolver(Arc::new(GuardedResolver { guard }))
            // 重定向我们自己逐跳走：每一跳都要重新过主机清单与私网检查，reqwest 的自动跟随两样都不做。
            .redirect(reqwest::redirect::Policy::none())
            // 见 Cargo.toml 那段：走代理时 resolver 解析的是代理，私网检查被整个绕过。
            .no_proxy()
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Self { client, guard, device_allow })
    }

    pub async fn reply(&self, id: Value, args: &Value) -> Value {
        todo!()
    }

    pub async fn fetch(&self, args: FetchArgs) -> Result<FetchResult, FetchError> {
        todo!()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// 只会按顺序回放固定响应的 HTTP/1.1 服务器：每个连接读一个请求、写一个响应、关连接。
    /// 记下收到的原始请求（小写），供断言请求行、头与 body。
    struct Canned {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
        hits: Arc<AtomicUsize>,
    }

    impl Canned {
        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }
        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
        fn request(&self, i: usize) -> String {
            self.requests.lock().unwrap()[i].clone()
        }
    }

    async fn serve(responses: Vec<Vec<u8>>) -> Canned {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (rq, h) = (requests.clone(), hits.clone());
        tokio::spawn(async move {
            for resp in responses {
                let Ok((mut s, _)) = l.accept().await else { return };
                h.fetch_add(1, Ordering::SeqCst);
                let req = read_request(&mut s).await;
                rq.lock().unwrap().push(req);
                let _ = s.write_all(&resp).await;
                let _ = s.shutdown().await;
            }
        });
        Canned { addr, requests, hits }
    }

    async fn read_request(s: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        loop {
            let n = s.read(&mut tmp).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                while buf.len() < end + 4 + len {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                break;
            }
        }
        String::from_utf8_lossy(&buf).to_lowercase()
    }

    fn resp(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn args(url: &str, allow: &[&str]) -> FetchArgs {
        FetchArgs {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body: None,
            redirect: RedirectMode::Manual,
            timeout_ms: 5_000,
            allow_hosts: allow.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn fetcher() -> Fetcher {
        Fetcher::new(Guard::loopback_ok(), None).unwrap()
    }

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    fn header<'a>(r: &'a FetchResult, name: &str) -> Vec<&'a str> {
        r.headers.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect()
    }

    #[tokio::test]
    async fn returns_status_multi_value_headers_body_and_final_url() {
        let s = serve(vec![resp("200 OK", &[("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")], b"hello")]).await;
        let r = fetcher().fetch(args(&s.url("/x?q=1"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(header(&r, "set-cookie"), vec!["a=1", "b=2"], "多值头逐个保留、顺序不变");
        assert_eq!(r.body, b64(b"hello"));
        assert_eq!(r.url, s.url("/x?q=1"));
    }

    #[tokio::test]
    async fn sends_method_headers_and_body_but_not_connection_headers() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let mut a = args(&s.url("/submit"), &["127.0.0.1"]);
        a.method = "POST".into();
        a.headers = vec![
            ("Cookie".into(), "sid=abc".into()),
            ("X-Multi".into(), "1".into()),
            ("X-Multi".into(), "2".into()),
            ("Content-Length".into(), "999".into()),
            ("Host".into(), "evil.example".into()),
        ];
        a.body = Some(b64(b"k=v"));
        fetcher().fetch(a).await.unwrap();
        let req = s.request(0);
        assert!(req.starts_with("post /submit http/1.1"), "{req}");
        assert!(req.contains("cookie: sid=abc"));
        assert!(req.contains("x-multi: 1") && req.contains("x-multi: 2"));
        assert!(req.contains("content-length: 3"), "content-length 按真实 body 算：{req}");
        assert!(!req.contains("evil.example"), "host 头不照抄：{req}");
        assert!(req.ends_with("k=v"));
    }

    /// spec「302 原样回传」：东财靠这个判会话失效。
    #[tokio::test]
    async fn manual_mode_returns_the_redirect_untouched() {
        let s = serve(vec![resp("302 Found", &[("Location", "/login")], b"")]).await;
        let r = fetcher().fetch(args(&s.url("/Trade/Buy"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(header(&r, "location"), vec!["/login"]);
        assert_eq!(s.hits(), 1, "manual 不跟随");
    }

    #[tokio::test]
    async fn same_origin_redirect_keeps_cookie() {
        let s = serve(vec![resp("302 Found", &[("Location", "/next")], b""), resp("200 OK", &[], b"done")]).await;
        let mut a = args(&s.url("/start"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Cookie".into(), "sid=abc".into())];
        let r = fetcher().fetch(a).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.url, s.url("/next"));
        assert_eq!(r.body, b64(b"done"));
        assert!(s.request(1).starts_with("get /next "));
        assert!(s.request(1).contains("cookie: sid=abc"));
    }

    #[tokio::test]
    async fn cross_origin_redirect_drops_cookie() {
        let b = serve(vec![resp("200 OK", &[], b"")]).await;
        let to_b = format!("http://localhost:{}/landing", b.addr.port());
        let a_srv = serve(vec![resp("302 Found", &[("Location", to_b.as_str())], b"")]).await;
        let mut a = args(&a_srv.url("/start"), &["127.0.0.1", "localhost"]);
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Cookie".into(), "sid=abc".into()), ("Authorization".into(), "Bearer t".into()), ("X-Keep".into(), "1".into())];
        fetcher().fetch(a).await.unwrap();
        let req = b.request(0);
        assert!(!req.contains("cookie:"), "跨源不带 cookie：{req}");
        assert!(!req.contains("authorization:"));
        assert!(req.contains("x-keep: 1"));
    }

    #[tokio::test]
    async fn see_other_turns_post_into_get_without_body() {
        let s = serve(vec![resp("303 See Other", &[("Location", "/done")], b""), resp("200 OK", &[], b"")]).await;
        let mut a = args(&s.url("/form"), &["127.0.0.1"]);
        a.method = "POST".into();
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Content-Type".into(), "application/x-www-form-urlencoded".into())];
        a.body = Some(b64(b"k=v"));
        fetcher().fetch(a).await.unwrap();
        let second = s.request(1);
        assert!(second.starts_with("get /done "), "{second}");
        assert!(!second.contains("content-type:"));
        assert!(!second.ends_with("k=v"));
    }

    #[tokio::test]
    async fn too_many_redirects_is_a_network_error() {
        let hops: Vec<Vec<u8>> = (0..=MAX_REDIRECTS).map(|_| resp("302 Found", &[("Location", "/again")], b"")).collect();
        let s = serve(hops).await;
        let mut a = args(&s.url("/again"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "network");
    }

    #[tokio::test]
    async fn a_declared_length_over_the_cap_is_too_large() {
        let mut raw = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1).into_bytes();
        raw.extend_from_slice(b"x");
        let s = serve(vec![raw]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "too-large");
    }

    #[tokio::test]
    async fn an_undeclared_body_over_the_cap_is_too_large() {
        let mut raw = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        raw.extend(std::iter::repeat(b'x').take(MAX_BODY + 1));
        let s = serve(vec![raw]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "too-large");
    }

    /// Review Focus 3：包代码自己带了 Accept-Encoding，对端回 gzip。
    #[tokio::test]
    async fn gzip_response_is_decoded() {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all("你好".as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        let s = serve(vec![resp("200 OK", &[("Content-Encoding", "gzip")], &gz)]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1"]);
        a.headers = vec![("Accept-Encoding".into(), "gzip, deflate, br".into())];
        let r = fetcher().fetch(a).await.unwrap();
        assert_eq!(r.body, b64("你好".as_bytes()));
        assert!(header(&r, "content-encoding").is_empty(), "解压后不再声称是 gzip");
    }

    #[tokio::test]
    async fn a_silent_server_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = l.accept().await {
                held.push(s);
            }
        });
        let mut a = args(&format!("http://{addr}/"), &["127.0.0.1"]);
        a.timeout_ms = 200;
        let started = Instant::now();
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn a_host_outside_the_list_is_refused_without_connecting() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["example.com"])).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(s.hits(), 0);
    }

    /// spec「设备侧清单优先」，端到端那一半：下发清单放行，设备的 ALLOW_HOSTS 不放行。
    #[tokio::test]
    async fn the_device_allow_list_overrides_the_sent_one() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::loopback_ok(), Some(vec!["eastmoneysec.com".into()])).unwrap();
        let e = f.fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(s.hits(), 0);
    }

    #[tokio::test]
    async fn the_strict_guard_refuses_a_private_ip_literal_even_when_listed() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::strict(), None).unwrap();
        let e = f.fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "private-target");
        assert_eq!(s.hits(), 0);
    }

    /// 走 resolver 那条路：名字解析到 loopback，错误要从 reqwest 的错误链里认回成 private-target。
    #[tokio::test]
    async fn the_strict_guard_refuses_a_name_that_resolves_to_a_private_address() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::strict(), None).unwrap();
        let url = format!("http://localhost:{}/", s.addr.port());
        let e = f.fetch(args(&url, &["localhost"])).await.unwrap_err();
        assert_eq!(e.code, "private-target", "{e:?}");
        assert_eq!(s.hits(), 0);
    }

    /// spec「重定向到内网被拦」。
    #[tokio::test]
    async fn a_redirect_into_the_private_network_is_refused_on_that_hop() {
        let s = serve(vec![resp("302 Found", &[("Location", "http://10.0.0.5/")], b"")]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1", "10.0.0.5"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "private-target");
    }

    #[tokio::test]
    async fn a_redirect_to_an_unlisted_host_is_refused_on_that_hop() {
        let b = serve(vec![resp("200 OK", &[], b"")]).await;
        let to_b = format!("http://localhost:{}/", b.addr.port());
        let s = serve(vec![resp("302 Found", &[("Location", to_b.as_str())], b"")]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(b.hits(), 0);
    }

    #[tokio::test]
    async fn only_http_and_https_are_fetched() {
        let e = fetcher().fetch(args("ftp://127.0.0.1/x", &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "network");
    }

    /// Review Focus 1：环境里的代理变量不改变设备请求的去向。
    #[tokio::test]
    async fn system_proxy_env_is_ignored() {
        let proxy = serve(vec![resp("200 OK", &[], b"from-proxy")]).await;
        let target = serve(vec![resp("200 OK", &[], b"direct")]).await;
        std::env::set_var("HTTP_PROXY", proxy.url(""));
        std::env::set_var("http_proxy", proxy.url(""));
        let f = fetcher();
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("http_proxy");
        let r = f.fetch(args(&target.url("/"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.body, b64(b"direct"));
        assert_eq!(proxy.hits(), 0);
    }

    #[tokio::test]
    async fn the_reply_frame_has_the_wire_shape_the_backend_parses() {
        let s = serve(vec![resp("204 No Content", &[], b"")]).await;
        let ok = fetcher()
            .reply(json!(7), &json!({"method":"GET","url": s.url("/"),"headers":[],"redirect":"manual","timeoutMs":5000,"allowHosts":["127.0.0.1"]}))
            .await;
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["result"]["status"], 204);
        assert!(ok["result"]["headers"].is_array());
        assert_eq!(ok["result"]["body"], "");
        assert!(ok.get("error").is_none());

        let refused = fetcher()
            .reply(json!(8), &json!({"method":"GET","url":"http://example.com/","headers":[],"redirect":"manual","timeoutMs":5000,"allowHosts":["example.org"]}))
            .await;
        assert_eq!(refused["id"], 8);
        assert_eq!(refused["code"], "host-not-allowed");
        assert!(refused["error"].as_str().unwrap().starts_with("host-not-allowed: "), "消息里带上 code，直接看 502 也认得出");

        let bad = fetcher().reply(json!(9), &json!({"url": 1})).await;
        assert_eq!(bad["code"], "network");
    }
}
```

在 `main.rs` 的 `mod` 列表里（`mod glide;` 之后）加：

```rust
#[cfg(target_os = "linux")]
mod httpfetch;
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml httpfetch`
Expected: FAIL（`not yet implemented`）。

- [ ] **Step 3: 实现**

把 `reply` 与 `fetch` 的 `todo!()` 体换掉，并在 `impl Fetcher` 里、模块里补上其余函数：

```rust
    /// 一帧请求 → 一帧回复。错误消息以 code 开头：后端 `POST /api/devices/:id/ops` 的 502 只给消息，
    /// 人看那一行就要认得出是哪一类。日志只记方法、主机、结果与耗时（spec「不泄露内容」）。
    pub async fn reply(&self, id: Value, args: &Value) -> Value {
        let a: FetchArgs = match serde_json::from_value(args.clone()) {
            Ok(a) => a,
            Err(e) => return json!({ "id": id, "error": format!("network: http.fetch 参数不对：{e}"), "code": "network" }),
        };
        let host = Url::parse(&a.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        let method = a.method.to_ascii_uppercase();
        let started = Instant::now();
        let out = self.fetch(a).await;
        let ms = started.elapsed().as_millis();
        match out {
            Ok(r) => {
                eprintln!("[http.fetch] {method} {host} → {} ({ms}ms)", r.status);
                json!({ "id": id, "result": r })
            }
            Err(e) => {
                eprintln!("[http.fetch] {method} {host} → {} ({ms}ms)", e.code);
                json!({ "id": id, "error": format!("{}: {}", e.code, e.message), "code": e.code })
            }
        }
    }

    /// 整个请求（含全部跳转与读 body）一个超时：调用方给的是「这件事最多等多久」，不是每一跳。
    pub async fn fetch(&self, args: FetchArgs) -> Result<FetchResult, FetchError> {
        let ms = args.timeout_ms.clamp(1, MAX_TIMEOUT_MS);
        match tokio::time::timeout(Duration::from_millis(ms), self.run(args)).await {
            Ok(r) => r,
            Err(_) => Err(FetchError::new("timeout", format!("{ms}ms 内没有完成"))),
        }
    }

    async fn run(&self, args: FetchArgs) -> Result<FetchResult, FetchError> {
        let allow = netguard::effective_allow(self.device_allow.as_deref(), &args.allow_hosts).to_vec();
        let mut url = Url::parse(&args.url).map_err(|e| FetchError::new("network", format!("url 不对：{e}")))?;
        let mut method = Method::from_bytes(args.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| FetchError::new("network", format!("方法不对：{}", args.method)))?;
        let mut headers = request_headers(&args.headers)?;
        let mut body = match &args.body {
            None => None,
            Some(b) => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .map_err(|e| FetchError::new("network", format!("body 不是 base64：{e}")))?,
            ),
        };
        let mut hops = 0usize;
        loop {
            self.check_target(&url, &allow)?;
            let mut req = self.client.request(method.clone(), url.clone()).headers(headers.clone());
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            let resp = req.send().await.map_err(classify)?;
            let status = resp.status().as_u16();
            let follow = args.redirect == RedirectMode::Follow && matches!(status, 301 | 302 | 303 | 307 | 308);
            // 没有 Location 的 3xx 按 Fetch 规范原样交回去。
            let location = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
            let (true, Some(loc)) = (follow, location) else {
                return read_response(resp).await;
            };
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(FetchError::new("network", format!("超过 {MAX_REDIRECTS} 次重定向")));
            }
            let next = url.join(&loc).map_err(|e| FetchError::new("network", format!("重定向地址不对：{e}")))?;
            if (matches!(status, 301 | 302) && method == Method::POST) || (status == 303 && method != Method::GET && method != Method::HEAD) {
                method = Method::GET;
                body = None;
                for h in ["content-type", "content-encoding", "content-language", "content-location"] {
                    headers.remove(h);
                }
            }
            // 后端为原主机放进来的凭据不能跟去另一个源（Review Focus 2）。
            if url.origin() != next.origin() {
                for h in ["authorization", "proxy-authorization", "cookie"] {
                    headers.remove(h);
                }
            }
            url = next;
        }
    }

    /// 每一跳发出之前：协议、主机清单、IP 字面量的私网检查。名字的私网检查在 [`GuardedResolver`]——
    /// reqwest 遇到 IP 字面量不调 resolver，所以字面量只能在这里查。
    fn check_target(&self, url: &Url, allow: &[String]) -> Result<(), FetchError> {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(FetchError::new("network", format!("不支持的协议：{}", url.scheme())));
        }
        let host = url.host_str().ok_or_else(|| FetchError::new("network", "url 里没有主机"))?;
        if !netguard::host_allowed(host, allow) {
            return Err(FetchError::new("host-not-allowed", format!("{host} 不在允许的主机里")));
        }
        let literal = match url.host() {
            Some(Host::Ipv4(a)) => Some(IpAddr::V4(a)),
            Some(Host::Ipv6(a)) => Some(IpAddr::V6(a)),
            _ => None,
        };
        if let Some(ip) = literal {
            if self.guard.blocks(ip) {
                return Err(FetchError::new("private-target", format!("{host} 是私网地址")));
            }
        }
        Ok(())
    }
}

/// 后端给的请求头 → reqwest 的。连接层的头由 reqwest 按真实请求算；照抄后端给的（尤其
/// `content-length`、`host`）只会和实际发出去的字节对不上。`accept-encoding` 也交给 reqwest：
/// 它自己声明的编码它一定解得开，调用方声明的（比如 `zstd`）它未必解得开，解不开就会把压缩字节原样交回去。
fn request_headers(pairs: &[(String, String)]) -> Result<HeaderMap, FetchError> {
    const SKIP: &[&str] = &[
        "host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "te", "trailer",
        "accept-encoding",
    ];
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| FetchError::new("network", format!("请求头名不对：{k}")))?;
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(v).map_err(|_| FetchError::new("network", format!("请求头 {k} 的值不对")))?;
        map.append(name, value);
    }
    Ok(map)
}

async fn read_response(mut resp: reqwest::Response) -> Result<FetchResult, FetchError> {
    let status = resp.status().as_u16();
    let url = resp.url().to_string();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(too_large());
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(classify)? {
        if buf.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(FetchResult { status, headers, body: base64::engine::general_purpose::STANDARD.encode(&buf), url })
}

fn too_large() -> FetchError {
    FetchError::new("too-large", format!("响应体超过 {MAX_BODY} 字节"))
}

/// reqwest 的错误 → 线上 code。resolver 的拒绝埋在错误链深处（reqwest → hyper-util → 我们的
/// `PrivateTarget`），顺着 `source()` 找；找不到才看是不是超时，其余都是 `network`。
fn classify(e: reqwest::Error) -> FetchError {
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(s) = src {
        if let Some(p) = s.downcast_ref::<PrivateTarget>() {
            return FetchError::new("private-target", p.to_string());
        }
        src = s.source();
    }
    if e.is_timeout() {
        return FetchError::new("timeout", e.to_string());
    }
    let mut msg = e.to_string();
    let mut s = std::error::Error::source(&e);
    while let Some(x) = s {
        msg.push_str("：");
        msg.push_str(&x.to_string());
        s = x.source();
    }
    FetchError::new("network", msg)
}
```

- [ ] **Step 4: 测试转绿**

Run: `cargo test --manifest-path app/host-agent/Cargo.toml httpfetch`
Expected: 20 个测试 PASS。若 `the_strict_guard_refuses_a_name_that_resolves_to_a_private_address` 报 `network` 而不是 `private-target`，说明错误链的形状和预期不同：打印 `{e:?}` 看链上每一环，修 `classify` 的查找（不许改测试的期望）。

- [ ] **Step 5: 提交**

```bash
git add app/host-agent/Cargo.toml app/host-agent/Cargo.lock app/host-agent/src/httpfetch.rs app/host-agent/src/main.rs
git commit -m "feat(host-agent): http.fetch on the device, checking hosts and addresses on every hop"
```

---

### Task 3: 会话吃 `Session`；`http.fetch` 并发执行；撤销

**Files:**
- Modify: `app/host-agent/src/relay.rs`、`app/host-agent/src/main.rs`

**Interfaces:**
- Consumes: `httpfetch::Fetcher::reply(&self, id: Value, args: &Value) -> Value`（Task 2）
- Produces:
  - `relay::SessionEnd::Revoked(String)`
  - `main.rs`：`struct Session { url: String, token: String, hello: Value, fetcher: Option<Arc<FetcherLike>>, paired: bool }`
  - `async fn run_session<D: Desktop>(session: &Session, backend: &mut D, overlay: Option<&OverlayHandleLike>) -> SessionEnd`
  - `async fn supervise<D: Desktop>(session: &Session, backend: &mut D, supervisor: &mut Supervisor, overlay: Option<&OverlayHandleLike>) -> String`——只在撤销时返回，返回撤销原因。

- [ ] **Step 1: `SessionEnd::Revoked` 的失败测试**

在 `relay.rs` 的 tests 里加：

```rust
    /// 撤销不是"连不上"：监督循环据此停下来交给设备模式去重新配对，日志要说出下一步。
    #[test]
    fn a_revoked_session_says_what_to_do() {
        let r = SessionEnd::Revoked("HTTP 401".into());
        assert!(r.reason().contains("撤销"));
        assert!(r.reason().contains("STREAM_PAIRING_CODE"));
    }
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml relay::`
Expected: 编译失败（没有 `Revoked`）。

- [ ] **Step 2: 实现 `Revoked`**

在 `relay.rs` 的 `SessionEnd` 里、`Disconnected` 之后加：

```rust
    /// 配对设备的 token 被主实例作废了：握手 401，或连接被以 4003 关闭（`host-relay.ts` 的
    /// `attachHostRelay`；后端内部故障回的是 503 / 1011，不会落到这里）。**不重试**——拿同一个
    /// token 再连一万次也还是 401；监督循环在这里返回，交给设备模式去作废保存的配对、重新配对。
    Revoked(String),
```

`reason()` 的 match 里加：

```rust
            SessionEnd::Revoked(e) => format!(
                "主实例撤销了这台设备（{e}）——保存的配对作废，需要在主实例上生成新配对码，设进 STREAM_PAIRING_CODE 后重启"
            ),
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml relay::`
Expected: PASS。

- [ ] **Step 3: 写 `Session` 与新会话行为的失败测试**

在 `main.rs` 的 tests 模块里：先把四个现有测试改成走 `Session`（加一个辅助函数，调用处 `run_session(&dead_addr().await, "token", &mut backend, None)` → `run_session(&local_session(&dead_addr().await), &mut backend, None)`，`supervise(&url, "token", …)` → `supervise(&local_session(&url), …)`；`the_first_frame_after_connecting_is_the_hello` 里同样换成 `&local_session(&url)`）：

```rust
    use std::sync::Arc;
    use tokio_tungstenite::tungstenite::protocol::{frame::coding::CloseCode, CloseFrame};

    fn local_session(url: &str) -> Session {
        Session { url: url.to_string(), token: "token".into(), hello: relay::local_hello(), fetcher: None, paired: false }
    }

    #[cfg(target_os = "linux")]
    fn device_session(url: &str) -> Session {
        Session {
            url: url.to_string(),
            token: "device-token".into(),
            hello: relay::hello_frame("linux:abc", "linux", "nas", "0.1.0", &["http.fetch"]),
            fetcher: Some(Arc::new(httpfetch::Fetcher::new(httpfetch::Guard::loopback_ok(), None).unwrap())),
            paired: true,
        }
    }

    /// 握手阶段就回 401 的中继（不升级）。
    async fn refusing_relay() -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf).await;
                let _ = s.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            }
        });
        format!("ws://{addr}/api/host")
    }

    /// 握手成功、收下 hello、再以给定关闭码关掉的中继。
    async fn closing_relay(code: u16) -> String {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((stream, _)) = l.accept().await {
                let echo = |_r: &Request, mut resp: Response| {
                    resp.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, PROTOCOL.parse().unwrap());
                    Ok(resp)
                };
                let Ok(mut ws) = tokio_tungstenite::accept_hdr_async(stream, echo).await else { continue };
                let _ = ws.next().await;
                let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: "revoked".into() }))).await;
            }
        });
        format!("ws://{addr}/api/host")
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_401_on_a_paired_session_is_a_revoke_but_on_the_shared_token_it_is_a_retry() {
        let url = refusing_relay().await;
        let mut backend = Backend::default();
        assert!(matches!(run_session(&device_session(&url), &mut backend, None).await, SessionEnd::Revoked(_)));
        assert!(matches!(run_session(&local_session(&url), &mut backend, None).await, SessionEnd::Rejected(_)));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_4003_close_on_a_paired_session_is_a_revoke() {
        let url = closing_relay(4003).await;
        let mut backend = Backend::default();
        assert!(matches!(run_session(&device_session(&url), &mut backend, None).await, SessionEnd::Revoked(_)));
        let url = closing_relay(1001).await;
        assert!(matches!(run_session(&device_session(&url), &mut backend, None).await, SessionEnd::Disconnected));
    }

    /// 撤销是监督循环唯一的出口：返回撤销原因，交给设备模式。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn supervise_returns_only_when_the_device_is_revoked() {
        let url = closing_relay(4003).await;
        let mut backend = Backend::default();
        let mut sup = Supervisor::with(Duration::from_millis(20), Duration::from_millis(60));
        let why = tokio::time::timeout(Duration::from_secs(5), supervise(&device_session(&url), &mut backend, &mut sup, None))
            .await
            .expect("撤销之后监督循环应当返回");
        assert!(why.contains("4003"), "{why}");
    }

    /// 设备会话的首帧是调用方给的 hello（linux 平台、只声明 http.fetch），不是本机那份。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_device_session_sends_its_own_hello_first() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let echo = |_r: &Request, mut resp: Response| {
                resp.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, PROTOCOL.parse().unwrap());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, echo).await.unwrap();
            let first = ws.next().await.unwrap().unwrap();
            serde_json::from_str::<Value>(first.to_text().unwrap()).unwrap()
        });
        let session = device_session(&format!("ws://{addr}/api/host"));
        let mut backend = Backend::default();
        let first = tokio::select! {
            _ = run_session(&session, &mut backend, None) => panic!("session ended before the server read a frame"),
            v = server => v.unwrap(),
        };
        assert_eq!(first, session.hello);
    }

    /// Review Focus 5：一个挂住的请求不挡同一条连接上的下一个请求。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_slow_fetch_does_not_hold_up_the_next_one() {
        let hang = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hang_addr = hang.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = hang.accept().await {
                held.push(s);
            }
        });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let echo = |_r: &Request, mut resp: Response| {
                resp.headers_mut().insert(SEC_WEBSOCKET_PROTOCOL, PROTOCOL.parse().unwrap());
                Ok(resp)
            };
            let mut ws = tokio_tungstenite::accept_hdr_async(stream, echo).await.unwrap();
            let _hello = ws.next().await.unwrap().unwrap();
            let slow = json!({"id": 1, "op": "http.fetch", "abortEpoch": 0, "args": {
                "method": "GET", "url": format!("http://{hang_addr}/"), "headers": [], "redirect": "manual",
                "timeoutMs": 3000, "allowHosts": ["127.0.0.1"] }});
            let fast = json!({"id": 2, "op": "http.fetch", "abortEpoch": 0, "args": {
                "method": "GET", "url": "http://example.com/", "headers": [], "redirect": "manual",
                "timeoutMs": 3000, "allowHosts": ["example.org"] }});
            ws.send(Message::Text(slow.to_string())).await.unwrap();
            ws.send(Message::Text(fast.to_string())).await.unwrap();
            let first = ws.next().await.unwrap().unwrap();
            serde_json::from_str::<Value>(first.to_text().unwrap()).unwrap()
        });
        let session = device_session(&format!("ws://{addr}/api/host"));
        let mut backend = Backend::default();
        let first = tokio::select! {
            _ = run_session(&session, &mut backend, None) => panic!("session ended early"),
            v = server => v.unwrap(),
            _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("快的请求被慢的挡住了"),
        };
        assert_eq!(first["id"], 2);
        assert_eq!(first["code"], "host-not-allowed");
    }
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml tests::`
Expected: 编译失败（没有 `Session`）。

- [ ] **Step 4: 实现**

4a. 在 `main.rs` 里 `OverlayHandleLike` 那组定义之后加：

```rust
/// `http.fetch` 的执行者。Linux 上是真的（`httpfetch.rs`）；其余平台没有设备模式，用一个**不可构造**
/// 的类型占位——和 `OverlayHandleLike` 同一个做法，`Session` 与 `run_session` 的签名因此不用套 `#[cfg]`。
#[cfg(target_os = "linux")]
type FetcherLike = httpfetch::Fetcher;
#[cfg(not(target_os = "linux"))]
pub enum FetcherLike {}
#[cfg(not(target_os = "linux"))]
impl FetcherLike {
    pub async fn reply(&self, _id: Value, _args: &Value) -> Value {
        match *self {}
    }
}

/// 一条会话要的全部输入。本机模式与设备模式只在这几个值上不同——WS 客户端、`host-relay.v2`
/// 协议、监督循环是同一份（spec linux-device-agent：复用现有的协议与 WS 客户端实现）。
pub struct Session {
    pub url: String,
    pub token: String,
    /// 首帧。本机模式是 `relay::local_hello()`，设备模式是 `device::device_hello(..)`。
    pub hello: Value,
    /// 设备模式才有：`http.fetch` 交给它并发执行。缺席时这个 op 和其他没声明的 op 一样落进 dispatch 报错。
    pub fetcher: Option<std::sync::Arc<FetcherLike>>,
    /// token 是配对得来的 device token：握手 401 / 关闭码 4003 = 已被撤销，不是"后端还没起完"。
    pub paired: bool,
}
```

4b. 把 `supervise` 整个换成：

```rust
/// 监督循环：连 → 跑会话 → 退避 → 再连。**只有一个出口：设备被撤销**（返回原因，交给设备模式
/// 重新配对）；本机模式的会话不会以撤销结束，于是对它而言这仍是一个永不返回的循环。
///
/// 这个函数存在的全部理由，是让 agent 的寿命不再等于一条 WebSocket 的寿命。进程只有两条
/// 出路：父进程（持有它的那个 DSH 引擎进程）没了（stdin EOF，见 `main`），或者被杀。中继断了从来不是其中之一
/// ——后端 restart 是开发期的日常，agent 得自己熬过去。退避语义见 `relay.rs`。
async fn supervise<D: protocol::Desktop>(
    session: &Session,
    backend: &mut D,
    supervisor: &mut Supervisor,
    overlay: Option<&OverlayHandleLike>,
) -> String {
    loop {
        let end = run_session(session, backend, overlay).await;
        if let SessionEnd::Revoked(why) = &end {
            return why.clone();
        }
        let delay = supervisor.after(&end);
        eprintln!(
            "[host-agent] {} — reconnecting in {:.1}s (attempt #{})",
            end.reason(),
            delay.as_secs_f32(),
            supervisor.scheduled(),
        );
        tokio::time::sleep(delay).await;
    }
}
```

4c. `run_session`：签名改成 `async fn run_session<D: protocol::Desktop>(session: &Session, backend: &mut D, overlay: Option<&OverlayHandleLike>) -> SessionEnd`，函数体按下面逐处改（其余行不动）：

- `url.into_client_request()` → `session.url.as_str().into_client_request()`；`format!("{PROTOCOL}, {token}")` → `format!("{PROTOCOL}, {}", session.token)`。
- `connect_async` 的 match 在现有 401/403 那一臂**之前**插入：

```rust
        // device token 的 401 是确定的撤销（后端内部故障回 503，见 host-relay.ts 的 attachHostRelay），
        // 不是共享 token 那种"后端重启途中还没挂上中继"——拿同一个 token 再试也还是 401。
        Err(WsError::Http(resp)) if session.paired && resp.status().as_u16() == 401 => {
            return SessionEnd::Revoked(format!("HTTP {}", resp.status()));
        }
```

- hello 那一行：`relay::local_hello().to_string()` → `session.hello.to_string()`。
- 在 `let mut policy = …` 之前加：

```rust
    // http.fetch 不在这条循环里执行：一个慢请求（跨洋、对端卡住）会把后面所有帧都堵到它超时为止，
    // 而后端给每台设备开了 4 个在途名额（host-relay.ts 的 DEVICE_FETCH_CONCURRENCY），本来就期待并发。
    // 每个请求一个任务，回复经 channel 交回这里写 socket——写端只有这一个所有者。
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let mut fetches = tokio::task::JoinSet::new();
    let mut end = SessionEnd::Disconnected;
```

- `tokio::select!` 里、`m = rx.next()` 那一臂之后加一臂：

```rust
            Some(line) = out_rx.recv() => {
                if tx.send(Message::Text(line)).await.is_err() {
                    break;
                }
                continue;
            }
```

- `let text = match msg {` 里，`Ok(Message::Close(_)) | Err(_) => break,` 之前加：

```rust
            // 4003 = 主实例撤销了这台设备（或 token 与 hello 对不上），见 host-relay.ts。
            Ok(Message::Close(Some(f))) if session.paired && u16::from(f.code) == 4003 => {
                end = SessionEnd::Revoked(format!("closed 4003: {}", f.reason));
                break;
            }
```

- 在 `if op == "status" {` 之前加：

```rust
        if op == "http.fetch" {
            if let Some(f) = &session.fetcher {
                let (f, out) = (f.clone(), out_tx.clone());
                fetches.spawn(async move {
                    let _ = out.send(f.reply(id, &args).await.to_string());
                });
                // 完成了的任务的结果会一直攒在 JoinSet 里；每来一个新请求顺手收掉。
                while fetches.try_join_next().is_some() {}
                continue;
            }
        }
```

- 循环之后、熄灭指示条那段之前加：

```rust
    // 断开时还在跑的请求一律放弃：后端已经把它们判成 device-lost（状态未知、不重试），
    // 结果写不回一条已经不在的连接。
    fetches.abort_all();
```

- 函数末尾 `SessionEnd::Disconnected` → `end`。

4d. `main()` 里两处调用改成先建 `Session`。macOS 线程里：

```rust
        std::thread::spawn(move || {
            // 后端（AX 句柄）不是 Send，在这条线程里建。
            let mut backend = Backend::default();
            let mut supervisor = Supervisor::default();
            let session = Session { url, token, hello: relay::local_hello(), fetcher: None, paired: false };
            let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
            let _ = rt.block_on(supervise(&session, &mut backend, &mut supervisor, Some(&handle)));
        });
```

（闭包之前那两行 `let url = url.clone(); let token = token.clone();` 原样保留——闭包 move 的就是这两份。）

其余平台：

```rust
    #[cfg(not(target_os = "macos"))]
    {
        let mut backend = Backend::default();
        let mut supervisor = Supervisor::default();
        let session = Session { url, token, hello: relay::local_hello(), fetcher: None, paired: false };
        // 本机会话不以撤销结束（paired=false），这一行实际走不到；真走到了就如实退出，别装作还在跑。
        let why = supervise(&session, &mut backend, &mut supervisor, overlay_handle.as_ref()).await;
        eprintln!("[host-agent] {why}");
        std::process::exit(1);
    }
```

- [ ] **Step 5: 测试转绿**

Run: `cargo test --manifest-path app/host-agent/Cargo.toml`
Expected: 全部 PASS（含原有四个会话测试与新增五个）。再跑 `cargo build --manifest-path app/host-agent/Cargo.toml`，无新增警告以外的问题。

- [ ] **Step 6: 提交**

```bash
git add app/host-agent/src/relay.rs app/host-agent/src/main.rs
git commit -m "feat(host-agent): sessions take a Session; http.fetch runs concurrently; revoke ends supervision"
```

---

### Task 4: 设备模式——配对、状态、入口

**Files:**
- Create: `app/host-agent/src/device.rs`
- Modify: `app/host-agent/src/main.rs`

**Interfaces:**
- Consumes: `netguard::parse_allow_hosts`、`httpfetch::{Fetcher, Guard}`、`relay::{hello_frame, Supervisor, SessionEnd}`、`Session` / `supervise`（Task 1–3）
- Produces（`device.rs`）：
  - `pub struct DeviceEnv { pub backend: Url, pub pairing_code: Option<String>, pub state_dir: PathBuf, pub name: String, pub allow_hosts: Option<Vec<String>> }`
  - `DeviceEnv::from_lookup(get: &dyn Fn(&str) -> Option<String>, hostname: Option<String>) -> Result<Option<DeviceEnv>, String>`；`DeviceEnv::from_process() -> Result<Option<DeviceEnv>, String>`
  - `pub struct Pairing { pub device_id: String, pub device_token: String }`（serde camelCase）
  - `pub fn ensure_state_dir(dir: &Path) -> Result<(), String>`、`load_pairing(dir) -> Result<Option<Pairing>, String>`、`save_pairing(dir, &Pairing) -> Result<(), String>`、`forget_pairing(dir) -> Result<(), String>`
  - `pub enum Startup { Saved(Pairing), Pair(String), NoCode }`；`pub fn startup(saved: Option<Pairing>, code: Option<&str>) -> Startup`
  - `pub enum PairError { Rejected(String), Unreachable(String) }`；`pub enum PairNext { Park, Retry }`；`pub fn after_pair_failure(e: &PairError) -> PairNext`
  - `pub fn control_client() -> reqwest::Client`；`pub async fn pair(client, backend: &Url, code: &str, name: &str) -> Result<Pairing, PairError>`
  - `pub async fn obtain_pairing(env: &DeviceEnv, code: &str) -> Pairing`；`pub async fn park(why: &str) -> std::convert::Infallible`
  - `pub fn ws_url(backend: &Url) -> String`；`pub fn device_hello(device_id: &str, name: &str) -> Value`；`pub const DEVICE_OPS: &[&str] = &["http.fetch"]`
- Produces（`main.rs`）：`#[cfg(target_os = "linux")] async fn run_device_mode(env: device::DeviceEnv)`

- [ ] **Step 1: 写失败的测试**

Create `app/host-agent/src/device.rs`：先放下面的类型与函数签名（体为 `todo!()`），测试模块写全。

```rust
//! 设备模式：这台 Linux 机器（NAS）不是主实例，而是主实例的一个执行位置。
//!
//! `STREAM_BACKEND_URL` 在场就进入这个模式：首次启动用 `STREAM_PAIRING_CODE` 配对，device token
//! 存进状态目录，之后每次启动都用它直接连——配对码只用一次。被主实例撤销后作废保存的配对，
//! 再用环境变量里的码配（通常它早已用过，于是挂起等用户换新码）。
//! 权威：openspec/changes/device-execution/specs/linux-device-agent/spec.md、design.md D8。

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::netguard;
use crate::relay::{self, SessionEnd, Supervisor};

/// 设备模式声明的全部 op。浏览器通道（`browser`）是计划 3 的事；这里只声明真的能做的。
pub const DEVICE_OPS: &[&str] = &["http.fetch"];
const PAIRING_FILE: &str = "device.json";
const REVOKED_FILE: &str = "device.json.revoked";

#[derive(Debug, Clone)]
pub struct DeviceEnv {
    pub backend: Url,
    pub pairing_code: Option<String>,
    pub state_dir: PathBuf,
    pub name: String,
    pub allow_hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub device_id: String,
    pub device_token: String,
}

#[derive(Debug, PartialEq)]
pub enum Startup {
    Saved(Pairing),
    Pair(String),
    NoCode,
}

#[derive(Debug, PartialEq)]
pub enum PairError {
    /// 主实例明确拒了（码不对、过期、老后端不认 linux）。同一个码再试只会继续被拒。
    Rejected(String),
    /// 没连上 / 5xx。主实例可能还没起来，退避重试。
    Unreachable(String),
}

#[derive(Debug, PartialEq)]
pub enum PairNext {
    Park,
    Retry,
}

impl DeviceEnv {
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>, hostname: Option<String>) -> Result<Option<DeviceEnv>, String> { todo!() }
    pub fn from_process() -> Result<Option<DeviceEnv>, String> { todo!() }
}

pub fn ensure_state_dir(dir: &Path) -> Result<(), String> { todo!() }
pub fn load_pairing(dir: &Path) -> Result<Option<Pairing>, String> { todo!() }
pub fn save_pairing(dir: &Path, p: &Pairing) -> Result<(), String> { todo!() }
pub fn forget_pairing(dir: &Path) -> Result<(), String> { todo!() }
pub fn startup(saved: Option<Pairing>, code: Option<&str>) -> Startup { todo!() }
pub fn after_pair_failure(e: &PairError) -> PairNext { todo!() }
pub fn control_client() -> reqwest::Client { todo!() }
pub async fn pair(client: &reqwest::Client, backend: &Url, code: &str, name: &str) -> Result<Pairing, PairError> { todo!() }
pub async fn obtain_pairing(env: &DeviceEnv, code: &str) -> Pairing { todo!() }
pub async fn park(why: &str) -> Infallible { todo!() }
pub fn ws_url(backend: &Url) -> String { todo!() }
pub fn device_hello(device_id: &str, name: &str) -> Value { todo!() }

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stream-agent-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn sample() -> Pairing {
        Pairing { device_id: "linux:0b7c".into(), device_token: "tok".into() }
    }

    #[test]
    fn no_backend_url_means_not_device_mode() {
        assert!(DeviceEnv::from_lookup(&env_of(&[]), None).unwrap().is_none());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "  ")]), None).unwrap().is_none());
    }

    #[test]
    fn the_env_is_read_with_its_defaults() {
        let e = DeviceEnv::from_lookup(
            &env_of(&[("STREAM_BACKEND_URL", "http://100.101.102.103:8900"), ("STREAM_PAIRING_CODE", " 123456 "), ("HOME", "/home/nas")]),
            Some("DS920".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.backend.as_str(), "http://100.101.102.103:8900/");
        assert_eq!(e.pairing_code.as_deref(), Some("123456"));
        assert_eq!(e.state_dir, PathBuf::from("/home/nas/.local/share/stream-agent"));
        assert_eq!(e.name, "DS920");
        assert_eq!(e.allow_hosts, None);
    }

    #[test]
    fn explicit_settings_win_over_defaults() {
        let e = DeviceEnv::from_lookup(
            &env_of(&[
                ("STREAM_BACKEND_URL", "https://stream.example.com/base/"),
                ("STREAM_AGENT_DATA", "/data"),
                ("XDG_DATA_HOME", "/xdg"),
                ("STREAM_DEVICE_NAME", " 家里的 NAS "),
                ("ALLOW_HOSTS", "eastmoneysec.com, eastmoney.com"),
                ("STREAM_PAIRING_CODE", ""),
            ]),
            Some("ignored".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.state_dir, PathBuf::from("/data"));
        assert_eq!(e.name, "家里的 NAS");
        assert_eq!(e.pairing_code, None, "空配对码 = 没给");
        assert_eq!(e.allow_hosts, Some(vec!["eastmoneysec.com".to_string(), "eastmoney.com".to_string()]));
        let xdg = DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "http://h:1"), ("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/x")]), None).unwrap().unwrap();
        assert_eq!(xdg.state_dir, PathBuf::from("/xdg/stream-agent"));
        assert_eq!(xdg.name, "Linux");
    }

    #[test]
    fn a_bad_backend_url_or_no_state_dir_is_a_startup_error() {
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "not a url")]), None).is_err());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "ftp://h/"), ("HOME", "/h")]), None).is_err());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "http://h:1")]), None).is_err(), "没有任何状态目录可用");
    }

    #[test]
    fn the_relay_url_follows_the_backend_scheme_and_base_path() {
        let u = |s: &str| ws_url(&Url::parse(s).unwrap());
        assert_eq!(u("http://100.64.1.2:8900"), "ws://100.64.1.2:8900/api/host");
        assert_eq!(u("https://stream.example.com/"), "wss://stream.example.com/api/host");
        assert_eq!(u("https://example.com/stream/?x=1#f"), "wss://example.com/stream/api/host");
    }

    #[test]
    fn the_hello_declares_linux_and_only_http_fetch() {
        let h = device_hello("linux:0b7c", "nas");
        assert_eq!(h["type"], "hello");
        assert_eq!(h["deviceId"], "linux:0b7c");
        assert_eq!(h["platform"], "linux");
        assert_eq!(h["name"], "nas");
        assert_eq!(h["ops"], json!(["http.fetch"]));
        assert_eq!(h["agentVersion"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn a_saved_pairing_round_trips_and_is_private() {
        let d = fresh_dir("roundtrip");
        ensure_state_dir(&d).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), None);
        save_pairing(&d, &sample()).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), Some(sample()));
        let mode = std::fs::metadata(d.join("device.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "device token 只给本用户读");
        let text = std::fs::read_to_string(d.join("device.json")).unwrap();
        assert!(text.contains("\"deviceId\"") && text.contains("\"deviceToken\""));
    }

    /// 坏文件不能被当成"没配过"：那会拿环境变量里的码再配一台新设备，留下一条孤儿记录。
    #[test]
    fn a_corrupt_or_foreign_pairing_file_is_an_error_not_a_reset() {
        let d = fresh_dir("corrupt");
        ensure_state_dir(&d).unwrap();
        std::fs::write(d.join("device.json"), "{not json").unwrap();
        assert!(load_pairing(&d).is_err());
        std::fs::write(d.join("device.json"), r#"{"deviceId":"android:1","deviceToken":"t"}"#).unwrap();
        assert!(load_pairing(&d).is_err());
    }

    #[test]
    fn forgetting_moves_the_pairing_aside() {
        let d = fresh_dir("forget");
        ensure_state_dir(&d).unwrap();
        save_pairing(&d, &sample()).unwrap();
        forget_pairing(&d).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), None);
        assert!(d.join("device.json.revoked").exists(), "留一份供排错");
    }

    #[test]
    fn an_unwritable_state_dir_fails_before_any_code_is_spent() {
        let d = fresh_dir("readonly");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = ensure_state_dir(&d);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        // root 跑测试时权限不生效，这条断言只在非 root 下有意义。
        if !is_root() {
            assert!(r.is_err());
        }
    }

    fn is_root() -> bool {
        std::fs::read_to_string("/proc/self/status")
            .map(|s| s.lines().any(|l| l.starts_with("Uid:") && l.split_whitespace().nth(1) == Some("0")))
            .unwrap_or(false)
    }

    /// spec「容器重启不需要重新配对」：保存的配对在，就不碰（多半已过期的）配对码。
    #[test]
    fn a_saved_pairing_wins_over_the_code_in_the_env() {
        assert_eq!(startup(Some(sample()), Some("999999")), Startup::Saved(sample()));
        assert_eq!(startup(None, Some("123456")), Startup::Pair("123456".into()));
        assert_eq!(startup(None, None), Startup::NoCode);
    }

    /// Review Focus 4：被拒的码不再试（重启循环会烧掉用户刚生成的新码），连不上才重试。
    #[test]
    fn a_rejected_code_parks_and_an_unreachable_backend_retries() {
        assert_eq!(after_pair_failure(&PairError::Rejected("配对码不对".into())), PairNext::Park);
        assert_eq!(after_pair_failure(&PairError::Unreachable("refused".into())), PairNext::Retry);
    }

    /// 只回一次固定响应的 HTTP 端，记下请求原文。
    async fn one_shot(status: &str, body: &str) -> (Url, Arc<Mutex<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        tokio::spawn(async move {
            let Ok((mut s, _)) = l.accept().await else { return };
            let mut buf = vec![0u8; 8192];
            let mut got = Vec::new();
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 { break; }
                got.extend_from_slice(&buf[..n]);
                if let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&got[..end]).to_lowercase();
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if got.len() >= end + 4 + len { break; }
                }
            }
            *s2.lock().unwrap() = String::from_utf8_lossy(&got).into_owned();
            let _ = s.write_all(resp.as_bytes()).await;
        });
        (Url::parse(&format!("http://{addr}")).unwrap(), seen)
    }

    #[tokio::test]
    async fn pairing_posts_the_code_with_the_linux_platform() {
        let (base, seen) = one_shot("200 OK", r#"{"deviceId":"linux:0b7c","deviceToken":"tok"}"#).await;
        let p = pair(&control_client(), &base, "123456", "nas").await.unwrap();
        assert_eq!(p, sample());
        let req = seen.lock().unwrap().clone();
        assert!(req.starts_with("POST /api/devices/pair "), "{req}");
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({"code": "123456", "name": "nas", "platform": "linux"}));
    }

    #[tokio::test]
    async fn a_403_is_a_rejection_carrying_the_backend_reason() {
        let (base, _) = one_shot("403 Forbidden", r#"{"error":"配对码无效或已过期"}"#).await;
        assert_eq!(pair(&control_client(), &base, "000000", "nas").await, Err(PairError::Rejected("配对码无效或已过期".into())));
    }

    /// 老后端忽略 platform、发回 android 的 id：拿着它连上来会被以 4003 关掉，不如在这里就说清。
    #[tokio::test]
    async fn a_non_linux_device_id_is_a_rejection() {
        let (base, _) = one_shot("200 OK", r#"{"deviceId":"android:0b7c","deviceToken":"tok"}"#).await;
        assert!(matches!(pair(&control_client(), &base, "123456", "nas").await, Err(PairError::Rejected(_))));
    }

    #[tokio::test]
    async fn a_5xx_or_no_answer_is_unreachable() {
        let (base, _) = one_shot("503 Service Unavailable", "{}").await;
        assert!(matches!(pair(&control_client(), &base, "1", "n").await, Err(PairError::Unreachable(_))));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = Url::parse(&format!("http://{}", l.local_addr().unwrap())).unwrap();
        drop(l);
        assert!(matches!(pair(&control_client(), &dead, "1", "n").await, Err(PairError::Unreachable(_))));
    }
}
```

在 `main.rs` 的 `mod` 列表里（`mod datadir;` 之后）加：

```rust
#[cfg(target_os = "linux")]
mod device;
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml device::`
Expected: FAIL（`not yet implemented`）。

- [ ] **Step 2: 实现 `device.rs`**

把各 `todo!()` 换成：

```rust
impl DeviceEnv {
    /// 读设备模式的配置。`Ok(None)` = 不是设备模式（没有 `STREAM_BACKEND_URL`）；`Err` = 是设备模式
    /// 但配置不能用——启动即判死，因为它不会自己变好。
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>, hostname: Option<String>) -> Result<Option<DeviceEnv>, String> {
        let val = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let Some(raw) = val("STREAM_BACKEND_URL") else { return Ok(None) };
        let backend = Url::parse(&raw).map_err(|e| format!("STREAM_BACKEND_URL 不是合法地址（{raw}）：{e}"))?;
        if backend.scheme() != "http" && backend.scheme() != "https" {
            return Err(format!("STREAM_BACKEND_URL 只能是 http:// 或 https://（{raw}）"));
        }
        let state_dir = val("STREAM_AGENT_DATA")
            .map(PathBuf::from)
            .or_else(|| val("XDG_DATA_HOME").map(|x| PathBuf::from(x).join("stream-agent")))
            .or_else(|| val("HOME").map(|h| PathBuf::from(h).join(".local/share/stream-agent")))
            .ok_or("没有可用的状态目录：设 STREAM_AGENT_DATA（容器里指向挂载的数据卷）")?;
        let name = val("STREAM_DEVICE_NAME")
            .or_else(|| hostname.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()))
            .unwrap_or_else(|| "Linux".to_string());
        Ok(Some(DeviceEnv {
            backend,
            pairing_code: val("STREAM_PAIRING_CODE"),
            state_dir,
            name,
            allow_hosts: netguard::parse_allow_hosts(get("ALLOW_HOSTS").as_deref()),
        }))
    }

    pub fn from_process() -> Result<Option<DeviceEnv>, String> {
        DeviceEnv::from_lookup(&|k: &str| std::env::var(k).ok(), sysinfo::System::host_name())
    }
}

/// 建状态目录并确认写得进去。**在花掉配对码之前做**：码是一次性的，配对成功后才发现 token
/// 存不下，主实例那边已经多了一台再也连不上的设备。
pub fn ensure_state_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了状态目录 {}：{e}", dir.display()))?;
    let probe = dir.join(".write-probe");
    std::fs::write(&probe, b"").map_err(|e| format!("状态目录 {} 写不进去：{e}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

pub fn load_pairing(dir: &Path) -> Result<Option<Pairing>, String> {
    let path = dir.join(PAIRING_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不了 {}：{e}", path.display())),
    };
    let p: Pairing = serde_json::from_str(&text)
        .map_err(|e| format!("{} 坏了（{e}）——确认这台设备已在主实例撤销后删掉它，再用新配对码启动", path.display()))?;
    if !p.device_id.starts_with("linux:") || p.device_token.is_empty() {
        return Err(format!("{} 里不是一份 linux 设备的配对", path.display()));
    }
    Ok(Some(p))
}

/// 写临时文件再改名：断电只会留下旧文件或新文件，不会留下半个 token。
pub fn save_pairing(dir: &Path, p: &Pairing) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!("{PAIRING_FILE}.tmp"));
    let body = serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    f.write_all(&body).and_then(|_| f.sync_all()).map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(PAIRING_FILE)).map_err(|e| format!("保存配对失败：{e}"))
}

/// 撤销之后：挪开而不是删掉，排错时还看得到当初是哪台设备。
pub fn forget_pairing(dir: &Path) -> Result<(), String> {
    std::fs::rename(dir.join(PAIRING_FILE), dir.join(REVOKED_FILE)).map_err(|e| format!("作废保存的配对失败：{e}"))
}

pub fn startup(saved: Option<Pairing>, code: Option<&str>) -> Startup {
    match (saved, code) {
        (Some(p), _) => Startup::Saved(p),
        (None, Some(c)) => Startup::Pair(c.to_string()),
        (None, None) => Startup::NoCode,
    }
}

/// 被拒的码不重试：容器 `restart: always` 下每次启动都拿旧码去配，主实例在连续失败后会作废
/// **当前**有效的那个码——用户刚生成、还没来得及填进环境变量的新码就这样被烧掉了。
pub fn after_pair_failure(e: &PairError) -> PairNext {
    match e {
        PairError::Rejected(_) => PairNext::Park,
        PairError::Unreachable(_) => PairNext::Retry,
    }
}

/// 控制面（配对）的 HTTP 客户端。和 `http.fetch` 不同，它**要**能连私网——主实例多半就在
/// Tailscale（100.64/10）或局域网上；代理照样不走，与 WS 那条路一致。
pub fn control_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("http client")
}

fn api_url(backend: &Url, path: &str) -> Url {
    let mut u = backend.clone();
    let base = u.path().trim_end_matches('/').to_string();
    u.set_path(&format!("{base}{path}"));
    u.set_query(None);
    u.set_fragment(None);
    u
}

pub fn ws_url(backend: &Url) -> String {
    let mut u = api_url(backend, "/api/host");
    let scheme = if backend.scheme() == "https" { "wss" } else { "ws" };
    u.set_scheme(scheme).expect("http(s) → ws(s) 总是允许");
    u.to_string()
}

pub async fn pair(client: &reqwest::Client, backend: &Url, code: &str, name: &str) -> Result<Pairing, PairError> {
    let resp = client
        .post(api_url(backend, "/api/devices/pair"))
        .json(&json!({ "code": code, "name": name, "platform": "linux" }))
        .send()
        .await
        .map_err(|e| PairError::Unreachable(e.to_string()))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return match (body["deviceId"].as_str(), body["deviceToken"].as_str()) {
            (Some(id), Some(token)) if id.starts_with("linux:") && !token.is_empty() => {
                Ok(Pairing { device_id: id.to_string(), device_token: token.to_string() })
            }
            _ => Err(PairError::Rejected(format!("主实例的配对回复不是一台 linux 设备（主实例太旧？）：{body}"))),
        };
    }
    if status.is_client_error() {
        return Err(PairError::Rejected(body["error"].as_str().map(str::to_string).unwrap_or_else(|| status.to_string())));
    }
    Err(PairError::Unreachable(format!("HTTP {status}")))
}

/// 用配对码换 device token 并存下。连不上就退避重试；被拒就挂起——见 [`after_pair_failure`]。
pub async fn obtain_pairing(env: &DeviceEnv, code: &str) -> Pairing {
    let client = control_client();
    let mut backoff = Supervisor::default();
    loop {
        let err = match pair(&client, &env.backend, code, &env.name).await {
            Ok(p) => {
                if let Err(e) = save_pairing(&env.state_dir, &p) {
                    eprintln!("[device] 配对成功但存不下 token（{e}）——在主实例上撤销 {} 后修好状态目录再重配", p.device_id);
                    std::process::exit(2);
                }
                eprintln!("[device] 配对成功：{}", p.device_id);
                return p;
            }
            Err(e) => e,
        };
        let why = match &err {
            PairError::Rejected(w) | PairError::Unreachable(w) => w.clone(),
        };
        match after_pair_failure(&err) {
            PairNext::Park => {
                match park(&format!("配对码被主实例拒绝（{why}）——同一个码不再重试；在主实例上生成新码、设进 STREAM_PAIRING_CODE 后重启")).await {}
            }
            PairNext::Retry => {
                let d = backoff.after(&SessionEnd::ConnectFailed(why.clone()));
                eprintln!("[device] 连不上主实例配对（{why}）——{:.1}s 后重试", d.as_secs_f32());
                tokio::time::sleep(d).await;
            }
        }
    }
}

/// 停在这里等人：进程不退（退了容器会被拉起来再试一遍同一个码），每小时重打一行，看日志的人总能看到。
pub async fn park(why: &str) -> Infallible {
    loop {
        eprintln!("[device] {why}");
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

pub fn device_hello(device_id: &str, name: &str) -> Value {
    relay::hello_frame(device_id, "linux", name, env!("CARGO_PKG_VERSION"), DEVICE_OPS)
}
```

Run: `cargo test --manifest-path app/host-agent/Cargo.toml device::`
Expected: 16 个测试 PASS。

- [ ] **Step 3: 接入 `main.rs`**

3a. `main()` 里，`--unregister` 分支之后、`verify` 分支之前插入：

```rust
    // 设备模式：这台机器是主实例的一个执行位置（NAS），不是本机工作台。只认 STREAM_BACKEND_URL
    // 这一个开关——本机模式什么都不用设，设备模式至少要知道主实例在哪。
    #[cfg(target_os = "linux")]
    match device::DeviceEnv::from_process() {
        Ok(Some(env)) => {
            run_device_mode(env).await;
            return;
        }
        Ok(None) => {}
        Err(e) => {
            eprintln!("[device] {e}");
            std::process::exit(2);
        }
    }
    #[cfg(not(target_os = "linux"))]
    if std::env::var_os("STREAM_BACKEND_URL").is_some() {
        eprintln!("[device] 设备模式（STREAM_BACKEND_URL）目前只有 Linux 构建");
        std::process::exit(2);
    }
```

3b. 在 `supervise` 之前加：

```rust
/// 设备模式的一生：拿到配对 → 监督循环 → 被撤销就作废配对、回到第一步。不返回。
///
/// 每一步的失败去向：配置 / 状态目录坏了 → 退出码 2（不会自己变好）；没有码或码被拒 → 挂起等人
/// （`device::park`）；主实例连不上 → 监督循环里退避重试。
#[cfg(target_os = "linux")]
async fn run_device_mode(env: device::DeviceEnv) {
    if let Err(e) = device::ensure_state_dir(&env.state_dir) {
        eprintln!("[device] {e}");
        std::process::exit(2);
    }
    let fetcher = match httpfetch::Fetcher::new(httpfetch::Guard::strict(), env.allow_hosts.clone()) {
        Ok(f) => std::sync::Arc::new(f),
        Err(e) => {
            eprintln!("[device] {e}");
            std::process::exit(2);
        }
    };
    if let Some(list) = &env.allow_hosts {
        eprintln!("[device] ALLOW_HOSTS 生效，只放行：{}", list.join(", "));
    }
    let ws = device::ws_url(&env.backend);
    loop {
        let saved = match device::load_pairing(&env.state_dir) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[device] {e}");
                std::process::exit(2);
            }
        };
        let pairing = match device::startup(saved, env.pairing_code.as_deref()) {
            device::Startup::Saved(p) => p,
            device::Startup::Pair(code) => device::obtain_pairing(&env, &code).await,
            device::Startup::NoCode => {
                match device::park("还没配对，也没有 STREAM_PAIRING_CODE——在主实例上生成配对码，设进环境变量后重启").await {}
            }
        };
        eprintln!("[device] {}（{}）→ {ws}", pairing.device_id, env.name);
        let session = Session {
            url: ws.clone(),
            token: pairing.device_token.clone(),
            hello: device::device_hello(&pairing.device_id, &env.name),
            fetcher: Some(fetcher.clone()),
            paired: true,
        };
        let mut backend = Backend::default();
        let why = supervise(&session, &mut backend, &mut Supervisor::default(), None).await;
        eprintln!("[device] {}", SessionEnd::Revoked(why).reason());
        if let Err(e) = device::forget_pairing(&env.state_dir) {
            eprintln!("[device] {e}");
            std::process::exit(2);
        }
    }
}
```

（`Backend` 在 Linux 上就是 `NotSupported`：设备模式不声明任何 a11y op，后端不会派来。）

- [ ] **Step 4: 全量测试与构建**

Run: `cargo test --manifest-path app/host-agent/Cargo.toml` 然后 `cargo build --release --manifest-path app/host-agent/Cargo.toml`
Expected: 全部 PASS；`app/host-agent/target/release/stream-desktop` 生成。

- [ ] **Step 5: 没有配置时的行为（手动）**

Run: `STREAM_BACKEND_URL=ftp://x app/host-agent/target/release/stream-desktop; echo exit=$?`
Expected: 打出「只能是 http:// 或 https://」，`exit=2`。

Run: `STREAM_BACKEND_URL=http://127.0.0.1:1 STREAM_AGENT_DATA=/tmp/stream-agent-nocode timeout 3 app/host-agent/target/release/stream-desktop; echo exit=$?`
Expected: 打出「还没配对，也没有 STREAM_PAIRING_CODE」一行后被 `timeout` 结束（`exit=124`）——挂起，不退出。

- [ ] **Step 6: 提交**

```bash
git add app/host-agent/src/device.rs app/host-agent/src/main.rs
git commit -m "feat(host-agent): Linux device mode — unattended pairing, saved token, re-pair after revoke"
```

---

### Task 5: CI、文档、实机冒烟

**Files:**
- Modify: `.github/workflows/test.yml`、`app/host-agent/README.md`、`openspec/changes/device-execution/tasks.md`

- [ ] **Step 1: CI job**

在 `.github/workflows/test.yml` 的 `jobs:` 下、`hosts:` 之前加：

```yaml
  # Rust host agent 的平台无关部分（协议、重连、设备模式的 http.fetch 与配对）都能在 Linux 上测；
  # 设备模式本身就是 Linux 构建，这里是它唯一的 CI 闸门。
  host-agent:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo test --manifest-path app/host-agent/Cargo.toml
```

若 Task 0 基线记下了依赖外部资产（模型文件等）、且不会自己跳过的失败用例：给 `cargo test` 加 `-- --skip <用例名>` 逐个跳过，并在这段注释里写明为什么跳（不许整模块跳过）。

- [ ] **Step 2: README**

在 `app/host-agent/README.md` 的「## Run」一节之后加一节（逐字）：

````markdown
## 设备模式（Linux）

同一个二进制在 Linux 上还能当**主实例的执行位置**用（NAS、另一台常开的机器）：它不连本机后端，而是连
`STREAM_BACKEND_URL` 指向的主实例，替主实例发 HTTP 请求（`http.fetch`）。绑定到这台设备的任务，出站
请求全部从这里发出。设计：`openspec/changes/device-execution/`。

```bash
# 首次：在主实例那台机器上生成配对码（只对本机请求签发）
curl -sS -X POST http://127.0.0.1:8900/api/devices/pairing-code

# 在设备上
STREAM_BACKEND_URL=http://100.101.102.103:8900 \
STREAM_PAIRING_CODE=123456 \
STREAM_DEVICE_NAME=家里的NAS \
./stream-desktop
```

| 变量 | 作用 |
|---|---|
| `STREAM_BACKEND_URL` | 主实例的 http(s) 地址。**设了它就是设备模式。** 用 IP 地址（Tailscale / 局域网）最省事：用主机名时主实例要把它登记为可信主机，否则配对请求会被 Host 检查拒掉。 |
| `STREAM_PAIRING_CODE` | 一次性配对码，只在还没配对时用。配对成功后 token 存进状态目录，之后的启动不再需要它（留着过期的码也没关系）。 |
| `STREAM_AGENT_DATA` | 状态目录，缺省 `$XDG_DATA_HOME/stream-agent` 或 `~/.local/share/stream-agent`。容器里指向挂载的数据卷，否则每次重建容器都要重新配对。 |
| `STREAM_DEVICE_NAME` | 设备列表里显示的名字，缺省主机名。 |
| `ALLOW_HOSTS` | 逗号分隔的主机名后缀。设了它，这台设备**只**替主实例访问这些主机，主实例下发的清单不再算数——给不完全信任主实例的人用。 |

几件不能配置的事：

- **私网目标一律拒绝**：目标解析到 loopback、局域网、链路本地、CGNAT（含 Tailscale 的 100.64/10）、ULA
  时以 `private-target` 拒绝，跟随重定向时每一跳都查。设备不会被当成进入你内网的跳板。
- **不走系统代理**：`HTTP_PROXY` / `HTTPS_PROXY` 对设备请求无效。
- **日志不含内容**：每个请求只记 `方法 主机 → 状态码 (耗时)`，没有 header、body、路径和查询串。

配对状态在 `<状态目录>/device.json`（0600）。在主实例上撤销这台设备后，agent 会把它改名为
`device.json.revoked`，然后用 `STREAM_PAIRING_CODE` 重新配对；那个码若已用过，agent 停在原地每小时提示一次
——**被拒的码不会重试**（重试会让主实例作废你刚生成的新码），换一个新码再重启即可。
````

- [ ] **Step 3: openspec 勾选清单**

把 `openspec/changes/device-execution/tasks.md` 里的

```markdown
## 计划 2：Linux 无界面 agent

- [ ] 待写（`http.fetch` 的设备侧实现、主机校验与私网拒绝、配对启动）
```

换成：

```markdown
## 计划 2：Linux 无界面 agent（device-execution-linux-agent）

- [x] 1. 设备侧主机后缀匹配、`ALLOW_HOSTS`、私网地址判定（`netguard.rs`）
- [x] 2. `http.fetch` 设备侧实现：逐跳主机与私网检查、10MB 上限、超时、不走代理（`httpfetch.rs`）
- [x] 3. 会话复用同一份 WS 客户端与协议；`http.fetch` 并发执行；撤销结束监督循环
- [x] 4. 设备模式：无人值守配对、device token 持久化、撤销后重配、被拒的码不重试（`device.rs`）
- [x] 5. CI 跑 `cargo test`；README 设备模式一节
```

- [ ] **Step 4: 实机冒烟（真后端 + 真 agent）**

照 `docs/DEVELOPMENT.md`「Start a Separate Backend for Smoke Tests」起一份隔离后端（**不要碰 8900 上的实例**）：

```bash
SMOKE=$(mktemp -d /tmp/stream-smoke.XXXX); mkdir -p $SMOKE/pkgs
printf 'packages_dir: %s/pkgs\nmanage_containers: false\n' $SMOKE > $SMOKE/config.yaml
```

用 Bash 工具的 `run_in_background` 跑：`STREAM_PORT=18931 STREAM_DATA_DIR=$SMOKE pnpm serve`（node22 工具链见 memory `box-node22-toolchain`）。等 `curl -s 127.0.0.1:18931/api/health` 回 `ok:true`。

依次验证，每一步记下实际输出：

1. 配对码：`curl -sS -X POST http://127.0.0.1:18931/api/devices/pairing-code` → 得到 `code`。
2. 起 agent（后台）：`STREAM_BACKEND_URL=http://127.0.0.1:18931 STREAM_PAIRING_CODE=<code> STREAM_AGENT_DATA=$SMOKE/agent STREAM_DEVICE_NAME=smoke-nas app/host-agent/target/release/stream-desktop`
   Expected: 日志「配对成功：linux:…」「connected」；后端日志 `device connected linux:… (linux, smoke-nas, …, 1 ops)`。
3. `curl -sS http://127.0.0.1:18931/api/devices` → 有一行 `platform:"linux"`、`paired:true`、`online:true`、`name:"smoke-nas"`。（spec「NAS 连上后出现在设备列表」）
4. 经设备发一个公网请求：

```bash
curl -sS -X POST "http://127.0.0.1:18931/api/devices/linux%3A<uuid>/ops" -H 'content-type: application/json' \
  -d '{"op":"http.fetch","args":{"method":"GET","url":"https://example.com/","headers":[],"redirect":"manual","timeoutMs":15000,"allowHosts":["example.com"]}}'
```
   Expected: `{"result":{"status":200,…}}`；agent 日志一行 `[http.fetch] GET example.com → 200 (…ms)`，没有路径、头或 body。（box 若不能出公网，记下 `network` 错误并跳过这一步的 200 断言。）
5. 私网：同上，`url` 换 `http://192.168.1.1/`、`allowHosts` 换 `["192.168.1.1"]` → 502，`error` 以 `private-target:` 开头。（spec「不能借设备访问用户内网」）
6. 主机不在清单：`url` 用 `https://example.com/`、`allowHosts` 用 `["example.org"]` → 502，`host-not-allowed:`。
7. 重启不重配：停掉 agent（按 pid），用 `STREAM_PAIRING_CODE=000000` 再起 → 日志没有「配对」字样，直接 connected；`/api/devices` 里仍是同一个 `deviceId`。（spec「容器重启不需要重新配对」）
8. 撤销：`curl -sS -X DELETE "http://127.0.0.1:18931/api/devices/linux%3A<uuid>"` → agent 日志「撤销」，`$SMOKE/agent/device.json.revoked` 存在，随后一行「配对码被主实例拒绝……不再重试」并停住（进程仍在）。
9. `ALLOW_HOSTS`：停掉 agent，生成新码，用 `ALLOW_HOSTS=example.org STREAM_PAIRING_CODE=<新码>` 起 → 配对成功；重复第 4 步（`allowHosts:["example.com"]`）→ 502 `host-not-allowed:`。（spec「设备侧清单优先」）
10. 收尾：按端口找 pid 停掉后端（`ss -ltnp | grep 18931`），按 pid 停掉 agent。不要 `pkill -f`。

任何一步与 Expected 不符：停下，按 systematic-debugging 查根因，修代码并补一条能复现它的单测，再从那一步重跑。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/test.yml app/host-agent/README.md openspec/changes/device-execution/tasks.md
git commit -m "docs(host-agent): device mode; ci: run the host agent's cargo tests"
```
