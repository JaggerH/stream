# tab-restore-cleanup

## Why

浏览器重启后，Chrome 的「继续浏览上次打开的网页」会把上次会话 Stream 标签组里没关的标签原样
恢复出来（标签组归属本身跟着会话恢复）。而出身账本（哪个 tab 是 AI 自建的探针/交互页、哪个是
用户拖入的）在浏览器重启时被作废——tabId 只在一次浏览器会话内有效，拿着上一次会话的账本对
新会话的标签动手，会关掉复用了旧 id 的用户标签。于是恢复出来的自建探针只能按保守默认收编为
「用户拖入」，永远没人回收：用户每次重启 Chrome，都看到上一轮采集留下的页面还开在 Stream
标签组里。

出身记录需要一个能跨浏览器会话存活的载体。Chrome 的「标签随会话恢复但 id 换新」决定了唯一
可靠的认领键是页面地址（Tab IDs are unique within a browser session —— developer.chrome.com,
chrome.tabs API, Tab.id）。

## What Changes

- 扩展 driver 建自建标签入组时，另存一条**自建名单**记录（tabId + URL + 出身），存
  `chrome.storage.local`，不随浏览器重启作废；标签被回收或撤销时同步删除。条目 URL 跟随标签
  导航保持新鲜：入组时优先记 `pendingUrl`，之后随 `tabs.onUpdated` 更新（只更新不新增），
  service worker 休眠期间错过的导航由醒来对账对在册 tabId 现读补上。
- 浏览器重启后 `reconcileOnWake` 认领恢复组时，对组内此刻标为「用户拖入」的标签按
  「URL 结构相等 ∧ 名单里有记录」认回真实出身：后台探针（probe）随之被常规路径回收；
  交互标签（created）留在主组并恢复出身。**认领键不含 tabId**（恢复出来的标签拿到新 id）。
  认领只在账本作废的跨会话分支发生；同一次会话内的普通醒来只刷新名单、不清（清了名单就
  活不到重启）。
- 每条名单记录至多认领一张标签；同 URL 多张恢复标签而记录不足时，多出来的照旧按「用户拖入」
  处理。名单只在启动对账时消费一次，用后即清，不跨启动累积。
- 红线不变：恢复组内名单认不出的标签照旧按「用户拖入」处理、绝不 `chrome.tabs.remove`；
  组外标签一律不碰。
- 不新增任何权限；不改服务端与中继协议。

## Capabilities

### Modified Capabilities
- `ext-cdp-interactive-transport`：SW 醒来对账新增「浏览器重启后按自建名单认回恢复标签的出身」
  一节；明确认领键、单记录单认领、名单一次性消费与红线。

## Impact

- 改动：`extension/src/lib/driver.ts`（名单的记/删/认领，`reconcileOnWake` 两个分支接入）。
- 测试：`extension/src/lib/driver.roster.test.ts`（先红后绿：probe 收回、created 留组、
  无记录不动、组外同 URL 不关、单记录单认领、名单用后清）。
- 用户升级扩展：**零操作**——不新增权限（不加 `sessions`；且 Chrome 实现的 `chrome.sessions`
  根本没有 `setTabValue`/`getTabValue`，那两个是 Firefox 专有 API），无需重新同意、无需重装。
