## Context

`android-phone-surface` 之后，手机是一个讲 `host-relay.v2` 的 host agent：`hello` 声明 op 集，后端发
`{id, op, args}`，设备回 `{id, result | error{code, message}}`。op 处理层已有两类「先于动作的检查」：

1. **keyguard 检查**（除 `status` / `sleep` / `windows` / `url` 外每个 op）：安全锁屏回 `device-locked`。
2. **stale-ref**：`find` 返回的 ref 绑定发现时的快照，树变了就拒绝执行。

错误码已经开了「设备端语义进协议」的先例：`device-locked`（设备拒绝执行）、`secure-window`（内容不出设备）、
`stale-ref`（设备端快照失效）。本提案沿同一族扩展，不发明新机制。

一个事实约束设计：**判定素材只在设备上。** 控件 role、文案、App 包名与类目、密码框 state 都在无障碍树里；
把原始屏幕送出去再判，本身就违背「值不出站」的目标。所以判定与打码都在执行端，调用方只消费回执。

## Goals / Non-Goals

**Goals**

- 提交类动作缺省要求审批请求；判定素材（semantics）结构化出站，不含屏幕原文。
- 密码与验证码的值不出现在任何出站帧。
- 批准凭据的绑定、一次性、过期、stale 校验全部在执行端闭合，执行端不为审批保存队列状态。
- deny 类目 App 不可见；豁免只来自调用方且永不解除 deny 与凭据字段。

**Non-Goals**

见 proposal。要点：不做档位裁决、不管理豁免生命周期、不做录屏与审计、不做 OCR、不引入新 op。

## Decisions

### D1. 判定在执行端；闸放在 op 处理层，不放在任何提示或约定里

敏感闸是 op 处理层的检查序列，与 keyguard 检查同层：

```
keyguard 检查（既有，device-locked）
  → busy 检查（D7，device-busy）
  → 敏感闸（本提案：deny → 凭据字段 → 凭据四查 → ask 判定）
  → 既有 ref/动作执行
```

gated op：`click`、`invoke`、`setValue`、`type`、`clearInput`、`scroll`。`launchApp` / `focusApp` 不缺省
要求审批（打开一个 App 属导航，不是提交类；deny 类目 App 照样打不开），安装类动作发生在商店 App 的
点击上，由提交类判定覆盖。`press`（Back / Home）、读类 op 不闸。

*备选被否*：把闸放在调用方的 driver 里按工具名判档。工具名判不了「这次点击点的是什么按钮」，而且
调用方拿不到未经打码的树——判定必须贴着素材。

### D2. `approval-required` 回执与 semantics schema

命中 ask 条件时 op 不执行，回：

```
error: {
  code: 'approval-required',
  message: string,
  semantics: {
    op: string,                        // 被拦的 op
    app: { id?, name, category? },     // 包名 / bundle id、显示名、类目（类目未知则缺省）
    control?: { role, label? },        // 被点控件的 role 与打码、裁剪后的文案（≤ 64 字符）
    reasons: string[],                 // 命中的判定原因（枚举见下，开放集合）
    bindingDigest: string,             // 设备 / 会话租约 / op / 规范化参数的摘要（D3）
    screenDigest: string,              // 打码后树快照的规范摘要（D4）
    snapshotRef?: string,              // 打码截图的设备端引用（不透明句柄；FLAG_SECURE 页缺省）
  }
}
```

reasons 枚举（初版）：

| reason | 含义 |
|---|---|
| `commit-label` | 词表命中提交类 |
| `payment-label` | 提交类且词表判定为资金动作 |
| `commit-unrecognized` | 结构上是提交类候选（可点击、表单 / 确认上下文）但词表未识别——缺省从严兜底 |
| `dialog-confirm` | 屏幕在问提交类问题（「删除此消息？」），目标是对话框肯定项 |
| `message-send` | 消息 / 社交 App 里的发送（输入提交、回车） |
| `install` | 商店 App 里的安装 / 卸载类动作 |
| `setting` | 系统设置的更改 |
| `call` | 呼叫类 |
| `link-leave-app` | 打开离开当前 App 的链接 |
| `app-category-ask` | 类目表把该 App 的此类动作标为 ask |

reasons 是**开放集合**：调用方对不认识的 reason 按 ask 处理。帧里没有屏幕原文、没有控件树、没有
凭据值——`control.label` 来自打码后的树，且裁剪到固定上限。

`approval-required` 与 `device-offline` 同族：动作没有发出，调用方可以挂起等审批、批准后重发同一次
调用。没有挂起机制的调用方把它当普通失败即可。

### D3. 批准凭据与执行前四查

调用方批准后按审批里记录的参数**原样重发**同一次调用，调用里多带一个调用方填的字段：

```
args.approval = {
  id: string,            // 审批请求的 id（调用方生成）
  bindingDigest: string, // 回执 semantics.bindingDigest 的原样回传
  screenDigest: string,  // 回执 semantics.screenDigest 的原样回传
  expiresAt: number,     // 过期时刻（epoch ms）；时长由调用方配置，执行端只比对时刻
}
```

