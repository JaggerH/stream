## ADDED Requirements

### Requirement: scroll 的分段耗时回执

`scroll` 的回执（带或不带 `until`，能力 `ui.tree` v5）SHALL 带可选字段 `timing`，其形状为
`{a11yMs, gestureMs, settleMs, changeCheckMs, steps}`，所有耗时为非负整数毫秒，`steps` 是本次完成的
步数（`until` 模式下与实际执行的滑动步数一致）。`a11yMs` 是无障碍滚动动作的耗时，`gestureMs` 是
回退手势的耗时，`settleMs` 是动作后静默检查的耗时，`changeCheckMs` 是读树判断内容是否移动的耗时，
`steps` 与回执顶层 `steps` / `scrolls` 一致。回执的既有字段 SHALL NOT 因此改变含义；不读 `timing`
的调用方 SHALL 不受影响（缺省即可用）。

#### Scenario: 回执说清时间花在哪
- **WHEN** 调用方在内容持续变化的页面上发 `scroll {dir: "down", amount: 2}`
- **THEN** 回执带 `timing: {a11yMs, gestureMs, settleMs, changeCheckMs, steps: 2}`，各字段为整数毫秒
- **AND** `method` / `steps` / `via` 等既有字段的含义与 v4 相同

#### Scenario: 老调用方不看新字段
- **WHEN** 调用方只读 `method`、`steps`、`via`
- **THEN** 回执照旧给出这些字段，`timing` 是额外字段，不出现也不影响这些字段的读取

### Requirement: 持续变化的页面上有界的滚动

无障碍滚动一步之后，执行端 SHALL 在「滚动容器的首个可见项位置在两次读之间变化」时，或「连续两次读
的内容指纹相同」时，判定该步完成；不得要求整页内容停止变化。单步的移动等待 SHALL 有上限（缺省
800 ms）。`scroll` 整次操作 SHALL 有总时长上限（缺省 10000 ms；带 `until` 时 `timeoutMs` 缺省同样为
10000 ms，上限仍是 60000 ms）。到上限时 SHALL 返回已完成的步数，并带 `stopped: "time"`；不得让调用方
的 op 超时来结束操作。上限在两步之间检查，进行中的一步会走完再返回。`scroll` 动作后的静默检查 SHALL
限制在一次短检查（缺省不超过 200 ms），SHALL NOT 为滚动等待无障碍事件停止。#### Scenario: 一直在变的页面不再每步等满
- **WHEN** 页面上的倒计时每秒都在变，调用方发 `scroll {dir: "down", amount: 10}`
- **THEN** 每步在首可见项位置变化后即完成，单步等待不超过 800 ms
- **AND** 整次操作在上限内返回，回执带已完成的步数与 `timing`

#### Scenario: 到总上限就带步数返回
- **WHEN** 每步都很慢，整次 `scroll` 到达 10000 ms 上限
- **THEN** 回执带 `steps`（已完成的步数）与 `stopped: "time"`
- **AND** 不继续滑完剩余的步数，也不抛错

#### Scenario: 滚动后的静默检查不再等满上限
- **WHEN** 无障碍事件一直没有安静（倒计时、进度条）
- **THEN** `scroll` 的静默检查在第一次看到内容变化后返回，`timing.settleMs` 为一次检查的耗时
- **AND** `settled` 仍如实表示「安静且变化」是否满足，`effect` 照旧由动作前后的指纹给出

#### Scenario: until 的缺省时长上限
- **WHEN** 调用方用 `scroll {dir: "down", until: "排序"}` 且不传 `timeoutMs`
- **THEN** 搜索在 10000 ms 上限处停止并回 `stopped: "time"`
- **AND** 显式传 `timeoutMs`（上限 60000）时以传入值为准

### Requirement: 记住已确认移动的滚动容器

一次 `scroll` 操作中，第一个经过步骤确认移动的无障碍滚动节点 SHALL 被记住，其后的步骤 SHALL 只用
它，不再枚举或尝试其他候选节点。`until` 模式的各步 SHALL 复用同一个已确认的节点，不再每步重新按
面积排序候选。被记住的节点在后续步骤被拒绝或没有移动时，按既有的「到内容尽头」语义处理，SHALL NOT
回去重试其他节点。

#### Scenario: 后续步骤不换容器
- **WHEN** `until` 模式的第一步确认第一个滚动容器移动了，之后另一容器在屏幕上变得更大
- **THEN** 后续步骤仍使用第一个容器
- **AND** 日志中没有对第二个容器的滚动尝试

#### Scenario: 记住的容器停住就是尽头
- **WHEN** 已确认移动的容器在后续步骤不再移动
- **THEN** 滚动在该步结束（`end: true` 或 `stopped: "end"`，取决于模式），不重试其他容器
