## Purpose

交互 lane：骑用户浏览器做多步操作时，以可见的标签组为授权边界——进组授权、拖出撤销、逐动作域名校验、高危动作有确认门。

## Requirements

### Requirement: 看活页面跨 transport

`peek`/`shot`（`GET /api/facilities/:id/page` 与 `/page/screenshot`）SHALL 经统一的 `Transport.evaluate`/`Transport.screenshot` 口求值，对 cloak 与 ext-cdp 两种 transport 返回等价结果，不得假设 Playwright 专有语义。

#### Scenario: cloak facility 读活页面
- **WHEN** 对一个 cloak transport 的 facility 调 `peek`（求值一个表达式）与 `shot`
- **THEN** 返回表达式求值结果与一张截图，行为与今日一致

#### Scenario: ext-cdp facility 读活页面（今日静默坏的路）
- **WHEN** 对一个 ext-cdp transport 的 facility 调 `peek` 与 `shot`
- **THEN** `peek` 经 `Runtime.evaluate`（`evalExpr`）返回表达式值、`shot` 经 `Page.captureScreenshot` 返回截图，均不再 TypeError 或静默失败

### Requirement: 交互 lane 以可见标签组为归属边界

ext-cdp 交互 lane 的"AI 可操作范围" SHALL 由一个会话级 Chrome 标签组界定：当且仅当某 tab 在该标签组内，AI 才可对它 attach 或执行动作。组外 tab MUST 被拒绝。组成员表 SHALL 持久化以便 service worker 回收后恢复。

#### Scenario: 组内 tab 可操作
- **WHEN** 一个 tab 在会话标签组内，AI 对它发起 `act`
- **THEN** 动作被执行

#### Scenario: 组外 tab 被拒
- **WHEN** AI 对一个不在会话标签组内的 tab 发起 `act`
- **THEN** 请求被拒并返回清晰错误，绝不 attach 或误落到别的 tab

### Requirement: tab 识别靠枚举而非猜测

交互 lane SHALL 提供 `list` 原语，返回会话标签组内每个 tab 的 `{tabId, url, title}`；所有动作原语 MUST 要求显式 `tabId` 参数，不得由系统隐式推断目标 tab。

#### Scenario: 枚举组内 tab
- **WHEN** AI 调 `list`
- **THEN** 返回组内全部 tab 的 `{tabId, url, title}` 列表，组外 tab 不出现

#### Scenario: 动作强制显式 tabId
- **WHEN** AI 调 `act` 而未提供 `tabId`
- **THEN** 请求被拒（缺少必填参数），不落到任意默认 tab

### Requirement: 进组授权 / 拖出撤销

一个 tab 进入会话标签组 SHALL 仅两条路：AI 经 `open`/`newTab` 自建（自动进组），或用户手动将已有 tab 拖入组（显式授权）。用户将 tab 拖出组 MUST 立即撤销 AI 对它的控制（detach 并从可操作集合移除）。

#### Scenario: 用户拖入已有 tab 授权
- **WHEN** 用户把一个已开的 tab 拖进会话标签组
- **THEN** 该 tab 进入可操作集合，随后出现在 `list` 结果中、可被 `act`

#### Scenario: 用户拖出 tab 撤销
- **WHEN** 用户把一个 tab 拖出会话标签组
- **THEN** 扩展 detach 该 tab、将其移出可操作集合；后续对它的 `act` 返回"已离组/撤销"错误

### Requirement: 逐动作域名校验

每个会改变页面状态的 `act` SHALL 在执行前校验目标 tab 当前 URL 的域名是否仍等于动作发起时记录的域名；不等则 MUST 拒绝该动作并返回清晰错误，不得静默放行。

#### Scenario: 中途导航到别的域名被拦
- **WHEN** 一个 mutating `act` 发起时 tab 在域名 A，执行前 tab 已导航到域名 B
- **THEN** 该动作被拒并报域名不匹配错误

### Requirement: 命令式 close 按 tab 出身分流

交互 lane 的关闭 SHALL 由命令触发（AI 一轮流程结束主动发 `close`，或用户手动关），不得作为每次求值的强制 `finally` 清理。close SHALL 按 tab 出身分流：AI 自建 tab → detach + `chrome.tabs.remove`；用户拖入的 tab → 只 detach + `chrome.tabs.ungroup` 移出组，MUST NOT 调 `chrome.tabs.remove`。

