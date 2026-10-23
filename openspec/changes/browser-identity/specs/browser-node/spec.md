## ADDED Requirements

### Requirement: 每个 profile 里的扩展实例是一个节点

扩展 SHALL 在首次运行时生成一个 `nodeId` 并保存在所在 profile 的扩展存储里，之后每次连接 Stream 时 SHALL 在握手中报上它；
认领过 profile 后 SHALL 同时报上 profile 目录名与显示名。系统 SHALL 为每个连上过的 `nodeId` 保存一行节点记录，记下它所在的
设备与连进来的绑定。不带 `nodeId` 的老扩展 SHALL 照旧工作。

#### Scenario: 同一个 Chrome 的两个 profile 是两个节点
- **WHEN** 用户在「工作」与「个人」两个 profile 里都装了扩展，两个都连上了同一个 Stream
- **THEN** 系统记录两个节点，`nodeId` 不同，所在设备相同

#### Scenario: 老扩展不带 nodeId
- **WHEN** 一个没有升级的扩展连上本机 Stream
- **THEN** 它照常可用，行为与升级前一致，不出现在节点列表里

### Requirement: 本机多个节点同时在线

同一台机器上多个 profile 的扩展连本机 Stream 时，系统 SHALL 为每个带 `nodeId` 的连接各保留一条中继，一个节点的连接
SHALL NOT 顶替另一个节点的连接。本机连接 SHALL 仍经 native host 取 token 并挑战应答。

#### Scenario: 两个 profile 不再互相顶替
- **WHEN** 「工作」与「个人」两个 profile 的扩展先后连上本机 Stream
- **THEN** 两条连接同时在线，任一条的在途命令不会因为另一条连上而失败

### Requirement: 配对绑定只属于一个节点

配对绑定第一次连上时，系统 SHALL 把连接报上的 `nodeId` 记进绑定；之后同一绑定的 token 带着不同的 `nodeId` 连接时，系统
SHALL 拒绝该连接。

#### Scenario: token 被拷到另一个 profile
- **WHEN** 一条已记下 `nodeId` A 的配对绑定，其 token 被另一个 profile 的扩展带着 `nodeId` B 用来连接
- **THEN** 连接被拒绝，绑定仍属于节点 A

### Requirement: 由 host agent 认领 profile

具备 `browser.profiles` 与 `browser.claim` 的设备上，系统 SHALL 能列出 Chrome 的全部 profile，并逐个用该 profile 打开扩展
自己的认领页，页面携带一次性 `nonce`。打开认领页的扩展实例 SHALL 经它的绑定把 `nonce` 交回；系统 SHALL 只接受来自同一台
设备上的绑定交回的 `nonce`，并 SHALL 把 profile 目录名与显示名记进该节点。`nonce` SHALL 一次性、2 分钟内有效。
20 秒内没有交回的 profile SHALL 被标为「扩展未安装或未连上」。认领 SHALL 只由用户在面板上发起。

#### Scenario: 识别两个 profile
- **WHEN** 用户在 PC 上点「识别 profile」，PC 的 Chrome 有 `Default`（工作）与 `Profile 1`（个人）两个 profile，都装了扩展
- **THEN** 两个节点分别记下 `Default` 与 `Profile 1`，扩展 popup 里各自显示自己的 profile 名

#### Scenario: 某个 profile 没装扩展
- **WHEN** 识别时 `Profile 2` 里没有装扩展
- **THEN** `Profile 2` 被标为「扩展未安装或未连上」，其他 profile 的认领不受影响

#### Scenario: 别的机器交回 nonce
- **WHEN** 一个 `nonce` 由 PC 的认领签发，却经 NAS 上的绑定交回
- **THEN** 系统拒绝这次认领，任何节点都不被改动

### Requirement: 扩展记住自己的 profile

认领成功后，扩展 SHALL 把 profile 目录名与显示名保存在自己的存储里，之后每次握手都 SHALL 带上，不需要再次认领。
再次识别时，系统 SHALL 按 profile 目录名刷新显示名。

#### Scenario: 用户手动打开工作 profile
- **WHEN** 认领过的「工作」profile 被用户手动打开，扩展连上 Stream
- **THEN** 系统不需要认领就知道这个节点是 `Default`（工作）

### Requirement: 一个 profile 一个 Stream 标签组

对每条绑定，扩展 SHALL 在所在 profile 的浏览器里至多保持一个 Stream 会话标签组，SHALL NOT 为别的窗口另建组。由组内标签开出、
出现在另一扇普通窗口里的新标签 SHALL 被移进主组所在的窗口并加入主组；因此空出来的、随该标签新开的窗口 SHALL 被关闭。
出现在 popup 窗口里的新标签 SHALL 留在原处，照常可驱动。主组所在窗口被关闭后，扩展 SHALL 在下一次需要标签时于当前窗口重建主组。
升级后，扩展 SHALL 收编旧版留下的「Stream 独立窗」组：后台探针标签关闭，自建标签移入主组，用户拖入的标签只解组、SHALL NOT 关闭；
同名的多个主组 SHALL 合并为一个。

#### Scenario: 站点开了新窗口
- **WHEN** 一个在 Stream 组里的标签用 `window.open` 开出一扇新的普通窗口
- **THEN** 新标签被移进 Stream 组所在的窗口并加入 Stream 组，那扇新窗口被关闭，浏览器里没有新增标签组

#### Scenario: 升级时清理旧的独立窗组
- **WHEN** 升级前浏览器里有 47 个「Stream 独立窗」组，其中一个组里有用户拖进去的标签
- **THEN** 升级后浏览器里只剩一个 Stream 组，用户拖进去的那张标签仍然开着、不在任何组里

### Requirement: 节点的环境标注

用户 SHALL 能给每个节点标一个环境（预置「工作」「个人」，也可自定义）。环境 SHALL 写进在该节点上执行的运行记录。
环境本身 SHALL NOT 改变任何执行的权限。

#### Scenario: 标注工作环境
- **WHEN** 用户把 `Default` 节点标为「工作」
- **THEN** 之后在该节点上执行的每条运行记录都显示环境「工作」
