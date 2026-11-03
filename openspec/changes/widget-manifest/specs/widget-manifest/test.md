# widget-manifest 测试计划

## manifest schema

- **合法通过**：id/name/version/entry 必填，size/card/half/full，permissions/preview/data serve 可选。
- **非法拒绝**：id 非 kebab-case、version 非 semver、entry 非 .html、端口=8900 或超出范围、未知字段。

## checkWidget 规则

- **manifest**：解析与 schema 校验失败则失败，否则成功。
- **entry**：文件不存在 → 失败。
- **icon**：声明了不存在 → 失败；缺省内置 → skip（成功）。
- **serve-port**：非法端口 → 失败。
- **serve-up**：command 在超时内起来并回应 <500 HTTP 响应 → 成功；否则失败（spawn 错、退出、超时等原因明确写出）。
- **permissions**：credentials 空串、network 域名格式不对 → 失败。

## CLI

- `stream widget:check dir` 每条打印 ✓/✗；任一条不过 exit 1。
- `stream widget:add id dir --device name` 写 `data/widgets.json`。

## 界面

- `/widgets` 列表：显示 name/icon/size/设备在线状态；离线条目标红。
- `/widgets/:id` iframe：凭证过期前刷新；设备离线时给可读错误页而非白屏。

## 接线（routes 层）

- `/widgets` 列表页随 `routes()` 挂上：本机回环免密可打开，空挂载表也给完整列表页。
