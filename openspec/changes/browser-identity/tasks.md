## 计划 0：spike

- [x] 1. S1：认领页按 profile 打开、由该 profile 的节点交回，不需要 `web_accessible_resources`（javis CfT 156）
- [x] 2. S2（Linux）：`--no-startup-window` 唤起 profile，SW 起来、不开窗口
- [x] 3. S2（Windows 真机）复核：profile 被静默加载，窗口数不变
- [ ] 4. S3：在登着号的 Chrome 上取 bilibili（`http` / JSON）、xhs（`page` / `__INITIAL_STATE__`）、eastmoney（`http` / HTML）的确切路径
- [x] 5. S4：`Local State` 的 `info_cache` 字段与 `last_active_profiles`
- [x] 6. S4：Windows 真机上 `Local State` 的位置复核（`%LOCALAPPDATA%\Google\Chrome\User Data`）
- [x] 7. 结论回写 design.md（D3 新 profile 补发、D5 两种形状、D8 静默唤起、D13 标签组）

## 计划 0.5：一个 profile 一个 Stream 标签组（可独立先做）

- [ ] 1. `adoptOpenedTab`：别的普通窗里的新标签挪进主组那扇窗并入主组，随它新开的空窗关掉；popup 照旧
- [ ] 2. 删掉 `WINDOW_GROUP_TITLE` / `windowGroups` / `reconcileWindowGroups`
- [ ] 3. 升级收编：独立窗组里 probe 关、created 挪进主组、adopted 只解组；同名主组合并
- [ ] 4. driver 测试：新窗被并回、popup 不动、收编 47 个旧组只剩一个且 adopted 标签仍在
- [ ] 5. Windows 真机冒烟：站点 `window.open` 后浏览器里仍只有一个 Stream 组

## 计划 1：节点（browser-node 的后端与扩展部分）

- [ ] 1. 扩展：生成并持久化 `nodeId`；握手带 `nodeId` / `profileDir` / `profileName`（`shared/browser-relay/handshake.ts`）
- [ ] 2. `browser_nodes` 表与 `NodeStore`；节点首次连上建行；设备默认浏览器迁到节点
- [ ] 3. 本机多节点：`/api/ext` 按 `nodeId` 给出 `local:<nodeId>`，不带的落兼容槽 `local`；`ExtRelayRegistry` 本机按节点
- [ ] 4. `registry.local` 改为经 `pickBrowser` 解析的门面；测试：一次执行内所有 relay 调用落在同一节点
- [ ] 5. 配对绑定记 `nodeId`，换 `nodeId` 来连以 4004 拒绝；扩展侧把 4004 显示为「这条绑定属于另一个 profile」
- [ ] 6. 登录态按节点：`data/cookies/<deviceId>/<nodeId>.json`，`CookiePuller` 按节点，`requiredDomainsFor` 按节点；兼容槽读旧文件
- [ ] 7. 运行记录加 `nodeId` / `profileName` / `environment`

## 计划 2：profile 认领

- [ ] 1. host agent：`browser.profiles`（读 `Local State`）、`browser.claim`（按 profile 打开 URL），声明进 `hello.ops`；`cargo test`
- [ ] 2. 扩展：`claim.html` entrypoint，把 `nonce` 经全部已连绑定交回；认领成功后记下 profile
- [ ] 3. 后端：认领会话（签 `nonce`、2 分钟一次性、校验同设备、20 秒未回标「未安装或未连上」）与 `/api/devices/:id/profiles/*` 路由
- [ ] 4. 节点的名称与环境：`PATCH /api/devices/nodes/:nodeId`

## 计划 3：站点身份

- [ ] 1. `whoami` 进 manifest 类型与安装校验（`url` 须在允许主机内）
- [ ] 2. 节点上的探测器：后台标签导航、解析、三态结果、按节点串行
- [ ] 3. `site_identities` 表；节点连上、会话 cookie 变化、手动刷新三个触发；无 `whoami` 的 facility 记 `node:<nodeId>`
- [ ] 4. `ctx.login` 成功后重新探测
- [ ] 5. 给 bilibili、xhs、eastmoney 补 `whoami`（按 spike S3 的结论）

## 计划 4：按身份路由

- [ ] 1. `Target` 三种；`facility_devices` 加 `account_id` / `environment` 列，任务行加 `identity` / `environment` 列；`command` 类任务拒绝
- [ ] 2. 解析器：身份 / 环境候选、在线优先、最近核对优先；预填 `browser.bindingId`；候选为空时没有回落分支
- [ ] 3. 按需唤起：`ensureApp { profileDirectory, force }`、等节点 30 秒、单节点单飞；按 S2 结论决定定时执行是否唤起
- [ ] 3a. 唤起后收尾：关掉自己开的标签与为它造的窗；`woken_at` 记录与清除；冒烟时看关窗后 Chrome 是否卸载该 profile
- [ ] 4. 执行前核对：新鲜度窗口（采集 10 分钟、动作 60 秒）；`identity-mismatch` / `identity-signed-out` / `identity-offline` 与失败处置
- [ ] 5. 通知：换号与登出指名 profile；运行记录加 `accountId` / `accountName`
- [ ] 6. 端到端测试：两个本机节点、两个账号，任务指定身份，换号后被拦下

## 计划 5：面板与 popup

- [ ] 1. 面板 API 层（节点、认领、身份表、目标）
- [ ] 2. 设备页：节点列表（profile、环境、在线、默认）、「识别 profile」、身份表、「Stream 在后台打开着的 profile」
- [ ] 3. facility 默认目标与任务覆盖的选择器：设备 / 身份 / 环境
- [ ] 4. 运行记录显示 profile、环境、账号
- [ ] 5. 扩展 popup：当前 profile 与环境；未识别时的说明
- [ ] 6. 文档（ARCHITECTURE 执行位置一节、PACKAGE 的 `whoami`、扩展 README）；Windows 真机冒烟：两个 profile 同时在线、认领、指定身份执行、换号被拦
