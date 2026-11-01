# browser-page-change-tracking — spec delta

## ADDED Requirements

### Requirement: 可选的内容变化跟踪

`browser-page` SHALL 支持可选参数 `track_changes`（布尔，默认关闭）。关闭时行为 SHALL 保持单页快照
语义不变（条目 guid 是页面地址，同一页面只产出一条）。开启时每次采集渲染同一页，页面归一化正文的
内容实质变化 SHALL 恰好产出一条新条目，内容未变化 SHALL NOT 产出条目。

#### Scenario: 默认关闭

- **WHEN** `subscribe_source({ source_id: "browser-page", params: { url: "<page>" } })`（不带 `track_changes`）
- **THEN** 行为与变更跟踪引入前完全一致：同一页面无论内容怎么变都只产出第一条

#### Scenario: 开启后首次采集

- **WHEN** 新订阅带 `track_changes: true`，第一次采集渲染出页面
- **THEN** 产出一条基线条目（与所有源的首次采集一致）

#### Scenario: 开启后内容未变

- **WHEN** 带跟踪的页面被连续采集两次，两次渲染的归一化正文相同
- **THEN** 第二次采集产出 0 条

#### Scenario: 开启后内容实质变化

- **WHEN** 带跟踪的页面正文发生实质变化后被再次采集
- **THEN** 恰好产出一条新条目

### Requirement: 条目身份由地址与内容摘要组成

开启跟踪时，条目标识 SHALL 由页面地址和归一化正文的摘要组成（同一内容同一身份），SHALL NOT 只用
页面地址。因此重启或重复采集不会因身份漂移产出重复条目——同一内容重复到达时由既有 dedup 吞掉。

#### Scenario: 重启后重复产出被吞

- **WHEN** 进程重启清空了跟踪记忆，第一次采集到的页面内容与重启前最后一次产出的相同
- **THEN** 该条目的身份与此前相同，dedup 不产出重复条目

### Requirement: 归一化去掉渲染噪声

内容摘要 SHALL 只取渲染后的页面正文（innerText），SHALL NOT 使用页面 HTML；摘要前 SHALL 折叠空白并
去掉时间戳一类逐次渲染会变的文本（绝对日期/时刻、相对时间短语）。页面标题变化 SHALL NOT 算作内容变化。

#### Scenario: 只有时间戳变了

- **WHEN** 两次渲染的正文只差一行「Last updated 2026-11-01 10:00」这类时间戳
- **THEN** 归一化后相同，产出 0 条

#### Scenario: 只有标题变了

- **WHEN** 页面标题变了而正文未变
- **THEN** 产出 0 条

### Requirement: 防刷上限

每个页面在滚动 1 小时窗口内产出的变更条目 SHALL 至多 10 条。超限期间的采集 SHALL 产出 0 条（不排队）；
窗口滑出后下一次实质变化报告的是当时的最新内容。上限记忆是进程内的，重启即重置。

#### Scenario: 噪声页面刷屏被截断

- **WHEN** 一个每次渲染都不同的页面在一个窗口内被采集超过 10 次
- **THEN** 第 11 次起产出 0 条，直到窗口滑出

#### Scenario: 窗口滑出后恢复

- **WHEN** 上限截断后窗口滑出，页面又发生实质变化
- **THEN** 产出一条新条目，内容是当时的最新正文

### Requirement: 描述口径与出路次序

`browser-page` 的对外描述 SHALL 如实写明：单页快照 + 可选内容变化跟踪（有产出上限、需要在线的浏览器
设备）。页面有 feed 时 SHALL 优先指引 `feed-url`（不依赖设备、条目身份来自 feed 自身）。

#### Scenario: 有 feed 的页面

- **WHEN** 模型为一个有 RSS/Atom feed 的站点找订阅出路
- **THEN** 指引先探 feed 地址订 `feed-url`，而不是对页面开跟踪
