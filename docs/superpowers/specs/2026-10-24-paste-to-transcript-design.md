# 粘贴链接 → 转成文字（面板原生）· 设计

日期：2026-10-24 · 状态：已确认（方案 A）

## 一句话

在 8900 独立面板上把「Ctrl+V 一条抖音/B 站链接 → 确认 → 转写 → 详情页右栏读全文」串成一步；
转写稿第一次在 Stream 前端里有了固定归宿，不再依赖对话宿主。

## 背景（为什么是现在）

- 粘贴入口已存在：`StreamPanel.tsx` 监听整页 paste → `app/src/lib/pasteLink.ts`（认领 →
  `/api/media/from-url` → 开详情）。抖音（`Douyin_TikTok_Download_API` 容器包）/B 站
  （`packages/bilibili` 原生包）都有 fetch-url 源。
- 转写管线已存在：`src/conversions/` 的 `extract`（stt 分支）+ `POST /api/conversions`；
  HTTP 门放行「句柄不在库但请求带 `media`」（`src/http/conversions-routes.ts:74`），粘贴
  item（`id: paste:<url>`，不进库）可直接转写。
- 缺口：转写稿在前端**没有渲染面**——全站唯一「转成文字」动作把一句话发进对话宿主
  （`askExtract.ts`），独立 8900 页面直接 toast 拒绝（头注明说「Stream 前端里没有任何地方画它」）。
- `Detail.tsx` 右栏 `PostPanelTabs` 曾有转写档（2026-08-12 退役），本次请回，背后换成转换资源 API。

## 用户流程

1. 粘贴 → 现有认领+抓取；**认领成功且带视频/音频媒体** → 弹 `PasteActionModal`：
   封面+标题+作者+来源徽章；按钮 [转成文字]（stt 可用时亮，读 `ExtractCapsProvider`）/
   [下载]（`videoDl` 非空时亮）；点卡片 = 仅开详情；ESC/关闭 = 取消。
2. [转成文字] → 开详情并携带 `autoExtract` 意图 → 右栏转写档出现并 POST 转换。
3. [下载] → `triggerDownload(videoDl)`（浏览器下载直链，现有路径），modal 关闭。
4. 回退不变：未认领/无媒体 → 现状直接开详情（link 原型自己抽正文），不弹 modal。
5. 库内条目：详情动作行 + 时间线右键「转成文字」从 `askExtract`（发进对话）改为
   **开详情 + 启动转写**，与粘贴流汇合。模型经 MCP 调 `extract` 的路径与 DSH ExtractCard 不动。

## 转写档（Detail 右栏第二档）

挂载：`PostPanelTabs`；`canExtract || 已有转写记录` 时出现「转写」档（一档仍不画切换器）。

| 状态 | 展示 |
|---|---|
| 未启动 | 说明 + [开始转写]（与动作行同一动作） |
| 排队 | `queuePos` + 取消（`DELETE /api/conversions/:id`） |
| 运行 | `timing.stages` 已完成阶段 + 当前阶段名 + 取消 |
| 完成 | `result.text`（按 format 渲染）+ 可折叠分段时间轴（`detail.segments`）+ 分支徽章 + 重新转写（force） |
| 失败 | `error.message` + 重试 |

刷新：`transcribe.done/error` 事件（`/ws`，`EventsProvider` 已收）按 `event.ref.id === item.id`
即时刷新；运行期叠 3s 轮询 `api.conversions.latest(..., { expandResult: true })` 兜底，详情卸载即停。

## 数据流（后端零改动）

- 粘贴 item：`api.conversions.start('extract', 'paste:<url>', { media, snapshot, options:{ content } })`
  （客户端函数在 `app/src/lib/api.ts` 本就存在、无消费者）。缓存键 (`paste:<url>`, `extract`)，
  同链接再粘命中缓存秒出；`conversions` 表按设计比 item 活得久。
- 库内 item：同一 POST，句柄由后端 `resolveHandle` 解析。
- 状态归属：`useExtractConversion(item)` hook 挂 Detail 树内；不进全局 store。

## 边界

- stt 未配置 → 按钮不亮/置灰 +「转写后端未配置」；不 POST 试探。
- 抓取失败（容器沉睡等）→ 现有 toast 路径，modal 不弹。
- frames（画面文字）派生后到 → v1 不展示 frames track；identify（发言人）并行跑 → v1 不展示投影。
- Detail 为两 bundle 共用树（面板内嵌 + detail-entry）→ 转写档做在 Detail 组件内部，两边天然都有。

## 模块

新：`app/src/components/TranscriptPanel.tsx`、`app/src/lib/useExtractConversion.ts`、
`app/src/components/PasteActionModal.tsx`。
改：`Detail.tsx`（右栏档位 + 动作行改道 + `autoExtract`）、`StreamPanel.tsx`（paste handler 插
modal + `autoExtract` 传参）、`ItemContextMenu.tsx`（同改道）、i18n。
`askExtract.ts` 保留（movie-entry 仍在用），不再从动作行调用。

## 测试

- `StreamPanel.paste.test.tsx` 扩展：认领+视频 → modal；点转写 → 详情开 + POST 带内联 media；
  点下载 → triggerDownload；ESC → 不开详情。
- 转写档新测试：五状态、轮询随卸载停止、ws 事件按 item id 命中刷新、缓存命中直接全文。
- 后端零改动（「句柄未知+media」门已有 `conversions-routes.test.ts` 覆盖）。

## 非目标（v1 不做）

转写历史列表（方案 C，纯增量后手）、frames track 展示、发言人投影、modal 内读全文。
