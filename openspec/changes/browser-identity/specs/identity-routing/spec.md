## ADDED Requirements

### Requirement: 身份与环境可以作为执行目标

facility 的默认目标与任务覆盖 SHALL 可以是设备、身份或环境三者之一。解析顺序 SHALL 为：任务的身份、任务的环境、任务的设备、
facility 的默认目标、`local`。解析 SHALL 在执行开始时进行一次，选出的节点 SHALL 决定本次执行的设备与扩展绑定，整次执行不变。

#### Scenario: 任务指定工作号
- **WHEN** 一条小红书发布任务的身份覆盖为工作号B，工作号B 只登在 PC 的「工作」节点上
- **THEN** 该次执行在 PC 上、经「工作」节点的绑定执行，运行记录写明身份工作号B

#### Scenario: facility 默认到个人环境
- **WHEN** 小红书的默认目标是环境「个人」，一条小红书采集源触发，任务没有覆盖
- **THEN** 采集在某个「个人」环境里登着小红书的节点上执行

### Requirement: 选择身份的候选节点

对身份目标，候选节点 SHALL 是身份表中该身份为 `signed-in` 的节点；对环境目标，候选节点 SHALL 是该环境中该 facility 为 `signed-in`
的节点。系统 SHALL 优先选在线的候选，同为在线时 SHALL 选最近核对过的。

#### Scenario: 同一身份两个节点一个在线
- **WHEN** 个人号A 登在家里电脑与笔记本上，只有笔记本在线
- **THEN** 执行选笔记本上的节点

### Requirement: 按需唤起目标 profile

候选节点全部离线、但其中有记下 profile 目录的节点且所在设备的 host agent 在线时，系统 SHALL 让 host agent 唤起该 profile，
并 SHALL 至多等待 30 秒让该节点连上。同一节点同时只有一次唤起在进行，并发的执行 SHALL 共用它的结果。若唤起必然打开窗口，
系统 SHALL 只在用户发起的执行中唤起，定时执行 SHALL 直接按 `identity-offline` 失败。

#### Scenario: 工作 profile 没开
- **WHEN** 用户在面板上手动运行一条指定工作号B 的任务，PC 上 Chrome 只开着「个人」profile
- **THEN** 系统唤起「工作」profile，等它的节点连上后再执行

### Requirement: 唤起的 profile 不留痕迹且对用户可见

执行结束后，系统 SHALL 关闭自己在被唤起的 profile 里打开的标签，以及为它新开的窗口。对由系统唤起、且此刻没有用户自己的窗口的
profile，系统 SHALL 让它的最后一扇窗关闭以使 Chrome 卸载该 profile；执行中从未开过窗时，系统 SHALL 开一扇不聚焦的窗再关闭它。
profile 里有不属于 Stream 的窗口或标签时，系统 SHALL NOT 关闭它们。系统 SHALL 记录哪些 profile 是由它唤起的；用户自己打开过该 profile
的窗口后，这条记录 SHALL 被清除。面板 SHALL 列出由 Stream 唤起、此刻仍在后台加载着的 profile。

#### Scenario: 定时任务唤起了工作 profile
- **WHEN** 一条定时任务静默唤起「工作」profile 并执行完毕
- **THEN** 「工作」profile 里没有 Stream 留下的标签或窗口，「工作」profile 被 Chrome 卸载

#### Scenario: 用户自己也开着那个 profile
- **WHEN** 一条任务唤起「工作」profile 执行期间，用户自己打开了「工作」的一扇窗
- **THEN** 执行结束后 Stream 只关自己的标签，用户的窗口照常开着，「工作」不再显示为由 Stream 在后台打开

### Requirement: 执行前核对身份

目标为身份或环境、且 facility 声明了 `whoami` 时，系统 SHALL 在派发任何动作前于选定节点核对身份，除非身份表中的记录足够新：
采集为 10 分钟内，任务中心的动作为 60 秒内。核对出另一个账号 SHALL 以 `identity-mismatch` 失败并通知用户；核对出已登出 SHALL 以
`identity-signed-out` 失败并发出指名该 profile 的「需要登录」通知；核对为 `unknown` SHALL 按 `identity-offline` 失败。

#### Scenario: profile 里的账号被换了
- **WHEN** 一条指定工作号B 的动作触发，核对发现「工作」节点上登的是个人号A
- **THEN** 执行以 `identity-mismatch` 失败，未发出任何动作，用户收到通知

### Requirement: 绝不换身份顶上

身份或环境目标没有可用节点时，系统 SHALL 以 `identity-offline` 失败，SHALL NOT 改用其他身份、其他设备或 `local` 执行。
`identity-offline` SHALL 按任务的 `maxAttempts` 重试；`identity-mismatch` 与 `identity-signed-out` SHALL NOT 自动重试。

#### Scenario: 工作号不在线
- **WHEN** 一条定时的发布任务指定工作号B，工作号B 所在的节点离线且无法唤起，个人号A 的节点在线
- **THEN** 执行以 `identity-offline` 失败，个人号A 的节点上没有打开任何标签
