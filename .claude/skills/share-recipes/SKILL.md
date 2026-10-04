---
name: share-recipes
description: recipe 包（npm 分发）发布/安装/更新的唯一入口。凡是"怎么把写好的 recipe 分享出去"、"发一个新版本"、"装别人发的 recipe 包"、"npm publish/pack 一份 recipe"、"这个包能不能装/装了之后有什么权限"——都先来这里。分诊两条：发布侧检查清单（npm publish 前必须过的关卡）、消费侧流程（preview → install，装完怎么验、怎么卸载/查更新）。与写 recipe 本身（write-recipe）是两件事：这里只管"包好的 recipe 怎么流通"。
---

# share-recipes — recipe 包的发布与安装

一个 recipe 包 = 一个 npm 包。npm 只管身份（`@scope` 防撞名）、版本（semver）、托管（tarball）；
信任关卡（capabilities/effects 亮牌、rateLimit 钳制、文件白名单）和执行边界全在 Stream 宿主侧，
**不经 npm 客户端**——宿主直打 registry HTTP API 拉 tarball，install scripts 无从执行。

## 包形状

```
package.json          # 唯一描述文件：npm 字段归 npm，领域字段全在 "stream" 对象
<id>.recipe.json       # 1..n 个，recipe 自带 meta 自描述
README.md              # 人读说明；rateLimit 依据这类注释性内容放这里（json 无注释）
LICENSE                # 可选
```

`package.json` 的 `stream` 对象：

```jsonc
{
  "name": "@streamapp/xhs",          // 官方包 @streamapp/<facility>；第三方任意 scope
  "version": "1.0.0",
  "keywords": ["stream-recipe"],     // 必含——registry 搜索发现的约定键
  "stream": {
    "type": "recipe",
    "schemaVersion": 1,              // 宿主拒载比自己新的版本
    "facility": "xhs",
    "cookieDomain": "xiaohongshu.com",
    "rateLimit": { "burst": 5, "perMinute": 6, "maxWaitMs": 15000 }  // 站点按累计量拦人再加 perHour
  }
}
```

官方包一个 facility 一包（`@streamapp/<facility>`）；第三方任意 scope，也允许单 recipe 的包
（粒度由作者定，宿主不关心）。recipe 的常规配置面是自己的 `meta` 块（自描述，合成 SourceManifest）；
`manifests.yaml` 只剩全量覆盖逃生口，不是常规配置面。

## 发布侧检查清单

**仓库内置包（`packages/<id>/`）不要手发。** 合 `main` 后由 CI（`release-recipes.yml`）按
`package.json` 的 `version` 发：改了 recipe / 代码 → bump 该包 `version` → 合 main，CI 判定该包名已在
npm 上、且缺这个精确版本才发；发前脚本（`scripts/recipe-release-plan.ts`）核一遍 `npm pack --dry-run`
的白名单，和下面第 5 条、以及安装侧的判据是同一份。可发的 = 填了 recipe 槽位**或**代码槽位的包
（纯 recipe 包 29 个 + 带代码的 12 个，名单与数字由 `scripts/recipe-release-plan.test.ts` 钉着；另外 3 个带容器的带代码包
alist / pansou / douyin-tiktok-download-api 保持 `private`——安装门今天装不进带容器的第三方包，见
`project planning record`）。**前提：只有已经在 npm 上的包由 CI 跟版本**——
一个内置包**第一次**公开发布仍是人手动 `npm publish` 一次（哪些包公开是生意上的决定），CI 只接手已经
在 npm 上的包的后续版本，判定时对不在 npm 上的包打一行「首发请人工」；npm 明确回 E404 才算"没上过"，
别的失败（断网 / 限流 / 鉴权）让流水线红。

**带代码的内置包多两步，CI 与人手都一样：bundle → assert → publish。**

