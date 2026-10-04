# Stream skills — 组织规范（读这个再改 skill）

`superpowers:writing-skills` 讲**怎么写**一个 skill（RED-GREEN、description 规范、bulletproof）。
这份讲**在本项目里放哪**——因为本项目对 skill 的**数量和入口**有强约束，写得再好、放错地方也是错。

## 核心规范：少入口、一域一门、how-to 进 references

**本项目的 skill 是一组"域入口/路由器"，不是 how-to 大杂烩。** 每个顶层 skill 是**一个域的唯一入口**，
自己**分诊 → 判路 → 派发**。具体落地手段（某一档怎么做、某个坑怎么绕）放在**那个入口 skill 的
`references/*.md` 里**，从它的分诊表/成本阶梯/Resources 接线。

**要加新内容时的判据（先问这一句）：**

> 我要写的东西，是**一个已有入口已经会路由到的落地/how-to**，还是**一个全新的、需要自己分诊的域**？

- **前者 → 写成那个入口的 `references/xxx.md`，并在入口里接一行。** 不要新立平级 skill。
- **后者（真·新域，有自己的触发面和判路）→ 才新建一个顶层 skill。**

**为什么**：用户只想记住**尽可能少的门**。每多一个平级 skill，就多一个他得知道去敲的门；而绝大多数
"新内容"其实是某个已有入口的一档落地，做成 reference 就能被那扇门自动路由到。

## 当前入口（域 → 门）

| 域 | 入口 skill | 落地放哪 |
|---|---|---|
| 把内容源/后端接进来（分诊 + 成本阶梯） | `onboard-source` | `references/`（tier-1 第三方后端 `via-external-backend.md`、tier-1 自建镜像 `authoring-backend-image.md`、找候选、wiring…）；重活派 `rsshub-routes`/`write-recipe` |
| **写一份可重放的 recipe 驱动界面**（采集或动作；浏览器 / 桌面 / 将来手机）——写、跑、观察、修 | `write-recipe` | 自己的 `references/`：共通的在 `pipeline.md`/`failure-atlas.md`，**面特化的在 `surface-<面>.md`** |
| 看一眼活着的页面 | `drive-live-ui` | 内联 |
| RSSHub 路由（成本阶梯第 2 级落地） | `rsshub-routes` | — |
| 网盘匹配漏配→回归覆盖 | `diagnose-netdisk-match` | — |
| 无人值守做 TODO（挑条→派发→合并→摘条，配 `/loop` 循环） | `todo-auto` | 内联 |
| 发布/安装 recipe 包（npm 分发） | `share-recipes` | 内联 |
| 购买决策（选"买什么"：调 `purchase_decide`、读回执、讲结论） | `purchase-decision` | 内联；`scripts/`（回执→markdown、验收） |
| 影视网盘（找片 / 追更 / 归档整理：`netdisk_follow`、`reconcile_*`、`netdisk_sync`） | `netdisk-library` | `references/`（找片+追更 `find-and-follow.md`、归档 `archive.md`）；改匹配器代码仍派 `diagnose-netdisk-match` |
| 挂/改/重排定时任务（判互斥 → 定排期 → 迟到语义） | `stream-cron` | 内联 |
| 用 Stream 工具的通用纪律（派不派子 agent） | `stream-assistant` | 内联 |

## 这份规范防的那个具体错（真发生过）

"构建一个 Stream 自建的 ML 模型后端容器"**不是新域**——它是 `onboard-source` 成本阶梯 **tier-1 的
"自建镜像"那一半**。它该是 `onboard-source/references/authoring-backend-image.md`（已就位），
**不是**一个叫 `authoring-ml-backend-container` 的平级 skill（一度错立、已并回）。

判据复述：能被某个已有入口路由到 → reference；否则才新 skill。

## 第二个反例：**别按"面"立门**

桌面客户端能力上来之后（手机在路上），一度想立 `desktop-recipe` 平级 skill。那是错的，同一条判据：
**域是"写一份可重放的 recipe 驱动界面"，浏览器 / 桌面 / 手机是这个域里的三档落地**，不是三个域——
它们共用 recipe 的词汇、runner、账本、drift 语义，只是"怎么指一个东西"和各自的坑不同。
所以落成 `write-recipe/references/surface-<面>.md`，入口那张"你在哪个面上"的表负责路由。

**这件事顺带教了另一课：门的名字会过期。** 原来那扇门叫 `browser-harvest`——`browser` 把面写死了，
`harvest` 把目的写死了（`wechat-send` 是动作 recipe，什么都不采）。名字里带着**今天恰好只有这一种**
的限定词，等于给自己埋一次改名。**改名不是免费的**：97 处引用要回补，而且 skill 是出货给用户的，
用户机器上那份旧名不会自己消失（清理机制见 `src/skills/shipped.ts` 的 `RETIRED_SKILLS`）。

## 关系

- **怎么写**一个 skill / reference（TDD、description、bulletproof）→ `superpowers:writing-skills`。
- **概念与不变量**（Source/Provider/Plugin/Channel）→ `docs/ARCHITECTURE.md`。
- **Stream 包标准**（描述符/槽位/compose/凭证/recipe 契约）→ `docs/PACKAGE.md`。
- 各入口 skill 自己是其域的唯一真相源，别在别处复述它的运行经验。
