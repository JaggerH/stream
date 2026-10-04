# PACKAGE.md — Stream 包：能填哪几格、每格的契约是什么

**扩展 Stream 的单位只有一种：Stream 包。** 内置包住在仓库的 `packages/<id>/`（49 个），用户从 npm 装的第三方包住在 `<dataDir>/recipes/<@scope__name>/`（目录名是历史布局，装载器对两处一视同仁）。同一份 `package.json#stream` 描述、同一个扫描器、同一条装载路径。

**内置包 = 出厂快照，npm = 更新通道。** 每个内置 recipe 包同时是一个 npm 包（`packages/<id>/package.json` 的 `name`，`@streamapp/<id>`）。改 recipe 的动作是：改 → bump 该包 `version` → 合 `main`，CI（`release-recipes.yml`）把 npm 上没有的版本发出去；不 bump 就不发。**前提：只有已经在 npm 上的包由 CI 跟版本**——一个包的首发是人手动 `npm publish` 一次（哪些包公开是生意上的决定，CI 不靠"npm 上查不到"去推断该发）。用户 `stream update` 把新版装进 `<dataDir>/recipes/`，同名包整包盖住内置那份（`mountRecipePackages`），CLI 主包不用重发。`@streamapp/` scope 的包与内置层同等信任（凭据注入照常，`OFFICIAL_SCOPE`）；别的 scope 用同名照旧不拿凭据。**`STREAM_NPM_REGISTRY` 指着镜像时，`@streamapp/` 包多向官方源核一次校验和**（`officialRegistryIfMirror` → `mirrorVerdict`）：一致才算官方；不一致 / 官方源没这个版本 / 连不上 → 照装，但包目录里落一份 `.stream-trust.json`（`TRUST_SIDECAR`），闸 3 按第三方对待、`stream update` 也不走自动装。不核的话镜像站就成了「谁能拿凭据」的信任根，而信任根只能是 npm 官方的 scope 归属。后端每天查一次更新（调度中心里的 `recipe-update-check` 任务，可手动立即跑一次），只在日志里提示（`STREAM_RECIPE_UPDATE_CHECK=0` 关掉）。

一个包声明它填了哪几个**能力槽位**：

| 槽位 | 声明处 | 它让宿主替包做什么 | 契约在 |
|---|---|---|---|
| Source 清单 | `manifests.yaml` 或 `stream.sources` | 把这些 Source 注册进 registry | §1 |
| recipe 数据 | `*.recipe.json` + `stream.facility` | 交给 replay 运行时，manifest 由 recipe 的 `meta` 派生 | §2 |
| 代码 | `activate.ts` + `stream.code` | 启动时调 `activate(ctx)`，收下它交出的 adapter / normalizer / 动作 | §3 |
| 能力 | `stream.capability` | 在后端进程里 `mount(ctx, config)` 它，把它注册的工具接到 `/api/mcp` 上 | §5.9 |
| docker 容器 | `stream.backend` | 建容器、接 `stream` 网络、健康检查、standby 回收、`/_p/<id>` 网关 | §4 |
| 凭证域 | `stream.credentials` | 铸 broker token，容器凭它取 cookie | §5 |

一个「插件」= 填了插件类槽位的包。它的目录长这样：

```text
packages/<id>/
  package.json      # descriptor：npm 壳（name/version）+ `stream` 字段承载领域字段
                    #   （id、catalog 展示字段、backend 容器声明、credentials、normalizer key）
  manifests.yaml    # 该包贡献的 Source manifests（顶层 YAML 列表）
  adapter.ts        # 独占归属的 adapter 代码（可选收编；核心/共享 adapter 留在 src/，见 §10 表格）
  activate.ts       # code 槽位的入口：导出 activate(ctx)，交出这个包贡献的 adapter / normalizer / 动作（见 §3）
```

纯 recipe 包一格插件槽位都不填，目录里只有 `package.json` + 若干 `*.recipe.json`（例：`packages/bt0/`）。
一个 recipe 包也可以再填代码槽位——`packages/xhs/` 就是四份 recipe + `activate.ts`（normalizer / enricher / adapter 全经
`ctx.readSource` 跑本包自己的 recipe，见 §3.2），填了代码槽位它就进 `/api/plugins`。

> 扫描器（`src/packages/scan.ts` 的 `scanPackages`，`src/plugins/loader.ts` 是它的薄壳）按文件夹装载：`package.json` 的 `stream` 字段为描述符（解析器 `src/packages/descriptor.ts` 的 `parseStreamDescriptor`），`manifests.yaml` 的顶层列表并入 `sources`（两处同时声明会直接报错）。`packages/` 顶层的散装 `*.yaml` 不是包，会被大声拒绝。内置包目录由配置字段 **`packages_dir`** 指定（默认 `./packages`）。包形状的权威设计见 `internal design record`，发布/安装流程见 `.claude/skills/share-recipes/SKILL.md`。Recipe 包的 Source **自描述**：由 recipe 的 `meta` 块经 `recipeToManifest`（`src/replay/recipe-manifest.ts`）派生出 `SourceManifest`——agent/用户生成的 recipe 无需手写 `manifests.yaml`（存在时是可选全量覆盖逃生口，仍过同一个 `manifestSchema`）。

### 「是不是插件」按槽位判，不按目录判

判据是一个具名函数：**`fillsPluginSlot`**（`src/plugins/loader.ts`）——包填了 `backend` / `code` / `capability` / `normalizer` / `sources` / `sourceGrouping` / `credentials` 里任意一格，它就有东西要经插件那条投影出去。

- **`/api/plugins` 只列填了插件类槽位的包**（今天 **22 个**，仓库 49 个包里的一部分）。纯 recipe 包不在那儿列。这是**产品口径**，不是遗漏——`/api/plugins` 回答的是「宿主替谁干活」。用户看的那份「我装了什么」是第三个读模型 `GET /api/packages`（两层全部的包，见 §8）。
- **一个包两条槽位都填是合法的**（带容器的 recipe 包），它会同时出现在两个投影里——这正是按槽位判而不是按目录判的意义。
- **判据宁可宽**：漏掉一个包 = 它的容器不被接管、`/_p/<id>` 恒 404、凭证 token 不铸，且**这类缺失没有任何日志会提到**。往 `StreamDescriptor` 加一个「要宿主替它做点什么」的新槽位时，`fillsPluginSlot` 也要加一行；数字由 `src/plugins/loader.real.test.ts` 钉着，判据一放宽就当场变红。
- **两个投影不能重复吃同一份 manifest**：插件包的 `manifests.yaml` 已经走插件那条注册进 registry，recipe 投影就不许再吃一遍——同一份 manifest 进两个 registry group，`Registry.swapGroup` 会抛 `Duplicate manifest id`，后端起不来。
- **想让界面上多列几个包，改的是投影，不是 `fillsPluginSlot`。** 这个判据同时管着三件事——容器要不要接管、`/_p/<id>` 通不通、凭证 token 铸不铸。为了让某个包在界面上露个面而放宽它，等于顺手让宿主去接管一个它本来不该碰的容器。「界面上列谁」和「宿主替谁干活」是两个问题，别用同一个开关。

### 界面上的两个入口：「源」和「组件」

按用户在做的动作分，不按代码分层分：

| 入口 | 回答的问题 | 频率 | 吃哪个端点 |
|---|---|---|---|
| **源**（`/sources`） | 找一个源，把它配成我的流 | 天天 | `/api/plugins` + `/api/plugins/:id/sources` |
| **组件**（`/packages`） | 装了什么 / 还活着吗 / 怎么配 / 再装一个 | 出事或想扩能力才来 | `/api/packages` + `/api/providers`（装卸走 `/api/recipes/packages/*`） |

接缝在**使用与拥有**之间。所以启用开关、容器状态、装卸升级**只在「组件」页有一份实现**——
源页那边只有一个只读的「已停用」标记和一颗跳过去的按钮。同一个开关在两处各写一份，
迟早说法不一致，而不一致的表现是"这一页说开着、那一页说关着"，两边单看都正常。

组件页同列两类组件：**包**（三段，见下）与 **Provider 行**（能力行段：类别/成员数/parked，
点行进 Provider 工作台——成员/路由/测配那套定制编辑面整套在工作台里，`/providers` 路由保留
但**不是一级入口**，spec `2026-08-17-component-page-design.md`）。

包的部分按**「坏了会怎样」**分三段（具名判据 `bandOf`，`app/src/components/packages/PackagesPage.tsx`）：
容器（`hosted`）/ 内置能力（提供源清单或代码）/ 抓取配方（只有 recipe 数据）。
容器那段**只在出事时占版面**：出错的常驻浮出，其余收进折叠。设计见
`internal design record`。

### 宿主替包做的那些事在哪

Stream 进程（`src/`）是 host/orchestrator。它负责：

- 加载 **source manifests**（`packages/<id>/manifests.yaml`）——每个数据源的声明式契约（`src/manifest/types.ts`）。
- 加载 **plugin descriptors**（`packages/<id>/package.json` 的 `stream` 字段）——把设施变成 Stream 托管插件的标准（`src/plugins/types.ts`）。
- 注册 **adapters**——把设施 API → Stream item，按 `manifest.adapter` 路由。设施的 adapter 由**包自己**在 `activate(ctx)` 里交出（`packages/<id>/adapter.ts` + `activate.ts`，见 §3）；`src/bootstrap.ts` 手工织的只剩宿主四件（builtin / rsshub / replay / browser）。
- 注册 **normalizers**（`src/content/normalize.ts` 的 `registerNormalizer`）——把原始 item 归一化成展示模型，按 `manifest.normalizer` 路由（`presenter` 字段仍被接受，作为向后兼容别名）。有包的 normalizer 由包在 `activate` 里交出；名字撞了一律硬拒、不覆盖。
- 解析 **credentials**（`src/credentials/*`）——登录态 cookie 是凭证提供方 #1（见 §5）。
- 把包交出的 **enricher** 露到两个面上（`src/http/app.ts` 的 `GET /api/enrich` 与 `src/http/enrich-ws.ts` 的 WS 命令 `enrich.open`）——「这条 item 打开时去哪现取」由包的 normalizer 写在 `Content.enrich` 里，前端照着调，宿主不认识任何站（契约见 §3.2，协议见 `docs/API.md`「包交出来的处理器」）。
- 读 **facility 级声明**（`package.json#stream` 的 `rateLimit` / `cookieDomain` / `serving` / `retires` / `providers` / `links` / `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` / `item`）——它们是**关于这个站的事实**，宿主只是读表：限速、拉登录态、媒体直链走代理、把被顶掉的 RSSHub 路由挡在目录外、建这个包出的 Provider 行、认出「这条链接归谁、是什么」、给认领的 RSSHub 命名空间盖上 normalizer、不因上游虚标的 `requirePuppeteer` 丢掉纯 HTTP 能跑的路由、把登录态按 RSSHub 要的环境变量名递过去。**声明 ≠ 槽位**：填了它们的包仍是纯 recipe 包，不进 `/api/plugins`（`fillsPluginSlot` 不认它们）。见下一节。

### 宿主与包的边界：什么算「宿主认识某个站」

**一句话：宿主只放机制和接口；「某个站长什么样、怎么调它」住在那个站的包里。**「宿主」= 后端 `src/`、
`shared/`、前端 `app/src/`、扩展 `extension/src/`、DSH 产物 `hosts/dsh/src/`、能力包 `capabilities/*/src/`
——守卫 `src/no-facility-names.guard.test.ts` 拿同一张名单扫这六个根（`.ts` / `.tsx`）。

判「宿主认不认识某个站」只看代码，不看散文：

| 算「认识」（不许出现在宿主） | 不算（允许） |
|---|---|
| 站点域名的**代码级**出现（字符串、正则、URL 拼接） | 注释里拿某站当**活体证据**（哪天、哪条、多少秒、哪个 CDN 拒了） |
| 源 id / 包名 / 平台键的字面量（`'<站>-detail'`、`@streamapp/<站>`） | 自动生成的整网目录（`app/src/lib/source-domains.ts`，RSSHub 全站表，按完整路径豁免） |
| 只为某站存在的标识符（`<站>Comment`、`<站>NoteId`、`fetch<站>`） | 金样语料（`golden-*.ts`、`gold.ts`）与测试夹具（`__fixtures__/`、`*.test.*`） |
| 读某站上游响应的字段名 | **宿主的领域模型**：TMDb id 作为影视身份主键；网盘分享链接文法（`shared/netdisk/share-link.ts`，覆盖没有包的网盘） |
| | **网盘领域实现**：`shared/netdisk/<盘>/`（夸克 / 百度的验分享、转存、播放、跳转客户端）与宿主侧的网盘驱动映射（`src/netdisk/backend.ts`、`src/netdisk/sync.ts` 的挂载路径 / 驱动名 → 网盘键）。网盘是宿主的一等领域（匹配、归档、追更都建在它上面），逻辑只有一份、由宿主与 `capabilities/netdisk` 能力包共用——与分享链接文法同一性质 |
| | **AList / OpenList 是宿主的网盘底座**：`src/netdisk/alist-client.ts`、接管序列、`settings.rows('alist')`、离线成员 `{plugin:'alist', source:'alist-audio'}` 属于领域模型。「哪个包是底座」全仓只由 `src/netdisk/base-package.ts` 的 `NETDISK_BASE_PACKAGE_ID` 回答；**前端仍不按包 id 分支**——后端在 `/api/packages` 出线上标 `role: 'netdisk-base'`，前端只看 `role` |
| 按站名分支（`stream_id.includes('<站>')`、`source === '<站>-detail'`） | **宿主的产品默认值**：梯子默认成员的顺序、默认频道的种子源——必须写**包全名**（`@streamapp/<包>/<源>`），且在旁边注释写「为什么是宿主的判断」 |

**前端同一条规则，还多一条：前端不按站分支。** 前端只渲染 item / content / 源目录**申报了什么**：
作者头像去哪取（`item.author_enrich`）、有没有点赞按钮（`item.actions`）、源叫什么（`item.source_label`）、
图标用哪个域名（`item.source_site` / 源目录的 `site`）都由包声明、后端投影给前端（出线口见 `docs/API.md`
「Items 出线形状里的投影格」）。

**知识该放哪个声明位**（`package.json#stream` 的全部键以 `STREAM_DECLARATION_KEYS` 为准、`code` 的子格以
`codeSchema` 为准，均在 `src/packages/descriptor.ts`）：

| 我要告诉宿主的是…… | 声明位 | 契约 |
|---|---|---|
| 这个包是谁、叫什么、官网在哪（官网主机 = 源目录与条目的 `site`） | `id` / `name` / `tagline` / `description` / `homepage` / `repository` / `docsUrl` / `author` / `facility` | §0 |
| 要求哪个版本的宿主 | `hostVersion` | §6.3 |
| 我出哪些 Source | `sources` / `manifests.yaml`；recipe 的 `meta` 派生 | §1、§2 |
| 这些 Source 怎么在选择面上分组 | `sourceGrouping` | §8 |
| 我的原始条目怎么变成 Content | `normalizer`（旧别名 `presenter`）+ `code.normalizers` | §3 |
| 我的 Source 由哪段代码执行 | `code.entry` + `code.adapters` | §3.1 |
| 条目打开时去哪现取剩下的 | `code.enrichers` + normalizer 写的 `Content.enrich` | §3.2 |
| 登录态掉了怎么重登 | `code.connect`（域名必须在 `credentials` 里） | §3.2、§3.4.6 |
| 我需要哪些域的登录态 | `credentials` / `cookieDomain` | §5 |
| 我要一个容器 | `backend` | §4 |
| 我带一个能力（MCP 工具） | `capability` | §5.9 |
| 这个站多快会封我 | `rateLimit` | §0.5 |
| 这个站的媒体直链浏览器拿不到 | `serving` | §0.5 |
| 我顶掉了哪些 RSSHub 目录路由 | `retires` | §0.5 |
| 我出 Provider 行、是哪些调用点的默认成员 | `providers`（`callsites`） | §0.5 |
| 哪些链接归我（主机、短链）、是什么（曲目 / 下载中转页） | `links`（`hosts` / `shortHosts` / `patterns`；老别名 `trackUrl` / `downloadPages`） | §0.5「`links`」 |
| RSSHub 目录里这些命名空间归我渲染 / 其实不要浏览器 / cookie 按什么环境变量名递 | `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` | §0.5 |
| 资源搜索里我这个源怎么认 | `searchSources` | §0.5 |
| 我的条目上要画作者头像 / 可点动作 | `item`（`authorEnrich` / `actions`） | §0.5 |
| 我这份 recipe 能被哪类聚合自动收进去 / 是哪个品类的产品库 | recipe 的 `meta.provides` / `meta.catalog` | §0.5 末 |
| 旧形 recipe 包的判别字段 | `type` / `schemaVersion` | §2.7.1 |
| 这个包不许用户关 | `required` | §8 |

**新增声明位的规矩**：先查上表有没有能表达的；没有才加。加的时候四样一起给：schema（`descriptor.ts`）、
装载期校验（坏声明整个包拒装，错误信息指到字段路径）、漂移守卫（`STREAM_DECLARATION_KEYS` 驱动的
`src/replay/recipe-package.declares-knowledge.test.ts` 会逼你回答「它算不算 facility 知识」）、上表一行。

> 本文只覆盖架构中的 **Plugin 层**（Source 的归属与执行边界）。五个概念
> （Channel / Stream / Provider / Source / Plugin）的权威定义、不变量与数据流见
> **[docs/ARCHITECTURE.md](ARCHITECTURE.md)**。

---

## 0. 终局形态：组件模型（目标态，分片落地中）

> 本节写的是**目标态**，不是现状。现状（各槽位怎么声明、怎么装载）从 §1 起；本节定的是
> 这一切最终收敛成什么样，分片迁移的 spec 落地一片就把那一片从"目标态"改写成正文。

**组件 = 可装、可配、可停、可被引用的管理单位。** Stream 里够得上组件的只有两类：
**包**（builtin / npm 装入）和 **Provider 行**（系统件 / 用户自建）。**Source 不是组件**——
它是包声明出来的展开项，管理面上折叠在所属包之下；**Channel 不是组件**——它是用户数据
（订阅与视图），归频道页管。

三条收敛，对齐 DSH/cordis 家族的组件形状：

