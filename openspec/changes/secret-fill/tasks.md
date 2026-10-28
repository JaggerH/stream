# secret-fill — tasks

## 计划 1：动作与来源

- [ ] 1. `SecretSource` / `SecretValue` 类型；`createStream` / `createRuntime` 选项 `secretSource`，接到 cdp 路由与 facility 的 act 通路
- [ ] 2. `interactive-gate.ts`：`ActionKind` 加 `login`，字段 `secret` / `usernameSelector` / `passwordSelector` / `totpSelector` / `submitSelector` / `waitMs`；`classifyAction` 固定高危（`credential`）
- [ ] 3. `tool-specs.ts`：`cdp_act` 参数与说明（告诉模型：只给引用名，值它永远拿不到；`navigated:false` 时看一眼页面再判断）
- [ ] 4. 顶层 frame origin：经 CDP `Page.getFrameTree` 读主 frame URL，规范化比对；iframe 表单拒绝
- [ ] 5. `runLogin`：取值 → 逐字段可信输入 → 提交 → 等导航（`waitMs` 缺省 15 s）→ 未导航则清空；结果只含字段名与布尔量

## 计划 2：读取锁与不落记录

- [ ] 1. 按标签的读取锁（后端）：登录期间 `cdp_look` / `cdp_shot` / `cdp_act` 读取与输入类动作立即拒绝 `secret-fill-in-progress`；清空失败时锁到导航或关闭
- [ ] 2. 中继：承载秘密的命令带标记，慢命令账本 / debug bus / 超时错误只写命令名；核对扩展侧不记 CDP 参数
- [ ] 3. 错误信息只带引用名与字段名

## 计划 3：测试

- [ ] 1. 来源缺失、origin 不符、iframe 表单各一条拒绝，页面无输入
- [ ] 2. 成功跳转、不跳转清空、清空失败保持锁
- [ ] 3. 并发读取被拒（同标签），别的标签不受影响
- [ ] 4. 未确认返回 `needs-confirmation` 且来源没被调用
- [ ] 5. 特征串审计：成功与失败各一次，全部日志、debug bus、运行记录、MCP 结果命中为 0
- [ ] 6. 真机：本机 Chrome + 扩展对一个练习站登录一次（截图不入库）

## 计划 4：验证与交付

- [ ] 1. `flock /tmp/stream-heavy.lock node_modules/.bin/vitest run src shared` 与 `tsc --noEmit -p .`（环境性失败名单不变）
- [ ] 2. rebase 到 origin/main，conventional 提交，push，main 线性
