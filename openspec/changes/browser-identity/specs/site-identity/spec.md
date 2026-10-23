## ADDED Requirements

### Requirement: 包可声明 whoami

包的会话声明 SHALL 可选地包含 `whoami`：一个返回当前账号的 GET 接口地址、账号 id 在响应 JSON 中的点路径、可选的昵称路径。
`whoami.url` 的主机 SHALL 落在包声明的允许主机内，否则安装校验 SHALL 拒绝该包。

#### Scenario: B 站声明 whoami
- **WHEN** bilibili 包声明 `whoami: { url: 'https://api.bilibili.com/x/web-interface/nav', id: 'data.mid', name: 'data.uname' }`
- **THEN** 包照常安装，系统可在任一节点上问出 B 站当前登录的账号

#### Scenario: whoami 指向未声明的主机
- **WHEN** 一个包的 `whoami.url` 指向不在其允许主机内的地址
- **THEN** 安装校验失败并指出是 `whoami.url` 越界

### Requirement: 在节点上探测身份

系统 SHALL 在指定节点上、经该节点自己的会话标签组打开一个后台标签导航到 `whoami.url`，解析响应并关闭标签。结果 SHALL 是三态之一：
取到非空 id 为 `signed-in`；响应为 JSON 但 id 为空为 `signed-out`；其余情况（打不开、不是 JSON、节点断开）为 `unknown`。
`unknown` SHALL NOT 被当作登录或登出。同一节点上的探测 SHALL 串行进行。

#### Scenario: 探测到登录的账号
- **WHEN** 在「个人」节点上探测 B 站，`nav` 接口返回 `data.mid = 123`、`data.uname = '某某'`
- **THEN** 结果为 `signed-in`，账号 id 为 `123`，昵称为「某某」

#### Scenario: 节点中途断开
- **WHEN** 探测进行中该节点的扩展断开
- **THEN** 结果为 `unknown`，身份表里该节点的记录保持原样

### Requirement: 身份表

系统 SHALL 维护身份表：每个（facility，节点）至多一条记录，含账号 id、昵称、状态与上次核对时间。身份 SHALL 由（facility，账号 id）
确定，可出现在多个节点上。系统 SHALL 在节点连上时探测该节点上会话 cookie 在场的 facility，在某 facility 的会话 cookie 于该节点上
变化时重新探测，并 SHALL 支持手动刷新。`unknown` SHALL NOT 写表；`signed-out` SHALL 写表并保留上次的账号 id。

#### Scenario: 同一账号登在两个节点上
- **WHEN** 小红书个人号A 同时登在家里电脑与笔记本的「个人」profile 上
- **THEN** 身份表中身份（小红书，A）出现在两个节点上

#### Scenario: 用户在 profile 里换了号
- **WHEN** 用户在「工作」profile 里把小红书从工作号B 换成个人号A，扩展报告会话 cookie 变化
- **THEN** 系统重新探测，该节点的小红书记录变为个人号A

### Requirement: 没有 whoami 的 facility 按节点区分身份

facility 未声明 `whoami` 时，系统 SHALL 把「该节点上的账号」当作一个身份（账号 id 为 `node:<nodeId>`），显示为该节点的 profile 名
加「上的账号」。这样的身份 SHALL 能作为路由目标，且 SHALL NOT 做执行前核对。

#### Scenario: 一个没有 whoami 的站点
- **WHEN** facility `zhuanzhuan` 未声明 `whoami`，它的会话 cookie 在「工作」与「个人」两个节点上都在
- **THEN** 身份表为它列出两个身份：「工作 上的账号」与「个人 上的账号」