```bash
cd packages/<x>
pnpm bundle                       # = node ../../scripts/bundle-code-packages.mjs .  → dist/index.js（尊重 STREAM_TSDOWN_BIN）
npm publish --access public       # prepack 自动跑 scripts/assert-npm-artifact.mjs：入口在且非空、独占 dist/、tarball 过白名单
```

CI 里 `pnpm packages:bundle` 先给 7 个包全出一遍产物，`--publish` 对每个要发的带代码的包再 bundle + assert 一次。
`dist/` 是 gitignore 的构建物，干净检出上没有——漏了 bundle 这一步，`prepack` 闸会以「入口不存在」退出 1，不会发出空壳。

**同名与不同名两层的规矩**（用户装了你发的包之后会发生什么）：同一个 npm 名（`@streamapp/xhs` 装到比内置更高的版本）
→ 用户层的 facility 级声明**与代码**顶掉内置那份（内置代码跳过，日志 `supersedes builtin`）；相等或更低 → 内置为准。
**不同 npm 名**（第三方给同一个 facility 的附加包）→ 版本不可比，声明以内置为准，用户层只叠加 recipe 与内置没声明的格。
细则见 `docs/PACKAGE.md` §0.5。

发布前逐条过，`npm publish --access public` 才是最后一步：

1. **`stream` 字段齐且过 schema。** 对着 `parseStreamDescriptor`（`src/packages/descriptor.ts`）自查
   ——安装口与目录扫描共用它这一把尺。两形都受理：旧形（`type: 'recipe'` + `facility` + `schemaVersion`）
   与新形（`id`，无 `type`）；写旧形时 `schemaVersion` 别超出宿主当前支持的
   `RECIPE_PACKAGE_SCHEMA_VERSION`。（`src/…` 那两条只有 Stream 源码检出里读得到；**没有源码
   时用活体那一口自查**——把包目录整份放进 `<dataDir>/recipes/`，然后
   `curl -s 127.0.0.1:8900/api/recipes/local`：过不了 schema 的包会带着**原文**出现在
   `packages[].error` 里，比读源码更直接，而且验的是宿主真正那把尺。）
2. **effects 如实申报——这是发布者的诚信义务，宿主不做交叉验证。** 装包时安装 preview 展示的
   capabilities/effects 直接读自包 `meta` 里写的什么，不会去跑一遍 recipe 验证它有没有说谎。
   一个会点赞/收藏/转存的 recipe 只要不写 `effects: ['write']`，确认页就会显示"无副作用"。
   **任何带写操作（点赞、收藏、转存等 interact 动作）的 recipe 必须标 `meta.effects: ['write']`**；
   缺省 = 只读。
3. **rateLimit 有依据，写进 README。** `rateLimit` 是站点的属性——多个包落到同一 facility 会被
   宿主取最严值钳制，写清楚这个数字是怎么定的（实测/官方文档/保守估计）。
   **站点按累计量拦人就再加一格 `perHour`**（`{ burst, perMinute, perHour?, maxWaitMs? }`）：
   `burst`/`perMinute` 只管「一阵能打多密」，管不了「一小时总共打了多少」——Google 拦的正是后者。
   撞满 `perHour` 是**立刻拒**（不等 `maxWaitMs`），调用方据此回落。没有实测就别填这一格：
   凭手感填的闸门坏起来的样子是「这条腿常年缺席」，而且不报错。
3.5 **`serving` 如实申报、`reason` 写清依据。** 它让 Stream **后端**替你的包去连 `hosts` 里的主机——
   安装确认页会把 match ∪ hosts 亮成 `proxies`。私网/loopback/单标签 host 会让整个包拒装。备选主机
   为什么是这几台、怎么测的，写进 README（范例 `packages/lizhi/README.md`「CDN」一节）。
   `retires` 只放两类 RSSHub 路由：上游已经使它跑不通的，和你的包里一条源**接管了同一条路由**的
   （目录里再留它，内容搜索就出两份）。别拿它挤掉一条还能用、且你没有等价源的路由。