1. **一切可配置的东西 = 一个带 schema 的 row。** schema 用
   [schemastery](https://github.com/shigma/schemastery)（cordis 家族的 schema 库；内核已是
   cordis，DSH 用的同一个）声明字段、类型、默认值。一份声明三处受益：写入校验、分层合并
   时的默认值语义、**表单自动生成**。今天的四套手搓各归各位：6 个 `/api/settings/*` 端点族
   的手写 GET/PUT + 手画表单、源 `runtime_config` 的 `withRuntimeDefaults` 两层合并、
   Provider 行的自带编辑面、频道槽位的局部覆盖——全部换成同一个 row 模型。手写表单只留给
   真需要定制交互的（如网盘目录选择器）。
2. **存储一张分层表**：`层 + rowId + 值`，合并顺序固定为 **内置默认 → 用户全局 → 局部**
   （频道槽位 `options.slots` 就是局部层的一个实例，语义不变只换存法）。既有判据保住：
   空串 = 用户主动清空，不回落默认。
3. **一张组件表的管理面**——就是「组件」页：包三段 + Provider 能力行段同列，Provider
   工作台是点行进入的详情面，管理入口共 3 个（见上「界面上的两个入口」）。尚欠：包行的
   「被谁引用」（Stream 成员 / binding 反查）。

**不动的边界**：「Stream 包 ≠ Cordis 插件」不变量保持（见 ARCHITECTURE 内核一节）——
收敛的是**配置与管理模型**，不是装载机制；包仍是跨进程信任边界，六格槽位契约（§1–§5）
原样有效。装载层是否也交给 cordis Loader 是独立的后续决策，不在本节承诺内。

---

## 0.5 facility 级声明：`rateLimit` / `cookieDomain` / `serving` / `retires` / `providers` / `links` / `rsshubNamespaces` / `rsshubNoBrowserNamespaces` / `rsshubCookieEnv` / `searchSources` / `item`

**包 = 一个 facility 的全部知识单位。** 一家站的事实在它的包上声明一次，所属每条 recipe 自动继承；
源码里只有泛化机制。判据："这条知识是关于**站**的（CDN 脾气、限速、登录域、顶掉了哪条上游路由），
还是关于**某个接口**的（字段路径）？"前者进 `package.json#stream`，后者进 recipe。

| 字段 | 含义 | 消费方 | 生效时机 |
|---|---|---|---|
| `rateLimit` | 频率闸门（多包同 facility 取最严） | 采集 `FacilityRateLimiter` | 热重载即生效 |
| `cookieDomain` | 登录态从哪个域拉 | 凭证注入 | 热重载即生效 |
| `serving[]` | `{ match, hosts?, referer?, reason }`：命中 `match` 的媒体直链改由后端代理、可换 `hosts` 里的备选主机；`referer` = 这台主机的字节要带哪个 Referer 才给（反向防盗链的图床，范例 `packages/rsshub` 的豆瓣图床），宿主替它取字节的每一处（图片代理 / 海报比对 / 本表的代理透传）都带上 | `src/media/serving.ts` `servingPolicyFor`（播放 + 转写取字节）、`refererForUrl`（`src/http/image-fetch.ts` / `src/video/poster-similarity.ts`） | 热重载即生效（thunk 现取） |
| `retires` | `{ 'rsshub:<ns>/<path>': 理由 }`：这个包顶掉了哪些 RSSHub 目录路由——上游已使它失效，**或本包一条源接管了同一条路由** | `src/rsshub-catalog.ts` 解析目录时挡掉；`src/providers/seed.ts` `pruneDeadMembers` 清掉指向它的系统行成员 | **下一次目录刷新 / 重启**（目录只在那时解析） |
| `providers[]` | 这个包出的 Provider 行（`{id, category, serveKeys, strategy, label, description, members, callsites?, fallback?, contract?, expand?, provides?}`，形状见 `src/packages/descriptor.ts` 的 `ProviderDeclaration`）。宿主并进身份表、`ensureSystemRows` 建行并标 `system:true`。`strategy:'expand'` 必须带 `expand`（A→B 组合子配置，同进同退）；`provides:[标签]` 让这条行**以组合成员的身份**被任何 `{mode:'auto', provides:标签}` 段收进去（与源 manifest 的 `provides` 同一张标签表，拿原始输入，本行与祖先行自动跳过）——包出的组合体行靠它进宿主的聚合行，不点名 | `src/providers/identities.ts` → `src/providers/seed.ts`；auto 段在 `src/providers/executor.ts` | **下一次启动**（身份表是快照，理由见 identities.ts 头注） |
| `links` | 「哪些链接归我、是什么东西」：`{ hosts, shortHosts?, patterns? }`——认领的主机（带 / 不带 platform）、短链主机、路径级类型（`track` 带命名组 `id`；`download-page` 带 `yields`，兼作 SSRF 白名单）。详见本节末「`links`」 | 认领函数 `src/links/recognize.ts`（`content.enrich` 派发键、曲目识别、下载中转页、`GET /api/links/recognize`）；校验 `src/packages/links.ts` | 热重载即生效（thunk 现取） |
| `trackUrl[]` / `downloadPages[]` | 迁移期别名，装载时翻译成 `links.patterns`，见本节末「`links`」。内置包不许再写 | — | — |
| `searchSources[]` | 「资源搜索里我这个源怎么认」：`{ source \| provider, key, label, param, kind: 'digest'\|'flat', nsfw?, searchUrl? }`。`source`（本包局部名，装载期补全名；含 `:` 的 RSSHub 目录路由 id `rsshub:<ns>/<path>` 原样保留——目录路由不归任何包命名空间，范例 `packages/rsshub`）与 `provider`（本包出的行 id，组合体以行的身份出现）恰给一个；`key` 打在 `Release.source` 上给前端配徽标；`param` 是主查询参数名；`kind` 是条目形状（`digest` = 一条是「片名 + 一串网盘链接」的合集体，`flat` = 一行一个种子）；`searchUrl` 是站内搜索页模板，`{q}` 换成编码后的查询词 | `src/search/seeds.ts` `searchMetaBySourceId`（整张表都来自包声明，宿主不留一行） | 热重载即生效（thunk 现取，同 `links`） |
| `rsshubNamespaces[]` | 「RSSHub 目录里这些命名空间的路由用我的 normalizer」，normalizer 键 = 包 facility | `src/rsshub-catalog.ts` 解析目录时盖上 `normalizer`，同时把路由的 `facility.label` 换成包名（`facility.key` 不变） | **下一次目录刷新 / 重启** |
| `rsshubNoBrowserNamespaces[]` | 「目录里这些命名空间的路由标了 `requirePuppeteer`，但带 cookie 走纯 HTTP 就能跑」——包对上游标记的一句反证。不声明的命名空间里标了 puppeteer 的路由一律不进目录（宿主没有浏览器，也不点名任何站） | `src/rsshub-catalog.ts` 解析目录时不因 `requirePuppeteer` 丢掉它们（各包声明取并集，两个包说同一个命名空间不算冲突） | **下一次目录刷新 / 重启** |
| `item` | 「本包的源产出的条目上多带什么」：`{ authorEnrich?: { enricher, params }, actions?: [{ id, icon, label, recipe, params, toggle: [未按下发的, 已按下发的] }] }`。`params` 的值里只认 `{点路径}` 占位符（从条目上取：`author`、`content.enrich.params.<k>`、`content.meta.<k>`…），**任何一个取不到那条整条不出**；不做表达式、不做条件。`authorEnrich` 只在条目没有 `author_avatar` 且有 `author` 时出，enricher 回 `{ name?, face?, url? }`（`url` 是作者主页，站点地址只住包里）。动作点一下走 `POST /api/recipes/action`，参数 = `params` + `action: toggle[…]`。装载期校验（任一不过整个包拒装）：`recipe` 必须是**本包全名**（包没有 npm 名就不许声明动作）、`icon` 在宿主词表（`shared/item/actions.ts` 的 `ITEM_ACTION_ICONS`，今天 `heart` / `bookmark`）、`toggle` 恰两个非空值、动作 id 不重复、`authorEnrich.enricher` 在本包 `code.enrichers` 里。**只作用于本包的源**：`rsshub:<ns>/…` 按 `rsshubNamespaces` 认领，其余按源目录那条的 `facility.key` | `src/packages/item-projection.ts`，经出线口 `toClientItem`（四条条目读口都走它）**投影时现算**——不写进入库的 content，存量立刻生效、包升级也立刻生效 | 热重载即生效（thunk 现取） |
| `rsshubCookieEnv` | `NAME_{CookieName}`：把该域的 cookie 串写进这个环境变量交给 RSSHub，`{CookieName}` 换成同名 cookie 的值。文法 `/^[A-Z][A-Z0-9_]*(\{[A-Za-z0-9_]+\}[A-Z0-9_]*)*$/`，命中不了整个包拒装。模板表按**包 facility 和 `rsshubNamespaces` 里每个命名空间**各登记一份（RSSHub 路由的 `inject.ref` 是命名空间），两个包对同一个键给出不同模板时后到的被忽略并落一行日志 | `src/credentials/cookie-provider.ts`（先查它，再查宿主 `transformRegistry`） | 热重载即生效（thunk 现取） |

**recipe 级也有两格站点知识**，写在 `*.recipe.json` 的 `meta` 里（manifest 投影会剥掉未知键，消费方读的是
原始 recipe）：`meta.provides: [标签]` 让这份 recipe 被同标签的 `{mode:'auto', provides}` 段自动收成聚合成员
（`search-download` / `resolve-download` / `search-price` / `search-resale` / `search-content`…，装上即入、关掉即出，
宿主行不点名任何站；manifest 源同样用 `provides` 申报，如 BT影视包的 `magnet-btbtla`）；
`meta.catalog: { category, param?, bands?, exhaustive? }` 是「购买决策枚举全集时，这个品类去问我、按这几档问」的
产品库声明（宿主 `src/agent/purchase/universe-catalog.ts` 只读表；缺省不写 `exhaustive` 就当样本标 `truncated`；
范例 `packages/zol/zol-phones.recipe.json`）。

**同一个 npm 名的包两层都在**（内置 `packages/<id>` + 用户 `stream add` 装来的同名新版）时，**只装载版本高的
那一层的一切**——代码、`manifests.yaml`、recipe、上表里的声明与 `states.json`——另一层整包跳过并留一行日志
（`[stream] package <npm 名>: user layer <v> supersedes builtin <v>` / `builtin <v> kept, user layer <v> skipped`）。
尺子 = `shared/package-sdk/semver.ts`：用户层严格更高 → 用户层；相等、更低、任一层缺合法 `x.y.z` → 内置（看不懂的
版本号——`v1.0.0`、`1.2`、缺失——按「不比内置高」读）。为什么两头都要：内置包随宿主同版本出货，它的声明与宿主机制
对得上，用户层那份可能是任何旧版，旧版少一格声明就是静默丢能力（播放变 502、目录路由消失、Provider 行建不出来），
没有一处会喊——所以旧版不许赢；而内置包也发 npm，`stream update` 拿到的新版本就是为了让用户不升宿主也能拿到
新声明——所以新版必须赢，赢的是**整包**（新版少一格声明 = 作者删的，不叠加旧版的）。决定只有一处：
`pickLayers`（`src/packages/pick-layer.ts`），四个消费者拿同一个结论——代码激活（`src/kernel/plugins/packages.ts`）、
recipe / manifests 装载与声明归并（`src/replay/recipe-package.ts` 的 `mountRecipePackages` /
`mergeRecipePackagesByFacility`）、curated 投影（`src/kernel/plugins/sources.ts`：被顶掉的内置包的 `manifests.yaml`
不再从插件描述那条路进 registry——否则与用户层那份撞成 `Duplicate manifest id`，用户装的整包被跳过）。不整层
一起挑、各条路各自"同 id 覆盖"是不够的：内置包的 `manifests.yaml` 有 curated 这条第二条路，逐条覆盖管不到它。
判的是 npm 名不是 `stream.id`：id 是包自己写的，npm 名的唯一性由 registry 保证；没有 npm 名的手放本地包不参与
比对（同全名时 user 层盖 builtin，撞了 curated 由启动期的逐包重试摘掉）。被顶掉的内置包仍留在 `/api/plugins`
目录里（那是启动时的描述符快照，只标内置那份的元数据），`/api/packages` 的目录与 `stream list` 才是「装了什么」
的真相。**被禁用的内置照样按版本参赛**（整包规则不看开关）；用户层赢了而内置那个插件被禁用 → 用户层那份
也不装（开关的机制是"禁用的插件不出 curated"，被顶掉的内置本来就不出，所以要连用户层一起挡，否则开关形同虚设），
翻开开关后下一次热重载装回来。**运行中**装进同名新版：取舍冻在启动那份（curated 不热换，现算会让之后每一轮
热重载都撞 `Duplicate`），这一轮先不装它、日志说 `user layer installed, takes over on restart`（只在顶掉的内置
确有 curated 清单时；顶掉的是纯 recipe 包就直接生效）——重启后切换。

**同一个 facility 两层都有包、npm 名不同**（第三方给这个 facility 的附加包）时：两层的 recipe 都挂上（归并键是
`<npm 包名>/<局部名>` 全名，包名不同就并存）；描述符按 facility 归并，不同包的版本号不可比，**上表里除 `rateLimit`
外的声明、以及 `states.json`，一律内置为准**（名单 = `src/replay/recipe-package.ts` 的 `DECLARATION_FIELDS`），
用户层只叠加内置没声明的格、recipe 与展示字段（`stream.name` / npm name / version 用用户层的）；`rateLimit` 取最严。

`match` 至少两段标签（`.fm` 拒、`.lizhi.fm` 收）：带上 `hosts` 之后这条策略会**替换主机**，
一段标签等于替整个后缀下所有 facility 决定字节从哪来。

`serving.hosts` 是让**后端**去连的地址——第三方包能借它让后端打内网。装载时把这串主机按 URL 层
真正会去连的那个形式归一（`0177.0.0.1`、`[::ffff:127.0.0.1]`、`localhost.` 都先还原）再判：私网 /
loopback / 链路本地 IP、单标签名、解析不出来的串，命中任一整个包拒装。**解析到私网 IP 的公网主机名
判不出来**（装载不做 DNS），安装确认页因此必须亮出 `proxies`（preview 字段），让用户看见它要连谁。
`retires` 只放两类："上游已使它失效"的，和"本包一条源接管了同一条路由"的（同一条路由目录里再留它，
内容搜索就出两份）；"我们更喜欢自己那份、但两条路由不同"归 `priority`。

**`providers` 的撞名规则（硬拒，不覆盖）**：`id` 撞任何现有行、或 `serveKeys` 里任一键已被**同 category**
的某行 serve → 拒这一条并落一行日志，其余照进；同 category 里第二个 `fallback` 也这么拒。两个包声明同一个
键时先到先得。用户**自建**的行（`system: 0`）不参与这条判据——那是用户自己的数据。包卸载后下一次启动，
`ensureSystemRows` 现有的「`system=1` 且 id 不在身份表里 → 清槽 + 删行」清退路径自然把它收走，不需要迁移。
同一次启动里，系统行上指向「已加载的包不再提供」的具名成员由 `pruneDeadMembers` 清掉，指向被
`retires` 的目录路由的系统行成员同样清掉（精确规则见 `src/providers/seed.ts` 头注）。安装确认页据 preview 的 `providers` 字段亮出这些行，并说明它们**重启后端
后才出现**。

`callsites` 的语义：这一行是这些调用点的**默认成员**。调用点的默认行列表 = 宿主自己的默认 ∪ 所有
声明了该调用点的包行（`ensureDefaults` 跳过默认为空的调用点）；`/api/providers` 上这一行的「调用位置」
注记也由调用点的 `label` 反查生成（`src/providers/seed.ts` 的 `callSitesOf`）——宿主自己那些行仍是手写
一张表，包行不必进那张表。**所有 dispatch 调用点都读包行 `callsites`**（`src/providers/callsites.ts` 里
`mode: 'dispatch'` 的那些，判据由 `src/providers/identities.ts` 现取，不手抄名单）：`music.track.resolve` /
`music.track.download` / `video.resolve` / `content.enrich`，以及网盘四个 `netdisk.share.verify` /
`netdisk.share.save` / `netdisk.play` / `netdisk.folder`（夸克、百度的包行就是这么进去的）：

- `video.resolve` 按平台派发，键是 `<平台>-video`；`GET /api/media/play|dash` 与转写 / 抽帧取字节都从这里走。
- `content.enrich` 按 `<平台>-link` 派发（平台来自认领函数，见本节末「`links`」；`stream_fetch_url` /
  `GET /api/media/from-url`），默认成员 = 宿主的兜底行 `fetch-url` ∪ 声明了 `callsites: ['content.enrich']`
  的包行。**一条 `serveKeys` 是 `<平台>-link` 的 transform 行，不写这一格就永远不可达**——没有别的调用点会问它；
  **包也得在 `links.hosts` 里认领那些主机**，否则认领函数认不出平台，键拼不出来。

这两个调用点给成员的输入是**普通对象**（`{vid, format}` / `{url}`），包的源收到的是空键 + 对象整个
展开进 `params`（`memberCallArgs`，`src/providers/invoke-types.ts`）——所以包的 adapter / recipe 从
`params.vid`、`params.url` 读，不从位置参数读。

`rsshubNamespaces`：两个包认领同一个命名空间 → 装载期抛（那是两份互相看不见的渲染规则争同一批路由，
先到先得会随磁盘顺序漂）。宿主自己那张 `NS_NORMALIZER` 今天是空的（机制保留）。

上面这张表是**描述符字段**。还有一类站点知识不走描述符、走代码槽位（§3）：normalizer 在每条
`Content` 上写 `enrich: { source, params }`，宿主把包交出的 enricher 同时露在 `GET /api/enrich` 与 WS 命令
`enrich.open` 两个面上（同 source 一次一条在飞、新点顶旧、同 params 搭车；协议见 `docs/API.md`）——
「这条打开时去哪现取剩下的」于是也由包说，宿主里没有任何一站的详情分支。

范例：`packages/netease/package.json`（`providers` / `links`（曲目 pattern）/ `rsshubNamespaces` 三样齐全）、
`packages/btbtla/package.json`（`links` 的 `download-page`）、
`packages/xhs/package.json`（`rsshubNoBrowserNamespaces` / `item.actions`）、
`packages/lizhi/package.json`（`serving` / `retires`）、`packages/bilibili/package.json`
（`rsshubCookieEnv` / `retires` / `links`（含短链）/ 两条 `providers`（`video.resolve` 与 `content.enrich` 各一）/
`code.enrichers` / `code.connect` / `item.authorEnrich` 齐全）、`packages/Douyin_TikTok_Download_API/package.json`（**一个容器包服务
两家平台**：四条 `providers`——每家一条 `resolve`（`<平台>-video`）+ 一条 `transform`（`<平台>-link`，`links.hosts` 显式写 platform），成员全骑
同一个 adapter 打容器，地址经 `ctx.backendUrl` 现取；完整拆解见 §10.1）。

### `links`：「哪些链接归我、是什么东西」

用户贴一条链接、说「下载它的视频 / 播放 / 读正文」，系统先回答**认领**（这条链接是哪个包、哪个平台、什么类型、
id 多少），再回答**派发**（交给哪条 Provider 行）。认领只有一张表——各包的 `stream.links`；宿主只有一个认领函数
`recognizeLink(url)`（`src/links/recognize.ts`），不认识任何站。

```json
"links": {
  "hosts": ["example.com", "exm.pl", { "host": "other-site.com", "platform": "other" }],
  "shortHosts": ["exm.pl"],
  "patterns": [
    { "kind": "track", "pattern": "^https://music\\.example\\.com/song\\?id=(?<id>\\d+)" },
    { "kind": "download-page", "pattern": "^https://(www\\.)?example\\.com/down/\\d+\\.html$", "yields": "magnet" }
  ]
}
```

- **`hosts`**：这些主机（含子域，按 label 边界后缀匹配——`evil-example.com` 不算 `example.com`）归本包。字符串或
  `{ host, platform }`。
- **`shortHosts`**：本包的短链主机，每个都必须被 `hosts` 覆盖。`recognizeLink` 只对它们发请求展开
  （`redirect:'manual'`、最多 3 跳、每跳 5 秒；下一跳主机没人认领就停，按停下前的地址认；展开失败按原链接认，
  原因进 DebugBox `links` 频道）——只打包声明过的公网主机，所以不是开放代理。
- **`patterns`**：路径级的类型认领，`kind` 是宿主的封闭词表，今天两个值：
  - `track`：必须有命名组 `id`。曲目识别（贴 URL 意图识别、音乐搜索结果）吃它，结果是 `platform:id`。
  - `download-page`：必须以 `$` 结尾、带 `yields`（`magnet|ed2k|quark|baidu|aliyun|unknown`）。解析器据此给行打
    `needsResolve`，下载解析据此放行抓取——**它兼作 SSRF 白名单**，`magnet` 有通用解法（抓页面取第一条 `magnet:`）。
  - 加新类型 = 宿主词表加一个值，且要有第一个消费方同时落地；不预留没人用的类型。
- 认领顺序：先 `patterns`（声明序，先声明先赢）给出 kind / id；没命中再按 `hosts` 只给 platform（最长后缀胜）。

**平台归属**：`platform` 缺省 = 包的 `stream.facility`；没有 facility 时每条都必须显式写（一包两平台的
`Douyin_TikTok_Download_API` 就是这样写的）。平台键只收 `[A-Za-z0-9][A-Za-z0-9_-]*`——它要拼进派发键。
**一个主机、一个平台只归一个包**：装载时按声明序并表（`src/replay/recipe-package.ts` 的 `linkTableOf`），撞了就
拒掉后到那个包的**整份** `links`，落日志并发 `recipe-reload` 频道（同 `serveKeys` 撞键：后到的拒）。同一个包的
内置层与用户层只剩一份（「同名两层只装高版本」），不算撞；嵌套主机分属两个包（`example.com` / `m.example.com`）
也不算撞，认领时最长后缀胜。

**装载期校验**（命中任一整个包拒装；`src/packages/links.ts` 的 `linkPatternProblem` 与 `normalizeLinks`）：

- pattern 以 `^https://` 或 `^https?://` 开头；能编译、不匹配空串；源串不超 200 字符、不含嵌套量词（`(a+)+`），
  拿病理串实跑两次、最好的一次不超 50ms；不许命中任何一条别人家的控制 URL（`https://example.com/` 这类）。
- pattern 主机段（协议之后、第一个 `/` 之前）至少指名一个字面域名（转义的 `\.` + 字母），**每个都落在本包的
  `hosts` 里**——包不能靠 pattern 认领别家的链接；主机段不许有能越过主机边界的通配（裸 `.`、`[^…]`、`\S`）。
- `hosts` / `shortHosts`：至少两段标签、不是公共后缀，且过 `servingHostProblem`（只收公网主机）。

**派发键约定：`<platform>-<名词>`，由认领结果拼，任何声明里都不写域名形状的键**（内置包由
`src/packages/legacy-link-fields.guard.test.ts` 守着）：

| 调用点 | 键 |
|---|---|
| `content.enrich`（贴链接抓媒体） | `<platform>-link` |
| `video.resolve` | `<platform>-video` |
| `music.track.resolve` / `music.track.download` | 平台键 |
| `netdisk.*` | `<网盘>-verify` 等 |

**`trackUrl` / `downloadPages` 是迁移期别名**：已经发到 npm 的旧版包里还有，装载时翻译成 `links.patterns`
（`trackUrl` 补 `^https?://(?:[a-z0-9-]+\.)*` 前缀、首个捕获组改名 `(?<id>…)`；`downloadPages` 的 `kind` 变
`yields`；`hosts` 从字面域名推出来，`platform` = 包的 facility），翻译后照样过上面的校验。`content.enrich`
在 `<platform>-link` 派发不到时再按老的主机键（完整主机、apex）试一次，命中照用并在 DebugBox `links` 频道留痕。
新包一律写 `links`。

`GET /api/links/recognize?url=` 回认领结果（`docs/API.md`）。设计与取舍见 spec
`internal design record`。


---

## 1. 槽位：Source 清单（`manifests.yaml`）

包贡献的每个 Source 是清单里的一项（顶层 YAML 列表）。一项 = 一个调用模式，字段语义见 `src/manifest/types.ts`；写法范例见 §10。

> 关键事实：source manifest 的 `auth: { type: 'cookie', domain }` **已经是**凭证声明（不要再发明 `needs_credential`）。plugin descriptor 的 `credentials: [domain, ...]` 声明的是该插件的**后端容器**通过 broker 需要的 cookie 域（§5）。

### 1.1 sourceId：你写局部名，宿主合成全名

一个 Source 的 id 是 **`<npm 包名>/<局部名>`**，叫它**全名**。

```
@streamapp/xhs/xhs-detail          scoped 包，全名里有两个 "/"
@streamapp/builtin/fetch-url
my-recipes/fetch-url               无 scope 包
local/<目录名>/<局部名>              手放进 <dataDir>/recipes/ 的本地包（package.json 没有 name）
```

**包作者写的永远是局部名**——`manifests.yaml` 的 `id`、recipe 的 `sourceId`，都不写自己的包名。
前缀是**宿主在装载期合成的**（`src/registry/source-id.ts` + `toPluginDescriptor` /
`loadRecipePackages`），与 `pluginId` 同构：派生字段进 Registry 之前写死，读取端零推导。
理由很实际：包名写进每一个 recipe 文件，改包名就得改一遍；而本地开发时包名往往还没定。

**全局唯一性由 npm registry 保证**，宿主不维护任何名字表。两个包的全名相同 ⇒ npm 名相同 ⇒
它们本来就是同一个包。

局部名有两条硬约束，装载期就拒（`validateRecipe` 与 `scanPackages` 两侧各一道——两条装载路径
独立，只钉一道会从另一侧漏过去）：

- **不得含 `/`**：它是包名与局部名的分隔符。含了就多出一族二义（包 `<p>` 的局部名 `a/b`
  和包 `<p>/a` 的局部名 `b` 长得一模一样）。
- **不得含 `:`**：`:` 被存量 stream 行的 plugin 前缀占着（下面第 2 级），含了会让剥离规则在
  全名上误触发。

#### 怎么解析一个 id（`Registry.get` 的四级规则）

| 级 | 规则 | 存在理由 |
|---|---|---|
| 1 | 精确命中 | 全名，以及 RSSHub catalog 的 `rsshub:…` |
| 2 | 含 `:` → 剥掉首个 `:` 之前的段，回到第 1 级 | 库里的 stream 行按 `plugin_id` + `source_template_id` 两列存，`canonicalSourceId` 把它们拼回 `xhs:<id>` |
| 3 | 裸名（局部名）→ 唯一命中则解析 | 库里的行、别人分享来的旧 bundle、用户手打的 id 都是裸名 |
| 4 | 裸名命中多条 → **内置层那条胜出**（记一条歧义记录到 `recipe-reload` 频道）；内置层里有 ≥2 条、或候选全在第三方层 → 抛 `AmbiguousSourceIdError`，消息里列出全部候选全名 | 见下 |

第 3、4 级作用在第 2 级剥离**之后**的那个串上，顺序不能反。

**裸名解析是永久能力，不是过渡。** 它服务的是用户数据（库里的行、旧 bundle、手打的 id），
这些东西永远存在。它也不是"旧路"，是"短名"——和 shell 在 `PATH` 里按裸名找可执行文件同构。

**歧义为什么内置优先**：一条写着裸名的存量记录，写下的那一刻只可能指内置那条——第三方包是
后来装的。让后来者改变一条旧记录的含义，是这条线上最贵的那种静默失真。分不出胜者时**抛**
而不是返回 `undefined`：「这个源不存在」和「它存在两份」的处置完全不同（前者是配置错，后者
要用户改写全名），压成同一个 `undefined` 就是把一个能说清楚的错变成一个说不清的错。

**但宿主自己的代码不吃裸名。** 源码里、`SYSTEM_IDENTITIES` 的 `defaultMembers` 里、
`VIDEO_RANKING_STREAMS`（影视频道默认榜单种子）里的具名 source 一律写全名——第三方装一个同名包就能把宿主自己的调用推进
歧义分支。这条由 `src/providers/system/index.real.test.ts` 的「every named default member points
at a real source」钉着。RSSHub catalog id（`rsshub:…`）不属于任何包命名空间，不加前缀、也不进
按局部名建的那张索引。

### `uses`：这个源要靠别的源才完整

一个 Source 的产出如果**依赖另一个 Source**，在 `uses` 里申报（`manifests.yaml` 的 `uses`，
recipe 写 `meta.uses`）。它回答的是反过来那个问题：**一份 recipe 坏了会连累谁**。

```json
"meta": { "uses": ["xhs-detail"] }
```

**同包内写局部名，宿主在装载期合成全名**（和 `sourceId` 同一条规矩，见 §1.1）。要指别的包里的源
就写全名——局部名不许含 `/`，所以「含 `/` = 全名」是个精确判据，不是猜。

**方向是「用的人申报」。** 被共用的那份 recipe **不**登记自己的用户：那样每来一个新消费方就得
回去改它，漏了不报错、只是安静地少算一个。申报写在消费方自己的文件里，加一个消费方只碰它自己
那一个文件。

**它不影响调度**——宿主不会因为一格 `uses` 就去替你跑那个源。这是一份供诊断读的声明，
消费面是 `GET /api/sources/affected?id=…`（[API.md](API.md)），以及漂移记账那一刻写进
修复账本的 `affectedSources`（`src/replay/repair-ledger.ts`）。

**活体那一条**：`xhs-home` / `xhs-search` 都 `uses: ["xhs-detail"]`——打开一条笔记要的正文、
图集、评论是共用的 detail recipe 现取的。detail 漂了，这两个源**采集照常成功、健康状态一路是
绿的**，只是每一条笔记都点不开；不申报，就没有任何一处会把它们算进受影响的源。

### Runtime Source Configuration

Use `runtime_config` when a Source requires deployment-private credentials or stable facility
values. Do not put API keys, endpoints, or tokens in `params_schema`, `fixed_params`, Provider
member params, or a plugin container environment. `params_schema` describes one invocation;
`runtime_config` is resolved privately at execution time.

```yaml
runtime_config:
  ref: tmdb                 # shared by every Source using this facility config
  fields:
    apiKey:
      type: secret
      label: TMDb API Key
      required: true
      description: 简短说明，显示在 Source Config Sheet 字段下方。
      helpUrl: https://provider.example.com/api-keys
    language: { type: string, label: 语言, default: zh-CN }
```

`secret` values are write-only and their HTTP status exposes only whether they are configured.
`string` values are returned to the Source Config Sheet. A Source may share a `ref` only when its
fields describe exactly the same facility configuration.

**端点例外**：只有真正私密、不因调用而变的值才落 `runtime_config`。可自托管、有公开默认值的
端点（大多数人不需要碰）走 `params_schema`（`baseUrl`，`required: false`，description 写明
默认值），只把密钥本身留给 `runtime_config`——`ocr-vlm`、`article-firecrawl`（住 `packages/firecrawl/`）都是这个形状：
`baseUrl` 在 `params_schema`，`apiKey` 在 `runtime_config`。

**可选密钥（keyless）**：一些设施提供匿名免费额度，`runtime_config.fields.apiKey` 可以声明
`required: false` 放行不填。但 keyless 额度通常按**出口 IP** 记账、与同一出口的其他调用方
共享，被别人先吃掉时只表现为一个 429，从调用方这边完全无从排查——`article-firecrawl`
（Firecrawl keyless 免费档 1000 credits/月）就是这个坑。声明 `required: false` 的字段，
`description` 必须点破这个坑并给出退路（注册一个免费账号填 key，额度相同但记在自己账上、
可预期）。

### 1.2 歌词源的 key 文法

`categories` 含 `lyrics` 的源，`lyrics-search` 那行按类目现取它们（成员 `{mode:'auto', category:'lyrics'}`），
订阅键由 `buildParams` 灌进 `key_param` 指定的那个参数。key 是 `<platform>:<id>`（已知曲目引用，
`platform` = 某个包的 facility）或 `<title>::<artist>`（模糊）。

**收到别家平台前缀要返回 `[]`（decline）**，把机会让给梯子的下一档；不要返回 `{matched:false}`
——那是"我查过了，没有"，会把别家的歌钉死成查无此歌。缓存归调用方（`GET /api/resolutions` 与 MCP 的
`resolve` 共用 `src/audio/lyrics-cache.ts`），源里不要自己缓存。范例 `packages/netease/lyrics.ts`。

---

## 2. 槽位：recipe 数据（`*.recipe.json`）

Recipe 是 Stream 对浏览器采集行为的正式称呼：一份**可录制、可校验、可回放、可修复**的
版本化数据契约。它描述如何使用一个带登录态的浏览器 session 完成动作、观察页面产生的
数据、映射为 item，并判断登录失效或站点漂移。

- 从零编写一份 recipe 的作者流程见 `.claude/skills/write-recipe/references/authoring.md`。
- **拟人采集管线（用户自己的 Chrome + facility 单会话 + 拦截 XHR）怎么跑、怎么观察、怎么修：
  `.claude/skills/write-recipe/SKILL.md` 是唯一真相源。** 本节只定义概念与契约，
  不重复运行经验；两边冲突时以 skill 为准。
- 本节是 Recipe 的权威概念、语义与验证术语；代码锚点在 `src/replay/`。

### 2.1 Recipe 不是什么

- Recipe **不是 Source**。Source 是用户可理解的入口；Recipe 是该入口的执行契约。
- Recipe **不是新的 Workflow 业务层**。动作编排是 Recipe 内部结构，不另立顶层概念。
- DOM、XHR、page state、eval **不是不同 Source**。它们是执行期间读取结果的手段。
- persistent shadow session **不是 Stream**。它只是 Provider 调用复用的浏览器执行资源。
- Recipe 是数据，不是任意站点代码容器。通用能力进入 schema/runner；站点 selector、URL
  pattern 和 mapping 留在 recipe。
- Recipe **不是独立的分发单位**。分发单位只有一种：**Stream 包**。recipe 数据是包的一个
  **槽位**（`*.recipe.json` + `stream.facility`），与 Source 清单 / 代码 / docker 容器 /
  凭证域这几格并列——同一个包可以同时填 recipe 槽位和容器槽位。

例如小红书按语义保留这几个入口（下表写的是**局部名**，也就是 recipe 文件里的 `sourceId`；
它们在 registry 里的全名是 `@streamapp/xhs/<局部名>`，见 §1.1）：

| 局部名 | 角色 | 数据落点 |
|---|---|---|
| `xhs-home` | 首页推荐时间线 Source（可订阅） | 入库 |
| `xhs-search` | Search Source / Provider | 临时返回，不入库 |
| `xhs-detail` | Home/Search 共用的私有 detail recipe；`discoverable:false` 的内部 Source，由本包的 `xhs-detail` enricher 经 `ctx.readSource` 调（§3.2） | enrich 临时结果，不入库 |
| `xhs-like` | 互动写入（点赞/收藏），on-demand、从不被调度；前端经 `POST /api/recipes/action` 触发 | 不产 item |

不得再按实现路径派生 `xhs-home-xhr`、`xhs-home-dom`、`xhs-home-click` 等 Source。

### 2.2 Recipe 的正交组成

Browser Recipe 目标结构由五部分组成：

```ts
interface BrowserRecipe {
  version: number
  kind: 'browser'
  sourceId: string
  session: {
    facility: string
    lifecycle: 'one-shot' | 'persistent'
    visibility: 'unattended' | 'interactive'
  }
  loginCheck: LoginCheck
  steps: RecipeStep[]
  observers: RecipeObserver[]
  output: RecipeOutput
  ledger?: { idField: string }
  policy?: RecipePolicy
  extract?: RecipeExtract
}
```

#### Session

- `one-shot`：一次执行获得 tab，完成后释放，适合普通 fetch/browser recipe。
- `persistent`：facility-scoped session，由 session manager 长期持有；Search/Detail 可复用。
- `unattended`：采集。后台标签，用户不必在场，**永远不抢屏幕**。所有 Source 都是这一档。
- `interactive`：用户得亲自动手的流程（登录、扫码、自助建 key）。开在他当前窗口里可见，因为他要在上面点。
- **没有 `transport` 字段可选**：浏览器只有一个（用户自己的 Chrome）。老 recipe 写 `'ext-cdp'`
  照收但无效，写 `'cloak'` **装载即拒**并指出迁移动作（`src/replay/recipe-store.ts`）。

判据是**谁动手**，不是谁想看。写 recipe 时只需要问一句：这次运行要用户伸手吗？要 → `interactive`，
不要 → `unattended`。开发期想看着它跑**不是**改这个字段的理由（那是一次运行的临时需求，写进随 git
走的文件里就得记着改回去）——用 `RECIPE_PROBE` 的分阶段账本和 `data/failures` 的失败现场。

**看得见 ≠ 抢焦点。** 采集标签一直在标签栏里，用户随时能自己切过去；`interactive` 只决定标签开在
前台还是后台，runner 一层不碰焦点。把窗口提到最前只发生在用户**显式要求**时（点「在浏览器里完成
登录」→ `RecipeSessionManager.focusFacilityTab`）。

后台档为什么点得动：lane 建好就发一条 `Emulation.setFocusEmulationEnabled`，隐藏标签的可信输入
因此照常落地；配上"鼠标事件不等 Chrome 回执"（`extension/src/lib/driver.ts` 的 `FIRE_AND_FORGET`），
一次可信点击 0.19–0.33s。
所以**"要可信点击"从来不是要前台的理由**。**要合成器真产出一帧的命令（截图 / `settle`）不吃这条
红利**——那由 OS 那层"Chrome 窗口显不显示在屏幕上"说了算，见 `write-recipe` skill 的
`references/session-runtime.md`。

四档对照数字、病理，以及"它对页面撒了什么谎"，见 `.claude/skills/write-recipe/references/session-runtime.md`
的 `visibility` 一节（运行经验的真相源在 skill，本节只定概念契约）。

#### Ledger（这份 recipe 的产出同时是一本有序账本）

`ledger: { idField }` 声明"这次运行在这条 lane 的页面上铺开了哪些条目、按什么顺序"。它是下游
`locate` step 的**坐标系**：detail 要在 feed 上找到目标卡片、滚进视口、可信点击，靠的就是这本账本。
调用方没传 `params[orderedParam]` 时，**运行时按这份 recipe 的 facility 从 `FeedLedger` 填**
（`SessionRecipeExecutor` 的 `orderedFor` → `RecipeRunner`）——「在 feed 上找卡片」当然要 feed 的
顺序，那是 locate 步的运行契约，不是某个调用方的事；显式传了（哪怕是 `[]`）就用传的。

- **谁是来源谁声明。** 引擎不认 sourceId，只按声明记账——"哪个字段是身份"是站点知识，属于 recipe
  这份数据。`idField` 必须和消费方 `locate` 的 `identityParam` 是同一个字段。
- **整本替换，不是追加。** 一次运行 = 那个标签被换成了这一批。
- **lane 关掉，账本一起丢。** 它描述的是那个标签；标签没了账本就是废纸。
- 没有账本不是故障：`locate` 立刻 MISS，走 `fallbackUrl` 整页导航，数据照出（降级）。

Recipe runner 不创建或销毁 tab；它向 session manager acquire/release session handle。扩展只
操作自己创建并登记的 owned tab，绝不 attach/关闭用户手动 tab。

#### Steps

Steps 表达站点可观察到的用户行为，例如导航、输入、提交、滚动、点击目标卡片、返回。
生产回放使用 CDP trusted input。Humanization 是任务动作的 pacing/trajectory policy，不是
随机制造与用户意图无关的点击。

`click` 是"按下这个具名元素"（与 `openItems`「打开信息流第 N 条」是两件事）。它可带
`position: {x, y}`——相对元素 rect 左上角的 CSS px 偏移，省略即中心；字段名与语义取自
Playwright 的 `locator.click({ position })`。存在的理由是**中心对某些目标就是错的点**，
而不是可调优的旋钮。

`setFiles` 是"把浏览器所在机器上的本地文件放进页面的 `<input type=file>`"（CDP
`DOM.setFileInputFiles`）：`{ kind:'setFiles', selector, paths }`，`paths` 是按换行拼的绝对路径，
通常写 `{files}`——一个 `format:'path', multiple:true` 的参数翻译后的形状（WSL 路径宿主已翻成
Windows 侧认的）。**大文件不该走控制通道**：`evaluate` 会把整个参数袋序列化进一条求值表达式，
几十 MB 的图编成 data URL 塞 params 就是一条几十 MB 的 CDP 消息，还挤在页内求值 30s 预算里；
这一步让**浏览器进程直接读盘**，页面拿到的 `File` 和用户在文件对话框里选中的一样。`paths` 为空
（参数缺席）就跳过并记进 trace；元素不在 / 不是文件输入框 / CDP 拒绝都抛。范例：
`packages/photopea/photopea-run.recipe.json`（宿主页上先由一步 `evaluate` 建好 input）。

每个 step 还可以带两道闸门，它们回答的是**两个不同的问题**：

- **`settle`（动作之前）——"现在能动手了吗"**。等目标那块区域**画完并停住**再执行。判据是
  「变过了 + 停住了」，逐帧比较该元素 rect 裁出的画面。它存在，是因为有些目标**就绪与否从 DOM
  里根本观察不到**（活在 closed shadow root 里的挑战控件），而**过早动手是有害的，不只是无效**。
  截哪里由 DOM 的 rect 给：**DOM 说在哪，画面说什么时候。**
  **每一类步骤都收它**（`locate` / `openTarget` / `evaluate` 也在内）；不声明就是零代价的空操作。
  `evaluate` 不操作页面、只调站点自己的 JS，通常没必要声明。
- **`expect`（动作之后）——"我做的这件事生效了吗"**。`{ selector, state: 'present'|'gone',
  timeout, retryEvery }`，语义取自 Playwright 的 `waitFor({ state, timeout })`。不满足就**在这一步
  断掉**：因果链断在这里，后面的步骤只会以无关的症状失败。状态叫 `present` 而不是 `visible`，
  因为判据是元素挂没挂上 DOM、不是 CSS 可见性——名字得说实话。

**等待属于 `expect`，不属于动作自己的 timeout。** 一个步骤等的从来不是"我这次点击要多久"，
而是"它引发的事什么时候发生"。

**`expect` 在 `locate` / `openTarget` 上的位置。** 这两类步骤自带**内建确认**（打开后看 URL 带不带
identity；不成就回落 `fallbackUrl`），它回答的是「**打开了没**」。`expect` 是使用者自己写的额外判据，
回答「**打开的是不是我要的那个 / 页面到位了没**」——所以它跑在**内建确认之后、observers 读之前**。
在 observers 之前是硬要求：observer 一旦从一个错的页面上把数据读走，拿到的是真数据、只是来自别处，
这是最难查的一类错。走 `fallback-nav` 回落的那条路**同样要过这道闸门**：`expect` 判的是最终状态，
不是走哪条路到的。

**这两类步骤不支持 `expect.retryEvery`，装载时就报错**（不是静默忽略）。`retryEvery` 的语义是"每隔
这么久把**动作**重做一遍"，而它们各自已经有自己的重试：`locate` 失败会回落 `fallbackUrl`（重做一次
locate = 重新滚动定位 + 一次拟人点击，humanize 是这条路径的耗时大头），`openTarget` 自带 `maxScrolls`
重试循环。再叠一层重做是重复且昂贵的；要放宽只调 `expect.timeout`。

一次运行失败时会留下**现场**（停在哪个 URL、页面可见文本、视口截图、失败那一步自己的观测）：
一次性会话失败即销毁，现场只有这一次机会。

#### Observers

Observers 在 steps 执行期间按限定窗口读取结果，可组合而非互斥：

- `network`：订阅匹配的 CDP Network response，按 requestId 读取 body。
- `state`：读取页面已产生的结构化 state（如 `__INITIAL_STATE__`）。
- `dom`：读取当前渲染结果，通常作为定位、校验或 fallback。

Observer 只读已经由页面流程产生的内容。主动调用站点内部 webpack request client 不等同于
"观察 XHR"，不得作为模拟用户浏览的默认路径；若保留，只能是显式、受限的兼容 step。

CDP event body 只在匹配 observer 的有限窗口读取，避免无限日志和敏感数据扩散。

#### Output

Output 负责去重、assert、mapping 和 normalizer 前的原始 item 形状。多个 observer 的结果由
backend observer pipeline 合并；extension 不解释 Recipe、不做字段映射。

- **`timestampFrom: 'harvest-order'`**（可选）：条目时间戳不取 mapping 里的 `pubDate`，改成
  「本轮采集时刻 − 序号秒」，即**按采到的先后排**。给「我的收藏」这类清单用：上游只给内容的
  发布时间、不给「我什么时候收藏的」，而页面顺序就是收藏顺序。不开的后果是昨天收藏的一条
  老视频按发布时间沉到底，收藏页前 30 条里看得见、Stream 里翻不到，长得像「采集漏了」。
  盖章只在 `stampHarvestOrder`（`src/adapters/replay/adapter.ts`）一处，observer 首批与
  evaluate 翻页批合并之后一起盖——别在 recipe 的 mapping 里自己算，network observer 的
  mapping 是声明式 dot-path，算不了。
- **`files`**（可选，只对**动作 recipe** 生效）：哪些 mapping 字段是**文件**——页内以 base64 交出来的
  二进制。宿主把它写进 `<dataDir>/action-artifacts/`（7 天回收），回执里那一格换成绝对路径。
  键是 mapping 字段名，值给 `ext`（写死扩展名）或 `extFrom`（同一条 item 里装格式的字段，
  `jpg:0.8` 取冒号前）；两者都不是 mapping 字段就装载期报错。**文件类产物没有第二条路**：回执会
  原样落进 run 账本（`agent-runs.db`），而账本拒收超过 1MB 的结果（`RESULT_MAX_BYTES`）——一张
  导出图几十 MB，编成文本塞进账本的下场是账本撑到 GB、开机 OOM。范例：`packages/photopea/`。
- **`track_id`**（mapping 保留字段，音频源用）：这条 item 在源站的稳定音轨 id 的**字段路径**。
  normalizer 用它 + 所属包的 `facility` 组出 `(platform, track_id)`——归档 / 网盘对齐 / 播放解析的键。
  `platform` **不许在 mapping 里写**，恒等于包的 facility：一个包不能把音轨挂进别家的 id 空间。
  有 `track_id` 没 `enclosure_url` = 付费/独家集（`resolveOnly`，只有网盘里有才可播）。

#### Extract（一次性抽取：Recipe 唯一的写效应）

`extract` 是 Recipe 契约里**唯一会改变 Stream 自身状态**的东西：把页面上只显示一次的明文
（刚建好的 API key）落进这个 Source 自己的 `runtime_config` secret 槽。除它以外，Recipe 全部
是"操作站点 + 读回 item"，不写本地。

因为写的是凭据存储，边界写在契约里，不留给实现自觉：

- **`extract` 里没有 ref。** 目标由执行侧从这份 Recipe **自己 manifest** 的
  `runtime_config.ref` 绑定，所以 Recipe 在运行期无法指名去写别人的配置。
- **字段必须在同一份 `runtime_config` 里声明为 `type:'secret'`**，否则拒写；这条在**装载点**
  就拒（一份共享 Recipe 被审查的时刻），不是运行时静默失效。
- **恰好命中一处才写**。0 处或多处都拒——多个候选挑哪个都是猜，而猜错的凭据只会在很远的
  下游变成一句"key 无效"。
- **只写不读**：没有把 `runtime_config` secret 送回页面的路径。
- 值不进 trace / outcome / 日志；`outcome.extract` 只报字段名与长度。

一个 `extract` Recipe 可以完全不产 item（`observers: []` + `allowEmpty`），它的产出就是那把 key。

**声明了它就等于报名当这一格的自助申请入口。** 宿主按具名判据 `provisionedConfigSlot`
（`src/replay/recipe-provisioner.ts`）反查「ref → 谁能产出它」，配置卡上那颗「一键帮我完成」
按钮就是这份索引的投影（机制见 `docs/ARCHITECTURE.md`「自助申请」）。两条要知道的边界：
**只有内置包**进这份索引（第三方包声明同一个 ref 不会让内置那张卡长出按钮）；同一个 ref 有多条
候选时按 Source 全名排序取第一条——今天 `firecrawl` 就有两条（`-create-key` / `-read-key`），
入口给的是排在前面那条。

**明文从哪里取——两档，由 `extract.from` 定：**

- 缺省 = **页面可见文本**（含表单控件的 `value`：只显示一次的凭据几乎总放在只读输入框里配一个
  复制按钮）。
- `from: { network: '<url glob>' }` = **响应正文**。给有些平台准备的：明文**从不进 DOM**。
  智谱建完 key，列表里永远是掩码，明文只在点复制时由 `/api_keys/copy/<id>` 单独返回、直接进
  剪贴板——页面文本这条路对它是死的。

  这一档的捕获由**引擎自己挂**（只捕获、不累积）。**Recipe 不要为此声明 network observer**：
  凭证不是 item，声明成 observer 就会进 items 管线，它抓到的那份响应会被空 `output` 判成
  malformed → **drift**，而 drift 优先级高于 `allowEmpty`，于是抽取本身的结论被盖住、看不见。

#### Policy

Policy 描述速率、停留、滚动距离、重试和任务预算。其目标是让动作序列与真实任务一致并避免
过快请求，不是生成表面随机噪声。风控、登录墙或无法克服的后台节流出现时必须停止并通知用户。

### 2.3 Probe 原型（`kind:'http'` 的探针形态）

Feed 之外的第二种 recipe 原型：**问一个目标一个问题，交回一个判决对象**（网盘验活是范例：
`packages/quark/quark-share.recipe.json`、`packages/baidu/baidu-share.recipe.json`）。契约与
feed 的差异全部显式声明：

- **`output: 'object'`**：`decode` 的返回值就是成员结果，不过 pagination/mapping（装载校验
  拒绝混写）；`null` = 主动弃权。判决以对象身份进 Provider 成员契约（`manifest.output`
  投影 + 执行器缝上解包），不穿 item 的衣服。
- **`acceptNonOk: true`**：探针的判决常长在上游错误响应体里（quark 403/404 的 code 就是
  死因），非 2xx 交给 decode 而不是抛错。feed 绝不该开这个——500 读成「今天没新闻」会把
  一条流的 items 清空。
- **探针语义三分（不变式）**：「目标死了」（not-usable）、「看不进去」（unknown）、
  「网络/风控坏了」（抛错 → 上层归 unknown）永不合并。把「提取码被拒」报成死链，会让一条
  活链在默认隐藏下静悄悄消失。
- **`jar: true`**（可选）：记住上游 `Set-Cookie` 供本次执行的后续请求携带。三条铁规归引擎
  强制：按域名分桶永不跨站；只活一次执行、不落盘不回写 broker；与 broker 凭据分账（发送时
  按 cookie 名去重、jar 值胜）。配套：`compute.params`（请求前派生参数）、prefetch
  `parse: 'json'|'text'|'none'`、`request.redirect: 'manual'`。

写能力（转存、删除、点赞/收藏）**也可以是 recipe**：recipe 可写用户账户，不做信任分级/出身审定。
分享/加载第三方 recipe 只做统一免责声明（①安全性不做保障 ②第三方内容需用户自行确认是否可信）。
画线全貌见 `internal design record` §2。

写操作的 recipe 在 `meta` 里自报 `effects: ['write']`（缺省 = 只读），npm 包安装 preview 展示的
capabilities/effects 就是读这个自报字段——**宿主不做交叉验证**，一个会点赞/收藏/转存的 recipe
只要不如实标 `effects: ['write']`，确认页就会显示"无副作用"。这条契约只对诚实包成立；发布/安装
流程（检查清单、preview/install API）见 `.claude/skills/share-recipes/SKILL.md`。

### 2.4 桌面 recipe（`kind:'desktop'`）

驱动**原生桌面应用**（非浏览器、非 HTTP）的 recipe，走 `a11y` 感知词汇（role/name/native-class +
native invoke）而不是 CSS selector。**独立的 `DesktopDriver` 接口 + desktop runner**（`src/replay/
desktop-*.ts`），与浏览器 `PageDriver`/`Transport` 并列、互不侵入（沿 http/html 先例）。运行时是宿主
上的 `host-desktop` Engine（`app/host-agent/` Rust sidecar：Windows UIA 读 + enigo 动），后端经
`/api/host` WS relay 驱动它（镜像 ext-cdp 的进程边界）。这个 sidecar 的生命周期由 Stream 后端自己在进程内持有
（`src/host-agent/mount.ts` 把 `capabilities/desktop/`（**Stream Desktop**）当成一件**内置能力**交给
`src/capabilities/host.ts` 挂上，§5.9），二进制按平台走 npm 子包
（`@streamapp/desktop-<os>-<cpu>`）——**桌面控制不需要装桌面壳**。首个 recipe `telegram-search`（`packages/
telegram/`）：驱动 Telegram 桌面客户端搜索、读结果为资源 item，纯读。概念与两轴模型（Engine /
Perception Vocabulary）见 `docs/ENGINE.md`；完整设计与活体验证见 `internal design records/specs/
2026-07-19-desktop-uia-engine-telegram-design.md`。

> 写/调这类 recipe 时的运行经验（复位、同 role 多组列表、drift 隔离怎么解除）见
> `.claude/skills/write-recipe/references/surface-desktop.md`。

#### 动作型：只做事、不读东西

一条桌面 recipe 不一定产 item（"给某联系人发一条消息"、"把这个目录装成扩展"）。这一档
**`allowEmpty: true`，并且把 `observer` / `read` 整个省掉**——别为了过"一条都没读到就判 drift"
那道闸去伪造一个恒真的 observer：伪造的比缺失更坏，它读什么、读到没读到都不再有人看，却长得
像一份真的验证。

动作型 recipe 要 `meta.action: true` 显式 opt-in，然后有三个入口，**同一条后端路**
（`src/mcp/action-recipe.ts`：两步确认、按 `params_schema` 校验、凭据注入、限速），别各接各的：

| 入口 | 谁用 | 确认怎么给 |
|---|---|---|
| MCP `run_action_recipe` | 对话宿主里的 agent | 先不带 `confirmed` 拿回执，用户点头后带 `confirmed:true` |
| `POST /api/recipes/action` | 脚本 / 界面 | 同上，`confirmed` 字段 |
| `stream recipe run <id> [--param k=v]… [--yes]` | 命令行、**调度中心的命令执行体** | `--yes`；不带它只打印会做什么、退出码 2 |

要让一条动作 recipe **定时、无人值守、不经模型**跑，就是第三行：任务的命令填 `stream`、参数填
`recipe run <id> … --yes`（`src/tasks/user-tasks.ts` 只认 command / action 两种执行体，不为 recipe
另加一种——CLI 就是那个桥）。退出码非 0 任务中心记红，3 表示"没正常收尾、动作可能已做了一部分"。

**跑完有产物的动作**再多一格申报：`meta.produces: "images"`。申报了的 recipe 以 sourceId 为模型名出现在
宿主的 OpenAI 形状生图口（`GET /v1/models` / `POST /v1/images/generations`，`src/http/image-generation-routes.ts`），
条目要带 `url`（退回带水印图的那张标 `watermarked:'true'`），`output.targetCount` 是一轮的上限（实际出几张由站点定，少了路由会再开一轮）；要接图生图就在 `params_schema` 里声明 `images`（参考图的 data URL，多张按行拼），`/v1/images/edits` 会递进来。那条口是
**宿主的适配器**，不认包名——接一个新的生图站点就是再写一份申报了 `produces` 的 recipe，宿主一行不改。
包**没有**"自己挂 HTTP 路由"的槽位（`PluginContext` 里没有），别往 `src/http/` 里写带包名的路由。

四样让"一套固定的界面操作"能整个写进 recipe 的东西（都是**通用形状**，不是某条流程的特例）：

| 写法 | 解决的问题 |
|---|---|
| `skipIf: <query>` | **别人在场就跳过这一步**。幂等开关要它：Chrome 的「开发者模式」toggle 一直都在、名字不带状态，读不出开关状态，而已经开着还点一次就是把它关掉。（`optional` 问的是"我自己的目标在不在"，是另一回事，别混。） |
| `{ kind: 'window', match, timeoutMs?, focus?, waitFor?, optional? }` | **换到另一个顶层窗口**并等它出现。原生文件对话框是主窗口的 owned window，**不是** `app` 那棵树的后代（进程可能还是同一个——Chrome 的文件夹对话框实测就在 `chrome.exe` 里，别指望按进程名区分），不换窗就永远在原来那棵树里找路径框。`waitFor`：标题先变、界面后建，再等一个恒在的控件出现。`optional`：等不到就跳过——**一段"锦上添花"的步骤要整段可跳过**，只把里面的 `invoke` 标成 optional、漏掉它们赖以立足的 `window`，等于留了个能把已经成功的流程判死的洞。 |
| `{ kind: 'pickFile', path, dialog?, timeoutMs?, closeTimeoutMs? }` | **喂一个已经弹出来的系统文件对话框**：等它出现 → 把 `path` 写进文件名框 → 让文件名框拿焦点、回车 → 等它消失 → 范围与前台目标**自动换回**这一步之前的窗口。前一步（点「发送文件」图标）负责把对话框弹出来。它收编的是此前要手抄的四步（`window` 等对话框 → `type` 填路径 → `invoke` 点确认 → `window` 换回），并修掉其中最脆的一格：**确认键不一定在控件树里**（微信「选择文件」对话框，同一台机器两次抓树一次有 `Button`「打开(O)」一次没有，2026-09-18）——主路是 setValue + Enter（活体验过），树里有确认键只当 Enter 没关掉时的备选。`path` 通常写 `{path}`（`format:"path"` 参数翻译后的形状）。`dialog` 省略 = 按 agent 报的平台取默认：win32 `{process:<app 进程>, titleAnyOf:['打开','选择文件','Open']}`（comdlg 默认「打开」，应用可改），darwin 是 NSOpenPanel（合成标题 `<无标题 AXSheet>` / `<无标题 AXDialog>`）；给了就按它认，标题包含匹配、`{param}` 照填。`timeoutMs` 等出现（默认 12s，第一次弹出实测要几秒）、`closeTimeoutMs` 等消失（默认 8s）。它是动作步：`expect` 在范围换回之后、在原窗口里验（"文件卡片出现在输入区"），恒真预检也在原窗口做，上一轮留下的同名卡片会被当场指出；写不出判据就 `blind`。**失败四个前缀各指一段**：`pickFile/dialog-missing`（没弹——前一步没点中）/ `pickFile/edit-missing`（对话框在、文件名框不在——界面语言或版本）/ `pickFile/set-value-failed` / `pickFile/dialog-still-open`（确认了它不关——路径打不开或弹了错误框）。走通的回执 `DesktopRunOutcome.pickFile[label]`：`via`（`value+enter` / `keyboard+enter` / `button` / darwin `goto+enter`）、`ms{appear,fill,close,total}`、`foregroundBack`（对话框没了之后主窗回到前台没有——没有文字判据的挂载（图片）只剩这一个弱信号，只记不判）。**macOS 那条路没有真机，按 AppKit 惯例写（面板上敲 `/` → `PathTextField` 写路径 → 回车 → `OKButton`），全部待活体验证（2026-09-18 起）。** |
| 窗口标题**是包含匹配** | 所以两个 `window` 步骤的候选标题**不许互相包含**。活体撞过：扩展页写成「扩展程序」，而文件夹对话框叫「选择扩展程序目录。」——装完那一步匹配上了正在关闭的对话框，报出来的却是"没能回到扩展页"。写全（「扩展程序 - Google Chrome」），并拿一条测试钉住这个不变量。 |
| `nameAnyOf: []` / `titleAnyOf: []` | **多候选名**。控件名和窗口标题跟着界面语言走，押一门语言换台机器就是空结果，而空结果和"这个版本改了界面"长得一模一样。展开在 runner 本地，不上 wire。 |
| `type` 的 `requireTarget: true` | **找不到输入框就停手**，不退回键盘。默认那条退路对采集是对的，但对"往特定框里填特定内容"是有害的：文字会打给碰巧有焦点的东西，而这一步照样"成功"。 |
| 步骤的 `label` | 失败时给人看的那句话。没有它，一条二十步的 recipe 失败了只报一个 JSON 查询，读的人得回去数第几步。**面向用户的流程必须写。** 跑的时候它也是接管提示条的第二行（`<label> (i/n)`）。 |
| `meta.title` / `meta.purpose` | **接管提示条的第一行**：`<title> · <purpose 填参>`（`微信发消息 · 发给 文件传输助手`）。`title` 就是这条 Source 的显示名（投影进 manifest `title`，缺省退回 sourceId）；`purpose` 才是提示条专有的：这一次目的的模板，`{x}` 只能引用 `params_schema` 声明过的键（装载期拒），且**不许引用 `secret_params`**——purpose 是这条链路上唯一一处让参数值上屏的地方，作者点名要露的才露，步骤 label 里的 `{contact}` 仍原样留着。两个都可选。 |

#### 桌面 recipe 的 `see` / `expect` / `interrupts`

**`see`：指屏幕上人眼看得到的东西，不指坐标。** `invoke` / `type` 的目标除了 `query`（a11y 的
role/name）之外可以写 `see`，两个只能给一个——一个目标只押一种词汇。`see` 里 `text`（屏幕上的这段
文字，支持 `{param}` 插值）与 `icon`（没有文字可指时的一句话描述）恰给一个，可选 `region` 按窗口九宫格
限定在哪一块找（边缘档取 1/3，`center` 取中央 1/3×1/3），或者反过来用 `not-left` / `not-right` /
`not-top` / `not-bottom` 排除某一侧三分之一、其余都算——给**固定宽度侧栏**用的：微信会话标题紧挨着
固定宽的左栏，随窗口尺寸在中间与左侧三分之一之间漂，没有一个正向格罩得住它，而「左栏以外」在任何尺寸下
都成立。**固定像素的栏（微信左栏 335 逻辑像素、顶部标题条 80、底部输入区 220）用 `{unit:'dip', x, y, w?, h?}`**：
逻辑像素、从窗口左上角量、负的 x/y 从右/下边往回量、w/h 省略 = 到窗口边，运行时乘当次读屏的 `scale`。
比例矩形押的是"占窗口的比例"，这类栏不随窗口走——4K 最大化时左栏只占 0.09，`x:0.2` 会把紧贴左栏的
会话标题和正文开头整个切掉（OCR 读出半截字，包含匹配落空），而 1600 宽的窗上同一份 recipe 又是好的。
怎么把这句意图变成一个框归识别层
（`src/replay/desktop-see.ts`，梯子见 `docs/ENGINE.md` §3），recipe 里一个数字都不该出现——
坐标押的是"窗口这次摆在这个位置、这台机器是这个缩放比"，换台机器就点到别处，而每一步照样"成功"。

**`see.below` / `see.notBelow`：按小标题分节找。** 分节列表里同一段文字会出现好几次（微信搜索候选弹层：
「搜索网络结果」下面第一条就是你打的字本身，「联系人」/「功能」/「公众号」下面才是真的那个账号，「收藏」
下面还有「来自：某某」），各节的位置又随结果动态变，`region` 切不动。`below` 列出**算**的小标题、`notBelow`
列出**不算**的，两份合起来是"哪些字是小标题"的全集；一个候选归离它最近的上方小标题，上方没有已知小标题
的不算。只对 `text` 目标有意义，给了就跳过 a11y 段（控件树没有"在哪个小标题下面"这一维）。

**`see.not`：别要那一行。** 候选**所在的那一行**里出现了这些字中的任何一段，整行出局。给
"看着像目标、其实是另一个入口"的行用：QQ 搜索联系人时，左栏同时出现真正的会话行和最下面那行
「进入全网搜索<名字>」，两行都写着那个名字。**靠位置分不开**（曾经按 x 切过：真行 x=121、
兜底行后半段 x=210——名字长一点就错位，那是把语义区别编码成像素阈值，会安静地失效），而
"那一行里带着『进入全网搜索』"是稳定的、语义上的区别，也正是人一眼分开它们的依据。

**判据落在行上，不落在段上**，这一点是必须的：OCR 每帧的分段不一样，那行兜底入口有时是一整段
「进入全网搜索我的手机」，有时被切成「进入全网搜索」+「我的手机」——只按段剔，剔掉的是前半段，
后半段照样是个和目标全等的假候选（本机 2026-09-07 实录）。按行聚合之后怎么切都不影响结论。

**`require`：前置条件。** 任何步骤都可挂 `require: { see | query, timeoutMs }`——动作之前必须成立，等到成立
（最多 `timeoutMs`）再做；等不到按这一步的 `else` 处理（`abort` = 此后不再发任何输入）。它和 `expect` 相反
（那个是动作前必须为假、动作后必须为真），补的是**判据落在别的窗口里**那一格：点候选弹层里的一行之后弹层
就关了，「会话标题是他」这个判据在主窗口里，只能挂到下一步（打正文）的前面。**不做恒真检查**——"此刻必须
为真"正是它的语义。同一格的另一种形状：**动作在对话框里、送达判据在主窗里、后面没有别的动作步了**
（`wechat-send-file`：点「打开」就发出去，回主窗只剩"看文件气泡"）——切回主窗之后挂一个 `wait 1ms` 步、把
判据写成它的 `require`。写成 `expect` 不行：预检"动作前必为假"在切窗之后才做，小文件那时气泡已经在了，一趟
真发成的会被判成恒真装饰。

**识别层的成本梯子与总开关。** `see` 按成本递增解：固化的句柄（上一趟模型定位过、留下了控件名）
→ 控件树 → 读屏（PP-OCRv5 跑在 ONNX Runtime 上，模型三件 `ocr-det.onnx` / `ocr-rec.onnx` /
`ocr-rec-dict.txt` 与运行时库都在 exe 旁；缺任一样两平台都直接报 `ocr-missing` / `ort-missing`，
不回落）→ 模板（本机缓存）→ 本地检测器给可点框（OmniParser icon_detect，exe 旁的
`see-detector.onnx`，只在 `icon` 目标和要问模型前才算）→ 视觉模型挑编号（`desktop.see` 调用点）
→ **grounding 模型报坐标**（`desktop.point` 调用点，最贵、最后）。

**最后两档是两个不同的问题，不是一档的两种说法。** `desktop.see` 问「这些候选里哪个是」，而候选
一律来自元素表——所以**元素表里压根没有的东西它永远指不到**（候选池空了它只能如实说没有）。
`desktop.point` 问「它在哪」，模型可以报出一个元素表里不存在的位置。因此它们各占一个调用点，
该绑两种模型：前者是看图挑选，后者要 GUI 专用的定位模型。

**只有 `see.point` 目标会走最后一档**，而且**只在动作路**——判据（`expect` / `require` /
`branch.when`）一行模型都不调，所以一个只写了 `point` 的判据永远不成立。

**点完立刻固化，所以这一档同一格只付一次钱。** 模型报出坐标之后会回读一次元素表，看那个位置上
有没有一个带名字的控件；有就把名字存进本机的 `handles.json`，下一趟从梯子第一档走完（省掉整窗
一次 OCR），而且**坐标漂了句柄还在**——桌面上 a11y 查询就是 XPath 的等价物。存下来的句柄一旦
点了却 `expect` 没兑现，会连同陈旧模板一起被作废（见下面的介入闸）。

**读屏的价钱按面积和行数走，所以 `region` 不是优化项、是这条路能用的前提**：整窗 1–3.4 秒
（det 随像素面积线性，rec 每行一次推理、20~50ms 一行），带 `region` 的一小块约几十毫秒——判据
几乎都写了 region，常态路径因此是快的。识别结果按框的图像内容缓存，同一屏第二次只认变了的那几行。

**梯子第一段（控件树）现在很便宜**：一次整窗枚举几十到几百毫秒（空树 ~50ms，几百个控件的真树
~0.6s），"找不到"也是几十毫秒。所以有控件树的应用没有理由绕开它——别因为"a11y 慢"去写像素判据。

**检测器只回答"哪儿有个能点的东西"，回答不了"哪个是我要的"**：它给的框没有名字，名字是 OCR 从
框里的文字扒出来的（写着「发送」的按钮因此有名）。

**比"无名"更糟的一档是"连框都没有"**：大片空白的输入框既没有文字可认，检测器（训练来找图标和
按钮的）也不给框，那它在三张表里**都不存在**——不是识别得不准，是那儿确实没有可指的东西。
本机 2026-09-07 的 QQ 消息输入框正是这一档。

**这一档正是 `see.point` 存在的理由**：`text` / `icon` 都是在表里挑，表里没有就挑不出来；
`point` 直接问模型「它在哪」。按顺序试三样：先问控件树有没有它（最便宜）；没有就写 `point`
（第一次付一次模型钱，之后固化成句柄）；两样都不行，才把**判据**换成"动作的后果"
（打了字之后正文出现在哪儿）而不是"动作的目标"——注意最后这一条换的是判据，不是靶子。

后端环境变量 `STREAM_DESKTOP_SEE_MODEL=off` 把最后**两**级整个拿掉，只剩本地能力——`icon` 与
`point` 目标从此无解，`text` 目标不受影响。**本地能走多远，量过一次**（2026-09-07，QQ 发消息）：
搜索、消歧、核对身份、送达判据全都走得动，停在"点一个没有文字、也没有稳定名字的东西"上。

**介入闸：`expect` 没兑现是叫 AI 的唯一触发口。** 一步彻底放弃时，如果它的靶子是**缓存给的**
（`template` 的图 / `point` 的坐标 / `pinned` 的控件名），就作废那个靶子并交出一条 **locator
提议**（`RepairProposal`，走 `src/replay/repair-runner.ts` 那条接缝）。三条边界：

- **只作废，不在同一趟里重走。** 这一趟已经点过一次，副作用可能已经发生，重来就是第二次点。
- **提议不改 recipe。** 静默自愈会把「界面真的改了」和「这次没点中」混成同一件事，而后者
  自愈"成功"就等于把一个真 bug 每次都自动绕过去，于是永远没人知道。
- **范围锁死在 locator。** 提议里装的永远是动作那一步的 `see`，判据一格都不许被改写——
  判据能被模型改，整套东西就退化成「模型自己说自己成了」。

`screen` / `a11y` 那两档不吃这一下：它们是**现读**的，没兑现说明界面上真的没有那个东西，
不是靶子陈旧。

**`branch`：分支。** `{ kind:"branch", when:{ see | query, timeoutMs? }, skip:N }`——`when` 此刻成立就跳过接下来
N 步，不成立就往下走；只评一次、在当前范围里评、不做恒真检查、不调模型。给"目标状态可能已经在了"的流程用
（会话已经是他就不搜了）。它不绕过任何闸：被跳过的步骤之后那一步的 `require` / `expect` 照常生效。逐步的
`skipIf` 不能替代它——几步里若有一步的范围在别的窗口，同一个判据在那里评出来的意思完全不同。

`when` 的第二种形状是**按参数分支**：`when:{ param:"send", equals:false }`——不读屏，只看调用方给的参数
（到 runner 手里已是字符串，`equals` 按 `String()` 比；参数缺席 = 不成立，默认值只在 `params_schema.default`
一处补）。`param` 必须是 `params_schema` 声明过的键（装载期拒：拼错的分支永远不成立，表现是"开关没生效"）。
给"同一条流程、最后一发做不做由调用方定"用——`wechat-send` 的 `send:false` 把正文打进输入框、跳过回车、
run 以 `ok` 收场。**只有参数分支允许跳到 recipe 末尾**（吃掉剩下的全部步骤）；读屏的分支跳到末尾是"什么
都没做却 ok"，装载期拒。跳过了什么进回执：`DesktopRunOutcome.skipped`（`run_action_recipe` 的 `done`
也带）每项 `<被跳过的步骤 label> ← <分支的 label>`，一步都没跳就没有这个字段——光看 `done`，「打进去没发」
和「发出去了」一模一样，这一行才分得开。

参数分支还能带 **`unverified:"<理由>"`**：这条分支成立 = 跳过了这一趟唯一的判据，runner 把理由记进回执
`DesktopRunOutcome.unverified[]`（`done` 也带）。给"判据按参数分流、其中一路根本没有判据"的流程用：
`wechat-send-file` 发图片——微信把图片挂进输入框只画缩略图、没有文件名，文字判据恒不成立，那一路只能跳过判据、
以「对话框已关」当弱判据，回执标 `unverified:['image-no-caption']`。一趟 `ok` + `unverified` 是"做了"，不是
"看见做成了"，调用方要能分开。只在参数分支上放行（读屏的分支成立是读到了状态，不叫没验）。

**`params_schema.<k>.format:"path"`：这个参数是目标机器上的文件路径。** 执行前（`materializeParams`，
`src/mcp/validate-params.ts`，三个入口同一份）：Linux 形状的路径先验存在、后端在 WSL 里就翻成
`\\wsl.localhost\<distro>\...`（`wslpath -w`，和代装扩展那条路同一份翻译）；已经是 `C:\...` / UNC 形状的
原样放行（`wslpath` 会把反斜杠吃掉，不能让它碰）；翻不出来 / 文件不存在 / 相对路径都在这里以
`invalid-params` 拒——一条注定填不进去的路径交给对话框，失败长得像"控件没找到"。顺带派生五个片段
（`src/replay/path-params.ts`）：`{<k>_name}` 文件名、`{<k>_stem}` 去扩展名的主干、**`{<k>_stem6}` 主干前 6 个字**、
`{<k>_ext}` 小写扩展名（不带点）、**`{<k>_kind}`** `image`（png/jpg/jpeg/gif/webp）或 `file`。界面上显示的是
文件名不是路径，而且**长文件名会被截断**（微信：「中基协登记备...2期.pdf」），全名当判据必失败——判据拿 `_stem6`
做包含匹配（`wechat-send-file` 的挂载 / 送达判据都是它）；图片没有文字可指，`branch` 按 `_kind` 分流。
派生键不在 schema 里，调用方传它会被未声明键那道闸拒掉；`branch.when.param` 认它们。

**`clear`：清空此刻有焦点的输入框。** `{ kind:"clear" }`——全选 + 删除，哪个修饰键归平台后端，recipe 不知道
也不该知道。给"上一轮停在打正文之后、正文成了草稿"这一档用：不清，下一轮的正文接在草稿后面一起发出去。
**紧跟在拿焦点那一步之后**——它清的是此刻有焦点的东西，焦点在别处就清错地方。它不是"按组合键"的通道
（`Ctrl+A` 一放行，`Ctrl+W` / `Alt+F4` 就在同一条路上），语义窄到只有这一件事；只走抢屏路，
`input:"message"` 下 agent 直接拒。

**`input`：坐标输入投给谁。** 省略 = 投给屏幕：agent 合成键鼠输入，每个坐标步骤之前先把 `app` 抢到
前台，抢不到（锁屏、别的窗口压着）就停手、一个输入都不发。`"input": "message"` = 投给窗口本身
（`PostMessage` 到它的 hwnd）：**不抢前台、锁屏照常跑**，`focus` 步骤只剩限定范围。这是没有控件树的
应用能"人不在时后台干活"的唯一一条路，微信 4.x 锁着屏全程验过。**它是显式选的，不是自动退路**：
走自己合成器的应用（Electron 系）多半不理会投进来的消息，而且失败得安静。哪个应用认只能真机量一次
（`stream-desktop.exe see-probe` 看得见界面、看不见输入进没进去——判据是每一步的 `expect`），量过
再写；写了 `input:"message"` 的 recipe 尤其不能省 `expect`。收件人是 `app` 匹配到的**顶层**窗口，
投给自绘子窗口进不去。

**`app.a11y`：这个应用有没有控件树。** 缺省 `true`。`"a11y": false` 是作者的**事实申报**（不是优化开关）：
动作前的元素表读取（`readElements`）就不再枚举控件树，每步省 80–90ms；判据路（`readText`）不受影响。
什么时候写：`see-probe` 的 `elements` 里 `kind:"a11y"` 恒为空**且**应用是已知自绘（微信 4.x 整个窗口只有
一个自绘 Pane）。它和 agent 拒绝的"问一次是空的就永久记黑名单"不是一回事——那是从一次临时状态推永久
结论，这是作者声明一个不随前后台变的事实。写错的表现：a11y 段永远缺席、点击全走坐标，而每一步照样"成功"，
只有日志里每次 `elements` 读都是 `a11y=0ms(off)`。非布尔装载期拒。

**`expect`：这一步做成了没有，一步一验——动作步骤必写，装载期强制。** `invoke` / `type` /
`click` / `scroll` / `press` / `clear` / `pickFile` 都能挂 `{ see | query, timeoutMs }`（默认 3000）。**要么给 `expect`，
要么给 `blind`（一句话说明为什么这一步没有可观测的后果）**，二选一，两个都不给装载就拒。

> **为什么是强制的**：「我点了一个东西，接下来就该看见某个东西」这条规则一直写在这里，但因为
> 曾经是可选的，实际上基本没人守——量过一次，桌面 recipe 的 21 个动作步里 **18 个没写**。不守
> 也没有任何提示，代价是点空了要拖到两三步之后才以别的面目冒出来，那时早已回不到现场。
>
> `blind` 不是豁免，是把**"忘了写"和"想过、确实没有"分开**。有些转移在某个后端上真的看不见：
> "输入框拿到了焦点"在视觉方案里没有任何画面变化。那就写下来，并说清责任转移到哪一步
> （`qq-send-see` 的「点搜索框」：点没点中由下一步「输入联系人」的 `expect` 兜住，那一步 `abort`）。
>
> **判据的形态跟着后端走**，但规则是同一条：浏览器上是某个选择器出现/消失，控件树上是某个控件
> 出现，视觉方案上是某段文字出现在某块区域。
>
> **写不出经过验证的 expect 时，不要编一个。** 没验过的 expect 比没有 expect 更坏——它看起来
> 严谨，其实是猜的。如实写进 `blind`（`qq-send` / `telegram-search` 那两份就是这么处理的，
> 用「未补判据」当可 grep 的待办标记）。

两条纪律照浏览器侧原样搬：**动作前必须为假、动作后必须为真**
——runner 动作前先即时读一次，此刻就成立的判据会被指名"恒真"当场判 drift，因为恒真的判据是装饰不是监督；
动作后轮询到成立或超时。不成立时按 `else` 走：`drift`（默认，停下留现场）、`retry`（重做这一步，上限一次）、
`abort`（干净停下，**此后不再发出任何输入**）。**有副作用的流程必须用 `abort` 把错误路径封死**：
`wechat-send` 在「名字出现在搜索框里」和「会话标题是他」两处都是 `abort`，没看到就绝不往下打正文——
发错人这条路从形状上没有了。

**`expect.fresh: true`：画不出一块"动作前必不含它"的区域时用。** 它把"动作前必为假"换成"动作后冒出一个
动作前没有的位置"：runner 动作前把这段字在区域里的全部位置记成一张清单（不做恒真预检），动作后要看到
一个不在清单里的位置才算兑现（同一行 OCR 框抖几个像素仍算原位）。只配 `see.text`、只在 `expect` 上
（`require` 只有"此刻"一帧）。典型是聊天输入框：它能被用户拖高拖矮，输入框和气泡之间没有固定的线——
`wechat-send` 的「打正文」「回车发出去」都用一块「会话区」+ `fresh`：打字 → 输入框里多一处；回车 →
气泡里多一处，没发出去就只剩输入框原位那一处；连发同一句，上一条的位置已在清单里。代价：区域可以
放宽但读屏按面积计价，只罩真正需要的那一截。

**`interrupts`：随时可能跳出来、关掉就能继续的东西。** 它是 recipe 级的一张表（更新提示、广告、权限询问），
每条是 `{ see, dismiss }`，`dismiss` 只认 `invoke`（带 `see`/`query`）或 `press`（`Escape` / `Enter`；
`press` 在普通步骤里**只放行 `Escape`**，回车照旧写 `type` 的 `\n`——别给同一件事两种写法）。**只在某步 expect 不成立时才查表**，正常路径
一次多余的读屏都不发；命中就 dismiss、重验一次原 expect，仍不成立才按 `else` 处理。**每步最多消化一次**——
允许循环的代价是被一个关不掉的弹窗困死。两件东西不进这张表：登录墙（它关不掉，归 `loginCheck` →
`needsLogin`）和表里没写过的弹窗（那是 drift，留现场给人看，绝不在不认识的界面上乱点）。

#### `map`：从一坨文本里抽出顶层字段

a11y 树只给得出控件的 `name`——一条 Telegram 消息的 name 就是整段正文挤成的一行字。而 Stream 的
item 要的是 `title`/`link` 这些**顶层**字段：**前端各处显示的是顶层 `item.title`**，在 normalizer
里再抽一次是白抽（教训写在 `packages/alist/normalizer.ts`）。所以桌面 recipe 有一层 `map`，
`目标字段 → { from: 源字段, match: 正则 }`，取第一个捕获组（没有捕获组就取整个匹配）：

```jsonc
"observer": { "itemQuery": { "role": "ListItem" }, "fields": { "text": { "read": "name" } }, "dedupeBy": "text" },
"map": {
  "title": { "from": "text", "match": "名称：(.+)" },
  "link":  { "from": "text", "match": "https?://[^\\s]+" }
},
"read": { "dedupeBy": "link", "targetCount": 30 }
```

四条规矩：

- **抽出来的字段是叠加**，原始字段照留（追溯要靠它）。
- **抽不到就不写这个键**，绝不写空串——空串会把"没抽到"伪装成"抽到了一个空标题"，
  而 `(untitled)` 至少看得出是缺失。
- **`map` 在 dedupe 之前跑**，所以 `read.dedupeBy` 可以指向抽出来的字段。按整段正文去重是不稳的：
  正文尾巴上挂着浏览数、「已编辑」这类每次读都在变的东西。反过来，抽不到 dedupe 键的那条会被
  丢弃——广告条通常没有链接，这正好当过滤用。
- **正则在装载时就编译**，坏正则当场拒收。留到运行期才炸的表现是"这一轮什么都没抽到"，
  与"页面变了、规则不匹配了"一模一样，会把一个打字错误伪装成源站漂移。

#### 落地方式（`groundings`）与贡献

**一步 = 意图 + 判据 + 若干份带标签的落地方式。** 图（有哪些步、从哪到哪）和判据跨平台通用，
而"怎么认出当前态、点哪里能过去"按（平台，应用版本，界面语言）分叉——两者的稳定性差一个量级，
写在同一行里就会让一个平台差异看起来像整份 recipe 作废。权威设计见
`internal design record`。

```jsonc
{
  "label": "等候选弹层",                       // 必填且全份唯一：它是本机 override 与贡献物的键
  "intent": "等搜索候选算出来、并把范围切到候选所在的地方",   // 人话意图，给未来的填充者读
  "kind": "window", "match": { "process": "Weixin.exe", "title": "Weixin" },  // 顶层 body = 通用落地方式
  "groundings": [
    {
      "on": { "platform": "darwin" },        // 没写的键 = 不限
      "kind": "wait", "ms": 600,
      "note": "mac 没有这个弹层，候选画在主窗左栏",
      "verified": { "runs": 3, "first": "2026-09-12", "last": "2026-09-12", "by": "author" }
    }
  ]
}
```

- **顶层 body 就是通用 grounding**：没写 `groundings` 的 recipe 一字不改照跑。
- **判据只住顶层**：`label` / `intent` / `expect` / `require` / `else` / `optional` / `blind` /
  `skipIf` / `groundings` 在 grounding 里出现是格式错误，装载即拒。理由是缓存能安全重填的前提——
  换了办法点进去，检查的还是同一件事；填错了被判据拦住，不会发出去。
- **grounding 里不许把参数写死**：顶层带 `{param}` 的字段，grounding 的同一路径必须还带着同一个
  `{param}`（换了写法、没有这个字段则不管）。这既是 recipe 跨调用的正确性，也是贡献链的脱敏闸。
- **`on` 的键**：`platform`（`win32` | `darwin`）、`app`（版本区间）、`lang`。
  区间语法只认空格分隔的 `>= > <= < =` 与裸版本号（`>=4.0 <4.1`、`4.0.6`），全部成立才算；
  `^` / `~` / `||` 装载期当语法错拒掉。
- **`on.app` 必须和 `on.platform` 一起写**（约定，装载期不拦）：两个平台报的版本格式不是一回事——Windows 报 exe 的
  文件版本（四段，如 `4.0.6.36`），mac 报 bundle 的 `CFBundleShortVersionString`（如 `4.0.6`）。
  一个不带 platform 的区间在另一个平台上会落在意料之外的一侧。agent 报不出版本时，带 `app` 的
  grounding 一律**不匹配**。
- **事实从 agent 来**（`WindowInfo.platform` / `appVersion`），不看 `process.platform`：后端在 WSL、
  agent 在 Windows 那种组合下后端自己的平台就是错的答案。老版本 agent 不报平台 → 只剩通用 body。
- **选择与兜底**：候选 = 包内 `groundings` ∪ 本机 override ∪ 顶层通用 body，按事实过滤后排序
  **贴合度**（`on` 写了几个键）> **来源**（包 `author` > 包 `contributed` > 本机 `human` > 本机 `ai`）
  > `verified.runs`，通用 body 永远最后。逐条试：执行 body 再跑顶层 `expect`，过了就用它；
  `else: "abort"` 那一步不许 fall-through（有副作用的路径不能试第二次）。全试完都没过 → drift 原因带
  `no-grounding@<label>` 前缀，携带试过的清单与当前事实。`DesktopRunOutcome.groundings` 记下每步
  用的是哪条（`package:<platform>[@app]` / `local:…` / `universal`）——**退路必须留痕**。
- **`edges[]`（条件边）只校验形状、不执行**：格式先钉住，免得两个写法各自漂。
- **步骤 `kind` 有白名单**，grounding 同吃这份名单：拼错的 kind 会被选中然后什么都不做，比没有它更坏。

##### 具名区域：判据的文字通用，判据看的那一块屏按平台落地

`expect.see.region` 装了两件事：「正文出现在气泡区」是判据、跨平台通用；「气泡区在这台机器的窗口里占哪一块」
是落地事实，和「输入框在哪」同类。拆开：顶层 `areas` 声明几块有名字的区域，`see` 用 `area` 引用（与 `region` 互斥）。

```jsonc
"areas": {
  "气泡区": {
    "intent": "已发出的消息所在的那一块；下沿必须排掉底部输入框",
    "region": { "x": 0.34, "y": 0.06, "w": 0.66, "h": 0.72 },     // 通用（可省）
    "groundings": [
      { "on": { "platform": "win32" }, "region": { "x": 0.34, "y": 0.40, "w": 0.66, "h": 0.38 }, "verified": { "runs": 1, "first": "2026-09-13", "last": "2026-09-13", "by": "author" } },
      { "on": { "platform": "darwin" }, "region": { "x": 0.34, "y": 0.06, "w": 0.66, "h": 0.52 } }
    ]
  }
},
"steps": [{ "label": "回车发出去", "kind": "type", "text": "\n", "expect": { "see": { "text": "{message}", "area": "气泡区" } } }]
```

- 区域 grounding 的 body **只有 `region`**（九宫格名 / `not-<边>` / 比例矩形 / dip 矩形）；出现别的键装载即拒。
- **选法是查表不逐条试**：开跑前按事实（平台、版本）为每块区域取一条（贴合度 > 来源 > runs，通用最后）；
  一块都选不中就整趟以 `no-grounding@area:<名字>` 停在发出任何输入之前——区域没有自己的 expect 兜底，
  逐条试等于拿别的区域把一个真失败洗成功。
- 记账、本机 override（文件里的 `areas` 段）、贡献（`stream recipe contribute <id> --area <名字>`）、吸收
  （`pnpm recipe:absorb`）全走 steps 那一套；只有**肯定**结论才记（动作前"此刻必须不成立"那次不算）。
- **什么时候用**：同一块屏被多条判据引用（标题栏）、或两平台位置不同（输入区、气泡区）。一处只用一次、
  两平台一样的矩形照旧内联 `region`。声明了没人引用的区域装载即拒。

**本机 override**：`<dataDir>/recipe-overrides/<sourceId>.json`——**不在包目录**，装的包住
`<dataDir>/recipes/<包名>/`、升级整目录覆盖。形状与包内 `groundings[]` 一致，只多一段来源，
所以每条都是能合回包里的块，不是私有魔改。包内 grounding 的次数记账也落在这里（包文件只读）。

```jsonc
{
  "recipe": "wechat-send",
  "package": { "name": "@streamapp/wechat", "version": "1.0.1" },
  "steps": {
    "点进消息输入框拿焦点": {
      "groundings": [{
        "on": { "platform": "darwin", "app": ">=4.0.6 <=4.0.6" },
        "kind": "click", "at": { "x": 0.6, "y": 0.87 },
        "verified": { "runs": 4, "first": "2026-09-14", "last": "2026-09-16", "by": "human" },
        "shadowed": false
      }]
    }
  },
  "edges": []
}
```

**本机 override 条目今天只有两种来源**（没有自动填充者——AI/人机填充是后话）：运行时给**包内**
落地方式记账（`by: "author"` / `"contributed"`，来源是包自己，因此永远不可贡献），以及**人手写进**
`<dataDir>/recipe-overrides/<id>.json`（`by: "human"`，过了门槛才可贡献）。所以 `stream recipe
contribute` 在没人手写过的机器上只会说「没有可贡献的落地方式」——那是对的，不是坏了。

一趟 recipe 走到 `done` 之后记一笔：`verified.runs += 1`、`last` 更新、`>=a <=b` 形状的 `on.app`
按本次版本扩边。对账发生在**每趟运行的开头**（runner 在第一次挑落地方式之前调
`overrides.reconcile`），不在装载期——包热更之后那一趟立刻吃到新的对账结果，而不是读着上一版的
本机落地方式跑完。对账做两件事：本机学到的那条已经进了包（同 label 同 `on` 同 body）→ 删掉；
`on` 被包内某条覆盖但 body 不同 → 标 `shadowed`（运行时不参与，UI 上可见、可删）。没变化就一声不吭。

**贡献回包**。去向由包自己说，我们不维护任何收集服务；两格缺一格就是「此包未开放贡献」，不猜、
也不往 Stream 仓库兜底：

```json
"repository": "github:JaggerH/stream",
"stream": { "contribute": { "path": "packages/wechat/wechat-send.recipe.json" } }
```

- 门槛：一条本机 grounding 要 `verified.runs >= 3`、`last - first >= 2 天`、`by ∈ {ai, human}`、
  没被 shadowed，才算可贡献。闸必须有——它过滤一次性蒙对。
- 用户侧一个动作：`stream recipe contribute <sourceId> [--step <label> | --area <名字>]`（`--step` 筛某一步的、
  `--area` 筛某块具名区域的，两个只能给一个）。本机 `gh` 登录着 → fork +
  分支 `contrib/<recipe>/<platform>-<hash8>` + 文件 `contributions/<recipe>/<platform>-<hash8>.json` + PR；
  否则打开预填好的 issue 链接（标签 `recipe-contribution`）；正文超过地址栏能吃的长度 → 写到
  `<dataDir>/recipe-overrides/<recipe>.<hash8>.contribution.md` 并打印路径。
- 贡献物带：平台、版本区间、Stream 版本、grounding 本身、次数与首末日期、填充者类型。
  **不带**截图、控件树、`origin`、任何参数字面量。证据只用「在多少次真实运行里通过了判据」。
- **去模板化那道闸在送出去之前再跑一次**：本机 override 那份文件不过装载闸（只 `JSON.parse`），
  而它是允许人手写的——所以把顶层 `{contact}` 写死成真实联系人名的那条，闸开在装载期是拦不住的。
  `stream recipe contribute` 以包里那份 recipe 为基准逐条核，不过的跳过并打印是哪一步。
- 作者侧：`pnpm recipe:absorb <issue 或 PR 号>`。四种情形——同 `on` 同 body → 只合并 `verified`；
  同 `on` 异 body → **并列**为第二条，不替换（运行时逐条试，判据兜底）；没有 → 插入；
  找不到那个 label → 拒。插入的那条 `verified.by = "contributed"` 并附 `ref`。
  脚本只写文件，**不 commit**：作者跑一遍守卫测试再自己提交。

### 2.5 静默 shadow session 数据流

> **本节只是概念契约。** 这条链路的运行模型（账本从哪来、locate 定位的三档降级、
> tab 独占与抢占探测、观察者挂载时序）以及全部故障查表，见
> **`.claude/skills/write-recipe/SKILL.md`（唯一真相源）**。动手改 `src/replay/` 之前先读它。

Search 是 T2 Provider invocation：按调用执行，结果返回调用者，从不写入 feed ItemStore。
底层 session 可以长期存在，但这不改变业务数据的临时性质。（**Home/推荐流不做**——刷别人的推荐流
不是 Stream 该干的事，理由见 spec `2026-07-28-xhs-harvest-on-user-chrome-design.md`。）

```text
命令方向：frontend -> backend -> /api/ext WS -> extension/CDP -> site
事件方向：site -> extension/CDP -> /api/ext WS -> backend -> /ws -> frontend
```

一次用户点击详情的推荐流程（宿主这一侧对任何站都一样，站名只住在包里）：

1. frontend 从这条 item 的 `content.enrich`（包的 normalizer 写的 `{ source, params }`，§3.2）拿到去哪现取，
   发 WS 命令 `enrich.open { correlationId, source, params }`（协议见 `docs/API.md`）。
2. backend 派发给包交出的同名 enricher；enricher 经 `ctx.readSource` 跑本包的 detail recipe。
3. recipe 的 `locate` 步在 facility 的 shadow session 里按 feed 账本定位目标卡片（账本由运行时填，
   §2.2 Ledger），必要时滚动寻找；CDP trusted input 点击；network/state/DOM observers 同时开启限定观察窗口。
4. backend 按 correlationId 分片推回 `enrich.article` / `enrich.comments` / `enrich.completed`。
5. session 返回原 Search 上下文并待命。
6. 目标卡片已被虚拟列表回收且无法恢复时，允许降级为详情 URL 导航，但必须记录 degraded path。

带 `content.enrich` 的卡片接近 viewport 不得自动触发 detail recipe（前端 `allowsAutomaticEnrichment` 对它恒假）；
只有用户真实点击或显式调用才触发详情。

### 2.6 Record -> Translate -> Validate -> Replay

四阶段必须使用同一份 Recipe schema 和同一个正式 runner：

1. **Record**：在 debug-visible session 中捕获动作、Network 样本和 DOM/state 线索。
2. **Translate**：生成 `steps + observers + output` 的 Recipe 草稿；不保存坐标宏或 AgentHistory。
3. **Validate**：使用正式 runner 真机回放，验证 capability、登录、输出与漂移语义。
4. **Replay**：换成生产 session policy（`unattended`），零 token 确定性执行。

修复账本应以 `{facility, recipeId, version}` 识别失败单元，并记录受影响 Source。共享 detail
recipe 漂移时应产生一条 repair state，而不是给 Home/Search 各记一份互不相关的故障。

### 2.7 "验证"四格术语

| # | 名称 | 含义 | PASS 判据 | 代码锚点 |
|---|---|---|---|---|
| ① | 登录态检测 | 运行时 `LOGGED_IN / WALLED / UNKNOWN` 分类，wall 优先 | WALLED -> needsLogin；UNKNOWN 不伪装成 wall/drift | `src/replay/actions.ts` |
| ② | 登录流程 / 建号 | 人工登录：用户在**自己的 Chrome 里**照常登录（Stream 没有自己的 profile 要喂）。要 Stream 出面替他登时，`meta.auth` 声明 `login: 'qr'`（扫码面板）或 `login: 'oauth'`（替他点掉"用 Google 继续"，骑浏览器里已有的第三方登录态） | 登录成功；正/负 selector 可识别。声明了 `login` 的那两支还要能在重登面板里露面（`PANEL_LOGIN_KINDS`） | 站点自身的登录流程；`src/auth/browser-{qr,oauth}-login-provider.ts` |
| ③ | Recipe schema 校验 | load 时零浏览器静态检查 | schema、引用、capability 合法 | `src/replay/recipe-store.ts` |
| ④ | Recipe 端到端验收 | 真 session 执行完整 recipe | outcome=ok、无 drift、满足 output target | `src/replay/author/validate.ts` |

说"验证"时必须带对象、阶段和可观察判据，例如：

> 验证 xhs-detail 的④端到端回放：debug session 中由 Home card trusted click 触发，收到匹配
> detail response/state，输出 media + comments，`outcome=ok` 且 `driftReason=null`。

#### Record 与 Replay 的登录墙策略

- record / `interactive`：墙出现 -> 暂停、提示人工处理、一次 resume。
- replay / `unattended`：墙出现 -> abort、`needsLogin`、通知用户；不是 drift，不 quarantine。

### 2.7.1 三个版本字段，各答各的问题——没有一个是「字段语义版本」

三个名字长得像，问的是三件事。混用会做出反效果的动作，所以照这张表用：

| 字段 | 住在哪 | 回答什么 | 谁读它 |
|---|---|---|---|
| `version` | recipe 文件 | 「这份 recipe 我动过了，之前那些失败不算数」 | `RepairLedger`：drift 三次隔离，**版本变高才解除** |
| `schemaVersion` | 包描述符（旧形） | 「这个包按哪版包格式写的」 | 装载时的**上界**：app 太老就拒装 |
| `hostVersion` | 包描述符 | 「我要求宿主至少多新」 | 装载时的**下界** |

两条由此而来的纪律：

- **`version` 必填，且不许当格式版本用。** 缺了它，`shouldRun` 的 `recipeVersion > s.recipeVersion`
  恒为 false —— 那个源一旦被隔离就**永久隔离**，改多少次都放不出来，而且安静（隔离期直接
  DECLINED，"本轮未采集"，不报错也不记失败）。反过来，把它当格式版本使，等于每次修好一份坏
  recipe 都在宣称格式变了。
- **recipe 的新旧形状不看版本号，看结构**：`isCanonicalBrowserRecipe`（有没有
  `steps`/`observers`/`output`）分流，旧形翻新形是 `canonicalizeBrowserRecipe` 的活。
  要加一档形状迁移，加在那条路上，别去给 `version` 划区间。

### 2.7.2 `pick_in`：这个源在哪个**选择面**能被挑到

界面上有两个挑源的地方，它们要的是两种不同的东西：

| 面 | 用户在干什么 | 谁属于这里 |
|---|---|---|
| `stream` | 给频道加一条**会持续来内容的流** | 各站时间线、关键词搜索流、RSSHub 路由 |
| `provider` | 给 Provider 行挑一个**干活的成员** | 搜索腿（google/brave/telegram/baidu）、网盘验活（quark/baidu-share）、组合体里 expand 的那一档 |

在 recipe 的 `meta` 里申报（手写 manifest 同名字段）：

```jsonc
"pick_in": ["provider"]   // 只在成员面挑得到
"pick_in": []             // 两个面都不出现：后端代码/配置流程按名字直调
// 不写                    // = 两个面都能挑到（绝大多数源）
```

**缺省宽松是刻意的**：3000+ 条 RSSHub 路由本来就两边都成立，让它们保持沉默；要收窄的自己申报。
反过来（默认谁都挑不到）会让忘了申报的新源从两个入口一起静默消失——"少了一个源"没有任何人
会收到通知。代价是漏写不会报错，所以名单由 `src/manifest/pick.real.test.ts` 逐个钉住：新增一份
该收窄的 recipe 忘了申报，那条用例当场变红。

**别拿 `discoverable` 当它使**。那个字段只管两处（首页精选列表、按意图搜源的排序），说的是
"别在推荐里出现"。两者混用过，而且是反着错的两个方向：该藏的没藏住——通用选择器不看
`discoverable`，于是"给笔记点赞"这个写操作能被当成来源挑中；该露的藏过头——网盘那个源因为
`discoverable:false` 在通用入口里挑不到，逼得面板里复制了一份成员编辑器。

**判据是具名函数** `pickableIn` / `pickableAnywhere`（`src/manifest/pick.ts`），端点按
`?surface=` 过滤，拼错的面名一律 400（不静默当成"没传"去发一份更宽的列表）。加第三个选择面时
改 `PICK_SURFACES` 一处，两个消费端（列表 + 跨插件搜）自动跟上。

### 2.8 工程边界

目标控制点：

- `recipe.ts`：Recipe schema，只定义数据契约。
- `session-manager.ts`：facility session 生命周期、unattended/interactive、恢复与并发。
- `recipe-runner.ts`：steps 与 observers 编排、取消、correlation。
- `actions.ts`：通用 trusted browser actions。
- `observer-pipeline.ts`：Network/state/DOM observer 与输出合并。
- `browser-ext*.ts`：backend CDP driver/transport adapter。
- `extension/src/lib/driver.ts`：owned tabs、原始 CDP RPC/event transport；无 Recipe 业务逻辑。
- `repair-ledger.ts`：Recipe 级 drift/quarantine/repair 状态。

`harvest` schema 与一次性 `ReplayLauncher` 只作兼容读取——**新 Recipe 一律不写旧式互斥 harvest
mode**。删这层兼容之前，必须先迁移 builtin/user package 或给出明确的版本错误。

三条契约层的纪律：

- selector 漂移时更新 Recipe；**禁止把站点 selector 硬编码进通用 runner**。
- 传给页面的 evaluate 表达式必须自包含，并受 Recipe schema/runner 能力约束。
- `data/`、真实 profile、cookie、`config.yaml` 永不进入 Stream 包或 git。

### 2.9 `kind:'html'` 的每行 hop 链（`hops`）

`kind:'html'` recipe（宿主裸 fetch + linkedom，无浏览器）在 `list` / `detail` 之外还可以给**每一行**
声明一串额外的跳（`hops`）：一跳 = 再发一个请求，URL 由这一行已攒到的字段拼出（`{field}` 模板，
词汇与 `RecipeRequest.url` 的 `{param}` 相同；或 `urlFrom` 直接取某个字段当 URL，二选一），
响应按 `parse` 读——`'html'`（默认，字段用 CSS selector 抽）或 `'json'`（字段用 dot-path 取，
路径语义同 http 引擎的 `itemsAt`）。抽出的字段合并进这一行，后一跳因此能用前面跳的产物（链式）。

- **容错是契约**：一跳失败（网络错、非 2xx、URL 模板的洞没值、JSON 解析不了）只让那几个字段留空，
  **绝不让整行、更不让整轮采集失败**——hop 是补充证据。相对地，`detail` 的失败语义不变（仍然中断），
  老 recipe 一个不用改。
- 每一跳都走同一个受护栏的 `fetchHtml`（SSRF 公网校验 + `cookieDomain` 覆盖校验），hop 之间串行发。
- 字段级还有一个通用件：`HtmlField.extract` / json 字段的 `extract`——一个正则，捕获组 1（或全匹配）
  替换值、不匹配就丢弃字段。既是切片器（从 wikidata href 里剥 `Q\d+`），也是形状闸（`^tt\d+$`
  之类，垃圾值进不了 item）。
- 站点知识（哪个 API、哪个属性号、值长什么样）留在 recipe；引擎只提供「再跳一次、能拼 URL、能解
  JSON、能验形状」这四样通用能力——§2.1 的边界原话。
- 实例：`packages/wikipedia/wikipedia-award-list.recipe.json`——detail 从条目页抠出 Wikidata 实体
  链接（`extract` 剥出 Q 号），三个 json hop 拿 Q 号问 Wikidata 的 `wbgetclaims`（P4947/P4983/P345），
  换来的 TMDb/IMDb 编号落成 `tmdb_movie_id` / `tmdb_tv_id` / `imdb_id`，影视 canonical 阶梯直接吃
  现成 id（不再在兑换阶段访问 Wikidata）。

### 2.10 状态图：`states.json`

包可以自带一张**状态图**，回答「动完发现不对，那是什么」——未登录 / 登录墙 / 人机验证 /
版式 A / 空结果，这些同一个 URL 后面藏着的东西。文件是 `packages/<id>/states.json`（npm 包同样，
放包根），由包扫描器读进 `RecipePackage.states`。

**形状**就是 `StateGraph` 的 JSON（`src/replay/state-graph.ts`）：

```jsonc
{
  "states": [
    {
      "id": "xhs/results",                    // 必须 `<facility>/<状态>`
      "features": [{ "kind": "url", "pattern": "/search_result" },
                   { "kind": "dom", "selector": ".note-item" }],
      "group": "xhs/page",                    // 同组互斥，跨组可以同时成立
      "note": "搜索结果页"                     // 只进轨迹和提议，不参与匹配
    },
    { "id": "xhs/banned", "features": [...], "deadEnd": "账号被限制" }
  ],
  "transitions": [
    { "from": "xhs/login-wall", "steps": [ /* 复用 recipe 的步骤类型，不新造 */ ] }
  ],
  "anchor": "xhs/home"                        // 可选，预留
}
```

**状态 id 必须带 `<facility>/` 前缀**（`assertStateIdPrefix`）。前缀不是装饰：**进哪张图由它说了算**。
写错前缀的状态不会在运行时报错，它只是谁也认不出——所以扫描器在装载时就拦。

**特征词汇只有五种**（`Feature`），全部命中才算认出（AND）：

| `kind` | 问什么 | 备注 |
|---|---|---|
| `url` | URL 匹不匹配这个模式 | 网页侧最便宜的一条 |
| `dom` | 这个选择器选不选得到 | 支持 `absent` |
| `a11y` | 控件树里有没有这个查询命中的东西 | 支持 `absent` |
| `text` | 屏上有没有这串字 | 支持 `absent`、`region`、`where` |
| `image` | 屏上有没有一小块长成这样 | base64 参考图，NCC 模板匹配；支持 `absent` |

`absent: true` 是必需的一档，不是补充：「已登录」最可靠的判据往往就是「登录按钮不在了」，
互斥也靠它撑开。**背景色不作为特征**（跟随系统主题，跨机器不可移植）。

**整包拒载的判据**（`validateStateGraph` + 扫描器；`states.json` 坏掉时整个包不装载，而不是
悄悄少一张图——少一张图的症状是「这个源永远认不出自己在哪」，没有一处会喊）：

- 顶层不是 `{ states: [], transitions: [] }`（JSON 解析不了也算）。
- 某个状态 `features` 为空——它会匹配一切，等于把 `identify` 关掉。
- 状态 id 重复，或缺 `<facility>/` 前缀。
- 转移的 `from` / `to` 指向不存在的状态。
- 已声明 `deadEnd` 的状态又有出口——两者矛盾，留着的话读图的人和引擎会各信一半。

**这是三层里的一层**：内置全局（`states-builtin.ts`，Cloudflare 三档）∪ 包自带这张 ∪ 本机学到的
（`<dataDir>/state-graphs/<facility>.json`，接受 AI 介入的提议时写）。键是 **facility** 不是
sourceId——状态是站点级的事（`xhs/results` 对 xhs-search、xhs-home、xhs-detail 都成立）。
任意两层 id 撞车一律报错。三层的分工与理由见 spec
`internal design record` §9.1，装配与运行时行为见
`docs/ENGINE.md` §6。

**怎么挑特征、怎么验、学到的状态怎么升格进包**，见 `write-recipe` skill
（`references/authoring.md` 的「给包写 `states.json`」一节）。

---

## 3. 槽位：代码（`stream.code` + `activate(ctx)`）

带代码的包**自己声明它贡献什么**，宿主只负责递上下文、收下结果。宿主不认识任何一个包的构造函数。

### 3.1 声明：`stream.code`

```json
"stream": {
  "id": "alist",
  "code": {
    "entry": "dist/index.js",
    "adapters": ["alist"],
    "normalizers": ["alist"]
  }
}
```

- `entry` —— 导出 `activate` 的模块（相对包根）。用户层只认字面量 `dist/index.js`（§6.4）；内置包也这么写
  （npm 上那份要它），但内置层装载不读它——`packages/index.ts` 的静态表直接指 `./<pkg>/activate.ts`（§3.3）。
- `adapters` / `normalizers` —— 这个包会注册的**名字全集**。
- `enrichers?: string[]` —— `GET /api/enrich?source=<名字>` 的名字全集；撞别的包、或撞宿主自己的
  `/api/enrich` 分支名都拒。
- `connect?: string[]` —— `POST /api/credentials/<域名>/connect` 的域名全集（大小写不敏感）；每个域**必须**
  同时出现在这个包的 `credentials` 里，两个包声明同一个域 → 装载期抛（同 §3.4 撞名规则）。

**名单为什么必须显式列出**：撞名要在**执行任何包代码之前**拒掉。`import` 一发生、`activate` 一被调用，包的代码就已经在本进程里跑了——那时再发现「这名字被别人占了」已经晚了，坏事已经做完。所以「谁能注册什么名」只能靠 `package.json` 里的**静态**名单判，不能靠「先跑一遍看它返回了什么」。名单与 `activate` 实际返回的键**必须一字不差**：两边的差集（多返回的、声明了却没返回的）都会抛错，declared-but-missing 同样是错——否则一个悄悄不再注册的名字会表现成「某个 source 突然解析不到 adapter」。

**包可以交出一个替代 builtin fn 的 Adapter。** 宿主的 `builtin` adapter 是一堆进程内函数的注册表
（`BuiltinFn(input, params, context)`）；一个包要把其中一格搬进自己家，交的是一个 **`Adapter`**
（`src/adapters/types.ts`：`id` / `init` / `fetch(params, manifest, context)`），manifest 的 `adapter`
写这个 adapter 名、不再写 `builtin`。**入参形状变了**：走 `resolveEngine.fetchSource` 这条路时，
订阅键由 `buildParams` 灌进 `manifest.key_param` 指定的那个参数，所以 adapter 读的是
`params[key_param]`（例：`key_param: input` ⇒ `params.input`），不是第一个位置参数。
范例：`packages/netease/lyrics.ts` + `packages/netease/manifests.yaml`。

### 3.2 契约：`activate(ctx)`

```ts
export const activate: ActivateFn = (ctx) => ({
  adapters: { alist: new AlistAdapter(ctx.config.url as string | undefined, ctx.config.token as string | undefined) },
  normalizers: { alist: alistNormalizer },
})
```

同步函数，返回 `{ adapters?, normalizers?, actions?, enrichers?, connect? }`，键就是注册名。normalizer 由装载器就地注册进全局 registry；adapter 实例**交还调用方**（bootstrap 拿它填 adapters Map，源按 manifest 的 `adapter` 字段路由到它——包的 resolve / fetch-url / 评论成员都骑同一个实例打容器，宿主不按名单取任何一个 adapter 自用）。`actions` 见 §3.4.5，`enrichers` / `connect` 见下。

#### `enrichers` / `connect`

- `enrichers: Record<name, (query, signal?) => Promise<unknown>>`——宿主把它露在**两个面**上：HTTP `GET /api/enrich?source=<name>&…` 命中时把整袋 query 交过来，返回值原样 JSON；WS 命令 `enrich.open { source, params }` 命中时把 `params` 交过来、结果拆成 `enrich.article / comments / completed` 分片推回（协议见 `docs/API.md`「包交出来的处理器」）。参数校验归包：不合法抛 `ValidationError`（`shared/package-sdk/errors.ts`，宿主按鸭子标记 `validation: true` 判，不 `instanceof`——见 §3.7）→ HTTP 400 / WS `enrich.failed`；`RecipeBlockedError`（限速 / 登录墙）→ WS `enrich.blocked`；其余异常 → 502 / `enrich.failed`。第二参 `signal` 是调用方放弃这次结果的取消信号（WS 面同 source 被新点击顶掉时触发；HTTP 面不带），不读它的 enricher 照样兼容。
- **`Content.enrich`——normalizer 告诉前端「这条打开时去哪现取剩下的」。** `Content` 上的可选字段 `enrich?: { source, params }`（`src/content/types.ts`）由包的 normalizer 在采集期写下；`source` 必须是本包 `code.enrichers` 里申报的名字（装载期不校验——normalizer 是纯函数，写错的表现是前端打开时 400 / `enrich.failed`，响亮不静默），`params` 全是字符串。前端 `enrichParamsFor(item)` **先看它**，有就原样拿去调；没有才走宿主自己那几条判据。带 `enrich` 的 item 缺省不会被自动预取（它多半要骑浏览器 tab 跑一次 recipe），只在用户真点开时经 WS `enrich.open` 现取；包可以在上面加 `prefetch: true` 自报「这次现取便宜：站外裸 HTTP、不骑标签页、不扣 facility 预算」（论坛回复那一类），前端据此放行滚动预取并走 HTTP 一问一答——这一格只有写 enricher 的包说得清，所以由它申报，前端不按站名猜。**包交出的 enricher 结果由宿主在装载处统一消毒**（`sanitizeEnricher`：`article.html` 与每条 `comments[].html`，含嵌套回复），HTTP 与 WS 两个出口吃同一份——前端对这两格是原样 `innerHTML`，它信的是宿主，不是包。范例：`packages/xhs/normalizer.ts` 写 `{ source: 'xhs-detail', params: { noteId, xsec_token } }`，`detail.ts` 的 enricher 经 `ctx.readSource` 跑同名 recipe。**同名不同物**：这里的 `Content.enrich` 是写在条目上的「打开时去哪现取」；Provider 调用点 id `content.enrich`（§0.5 `providers` 行的 `callsites`，贴链接抓媒体的派发点 `stream_fetch_url` / `GET /api/media/from-url`）是另一回事，两者只是拼法撞了。
- `connect: Record<domain, () => Promise<{ stream, extra? }>>`——`POST /api/credentials/<domain>/connect` 命中时调一次，宿主 `subscribe(stream)`，回 `{ ok:true, id, ...extra }`。键必须出现在 `credentials` 里。

**评论 enricher 有一份前端合同，其余名字自由。** 前端对带 `(provider, vid)` 的视频一律请求
`source=<facility>-comments&vid=…`（`app/src/lib/enrich.ts` 的 `enrichParamsFor`），翻页时把上一页回的
`cursor` 当 `page` 再发（`app/src/lib/preload.ts`）。所以一个视频平台包的评论 enricher**必须**叫
`<facility>-comments`，收 `vid`（+ 可选 `page`），返回 `Enrichment` 形状的
`{ comments: Comment[], total, cursor?: string | null }`（`src/content/types.ts`；`cursor` 是下一页的游标串——
页码或站方的数字 cursor 都行，前端只原样递回——**`null` 或缺省 = 没有下一页**，两种写法前端同等看待
（`packages/bilibili/` 给 `null`，`packages/Douyin_TikTok_Download_API/` 末页直接不带这个键），详情面板靠它决定
「加载更多」显不显示）。名字写错的表现不是报错而是**前端找不到**：
请求落进宿主自己的分支、回 `400 bad enrich request`。其他 enricher（UP 主、用户资料…）名字随意，
收的是整袋原始 query，返回值也原样发。

两样都在 `stream.code` 里申报（§3.1），名单与返回的键一字不差，撞名装载期硬拒（§3.4）。范例：`packages/bilibili/`。

`ctx`（`PluginContext`，`src/packages/activate.ts`）就七样，**这是包够到宿主的唯一的门**：

| 成员 | 是什么 |
|---|---|
| `backendUrl(service?)` | 这个包声明的 backend service 的可达地址。compose 档是容器 DNS、host 档是 loopback 随机口——两档差异归宿主的 resolver 管，包不该知道。没有 backend 的包拿到 `undefined`。 |
| `withAwake(service, fn)` | standby 唤醒：容器睡着了先叫醒再打。 |
| `cookieFor(domain)` | 该域的 Cookie 头。**只放行这个包 `credentials` 里申报过的域**，其余**抛错**（不是返回 `undefined`）——静默返回空会让包以为「这个域没登录态」而走降级路径，最终表现成一次莫名其妙的采集失败，真因（少写一行申报）离现场十万八千里。 |
| `login(facility)` | **把这个 facility 登回来**：宿主找到它那条 `meta.login` 的 recipe、在用户自己的 Chrome 里跑掉、跑完**去浏览器取一份新 cookie 再顶掉内存缓存**（两层，见 §3.4.6）。成功即返回，任何一档失败都抛（包括「这个 facility 没有登录 recipe」）。**调用点是「建立会话」那一步，不是整个动作外面**——宿主刻意不替包做「失败了整个重跑」，因为一个动作重跑一次安不安全只有包知道，而重跑一个已经下过一半单的动作就是重复下单。见 §3.4.6。 |
| `readSource(sourceId, params, { signal? })` | **运行这个包自己声明的一条源**（recipe / manifest），拿回归一化前的原始条目。裸名按包的 npm 名限定（`'x-detail'` → `<npm 名>/x-detail`，与 recipe `meta.uses` 同一条规矩，判据在 `src/packages/read-source.ts`）；带 `/` 的全名必须以本包前缀开头，否则**抛**——一个包不许借 `ctx` 去跑别人的 recipe，那等于绕开别家的 rateLimit 与账本。**不带 `userInitiated`**：包代码不是用户当场的点击，动作 recipe（`meta.action:true`）经这条路照常被闸住；用户点击触发的动作走 `POST /api/recipes/action`。有 `locate` 步的 recipe 不用传 `ordered`，运行时按 facility 从 feed 账本填（§2 Ledger）。 |
| `log(msg)` | 带包 id 前缀的日志。 |
| `readArticle(url)` | 一个公开网页的正文（宿主那一份 Defuddle 抽取，与 `/api/enrich?source=link` 同一个实现、同一份缓存），抽不出回 `null`。不带登录态，谁都可以用——**包里别再带第二份正文抽取器**。返回的 html 未必干净：包交出的 enricher 结果由宿主统一消毒（§3.2）。SDK 镜像 `ArticleContent`，双向守卫 `plugin-sdk-compat.test.ts`。 |
| `config` | 宿主解析好后按包分发的部署配置。**包不自己读 config.yaml / env / settings**——配置从哪来、怎么解析是宿主的事。 |

往 `ctx` 加一个字段 = 往「所有包能做什么」里加一条，加之前先问这条该不该给所有包。

### 3.3 内置包怎么被装载

`packages/index.ts` 里一张**静态 import 表**：

```ts
import { activate as alist } from './alist/activate.ts'

export const BUILTIN_ACTIVATIONS = new Map<string, ActivateFn>([
  ['alist', alist],
])
```

字面量 `import`——这样 esbuild 能把它们打进发行 bundle、tsc 也全覆盖。**加一个带 code 的内置包 = 这里加一行。** 声明了 `code` 却不在这张表里是**抛错**而不是跳过：漏进 import 表会表现成「某个 source 突然解析不到 adapter」，静默极难查。

装载分两段（`activatePackages`）：先把所有带 code 的包的名单**全量核对一遍**（撞名、已被占用的 normalizer 名、漏进 import 表），全过了才开始逐个调 `activate`。

### 3.4 撞名一律硬拒，不覆盖

adapter 名与 normalizer 名撞了——不管是两个包互撞，还是一个包撞上已注册的名字——**两个都不激活，直接抛错**。允许覆盖就等于让一个包静默换掉另一个包的实现，那是供应链攻击面。（同 npm 名的两层——代码、recipe、manifests、声明——整包按 `version` 高者只装一层，那是"同一个包的两个版本"，与两个不同的包撞名不是一回事，见 §0.5。）

### 3.4.5 动作：`activate()` 交出来的第三样东西

```ts
export const activate: ActivateFn = (ctx) => ({
  actions: {
    // 全局名 = `<包 id>:<键>`，如 `eastmoney:repo`
    repo: async (params) => await doIt(ctx, { live: params.trading === true }),
  },
})
```

一条**用户定时任务**可以把执行体指到这个名字上（`UserTaskRow.action`，与 `command` 二选一）。
契约在 `src/tasks/package-actions.ts`，权威设计见
`internal design record`。四条要点：

- **包提供动作，不提供排期。** 什么时候跑、跑不跑、用哪一格账号，全是用户任务行的事
  （住 db，界面上改，不用重启）。判据是 `src/tasks/task-store.ts` 的头注：运维任务留代码、
  **业务任务入库**。一个设施要宿主替它在 `configForPackage` 里写一行 `case`，就说明槽位
  没设计对。
- **参数来自那条任务绑的配置 row**（`configRef`），不来自 argv / env——`GET /api/tasks` 会把
  整行回显，值进了 argv 就是明文进任务列表和 `ps`。而且是**调用时才取**：用户改完那格，
  下一轮就该按新的来，存快照的表现是"改了没反应"且不报错。
- **动作够不到宿主内脏。** 签名里只有参数袋；其余靠 `activate(ctx)` 闭包的那个 `ctx`。
  要加新能力，往 `PluginContext` 加一格（并回答"该不该给所有包"），不是往签名里塞。
- **不用申报。** adapter / normalizer 要在 `stream.code` 里申报，是因为它们注册进全局命名空间，
  撞名必须早于执行就确认。动作名前缀是包 id，而带 code 槽位的包 id 全局独占——撞不了名。
  名字打错由写路由当场拒（`GET /api/tasks` 顺带回可选动作名）；运行时找不到则**抛**，
  不静默跳过。

**不要给任务加「危险 / 会花钱」这类申报。** `ScheduledTask` 上曾经有过一格 `effect`，已经删掉，
因为没有任何后端消费它——写错不报错，读的人却以为它管着什么。真金白银的护栏钉在动作自己的
实现里，而且要可执行：时间窗 cutoff、空跑一档、任何一笔失败就整条标红。"要不要真下单"
也不是标签，它是那条任务配置 row 里的一个字段（缺省 false——"忘了配"必须等于"不下单"）。

### 3.4.6 登录态掉了：包开口，宿主去登

需要登录态的包（走 `cookieFor`）迟早会撞上「会话过期」。**宿主提供机制，包决定在哪儿用它。**

一条 recipe 声明自己是某个 facility 的登录入口：

```jsonc
"meta": {
  "action": true,          // login 蕴含 action：登录会建会话、踢掉同账号在别处的登录
  "login": true            // ← 这一格
},
"session": { "facility": "eastmoney", … }   // ← 宿主按它索引
```

包在**建立会话**那一步接住过期，调 `ctx.login(facility)`，然后只重做建会话那一段：

```ts
const open = async () => await openSession(await ctx.cookieFor(DOMAIN))
try { return await open() }
catch (e) {
  if (!(e instanceof SessionExpired)) throw e
  await ctx.login('eastmoney')   // 宿主：找 recipe → 跑 → 刷新 cookie 快照
  return await open()            // 建会话没有副作用，重做是安全的
}
```

三条边界，各堵一个具体的洞：

- **重试只圈住没有副作用的那一段。** 宿主不替包做「动作失败了整个重跑」——那件事安不安全只有
  包知道。自动重跑一个已经下过一半单的动作，就是重复下单。
- **只重来一次。** 登回来了还是过期，说明问题不在会话（风控、站点维护），再登只是多敲一次
  登录接口，而「连续失败登录」在有些站那边是有后果的。
- **按 `meta.login` 找，不按「这个 facility 恰好只有一条动作 recipe」猜。** 判据要有名字：
  猜法在包多一条动作 recipe 的那天会静默改指向去登另一个账号，没有一处会报错。命中多条 →
  宿主抛，不挑一个。

宿主那一半在 `src/credentials/facility-login.ts`，接线在 `auth` 域（它 owns facility 登录态，
而且 packages 域 inject 不了 `sources`——`sources` 自己 inject 了 `packages`，是环）。

**跑完取 cookie 有两层，缺哪层都表现成「登录成功了但还是没登录」**，两层都真栽过：

1. **先去浏览器要一份**（`cookiePuller.pull`）。登录 recipe 跑完那一刻新 cookie 还只在浏览器里，
   本地快照要等扩展推过来才更新——只重读本地就是**自己读自己**。实测：任务 03:44:17 开始，
   cookie 文件 03:45:01 才落盘，中间那次重试拿到的是登录之前那一份。
2. **再顶掉内存缓存**（`cookieProvider.refresh`）。`CookieProvider` 另有 60 秒 TTL，
   盘上新了、内存里还是旧的。实测表现是「一分钟后自己好了」。

### 3.5 宿主四件为什么不走这条路

`src/bootstrap.ts` 的 adapters Map 里只剩 `builtin` / `rsshub` / `replay` / `browser`。它们的构造依赖 transport / ledger / sessionFetch / `ensureHarvestBrowser` 这些**宿主基础设施**——是宿主自己的东西，不是某个设施的适配器。它们继续手工织，**永不进公开面**（`ctx` 里也不会有这些句柄）。判据一句话：一个件如果需要 `ctx` 七样之外的东西才能造出来，它就不是包。

### 3.6 关掉包，它提供的实现一起消失

用户在「包」页**关掉一个视频平台的包**之后，它的 `*-resolve` source、`providers[]` 里那条 `<平台>-video` 行的成员、评论 enricher、connect 一并消失——manifest、实现、行声明全住在包里，宿主没有任何一处替它兜着。此时 `GET /api/media/play?platform=<平台>` 响亮回 `502 { error: 'unresolved' }`（没有行 serve 这个键，`detail` 不带），`/api/enrich?source=<平台>-comments` 回 `400 bad enrich request`。这是刻意的（"我把这个平台关了"），不是 bug；响亮报错也是刻意的——静默传一个 undefined 实现会让它在某次播放时才崩，离现场十万八千里。

### 3.7 包能 import 什么：类型、`shared/package-sdk`、`ctx`——就这三样

带代码的包会被 tsdown 打成一份**自包含**的 `dist/index.js`（§3.8），`activate.ts` 可达图里的每一条运行时 import
都会被**复制**进那份产物。复制纯函数无害；复制别的东西是静默故障，所以规则只有三条：

| 你要的 | 从哪拿 | 为什么 |
|---|---|---|
| **类型**（`Adapter` / `Normalizer` / `SourceManifest` / `Enricher` / `ConnectFn` / `Content` / `Media` / `VideoResolved`…） | `import type` 宿主 `src/`（`import type { Adapter } from '../../src/adapters/types.ts'`） | 编译期抹掉，dist 里没有它。**必须**是 `import type` 或花括号里每一项都带 `type`——混合写法 `{ ValidationError, type Enricher }` 算运行时 import |
| **纯函数 / 常量 / 错误类**：`ValidationError` / `ContentUnavailableError`、`mediaPlayUrl`、`toText` / `extractImages` / `stripImages` / `firstLink` / `extractLinks`、`BROWSER_UA`、`compareVersions` | `shared/package-sdk/`（`import { ValidationError } from '../../shared/package-sdk/index.ts'`；第三方作者从 `@streamapp/plugin-sdk` 拿同一批） | 宿主与包**同吃一份源码**，被 inline 进包的 bundle 无害。错误类带鸭子标记（`validation: true` / `unavailable: true`），宿主只看标记（`isValidationError` / `isUnavailable`）、从不 `instanceof`——所以 bundle 里那份副本抛出来照样被认成 400 / 404 |
| **宿主单例 / 有状态的东西**：容器地址、standby 唤醒、cookie、登录、跑本包的 recipe、日志、配置 | `ctx`（§3.2 那七样） | 单例复制一份就是第二张表：包登记进副本、宿主查的是原件，永远为空。分片信任表就是这一类——包**不**登记，只在 `DashResult` 上把 `headers` 交出来，`/api/media/dash` 路由拿到结果后自己 `rememberSegHosts`（见下） |

**除此之外的 `src/` 运行时 import 一律禁止**，守卫 `src/packages/self-contained.guard.test.ts` 从每个带 code 的包的
`activate.ts` 起沿相对 import 走一遍（`shared/` 也跟进去看），命中即红。要用宿主的某个函数：纯的就搬进 `shared/package-sdk/`
（宿主改成 import 那里），有状态的就往 `ctx` 加一格（先回答「该不该给所有包」）。

**`DashResult.headers`**（`src/video/dash.ts`）：包解析出 dash 流之后，取分片时要带的请求头（B 站是 `Referer` + `Cookie`）
写在这一格；**缺省 = 不带头**。路由把全部流 URL 连同这份 headers 登进分片信任表，分片代理按主机取头。CDN 按 Referer / Cookie
放行的站不填它，表现是 MPD 解析成功、每个分片 403——播放器一直转圈，日志里只有 CDN 的 403。

### 3.8 构建与发布

内置层**以源码装载**（§3.3 的静态表），npm 上那份是**预编译产物**——同一个包两种装载形态，包代码不感知。

**构建**：每个带 code 的包一份 `tsdown.config.ts`（裸对象，不 `import 'tsdown'`——包目录没有 node_modules，
这份文件又在根 tsconfig 的 include 里）：

```ts
export default {
  entry: { index: 'activate.ts' },   // 键名就是产物名；写成数组会出 dist/activate.js，装载器找不到
  format: 'esm',
  outDir: 'dist',
  dts: false,                         // 没有消费者：产物只被后端运行时动态 import
  noExternal: [/.*/],                 // shared/** 全部 inline；切了 chunk 让它在构建期就失败
  clean: true,                        // 上一代产物会随 files: ["dist"] 进 tarball
}
```

- **`pnpm packages:bundle`**（根脚本 `scripts/bundle-code-packages.mjs`）：对 `packages/*` 里每个填了 `stream.code` 的包，
  以包目录为 cwd 调根 `node_modules/.bin/tsdown -c tsdown.config.ts`，任一包非 0 或 `dist/index.js` 不在 / 为空就整体失败。
  传目录参数只构建那几个（包自己的 `pnpm bundle` 就是传 `.`）。判据是 `stream.code` 在不在，不是手写清单——
  漏一个的表现是那个包发上 npm 后 `code.entry` 指着一个不存在的文件。
- **`STREAM_TSDOWN_BIN=<路径>`**：借一份别处的 tsdown（worktree 里根依赖没刷新时借主检出的）。两处都没有就带着安装提示
  退出 1，不静默跳过。
- `dist/` 在 `.gitignore`；`packages/index.ts` 不读它。

带容器的内置包（alist / pansou / 抖音解析）今天不发 npm：第三方容器钳制（service 由宿主指派、必须写 mem、id 文法）
与「用户层同名容器包该顶掉还是并存」都还没有设计，它们保持 `private`，构建链照样出 dist 备着。

**`package.json` 的出货形状**（4 个可发包同一份）：

```json
"files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
"scripts": {
  "bundle": "node ../../scripts/bundle-code-packages.mjs .",
  "prepack": "node ../../scripts/assert-npm-artifact.mjs"
},
"stream": { "code": { "entry": "dist/index.js", … } }
```

不写 `private`（要发 npm）；不写 `repository` / `homepage`（仓库私有，对外是死链，闸会拒）；README 里不许有指向仓库
`docs/` 的相对路径（同理）。`manifests.yaml` / `README.md` 缺席不算错——只做动作的包本来没有 Source 清单。

**`prepack` 闸**（`scripts/assert-npm-artifact.mjs`，`npm publish` / `npm pack` 必跑）：`stream.code.entry` 在盘上且非空；
`dist/` 里**只有**它（切出的 chunk、sourcemap、上一代残留都拒——用户层安装门只认 `dist/index.js` 一个文件，多一个就整包拒装）；
`npm pack --dry-run` 清单逐条过安装门白名单（借 `scripts/recipe-release-plan.ts --check`，判据就是安装门那一个函数
`isAllowedPackageFile`，不另抄）。挂在 `prepack` 而不是只写在 workflow 里，是让绕过 workflow 手发的人也被拦。

**发布**（CI `release-recipes.yml`，`scripts/recipe-release-plan.ts --publish`）：可发 = 有 `name`、不 `private`、
填了 recipe 槽位**或**代码槽位。对每个可发的包查 `npm view <name> versions`：**npm 上已有该名**（任意版本；只有明确
E404 才算没有，断网 / 限流 / 鉴权错让流水线红）**且本版本未发** → 带 code 的先 bundle 再过 `assert-npm-artifact.mjs`，
然后核白名单、`npm publish --access public`。**不在 npm 上的包 CI 不代劳**——首发是人为动作（哪些包公开是生意上的
决定），判定时打一行「首发请人工：`cd packages/<x> && pnpm bundle && npm publish --access public`」。首发一次之后 CI
接手后续版本：改了代码或 recipe → bump `version` → 合 `main` → 发。

**同名两层**：用户 `stream add @streamapp/<x>` 装到比内置更高的版本 → 用户层整包为准（代码 / manifests / recipe /
声明），内置那份整包跳过（日志 `supersedes builtin`）；相等或更低 → 内置为准、用户层整包跳过。尺子与日志见 §0.5。

---

## 4. 槽位：容器（`stream.backend`）

一个声明了 `backend` 的包，它的后端容器由 Stream **托管**：用设施**自己发布的镜像**（Stream **永不**重新打包）。例：Douyin_TikTok_Download_API → `douyin-tiktok-download-api`。所有容器都在共享网络 `stream` 上，通过**同网络 DNS** 互相访问（`http://<service>:<port>`），无需向宿主机发布端口。

`PluginBackend` 的字段全貌见「附：当前形状速查」；怎么把容器**起来**见 §7。

> ⚠️ **后端容器只能通过生成的 compose 或宿主接管拉起**（§7）。**禁止**为插件后端手写 `docker run` / `docker build`——后端在 `packages/<id>/package.json` 的 `stream.backend` 里**声明**，由生成的 compose 统一接 `stream` 网络 + healthcheck + 卷与内存上限。手搓 docker 命令绕过这一切，是错的。

**只声明容器、不带 Source 也不带凭证的包不住内置层**（§5.9.6）：它们是可选包，源码与清单在
`github.com/JaggerH/stream-packages`（一目录 = 一个 Dockerfile + 一份 `package.json#stream.backend`，
tag `<name>-v<版本>` 同时锁定 ghcr 镜像与 npm 清单）。今天有四个：`@streamapp/ddddocr`（验证码识别，给
recipe 的 `call` 步骤用）、`@streamapp/dewatermark`（生图去水印）、`@streamapp/mineru`（文档解析，GPU）、
`@streamapp/voiceprint`（说话人分离，仅 GPU）。用户
`stream add @streamapp/<x>`，容器只在 `manage_containers: true` 时由宿主接管建出来（§7.2），GPU 包要
nvidia container toolkit。stream 侧只留消费方，且每个消费方都得有包缺席时的具名退路：`ocr-mineru`
梯子成员不亮、声纹归名退匿名段（`identify_speakers` 不注册）、生图带水印且解不出 dewatermark 地址
→ 请求 503 并提示 `stream add @streamapp/dewatermark`（不静默返回带水印的图——那会被当成品用掉）、
recipe `call` 步骤点名的 `service` 解析不到 → 该步硬失败（`call-service.ts`，本来就是这条语义）。

### 4.1 不变量：容器是一次性的，要保的状态必须声明成 `volumes`

**声明了 `backend` 的包，凡是要跨重启保留的东西都必须写进 `backend.volumes`（`name:/容器内绝对路径`）。宿主在镜像与声明不一致时会直接删掉容器按新声明重建，容器可写层里的一切都会没。** 卷不受影响——删容器走的是不带 `v` 的 remove，命名卷原样留在宿主上，重建后按同名挂回去。

判断标准是"这份数据在容器里活了多久"，不是"它看起来重不重要"：设施自己写在镜像默认路径下的配置库、下载好的模型权重、生成的索引缓存——只要不想让用户在一次包升级后重新配一遍、重新下一遍，就得有一个卷。只读的仓库文件用宿主 bind 挂载（内置包才可以；第三方包的宿主 bind 会被安装期钳制拒掉，见 §6）。

内置包的现状可以照抄：alist 的配置在 `alist-data:/opt/openlist/data`，douyin / pansou 无状态；可选包里 ddddocr / dewatermark 无状态，mineru / voiceprint 的模型缓存各有自己的卷（用户层的卷名带包前缀，如 `mineru_mineru-cache`，见 §6.2）。

**新建的命名卷是 root 属主。** 镜像若以非 root 跑、入口只查数据目录能不能写而不 chown（OpenList 以 UID 1001 跑就是这样），在全新的卷上容器会秒退，日志只有一行 `does not have write ... permissions for the ./data directory`。这类镜像在 `backend` 里声明 `user: "0:0"`（`uid` 或 `uid:gid` 数字形），compose 生成器与宿主接管两条路同样透传，容器以 root 起。这一格**只给内置包**，第三方声明一律拒（§6.2）。

### 4.2 能力型后端（capability backend）与分片 Job 骨架

一部分插件后端不是内容源，而是 **Provider 能力**——ASR / diarization（说话人分离）/ embedding /
docparse 这类模型服务（如 `voiceprint`=sherpa-onnx）。这类后端有一条
额外的**硬不变量**：

> **容器端点必须秒级、无状态、可重放**——单次请求的计算量以秒计（不长算）；响应体是结果的**唯一**
> 出口，容器自己不落盘、不存中间结果（不存结果）；同一输入可以放心重发（可重放）。

**为什么**：undici 的默认 `headersTimeout` 是 300s 天花板，而容器必须算完才发响应头，长计算会撞穿它；
容器又不该有持久状态——standby 随手停一个空闲容器是这套系统的前提，容器一旦有状态，停掉就等于
丢结果，"随手停"就不再安全。所以一次请求的结果只活在这一次 TCP 响应的瞬间，容器本身必须是可以
随时重启、随时重放的纯计算单元。

**长活谁来切、装配谁来做**——分工在**后端（Stream 侧）**，不在容器：

- **planner**：把一份长输入切成若干可在秒级内算完的片（时间窗、页码、重叠量按能力自定）。
  例：`src/media/audio-windows.ts` 的 `planAudioWindows`，把音频抽轨切成 120s 窗（10s 重叠）。
  同文件的 `planSttChunks` 是它的姊妹 planner，服务云端 STT 成员（Groq/OpenAI Whisper，走 API 非容器）：
  压成 32kbps m4a，≤24MB 单块直传、否则切 600s **无重叠**块（重叠会在接缝处重复转写文本），
  装配即按 `startS` 平移时间轴拼接（见 `internal design record`）。
- **逐片短调用**：对每一片各打一次容器端点（如 `/diarize`），容器只看见这一片。
- **assembler**：把各片的结果装配回一份整体结果（跨片去重/合并/拼接，语义由能力自定）。
  例：`src/voiceprint/windowed.ts` 的 `mergeWindows`，把各窗独立识别出的局部说话人用全局
  平均连接凝聚（无窗序，锚点参与聚类、碎片就近归附）并成全局说话人、按重叠区中点去重。
- **账本**：`CapabilityJobStore`（`src/jobs/store.ts`）挂在 `ConversionRunner`
  （`src/conversions/runner.ts`）上——转换类能力（OCR/转写/补说话人/摘要）共用它这一份，
  管排队/断点续跑（重启后从已完成片继续，不是找回结果——容器无状态，恢复形态只能是"重跑"）/
  回收（done 即删、error 行留 7 天、启动时**超过 24h** 的孤儿标 error，24h 内的孤儿走断点续跑
  而不是直接标 error）。每次转换的片文件写在 runner 供出的 `ctx.jobDir` 下。

**worked example：voiceprint**（可选包，容器源码在 `stream-packages/voiceprint/app.py`）——它的 `/diarize` 是单窗纯函数，
一次只诊断一段音频；超过 `VOICEPRINT_MAX_SINGLE_S`（默认 300s）直接拒绝（413），把"这段太长"的
判断权交还调用方，而不是在容器里硬扛到 OOM。跨窗切分（planner）与跨窗说话人合并（assembler）都
在 TS 侧，容器本身不知道、也不需要知道自己是不是被分窗调用的一部分。设计全文见
`internal design record`。

---

## 5. 槽位：凭证域（`stream.credentials`）

### 5.1 方向只有一个：宿主派发，包不索取

**宿主是唯一调度方。** 包不发起调用——是宿主在处理一次请求时决定去问谁要什么，然后把**这一次
需要的那一份**递给包。adapter 就是那层兼容：它跑在宿主进程里，凭证由宿主注入，它再随请求把
必要的部分递给自己的容器。

```
用户/调度器 → 宿主 → (取 cookie) → adapter(进程内) → 插件容器
                                      ↑ 宿主注入          ↑ 随请求递下去
```

**申报（`stream.credentials`）是一张许可名单，不是一条取数路径。** 它回答的是「宿主可以把哪些
域的登录态交给这个包」，闸门在 `src/packages/activate.ts` 的 `makeCookieFor`——`ctx.cookieFor`
只放行申报过的域，其余当场抛错（静默返 undefined 会让包去走降级路径，最终表现成一次莫名其妙的
采集失败，而真正的原因离现场十万八千里）。域名比较大小写不敏感。

**许可名单不是需求名单——两处都要写。** `credentials` 只说「宿主**可以**把这个域给我」；
「**去用户浏览器把这个域取回来**」是另一格：**manifest / recipe 的 `auth`**（`requiredCookieDomains`
只从它和 `config.session_exports` 两处推那份下发给扩展的同步域名单，见 §5.2）。只写
`credentials` 的包，`ctx.cookieFor` 的闸会放行，但快照里根本没有那个域的 cookie——**表现和
"用户没登录"一字不差，没有一处会喊**。东财栽过这一刀（2026-09-03，`3efad7a1`）：登录域全靠
`config.yaml` 里一块给别的东西用的旧配置意外顶着。recipe 那侧怎么写见
`.claude/skills/write-recipe/references/recipe-template.md` §「`auth` 不是装饰」。

`auth: cookie` 是**硬**的：解析不到就抛可执行错误（响亮、按 stream 隔离），不静默降级成空 feed；
没有"可选 cookie"类型——静默返空正是它最坑的失败模式。

> **别引入「包向宿主要凭证」的路**——形状是一个 credential broker：`GET /api/credential`，
> 容器带着自己那份 `STREAM_CREDENTIAL_TOKEN` 反过来敲门。
>
> **方向反了**：它凭空造出一个常驻在容器环境变量里的长期密钥，而它换不来任何宿主本来做不到的
> 事——宿主本来就知道这次调用需要哪个域的登录态。代价则是实打实的：那把密钥要写进生成的
> `docker-compose.yml`，而那个文件会被人 `cat`、会被误提交（那份 compose 真被 git 跟踪过）。
>
> 唯一看起来需要它的场景是「只有容器、不带代码的第三方包」——宿主泛化转发时不知道它的 API 形状，
> 塞不进 cookie。**这个场景按产品口径不存在**：接进来的东西一律配一层 adapter，那正是 adapter
> 存在的意义。

**`credentials` 只能写具体站点域名**（`douyin.com`、`pan.quark.cn`）。单标签（`cn`）和公共后缀
（`com.cn`、`co.uk`）会被描述符校验拒掉、包直接装不上——因为 cookie 是**后缀匹配**取的，申报一个
后缀 = 申报它下面所有站点的登录态，等于把申报名单这道边界掏空。

**生成的 compose 里一个凭证都没有**（`src/plugins/cli.test.ts` 与 `src/plugins/compose.test.ts`
各有一条守卫钉着）。容器 env 只放非 secret 配置。

cookie 本身由 `CookieProvider.cookieString(domain)` 取（按域后缀匹配拼 `name=value` header），
只在宿主进程内被调用。**它背后是谁由 §5.2 决定，取的人不需要知道。**

### 5.2 登录态从哪儿来

**默认：后端自己去用户的 Chrome 里取，零容器。** 后端在中继上发 `op:'cookiePull'`，扩展把
那些域的 cookie 回过来，后端整份写进 `data/cookies.json`（0600）。这条路上没有任何第三方进程
——扩展和后端本来就在直接说话（ext-relay 有 token、拟人采集全程走它），cookie 没有理由绕路。

**为什么是后端去取，而不是扩展定时推**：只有后端知道什么时候要用登录态——这一轮要采集了、
手里那份多旧、刚刚是不是吃了个 401。扩展一样都不知道，所以它只能按时间猜，而猜的代价是
**cookie 轮换之后干等一整个周期**（夸克 `__puus` 过期 → 期间每次取流都 412）。取数的调度权
必须在知道"什么时候要用"的那一端。

- **三个取的时机**（接线在 `bootstrap.ts`，实现是 `src/credentials/cookie-puller.ts`）：
  中继一连上（Chrome 刚起来，快照最旧）／每轮采集动手前发现快照超过 5 分钟／扩展报
  「同步域里的 cookie 变了」。**没有周期闹钟**——别加一个，理由见上。
- **范围闸在扩展那边，不在后端**：扩展只应答它自己申报过的同步域（用户填的 ∪ 后端下发的
  `requiredDomains`），范围外的原样退回 `refused`。请求方自己定范围等于没有范围。
  拿到 `refused` 非空要当配置问题喊出来——它的表现和"用户没登录"一模一样。
- **永远取全量，不取"变了的那几个"**：因为写入口是**整份替换**。只写变的那几个就得改成按域
  合并，而合并会让用户退登过的域以僵尸形式永远留在快照里。
- **不加密**。后端就是消费端、采集时本来就拿明文 cookie 发请求，自己解自己的密只是把密钥和
  密文放进同一个目录。用文件权限管（0600）。**别把加密加回来。**
- **快照必须存着**：Chrome 关着的时候取不到（读它的 cookie 文件是死路——App-Bound Encryption
  加独占锁），而采集是定时跑的，半夜那一轮多半没有浏览器。所以拉失败**绝不清空快照**：
  旧的登录态再旧也比没有强，清空会把一次抖动放大成全站游客态。
- 扩展该同步哪些域，由后端下发（`GET /api/ext/sync-config` 的 `requiredDomains`，从**装着的
  东西**推，见 §5.1）。这一口**不下发任何密钥**，也不许有——它一旦带上钥匙，任何拿得到这个
  地址的人就拿到了整个 cookie 库。

**登录态只有这一个来源。** 消费侧永远是同一个接缝 `CookieProvider.cookieString(domain)`，
所以真要换来源，对消费侧无感。

> **别引入「指一台第三方服务器去拉 cookie」那种形状**（更别把它做成生成 compose 里的容器）。
> 那台机器会成为采集链路上唯一"没它就全站游客态"的依赖——而插件容器（pansou / mineru / 声纹）
> 都只是可选能力，没有只是少几个源。它不通的表现是最坏的那种：取 cookie 静默失败、全程游客态、
> 一切看着正常。

### 5.3 打包出去的 facility 能力：可选能力包，网盘是范例

**能力包也是 Stream 包**——它填的是能力槽位（`package.json#stream.capability`）。区别只在
「这件能力是随发行版出货，还是用户按需装」：

| | 内置能力 | 可选能力包 |
|---|---|---|
| 住哪 | `capabilities/desktop/`（Stream Desktop，`private: true`，随后端 bundle 出货） | 本仓库 `capabilities/netdisk/`（npm `@streamapp/netdisk`）或独立发布的兼容能力包；装到 `<dataDir>/recipes/<@scope__name>/` |
| 谁装载 | 后端静态 import，`src/host-agent/mount.ts` 交给宿主 | 后端扫 `<dataDir>/recipes/`、动态 import `dist/index.js`（`src/capabilities/load.ts`） |
| 装法 | 装 `@streamapp/stream` 就有 | `stream add @streamapp/<x>`，或组件页里点装；`stream remove` 卸载 |
| 工具从哪出 | 都是 8900 的 `/api/mcp`——宿主那一行（`stream mcp`）永远不用改 | 同左 |
| 何时生效 | 随后端起来 | **后端重载后**（安装那一刻只落盘） |

**能力槽位本身的契约在 §5.9**（声明形状、自包含要求、宿主七格、撞名硬拒、挂载顺序、
内置/可选的判据）。本节只讲**一件 facility 能力要打包出去时的四条边界**。

认盘（验分享 / 转存 / 取直链 / 跳转网盘）是能力包的范例（`capabilities/netdisk/`，spec
`internal design record`）。要把别的 facility 能力
也打出去，照它的四条边界：

| 边界 | 网盘包的做法 |
|---|---|
| **逻辑只有一份** | 判决与取数住 `shared/netdisk/`；Stream 编排层与能力包都 import 同一份，包构建时全部 inline 进 `dist/index.js`（装到的目录里没有 node_modules，任何外部 import 都解不开）。别在包里复刻一份，会静默漂移。 |
| **凭证仍是宿主派发**（§5.1 不变） | 在 `package.json#stream.credentials` 申报要借哪几个域（过安装门校验、确认页逐域点名），取数时 `ctx.require('streamBrowserCookies')` **每次现取**——后端在同一个进程里挂着那份服务，cookie 不落盘、不出进程。服务不在时要登录态的动词回「失败 + 指路」，不是静默空结果。 |
| **两档由配置决定，不由运行时猜** | 给 `openlistUrl` + 永久 `openlistToken` = external 档（Stream 在场：用户从 `GET /api/netdisk/openlist-access` 拿到 `<origin>/_p/alist` 与永久 token，写进自己的配置），只读 / 转存 / 播放，不碰 storage admin；没给 = managed 档（包经 `shared/docker/engine-api.ts` 自己拉容器、接管 admin、挂载、空闲回收）。48h JWT 形状的 token 直接拒——包没有 401 重登通道。 |
| **同机撞上宿主时让位，判据是证据** | managed 档每次调用都先看本机有没有 `com.docker.compose.service=alist` 的容器（Stream 在管），有就不建第二份、理由点名那个容器并指路 external 档。自己的容器另打标签 `netdisk-openlist`、另起卷——standby 会 adopt 任何 `alist` 标签的容器，撞了标签就是两个大脑抢一个容器。 |
| **写操作是审过的代码** | 转存（写用户的盘）是 `shared/netdisk/quark/save.ts`，随版本发布；recipe 那两条验活在包里是同判决的 TS 版（recipe 运行时依赖 isolated-vm，打不进能力包）。 |

「让模型直接翻盘」不由能力包写工具：OpenList 自带只读 MCP（`/mcp`，`fs.list/get/link`），一行
`dsh-mcp-client` 指过去即可（握手要三步：`initialize` → `notifications/initialized` → `tools/list`，漏了中间那条
`tools/list` 静默回 `null`；`Authorization` 裸放永久 token，无 `Bearer`）。

---

## 5.9 槽位：能力（`stream.capability`）

一格能力 = **一件手上的能力**（电脑操作、认盘等）：它给模型交出几个动词，而不是给
Stream 交出一个数据源。填了这一格的包由后端在**自己的进程里**挂上，它注册的工具从 8900 的
`/api/mcp` 出去，和后端自己的工具走同一个口。

### 5.9.1 声明

```jsonc
// package.json
{
  "name": "@streamapp/netdisk",
  "stream": {
    "id": "netdisk",                    // 必填：包 id，两层命名空间里唯一
    "capability": "dist/index.js",      // 导出 `capability: Capability`
    "credentials": ["quark.cn"]         // 要借哪几个域的登录态（可选，§5.1）
  }
}
```

- **值只认字面量 `dist/index.js`**（`src/packages/code-entry.ts` 的 `PACKAGE_CODE_ENTRY`，与
  `stream.code` 同一个常量，schema 是 `z.literal`）。`./dist/index.js` 这类别名写法一律拒——
  放行别名等于放行一族路径。
- **`stream.id` 必填**，与别的包一样。只写 `capability` 不写 `id` 的包**永远装不进去**：
  安装门解析描述符时就抛 `stream.id — required`，而包自己的测试、`npm pack`、产物断言三处
  全绿——它们只问"文件在不在"，没有一处去解那份清单（真栽过，2026-09-06）。仓库里那两个包的
  `package.json` 由 `src/capabilities/optional-package.e2e.test.ts` 直接过一遍
  `parseStreamDescriptor` 钉着。
- **凭证域只在 `stream.credentials` 申报**，不在模块上。那一格过安装门（schema 校验 + 确认页
  **逐域点名**让用户批准），模块级属性是装完之后才读得到的——放模块上等于「用户批准的名单」
  和「实际拿去同步的名单」分成两份，而两份漂移了没有任何一处会喊。已挂能力申报的域经
  `host.credentialDomains()` 并进 `requiredCookieDomains`（第三个来源），扩展才会去读它。

### 5.9.2 必须自包含

装到 `<dataDir>/recipes/<@scope__name>/` 的目录里**没有 `node_modules`**，安装门的 tarball
白名单只受理 `package.json`、`README`/`LICENSE`/`NOTICE`/`CHANGELOG`、`manifests.yaml`、
`*.recipe.json`，外加 `dist/index.js` 这**一个**含 `/` 的路径；其余一律拒。所以依赖必须全部
打进那个文件（tsdown `noExternal: [/.*/]`），只留 `node:` 内置。

`import` 一个没被打进来的库 = 装载期 `ERR_MODULE_NOT_FOUND`，这个包**这次就是不生效**，而
Stream 其余部分照常起来。**冒烟要跑产物不跑源码**（`capabilities/netdisk/scripts/smoke-managed.mjs`
就是这么写的）：跑源码验不到"打漏了一个相对 import"，而那正是这条约束最该抓的。

### 5.9.3 宿主七格：后端怎么实现它们

契约是 `shared/capability/types.ts` 的 `CapabilityContext`；**唯一那份宿主实现**是
`src/capabilities/host.ts` 的 `createCapabilityHost`。内置的 Stream Desktop 与用户装进来的可选
包走的是**同一个** `mount()`——区别只在「模块怎么到场」。

| 格 | 后端实现 |
|---|---|
| `dataDir` | `<dataDir>/capabilities/<能力名>/`，**读到才 `mkdir`**（惰性 getter）。多数能力从不落盘，而 `mkdir` 会因为权限/只读挂载失败——急着建目录就是让一个用不到的副作用去否决整个能力的挂载 |
| `log` | `info` / `warn` 两条，前缀 `[stream-<能力名>]`（内置那件是 `[stream-desktop]`）。日志出口缺省是后端的 stdout |
| `require(service)` | 进程内一张 `Map`，取不到给 `undefined`（包自己降级并 `log.warn`，不是抛） |
| `provide(service, value)` | 同一张 `Map`，**同名硬拒**。服务总线上一个名字只能有一个主人；静默覆盖会让先到那个包的消费者拿到一份它不认识的东西，两边单看都正常。今天唯一的一对：后端 `provide('streamBrowserCookies')`、netdisk `require` 它 |
| `registerTools(defs)` | 进 host 的工具表，`toolDefs()` 每次现取地喂给每一个 `createMcpServer()`（`/api/mcp` 是**每请求一个 server**，所以挂载一次、注册每次）。**撞名硬拒**，见下 |
| `destructiveGate` | 恒为 `'host'`：`annotations.destructiveHint` 原样透给 MCP，由宿主（Claude Code / Codex / DSH）自己弹确认。包读到 `'none'` 时要 fail closed，别自己放行 |
| `onDispose(fn)` | 收进一张表，后端关停时**逆 mount 顺序**执行，逐个吞错记一行；整份 host 收摊时服务总线一并 `clear()` |

### 5.9.4 撞名硬拒、挂载顺序、失败语义

- **工具名撞名硬拒**，在进表**之前**查两张名单（已收的 defs + 后端自己的工具名，后者是
  thunk 不是快照——工具面按域的可用性现算）。不是"覆盖 + 记一行"：用户能 `stream add` 任意包，
  一个第三方包起个 `extract` 就能把后端的动词顶掉，而模型只会觉得这个工具忽然变笨了。
- **挂载顺序：内置的 Stream Desktop 先、可选包后。** 硬拒之下**顺序直接决定谁被拒**——反过来的话，
  用户装一个起名 `desktop` 的包就能把机器上的 Stream Desktop 顶掉。
- **一个包 mount 抛错只记一行、接着装下一个**，不拖死别的包、不拖死后端；它抛错前已经注册的
  工具 / 服务 / 收摊函数**一并回滚**（否则工具面上挂着一个没装成的包的动词，调用必然炸，而
  没有一处会说这个包没装上）。兜底在装载器（`src/capabilities/load.ts`）那一层，不在 host 里
  ——host 照常把错抛出来，好让"装上了"和"装的时候炸了"分得开。
- **`import` 与 `mount` 各有一道 30s 超时**。到点只保证"装载器不再等它"（ESM import 和包自己
  的 mount 都停不掉），走同一条逐包 try/catch。

### 5.9.5 装法与生效时机

```bash
stream add @streamapp/netdisk        # = preview + install，走安装门；组件页里点装是同一条路
stream remove @streamapp/netdisk
```

**装完不热装，重启后端才生效**——安装那一刻只落盘。`loadOptionalCapabilities` 只在启动路径上
跑一次，而已经 `import` 进来的 ESM 模块运行中也卸不掉。安装/卸载的回执把这句话说出来，
**不许静默不生效**——装是「源立刻生效；能力包（工具）要等后端重载后才出现」，卸是「重启后端后
才真正卸掉——已装载的工具与凭证域申报在重启前仍在」。两句都由 `src/install/add-command.test.ts`
钉着文案；改一句就得改另一处，别只改一边。

装载结果在**组件页**看得见：`GET /api/packages` 每一行多两格——`slots.capability`（入口路径，
包目录就有答案）与 `slots.tools`（这个包此刻注册了哪些动词，运行期现取）。声明了能力却
`tools: []` 是一句真话，意思是装载没成或它没注册工具。

### 5.9.6 什么内置、什么可选

**判据一句话：这件能力是不是「装了 Stream 的人默认就该有」。**

- **内置**（随 `@streamapp/stream` 出货）：纯 recipe 数据包（几 KB 的 JSON，不订阅零代价）+
  核心壳（builtin / replay / rsshub）+ **Stream Desktop**（电脑操作，今天唯一那件内置能力）。
- **可选**（`stream add`，独立发 npm）：凡**带代码、带容器、绑第三方服务、或收费**的。

**东方财富属于收费的 VIP 系列，绝不进内置包。** 它是第一个必须搬出去的：搬的时候注意开发机上
8900 挂着它的申购 / 逆回购定时任务，**先在用户层装上、再从内置层摘**。收费分发的机制见
`project planning record`。

**只声明容器的包（ddddocr / dewatermark / mineru / voiceprint）已经在可选层**：
住 `github.com/JaggerH/stream-packages`，`stream add @streamapp/<x>` 装（§4 开头）。安装门不钳 `gpu` 与 `mem`
的大小（§6.2），GPU 容器包装得进来。

按这条规则今天还该搬出去的是 3 个容器包（alist / 抖音解析 / pansou）与东方财富——它们
带 Source 清单或代码，不是纯容器声明；**等第一个真要拆的时候一起搬**（容器包不起就不占资源）。
迁入 stream-packages 的触发条件见 `project planning record`。

---

## 6. 分发与装载：内置包 vs 从 npm 装进来的第三方包

内置包（仓库 `packages/`、随应用一起发布）与第三方包（用户在 UI 里从 npm 装进来、落在 `<dataDir>/recipes/<包名>/`）**是同一种包、同一份 `package.json#stream` 文法**。差别只在两处：**能填哪几格**，以及**安装期要过哪几道闸门**。

**装一个带代码的包 = 信任作者**：代码在后端进程内跑（与 Stream 同权限），同 npm 名的更高版本会**替换内置那份的代码**——这与装一个纯 recipe 包不是同一档权限，安装页按 §6.6 把它评成最高档 `code`。

### 6.1 能填哪几格

| 格 | 内置包 | 第三方包 |
|---|---|---|
| 清单（`manifests.yaml` / `stream.sources`） | ✅ | ✅ |
| recipe 数据（`*.recipe.json`） | ✅ | ✅ |
| 代码（`stream.code`） | ✅ | ✅，但入口路径被钉死（见 §6.4） |
| 能力（`stream.capability`） | ✅（今天只有 `capabilities/desktop/`，静态编进 bundle） | ✅，同一个被钉死的入口路径（见 §5.9） |
| 容器后端（`stream.backend`） | ✅ 原样声明 | ✅，但整份声明先过钳制（见 §6.2） |

### 6.2 容器格：第三方能声明什么、会被钳成什么

第三方的 `backend` 一律先过 `src/packages/container-policy.ts`（`clampThirdPartyBackend`）：不合规**安装期抛错**（不留到运行时），合规的**改写成安全形态**再落盘。**落盘的 `package.json` 存的是钳制后的声明**——用户在确认页看到的、provisioner 建容器时读到的、盘上躺着的，是同一份字节。内置包不走这条（我们自己写的，原样声明）。

**`gpu` 与 `mem` 的大小不钳、不按作者分档**：装一个包本来就是信任作者（同 dsh 插件的立场），要显卡、
要 10G 内存是包对自己镜像的诚实声明，钳它们挡不住任何人，只会把正经的 GPU 包挡在门外。`mem` 仍**必须
写**（不写 = 不限制，那是漏写不是选择）。确认页把 `gpu` 亮出来（`summarizeBackend`），"没装 nvidia toolkit
就起不来"是包 README 该写的前提。钳的只剩宿主命名空间与文件系统边界：拒 `service` / `dev` / `user` /
`publish`，env 与 volumes 上限，standby 兜底，卷名加前缀。

**`image` 必须钉版本（tag 或 digest，不收 `:latest` / 无 tag）**——这是更新机制的前提，不是信任问题：
宿主接管只比容器的 `Config.Image` 字符串，`stream update` 换清单 = 换 tag → 判成不一致 → 下次启动删了重建
（`provisioner.ts` `recreateOnImageMismatch`）。浮动 tag 的清单更新后字符串没变，容器永远跑装机那天拉到的
那一层。所以**镜像版本随包版本一起发**：stream-packages 打 tag `<dir>-v1.2.0` 同时出镜像 `:1.2.0` 与
`image: …:1.2.0` 的清单。`stream update` 装完会提示「重启后端后按新镜像重建」。

**宿主替包决定的三格**：

- **`service` 名由宿主指派，恒等于包 id**（包自己写 `service` = 拒；包 id 另有文法约束，见下表）。service 名是全局单一命名空间，三处共用——`/_p/<service>` 网关路由、standby 名册、compose service key；包 id 在安装期已保证不撞，所以 id 唯一 ⇒ service 名唯一 ⇒ 三处天然无冲突。**对外形状**：容器就在 `/_p/<service>/`。名册重名在构造期抛，但 `serve.ts` 的 `buildStandbyOrDegrade` 把它降级成一行日志——后果不是开不了机，是**全体 standby 失效**（所有插件容器不回收、不唤醒，界面上一个字不提），所以承重的是安装期那道撞名闸门。
- **命名卷加包前缀**：包写 `data:/var/lib/x`，实际挂 `<包 id>_data`。不加前缀的话两个包各自写 `data:` 就是同一个 docker 卷，A 能读写 B 的数据。
- **`standby` 缺省兜 30 分钟闲置回收**（`DEFAULT_STANDBY_IDLE_MINUTES`）。兜底而不是拒：常驻是资源治理问题、不是安全边界，而 standby 唤醒对调用方透明。补出来的值进钳制后的声明，所以确认页上用户看得到「闲置 30 分钟后回收」。

**一律拒（错误消息说清哪一条、为什么、该怎么改）**：

| 拒绝理由 | 触发条件 |
|---|---|
| service 名不许自选 | 声明了 `backend.service` |
| 不许多开宿主端口 | 声明了 `backend.publish` |
| dev 覆盖会把宿主源码 bind 进容器 | 声明了 `backend.dev` |
| 容器内跑成谁由镜像自己的 USER 定；这一格能把按非 root 设计的镜像抬成 root，而宿主对第三方镜像里跑的是什么一无所知 | 声明了 `backend.user` |
| 不声明内存上限 = 不限制 = 可以吃满宿主内存 | 缺 `backend.mem`，或 `mem` 解析不了（多大都行，但必须是个数） |
| 镜像没钉版本：`stream update` 靠换 tag 触发容器重建（宿主接管只比 `Config.Image` 字符串），浮动 tag 永远重建不了、用户一直跑装机那天的镜像而没有一处会喊 | `backend.image` 没有 tag，或 tag 是 `latest`（钉版本 tag 或 `@sha256:` digest 才过；`floatingImageTag`） |
| 包 id 不合文法 | `stream.id` 不匹配 `^[a-z0-9][a-z0-9_-]*$`。id 被指派成 service 名，于是同时是容器名 `stream-<id>`、卷名前缀、URL 路径段；而撞名闸门是精确比较，`Alist` 挡不住内置的 `alist` |
| health 会把探活打去别人家 | `backend.health` 不是以单个 `/` 开头的本机路径（`@evil.com/`、`//evil.com/`、`healthz`、含空白或反斜杠）。探活 URL 是宿主后端拼出来的，`http://127.0.0.1:<口>@evil.com/` 的 host 是 `evil.com` |
| 时间格超上界 | `standby.startTimeoutSeconds` > 300（容器备齐是启动时 await 的串行循环，这个数就是"一个永不健康的容器能把开机卡多久"）、`standby.idleMinutes` > 1440（等于声明常驻） |
| 把宿主文件系统交给容器 | `volumes` 里有宿主路径 bind（判据复用运行时同一个 `isHostBindMount`），或不是 `name:/绝对路径` 形状，或包 id 本身不能当卷名前缀 |
| 每个卷都是宿主上长期占地的存储 | `volumes` > 4 个 |
| env 原样进容器，无界就是无界注入面 | `env` > 32 条，或某个值 > 4096 字符 |
| 顶掉宿主注入的 env | `env` 名以 `STREAM_` 开头（宿主命名空间） |
| service 名（= 包 id）已被占用 | 撞了就是两边抢同一条 `/_p/` 路由 + 同一个 standby 名册位。**这道闸门查的是 `occupied.services` 不是 `occupied.ids`**——内置包的 service 名不一定等于它的 id（`Douyin_TikTok_Download_API` 的 service 是 `douyin-tiktok-download-api`），只查 id 看不见它 |

**凭证由宿主派发**：包用 `stream.credentials: [域]` 申报它可以拿到哪些域的登录态，宿主在调用时注入（见 §5.1）。secret 不进镜像、不进 `backend.env`、不进生成的 compose。

**装上不等于跑起来**：第三方容器和内置容器走同一条线（§7.2），要真被建出来得用户开 `manage_containers`（**默认关闭**）。关着的时候宿主一个 docker 写操作都不发。容器是**启动时**备齐的，所以刚装完那一刻它还不存在——重启后端才有。

**卸载收容器、但不收卷**：卸载一个带容器的包会先 `docker rm -f` 它的容器再删包目录（不看 `manage_containers`——那个开关管"要不要替你建"，收自己建的东西不受它管）。**命名卷原地留着**：那里面是数据，删掉不可逆。留了就必须说——卸载成功时通知中心会点名留下了哪几个卷、以及 `docker volume rm` 怎么敲。别把这条通知和"容器没能清掉"那条共用一个 `dedupeKey`：事件层对同一个 key 的未读事件只刷时间戳、**丢掉新正文**，轻的那条会把重的那条吃掉。

### 6.3 `hostVersion`

`stream.hostVersion` 只支持 **`>=X.Y.Z`** 一种写法，`^`/`~`/x-range/`latest` 一律当场拒绝——装作看懂了比拒绝更危险。宿主自己的版本走构建期注入（`scripts/build-server.mjs` 的 `--define`），源码路回落读仓库根 `package.json`。**读不到时 fail-closed**：声明了 `hostVersion` 的包一律拒装（一道失效的闸门比拒装危险得多）。不声明 `hostVersion` 的包不受影响。

**宿主版本 = 仓库根 `package.json` 的 `version`，它是「包能依赖哪些声明位」的契约版本。** 宿主加了包会
依赖的新声明位 / 新语义（例如 `links`、`item`），就 bump 它的 minor；用到这些声明位的包在同一轮写
`hostVersion: ">=<那个版本>"`。**两件事必须一起做**：只 bump 宿主不写下界，旧宿主装上新包会把不认识的键
**静默丢掉**（schema 不是 strict），能力无声消失；只写下界不 bump 宿主，下界永远比不出新旧。当前契约版本
`0.1.0` 引入了 `links` 与 `item`。

### 6.4 代码包怎么打

- **入口必须正好是 `dist/index.js`**——一个字面路径，不是 pattern、不是目录。`./dist/index.js`、`dist//index.js`、`DIST/INDEX.JS` 这些别名写法全都进不来（放行别名等于放行一族路径）。
- **预打包成单文件 ESM，依赖全部打进去**：宿主装完不跑 `npm install`，`node_modules` 不会出现在包目录里。`import` 一个没被打进来的第三方库 = 装载期 `ERR_MODULE_NOT_FOUND`，这个包**这次就是不生效**（Stream 其余部分照常起来，通知中心会有一条"扩展包未生效"）。用 esbuild/rollup 之类 bundle 到一个文件。
- **只能有这一个代码文件**。tarball 白名单只受理 `package.json`、`*.recipe.json`、`manifests.yaml`、README/LICENSE/NOTICE/CHANGELOG，加上 `dist/index.js` 这一个例外；其余带 `/` 或 `\` 的路径一律拒。
- **申报与实物必须一字不差对上**：声明了 `stream.code` 却没有那个文件 → 拒；有那个文件却没声明 → **夹带代码**，也拒。
- 类型从 `@streamapp/plugin-sdk` 取（`ActivateFn` / `PluginContext`…），运行时工具也从它取（`ValidationError` /
  `ContentUnavailableError` / html 工具 / `mediaPlayUrl` / `BROWSER_UA`——就是 `shared/package-sdk/` 那一批，bundle 进你自己的
  dist，宿主按鸭子标记认）；`activate(ctx)` 的契约与内置包完全一样（§3）。内置那 7 个带 code 的包走的就是这条路
  （§3.7 / §3.8），形状由它们钉着。

### 6.5 装完什么时候生效

| 装进来的东西 | 生效时机 |
|---|---|
| recipe 数据 / 清单 | **热重载**，装完即生效（watcher 重挂 recipe 包） |
| 代码（`stream.code`） | **重启 Stream 之后**——包代码只在启动时 `import()` 一次 |
| 能力（`stream.capability`） | **重启 Stream 之后**——同上，装载器只在启动路径上跑一次（§5.9.5） |
| 容器（`stream.backend`） | **重启 Stream 之后**——`image` 换了 tag 只是落盘，宿主要在重启时的备齐路径上比对镜像声明才会拿新 tag 重建容器（§4.1、`recreateOnImageMismatch`） |

同理**卸载和升级**：文件立刻删/换，但已经 `import` 进来的那份 ESM 模块运行中卸不掉，重启前它还在跑。安装页和卸载确认页都会把这句话说出来。

**待生效清单是算出来的，不是记出来的**：启动那一刻装载的用户层被冻成一份快照，`GET /api/packages/pending`
每次请求现扫盘上的用户层目录、拿去跟快照对账，回一份 `PendingChange[]`（`{ name, kind:
'installed'|'updated'|'removed', from?, to?, needsRestart, why }`）；判据只看槽位——只有 recipe 数据的
新装/更新/卸载不用重启，带 `code` / `capability` / `backend` 的都要。同一份计数进
`GET /api/health.pending_restart`（只给个数，health 保持轻），`GET /api/packages` 每项也带一格 `pending?`
按包名对上。后端没接这条查询就 `503` / health 里干脆没有这一格——不装账本，所以也没有「账本坏了」这回事。
凭证域**不单独算**判据：它是给代码 / 容器用的许可名单，那三格已经把重启判出来了；装 / 换 / 卸三条路同一把尺。

**怎么重启**：`POST /api/restart`（契约见 `docs/API.md`）把进程优雅关掉再重新起——**不是热重载**，
代码 / 能力 / 容器 / 凭证域申报全部按正常启动路径重来。三个入口都打这一个端点：
`stream add` / `stream update` / `stream remove` 装完直接问「现在重启后端？[y/N]」（`--restart` /
`--no-restart` 跳过那一问，脚本用）；命令行单独的 `stream restart [--force]`；包页面顶部的横幅
「N 项变更等待重启生效」。有正在跑的任务（8900 上的定时采集/交易任务）会拦下 `409`，除非带
`?force=1`——重启时机归人，一次包更新不该打断正在跑的任务。

**谁拉起我，决定怎么活回来**（`src/restart/policy.ts`，回执里的 `mode` 就是这一格）：

| 拉起方式 | 判据 | 收尾 |
|---|---|---|
| 有监护（systemd 服务、`stream mcp` 壳、别的 supervisor） | env `INVOCATION_ID` 或 `STREAM_SUPERVISED=1` → `supervised` | 优雅关后以 75 退出，监护者拉起 |
| 用户前台跑的 `stream` | 两者都不在 → `reexec` | 优雅关后自己再起一份、退出。**新的一份已脱离终端**：Ctrl-C 够不着它，要停它按端口找 pid |
| `scripts/dev.sh`（`tsx watch` 养着） | 脚本 `export STREAM_RESTART_MODE=watch` | 不自己关，碰仓库根的 `restart-sentinel`，监视器 SIGTERM + 拉起 |

`STREAM_RESTART_MODE=supervised|reexec|watch` 显式设了就压过自动判。**要设它的场景**：`INVOCATION_ID`
会被 systemd 用户服务拉起的 scope / 终端继承，在那种终端里前台跑 `stream` 会被误判成有监护、退 75
之后没人拉起——那里要 `export STREAM_RESTART_MODE=reexec`。

**`stream mcp` 拉起的后端重启后照常服务，但宿主那侧的 `tools/list` 快照不会跟着刷**——新装的能力包
的工具要重开一次对话才看得到。

### 6.6 安装页会亮什么

preview 把包的申报摆出来，`app/src/components/recipes/risk.ts` 把它评成四档，**严格升序 `plain < elevated < container < code`**：

- **`code`（最高）**——preview 里有 `code` **或 `capability`**。文案说清「这个包的代码和 Stream 同权限：能读全部 cookie 和 token、能以你的身份向任意地址发请求」，并**摆出它会占用的 adapter / normalizer 注册名**与代码入口路径，外加那句"重启后才生效"。**官方 `@streamapp/` scope 不豁免这一档**——前缀能说明的只有"覆盖内置源是升级而不是李代桃僵"，说明不了这份字节里的代码要干什么。
- **`container`**——preview 里有 `backend`。页面摆出**镜像全名、内存上限、卷、env 键名、能取到的登录态域、闲置多久回收**（env 只给键名，值不外泄——值可能是包作者塞的 token，而确认页是会被截图分享的）。夹在 `elevated` 与 `code` 之间的理由是能力面：比 elevated 重（在用户机器上长期跑一个任意镜像、有网、能经 broker 取申报过那些域的登录态），比 code 轻（另一个进程、另一个文件系统命名空间，宿主 bind 被拒、卷加了包前缀、内存有上限、GPU 被拒、不额外开宿主口，凭证只到申报过的域为止）。容器与代码同在时 level 取 `code`，但**两条理由都摆出来**——容器那条带着镜像全名，是用户唯一能核实的具体物。
  **能力包（`capability`）另摆一条理由**（两格都填就两条都摆——同一个文件，注册的东西不同）：
  能力入口路径、**申报的凭证域逐个点名**、「它在后端进程内运行、与 Stream 同权限、能取浏览器
  登录态」、以及「重启后端才生效」。**它会注册哪些工具通常摆不出来**——工具名要 import + mount
  之后才知道，而确认发生在那之前。所以那句话说的是**权限本身**，不是数动词：用一个数不出来的
  数字当风险量纲，会让人误以为 0 个工具就是安全的。
- **不分档、但每档都摆的一行：`proxies`**——包有 `serving` 声明时，页面列出后端会替它去连的主机
  （`match` 与 `hosts` 的并集）。这是「后端替第三方出站」的事实，和限流、登录域同级；没有声明就不占行。
- **`elevated`**——包内有 recipe 声明 `effects: write`（会写用户账户），或非官方 scope 的包覆盖了内置源。
- **`plain`**——纯数据包，档位不变（不因为代码格的加入而被连坐）。

`plain` 之外全部触发**慢速确认门**（二次确认控件）。

**`overrides` 的语义：「你正在把内置的这个包换成 npm 上的这一版，被换掉的全名有这些」。**
判据是**包名**，不是 sourceId：装 `@streamapp/xhs` → 与内置层那个包同名 → 全名逐条相同 →
用户层整包盖住内置层。所以覆盖**永远是一次自我升级**，第三方包盖不到官方源（全名以包名打头，
两个包的名字空间天然分开）。`risk.ts` 里「非官方 scope 覆盖内置源 → elevated」那条因此
永不触发——它没被删掉，而是改写成断言 `assertOverridesAreSelfUpgrade`：真触发了说明前缀合成
或 preview 出了问题，要大声报，不是静默走进一档更严的确认框就算了。

### 6.7 安装期会拒掉什么（对包作者最有用的一张表）

同一把尺同时管 npm tarball 与本地 zip 导入（`assertInstallable`），换个入口绕不过去：

| 拒绝理由 | 触发条件 |
|---|---|
| schemaVersion 过高 | 旧形 `stream.schemaVersion` 超过本应用支持的上界 |
| hostVersion 不满足 / 写法不支持 / 宿主版本读不到 | 见 §6.3 |
| 容器声明不合规 | `backend` 里写了 `service`/`publish`/`dev`/`user`、缺 `mem` 或 `mem` 解析不了、`image` 没钉版本（无 tag / `:latest`）、卷是宿主 bind 或超量、env 超量或用了 `STREAM_` 前缀名（整张表见 §6.2；`gpu` 与 `mem` 大小不钳） |
| 撞容器 service 名 | `stream.id` 指派出的 service 名已被内置包或另一个已装第三方包占着 |
| 撞内置**插件**包 id | `stream.id` 与一个**填了插件槽位**的内置包（有 `backend` / `code` / `normalizer` / `sources` / `sourceGrouping` / `credentials` 任一格，见 `fillsPluginSlot`）同名。撞上内置**纯 recipe 包**的 id **不拒**——那是受支持的覆盖（见 §6.6 的 `overrides`）。**同 npm 名的内置包不算撞**：装 `@streamapp/xhs` 的新版就是装内置 xhs 那同一个包，占用表按正在装的 npm 名把那一个内置包剔掉（`occupiedByBuiltins(packages, selfPkgName)`），启动时按 §0.5 的尺子只装载版本高的一层 |
| 撞 adapter 名 | 申报的 adapter 名已被**内置包**（同 npm 名的那个除外，同上）、**另一个已装的第三方包**或宿主四件（`builtin`/`rsshub`/`replay`/`browser`）占用 |
| 撞 normalizer 名 | 申报的 normalizer 名已被内置包（同 npm 名的那个除外）或另一个已装的第三方包占用 |
| 撞 enricher 名 | 申报的 `code.enrichers` 名已被内置包（同 npm 名的那个除外）、另一个已装的第三方包，或宿主自己的 `/api/enrich` 源（`HOST_ENRICH_SOURCES`）占用。启动期撞上是「两边都不激活」→ packages 域起不来，所以装之前拒 |
| 撞 connect 域名 | 申报的 `code.connect` 域名（按小写比）已被内置包（同 npm 名的那个除外）或另一个已装的第三方包占用——同一个站点只能有一个包提供一键订阅 |
| **tarball 里有重复路径** | 同一个路径出现多次（校验读第一份、落盘留最后一份 = 用户批准的和装上的不是同一份字节） |
| 代码入口路径不对 | `stream.code.entry` 不是 `dist/index.js`；`stream.capability` 不是同一个字面量 |
| 申报了代码但没有文件 | 声明 `stream.code` **或 `stream.capability`**，包里没有 `dist/index.js` |
| **夹带代码** | 包里有 `dist/index.js`，却两格都没声明 |
| 白名单外的文件 | 任何其他含 `/` 或 `\` 的路径，或不在受理扩展名清单里的顶层文件 |
| sourceId 撞车 | **同一包内** sourceId 重复（两份会合成同一个全名，后一份静默盖掉前一份）。跨包同名不是冲突——全名带包名前缀，两个包产不出同一个 id（§1.1） |
| 局部名文法不合 | `manifests.yaml` 的 `id` 或 recipe 的 `sourceId` 含 `/` 或 `:`（§1.1） |
| 体积 / 数量超限 | tarball > 2MB、解包 > 20MB、条目 > 200 |
| 包名文法不合 / 名字对不上 | 包名不符 npm 文法，或 tarball 里的 `package.json#name` 与请求的名字不一致 |
| tarball 完整性对不上 | integrity 与 registry 给的不符，或 preview 之后包被换过（confirm token 不匹配） |

### 6.8 装载时的两条来路

启动时 `activatePackages` 取模块有两条路：内置包走 `packages/index.ts` 的**静态 import 表**，用户目录里带 `code` 的第三方包走运行时 **`import(file://…/dist/index.js)`**。

**路由按包对象身份，不按 id**——包对象是宿主扫出来的，包里写什么都伪造不了；按 id 建集合的话，第三方把 `stream.id` 写成 `alist` 就会把**内置** alist 也判成动态、去 import 它的 `.ts` 源码（发行 bundle 里不出货）→ 后端起不来。同理别把它换成写在包对象上的 `layer` 字段。

`code.entry` 还要 resolve 后确认收在包目录内（`../../…`、绝对路径一律拒）。

**检查同步、执行异步**：`activatePackages` 本体**不是 `async function`**，第一段（撞名、保留名、包目录边界、漏进 import 表）在返回那个 Promise 之前就同步抛。这不是花招——`import()` 本身就会执行模块顶层代码，`activate` 都不用被调，所以"这个名字能不能注册"的确认必须早于任何 import，而"同步抛出的一定发生在 import 之前"是控制流保证的，测试能直接用 `expect(() => …).toThrow()` 钉住。

**失败分两档，差别是"这是谁的代码"**：

| 什么时候 | 内置包（静态表） | 第三方包（动态 import） |
|---|---|---|
| **名字检查**（撞名 / 保留名 / entry 路径越界，第一段，执行之前） | 致命，后端不启动 | 致命，后端不启动 |
| **执行期**（`import()` 抛错、模块顶层炸、没导出 `activate`、交出来的名单与申报对不上） | 致命，后端不启动 | **只这个包不生效**：记一条日志 + 发一条通知（`package.activate-failed`），bootstrap 照常走完 |

名字检查发生在任何包代码跑起来之前，是信任边界的一部分，**不许降级**。执行期就不同了：第三方包漏打一个依赖不该让整个 Stream 起不来——起不来的话用户在 UI 里根本恢复不了，只能去翻文件系统删包。内置包反过来，那是我们自己的代码，坏了就该起不来。

---

## 7. 起容器

### 7.1 生成 compose

compose **不是手写的静态文件**——它从**当前激活的插件集**生成（`generateCompose`，`src/plugins/compose.ts`，纯函数、键排序、确定性可 diff）。

打印生成的 compose：

```bash
pnpm plugins compose            # = tsx src/plugins/cli.ts compose
```

输出（当前激活集为 douyin，**下例只截取插件后端部分**）：

```yaml
networks:
  stream:
    driver: bridge
services:
  douyin-tiktok-download-api:
    expose:
      - "80"
    healthcheck:
      interval: 10s
      retries: 5
      test:
        - CMD-SHELL
        - wget -qO- http://localhost:80/docs || exit 1
      timeout: 5s
    image: ghcr.io/jaggerh/douyin_tiktok_download_api:latest
    networks:
      - stream
```

> **注意**：默认输出里**只有插件容器**——Stream 自己的后端跑在宿主上、自己就是那扇门，没有 `serve-backend`/`gateway`，也不写 `./Caddyfile`。要整套容器（NAS/VPS 自托管）用 `pnpm plugins compose --selfhost`：那一档才注入那两件 + 顶层 `volumes: { stream-data }`，并副写 `./Caddyfile`（stderr 打 `[plugins] wrote ./Caddyfile`）。上例为聚焦插件而截取，完整产物以实跑为准。

起停（幂等——`up -d` 会 reconcile 到当前激活集）：

```bash
pnpm plugins compose > docker-compose.yml
docker compose up -d
```

> ⚠️ **别用 `docker compose down` 收摊插件层。** 它把容器**删掉**，而 standby 只会启停、不会创建
> ——之后任何 `/_p/<plugin>` 都秒回 502（inspect 找不到容器，不是"睡着了"）。要停就 `stop`；已经
> `down` 过就 `docker compose create` 把它们建回来（不启动，standby 照旧按需唤醒）。

> ⚠️ **改了生成器就得重新生成，并且 `--force-recreate` 那个容器。** `docker-compose.yml` 是**产物**，
> 不跟着 `src/plugins/compose.ts` 走；容器的 healthcheck、卷、内存上限在**创建那一刻**就烤进去了，
> 后来改生成器一概不影响已存在的容器，而 `docker compose up -d` 只在 compose 文件**本身**变了时
> 才重建。
>
> 这条失败得极安静，实测撞过：探针曾经写死一条 `wget`，抖音那个镜像里根本没有 wget，于是容器
> **Up 着、永远 unhealthy**（连败 128 次），服务本身好好的（直连 `/docs` 返回 200），只是宿主拿不到
> 它的基址——报出来是 `Failed to parse URL from /api/hybrid/video_data?…`，**看着像代码 bug，
> 其实是基础设施状态**。生成器早就修成了 `wget || curl || python3` 三选一、还有测试钉着，而盘上那份
> compose 停在三周前，所有容器都建在坏探针上。判法：
>
> ```bash
> docker inspect <容器> --format '{{json .State.Health}}'   # 看 FailingStreak 和探针原始输出
> ```

**开发（base 镜像 + 挂源码 + reload，零 rebuild）**：descriptor 的 `backend.dev` 声明 base 镜像 + 挂载路径 + reload 命令；`--dev` 输出**只含 dev delta** 的 override，compose **自动合并** `docker-compose.yml` + `docker-compose.override.yml`：

```bash
pnpm plugins compose       > docker-compose.yml            # baked 镜像（分发默认）
pnpm plugins compose --dev > docker-compose.override.yml   # 仅开发：被 dev 的服务换成 base+挂载+reload
docker compose up -d                                        # 两个文件自动合并
```

无 `backend.dev` 的插件不出现在 override 里 → 保持各自 baked 镜像。改源码即生效——**没有 rebuild、没有「重新部署」**。`backend.dev` = `{ image, mount, workdir?, command }`（见 §10 douyin 范例）。

网关端口/路由规则、`expose` vs `publish` 的区别、排错顺序 → **专题见 `docs/GATEWAY.md`**（后端连不上/端口对不上先读它）。

### 7.2 后端自己接管容器（`manage_containers`，默认关）

发行版用户没有仓库、也没有 compose CLI。`config.yaml` 写 `manage_containers: true`（或 `STREAM_MANAGE_CONTAINERS=1`）后，后端启动时按各插件的 `stream.backend` 声明**自己**把容器备齐：没有就 `pull` + `create` + `start`，已经在跑就一次 `list`+`inspect` 什么都不做。建出来的容器带 standby 认得的 label，两条路（compose / 后端接管）产出的容器长得一模一样。

**备齐管「有没有」，standby 管「转不转」。** 容器已存在但**停着**时，备齐**不动它**（`'asleep'`，零写操作）——那个"停着"是 standby 的闲置回收刚做出的正确决定，起了就是两个主人抢同一件事，而后端每重启一次就把睡着的容器全叫醒一遍（开发期每存一次文件就重启一次），standby 省内存那件事整个作废。唯一会被备齐起来的是**没声明 `backend.standby` 的常驻容器**——没人负责唤醒它。

**默认关闭，关着时一个 docker 写操作都不发**——容器照旧归上面的 compose 管。

内置包（`packages/`）和用户装的第三方包（`<dataDir>/recipes/`）走的是**同一条线**：都会被接管建容器、
都进 standby 名册（所以第三方那份兜底的 `standby: { idleMinutes: 30 }` 真的有 reaper 收）、
申报了 `credentials` 就都由宿主在调用时派发登录态。第三方多两道运行时闸门：
缺 `mem` 拒绝创建、卷里的宿主路径 bind 拒绝（盘上的 `package.json` 装完之后被手改那条路）。

两条守则（`src/plugins/provision-wire.ts`）：

- **镜像与声明对不上就删了重建**（包升级换了 image tag 的那一刻），不问、不给按钮，重建完在通知中心发一条 info 通报。前提是 §4.1 那条不变量：容器层不许住状态。
- **docker 够不着不掀翻启动**：一条日志 + 一条 error 通知，Stream 其余部分照跑。

`backend.publish`（自带管理 UI 的固定宿主口，如 AList）这条路它还不支持——声明了就发一条通知说明该端口不会被发布，那个容器仍需走 compose。

---

## 8. Plugin / Source catalog（`/channels` 的读模型）

前端 `/channels` 看到的不是「manifest 列表」，而是一个 **server-owned 的两层目录**：

```text
Plugin              能力包边界：存在什么、怎么启动、健康/配置状态、广义能力
  owns Source[]     可绑定进 Stream / Provider 的具体入口（每个 source manifest = 一个 Source；订阅本身指向 Channel）
Source
  categories[]      只是 Plugin 内的分面（filter/tab）——不决定归属
  facility?         该 Source 所属的外部设施（{key,label}），可作为 manifest.facility 分组 resolver 的输入
  capabilities[]    该 Source 的最小可执行契约（驱动 UI 控件与执行校验）
  detail 按需加载    docs / params schema / examples / credentials 只在打开 Source 时取
```

四条不变量（`openspec/specs/plugin-source-catalog/`）：

1. **Plugin 是唯一归属边**。`Source.pluginId` 由后端给定，前端**不许**靠 `id.startsWith('rsshub:')` 或 adapter 前缀去猜归属。
2. **category 是分面不是归属**。换 category 分组不会把 Source 移出它所属的 Plugin。
3. **list 轻、detail 重**。列表只回 summary（id/title/categories/capabilities/auth/badges/param 计数），**不带** docs markdown 和完整 params schema；那些留给 detail。
4. **source grouping 只能由 Plugin descriptor 显式开启**。`packages/<id>/package.json` 里 `stream.sourceGrouping` 决定 Plugin 是否显示一级分组页，以及后端调用哪个 resolver：`manifest.facility` 读取 Source 的 `facility` 字段，`adapter.<function>` 调用当前 Plugin runtime 的 adapter 分组函数，`plugin.<function>` 调用当前 Plugin runtime 的 plugin 分组函数。`facility` 本身只是分面/元数据，不能让前端推断分组；没解析出 group 的 Source 落进显式的「未分类」（`key: ''`）组。

四个端点（`src/http/app.ts`，读模型在 `src/mcp/tools.ts` 的 `StreamService`）：

```text
GET /api/plugins                                  → PluginSummary[]
GET /api/plugins/sources                          → { sources, plugins, facets, nextCursor?, total? }   (跨插件源搜索，按 plugin 分组)
GET /api/plugins/:pluginId/sources                → { plugin, sources: SourceSummary[], groups, facets, nextCursor?, total? }
GET /api/plugins/:pluginId/sources/:sourceId      → SourceDetail   (sourceId URL-encoded：RSSHub id 含 : 和 /)
```

> 跨插件源搜索的 MCP 对应工具是 `stream_sources`（faceted，按 plugin 分组）；`stream_search` 仍是意图排序的发现工具，二者职责不同。

**Plugin 展示元数据只来自 descriptor**（`packages/<id>/package.json` 里 `stream.name/tagline/description/homepage/repository/docsUrl`）——`plugins()` 里 `pluginMetadata(descriptors, id)` 是唯一来源，无 descriptor 的插件回落到裸 `id`。**不要**在 `tools.ts` 里再写一份硬编码文案。

> 当前债（design Risks 已记）：`status`/`launch.health` 除了 `mergePluginStatus` 接入的运行态外仍多为占位。归属边（`src/registry/seal.ts` 的 `pluginIdForDescriptor` / `pluginIdOf`）只认 `package.json#stream.id` 与 manifest 自己写的 `adapter`，宿主不替任何包维护别名。重点边界已达成：**前端不猜归属**。

---

## 9. 来源 failover + 健康台账 + doctor

一个 Stream（代码类型 `StreamRecord`，`src/store/types.ts`）的多个 `members` 默认是 **fan-out**（每周期全拉 + DedupStore 去重）。声明 `strategy: exclusive` 后，`members` 变成**有序阶梯**：调度器只拉**第一个 healthy 的源**，命中即停；硬错误时在同一 tick 内顺延到下一档。

> 词汇对照（[ARCHITECTURE.md](ARCHITECTURE.md)）：这就是 Stream 的两种 `strategy`——fan-out ≡ `fanout`，容灾阶梯 ≡ `exclusive`。散文里的 "failover" 说的就是它，但**配置里只能写 `exclusive`**，写 `failover` 会被 user store 拒。

**健康台账**（`src/source-health-store.ts`，JSON，keyed by `source_id`）记录每次**真实**拉取（缓存命中不记，design D3）：
- 硬失败（`adapter.fetch` 抛错）→ 连续 2 次判 `dead`（1 次 `degraded`）。
- 软失败（返回 `[]`）→ 仅当该源历史产出过（`lifetimeItemCount > 0`）且**连续空 ≥ K（默认 4）**才 `degraded`；安静源不误伤。
- **re-probe**：每 M（默认 6）个 cadence 重探最高档非 healthy 源，成功则升回 `healthy`，选择自动回到它。

> 健康是 **Source 的全局属性**（keyed by `source_id`，跨流共享）；优先级是 **每个流 `members` 的顺序**（边属性）。台账是 failover 与 doctor 的**唯一共享真相**。

**浏览器末档**：`adapter: browser` 的源渲染一个 URL 作为通用最后一档。渲染发生在**用户自己的 Chrome**（经扩展 relay，renderer 由 bootstrap 注入，adapter 自己没有默认实现——Stream 不带浏览器，这一档尤其不许偷偷再起一个）。放在 `members` 末尾，只有上面的源都 degraded/dead 时才触达。见 `packages/browser/manifests.yaml`（`browser-page`）。

**`pnpm doctor`**：读同一台账，逐源打印 active state / 退化原因（如 `empty ×6`）/ 缺凭证处方（`auth: cookie` 域在登录态快照里解析不到 → 提示去浏览器登录）。`pnpm doctor --reprobe <source>` 立即重探一个源。

```jsonc
// POST /api/streams —— 主源挂了自动退到备用源，最后兜底到浏览器
{
  "id": "my-music",
  "label": "我的音乐收藏",
  "strategy": "exclusive",
  "members": [                                                                    // 顺序 = 阶梯
    { "plugin": "replay",  "source": "zuna-playlist", "params": { "id": "…" } },  // 主
    { "plugin": "rsshub",  "source": "rsshub-raw",    "params": { "route": "…" } },  // 备
    { "plugin": "browser", "source": "browser-page",  "params": { "url": "https://…" } }  // 末档兜底
  ],
  "cadence_seconds": 1800,
  "options": { "vault_subdir": "music" }
}
```

---

## 10. 范例与模板

一个完整插件最多 6 件：

| # | 件 | 位置 | 必需？ |
|---|----|------|--------|
| a | adapter 类（mode → backend endpoint） | `packages/<id>/adapter.ts`（独占归属，默认）；仅被多插件共享/属应用核心时才放 `src/adapters/` | 是 |
| b | plugin descriptor（catalog 展示字段 + backend 镜像 + credentials + normalizer） | `packages/<id>/package.json`（`stream` 字段） | 是 |
| c | source manifest(s)（每个调用模式一个） | `packages/<id>/manifests.yaml`（顶层列表） | 是 |
| d | normalizer（原始 item → 展示模型） | `packages/<id>/<facility>.ts`，由 `activate` 交出（§3） | 是 |
| e | 声明凭证域（broker 服务） | descriptor 的 `credentials: [...]` | 仅当需要登录态 |
| f | code 槽位：`activate(ctx)` + `stream.code` 名单（把 a/d 交给宿主注册） | `packages/<id>/activate.ts` + descriptor 的 `stream.code`（§3） | 有代码就必需 |

### 10.1 范例（完整）：douyin

**(a) adapter** —— `packages/Douyin_TikTok_Download_API/adapter/adapter.ts`（`DouyinTiktokDownloadApiAdapter`；同目录还有 executor / normalize / danmaku / play-addr 等实现件与 `__fixtures__/`）。一个对**外部已运行的 Douyin_TikTok_Download_API 容器**的薄 HTTP 客户端：整个包**一个 adapter**，按每个 source manifest 的声明式 `api.endpoint/query/unwrap` 路由到后端端点（见 `onboard-source` skill 的 references/via-external-backend.md），返回原始列表；`api.handler` 是逃生口，resolve / fetch-url 这类不是「列表」形状的成员走它。容器地址：

```
env DOUYIN_API_URL（显式覆盖，比如用户自己跑的一份 http://10.0.0.21:3007）
  →  ctx.backendUrl()（缺省：本包自己的 backend service，compose 档是容器 DNS、host 档是醒着的容器的 loopback 口）
```

`ctx.backendUrl` **递 thunk 不递值**（`() => ctx.backendUrl()`）：host 档下 loopback origin 只在容器醒着时存在，构造期快照必得空串。每次打容器都套 `ctx.withAwake`，睡着的容器先叫醒。宿主的 `config.yaml` 里**没有**这个容器的地址项——地址归包，宿主只管 resolver。

（登录态 mode（collection / follow / search）的 cookie 走 **adapter 路**：宿主经 manifest `auth: { type: cookie, domain: douyin.com }` 解析后注入 `init`/`sidecar.start`，adapter 把它当 query 参数传给容器 —— adapter 自己**不去要凭证**。user mode 是公开主页，`auth: none` 无需 cookie。）

**(b) descriptor** —— `packages/Douyin_TikTok_Download_API/package.json`：

```json
{
  "name": "@streamapp/douyin-tiktok-download-api",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "bundle": "node ../../scripts/bundle-code-packages.mjs .",
    "prepack": "node ../../scripts/assert-npm-artifact.mjs"
  },
  "files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
  "stream": {
    "id": "Douyin_TikTok_Download_API",
    "name": "抖音 / TikTok",
    "tagline": "视频平台搜索与解析服务",
    "description": "抖音搜索、用户作品、关注流、合集与视频媒体解析。",
    "backend": {
      "image": "ghcr.io/jaggerh/douyin_tiktok_download_api:latest",
      "service": "douyin-tiktok-download-api",
      "port": 80,
      "health": "/health",
      "standby": { "idleMinutes": 30 }
    },
    "credentials": ["douyin.com", "tiktok.com"],
    "links": {
      "hosts": [
        { "host": "douyin.com", "platform": "douyin" },
        { "host": "iesdouyin.com", "platform": "douyin" },
        { "host": "tiktok.com", "platform": "tiktok" }
      ],
      "shortHosts": ["v.douyin.com", "vm.tiktok.com"]
    },
    "normalizer": "douyin",
    "sourceGrouping": { "enabled": true, "resolver": "manifest.facility" },
    "code": {
      "entry": "dist/index.js",
      "adapters": ["Douyin_TikTok_Download_API"],
      "normalizers": ["douyin", "tiktok", "bilibili-web"],
      "enrichers": ["douyin-comments"],
      "connect": ["douyin.com"]
    },
    "providers": [
      { "id": "video-douyin", "category": "resolve", "serveKeys": ["douyin-video"], "strategy": "sequential",
        "label": "douyin 视频解析", "description": "作品 id → play_addr 直连 CDN（带 Referer，range 串流）",
        "members": [{ "source": "douyin-resolve" }], "callsites": ["video.resolve"] },
      { "id": "video-tiktok", "category": "resolve", "serveKeys": ["tiktok-video"], "strategy": "sequential",
        "label": "tiktok 视频解析", "description": "作品 id → play_addr 直连 CDN",
        "members": [{ "source": "tiktok-resolve" }], "callsites": ["video.resolve"] },
      { "id": "douyin-url", "category": "transform", "serveKeys": ["douyin-link"], "strategy": "sequential",
        "label": "抖音链接抓媒体", "description": "douyin.com / iesdouyin.com / v.douyin.com 的链接 → 标题、作者与可播放地址",
        "members": [{ "source": "douyin-fetch-url" }], "callsites": ["content.enrich"] },
      { "id": "tiktok-url", "category": "transform", "serveKeys": ["tiktok-link"], "strategy": "sequential",
        "label": "TikTok 链接抓媒体", "description": "tiktok.com 的链接 → 标题、作者与可播放地址",
        "members": [{ "source": "tiktok-fetch-url" }], "callsites": ["content.enrich"] }
    ]
  }
}
```

> `providers[]` 四行是这个包对外的**能力面**（§0.5）：`resolve` 行按 `<平台>-video` 被 `GET /api/media/play|dash`
> 与转写 / 抽帧取字节派发到，`transform` 行按 `<平台>-link` 被 `stream_fetch_url` / `GET /api/media/from-url` 派发到
> （认领函数按 `links.hosts` 的后缀匹配认平台，`douyin.com` 一条盖住 `www.` / `v.`；一包两平台，所以每个 host 显式写 `platform`）。**每行都写了 `callsites`**——
> 不写就没有任何调用点会问它。成员合同：`*-resolve` 收 `{ vid, format }` 回 `VideoResolved[]`（`[]` = decline，
> `dash` 如实回空；作品被删 / 私密**抛** `ContentUnavailableError`，播放路由据此回 404 而不是 502）；`*-fetch-url`
> 收 `{ url }`、manifest `output: object`，回 `[FetchUrlResult]`。`vid` 的形状归包：抖音是 `aweme_id`、TikTok 是
> 作品 `id`（都是数字串），解析器按 id 拼一条主站链接交容器；**不用分享链接当 vid**——它是派发键与进度键的一半，
> 一条带签名参数的分享链接每次都不同。

> 顶层 `name`/`version`/`files`/`scripts` 是 npm 壳（带 code 的包发 npm，所以不写 `private`；`bundle` / `prepack` /
> `files` 那三格是 §3.8 的出货形状）；领域字段一律在 `stream` 里。
> **`"type": "module"` 必写**（`src/plugins/loader.real.test.ts` 守着）：Node 认**最近的**
> package.json，`packages/<id>/package.json` 一存在，仓库根那句 `"type": "module"` 就管不到这棵
> 子树了。漏写 = 整个 `packages/<id>/**` 按 CommonJS 解析，它 `import` 的每个 `src/**` 模块都会在
> CJS 缓存里**多出一份副本**——bootstrap 在 ESM 那份上接的线（`setPluginTargetResolver` /
> `setStandbyManager`）插件永远看不到：host 档下 `pluginTarget()` 恒 null（base 空串 → fetch 一个
> 相对 URL → `Failed to parse URL`）、`withAwake()` 变 no-op、`standbyOrigin()` 恒 null。
> 不报错、单测也照绿（测试进程里两份副本都没接线），只有活体 host 档才炸。
> **撞到 `Failed to parse URL` 先看 DebugBox 的 `plugin-target` 频道**：`pluginTarget()` 每次答空
> 都会记一条现场（reason、容器在不在、standby 认为它是什么状态、现场 inspect 出来的宿主口 vs
> 缓存的 origin），够直接分清是「没醒」「名单漏了它」还是「缓存陈旧」。事后翻旧账读落盘那份
> （环只有 200 条、重启即清空）：`grep '"plugin-target"' data/debug-failures.jsonl`。
> **`reason: not-awake` 绝大多数是常态噪音，不是现场**：能力探测每分钟问一遍地址，容器被 standby
> 睡着就如实答空（实测 21 小时 1184 条，内容一字不差）。落盘会把它们折叠，**带 `_repeated` 的行
> 就是这类**。要找的现场长成另一个样子：没有 `_repeated`，且 standby 说 `awake`（那就是没醒之外
> 的毛病）或缓存 origin 与现场 inspect 出的宿主口对不上（那就是 Cell 缓存陈旧）。
> `name/tagline/description` 是 catalog 展示字段（§8），Plugin 元数据的唯一来源。
> `image` 用设施自己发布的镜像；`service` 是 compose 服务名（缺省 = `id`），gateway 走 `/_p/<service>`；
> `health` 返 2xx 即 ready（缺省 `/`）——**挑设施自己那个专门的健康端点，别拿首页或文档页顶替**：
> 探针每 10 秒打一次、只要容器活着就一直打，抖音那个设施 `/health` 是 65 字节 2.6ms，
> `/docs`（Swagger 页）958 字节、`/` 首页 7.6KB。选之前 `curl -w '%{size_download} %{time_total}'`
> 挨个量一遍，几秒钟的事；声明了 `backend.dev` 的包在 `compose --dev` 时挂源码热跑（这个包跑 baked 镜像，没声明）；
> `credentials` 里的域是宿主**可以**把登录态交给这个包的许可名单（方向见 §5.1，包不索取）。

**(c) source manifests** —— `packages/Douyin_TikTok_Download_API/manifests.yaml`（顶层列表，一项一个 Source；完整以仓内真实文件为准）：

```yaml
- id: douyin-user
  adapter: Douyin_TikTok_Download_API                          # 路由到包内 adapter
  normalizer: douyin
  description: 抖音 — 指定用户的作品（按主页链接或 sec_user_id）。   # ← 发现/搜索匹配此字段
  topics: [douyin, 抖音, 用户, 作品, video, social-media]         # ← 发现 facet
  categories: [social-media, video]
  example_queries: [某个抖音博主的最新视频, douyin user videos]     # ← 意图检索样例
  capabilities: [timeline]
  auth: { type: none }                                         # user=公开主页，无需登录；登录态 mode 用 auth: { type: cookie, domain: douyin.com }（host 注入 adapter）
  cadence_hint_seconds: 3600
  params_schema:
    url:  { type: string, required: false }
    sec_user_id: { type: string, required: false }
    count: { type: number, required: false }
# Provider 行的成员也是一条 source：不可发现、走 handler 逃生口、params 就是调用点递来的对象整个展开
- id: douyin-resolve
  adapter: Douyin_TikTok_Download_API
  title: 抖音视频解析
  description: 抖音作品播放解析（作品 id → play_addr 直连 CDN，带 Referer，range 串流）；video-douyin Provider 行的成员。
  facility: { key: douyin, label: 抖音 }
  auth: { type: none }
  discoverable: false
  api: { handler: douyin-resolve }                             # vid → 主站链接 → 容器 /api/hybrid/video_data
  params_schema:
    vid: { type: string, required: true, description: "作品 id（aweme_id）" }
    format: { type: string, required: false, description: "progressive | dash | audio（dash 如实回空）" }
```

> `schema_version` / `type` / `discoverable` 可省（loader 给默认）；但 `description` / `topics` / `example_queries` 是发现与搜索的依据，**别省**。
> 同一份文件里还有 `tiktok-resolve` / `douyin-fetch-url` / `tiktok-fetch-url`（后两条 `output: object`），形状同上。

**(d) normalizer** —— `packages/Douyin_TikTok_Download_API/douyin.ts`（`douyinNormalizer`；同目录的 `tiktok.ts` 是同一容器另一家的）。它由包自己在 `activate` 里交出来（见下面 (f)），装载器负责往 `src/content/normalize.ts` 的 registry 注册。视频 media 只带 `(provider, vid)` 身份（`vid` = `aweme_id`），播放地址由包的 resolve 成员在播放时现解，normalizer 里不烘路由字符串、不烘 embed；`page_url` 保留（前端「打开原页」与去重都用）。

**(f) code 槽位** —— `packages/Douyin_TikTok_Download_API/activate.ts` 导出 `activate(ctx)`，descriptor 里 `stream.code` 申报的四份名单（`adapters` / `normalizers` / `enrichers` / `connect`）与返回的键一字不差：

```ts
export const activate: ActivateFn = (ctx) => {
  // 容器地址递 thunk 不递值：host 档下 loopback origin 只在容器醒着时存在，构造期快照必得空。
  // 不传参的 ctx.backendUrl() = 本包自己的 backend service。显式覆盖由包自己读 DOUYIN_API_URL，不经 ctx.config。
  const adapter = new DouyinTiktokDownloadApiAdapter({ backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake })
  return {
    adapters: { Douyin_TikTok_Download_API: adapter },
    normalizers: { douyin: douyinNormalizer, tiktok: tiktokNormalizer, 'bilibili-web': bilibiliWebNormalizer },
    enrichers: makeEnrichers(adapter),   // { 'douyin-comments': ({ vid, cursor|page }) => { comments, total, cursor? } }
    connect: makeConnect(),              // { 'douyin.com': () => ({ stream: 「我的抖音关注」 }) }
  }
}
```

- **enricher** `douyin-comments`（`enrich.ts`）骑同一个 adapter 打容器的评论接口：收 `vid`（缺 → `ValidationError` → 400），
  翻页游标首选 `cursor`、也认前端通用翻页递回的 `page`；末页**不带** `cursor`（§3.2 的合同：`null` 或缺省都是「没有下一页」）。
- **connect** `douyin.com`（`connect.ts`）零输入、不经容器：建一条 `douyin-follow` 流（source `douyin-follow` + `{ mode: 'follow' }`），
  登录态在采集时才用得到。键必须出现在 `credentials` 里。

契约与 ctx 的七样见 **§3.2**。

**(e) 凭证域** —— descriptor 的 `credentials: [douyin.com, tiktok.com]`：一张**许可名单**，说明宿主可以把哪些域的登录态交给这个包。取数由宿主发起（adapter 在宿主进程里拿到注入的 cookie，再随请求递给容器），包不反向索取——见 §5.1 的方向说明。secret 不进镜像、不进 `backend.env`、不进生成的 compose。

加进激活集后，`pnpm plugins compose` 自动把 `douyin-tiktok-download-api` 后端加进生成的 compose。

### 10.2 模板（search-only 外部服务，无凭证）：pansou

pansou 是一个网盘资源搜索服务——**只搜索、无登录态**。这是最简插件形态：一个后端容器 + adapter + manifest + normalizer，**没有 `credentials`**。

**(b) descriptor** —— `packages/pansou/package.json`：

```json
{
  "name": "@streamapp/pansou",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "bundle": "node ../../scripts/bundle-code-packages.mjs .",
    "prepack": "node ../../scripts/assert-npm-artifact.mjs"
  },
  "files": ["dist", "*.recipe.json", "manifests.yaml", "README.md"],
  "stream": {
    "id": "pansou",
    "backend": {
      "image": "ghcr.io/fish2018/pansou:latest",
      "port": 8888,
      "health": "/"
    },
    "normalizer": "pansou"
  }
}
```

> `image`/`health` 换成 pansou 真实发布的镜像与健康探针路径。没有 `credentials`：搜索无需登录态。

**(a) adapter** 骨架 —— `packages/pansou/adapter.ts`。指回 `src/` 的只许是 `import type`（走 `../../src/...`）；
容器地址与唤醒**经 `ctx` 递进来**，包不 import 宿主的 `pluginTarget` / `withAwake` 单例（守卫
`src/packages/self-contained.guard.test.ts` 会判红——那两份单例被 inline 进包的 bundle 后是第二张永远为空的表）：

```ts
import type { Adapter } from '../../src/adapters/types.ts'
import type { SourceManifest } from '../../src/manifest/types.ts'

export const PANSOU_SERVICE = 'pansou'   // withAwake 的唤醒键 = compose service 名

export interface PansouAdapterDeps {
  backendUrl: () => string | undefined   // thunk 不是值：host 档 loopback origin 只在容器醒着时存在
  withAwake: <T>(service: string, fn: () => Promise<T>) => Promise<T>
}

/** 显式覆盖（ctx.config.url）→ PANSOU_URL env → 宿主此刻给的容器地址（none 档 → ''）。 */
export function resolvePansouUrl(explicit: string | undefined, backendUrl: () => string | undefined): string {
  return explicit ?? process.env.PANSOU_URL ?? backendUrl() ?? ''
}

export class PansouAdapter implements Adapter {
  readonly id = 'pansou'
  constructor(private readonly deps: PansouAdapterDeps, private readonly explicitUrl?: string) {}
  /** 每次求值现解析；fetch 都在 withAwake 回调里，求值时容器已醒。 */
  private get baseUrl(): string {
    return resolvePansouUrl(this.explicitUrl, this.deps.backendUrl).replace(/\/$/, '')
  }
  async init(_env: Record<string, string>): Promise<void> {}   // 无凭证

  async fetch(params: Record<string, unknown>, _m: SourceManifest): Promise<unknown[]> {
    const kw = String(params.keyword ?? '')
    if (!kw) throw new Error('[pansou] search needs `keyword`')
    const r = await this.deps.withAwake(PANSOU_SERVICE, () =>
      fetch(`${this.baseUrl}/api/search?kw=${encodeURIComponent(kw)}`))
    if (!r.ok) throw new Error(`[pansou] HTTP ${r.status}`)
    const data = await r.json()
    return /* TODO: 从 pansou 返回结构里取出结果数组 */ []
  }
}
```

**(c) manifest** 骨架 —— `packages/pansou/manifests.yaml`（顶层列表的一项）：

```yaml
- id: pansou-search
  adapter: pansou
  normalizer: pansou
  description: 网盘资源搜索 — 按关键词搜全网网盘（百度/阿里/夸克…）资源链接。   # 发现/搜索依据
  topics: [pansou, 网盘, 资源, 搜索, 百度网盘, 阿里云盘, netdisk, search]
  categories: [search, resource]
  example_queries: [搜网盘资源, 某电影 网盘资源]
  capabilities: [search]
  auth: { type: none }
  cadence_hint_seconds: 3600
  params_schema:
    keyword: { type: string, required: true, description: search keyword }
```

**(d) normalizer** 骨架 —— `packages/pansou/normalizer.ts`（`pansouNormalizer`，住包里；只 `import type` 宿主的
`Normalizer` / `Media`），由包在 `activate` 里交出，宿主 `src/content/normalize.ts` 的注册表不加行。

**(e) 凭证**：无（搜索无需登录）。

**(f) code 槽位** —— `packages/pansou/activate.ts` 导出 `activate(ctx)`，descriptor 加 `"code": { "entry": "dist/index.js", "adapters": ["pansou"], "normalizers": ["pansou"] }`（`entry` 指的是 npm 上那份预编译产物，§3.8；内置层照 §3.3 的静态表直接 import `activate.ts`）：

```ts
export const activate: ActivateFn = (ctx) => ({
  adapters: {
    pansou: new PansouAdapter(
      { backendUrl: () => ctx.backendUrl(), withAwake: ctx.withAwake },   // 递 thunk 不递值
      ctx.config.url as string | undefined,
    ),
  },
  normalizers: { pansou: pansouNormalizer },
})
```

内置包还要在 `packages/index.ts` 的静态 import 表里加一行（见 §3.3）。**`src/bootstrap.ts` 的 adapters Map 不加行**——那张表只放宿主四件。

加进激活集后，`pnpm plugins compose` 自动把 `pansou` 后端加进生成的 compose。

---

## 附：当前形状速查

- **PluginDescriptor**：`{ id, name?, tagline?, description?, homepage?, repository?, docsUrl?, required?, backend?, sourceGrouping?, credentials?: string[], normalizer?, code?, capability?, sources? }`（`code?: { entry, adapters?: string[], normalizers?: string[], enrichers?: string[], connect?: string[] }` 见 §3；`capability?: 'dist/index.js'` 见 §5.9）（`src/packages/descriptor.ts` `parseStreamDescriptor` / `src/plugins/types.ts`；`presenter?` is kept as a deprecated alias for `normalizer`）。`name/tagline/description/homepage/repository/docsUrl` 是 **catalog 展示字段**（§8），是 Plugin 元数据的唯一来源。`required?: boolean` 标记基座插件（`rsshub`/`builtin` 用 `required: true`）。`sources` 由扫描器从 `manifests.yaml` 并入（`stream.sources` 内联与 `manifests.yaml` 二选一，同时给会报错）。
- **PluginBackend**：`{ image, service?, port, health?, env?, gpu?, volumes?, mem?, user?, publish?, dev?, standby? }`（`src/packages/descriptor.ts` `backendSchema`）——`image` 是设施自己的镜像；`service` 缺省 = `id`；同网络 DNS 走 `http://<service>:<port>`；**secret 永不进 `env`**——要登录态就申报 `credentials`，由宿主随请求派发（§5.1）。`gpu`（nvidia 预留，可选包 `voiceprint`/`mineru` 用；第三方声明被钳制拒，官方包放行，§6.2）、`volumes`/`mem`（资源，多设施用）、`user`（容器内跑成谁，`alist` 用，见 §4.1）、`publish`（额外发布宿主端口，schema 有、当前无插件用）。`dev = { image, mount, workdir?, command }` 仅 `compose --dev` 输出（base+挂载+reload）。
- **生成 compose 结构**：`{ networks: { stream }, services: {…} }`，键排序、确定性。默认只有插件容器。`--selfhost` 才追加 Stream 自身的两件：`serve-backend`（`build: .`，`STREAM_PLUGIN_NETWORK: compose` + 显式 `STREAM_PORT: 4555`，即 `/_p` 的 owner，界面也由它发）、`gateway`（`caddy:2-alpine`，那一档**唯一对宿主发布的端口** `127.0.0.1:8900:80`）+ 顶层 `volumes: { stream-data }`，并副写 `./Caddyfile`。单个 `ComposeService` 可含 `image/build/command/env_file/expose/ports/volumes/deploy(GPU)/mem_limit/depends_on/networks/healthcheck/environment`。真实产物以 `pnpm plugins compose` 输出为准。
- **BrowserRecipe**：`{ version, kind, sourceId, session{facility,lifecycle,visibility}, loginCheck, steps[], observers[], output, ledger?, policy?, extract? }`（§2.2）。另有 `kind:'http'` 探针原型（§2.3）与 `kind:'desktop'` 桌面原型（§2.4）。
