## Purpose

看一眼、并操作活着的界面：统一的 target 语法覆盖浏览器标签与原生窗口，四个动词语义同形，做完确认（expect）跨 target 一致，够不着时显式失败且原因可诊断。

## Requirements

### Requirement: 统一的 target 语法覆盖浏览器与原生窗口

「看/动此刻活着的界面」的四个动词（`cdp_look` / `cdp_shot` / `cdp_act` / `cdp_pages`）SHALL 共用
一个 `target` 字符串选面，取值为以下六档之一：`chrome`（随手开一个 URL）、`chrome:<tabId>`（已开
着的 tab）、`facility:<name>`（某 facility 正在采集的那一页）、`webview`（桌面端自己的 WebView2）、
`desktop`（当前前台的原生窗口）、`app:<process>[/<title>]`（按进程定位原生窗口，可选标题消歧）。

未知 scheme SHALL 报 `unknown target scheme '<x>'`，不得回退到任意默认面。某个动词对某档 target
不适用时（如 `cdp_act` 对 `webview`）SHALL 显式报错，不得静默空转。

`app:` 的标题匹配 SHALL 为**包含**语义而非全等——真实窗口标题带动态前后缀，全等匹配在活体上
几乎必然落空。

#### Scenario: 按进程 + 标题定位到唯一窗口
- **WHEN** 同一进程开着多个窗口（如 Chrome 同时有主窗口与账户选择器），调用方给出
  `target: 'app:chrome.exe/扩展程序'`
- **THEN** 动词作用于标题包含「扩展程序」的那个窗口，不作用于同进程的其他窗口

#### Scenario: 只给进程且存在多窗口
- **WHEN** 调用方给出 `target: 'app:chrome.exe'` 而该进程有多个可见窗口
- **THEN** 返回一个指明"多窗口歧义"的错误并列出候选窗口标题，MUST NOT 任选一个继续执行

#### Scenario: 未知 scheme 不回退
- **WHEN** 调用方给出 `target: 'cloak:xhs'`（已退役的写法）
- **THEN** 报 `unknown target scheme 'cloak'`，不落到任何默认 target 上

### Requirement: 四个动词对原生窗口的语义与浏览器侧同形

对 `desktop` / `app:` 两档 target，四个动词 SHALL 提供与浏览器档语义对应的能力：`cdp_look` 读
a11y 子树（按 `{role, name}` 之类的结构化 query 返回元素及其屏幕矩形），`cdp_shot` 返回截图，
`cdp_act` 提供 `click` / `type` / `scroll` / `focus` / `invoke`，`cdp_pages` 枚举可寻址的窗口
（进程、标题、是否前台）。

`cdp_pages` 对原生窗口 SHALL 返回足以直接构造 `app:<process>/<title>` 的字段——枚举的用途就是
让调用方"认出目标再动手"，返回一份认不出目标的清单等于没有。

#### Scenario: 枚举窗口再定位
- **WHEN** 调用方对 `target: 'desktop'` 调 `cdp_pages`
- **THEN** 返回当前可寻址窗口列表，每项含进程名、窗口标题与是否前台，据此可直接拼出该窗口的
  `app:` 地址

#### Scenario: 读 a11y 子树
- **WHEN** 调用方对某原生窗口调 `cdp_look`，query 为 `{role:'Button'}`
- **THEN** 返回该窗口 a11y 树中匹配的元素及其屏幕矩形

### Requirement: 做完确认（expect）跨 target 一致

`cdp_act` 的 `expect` SHALL 在所有 target 上同语义、同返回字段：动作执行后回读，命中返回
`confirmed`，未命中返回 `acted-unconfirmed`。对原生窗口，`expect` 取 a11y query（与该档
`cdp_look` 同一种 query 语言），不是 CSS 选择器。

#### Scenario: 动作后确认预期出现
- **WHEN** 调用方 `cdp_act` 点击某按钮并给出 `expect: {role:'Text', name:'已保存'}`
- **THEN** 回读命中则返回 `confirmed`，未命中则返回 `acted-unconfirmed`（**而不是笼统的成功**）

### Requirement: 原生窗口的前台确权按实际走的那条路判定

原生 actuation 有两条物理上不同的路，前台要求 SHALL 按路分别判定，MUST NOT 一刀切：

- **元素句柄直达（invoke）**：收件人是 UIA 元素本身，不算屏幕坐标、不受遮挡影响。这条路
  MUST NOT 要求前台，也 MUST NOT 主动抢前台——抢屏在这里纯属副作用，而"人不在时后台干活"
  正是这条链路的主要用途，半夜的定时采集不该把用户的屏幕夺过去。
