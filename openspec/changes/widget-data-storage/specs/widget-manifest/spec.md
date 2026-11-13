# widget-manifest

## ADDED Requirements

### Requirement: 宿主提供的持久数据服务

宿主 **可以** 提供一个持久数据服务，让 widget 后端把数据写到宿主维护的存储里而不是只写本地目录。
是否提供、怎么实现由宿主决定；本能力只定 widget 一侧的约定，任何嵌入方都可以照此实现宿主一侧。

- **数据根**：`dataDir`（未声明时默认 `data/`，常量 `WIDGET_DATA_DEFAULT_DIR`）声明的是构件持久
  数据的**数据根**——数据根下的路径构成该构件持久数据的唯一命名空间，代码与 `widget.json` 不在
  其中。数据根的映射仍是宿主的事（见「数据目录与环境变量的归属」），本需求不改变它。
- **宿主注入的环境**（清单不能声明，环境由宿主组装）：`WIDGET_DATA_URL`（数据服务的 base URL）、
  `WIDGET_DATA_TOKEN`（本次会话的构件凭据）、可选 `WIDGET_DATA_MODE`（`off` / `snapshot` /
  `write_behind` / `write_through`）。常量 SHALL 从公共入口导出。
- **HTTP 面**：服务 SHALL 在 `<base>/v1/document` 提供 JSON 文档的 `GET`（200 + JSON，带弱 `ETag`
  与 `X-Widget-Revision`；404 = 没写过）与 `PUT`（整份写，可带 `If-Match` / `If-None-Match: *`），
  在 `<base>/v1/objects?prefix=&cursor=`（列举）、`<base>/v1/objects/<path>`（`GET`/`HEAD`/`PUT`/
  `DELETE`）提供对象读写。覆盖写 SHALL 要求 `If-Match`、新建 SHALL 用 `If-None-Match: *`，前置
  不满足 SHALL 回 `409`（版本不符）或 `412`（前置失败），SHALL NOT 静默覆盖。服务端 SHALL 分配
  单调递增的 per-widget `revision` 并在成功响应中带新值。
- **错误与上限**：错误码 SHALL 覆盖 `401`（未认证）、`403`（越权）、`404`、`409`、`412`、`413`
  （超限）、`429`（限流）、`503`（服务不可达）、`507`（配额）；错误体 SHALL 为
  `{error: <code>, message: <可读>}`。文档 SHALL 限 1 MiB、单对象 SHALL 限 8 MiB（常量导出）。
- **路径规范化**：对象路径 SHALL 是 POSIX 相对路径；绝对路径、空段、`.`、`..`、反斜杠、NUL SHALL
  拒绝；段长 ≤ 255、总长 ≤ 512、深度 ≤ 16；保留名 `doc` 与 `.well-known` SHALL NOT 进文件命名
  空间（常量导出）。校验逻辑在 widget 侧参考客户端与服务端各做一遍，不信任其中一侧。

本能力不实现存储服务端、鉴权服务、迁移与配额管理；`POST /.well-known/widget-data` 的既有语义
不变（那是宿主向 widget 送数据的口，与这里的存储接口方向相反、并存）。

#### Scenario: widget 用存储接口持久化一个对象

- **WHEN** 宿主注入了存储环境，widget 后端对 `<base>/v1/objects/lists/todo.json` 发 `PUT`
  （`If-None-Match: *`，body 为 JSON）
- **THEN** 服务回 2xx 并带新 revision；随后 `GET` 同路径取回同一内容，响应带弱 `ETag` 与
  `X-Widget-Revision`

#### Scenario: 条件写冲突不静默覆盖

- **WHEN** widget 按过期的 `If-Match` revision 发 `PUT`
- **THEN** 服务回 `409`（或前置失败回 `412`），已有对象保持不变；widget 重取后再写才能覆盖

#### Scenario: 未提供存储服务的宿主行为不变

- **WHEN** 宿主不注入 `WIDGET_DATA_URL`，widget 声明了 `dataDir`
- **THEN** widget 照旧只有宿主映射的本地数据目录，存储接口的常量与检查规则的结论不因此变化

## MODIFIED Requirements

### Requirement: 数据目录与环境变量的归属