3.6 **`providers` / `links` / `rsshubNamespaces` / `rsshubCookieEnv` 这几格 facility 级声明，写了就要负责。**
   - `providers[]`：你的包会在用户的 Provider 页面上**建出一整行**（标 `system:true`，装着就删不掉），
     重启后端后才出现。`id` 与 `serveKeys` 撞了现有行 → 这一行被拒（其余照装），日志里会说撞了谁。
     别拿通用词当 `serveKeys`（`music`、`track` 这种）——那等于替所有同类平台认领分发键；也别写域名
     （键一律 `<platform>-<名词>`，如 `<platform>-link` / `<platform>-video`）。
   - `links`：`hosts`（认领的主机）/ `shortHosts`（短链，须被 hosts 覆盖）/ `patterns`（`track` 带命名组
     `id`；`download-page` 以 `$` 结尾、带 `yields`，兼作宿主抓取的白名单）。pattern 必须以 `^https://` 或
     `^https?://` 开头、主机段的域名必须在你自己的 `hosts` 里——违反任一 → **整个包拒装**；主机或平台撞了
     别的包 → 你这份 `links` 整份被拒（日志说撞了谁）。它决定"贴这条链接进来算谁家的"，写宽了就是抢别人的 URL。
     老写法 `trackUrl` / `downloadPages` 仍受理（装载时翻译进 `links`），新包别再写。
   - `rsshubNamespaces[]`：两个包认领同一个命名空间 → 装载期抛。只认领你真的实现了 normalizer 的那些。
   - `rsshubCookieEnv`：RSSHub 要的 cookie 环境变量名模板（`NAME_{CookieName}`，文法不对整个包拒装），
     按你的 facility 和你认领的每个命名空间登记；同一个键两个包给不同模板，后到的被忽略。

   这些都不是插件槽位：只填它们的包仍是纯 recipe 包，不进 `/api/plugins`。
