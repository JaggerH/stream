# 接线：一个验证过的 Source 挂在哪一层

手里已经有一个跑通的 Source（manifest 条目或 recipe），这一步只回答**谁来调它**。概念的权威定义在
`docs/ARCHITECTURE.md`（Stream / Provider 两节），每个声明位的契约在 `docs/PACKAGE.md` §0.5——这里只做判路。

**先问一句：它的结果是「定时采进库」还是「调用时现取、交给调用方」？**
前者是 **Stream 成员**，后者是 **Provider 行的成员**。两条链互不相通：Stream 由调度器按节拍跑、条目入库；
Provider 行由调用点（`src/providers/callsites.ts` 的 `PROVIDER_CALLSITES`）在请求来时经 `ProviderExecutor`
（`src/providers/executor.ts`）执行、结果不落库。

## 判断表

| 你要的是…… | 挂法 | 要写的东西 | 本仓库里的例子 |
|---|---|---|---|
| 定时追更新；和同一条流里其他源**互补**（并集） | Stream 成员，`strategy: 'fanout'` | 不写代码。Stream 是用户数据：`subscribe_source`（MCP）或 `POST /api/streams` / `PATCH /api/streams/:id` 的 `members` | `src/streams/types.ts` 的 `strategy` 注释 |
| 定时追更新；和已有成员是**同一份内容的另一条路**（镜像 / 备用） | Stream 成员，`strategy: 'exclusive'`（按序梯子，首个健康的赢） | 同上 | `src/streams/from-provider.ts` 的 `makeStreamFromProviderLadder`（把一条 Provider 行的成员快照成 exclusive 流）；`src/scheduler.failover.test.ts` |
| 现取；已有调用点，那条行有 `{mode:'auto', provides}` 段 | 自动被收成成员 | **只在包里打标签**：manifest 的 `provides` 或 recipe 的 `meta.provides`，零宿主改动 | 资源搜索：`src/providers/system/resource-search.ts:28` 收 `search-download`，`packages/1lou/1lou-search.recipe.json:57`、`packages/pansou/manifests.yaml:49` 申报它；比价 `price-search` 收 `search-price`（`packages/manmanbuy/manmanbuy-search.recipe.json:91`）；`download-resolve` 收 `resolve-download`（`packages/btbtla/manifests.yaml:16`） |
| 现取；已有调用点，那条行是**点名成员**（`{source:…}`） | 行的具名成员 | 给这台部署加：`PATCH /api/providers/:id` 的 `members`；改出货默认：`src/providers/system/<id>.ts` 的 `defaultMembers`（见下「两个陷阱」） | `src/providers/system/music-search.ts:15`、`video-metadata.ts:21` |
| 现取；**按平台派发**的调用点（`mode: 'dispatch'`），这个平台还没有行 | 包出一条新 Provider 行 | 包的 `stream.providers[]`：`serveKeys` 用派发键（`<平台>-video` / `<平台>-link` / 平台键 / `<网盘>-verify`…），`callsites` 填那个调用点 id | `packages/bilibili/package.json:39-56`（`video.resolve` + `content.enrich` 各一条）、`packages/netease/package.json:28-37`（取歌，成员是 `{mode:'auto', matches}`）、`packages/quark/package.json`（四个 `netdisk.*`） |
| 现取；要**两步**才出货（搜索出壳 → 逐条钻详情出链接） | 包出一条 `strategy: 'expand'` 的行，再用 `provides` 让聚合行收它 | `stream.providers[]` 带 `expand` + `provides` | `packages/btbtla/package.json`（`provides: ["search-download"]`，被资源搜索的 auto 段当组合成员收进去） |
| 现取；**没有任何调用点**会问这类东西 | 宿主新增调用点（+ 一条系统行） | 见下「什么时候才改宿主」 | — |

一句话版：**同一份东西更稳 → exclusive 流 / sequential 行；更多东西进同一张列表 → fanout 流 / concurrent 行 /
auto 段；新的一种调用 → 新调用点。**

### 行内三种策略（`src/providers/strategies/`）

| `strategy` | 语义 | 典型 |
|---|---|---|
| `sequential` | 按行里的原序逐个试，首个合格结果赢；decline / 合同拒 / 抛错都落下一档（就是"兜底梯子"） | `download-resolve`、`lyrics-search`、所有 `resolve` 派发行 |
| `concurrent` | 全员并发、结果合并；唯一支持 `collect()`（逐成员成对结果，调用点按来源合并字段） | `content-search` / `resource-search` / `price-search`；影视详情三行（调用点带 `collect: true`） |
| `expand` | 有序两成员 `[A, B]`：A 出 handle，按 `expand.map` 参数化 B，B 的结果经 `expand.assemble` 装成 `links[]` | `packages/btbtla/package.json` |

别和身份上的 **`fallback: true`** 混：那是「本 category 没有具名键命中时落到的兜底行」，每个 category 至多一条
（`src/providers/system/fetch-url.ts:13`），与策略无关。

成员四型（`ProviderMemberRef`，`src/store/types.ts`）：`{source}` 点名一个源（可带 `name` 开同源多实例）；
`{mode:'auto', provides | matches | category}` 调用时按目录现展开（`provides` 标签 / RSSHub-Radar 匹配式 /
目录 category，`lyrics-search.ts:21` 用的是 category）；`{provider}` 引用另一条行（组合，递归 invoke）。

## 站点知识写在包的哪一格

**宿主只放机制，站点知识住包里**（`docs/PACKAGE.md` "The host/package boundary"；`src/no-facility-names.guard.test.ts`
扫宿主代码里的站名）。接线相关的几格：

