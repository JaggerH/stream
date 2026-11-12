## MODIFIED Requirements

### Requirement: SW 醒来与浏览器对账，而非无差别回收

service worker 醒来时 SHALL 以**浏览器真实的标签组成员**为准与持久化账本双向对账，MUST NOT 无差别回收组内 AI 自建 tab。理由：MV3 SW 一空闲就死、来个命令又活是常态，账本活得比 SW 久，而 SW 死着时用户的拖入/拖出/关 tab 事件无人接收——醒来时账本已不可信。

- 账本有、浏览器无（用户趁 SW 死时拖出或关掉）→ MUST 撤销该成员并 detach，MUST NOT `chrome.tabs.remove`。
- 浏览器有、账本无（用户趁 SW 死时拖入）→ SHALL 补记为"用户拖入"出身。
- 对账后 SHALL 仅回收后台静默探针；给人看的交互 tab MUST 保留（它在可见标签组里，用户一眼看得见、随手关得掉——可见性即其防泄漏机制）。
- 浏览器重启后 Chrome 恢复出上次会话的自建标签时，SHALL 按跨会话的自建名单认回真实出身（见下），认回的探针随之按常规路径回收。

#### Scenario: SW 重启不关掉用户正看着的交互 tab
- **WHEN** service worker 重启，会话组内有一个 AI 开的前台交互 tab（`interactive:true` / `kept:true`）
- **THEN** 该 tab MUST NOT 被 `chrome.tabs.remove`，其组成员身份保留

#### Scenario: SW 重启仍回收没人看的后台探针
- **WHEN** service worker 重启，会话组内有一个后台静默探针 tab（调用方崩溃未能关闭）
- **THEN** 该 tab 被 detach 并 `chrome.tabs.remove` 回收

#### Scenario: 补上 SW 死期间漏掉的拖出
- **WHEN** 用户在 service worker 死着时把一个 tab 拖出会话组，SW 随后醒来
- **THEN** 该 tab 的授权被撤销（移出账本 + detach），且 MUST NOT 被 `chrome.tabs.remove`（它还在用户手里）

#### Scenario: 归属判据以浏览器为准
- **WHEN** 账本仍记着某 tab 在组内，但浏览器的 `groupId` 显示它已被拖出
- **THEN** 对它的 attach/动作 MUST 被拒（账本只是出身缓存，浏览器才是组归属的真相）

### Requirement: 浏览器重启后按自建名单认回恢复标签的出身

浏览器重启会作废出身账本（tabId 只在一次浏览器会话内有效，官方文档：Tab IDs are unique within a browser session），而 Chrome 的「继续浏览上次打开的网页」会把上次会话标签组里的 tab 原样恢复出来（组归属跟着会话恢复）。系统 SHALL 为每个自建 tab（probe 与 created）保存一条跨浏览器重启存活的名单记录（tabId + URL + 出身，存 `chrome.storage.local`），并在重启后认领恢复组时按名单认回出身。

认领规则：
- 匹配键 SHALL 是「URL 结构相等 ∧ 该成员此刻在本绑定的恢复组内、出身标为『用户拖入』」，MUST NOT 以 tabId 为匹配条件（恢复出来的 tab 拿到新 id）。
- 名单条目的 URL SHALL 跟随标签导航保持新鲜：进组时优先记 `pendingUrl`（此刻 `tab.url` 常还是初始空文档）；之后随 `tabs.onUpdated` 的 `changeInfo.url` 更新（只更新、不新增，tab 回收后条目绝不复活）；service worker 休眠期间错过的导航 SHALL 在醒来对账时对仍在册的 tabId 现读补上（同一会话内 tabId 可信，跨重启的陈旧条目 MUST NOT 现读刷新）。
- 每条名单记录 SHALL 至多认领一张标签；同 URL 多张恢复 tab 而记录不足时，多出的 tab 照旧按『用户拖入』处理。
- 名单 SHALL 在一次跨会话认领后整个清掉，不跨启动累积；同一次会话内的普通醒来 MUST NOT 清名单（清了名单就活不到重启）；tab 被回收或授权被撤销时 SHALL 同步删除其名单条目。
- 认回 probe 的 SHALL 随后被常规回收路径关闭；认回 created 的 SHALL 留在主组并恢复出身。

红线不变：名单认不出的恢复 tab 照旧按『用户拖入』处理、MUST NOT 被 `chrome.tabs.remove`；组外 tab（含 URL 恰好与名单相同的用户自己的 tab）一律不碰。本机制 MUST NOT 新增任何权限。

#### Scenario: 重启后恢复的探针被收回
- **WHEN** 浏览器重启，Chrome 恢复出上次会话组里一个后台探针 tab（新 tabId、URL 与名单记录一致）
- **THEN** 它被认回 probe 出身并 `chrome.tabs.remove` 回收，用户重启后不再看到它

#### Scenario: 重启后恢复的交互 tab 留在主组
- **WHEN** 浏览器重启，Chrome 恢复出上次会话组里一个 AI 开的前台交互 tab（URL 与名单记录一致）
- **THEN** 它不被 remove，出身记回 created，留在恢复的主组里

#### Scenario: 名单认不出的恢复 tab 绝不动
- **WHEN** 浏览器重启，恢复组里有一个 URL 与任何名单记录都对不上的 tab
- **THEN** 它照旧按『用户拖入』处理，MUST NOT 被 `chrome.tabs.remove`

#### Scenario: 组外同 URL 的用户标签不关
- **WHEN** 名单里的 URL 出现在恢复组之外的用户自己的 tab 上
- **THEN** 该 tab 不被认领、不被 remove（认领只作用于恢复组内标为『用户拖入』的成员）

#### Scenario: 名单跟到导航后的最终 URL
- **WHEN** 自建标签进组后继续导航（翻页、点详情、站内跳转、重定向），Chrome 恢复的是它最后停留的 URL
- **THEN** 名单条目的 URL 跟随导航更新（进组时记 `pendingUrl`，之后随 `onUpdated` 更新；service worker 休眠期间错过的由醒来对账现读补上），重启后按最终 URL 认领

#### Scenario: 休眠期导航靠醒来刷新兜住
- **WHEN** service worker 死着时自建标签导航到了新 URL（`onUpdated` 事件无人接收），随后 SW 在同一次浏览器会话内醒来
- **THEN** 名单里该 tabId 的条目被现读刷新为新 URL，之后重启也能按最终 URL 认领

#### Scenario: 回收后的条目不复活
- **WHEN** 一个 tab 的名单条目已随其回收删除，同一 tabId 在本会话内被复用给用户新开的标签并发生导航
- **THEN** `onUpdated` 不为它创建名单条目（名单只由入组时刻创建）

#### Scenario: 同 URL 多张只认领一张
- **WHEN** 恢复组内有两张 URL 相同的 tab，而名单只有一条该 URL 的记录
- **THEN** 只有一张被认领（probe → 回收），另一张照旧按『用户拖入』处理、绝不 remove

#### Scenario: 升级零操作
- **WHEN** 用户从旧版本扩展升级到带此机制的版本
- **THEN** 不出现新的权限警告，扩展不被停用，用户无需重新同意或重装