执行端在任何动作前自校，任一不过即拒绝、不执行：

| 检查 | 错误码 | 语义 |
|---|---|---|
| 过期 | `approval-expired` | `expiresAt` 已过执行端时钟 |
| 绑定 | `approval-mismatch` | 重算 `digest(设备, 会话租约, op, 规范化参数)` ≠ `bindingDigest`——换设备、换会话、换 op、改参数任何一个都作废 |
| 一次性 | `approval-used` | 该凭据 id 已消费过；一个批准只执行一次动作 |
| stale | `approval-stale` | 执行前重读树、重算屏幕摘要 ≠ `screenDigest`——批准之后屏幕变了，什么都不做 |

 digest 由执行端计算（素材在设备上），调用方只透传、不解释，避免两边规范化规则漂移。binding 用**会话
租约**而不是 WS 连接 id：审批挂起期间设备可能重连，租约不变（`android-phone-surface` 的每设备租约语义）。

**执行端不保存审批队列。** 校验所需的全部素材都在凭据里；执行端只维护一个已消费凭据 id 的有界集合
（进程生命周期内），连接断开不清空、设备重启即清——重启后凭据照常按绑定与 stale 校验拒绝不了的情况
由 stale 与绑定兜住，一次性在这台设备的本次开机内成立。无凭据的 ask 命中回 `approval-required`；带了
凭据的非 gated op 照常执行，凭据被忽略。

*对齐先例*：Pinky 的批准是「单次 id，绑定 session + device + lease + tool + 参数 digest」，Allow 后重查
屏幕再执行（stale）、审批期间冻结设备、参数换一个就作废——四查即这四条的中性化改写（pinky
`internal/approval/approval.go` 头注、`internal/gateway/pipeline.go`）。

### D4. 屏幕摘要（快照签名）

`screenDigest` = 执行端对**打码后**的无障碍树快照做的规范摘要（SHA-256，序列化与舍入细则随批次 B 实现
定死并写入测试）：按遍历序取每个可见元素的 role、class、舍入后的 bounds、打码后的文本与 resource id。
特性：

- 由打码后的值计算——打码是确定性的，摘要才稳定，且摘要本身不泄露值。
- 目标附近的内容或结构变化必变（stale 生效）；屏幕别处的纯动画不变（对齐 `stale-ref` 的轮播豁免口径）。
- `bindingDigest` 只绑参数，`screenDigest` 只绑屏幕；批准后参数不变而屏幕变 → `approval-stale`。

### D5. 读取层打码

打码在读取层完成：值一旦进入出站帧就晚了。规则：

- **凭据字段识别**：输入框带密码 state，或其标签 / resource id 命中密码词或验证码词（验证码词受排除项
  约束——促销码、邮编、区号不算）。
- **树读取**（`find` / `readSubtree`）：凭据字段的文本与标签一律替换为固定掩码；凭据字段附近的验证码
  数字序列一并掩码（「您的验证码是 482913」→「您的验证码是 ••••••」）。
- **截图**：被识别元素的显示区域打上覆盖；执行端无法保证覆盖完整时不回图，回 `secure-window`——与
  FLAG_SECURE 同一个口径：拿不准的内容不出设备。
- **回执**：`approval-required` 的 `semantics.control.label` 来自打码后的树。

对齐先例：`secure-window` 已经确立了「内容不出设备」；打码是同一原则在凭据字段上的前置化。

### D6. App 类目表与 deny；词表与兜底

**类目表**：`finance`、`passwords`、`messaging`、`social`、`stores`、`browsers`、`phone`、`settings`、
`system`、`blocked`（对齐 Pinky `apps.yaml` 的类目集合）。deny 类目缺省 = `finance`、`passwords`、
`blocked`（用户手动拉黑）。deny 的语义是**整个 App 不可见**：`windows` 看不到它、`find` / `readSubtree`
读不到内容、一切动作回 `app-denied`、通知不出现。豁免永不解除 deny。

**可见性档位**（执行端只区分这两档，档位之上的产品语义归调用方）：

| 档 | 语义 |
|---|---|
| deny（不可见） | `app-denied`，读不到屏 |
| 可见 | 类目 ask 的动作与提交类动作要求审批；其余照常 |

**词表**：提交动词 / 短语、CJK 前缀、资金词、安装、呼叫、设置、肯定词、密码词、验证码词及排除项，
覆盖 11 种 UI 语言（英、简中、繁中、日、韩、西、法、德、葡、意、俄）。表以数据文件随 Stream 版本发布；
摘自 Pinky（Apache-2.0，DIYgod/pinky）的部分在 `NOTICE` / `THIRD-PARTY-NOTICE` 登记出处与许可证。

**兜底（命中 / 漏报）**，按优先级：

1. **结构信号优先于词表**：role（可点击按钮）、输入框 state（密码 / 可编辑）、上下文（表单最后一控件、
   确认对话框）。词表只是文本维度，图标按钮、图片按钮靠结构命中。
