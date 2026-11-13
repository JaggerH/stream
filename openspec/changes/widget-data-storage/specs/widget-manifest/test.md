# widget-data-storage 测试计划

## manifest schema

- **不变**：不带 `dataDir` 的旧清单照常解析（既有用例钉住）；`dataDir` 形状受理（非空字符串），
  拒绝仍是检查器 `data-dir` 一条的事。
- **常量**：`WIDGET_DATA_DEFAULT_DIR = 'data'`；存储环境变量名与模式枚举、存储接口常量可从公共
  入口导（导出面守卫快照覆盖）。

## checkWidget 新规则

- **data-dir**：判定规则不变（相对路径、无 `..`、非绝对路径）；未声明时 skipped 且 message 说明
  缺省数据根为 `data/`。既有正反例全部保持通过。
- **data-storage**（进程级 env 探活，不依赖 serve 进程窗口）：
  - `WIDGET_DATA_URL` 指向回 2xx 的服务 → 通过；
  - 指向回 404 的服务 → 通过（还没写过，正常）；
  - 指向回 401 / 403 的服务 → 失败并写明状态码；
  - 指向回 5xx 的服务 → 失败并写明状态码；
  - 连不上（连接拒绝 / 断开 / 超时）→ 失败；
  - 回其它非 2xx/404 的状态码（如 3xx/4xx 其它）→ 失败；
  - 没有该环境变量 → skipped（自部署 `widget check` 行为不变，既有用例全绿）。
- **data-ingress / data-endpoint**：行为不变，既有正反例全部保持通过。

## 参考客户端（对假服务端）

- 路径规范化：合法相对路径通过；绝对路径、`..`、反斜杠、NUL、超长段、超深、保留名拒绝（客户端侧
  先拒，不发请求）。
- 文档：GET 未写过 → 404 → 客户端报「没写过」；PUT 新建（`If-None-Match: *`）→ 200 + revision；
  PUT 覆盖带正确 `If-Match` → 200；带过期 `If-Match` → 409 映射为条件冲突；412/413/429/503/507
  各映射为可读错误，message 取服务端错误体的 `{error, message}`。413/507（超限）是客户端必须
  处理的错误，假服务端分别以单个过大 / 总量超限命中。
- 对象：GET / HEAD / PUT / DELETE / 列举（prefix + cursor）往返；DELETE 幂等（404 也算删成）。
- 条件写：新建用 `If-None-Match: *`、覆盖用 `If-Match`，header 形状由假服务端断言。

## 行为不变

- 无 `WIDGET_DATA_URL` 的环境里跑完整既有套件：每条规则结论与升级前一致。
