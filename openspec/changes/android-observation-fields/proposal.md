# android-observation-fields

## Why

嵌入方在动态页面（轮播、倒计时、轮换的搜索框提示词）上驱动真机时，设备端给的事实不够用：

- **读不出来**：输入框里显示的是提示词还是用户输入、控件可不可编辑、resource id 是什么，`find`
  都不给；`windows` 不分窗口类型与层级，分不清应用窗口、键盘和无障碍悬浮层；两次读屏之间屏幕
  多大（viewport）也无处可查。
- **ref 太脆**：每次 `find` 整代作废——读一次屏、再读一次，同一颗按钮换了 ref；动态页面上 ref
  一到动作时就 `stale-ref`，调用方只能盲目重 `find`。设备端明明有能力认出「还是同一颗按钮」。
- **动作后不知道界面稳没稳**：回执只有 `via`（和给了 `expect` 时的 `confirmed`）；调用方想等
  界面停稳只能自己 `sleep` + 重读，倒计时页一睡就过头。

开源项目 Mika（Apache-2.0，github.com/wangzan101/Mika）在 `core/uistate`（`RefStabilizer`、
`Accuracy`、`ScreenSession`、`InterfaceUpdate`）与 `app/.../a11y`（`ScreenReader`、`ChangeWait`）
里对这套问题有成熟做法：跨读屏的稳定元素编号、按（角色 + 名字 + 资源 ID）唯一性找回、
「页面基本不动」时的放宽匹配、事件安静 + 树哈希的静默等待。本 change 只借鉴其**设计**
（匹配条件、放宽规则、静默等待的状态机与常量档位），不拷代码；实现落在 Stream 自己的
`agent` 层类型上。

## What Changes

- **`find` 元素补字段**（能力 `ui.tree` 升到 `v: 3`）：可带 `hintText`（提示词，非空才带；凭据
  字段不带）、`isShowingHintText`（正在显示提示词：系统标记为真，或 text 与提示词相同）、
  `viewId`（resource id，混淆 id 过滤掉）、`editable`。混淆 id 过滤规则：resource 段（最后一个
  `/` 之后）须匹配 `^[A-Za-z0-9_]{4,}$` 且含连续 3 个英文字母，否则不报。
- **`find` 与 `windows` 回执带 `viewport`**（`{width, height}`，屏幕尺寸）；`windows` 每行带
  `type`（`application` / `input` / `system` / `accessibility_overlay`）与 `layer`（z 序）。悬浮层
  与键盘窗口从此也列出（带类型），但 `foreground` 永不为真，`scopeWindow` 仍只认应用窗口。
- **ref 跨读稳定**：ref 不再「一次 find 整代作废」。后续读里认得出「同一个控件」的，沿用原 ref：
  条件是身份键（role + 身份名 + viewId）在新旧两读里都唯一、同一窗口、自上次看到它起该区域没有
  变化事件、中心位移不超过屏幕短边的 15%（列表项还须原地 ≤2%；可滚动容器内的元素滚动过后一律
  不再沿用）。输入框的身份名是提示词（值会变，不算身份）。认不出的一律发新 ref；ref 编号单调
  递增，退役的编号永不复用。
- **stale 错误分型**：`stale-ref` 错误帧带 `code: "stale-ref"` 与 `semantics: {kind, ref}`，
  `kind` ∈ `snapshot_unknown`（ref 格式不认识或编号没发过——连接重启后的旧引用）、
  `ref_not_in_snapshot`（编号发过但已不在保留表里——被淘汰）、`ref_retired`（ref 还在表里但绑的
  scope 或窗口已经不对）、`element_moved`（ref 与窗口都对，但节点不在原地且找回失败——滚动过
  它所在的列表、或页面上认不出它）。经既有结构化错误通道（错误帧 `code`/`semantics` →
  `HostOpError.semantics` → 管理口 502 body）透传。
- **动作时找回（relocate）**：ref 对应节点不在原地时，先在最新树里按身份键找唯一匹配（唯一性、
  上下文一致、位移 ≤15%）；页面「基本不动」（前后都唯一的有名元素 ≥2 个、其中八成以上原地
  ≤2%）时放宽：同一 viewId、同一位置、名字只差数字（倒计时）或名字来自轮换提示词的，仍算同一
  控件；换了含义的名字（关注→已关注）不算。找回成功就继续动作，回执带 `relocated: true`。
  **安全闸不放宽**：带审批凭据的动作不找回（凭据绑定的是批准时的屏幕，找回换目标等于绕过
  `approval-stale`）；ask 闸照常对找回后的目标做判定。
- **动作后静默等待**：gated 动作（`click`/`invoke`/`setValue`/`type`/`clearInput`/`scroll`/
  `press`）之后等「无障碍事件安静 ≥450ms 且控件树指纹已变化」即完成，封顶 2.5s（事件一直来的
  页面——倒计时、进度条——不会卡住；始终没变的等到封顶按没效果收尾）。回执带 `settled`、
  `changedDuringRead`，并可带 `effect`（`done` / `small_change`（只有数字变化的改名）/
  `no_effect` / `place_changed`（同一批控件挪了位置））；`expect` 的 `confirmed` 改在等待结束后
  判。`press` 的 Back/Home/Enter 也走同一等待。
- **向后兼容**：全部是新增可选字段与新增可选键；旧调用方不读它们，行为不变。行为变化只有两处
  是有意为之并在 spec 里改写：ref 不再随一次新 `find` 整代作废；动作回执多出的键。

## Capabilities

### Modified Capabilities

- `android-recipe-replay`：find/windows 回执字段（ADDED）、ref 跨读稳定与找回（MODIFIED 原有的
  「ref 只在找到它的那一屏有效」）、stale 分型、动作后静默等待（ADDED）。
- `embeddable-device-gateway`：`HostOpSemantics` 新增 stale 分型回执形状（`{kind, ref}`）。

## Impact

- `app/android/agent/src/main/java/com/streamapp/android/agent/`：`UiNode`（hintText /
  isShowingHint）、`RefTable`（跨读保留表 + stale 分型）、新文件 `Stability.kt`（身份键、找回、
  stationary、effect 分类）、`Dispatcher`（find/windows 回执、resolveRef 找回、settle 静默等待、
  能力版本）、`Device`（`lastA11yEventMs`、`scrolledSince`、`WindowInfo.type/layer`）、
  `ChangeLog`（事件时刻、滚动判别）。
- `app/android/agent/src/main/java/com/streamapp/android/a11y/`：`NodeAdapter`（hint 字段）、
  `AndroidDevice`（窗口 type/layer、事件时刻、滚动判别）、`StreamAccessibilityService`（喂事件
  时刻）。
- TS 侧：`src/replay/desktop-driver.ts`（`A11yElement` 等类型）、`src/http/host-relay.ts`
  （`HostOpSemantics` 增加 stale 分型形状）。
- `docs/API.md`：windows/find 字段、ref 生命周期、stale 分型、静默等待回执。
