# widget-data-storage

## 计划 1：约定与常量

- [ ] 1. `manifest.ts`：`WIDGET_DATA_DEFAULT_DIR = 'data'` 与数据根语义注释；存储环境变量名常量
      （`WIDGET_DATA_URL` / `WIDGET_DATA_TOKEN` / `WIDGET_DATA_MODE`）与模式枚举（含「提示性质，
      构件不得依赖其做正确性判断」的注释）；存储接口常量（路径前缀 `/v1`、document / objects 端点、
      大小下限参考值（文档 ≥ 256 KiB、单对象 ≥ 1 MiB，注明参考性质）、路径限制与保留名）
- [ ] 2. `src/engine/index.ts` 导出上述常量；`exports.guard.test.ts` 快照同步

## 计划 2：检查器

- [ ] 1. `data-dir`：未声明时 message 说明缺省数据根 `data/`；判定规则不变（绝对路径、`..` 拒绝）
- [ ] 2. `data-storage` 新规则：进程带 `WIDGET_DATA_URL` 时对对象端点单次 `HEAD` 探活（短超时），
      接受 2xx 与 404，拒绝连接失败、401/403、5xx 及其余非 2xx/404 状态码；无 env 时 skipped

## 计划 3：参考客户端与测试

- [ ] 1. `data-client.ts`：路径规范化校验、文档 GET/PUT、对象 GET/HEAD/PUT/DELETE/列举、条件写
      （`If-Match` / `If-None-Match: *`）、错误码解析；不进公共导出面
- [ ] 2. `data-client.test.ts`：对假服务端跑通 GET/PUT/list/条件写/错误码（409/412/413/429/503/507）
- [ ] 3. `widgets.test.ts` 正反例：旧清单不带 `dataDir` 照常解析；`data-dir` 缺省语义 message；
      `data-storage` 有 env 探活（2xx/404 过，401/403/5xx/连不上不过）与无 env skipped；
      `data-ingress` / `data-endpoint` 行为不变

## 计划 4：文档与交付

- [ ] 1. `docs/ARCHITECTURE.md`：Widget Manifest 一节补数据根、宿主注入环境与存储接口约定
- [ ] 2. 全量测试 + typecheck 绿后推中性主题分支（评审改动提交只写中性说法）
