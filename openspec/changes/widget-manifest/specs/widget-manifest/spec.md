# widget-manifest

## ADDED Requirements

### Requirement: widget.json 的格式

挂载描述文件 `widget.json` SHALL 按 zod schema 校验，字段：`id`（kebab-case 字符串）、`name`（字符串）、
`icon`（可选，相对路径）、`version`（semver 字符串）、`entry`（相对路径，以 `.html` 结尾）、`serve`
（可选对象：`command`（非空字符串数组）与 `port`（1024–65535，不得是主实例端口））、`size`
（`card` / `half` / `full` 之一）、`data`（可选，合法 JSON Schema 对象）、`permissions`（可选对象：
`model`（可选布尔）、`credentials`（可选字符串数组）、`network`（可选主机名或 `*.` 后缀数组））、
`preview`（可选对象：`type`（`text` / `image`）与对应的 `text` 或 `src`）。不认识的字段 SHALL 拒绝。

#### Scenario: 合法描述通过
- **WHEN** 一个只含必填字段且取值合法的 `widget.json`
- **THEN** schema 校验通过，解析结果带缺省值（icon 缺省用内置图标路径占位）

#### Scenario: 非法字段被拒
- **WHEN** `size` 取了 `huge`，或 `entry` 指向 `.js`
- **THEN** 校验失败并指明是哪个字段为什么

### Requirement: 检查器逐条给结论

库函数 `checkWidget(dir, opts?)` SHALL 逐条规则返回 `{ok, results:[{rule, ok, message}]}`，规则覆盖：
`manifest`（存在且 schema 合法）、`entry`（文件存在）、`icon`（声明了就存在）、`serve-port`（合法且不
是主实例端口）、`serve-up`（`serve.command` 在超时（缺省 10s）内起来并回应健康检查：连接上且回答任何
< 500 的 HTTP 响应；没声明 `serve` 则跳过）、`permissions`（字段本身合法：键已知、域名格式对）。整体
`ok` SHALL 等于全部结果都通过（跳过算通过）。CLI SHALL 以同一实现逐条打印并在任一条不过时以非零码
退出。

#### Scenario: 后端起不来指名道姓
- **WHEN** `serve.command` 指向一个不存在的可执行文件
- **THEN** `serve-up` 一条失败，message 说明命令与超时；`ok` 为 false

#### Scenario: 每条规则可单独通过
- **WHEN** 一个不带 `serve` 与 `permissions` 的静态页面 widget
- **THEN** `serve-up` 与 `permissions` 记为 skipped（按通过计），其余规则通过，`ok` 为 true

### Requirement: 挂载存储与最小界面

挂载 SHALL 记录在 `data/widgets.json`（id → `{dir, device}`），由 CLI 写入（`widget:add`），界面 v1
SHALL 只读。后端 SHALL 服务一个只读页面：widget 列表（name、icon、size、设备在线状态）与点开的
iframe。iframe 地址 SHALL 指向转发入口并携带为该 `(device, port)` 签发的短期凭证，`sandbox` 属性 SHALL
不带 `allow-same-origin`；页面 SHALL 在凭证过期前刷新 iframe 地址。列表 SHALL 标出设备不在线的条目，
此类条目点开 SHALL 得到可读的失败页而非白屏。

#### Scenario: 挂载一个本机页面
- **WHEN** 用户在本机目录写好 `widget.json` 并通过检查，`widget:add` 指向 local 设备
- **THEN** 列表页出现该 widget，点开 iframe 显示其 `entry` 页面

#### Scenario: 设备离线的条目
- **WHEN** 一个 widget 挂在不在线的设备上
- **THEN** 列表标出离线；点开后页面说明设备不在线，而不是静默空白

### Requirement: 公共导出

`widget.json` 的类型与解析、`checkWidget`、挂载存储 SHALL 从公共入口导出；依赖方 SHALL NOT 需要导入
本仓库内部文件。

#### Scenario: 依赖方只碰公共入口
- **WHEN** 嵌入方从公共入口导入 schema 类型、`checkWidget` 与挂载存储
- **THEN** 编译通过，守卫测试（导出面快照）更新覆盖
