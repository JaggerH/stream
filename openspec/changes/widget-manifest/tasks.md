# widget-manifest

## 计划 1：格式与检查器

- [x] 1. `manifest.ts`：zod schema + 类型 + 解析（拒绝未知字段、缺省值）
- [x] 2. `check.ts`：`checkWidget(dir, opts)` 六条规则逐条给结论；健康检查起 `serve.command` 轮询回环
- [x] 3. CLI `src/widgets/cli.ts`：`check`（非零码退出）与 `add`（写挂载存储）；package.json script
- [x] 4. 每条规则的正反例测试

## 计划 2：挂载与最小界面

- [x] 1. `store.ts`：`data/widgets.json` 读写（原子写、损坏容错）
- [x] 2. `page.ts`：只读列表页 + sandbox iframe（凭证到期前刷新地址；设备离线给可读失败页）
- [x] 3. serve 接线：页面路由 + 复用 device-loopback-forward 的转发入口

## 计划 3：导出与文档

- [x] 1. `src/engine/index.ts` 导出 schema 类型、`checkWidget`、挂载存储
- [x] 2. `docs/ARCHITECTURE.md` 一节；推送前全量测试 + typecheck