widget 的数据目录与环境变量 SHALL 都属于宿主，清单只能**声明位置**，不能索取注入：

- 声明了 `dataDir` 的 widget，宿主 SHALL 把它映射成**该 widget 唯一可写的数据目录**；没声明的，
  宿主 SHALL 在它自己的数据目录下给一份按 widget `id` 命名的目录，目录名对应缺省数据根
  `data/`（常量 `WIDGET_DATA_DEFAULT_DIR`，语义：`dataDir` 未声明时构件持久数据的命名空间缺省
  就是清单目录下的 `data/`）。`dataDir` 的值 SHALL 是相对清单目录的路径——绝对路径或含 `..` 段的
  值 SHALL 不通过（跳出清单目录的路径不是「widget 自己的数据目录」）。
- 清单 SHALL NOT 提供环境变量注入面：顶层 `env` 与 `environment` 字段 SHALL 不通过，原因 SHALL
  写明「环境变量由宿主组装」。宿主给 `serve.command` 组装什么环境（包括是否注入存储服务的
  `WIDGET_DATA_URL` / `WIDGET_DATA_TOKEN` / `WIDGET_DATA_MODE`），由宿主决定，不由清单决定。

本能力只定声明与检查它：目录的创建、权限与内容迁移，以及环境变量的实际组装，都不在本能力内。

#### Scenario: 缺省数据目录

- **WHEN** 一个 widget 不写 `dataDir`
- **THEN** 检查器 `data-dir` 记跳过（按通过计），message 说明缺省数据根为 `data/`；挂载时宿主给
  它一份按 widget id 命名的目录

#### Scenario: 声明了自己的数据目录

- **WHEN** `widget.json` 写 `"dataDir": "data"`
- **THEN** `data-dir` 通过，宿主把清单目录下这个相对路径映射成该 widget 唯一可写的数据目录

#### Scenario: 想借数据目录跳出清单目录

- **WHEN** `dataDir` 写成 `/var/tmp/x` 或 `../shared`
- **THEN** `data-dir` 不通过并指名原因（绝对路径 / 含 `..`）

#### Scenario: 清单想注入环境变量

- **WHEN** `widget.json` 顶层写了 `env`（或 `environment`）
- **THEN** `env` 一条不通过，message 写明环境变量由宿主组装、清单不能注入

### Requirement: 检查器逐条给结论

库函数 `checkWidget(dir, opts?)` SHALL 逐条规则返回 `{ok, results:[{rule, ok, message}]}`，规则覆盖：
`manifest`（存在且 schema 合法）、`env`（顶层没有 `env` / `environment`；有则不通过并写明环境变量由宿主
组装、清单不能注入）、`entry`（文件存在）、`icon`（声明了就存在）、`data-dir`（声明了 `dataDir` 时必须是
相对路径、不含 `..` 段、不是绝对路径；没声明则跳过并说明缺省数据根为 `data/`）、`serve-port`（合法且不是
主实例端口）、`serve-command`（声明了 `serve` 时：`command` 的第一个词要么是裸名且在解释器白名单（`node` /
`python3` / `deno` / `bun`）里，要么是清单目录内的相对路径（不是绝对路径、不含 `..` 段）；命令的任意元素
不得含 shell 元字符 `;` `&&` `|` 反引号 `$(`；没声明 `serve` 则跳过）、`serve-up`（`serve.command` 在超时
（缺省 10s）内起来并回应健康检查：连接上且回答任何 < 500 的 HTTP 响应；没声明 `serve` 则跳过；
**`serve-command` 不通过时 SHALL NOT 启动该命令**，本条记跳过并说明原因）、`data-ingress`（声明了 `data`
而没有 `serve` → 不通过并说明数据无处可写；没声明 `data` 则跳过）、`data-endpoint`（声明了 `data` 且
serve 已起来时，在 serve-up 的进程窗口内向 `/.well-known/widget-data` POST 一次最小样例（空对象 JSON，
单次超时 2s），连接失败或 404 → 不通过并逐条说明；widget 校验数据后回的其他 4xx / 5xx 不拦；没声明
`data`、没有 `serve`、serve 没起来或 serve 未被启动则跳过并说明原因）、`data-storage`（宿主注入了
`WIDGET_DATA_URL` 时，对该服务的对象端点发一次单次短超时 `HEAD` 探活：`2xx` 与 `404` 通过（404 =
还没写过，正常），连接失败、`401/403`、`5xx` 与其余非 2xx/404 的状态码不通过并写明状态码；没有该
环境变量则跳过——自部署 `widget check` 行为不变）、`permissions`（字段本身合法：键已知、域名格式对）。
整体 `ok` SHALL 等于全部结果都通过（跳过算通过）。描述 schema SHALL NOT 因 `data` 无 `serve`、或
`dataDir` 取值不合法而拒绝（拒绝是检查器的规则，不是 schema 的）。CLI SHALL 以同一实现逐条打印并在
任一条不过时以非零码退出。