4. **keywords 含 `"stream-recipe"`。** registry 发现唯一认这个 keyword，不认包名规则。
5. **`npm pack --dry-run` 核对 tarball 内容**——宿主安装器是 fail-closed 白名单。受理的是这些
   **平铺**（不带任何目录分隔符的）文件：
   - `package.json`
   - `*.recipe.json`
   - `README`（可带 `.md`/`.txt`/`.markdown`/`.rst`）
   - `LICENSE` / `LICENCE`（可带 `.md`/`.txt`）
   - `NOTICE`、`CHANGELOG`（可带 `.md`/`.txt`）
   - `manifests.yaml`

   外加**唯一一个代码入口**：字面路径 `dist/index.js`——白名单里唯一带 `/` 的例外，用 `===` 比，
   所以 `./dist/index.js`、`dist//index.js`、`DIST/INDEX.JS`、`dist/index.mjs` 全都不受理。它还
   必须在 `package.json` 的 `stream.code.entry` 里申报（申报了却没这个文件、有这个文件却没申报，
   两种都是拒装——后者是夹带代码）。带代码的包在安装确认页是最响的一档。

   其余一律**整包拒装**：任何别的代码文件（`.ts`/`.mjs`/`dist/` 下的其他文件）、任何含 `/` 的
   其他路径（子目录）、任何含 `\` 的路径（Windows 上它就是路径分隔符）。发布成功不等于装得上，
   `npm pack --dry-run` 是发布前唯一能提前发现这个坑的办法。
6. **版本号语义。** 改了 recipe 行为（selector、mapping、observers）= minor 起步；纯文案/README
   改动才是 patch。

### 带代码的包：多出来的几条

一个包可以只带数据（recipe / 清单），也可以**同时**带一个代码入口。带代码的，上面六条照过，另加：

1. **入口预打包成单文件 ESM，依赖全部打进去。** 宿主装完**不跑 `npm install`**，包目录里不会有
   `node_modules`。漏打一个依赖 = 启动时 `ERR_MODULE_NOT_FOUND`，**这个包这次就是不生效**——
   Stream 其余部分照常起来，通知中心出一条"扩展包未生效：<id>"，后端日志里有完整原因。
   `dependencies` 写不写都不影响宿主，能跑起来的只有你 bundle 进去的那份字节。
2. **类型从 `@streamapp/plugin-sdk` 取**（`ActivateFn` / `PluginContext`），**运行时工具也只从它取**
   （`ValidationError` / `ContentUnavailableError` / html 工具 / `mediaPlayUrl` / `BROWSER_UA`——同一批住在
   `shared/package-sdk/`，bundle 进你的 dist；宿主按鸭子标记 `validation: true` / `unavailable: true` 认，
   不 `instanceof`）。宿主单例一律经 `ctx`，别的宿主代码一律 `import type`——三条规则见 `docs/PACKAGE.md` §3.7。
   宿主对第三方代码**不做 typecheck**，SDK 只是给你自己用的形状。`activate(ctx)` 契约见 `docs/PACKAGE.md` §3.2。
3. **`stream.code.adapters` / `normalizers` 的名单必须与 `activate` 实际返回的键一字不差。** 多返回的、
   声明了没返回的，两边差集都抛错。名字还不能撞**内置**（含宿主自己的 `builtin`/`rsshub`/`replay`/`browser`）
   或用户**已经装着的另一个第三方包**——撞了是**安装期**拒，不是运行期覆盖。
4. **`stream.backend`（容器格）能申报，但只能申报钳制得住的那个形状**——见下一节。
5. **`stream.hostVersion` 只支持 `>=X.Y.Z`。** `^`/`~`/x-range 一律拒。不确定就别写——写错了是硬拒，
   不写没有任何代价。
6. **告诉用户要重启。** 代码只在 Stream 启动时 import 一次：装、升级、卸载都要重启后才生效
   （已加载的 ESM 模块运行中卸不掉）。UI 会说这句，README 里也说一遍。
7. **心里有数：这个包在用户那儿是最响的一档警示。** 安装确认页把它评成 `code` 档（高于
   `effects: write`），摆出代码入口、会占用的注册名，并明说"和 Stream 同权限：能读全部 cookie 和
   token、能以用户身份向任意地址发请求"。**官方 `@streamapp/` scope 不豁免这一档。** 能用 recipe
   数据表达的能力就别用代码写——那是纯数据包（`plain` 档，不罚站）。

### 带容器的包：宿主会把你的声明钳成什么

一个包可以在 `package.json#stream.backend` 里声明一个后端容器（镜像 + 端口 + health + env + 卷）。
**宿主不原样收**：安装期先过一遍钳制（`src/packages/container-policy.ts`），不合规**当场拒装**、
合规的**改写成安全形态**再落盘。落盘的 `package.json` 存的就是钳制后的那份——你在确认页看到的、
后端建容器时读到的，是同一份字节。

**宿主替你决定的三格（别自己写）**：

- **`service` 名由宿主指派，恒等于你的包 id**。自己写 `service` 一律拒。容器对外的地址就是
  `/_p/<包 id>/`。（这个名字是全局单一命名空间：网关路由、standby 名册、compose service key
  三处共用，所以只能宿主发。包 id 已被撞名闸门保证唯一。）
- **命名卷加包前缀**：你写 `data:/var/lib/x`，实际挂的是 `<包 id>_data`。不加前缀的话两个包各自
  写 `data:` 就成了同一个 docker 卷。
- **`standby` 缺省兜 30 分钟闲置回收**（stop，容器和卷原地留着，下次用到再唤醒）。你可以自己写
  一个更合适的值。这个兜底值会出现在安装确认页上——用户看到的是「闲置 30 分钟后回收」。

**一律拒（消息里会说该怎么改）**：

