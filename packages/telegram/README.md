# @streamapp/telegram — Telegram

Telegram 的站点知识住在这个包里：一份桌面 recipe（`telegram-search`，经 Stream Desktop 读 Telegram 客户端的
a11y 树，在指定频道里搜关键词）+ 一格代码槽位。

## 能力

| 能力 | 谁提供 | 说明 |
|---|---|---|
| **采集**频道内搜索结果 | recipe `telegram-search`（kind:desktop） | 一条消息的整段正文落在 `content` 字段，标题由 recipe 的 `map` 抽 |
| **渲染**消息 | normalizer `telegram`（`normalizer.ts`） | 资源频道消息 → 链接卡（`archetype:'link'`）：网盘链接列成卡片、正文只留「描述：」那段 |
| **资源搜索**里怎么认 | `package.json#stream.searchSources` | 展示键 `telegram`、查询参数 `q`、形状 `digest`（一条消息 = 片名 + 一串网盘链接的合集体）。它不是网络请求，是点窗口、等渲染，一趟约 12s，所以 recipe 自己申报 `member_timeout_ms: 25000` |

normalizer 自带一张**网盘域名 → 中文名**表（夸克 / 百度 / 阿里 / 天翼 / UC / 115 / 123 / 移动 / 迅雷 / PikPak），
只用来给链接卡起名；带提取码的写成 `夸克网盘 · 提取码 xxxx`。认不出的域名原样显示 URL，不安「网盘」名头。
抽不到「描述：」（广告条、频道互推）就退回整段原文，不产出空卡；标题只认 recipe 抽好的那个。

整段正文字段叫 `content` 不是随便挑的：资源搜索的解析器按 item 形状认领，认的就是 `content` 里的下载链接。
同一段正文有两个消费者（收件箱渲染 + 搜索解析器），字段名必须是两者都认的那一个。

## 存量条目

`Content` 在采集期落库，这次归包 normalizer 逻辑没变，存量条目不用重跑。

## 发布

代码槽位由 tsdown 打成单文件 `dist/index.js`（`package.json#stream.code.entry`）；构建在仓库根
`pnpm packages:bundle`（或包内 `pnpm bundle`），`prepack` 闸核产物。内置层不读 dist——它直接 import
`./activate.ts`（`packages/index.ts`）。bump `version` 合 `main` 后由 CI 发 npm。