#### Scenario: 后端起不来指名道姓

- **WHEN** `serve.command` 指向一个不存在的可执行文件
- **THEN** `serve-up` 一条失败，message 说明命令与超时；`ok` 为 false

#### Scenario: 每条规则可单独通过

- **WHEN** 一个不带 `serve` 与 `permissions` 的静态页面 widget
- **THEN** `serve-port`、`serve-up`、`serve-command`、`data-dir` 记为 skipped（按通过计），其余规则通过，
  `ok` 为 true

#### Scenario: 检查器不起不该起的命令

- **WHEN** `serve.command` 的第一个词既不在解释器白名单、也不是清单目录内的相对路径
- **THEN** `serve-command` 不通过并列出允许的形状，`serve-up` 记跳过且**没有 spawn 过那条命令**，`ok` 为
  false

#### Scenario: 声明了 data 但没有 serve

- **WHEN** 一个 `widget.json` 写了 `data` 而没写 `serve`
- **THEN** `data-ingress` 一条失败，message 说明数据无处可写与约定的写法；`data-endpoint` 跳过；`ok` 为
  false

#### Scenario: 数据口没实现

- **WHEN** widget 的 serve 起来了，但对 `POST /.well-known/widget-data` 回 404，或连接被拒
- **THEN** `data-endpoint` 一条失败并指名路径与原因；widget 因数据不合 schema 回的 4xx 不算这条失败

#### Scenario: 没声明 data 的 widget 行为不变

- **WHEN** 一个不声明 `data` 的 widget（无论有没有 serve）
- **THEN** `data-ingress` 与 `data-endpoint` 都记跳过（按通过计），其余规则结论与升级前一致

#### Scenario: 有存储环境时探活通过

- **WHEN** 检查器进程带着 `WIDGET_DATA_URL` 指向一个正常的服务（对象端点回 2xx 或 404）
- **THEN** `data-storage` 通过并说明探测结果

#### Scenario: 存储服务不可达或拒绝时探活不通过

- **WHEN** `WIDGET_DATA_URL` 指向的服务连不上、回 `401/403` 或 `5xx`
- **THEN** `data-storage` 不通过，message 写明原因（连接失败或状态码）；`ok` 为 false

#### Scenario: 没有存储环境时探活跳过

- **WHEN** 检查器进程没有 `WIDGET_DATA_URL`
- **THEN** `data-storage` 记跳过（按通过计），其余规则结论与升级前一致

### Requirement: 公共导出

`widget.json` 的类型与解析、数据写入口常量 `WIDGET_DATA_PATH`、检查器、挂载存储 SHALL 从公共
入口导出；依赖方 SHALL NOT 需要导入本仓库内部文件。存储约定的常量——`WIDGET_DATA_DEFAULT_DIR`、
`WIDGET_DATA_URL`、`WIDGET_DATA_TOKEN`、`WIDGET_DATA_MODE` 与模式枚举、存储接口的路径前缀与
端点路径、大小上限、路径规范化限制、保留名——SHALL 一并从公共入口导出，导出面守卫快照同步。

#### Scenario: 依赖方只碰公共入口

- **WHEN** 嵌入方从公共入口导入 schema 类型、`WIDGET_DATA_PATH`、`checkWidget`、挂载存储与存储
  约定常量
- **THEN** 编译通过，守卫测试（导出面快照）更新覆盖