| 拒 | 为什么 |
|---|---|
| 写了 `backend.service` | 宿主指派，见上 |
| 写了 `backend.publish` | 那会在宿主上多开一个对外端口 |
| 写了 `backend.dev` | dev 覆盖会把宿主源码目录 bind-mount 进容器 |
| `backend.gpu: true` | GPU 是独占稀缺资源；没装 nvidia container toolkit 的机器上容器根本起不来，表现成「装上了一直起不来」 |
| 缺 `backend.mem` | 不声明 = 不限制 = 可以吃满宿主内存。必填 |
| `backend.mem` > 4G | 第三方上限 |
| `stream.id` 不匹配 `^[a-z0-9][a-z0-9_-]*$` | id 会被指派成 service 名，于是同时是容器名、卷名前缀和 URL 路径段；撞名闸门是精确比较，`Alist` 挡不住内置的 `alist` |
| `backend.health` 不是以单个 `/` 开头的本机路径 | 探活 URL 是宿主后端拼出来的：`'@evil.com/'` 会拼成 `http://127.0.0.1:<口>@evil.com/`（host 是 `evil.com`），`'//evil.com/'` 同理。写 `'/healthz'` |
| `standby.startTimeoutSeconds` > 300 | 容器备齐是宿主启动时 await 的串行循环，这个数就是"你的容器起不来能把用户开机卡多久" |
| `standby.idleMinutes` > 1440 | 超过 24h 不回收等于声明常驻 |
| `volumes` 里有宿主路径 bind（`/host/path:/x`、`./x:/x`） | 那是把宿主文件系统交出去。只收命名卷 `name:/绝对路径` |
| `volumes` 超过 4 个 | 每个卷都是宿主上长期占地的存储 |
| `env` 超过 32 条，或某个值超过 4096 字符 | env 原样进容器，超长值多半是把配置/密钥整个塞了进来 |
| `env` 名以 `STREAM_` 开头 | 那是宿主往容器里注入用的命名空间，塞同名值会顶掉宿主注入的那个 |
| service 名（= 包 id）已被占用 | 撞了就是两边抢同一条 `/_p/` 路由 + 同一个 standby 名册位。换个 `stream.id` |

**凭证由宿主派发，容器不自己去要**：`stream.credentials: [域]` 是一张**许可名单**——申报之后，
宿主在调用你的容器时把那一次需要的登录态递下去。你的容器里**没有**任何常驻凭据，也不该有：
**别把 cookie/token 烘进镜像或写进 `backend.env`**，生成的 compose 里也一个都不会有。
（曾经有一条「容器带 token 反打 broker」的路，已撤销——方向反了，见 `docs/PACKAGE.md` §5.1。）

**心里有数的两件事**：

1. 带容器的包在安装确认页是 `container` 档（`plain < elevated < container < code`），页面会摆出
   **镜像全名、内存上限、卷、env 键名、能取到的登录态域、闲置多久回收**，并触发慢速确认门。
2. **装上不等于跑起来。** 后端自己建容器要用户开 `manage_containers`（默认关闭）。关着的时候
   宿主一个 docker 写操作都不发，你的容器不会被建出来。README 里说这句。

## 消费侧流程

装包首选走界面：侧栏「管理 → 包」（`/packages`），右上角「添加包」。一个搜索框同时做两件事——
输关键词按 `stream-recipe` 约定搜 npm，输完整包名（`@scope/name` 或裸名）直接给出安装项（刚发布
的包常还没进 npm 搜索索引，这条路绕过它）。点安装先走 preview，把 facility / 钳后限流 / 每个 recipe
的能力副作用 / 将覆盖的内置源摆出来再让你确认；**带 `effects: ['write']` 的包、或第三方包覆盖内置源，
首次点击不安装**，要再点一个点名具体风险的按钮。装完它就落在同一页的「抓取配方」段里，那一行的
··· 菜单管卸载与更新（更新走同一条 preview → 确认 → install）。

下面这套端点是同一条路的机器接口（agent / 脚本用）：

