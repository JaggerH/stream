# feed-url-source — spec delta

## ADDED Requirements

### Requirement: 直接订阅 RSS / Atom feed 地址

系统 SHALL 提供通用源 `feed-url`：参数 `url` 是 RSS 2.0 或 Atom 的 **feed 文档地址**，服务端直接拉取并解析，
每个条目产出一项（title、link、正文、发布时间），频道名用于订阅后的自动命名。解析不到任何条目时 SHALL 报错，
SHALL NOT 产出空的权威快照。

#### Scenario: 订一个博客的 feed

- **WHEN** `subscribe_source({ source_id: "feed-url", params: { url: "https://example.com/feed.xml" } })`
- **THEN** 首次采集产出该 feed 当前的全部条目，每条一项

#### Scenario: 传的是页面不是 feed

- **WHEN** `url` 指向一份没有 item/entry 的文档（如 HTML 页）
- **THEN** 采集报错说明「没找到 RSS 条目」，不产出任何条目

### Requirement: 条目身份来自 feed 自身

条目标识 SHALL 取自 feed 自己的 per-entry 标识（RSS `<guid>` / Atom `<id>`，缺失时回落到条目链接），
SHALL NOT 使用 feed 地址本身。因此 feed 新增一条后，下一次采集 SHALL 恰好新增这一条；内容未变的条目
SHALL NOT 重复产出。

#### Scenario: feed 新增一条

- **WHEN** 已订阅的 feed 新增一个条目，其余条目不变
- **THEN** 下一次采集恰好产出这一条新条目

#### Scenario: 重复采集

- **WHEN** 同一份 feed 被连续采集两次
- **THEN** 第二次不产出新条目

### Requirement: 服务端取数走统一守卫

取数 SHALL 走服务端统一的出站守卫（SSRF 基线 + caller-fetch-guard 激活时的逐跳判定）：回环、私网段、
link-local（含云元数据地址）SHALL 被拒绝；守卫激活时拒绝 SHALL 原样冒泡。

#### Scenario: 私网地址

- **WHEN** `url` 是 `http://127.0.0.1/feed.xml`、`http://10.0.0.1/f.xml` 或
  `http://169.254.169.254/latest/meta-data/`
- **THEN** 采集被拒绝，且不向该地址发出任何请求
