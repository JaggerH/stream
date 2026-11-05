# widget-manifest

## ADDED Requirements

### Requirement: 数据写入口

宿主 SHALL 只用一条固定约定把数据写给声明了 `data` 的 widget：对该 widget 的 `serve.port` 发
`POST http://127.0.0.1:<port>/.well-known/widget-data`（常量 `WIDGET_DATA_PATH`），`Content-Type:
application/json`，body 为一份符合该 widget `data` schema 的 JSON；widget 回 2xx SHALL 视为收下，
其余状态码 SHALL 视为失败。声明了 `data` 而没有 `serve` 的 widget SHALL 视为无处可写。
`WIDGET_DATA_PATH` SHALL 从公共入口导出。本能力只定约定与检查它：宿主的写入客户端与数据口鉴权
不在本能力内。

#### Scenario: 按约定送数据
- **WHEN** 宿主对一个声明了 `data` 且已挂载的 widget，向其 `serve.port` 的 `/.well-known/widget-data` POST 一份符合 schema 的 JSON
- **THEN** widget 校验后回 2xx，数据交付完成

#### Scenario: widget 校验失败
- **WHEN** 送出的 JSON 不符合该 widget 的 `data` schema，widget 回 4xx
- **THEN** 按约定视为失败（口在、数据不对；检查器不据此判负）

## MODIFIED Requirements

### Requirement: 检查器逐条给结论

库函数 `checkWidget(dir, opts?)` SHALL 逐条规则返回 `{ok, results:[{rule, ok, message}]}`，规则覆盖：
`manifest`（存在且 schema 合法）、`entry`（文件存在）、`icon`（声明了就存在）、`serve-port`（合法且不
是主实例端口）、`serve-up`（`serve.command` 在超时（缺省 10s）内起来并回应健康检查：连接上且回答任何
< 500 的 HTTP 响应；没声明 `serve` 则跳过）、`data-ingress`（声明了 `data` 而没有 `serve` → 不通过并
说明数据无处可写；没声明 `data` 则跳过）、`data-endpoint`（声明了 `data` 且 serve 已起来时，在 serve-up
的进程窗口内向 `/.well-known/widget-data` POST 一次最小样例（空对象 JSON，单次超时 2s），连接失败或
404 → 不通过并逐条说明；widget 校验数据后回的其他 4xx / 5xx 不拦；没声明 `data`、没有 `serve` 或
serve 没起来则跳过并说明原因）、`permissions`（字段本身合法：键已知、域名格式对）。整体 `ok` SHALL
等于全部结果都通过（跳过算通过）。描述 schema SHALL NOT 因 `data` 无 `serve` 拒绝（拒绝是检查器的
规则，不是 schema 的）。CLI SHALL 以同一实现逐条打印并在任一条不过时以非零码退出。

#### Scenario: 后端起不来指名道姓
- **WHEN** `serve.command` 指向一个不存在的可执行文件
- **THEN** `serve-up` 一条失败，message 说明命令与超时；`ok` 为 false

#### Scenario: 每条规则可单独通过
- **WHEN** 一个声明了 `data`、带 `serve` 且数据口按约定实现的 widget
- **THEN** `data-ingress` 与 `data-endpoint` 通过，其余规则通过，`ok` 为 true

#### Scenario: 声明了 data 但没有 serve
- **WHEN** 一个 `widget.json` 写了 `data` 而没写 `serve`
- **THEN** `data-ingress` 一条失败，message 说明数据无处可写与约定的写法；`data-endpoint` 跳过；`ok` 为 false

#### Scenario: 数据口没实现
- **WHEN** widget 的 serve 起来了，但对 `POST /.well-known/widget-data` 回 404，或连接被拒
- **THEN** `data-endpoint` 一条失败并指名路径与原因；widget 因数据不合 schema 回的 4xx 不算这条失败

#### Scenario: 没声明 data 的 widget 行为不变
- **WHEN** 一个不声明 `data` 的 widget（无论有没有 serve）
- **THEN** `data-ingress` 与 `data-endpoint` 都记跳过（按通过计），其余规则结论与升级前一致

### Requirement: 公共导出

`widget.json` 的类型与解析、数据写入口常量 `WIDGET_DATA_PATH`、`checkWidget`、挂载存储 SHALL 从公共
入口导出；依赖方 SHALL NOT 需要导入本仓库内部文件。

#### Scenario: 依赖方只碰公共入口
- **WHEN** 嵌入方从公共入口导入 schema 类型、`WIDGET_DATA_PATH`、`checkWidget` 与挂载存储
- **THEN** 编译通过，守卫测试（导出面快照）更新覆盖
