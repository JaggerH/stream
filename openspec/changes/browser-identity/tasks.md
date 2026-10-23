## 计划 0：spike（Windows 真机 Chrome，先于一切实现）

- [ ] 1. S1：`--profile-directory=X chrome-extension://<id>/claim.html#…` 交给运行中的 Chrome，是否在 X 里打开扩展页；是否需要 `web_accessible_resources`
- [ ] 2. S2：目标 profile 未加载时，`--profile-directory=X --no-startup-window` 能否只唤醒扩展 SW 不开窗口
- [ ] 3. S3：bilibili / xhs / eastmoney 的「当前用户」接口，直接导航能否带上会话拿到账号 id
- [ ] 4. S4：Windows 与 macOS 上 `Local State` 的位置与 `profile.info_cache` 字段
- [ ] 5. 结论回写 design.md 的 Open Questions，必要时改 D3 / D5 / D8

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
- [ ] 4. 执行前核对：新鲜度窗口（采集 10 分钟、动作 60 秒）；`identity-mismatch` / `identity-signed-out` / `identity-offline` 与失败处置
- [ ] 5. 通知：换号与登出指名 profile；运行记录加 `accountId` / `accountName`
- [ ] 6. 端到端测试：两个本机节点、两个账号，任务指定身份，换号后被拦下

## 计划 5：面板与 popup

- [ ] 1. 面板 API 层（节点、认领、身份表、目标）
- [ ] 2. 设备页：节点列表（profile、环境、在线、默认）、「识别 profile」、身份表
- [ ] 3. facility 默认目标与任务覆盖的选择器：设备 / 身份 / 环境
- [ ] 4. 运行记录显示 profile、环境、账号
- [ ] 5. 扩展 popup：当前 profile 与环境；未识别时的说明
- [ ] 6. 文档（ARCHITECTURE 执行位置一节、PACKAGE 的 `whoami`、扩展 README）；Windows 真机冒烟：两个 profile 同时在线、认领、指定身份执行、换号被拦
