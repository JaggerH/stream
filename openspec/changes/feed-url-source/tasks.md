# feed-url-source — tasks

## 计划 1：包与解析

- [x] 1. `packages/feed/parse.ts`：RSS 2.0 / Atom 最小解析（guid/id、link、title、正文、日期、作者；CDATA 与实体；命名空间前缀宽容）
- [x] 2. `packages/feed/adapter.ts`：`feed` adapter——`safeFetchResponse` 缺省传输、非 feed 文档报错、报频道名给自动命名
- [x] 3. `packages/feed/manifests.yaml`：`feed-url` 源（discoverable、timeline、key_param url、中性描述与例子）
- [x] 4. `src/kernel/plugins/adapters.ts`：注册 `feed` 宿主 adapter

## 计划 2：守卫与测试

- [x] 1. 解析 fixtures：RSS（CDATA / content:encoded / 实体）、Atom（id / rel=alternate / published）、HTML 页零条目、无身份条目跳过
- [x] 2. 内网拒绝：回环 / 私网 / link-local（云元数据）在守卫关闭时也不发请求；守卫激活时拒绝冒泡为 `CallerUrlBlockedError`
- [x] 3. 集成：本地 feed 第一次采到 N 条 → feed 新增一条 → 第二次恰好多这一条 → 再采 0 新
- [x] 4. `stream-pipeline` 钉住「页面地址当身份 → 内容变了也采不出新条」的失败模式（`browser-page` 不能追更新的结构证据）
- [x] 5. `stream_search` 空 note 指路更新（feed-url 先探、browser-page 只按单页快照说、都订不了如实说）+ 描述钉住