- **坐标输入**（元素没有句柄退回的坐标点击，以及 `type` / `scroll`）：投给**屏幕**，谁在
  上面谁收下。这条路 SHALL 在动作**之前**取得并回读确认前台，取不到时 SHALL 报错且
  MUST NOT 发出任何输入。

`cdp_act` 的回执 SHALL 带 `via` 字段如实报出走的哪条路（`invoke` / `coords`），实现
MUST NOT 在拿不准时猜一个值。理由：这个分支从调用方看是隐形的，而**锁屏时行不行恰恰取决
于它**——不报出来，调用方解释不了自己拿到的结果。`via` 与 `confirmed` 是两件事：前者说
走了哪条路，后者说效果验没验、兑没兑现；`confirmed` 三态不变（没给 `expect` 就没有该字段）。

#### Scenario: 锁屏下 invoke 照常且如实报路
- **WHEN** 桌面处于锁屏状态，调用方 `cdp_act` 点击一个定位得到原生句柄的元素（活体
  2026-08-02：锁屏 + Chrome 在后台，切标签页）
- **THEN** 动作照常执行，回执带 `via: 'invoke'`，全程不曾 `focusApp`

#### Scenario: 退回坐标时才确权，锁屏下被拒
- **WHEN** 定位到的元素没有原生句柄，实现退回坐标点击，而此刻取不到前台
- **THEN** 返回指明"未能取得前台"（锁屏时为"桌面已锁屏"）的错误，MUST NOT 向屏幕坐标
  发出任何输入

#### Scenario: 后台标签的 a11y 树不构成可点判据
- **WHEN** 浏览器某后台标签的内容在 a11y 树中可读，调用方据此对其中元素发起**坐标**点击
- **THEN** 该点击 MUST 经前台确权：目标不是当前活动标签时报错，而不是把点击落到活动标签上

### Requirement: invoke 按控件 pattern 逐级降级，全败才报错

原生 `invoke` SHALL 依次尝试 Invoke → SelectionItem → Toggle → LegacyIAccessible 默认动作，
任一级成功即返回；全部失败时 SHALL 报错并**列出各级各自的失败原因**。

理由是活体撞出来的（2026-08-02）：只认 InvokePattern 一种时，点 Chrome 标签页（SelectionItem
控件）必然失败，而该错误经 Win32 格式化后是「操作成功完成。」（`ERROR_SUCCESS` 的文本）——
一条**比失败更误导**的错误信息。一个只会一种 pattern 的 invoke，会把"这个控件用的是别的
pattern"错报成"点了但没反应"。

#### Scenario: SelectionItem 控件在第二级成功
- **WHEN** 调用方 invoke 一个 Chrome 标签页元素（它不实现 InvokePattern，实现 SelectionItem）
- **THEN** 第一级失败后自动降到 SelectionItem 并成功，回执 `via: 'invoke'`

#### Scenario: 全部 pattern 都不支持
- **WHEN** 目标元素四级 pattern 全部不可用
- **THEN** 报错并逐级列出失败原因，MUST NOT 返回成功、MUST NOT 只透传最后一级的 Win32 文本

### Requirement: a11y query 的 role 认不出时报错，不静默放行

`cdp_look` / `cdp_act` 的 a11y query 中，`role` 取值 SHALL 映射到具体控件类型；映射不到时
SHALL 报 `unknown role '<x>'` 并中止，MUST NOT 把该条件当没写。

理由：过滤条件静默失效比没有过滤更危险——查询会照常返回一批"看起来对"的元素，而第一名
可能是完全不同的控件，`cdp_act` 会把它直接执行掉（活体 2026-08-02：`{role:'TabItem'}` 返回
了一个 Button）。

#### Scenario: 未知 role 中止而不是放行
- **WHEN** 调用方给出 `{role:'TabItem'}` 而实现的 role 表里没有这一项
- **THEN** 报 `unknown role 'TabItem'`，MUST NOT 忽略 role 条件返回其它控件类型的元素

### Requirement: `cdp_act` 的 `kind:'open'` 在浏览器里 find-or-open 一张标签

`chrome` 档 SHALL 提供 `kind:'open'`：输入一个 `targetUrl`，输出一张标签。它是该档**唯一不要
`tabId`** 的动作（要 tabId 就成了先有鸡后有蛋——tabId 正是它的产出）。

- 语义 SHALL 为 find-or-open：已开着同一页（尾斜杠不计、scheme/host 大小写不敏感、query/hash
  照算）则激活并抬窗，否则新建。