2. **未识别升档**：结构上是提交类候选而词表未识别 → `commit-unrecognized`，照样要求审批。宁可多问一次。
3. **类目兜底**：未知类目 App 的提交类候选照走第 2 条；类目命中 deny 直接不可见。
4. **排除项防误报**：「Order history」「sort by」、价格与日期不算提交；误报的代价是一次多余的审批，
   漏报的代价是动作绕过闸——表向命中倾斜（Pinky 同款取舍）。

**如实声明残余风险**：非常规文案 + 非标准控件的提交可能穿过词表与结构信号，此时只剩类目表与缺省从严
兜底，无法闭合到零；Pinky 对此同样承认（其 README FAQ 原话「an unusual one could slip through」）。

### D7. 置忙（device busy）

审批未决期间，调用方用控制帧 `setBusy { busy: boolean, reason? }` 把执行端置忙。置忙期间：

- 除 `status`、`sleep` 与控制帧（`setBusy`、豁免下发）外，一切 op 回 `device-busy`；`message` 带 reason。
- `status` 照常（调用方与用户需要看到设备活着、忙与否）。
- `busy: false` 解除；连接断开自动解除（调用方不再在，忙无从维持）。
- 执行端不推断忙的时长、不自动过期——忙什么时候结束是调用方的审批语义。

busy 检查在 keyguard 检查之后（锁着的手机先回 `device-locked`），在任何其他检查与动作之前。

### D8. 错误码对照：新增与既有先例

新码全部落在既有族里——错误封装 `{code, message}` 不变，语义按族对齐：

| 新码 | 族 / 先例（出处） | 与先例的关系 |
|---|---|---|
| `approval-required` | `device-offline`（`device-execution`：未发出任何动作、可挂起恢复重跑） | 同族：动作未发出，等批准后原样重发 |
| `approval-expired` | `device-locked`（`android-recipe-replay`：先于一切动作的硬检） | 同层：凭据硬检，先于任何动作 |
| `approval-mismatch` | 同上（先于动作的硬检） | 绑定不符即拒绝，不执行 |
| `approval-used` | 同上 | 同层 |
| `approval-stale` | `stale-ref`（`android-recipe-replay`：ref 绑定发现时快照，树变即拒） | 兄弟码：`stale-ref` 管 ref 新鲜度，`approval-stale` 管批准时刻到执行时刻的屏幕变化 |
| `credential-field-denied` | `secure-window`（内容不出设备）+ `device-locked`（不可协商的硬检） | 凭据字段不可写，任何审批与豁免不可解除 |
| `app-denied` | `secure-window`（内容不出设备） | 同原则的 App 级前置化：deny 类目整体不可见 |
| `device-busy` | `device-locked`（先于动作拒绝） | 同层：置忙期间拒绝执行类 op |

既有的错误码全部不变：`device-locked` / `secure-window` / `blocked-by-os` / `stale-ref` / `aborted` /
`device-offline` / `device-lost` / `device-incapable` / `host-not-allowed` / `private-target` 等
（`android-phone-surface`、`device-execution`）。

## Risks / Trade-offs

- **执行端时钟漂移**：`expiresAt` 按执行端时钟比对，设备时钟不准会让凭据提前失效或晚失效。缓解：文档
  写明凭据以执行端时钟为准、调用方应留余量；不做时钟同步（超出范围）。
- **词表漏报无法闭合到零**：D6 第 4 条如实声明。缓解：结构信号 + `commit-unrecognized` + 缺省从严三
  层兜底；漏报样例进批次 B 测试清单，随版本补词表。
- **打码误伤**：验证码词表可能把普通数字文本掩掉（如页面同时显示订单号）。缓解：排除项 + 上下文
  （邻近元素是否在谈验证码）约束；误伤只损失信息，不损失安全。
- **digest 规范化漂移**：`screenDigest` 的序列化细则一旦实现定死，App 更新不得改变既有快照的摘要值，
  否则存量凭据集体 stale。缓解：细则进测试快照；升级改变摘要时按大版本处理。
- **busy 误挂**：调用方崩溃在置忙态会把设备冻住到重连。缓解：连接断开自动解除（D7）；`status` 始终可
  用，用户在设备上能看到状态。
- **一次性集合在设备重启后清空**：D3 的取舍——持久化凭据状态引入存储面，重启窗口的绕过面由绑定与
  stale 兜住；如评审认为不够，可升级为持久化（列为 Open Question）。

## Open Questions

- `setBusy` / 豁免下发的控制帧走 `hello` 之后的带外帧还是 op？建议带外控制帧（与 `abort` 对称，不占
  op 集），批次 B 定帧格式。
- `snapshotRef` 的取图机制：调用方拿引用后通过什么通道取打码图（新 op？带外接口？）——审批卡片展示
  的事，批次 B 定；本提案只定引用的存在性与 FLAG_SECURE 页缺省。
- 一次性凭据集合是否要持久化（见 Risks 最后一条）。
- 已消费凭据 id 集合的容量与淘汰策略（批次 B 定；建议 LRU，容量以一次挂起会话的审批量为量级）。
