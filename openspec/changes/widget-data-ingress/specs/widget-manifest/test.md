# widget-data-ingress 测试计划

## manifest schema

- **不变**：`data` 无 `serve` 的描述 schema 照样放行（用例钉住），拒绝交给检查器。
- **常量**：`WIDGET_DATA_PATH = '/.well-known/widget-data'`，公共入口可导（导出面守卫快照覆盖）。

## checkWidget 新规则

- **data-ingress**：`data` 声明了而 `serve` 缺失 → 失败，message 写清「数据无处可写」与约定写法；没声明 `data` → skipped。
- **data-endpoint**（复用 serve-up 起的进程窗口，不另起第二次）：
  - 端点回 2xx → 通过；
  - 端点回 4xx（widget 自己校验数据）→ 通过（口在，数据不对不是这条的事）；
  - 端点 404 → 失败并指名路径；
  - 连接失败（对数据口断开/拒绝）→ 失败；
  - 没有 serve、serve 没起来 → skipped 并说明原因。

## 行为不变

- 没声明 `data` 的 widget（静态或带 serve）：两条新规则 skipped，整体结论与升级前一致，既有用例全绿。

## CLI

- 不需要改：新规则随同一个 results 数组逐条打印，任一条不过 exit 1。
