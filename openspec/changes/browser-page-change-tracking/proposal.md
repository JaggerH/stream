# browser-page-change-tracking

## Why

`browser-page` 的条目身份是页面地址本身（adapter 把 guid 写成 `page.url`），而 `stream-pipeline` 的
条目 id 判据是 `stream|guid`、入库按 id 去重——同一页面永远只产出第一条，订阅之后页面内容再怎么变
也采不出新条目（`stream-pipeline.test.ts` 的 page-as-id 测试钉住了这个失败模式）。所以它只能当
**单页快照**用，不能追更新；页面没有 feed 时用户今天没有任何办法「盯一个网页的变化」。

这不需要推翻快照源的结构：把条目身份改成「地址 + 内容摘要」即可让内容变化自然成为新条目——
代价是噪声页面（每次渲染都不同）会刷屏，所以要归一化 + 产出上限。作为**可选能力**加在
`browser-page` 上，默认行为不变。

## What Changes

- **`browser-page` 新增可选参数 `track_changes`（默认关闭）。** 关闭 = 现行单页快照语义原样不动
  （guid 仍是页面地址，同一页面只产出一条，零迁移）。开启 = 每次采集渲染同一页，把渲染出的正文
  归一化（折叠空白、去掉时间戳一类噪声）后取摘要：内容实质变化产出**恰好一条**新条目，guid 由
  页面地址和内容摘要组成；内容没变不产出。
- **归一化只吃渲染正文（innerText），不吃 HTML。** 脚本与样式本来就不出现在 innerText 里；
  HTML 里的 nonce、资产哈希、A/B 标记全是噪声，不参与摘要。标题变化不算内容变化（标题改写
  正是典型噪声）。
- **防刷上限：每个页面滚动 1 小时窗口内至多产出 10 条变更条目。** 超限的采集产出 0 条（不排队）；
  窗口滑出后，下一次内容变化报告的是当时的最新内容。上限记忆是 adapter 进程内的（与
  adapter-request-cache 同级的进程内缓存先例），重启即重置——重启后最坏多产出当前内容的一条，
  身份不变时 dedup 会吞掉，不重复。
- **升级语义：历史订阅不会把现有页面当成一次变更。** 既有订阅不带新参数，行为原样；带参数的
  新订阅首次采集产出当前页面作为基线条目（与所有源的首次采集一致）。重启丢失「上次摘要」记忆
  后的重复产出由既有 dedup 兜底，不产生重复条目。
- **描述口径如实更新**（`manifests.yaml` 与 `stream_search` 空结果 note）：browser-page 能力是
  单页快照 + 可选的内容变化跟踪（有产出上限、需要在线浏览器设备）；页面有 feed 时仍优先
  `feed-url`（不依赖设备、身份来自 feed 自身，比逐 tick 渲染便宜且稳）。

## Capabilities

### New Capabilities
- `browser-page-change-tracking`：`browser-page` 的可选内容变化跟踪——归一化正文摘要做条目身份、
  未变不产出、实质变化恰好一条、噪声归一化、防刷上限、描述口径。

### Modified Capabilities
- 无（`feed-url-source` 等既有能力不动）。

## Impact

- `packages/browser/adapter.ts`：track_changes 分支 + 归一化 + 产出上限（进程内状态，注入时钟可测）。
- `packages/browser/manifests.yaml`：参数与描述更新。
- `src/mcp/tool-catalog.ts`：`stream_search` 空 note 里 browser-page 那句改成事实口径。
- 测试：adapter 单测（身份、未变、噪声、上限）+ adapter×pipeline 集成（不变 0 条 / 实质变化 1 条 /
  只有噪声 0 条 / 超上限不再产出）。