```
POST /api/recipes/packages/preview  { name, version? }
  → 人读返回的 facility / cookieDomain / 钳制后的 rateLimit / 每个 recipe 的
    id / description / capabilities / effects / params_schema
  → 拿到一个 confirm 凭据（对包名+版本+tarball 摘要的签名）
POST /api/recipes/packages/install  { name, version?, confirm }
  → confirm 必须来自上一步 preview 的返回值，凭据不匹配拒装
```

**装第三方包、尤其带 `effects: ['write']` 的，先把 preview 返回的 effects 看清楚——那是包作者
自述，不是宿主保证。** 宿主只钳制 rateLimit、只挡文件白名单和 schema，不会替你验证一个包是否真的
只做它说的那些事。

装完验证：

1. `GET /api/sources`（或 `stream_sources` MCP 工具）确认新 source 出现在列表；
2. 跑一次采集，确认真的产出数据（不是装上就算数）。

其余端点：

- `POST /api/recipes/packages/uninstall { name }` —— 卸载（收容器 + 删目录 + 重挂载）。**带代码的包
  卸载后要重启 Stream** 才真正卸下——删的是磁盘文件，已 import 的 ESM 模块运行中卸不掉。
  声明了 `backend` 的包，它那个 `stream-<service>` 容器会被停掉并删除（**不看 `manage_containers`**：
  那个开关管"要不要替你建"，收自己建的东西不受它管；compose 起的 `<project>-<service>-1` 名字对
  不上，一根汗毛不碰）。docker 够不着时卸载照常成功，但会发一条通知说清要手工 `docker rm -f` 什么。
  **命名卷不动**——那是数据，删掉不可逆。
- `GET /api/recipes/packages/updates` —— 对比内置版 / 已装版与 registry latest，只报不装。CLI 用户走
  `stream update [<pkg>…] [--yes]`：不带参数列出每个内置包和每个已装第三方包的内置版 / 已装版 / npm
  版；官方 `@streamapp/` scope、没有新增 `meta.effects`、也没有新带代码格 / 能力格（当前版是纯数据包、
  新版带 `dist/index.js`）的直接装，否则打印 preview 要求 `stream update <pkg> --yes` 才装。后端在场走
  热挂载（装进 `<dataDir>/recipes/` 后立即生效），不在场下次启动生效。后端自己每天查一次（调度中心的
  `recipe-update-check` 任务，可手动立即跑一次），只在日志里提示。
- `GET /api/recipes/packages` —— 已装清单：`{name, version, facility, sourceIds, hasCode}[]`（市场页已装区的
  数据源；`hasCode` 决定卸载确认页要不要说"重启后才真正卸下"）。`sourceIds` 是**全名**
  （`<npm 包名>/<局部名>`，见 `docs/PACKAGE.md` §1.1）——recipe 文件里写的那个是局部名，前缀由宿主合成。
- `GET /api/recipes/packages/search?q=<关键词>` —— 按关键词搜 recipe 包：`{name, version, description}[]`。
  `keywords:stream-recipe` 限定与 registry 地址**由服务端固定**，接口收不了 URL、收不了 registry 主机
  （一个"帮我 fetch 这个地址"的端点等于给后端开了个 SSRF 口子）。

registry 地址可配（env `STREAM_NPM_REGISTRY`，默认官方源，可切 npmmirror）。切了镜像之后 `@streamapp/` 包会多向官方源核一次校验和，核不上的照装但不拿凭据（`docs/PACKAGE.md` §1）——用户报「从镜像装了官方包、登录态没注入」先看包目录里有没有 `.stream-trust.json`，里面写着原因。

## 已知表达力上限

recipe 的 `meta.radar` 是 `string[]`，表达不了 rule 级的 target 特化。需要针对具体 target 覆盖
行为的 recipe，只能退回手写 `manifests.yaml` 的全量覆盖口——这不是 bug，是当前 schema 的边界。

## 相关

- 从零写一份 recipe → `write-recipe` skill。
- 包形状与校验关卡的权威设计 → `internal design record`。
- Recipe 概念契约（`meta`/effects 字段语义） → `docs/PACKAGE.md` §2（recipe 槽位）。
