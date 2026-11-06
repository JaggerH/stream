# widget-manifest

## ADDED Requirements

### Requirement: 数据目录与环境变量的归属

widget 的数据目录与环境变量 SHALL 都属于宿主，清单只能**声明位置**，不能索取注入：

- 声明了 `dataDir` 的 widget，宿主 SHALL 把它映射成**该 widget 唯一可写的数据目录**；没声明的，宿主
  SHALL 在它自己的数据目录下给一份按 widget `id` 命名的目录。`dataDir` 的值 SHALL 是相对清单目录的
  路径——绝对路径或含 `..` 段的值 SHALL 不通过（跳出清单目录的路径不是「widget 自己的数据目录」）。
- 清单 SHALL NOT 提供环境变量注入面：顶层 `env` 与 `environment` 字段 SHALL 不通过，原因 SHALL 写明
  「环境变量由宿主组装」。宿主给 `serve.command` 组装什么环境，由宿主决定，不由清单决定。

本能力只定声明与检查它：目录的创建、权限与内容迁移，以及环境变量的实际组装，都不在本能力内。

#### Scenario: 缺省数据目录
- **WHEN** 一个 widget 不写 `dataDir`
- **THEN** 检查器 `data-dir` 记跳过（按通过计），挂载时宿主给它一份按 widget id 命名的目录

#### Scenario: 声明了自己的数据目录
- **WHEN** `widget.json` 写 `"dataDir": "data"`
- **THEN** `data-dir` 通过，宿主把清单目录下这个相对路径映射成该 widget 唯一可写的数据目录

#### Scenario: 想借数据目录跳出清单目录
- **WHEN** `dataDir` 写成 `/var/tmp/x` 或 `../shared`
- **THEN** `data-dir` 不通过并指名原因（绝对路径 / 含 `..`）

#### Scenario: 清单想注入环境变量
- **WHEN** `widget.json` 顶层写了 `env`（或 `environment`）
- **THEN** `env` 一条不通过，message 写明环境变量由宿主组装、清单不能注入

## MODIFIED Requirements

### Requirement: widget.json 的格式

挂载描述文件 `widget.json` SHALL 按 zod schema 校验，字段：`id`（kebab-case 字符串）、`name`（字符串）、
`icon`（可选，相对路径）、`version`（semver 字符串）、`entry`（相对路径，以 `.html` 结尾）、`serve`
（可选对象：`command`（非空字符串数组）与 `port`（1024–65535，不得是主实例端口））、`size`
（`card` / `half` / `full` 之一）、`data`（可选，合法 JSON Schema 对象）、`dataDir`（可选，非空字符串：
相对清单目录的数据目录，取值对不对由检查器判，schema 只受理形状）、`permissions`（可选对象：`model`
（可选布尔）、`credentials`（可选字符串数组）、`network`（可选主机名或 `*.` 后缀数组））、`preview`
（可选对象：`type`（`text` / `image`）与对应的 `text` 或 `src`）。不认识的字段 SHALL 拒绝（顶层 `env` /
`environment` 因此本来就落在「不认识」里；指名原因是检查器的 `env` 规则）。

#### Scenario: 合法描述通过
- **WHEN** 一个只含必填字段且取值合法的 `widget.json`
- **THEN** schema 校验通过，解析结果带缺省值（icon 缺省用内置图标路径占位）

#### Scenario: 非法字段被拒
- **WHEN** `size` 取了 `huge`，或 `entry` 指向 `.js`
- **THEN** 校验失败并指明是哪个字段为什么

#### Scenario: 没有 dataDir 的老清单解析行为不变
- **WHEN** 一个升级前写好、从不含 `dataDir` / `env` 的 `widget.json`
- **THEN** 解析结果与形状判定与升级前一致，新规则全部记通过或跳过

### Requirement: 检查器逐条给结论

库函数 `checkWidget(dir, opts?)` SHALL 逐条规则返回 `{ok, results:[{rule, ok, message}]}`，规则覆盖：
`manifest`（存在且 schema 合法）、`env`（顶层没有 `env` / `environment`；有则不通过并写明环境变量由宿主
组装、清单不能注入）、`entry`（文件存在）、`icon`（声明了就存在）、`data-dir`（声明了 `dataDir` 时必须是
相对路径、不含 `..` 段、不是绝对路径；没声明则跳过）、`serve-port`（合法且不是主实例端口）、
`serve-command`（声明了 `serve` 时：`command` 的第一个词要么是裸名且在解释器白名单（`node` / `python3` /
`deno` / `bun`）里，要么是清单目录内的相对路径（不是绝对路径、不含 `..` 段）；命令的任意元素不得含 shell
元字符 `;` `&&` `|` 反引号 `$(`；没声明 `serve` 则跳过）、`serve-up`（`serve.command` 在超时（缺省 10s）
内起来并回应健康检查：连接上且回答任何 < 500 的 HTTP 响应；没声明 `serve` 则跳过；**`serve-command` 不
通过时 SHALL NOT 启动该命令**，本条记跳过并说明原因）、`data-ingress`（声明了 `data` 而没有 `serve` →
不通过并说明数据无处可写；没声明 `data` 则跳过）、`data-endpoint`（声明了 `data` 且 serve 已起来时，在
serve-up 的进程窗口内向 `/.well-known/widget-data` POST 一次最小样例（空对象 JSON，单次超时 2s），连接
失败或 404 → 不通过并逐条说明；widget 校验数据后回的其他 4xx / 5xx 不拦；没声明 `data`、没有 `serve`、
serve 没起来或 serve 未被启动则跳过并说明原因）、`permissions`（字段本身合法：键已知、域名格式对）。整体
`ok` SHALL 等于全部结果都通过（跳过算通过）。描述 schema SHALL NOT 因 `data` 无 `serve`、或 `dataDir`
取值不合法而拒绝（拒绝是检查器的规则，不是 schema 的）。CLI SHALL 以同一实现逐条打印并在任一条不过时以
非零码退出。

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
- **THEN** `data-ingress` 一条失败，message 说明数据无处可写与约定的写法；`data-endpoint` 跳过；`ok` 为 false

#### Scenario: 数据口没实现
- **WHEN** widget 的 serve 起来了，但对 `POST /.well-known/widget-data` 回 404，或连接被拒
- **THEN** `data-endpoint` 一条失败并指名路径与原因；widget 因数据不合 schema 回的 4xx 不算这条失败

#### Scenario: 没声明 data 的 widget 行为不变
- **WHEN** 一个不声明 `data` 的 widget（无论有没有 serve）
- **THEN** `data-ingress` 与 `data-endpoint` 都记跳过（按通过计），其余规则结论与升级前一致
