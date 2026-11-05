# widget-data-ingress

## 计划 1：约定与导出

- [x] 1. `manifest.ts`：`WIDGET_DATA_PATH` 常量；`DATA_SCHEMA` 与 `WidgetManifest['data']` 的类型注释写死约定
- [x] 2. `src/engine/index.ts` 导出 `WIDGET_DATA_PATH`；导出面守卫测试快照同步

## 计划 2：检查器

- [x] 1. `data-ingress` 规则：data 声明了而 serve 缺失 → 不通过，原因写清「数据无处可写」
- [x] 2. `data-endpoint` 规则：复用 serve-up 的进程窗口，POST 空对象 JSON，单次 2s，只排除连接失败与 404
- [x] 3. 没声明 data 的 widget 两条规则 skipped，既有用例全部保持通过

## 计划 3：测试与文档

- [x] 1. 正反例：data 无 serve 不通过；data+serve 端点 2xx / 4xx 通过；404 / 连接失败不通过
- [x] 2. `docs/ARCHITECTURE.md` Widget Manifest 一节补数据写入口与两条规则
- [x] 3. typecheck + 全量测试绿后线性推 main