出身 SHALL 编码两条正交的轴，不得合并为一条：
- 红线轴（可否 remove）：用户拖入的 tab 永远不可；AI 自建的可以。
- 生命周期轴（SW 醒来是否兜底回收）：仅**后台静默探针**（没人看着的 `interactive:false` tab）回收。

#### Scenario: 关闭 AI 自建 tab
- **WHEN** 对一个 AI 自建的 tab 发 `close`
- **THEN** 该 tab 被 detach 并 `chrome.tabs.remove` 回收

#### Scenario: 关闭用户拖入的 tab 不销毁它
- **WHEN** 对一个用户拖入的 tab 发 `close`
- **THEN** 该 tab 被 detach 并 `chrome.tabs.ungroup` 移出组（撤销要让用户看见：只从账本删而不 ungroup，用户看到的仍是"还授权着"），但 MUST NOT 被 `chrome.tabs.remove`（保住用户自己的 tab）

### Requirement: SW 醒来与浏览器对账，而非无差别回收

service worker 醒来时 SHALL 以**浏览器真实的标签组成员**为准与持久化账本双向对账，MUST NOT 无差别回收组内 AI 自建 tab。理由：MV3 SW 一空闲就死、来个命令又活是常态，账本活得比 SW 久，而 SW 死着时用户的拖入/拖出/关 tab 事件无人接收——醒来时账本已不可信。

- 账本有、浏览器无（用户趁 SW 死时拖出或关掉）→ MUST 撤销该成员并 detach，MUST NOT `chrome.tabs.remove`。
- 浏览器有、账本无（用户趁 SW 死时拖入）→ SHALL 补记为"用户拖入"出身。
- 对账后 SHALL 仅回收后台静默探针；给人看的交互 tab MUST 保留（它在可见标签组里，用户一眼看得见、随手关得掉——可见性即其防泄漏机制）。

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

### Requirement: 默认自主执行 + 高危动作确认门

交互 lane 的 mutating 动作 SHALL 默认 `act-without-asking`（AI 自主推进）；仅当动作命中高危清单（提交/发送类、删除/不可逆变更、跨站导航、触碰凭据/账号设置）时 MUST 暂停等用户确认后才执行。

确认门 SHALL 被明确定位为**对齐手段而非安全沙箱**：`confirmed` 与 `intent` 均由调用方自报，一个说谎的调用方可以绕过它。其作用是让高危动作停下来、把自己摊给用户看。**真正的强制边界 MUST 由扩展侧持有**（组成员资格、逐动作域名校验、绝不销毁用户拖入的 tab）——那三条不管后端与模型声称什么都成立。

#### Scenario: 非高危动作自主执行
- **WHEN** AI 在默认模式下执行同站导航、点击非提交按钮、滚动、读取或未提交的填字段
- **THEN** 动作直接执行，不打断用户

#### Scenario: 高危动作暂停确认
- **WHEN** AI 在默认模式下要执行表单提交、下单/支付、删除或跨站导航
- **THEN** 动作在执行前暂停并请求用户确认，确认后才执行，且暂停时 MUST NOT 已经发出任何命令（绝不先斩后奏）

#### Scenario: 确认门失效时安全边界仍在
- **WHEN** 调用方自行声称 `confirmed:true` 而用户从未确认
- **THEN** 该动作会执行——但它仍 MUST 受扩展侧边界约束：目标 tab 必须在用户亲手授权的会话标签组内，且执行前仍要通过逐动作域名校验

### Requirement: 交互 lane 多步原语骑同一持久 tab

交互 lane SHALL 暴露 `open`/`act`/`look`/`close` 原语，同一会话的多步动作骑同一持久前台 tab（同一 `tabId`）串行执行、不交错，中间可用 `look` 读结果决定下一步。

#### Scenario: 多步流程走同一 tab
- **WHEN** AI 依次 `open` → `act(goto)` → `act(type)` → `look` → `act(click)` → `close`
- **THEN** 全序列在同一 `tabId` 上串行完成，各步不交错，`look` 能读到中间页面状态