- 它 MUST NOT 挂 debugger、MUST NOT 注入脚本、MUST NOT 入会话组。正因如此 `chrome://*`
  这类特权页在这里开得了（`cdp_look({target:'chrome',url})` 是「开 + attach + eval」焊死的
  一件事，对特权页会在 attach 一步炸掉、还留下没人管的空窗口）；也正因如此它开出来的页
  **不可驱动**。
- 回执 SHALL 为 `{tabId, title, url, created}`，其中 `title` 是通往原生档的**桥**：Chrome
  窗口标题形如「<页面标题> - Google Chrome」，据此可直接拼出 `app:chrome.exe/<title>` 用
  a11y 驱动这张特权页。页面 ~2s 内没给出标题时 `title` 回空串，但该字段一定在。
- 它 MUST NOT 走高危确认门：开一张新标签与 `cdp_look({target:'chrome', url})` 同级，而后者
  从来不设门；`goto` 的跨站门管的是"把一个**已有** tab 劫持到别的站"，开新标签没有那件事
  里被夺走的东西。

#### Scenario: 开特权页并接上原生驱动
- **WHEN** 调用方 `cdp_act({target:'chrome', kind:'open', targetUrl:'chrome://version'})`
- **THEN** 返回 `{tabId, title, url, created}`（活体 2026-08-02：`title` 为「关于版本」），
  据此拼 `app:chrome.exe/关于版本` 一发命中该窗口，后续 `cdp_look` / `cdp_act` 走 a11y 驱动它

#### Scenario: 同一页已开着则不新建
- **WHEN** 目标 URL 的标签已经开着（仅尾斜杠或 scheme 大小写不同）
- **THEN** 激活该标签并抬窗，回执 `created: false`，MUST NOT 再开一张

### Requirement: 唤起应用与打开页面必须有回执，禁止从 shell 起 GUI 程序

这条链路上，唤起一个应用 SHALL 走 `ensureApp`、打开一个页面 SHALL 走 `kind:'open'`。
MUST NOT 从 shell / bash 启动 GUI 程序（如 `chrome.exe`）。

理由：**没有回执的动作不该存在**。从 shell 起 GUI 只知道"进程退了"，起没起来、起出了哪个
窗口、是不是复用了已有实例，全都不可知——失败也不可知（活体 2026-08-02 真造成过两个孤儿
空白窗口，没有任何一步能发现）。两个原语都带回执，正是为了让「打开 → 拿到窗口 → find/invoke」
每一步都有判据。

#### Scenario: 需要一个 GUI 应用在跑
- **WHEN** 调用方需要某桌面应用处于运行状态
- **THEN** 调 `ensureApp` 并读它的回执，MUST NOT 用 shell 命令启动该程序

### Requirement: `ensureApp` 回执带这次开出来的窗口（拿得准才带）

`ensureApp` SHALL 在 spawn 前拍一份窗口快照、spawn 后轮询 diff，若**恰好**出现一个属于目标
进程的新窗口则在回执里带上它；零个或多个都 MUST NOT 带该字段。

理由：只报 pid 的话下一步只能猜窗口标题，而真实标题带动态前后缀，猜出来的
`app:<process>/<title>` 地址十有八九指不中。**指错一个比不给更坏**——调用方会拿着一个看似
合法的地址去驱动别的窗口。

#### Scenario: 恰好开出一个新窗口
- **WHEN** `ensureApp` 启动了目标进程，轮询期内恰好出现一个属于它的新窗口
- **THEN** 回执带 `window`，调用方据此直接拼出 `app:` 地址，无需猜标题

#### Scenario: 拿不准时不猜
- **WHEN** 轮询期内没有新窗口出现，或出现了多个都属于该进程
- **THEN** 回执**没有** `window` 字段，MUST NOT 任选一个带回

### Requirement: 原生截图首选按窗口句柄截，落回抓屏时语义不同

`cdp_shot` 对 `desktop` / `app:` 档 SHALL 首选按**窗口句柄**截图（命令窗口把自己的内容画进
离屏位图，对 DWM 合成的窗口强制出全帧），使得目标窗口被遮挡、在后台、或桌面锁屏时截回的
仍是**该窗口本身**；该路径任一步失败才 SHALL 落回抓屏。

理由：抓屏截的是"屏幕上此刻盖着什么"，不是"这个窗口长什么样"。两者混为一谈会让一张锁屏
壁纸被当成"窗口没渲染"的证据——它其实什么也证明不了（活体 2026-08-02 真误导过一轮诊断）。
落回抓屏时宁可给一张"盖着别的东西"的屏，也 MUST NOT 报一张全黑并声称那是窗口。

