# 计划 1：词表与类目数据（device-sensitive-semantics-data）

- [ ] 1. 词表数据文件：提交动词与短语、CJK 前缀、资金词、安装、呼叫、设置、肯定词、搜索词、密码词、
      验证码词、排除项，11 种 UI 语言（摘自 Pinky `internal/policy/words.go`，Apache-2.0）
- [ ] 2. 类目表数据文件：finance / passwords / messaging / social / stores / browsers / phone /
      settings / system / blocked（初版条目摘自 Pinky `apps.yaml`），deny 类目 = finance / passwords / blocked
- [ ] 3. `NOTICE` / `THIRD-PARTY-NOTICE` 登记 Pinky 出处、许可证与取用版本
- [ ] 4. 规范化：拉丁 6 词 / CJK 14 字长度上限、数字不计长度、排除项先于命中（`detect.go` 的既有工程，
      用例固化）

# 计划 2：读取层打码（device-sensitive-semantics-masking）

- [ ] 5. 凭据字段识别：密码 state、密码词、验证码词 + 排除项（promo / 邮编 / 区号不算）
- [ ] 6. 树读取打码：`find` / `readSubtree` 的文本与标签掩码
- [ ] 7. 截图打码：被识别元素的显示区域覆盖；无法保证覆盖完整 → `secure-window`
- [ ] 8. 出站帧审计测试：枚举全部出站帧类型（树读取、截图、回执、状态帧），断言凭据值不出现

# 计划 3：敏感闸与凭据校验（device-sensitive-semantics-gate）

- [ ] 9. 提交类检测引擎：op × 结构信号 × 词表 × 类目 → reasons（含 `commit-unrecognized`）
- [ ] 10. `approval-required` 回执与 `semantics` schema；`bindingDigest` / `screenDigest` 计算（规范化
       序列化定死并进测试快照）
- [ ] 11. 执行前四查与错误码：`approval-expired` / `approval-mismatch` / `approval-used` /
       `approval-stale`；检查顺序（keyguard → busy → 闸）与「检查失败不消费凭据」
- [ ] 12. 豁免下发与匹配：App × 动作类目；断开清空；不解除 deny 与凭据字段
- [ ] 13. `setBusy` 控制帧与 `device-busy`：置忙拒执行类 op、`status` 照常、断开自动解除
- [ ] 14. deny 类目可见性：窗口列表、树读取、动作、通知四面都不可见；`app-denied`
- [ ] 15. host-relay 协议文档：新错误码、`semantics` schema、控制帧（`docs/ARCHITECTURE.md` 或
       `docs/API.md` 对应节）

# 计划 4：测试用例（批次 B 验收清单）

词表命中与漏报：

- [ ] 16. 命中样例：11 种语言各 ≥ 3 例（发送 / 支付 / 删除 / 安装 / 呼叫 / 设置各方向），含简中
       「确认收货」「立即还款」、繁中「結帳」、日文「送信」、韩文「결제」等 CJK 前缀
- [ ] 17. 漏报兜底：非常规文案 + 可点击 + 表单确认上下文 → `commit-unrecognized` 仍 `approval-required`
- [ ] 18. 排除项不误报：「Order history」「sort by」「order by」、价格与日期、订单号数字；长文本段落
       （拉丁 > 6 词）不算按钮
- [ ] 19. 对话框确认：屏幕在问「Delete this message?」时肯定项被扣（`dialog-confirm`）

打码与凭据字段：

- [ ] 20. OTP 数字不出现在 `find` / `readSubtree` / 截图 / `semantics.control.label` 任何出站帧
- [ ] 21. 密码框（state 与词表两条识别路径）同上
- [ ] 22. 截图无法定位凭据区域 → `secure-window`，无图片出站
- [ ] 23. 密码 / 验证码框的 `setValue` / `type` / `clearInput` → `credential-field-denied`；携带有效
       凭据或豁免都不解除

凭据四查：

- [ ] 24. binding 不符三方向：改参数、换 op、换会话租约 → `approval-mismatch`，不执行、不消费
- [ ] 25. 一次性：成功执行后原样重发 → `approval-used`
- [ ] 26. 过期：凭据过期（时钟前与边界两例）→ `approval-expired`，不执行
- [ ] 27. stale：批准后目标页内容或结构变化 → `approval-stale`；无关轮播滚动不 stale；
       `bindingDigest` 与 `screenDigest` 独立变化各自触发对应码
- [ ] 28. digest 稳定性：同一屏幕重复计算摘要一致；打码值参与摘要且摘要不泄露原文

类目、豁免与 busy：

- [ ] 29. `app-denied` 四面：窗口列表、树读取、动作、通知；deny 优先于 `approval-required`
- [ ] 30. 豁免生效面：只解除被豁免 App × 类目的 ask；同 App 其他类目、其他 App 仍问
- [ ] 31. 豁免不解除 deny 类目与凭据字段；断开重连后豁免清空
- [ ] 32. `device-busy`：置忙后执行类 op 全拒、`status` / `sleep` / 控制帧可用；`busy:false` 与断开解除；
       锁屏优先于 busy
- [ ] 33. 回归：`secure-window`、`device-locked`、`stale-ref`、abort 的既有语义不变

走查：

- [ ] 34. 模拟器端到端：一次「加入购物车 → 提交订单」链路——提交按钮扣下（回执带 semantics）→ 调用方
       挂起 → 置忙 → 批准后原样重发带凭据 → 四查通过 → 执行成功 → 凭据再发被拒
