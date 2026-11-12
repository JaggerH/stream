# tab-restore-cleanup — tasks

## 计划 1：driver 自建名单

- [x] 1. `extension/src/lib/driver.ts`：`ROSTER_KEY`、`BindingRuntime.rosterKey`、`loadRoster` / `saveRoster` / `noteRoster`（adopted 不进名单）/ `dropRoster`
- [x] 2. `addTabToGroup` 写账本同一时刻记名单；`forgetMember` 同步删名单条目
- [x] 3. `claimRestoredTabs`：URL 结构相等（sameUrl）∧ 组内 ∧ 此刻标 adopted 才认领；单记录单认领；用后整清；认领/未认领都记 debugLog

## 计划 2：接入启动对账

- [x] 1. `reconcileOnWake` 账本活着分支：对账补账后、回收探针前认领
- [x] 2. `reconcileOnWake` 账本作废分支（浏览器重启走的路）：认领恢复组后认领 + 回收认回的 probe

## 计划 3：测试（先红后绿）

- [x] 1. `extension/src/lib/driver.roster.test.ts`：重启后恢复 probe（新 tabId、同 URL、组内）被关；created 留组记回 created；无名单记录不动；组外同 URL 不关；同 URL 两张名单一条只认领一张；名单用后清；名单不作用于非 adopted 成员
- [x] 2. 红验证：暂存实现后 4 条挂、恢复后全绿

## 计划 3'：R1 —— 名单 URL 跟着导航走

- [x] 1. `noteRoster` 优先记 `pendingUrl`（进组时 `tab.url` 常还是 about:blank）；about:blank/空串也照记，条目先占上
- [x] 2. `refreshRosterUrl`：`tabs.onUpdated` 的 `changeInfo.url` 更新在册条目（只更新、不新增；URL 没变不写 storage）
- [x] 3. `refreshRosterFromLive`：醒来对账把名单里账本还在册的 tabId 现读刷新（SW 休眠期错过的导航；跨重启陈旧条目不刷）
- [x] 4. 修上轮遗留：`reconcileOnWake` 账本活着分支不再调用认领（它每次醒来清名单，名单活不到重启）；认领只在账本作废（重启）分支
- [x] 5. 新用例（先红后绿，3 条行为用例无修复即挂）：进组 about:blank→pendingUrl、导航 A→B 跟随、重启按 B 认领；created 全链（休眠期无事件导航→醒来刷新→重启记回 created）；probe 全链（醒来刷新成最终 URL）；回收后条目不复活；URL 没变不写 storage

## 计划 4：规格

- [x] 1. `openspec/changes/tab-restore-cleanup/`：proposal、spec delta（ext-cdp-interactive-transport：对账 Requirement 补一条 + 新 Requirement「浏览器重启后按自建名单认回恢复标签的出身」六个 Scenario）
