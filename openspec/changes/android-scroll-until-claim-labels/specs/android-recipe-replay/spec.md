## ADDED Requirements

### Requirement: scroll 的有界 until 模式

`scroll` 的参数带非空字符串 `until` 时（能力 `ui.tree` v4），执行端 SHALL 一次只滑一步，每步之后重新读
目标窗口（有 scope 用 scope 的窗口，否则前台窗口），直到某个可见节点的 name 或 text 包含 `until`
（大小写不敏感），或在下列先到者处停止：连续两次滑动后窗口内的内容指纹不变（到顶/到底）、已滑次数达到
`maxSteps`、已用时长达到 `timeoutMs`、或窗口消失。`maxSteps` SHALL 缺省 20、上限 50；`timeoutMs` 缺省
15000 ms、上限 60000 ms；越界 SHALL 夹到边界内。两个上限 SHALL 在两步之间检查——进行中的一步会走完，
再返回。未给 `until`（或为空串）时，`scroll` 的行为、`amount` 语义与回执 SHALL 与 v3 完全一致；给了
`until` 时 `amount` SHALL NOT 参与（每次一步是判定所必需）。

回执 SHALL 带 `found`（布尔）与 `scrolls`（本次实际执行的滑动步数），找到时带
`match: {name, role, rect}`（name 打码并裁剪），未找到时带 `stopped`（`end` / `steps` / `time` /
`no-window`）与 `visible`（停止时屏幕上最多五个可见标签，打码、裁剪，按文档顺序取末尾）。回执 SHALL NOT
让调用方靠自己的 op 超时来判断结果。

#### Scenario: 目标在滚动后出现
- **WHEN** 调用方发 `scroll {dir: "down", amount: 1, until: "排序", maxSteps: 10}`
- **THEN** 执行端逐步滑动，第二步后屏幕上出现「排序」，回执是 `{found: true, scrolls: 2, match: {name: "排序", …}}`
- **AND** 不会继续滑到 `maxSteps`

#### Scenario: 已经可见就不滑
- **WHEN** `until` 指定的文字在滑动前就已经是可见节点的 name 或 text
- **THEN** 回执是 `{found: true, scrolls: 0, match: …}`，没有发出任何滑动动作

#### Scenario: 到底就停，别让调用方超时
- **WHEN** 目标一直不出现，两次连续滑动后窗口内容指纹相同
- **THEN** 回执是 `{found: false, scrolls: n, stopped: "end", visible: […]}`，滑动在此停止

#### Scenario: 次数与时长上限取先到者
- **WHEN** 目标一直不出现，而内容每步都在变
- **THEN** 到 `maxSteps`（缺省 20）回 `stopped: "steps"`，到 `timeoutMs`（缺省 15000 ms）回 `stopped: "time"`，以先到者为准

#### Scenario: 窗口消失
- **WHEN** 滑动途中被限定的窗口不在了
- **THEN** 回执带 `found: false` 与 `stopped: "no-window"`，SHALL NOT 继续空转

### Requirement: windows 标注应用无响应对话框

`windows`（能力 `ui.tree` v4）遇到系统的「应用无响应」（ANR）对话框时 SHALL 把该行标成
`type: "system"` 并带 `anr: true`。能拿到弹窗针对的应用包名时 SHALL 带 `appPackage`（包名字符串），
拿不到时 SHALL 省略该字段。识别 SHALL 不依赖单一语言：AOSP 对话框按钮的 `android:id/aerr_*` 资源 id，
或弹窗标题/消息里的无响应词（中英日韩及常见西语/法语/德语/意大利语/俄语）任一命中即可。执行端 SHALL
NOT 自动点击 ANR 对话框的任何按钮，SHALL NOT 把 ANR 当成普通应用窗口执行动作。

#### Scenario: 系统 ANR 弹窗
- **WHEN** 前台弹着「微信没有响应」的系统对话框，调用方执行 `windows`
- **THEN** 该行带 `type: "system"`、`anr: true`，能确定时还带 `appPackage: "com.tencent.mm"`
- **AND** 回执里没有对对话框按钮的点击

#### Scenario: 普通系统窗口
- **WHEN** 前台是通知栏或音量面板，没有无响应标记
- **THEN** 该行照旧是 `type: "system"`，不带 `anr` 与 `appPackage`
