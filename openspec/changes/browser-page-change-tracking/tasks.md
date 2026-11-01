# browser-page-change-tracking — tasks

## 计划 1：adapter 能力

- [x] 1. `packages/browser/adapter.ts`：`track_changes` 分支——归一化正文摘要做 guid（`url#<digest>`）、
  未变不产出、实质变化恰好一条、标题变化不算
- [x] 2. 归一化：折叠空白、去绝对日期/时刻与相对时间短语；只吃 innerText 不吃 HTML（导出供测试）
- [x] 3. 防刷上限：每页滚动 1 小时至多 10 条，超限 0 产出（不排队）；进程内记忆、注入时钟可测
- [x] 4. adapter 单测：默认关闭行为不变、身份格式、未变 0 条、变化 1 条、噪声 0 条、超上限截断、
  窗口滑出恢复、标题不算变化、重启后 dedup 兜底

## 计划 2：集成与口径

- [x] 5. adapter × `stream-pipeline` 集成测试：不变两次采集写 0 条、实质变化写 1 条、只有噪声写 0 条、
  超防刷上限不再产出（真 DedupStore 走 persistItems）
- [x] 6. `packages/browser/manifests.yaml`：`track_changes` 参数 + 描述改事实口径（保留「需要在线浏览器
  设备」，有 feed 优先 feed-url）
- [x] 7. `src/mcp/tool-catalog.ts`：`stream_search` 空 note 里 browser-page 那句改成事实口径
- [x] 8. `pnpm test` 全量（除导出闸测试的既有失败）+ typecheck 0
