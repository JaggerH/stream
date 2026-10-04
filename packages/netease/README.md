# @streamapp/netease — 网易云音乐

网易云这个站点的知识全住在这里。源码（`src/`）只留泛化机制，不认识任何具体平台。
设计见 spec `2026-09-18-facility-knowledge-stage2-design`。

## 1. 这个包管什么

四格，全部由 `package.json#stream` 声明：

| 槽位 | 内容 | 落点 |
|---|---|---|
| `code.normalizers` | `netease` —— 歌单条目的渲染模型（`normalizer.ts`） | 装载器注册进全局 normalizer 表 |
| `code.adapters` + `manifests.yaml` | `netease-lyrics` —— 歌词源（`lyrics.ts`） | `lyrics-search` 行按 `lyrics` 类目现取 |
| `providers` | `netease-track` —— 取歌那条 Provider 行 | 合并身份表 → `ensureSystemRows` 建行 |
| `links` / `rsshubNamespaces` | 贴 URL 识别曲目（`links.patterns` 两条 kind `track`，命名组 `id`）/ RSSHub `163` 命名空间归这个 facility | 认领函数 `recognizeLinkSync`（经 `trackRefFromUrl`）/ RSSHub 路由的 normalizer 归属 |

## 2. 取歌的成员不是本包的东西

`netease-track` 这一行的成员是 `{ mode: 'auto', matches: 'music.163.com/song' }` ——
按 radar 文法现取，命中的是 **zuna / toubiec 两个第三方解锁站**的 download recipe
（`packages/zuna/zuna-download.recipe.json`、`packages/toubiec/toubiec-download.recipe.json`，
两者的 `session.radar` 都是 `music.163.com/song`）。

它们的 facility 不是 `netease`，`normalizer` 是 `rsshub`，**本包不碰它们**。
这一行只声明"谁来服务网易云的取歌请求"这个位置，谁站上去由装了哪些包决定——
所以这里没有写死任何成员 id，换一个解锁站只是装/卸一个包。

## 3. 歌词 key 的文法与 decline 语义

`netease-lyrics` 的 manifest 写的是 `key_param: input`，所以订阅键经
`buildParams`（`src/kernel/plugins/provider.ts`）灌进 `params.input`，adapter 读的是
**`params.input`，不是第一个位置参数**（那是 `BuiltinFn` 的形状，本包不走 builtin 那条路）。

key 三种走法：

| key | 行为 |
|---|---|
| `netease:<id>` | 已知曲目，直取歌词接口，不发搜索请求 |
| `<title>::<artist>` | 模糊搜，取最高分候选（≥50%）再取歌词 |
| 别家平台前缀（`qqmusic:9`…） | **decline —— 返回 `[]`**，把机会让给梯子的下一档歌词源 |

平台前缀的判据要求冒号后**紧跟一个非空白字符**。少了这条，一个普普通通的歌名
（`Song: Reprise`，冒号 + 空格）会被当成别家平台的引用而 decline，连模糊搜都不走，
歌词静默不出。

decline 必须是空数组而不是 `[{matched:false}]`：后者是"我查过了，这首歌没歌词"，
会被调用侧当成判决缓存 7 天；前者是"这个问题不归我答"。

网络错误**抛**，不返回 `{matched:false}`——缓存在调用侧
（`/api/resolutions?type=lyrics` 与 MCP 的 `resolve`，同一份壳 `src/audio/lyrics-cache.ts`），
只缓存源给出的判决，一次抖动不该被冻成 7 天的"查无此歌"。

## 4. normalizer 里那两条站点判据的来历

**VIP 判据**：RSSHub 的 163 路由给付费曲目打一个 `VIP` category；早期的原生条目用数字
`fee` 字段，`1` 和 `4` 是付费档。两条都留着——存量库里两种形状的 item 都有。
判为 VIP 的条目不挂可播放的 audio media，改出一条 link（标题带 `(VIP)`），
仍可经 `netease-track` 行下载。

**`itunes_duration` 三种形状**：RSSHub 163 路由输出的这个字段在不同路由下是
number（秒）、纯数字字符串、或 `HH:MM:SS`。三种都解析，解析不出就不报时长——
猜一个错的时长比没有更糟（进度条会骗人）。

媒体里只存 `(platform, track_id)` 这个**引用**，不存解析路由：存下来的路由会随端点改名
而腐烂，那正是旧 `/api/audio/resolve` 改名之后一批存量 item 404 的原因。

## 5. 发布

npm 上的 `@streamapp/netease` 带一份预编译的代码槽位：`activate.ts` 及其可达的模块（含 `shared/package-sdk/`
那几个纯函数）由 tsdown 打成单文件 `dist/index.js`，`package.json#stream.code.entry` 指的就是它；tarball 里只有
`dist/index.js`、`manifests.yaml`、`README.md` 与 `package.json`。宿主类型只 `import type`，编译期抹掉。

- 构建：包内 `pnpm bundle`（= 仓库根 `pnpm packages:bundle` 只对这个目录）。
- 发布：`npm publish --access public`，`prepack` 闸自动核产物在且非空、独占 `dist/`、tarball 过安装门白名单。
- 首发由人做一次；之后 bump `version` 合 `main`，CI（`release-recipes.yml`）跟版本自动发。
- 用户 `stream add @streamapp/netease` 装到比内置更高的版本 → 用户层的声明与代码顶掉内置那份（内置代码跳过）；
  相等或更低 → 内置为准。内置层自己不读 dist，直接 import `./activate.ts`。