| 要告诉宿主 | 声明位 | 生效 |
|---|---|---|
| 我这个源能被某类聚合自动收进去 | manifest `provides` / recipe `meta.provides` | 热重载 |
| 我出一条 Provider 行、是哪些 dispatch 调用点的默认行 | `stream.providers[]`（`callsites`）；行也可带 `provides` 以组合成员身份进聚合行 | **下一次启动**（身份表是装配期快照，`src/providers/identities.ts` 头注） |
| 哪些链接归我、是什么 | `stream.links`（`hosts` / `shortHosts` / `patterns`） | 热重载 |
| 资源搜索里我这个源怎么认（徽标键、主查询参数、条目形状） | `stream.searchSources` | 热重载 |
| 我顶掉了哪条 RSSHub 目录路由 | `stream.retires` | 下一次目录刷新 / 重启 |

几条硬约束（都是静默失败，不报错）：

- 包行的 `callsites` 只能填 `mode: 'dispatch'` 的调用点，填 fixed 的整条被拒（`setPackageIdentities`）。
  fixed 调用点（`search.content` / `search.resources` / `search.price`…）的默认行归宿主，包要进去**只能靠 `provides`**。
- 包行撞 `id`、撞同 category 的 `serveKeys`、或当第二条兜底 → 被拒，其余照进；拒绝理由在启动日志里。
- 只写了 `serveKeys` 没写 `callsites` 的派发行不在绑定里，**永远派发不到**。
- `content.enrich` 的键 `<平台>-link` 来自认领函数 `recognizeLinkSync`（`src/links/recognize.ts`）——包没在
  `links.hosts` 里认领主机，平台认不出，键拼不出来。
- `video.resolve` / `content.enrich` 给成员的输入是对象（`{vid, format}` / `{url}`），源从 `params.vid` / `params.url`
  读（`memberCallArgs`，`src/providers/invoke-types.ts`）。

### 两个陷阱：运行时编辑 vs 出货默认

- `PATCH /api/providers/:id` 的 `members` 是**整数组替换**：先 `GET /api/providers/:id` 拿当前 `members`，追加后整份写回。
  系统行的身份字段（category / serves / strategy…）PATCH 会被 400 拒，可改的只有 members / options / label / description。
- 改 `src/providers/system/<id>.ts` 的 `defaultMembers` **只影响新装机**：`ensureSystemRows`（`src/providers/seed.ts`）只补缺失的行，
  不覆盖已存在行的 members。点名成员写包全名 `@streamapp/<包>/<源>`，旁边注释写「为什么是宿主的判断」。
  哪台机器要现在就生效，走上一条。

## 什么时候才改宿主

只有这三种：

1. **新的一种调用**：`PROVIDER_CALLSITES` 加一个调用点（fixed 还是 dispatch、category、`entries`；要按来源合并字段就标
   `collect: true`），再在调用方（HTTP 路由 / MCP 工具）里经 `ProviderBindings.fixed()` / `.dispatch()` 取行、`executor.invoke()`
   或 `.collect()` 执行。dispatch 调用点宿主默认留空、用 `callsiteDefaultsFor(id)`，让包行来填。
2. **新的一条系统行**（fixed 调用点的默认行）：`src/providers/system/<id>.ts` 一个模块 + `index.ts` 一行，
   `src/providers/system/index.real.test.ts` 的行数随之改；宿主手写的调用位置注记在 `seed.ts` 的 `PROVIDER_CALL_SITES`。
   成员优先写 `{mode:'auto', provides: <新标签>}`，别点名站。
3. **新的执行策略**：`src/providers/strategies/index.ts` 头注列了要动的三处。

其余情况都只动包。

## 验证：它真被派发到了吗

先 `curl -s 127.0.0.1:8900/api/health` 核活体版本；包行是启动期快照，`pending_restart > 0` 就先 `POST /api/restart`。

```bash
# 1. 行里有没有它（auto 段已展开；calls 是执行器打的调用账）
curl -s 127.0.0.1:8900/api/providers/resource-search | jq '.resolvedMembers[].source.id, .calls'
# 2. 派发键落到谁头上（dispatch 行）
curl -s '127.0.0.1:8900/api/providers?category=resolve&key=bilibili-video' | jq '.items[].id'
curl -s '127.0.0.1:8900/api/provider-callsites' | jq '.items[] | select(.id=="video.resolve") | .binding'
curl -s '127.0.0.1:8900/api/links/recognize?url=<一条链接>'
# 3. 真跑一次，确认它的条目回来了
curl -s '127.0.0.1:8900/api/search?scope=resources&q=<片名>'      # scope: content | music | price | resale | resources | video
curl -s '127.0.0.1:8900/api/media/from-url?url=<一条链接>'         # content.enrich
```

**「在行里」≠「出了结果」**：路由参数对不上的成员表现为空结果（decline），不是启动错误——第 3 步必须看到它自己的条目。

对应的测试（改了声明或宿主就跑这些）：

| 钉什么 | 文件 |
|---|---|
| 包行并表、撞名硬拒、`callsites` 只收 dispatch | `src/providers/identities.test.ts` |
| 调用点默认 = 宿主默认 ∪ 包行 | `src/providers/callsites.test.ts` |
| auto 段展开、`provides` 收组合行 | `src/providers/executor.test.ts`（`auto provides 段也收申报了 provides 的 Provider 行`） |
| 系统行数、成员指向真源、一 category 一条兜底 | `src/providers/system/index.real.test.ts` |
| 真实出货包的资源站 / 网盘声明装得进、指得上 | `src/packages/resource-sites.real.test.ts`、`src/packages/netdisk-providers.real.test.ts` |
| 链接认领 | `src/links/recognize.test.ts` |
| 按平台派发的播放路由 | `src/http/app.video-resolve.test.ts` |
| exclusive 流的梯子 | `src/scheduler.failover.test.ts` |