#### Scenario: 窗口被遮挡或在后台
- **WHEN** 目标窗口不在最前，调用方 `cdp_shot`
- **THEN** 返回该窗口自身的画面，而不是盖在它上面的那个窗口

### Requirement: 桌面不可用时显式失败且原因可诊断

原生窗口档不可用时，SHALL 返回可区分的具体原因，MUST NOT 静默成功、MUST NOT 只透传底层错误
字符串：host agent 未连接、目标窗口不存在、多个窗口都匹配、还没确立目标、目标窗口无法取得前台。

**锁屏 MUST NOT 成为一道闸门**，只作为「无法取得前台」的**原因说明**。理由是实测出来的
（2026-08-01）：

- 锁屏状态下 UIA `invoke` **照常生效**（活体：锁着屏把 bilibili 画中画开了又关，两次都成）。
  把它禁掉等于用户一锁屏、定时桌面采集就整体停摆——而"人不在时后台干活"正是这条链路的
  主要用途。
- 而且可用的锁屏判据并不可靠：`OpenInputDesktop` 查输入桌面名在锁屏下 **8 次采样恒为
  `Default`**（从未报告过锁定），`LogonUI.exe` 是否存在**时有时无**。以它们为闸门，
  拦不拦全凭偶然。

真正需要保护的是**坐标输入**，而它已由前台校验天然挡住：锁屏时没有任何应用窗口能取得前台。
因此当无法取得前台时，实现 SHALL 判断此刻前台归谁，若为锁屏界面则报"桌面已锁屏"，否则报
"未能取得前台"——**两者指向相反的下一步**（去解锁 / 让用户切窗口），混为一谈等于没有诊断。

**「读得到」不蕴含「点得动」** 仍然成立且 SHALL 可表达：`cdp_look` 成功而 `cdp_act` 被拒是
合法状态，两个动词的可用性独立判定。

**锁屏还有一条与闸门无关的边界：渲染缺席**（活体 2026-08-02）。锁屏时 a11y 读**已经物化的**树、
invoke **已经物化的**元素都照常；但浏览器 renderer **对从没渲染过的页面不出帧，锁屏期间也不会
补画**——没渲染过的网页内容在 a11y 树里根本不存在，四种点击路径都无米之炊。这**不是一道闸门**，
没有任何错误码对应它：`find` 只是查无此元素。诊断 SHALL 可用窗口截图作证（见窗口句柄截图那条：
截回的是窗口真容，浏览器 UI 全在而页面内容区空白，一张图就把"renderer 没出帧"钉死成看见的事实）。

#### Scenario: 锁屏时读照常，坐标输入被拒且说清原因
- **WHEN** 桌面处于锁屏状态，调用方先 `cdp_look` 读某窗口的 a11y 树、再 `cdp_act` 发起坐标点击
- **THEN** `cdp_look` 正常返回元素；`cdp_act` 因取不到前台而拒绝，且原因指明"桌面已锁屏"

#### Scenario: 锁屏不阻断原生 invoke
- **WHEN** 桌面处于锁屏状态，调用方 `cdp_act` 点击一个 a11y 可 invoke 的元素
- **THEN** 该动作 SHALL 照常执行（定时桌面采集不因用户锁屏而停摆）

#### Scenario: 锁屏下切到从未渲染过的页面，读不到页面内容
- **WHEN** 桌面处于锁屏状态，调用方 invoke 切到一个**本次会话从未显示过**的页面（活体
  2026-08-02：`chrome://extensions`），随后 `cdp_look` 找页面里的元素
- **THEN** 切换动作本身成功（`via:'invoke'`），但页面内容元素在 a11y 树中不存在；这
  MUST NOT 被解读为闸门拦截或动作失败——`cdp_shot` 截回的窗口画面里浏览器 UI 全在、内容区
  空白，即为 renderer 未出帧的证据

#### Scenario: 普通窗口抢占前台不报成锁屏
- **WHEN** 目标窗口取不到前台，而此刻前台属于一个普通应用窗口
- **THEN** 返回"未能取得前台"，MUST NOT 报成"桌面已锁屏"

#### Scenario: agent 未连接
- **WHEN** host agent 未连接，调用方对 `desktop` / `app:` 档调任一动词
- **THEN** 返回"host agent 未连接"，与"窗口不存在"、"未能取得前台"互不混淆
