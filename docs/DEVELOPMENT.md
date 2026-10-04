# DEVELOPMENT.md — 开发手册

面向**日常开发运维**:起停、看日志、跑测试,以及切换到宿主原生之后最容易踩的几个坑。
概念模型(Target/Stream/Provider/Source/Plugin)看 [ARCHITECTURE.md](./ARCHITECTURE.md);
端口/网关规则看 [GATEWAY.md](./GATEWAY.md);接源/做包看 [PACKAGE.md](./PACKAGE.md)。

## 运行时形态(一句话)

**Stream 自己跑在宿主上,容器里只剩插件。** 后端是宿主上的原生 node 进程,直接绑
`127.0.0.1:8900`——**它自己就是那扇门**:`/api`、`/ws`、`/_p` 自己应答,其余路径落 8900 的独立
正门(`src/http/standalone-page.ts`,一张自包含页挂 `/panel/*` 的面板 bundle)。没有 Caddy,
没有 serve-backend/serve-frontend 容器,没有 `docker-compose.local.yml`。

**为什么后端必须在宿主上**:采集要能看见**用户自己那个 Chrome**——探测它、唤起它、和它同层;
容器里的进程够不到宿主的进程表和文件系统。(设计见
`internal design record`。)

整套容器化(backend+frontend+Caddy)只属于**自托管旁支**(NAS/VPS:那种形态没有"用户的浏览器"这一侧)
——`pnpm plugins compose --selfhost`,见文末。

## 起停 / 日志 / 测试

```bash
pnpm dev                                   # 后端(原生, caged 热重载) + 扩展的 WXT 监视器; Ctrl-C 一起收摊
docker compose up -d                       # 需要插件容器时另起(只有插件,没有 Stream 自己)
curl -s http://127.0.0.1:8900/api/health   # 健康 + 它跑的是哪一份代码:{"ok":true,"commit":...}
scripts/dev-stop.sh                        # 确定性收摊(端口/cage/锁/常驻服务),起之前 pnpm dev 自己也会先跑它
systemctl --user status stream-back        # 常驻后端(非开发态): Restart=always + 开机自启
```

- **常驻 vs 开发**:8900 上平时跑的是 `stream-back.service`(`scripts/stream-back.service`,
  软链进 `~/.config/systemd/user/`)。它常驻是因为**调度中心在后端进程里**——A 股申购/逆回购
  按点触发要靠它活着,挂在一个人手起的终端上就是单点。`pnpm dev` 进场先把它停掉(dev-stop),
  Ctrl-C 退场再把它起回来,所以开发完机器自动回到常驻态,不用记得手动拉。两者同时起会被
  `serve.ts` 的单实例锁挡住(后起的直接退出)。
  已知降级:由开机拉起时 WSL 的 interop 变量可能缺失,桌面控制插件够不到 Windows 侧;
  要用它就从终端跑 `pnpm dev`。

- **热更新**:只有后端 `tsx watch`(**轮询**,`CHOKIDAR_USEPOLLING=1`)和扩展的 WXT 监视器。页面从 8900 取,
  面板产物(`app/dist-panel/panel*.js`,Stream 的全部界面)**不在 watch 里**:改了 `app/src` 要
  手动构建。只建在改的那一份:`npm run build:panel -- main`(约 5s);不带参数全量(约 25s)。
  入口名见 `app/panel-entries.mjs`。

  没挂 watch 是量过的取舍:单个 `vite build --watch` 实测 **522MB RSS + 2% 单核空转**,五个
  入口约 3GB;而即便挂上,页面**仍要手动刷新**——`<script>` 装进去的 bundle 没有热替换通道,
  省下的只有那一条命令。
  后端为什么必须轮询、代价多少,见 `scripts/dev.sh` 里那一行的注释——**别改回 inotify 档**。
- **怀疑"改了没生效"就 `curl -s 127.0.0.1:8900/api/health` 看 `commit`**,别靠比日志时间戳猜。
  对不上就是没重载(轮询档理论上不该发生,但判据比信念可靠);`dirty_since_start` 数的是进程启动后
  又变过的 `.ts`,是提示不是告警——别的线未提交的 WIP 也会计进来。**活体验收 / A-B 实测开跑前先核这一口**。
- **后端日志直接在 `pnpm dev` 的终端里**,不用 `docker compose logs`。
- **测试/类型检查**:`pnpm test`、`pnpm typecheck`(后端);`cd app && npm run typecheck`(前端)。
  worktree 里**别 `pnpm install`**——把主检出的 `node_modules` 软链过来(根 + `app/` 两处),
  跑法见 `CONTRIBUTING.md` 的 worktree 一节。
- **全量跑要把整份输出存文件**,别 `| tail`(失败详情打在汇总**上面**,tail 只会留下一个
  「1 failed」的数字——通用规则见 `~/.claude/principles.md`):
  ```bash
  scripts/qrun.sh node_modules/.bin/vitest run > /tmp/vitest.log 2>&1; tail -6 /tmp/vitest.log
  grep -n -B2 -A20 'Failed Tests' /tmp/vitest.log      # 红了就翻这里
  ```
  **偶发红**(重跑就绿)循环撞:绿的日志删、红的留,撞一次就够定位。
  ```bash
  for i in $(seq 1 20); do
    scripts/qrun.sh node_modules/.bin/vitest run > /tmp/run-$i.log 2>&1
    grep -qE '[0-9]+ failed' /tmp/run-$i.log && { echo "CAUGHT -> /tmp/run-$i.log"; break; }
    rm -f /tmp/run-$i.log
  done
  ```
  qrun 是机器级单槽锁,连跑二十轮会让**别的会话/worktree 的测试一起排队**——开长循环前先看看
  有没有并行的线在跑。撞出红先分诊:测试文件总数、内置包数量这类背景数字变了 = 有人推进了
  `main`(先 `git log`),不是偶发。

> **别去 `logs/combined.log` / `logs/error.log` 找后端日志**——那两个是 RSSHub 自带 winston File
> transport 的遗留文件,已被 `NO_LOGFILES` 关掉,恒为 0 字节(它们没有 maxsize,2026-07-23 涨到
> 40GB 就是这么来的)。RSSHub worker 的输出被 Stream 自己接管、限长写进
> `logs/rsshub-worker.log`(`src/rsshub-worker-log.ts`)。

**起不来 / 半死不活时按这三条查**(都是宿主与容器共享资源造成的,和业务代码无关):

1. **`/api/health` 200,但日志里 `attempt to write a readonly database`** = `data/` 里有**别的 uid**
   写下的文件(root 属主的 SQLite/JSON),宿主上的后端打不开。半死不活最难认。修法(不需要 sudo):
   ```bash
   docker run --rm -v $PWD/data:/d alpine chown -R $(id -u):$(id -g) /d
   ```
   同一类:`data/ext-relay-token` 若是 `root:root 600`,后端读它会直接崩(见 `drive-live-ui` skill)。
2. **`ENOSPC: System limit for number of file watchers reached`**(后端与扩展监视器都走轮询、不吃配额;报这个的是别的 inotify 用户,如手起的 `vite build --watch`)
   = inotify 配额被这台机器上别的进程吃光了——watcher 在宿主上,**和所有宿主进程抢同一份配额**
   (常见大户:每个 Claude 会话一个的 CodeGraph MCP 实例,一个能吃十几万个 watch)。判据:
   `cat /proc/sys/fs/inotify/max_user_watches` 对比实际用量
   (`for f in /proc/[0-9]*/fdinfo/*; do grep -c ^inotify $f; done` 求和),再按进程排出大户。
   修法是抬配额(`/etc/sysctl.d/60-stream-inotify.conf` = 4194304),**别去杀别人的 MCP**。
3. **`/_p/<plugin>` 秒回 502**(不是超时) = 那个插件容器**不存在**,不是睡着——`docker compose down`
   会删容器,而 standby 只启停、不创建。修法:`docker compose create` 建回来(不启动),
   standby 照旧按需唤醒。收摊插件层用 `stop`,别用 `down`。

## 加一个后端依赖

后端跑在宿主上,所以就是普通的 `pnpm add <pkg>`,`tsx watch` 立刻热重载。原生模块按**宿主**编译,
只有一棵 `node_modules`,按宿主编译。

> **`pnpm <script>` 在跑脚本前会先校依赖并自动 `install`**(pnpm 11 的 `verifyDepsBeforeRun`)——
> 所以 `pnpm dev` **有可能顺手改你的 node_modules**:树和 lockfile 一有出入它就动手,撞上不属于你的
> 属主(root)就 EACCES 中断,`pnpm dev` 直接起不来。判据:输出里出现 `Packages: -N` 或
> `EACCES ... node_modules`。修法是让树对齐、属主归位:
> ```bash
> docker run --rm -v $PWD:/w alpine chown -R $(id -u):$(id -g) /w/node_modules /w/app/node_modules
> pnpm install
> ```
> **别去绕过校验**。急着起可以直接 `scripts/dev.sh`(不经 pnpm 包装器)。

> **自托管镜像**那一档的依赖是另一套规则:dev override 用**匿名卷**遮住 `/app/node_modules`(卷内容
> 在容器创建时从镜像播种一次,不会跟着 lockfile 走)。所以在那一档里加依赖要
> `docker compose exec serve-backend pnpm add <pkg>`(卷即时对齐),重建镜像**必带**
> `--renew-anon-volumes`。少带那个参数的代价:容器显示 `Up` 但 `/api/health` 不通 + 日志
> `Cannot find package '<x>'`,而且能这么挂十几个小时都不报错。

### 后端"改了代码没反应"——热重载的 watcher 死了,子进程还活着

**症状最坑的地方是它一点都不像故障**:页面正常、`/api/health` 200、日志干净,只是你改的每一行
后端代码都不生效。原因是 `tsx watch` 的文件监视崩了,而**它拉起的后端子进程不会跟着死**——
变成孤儿继续服务上一版代码。

**判据**(先问活体自己,再去数进程):

```bash
curl -s 127.0.0.1:8900/api/health           # commit 对不上 = 确实在跑旧代码,别再猜了
ps -eo pid,ppid,etime,cmd | grep serve.ts   # 子进程还在,但 PPID 不是 tsx watch(被 reparent 了)
ps -eo pid,cmd | grep "tsx.*watch"          # 空 → watcher 已死
```

`etime` 明显长于你最后一次改动的时间,基本可以钉死。

**根因**:RSSHub 是从**仓库外的绝对路径**引进来的(tsconfig 的 `@/*` → `$RSSHUB_SRC/lib`),
`tsx watch` 跟着 import 一路去盯它的 `node_modules`——几万个文件,轮询档白烧 CPU、inotify 档直接
把配额打穿。`scripts/dev.sh` 已经用 `--exclude "$RSSHUB_SRC/node_modules/**"` 排掉(RSSHub 自己的
`lib/` 照常热重载),并把结尾的 `wait` 改成 `wait -n`——哪条腿先倒就整摊收掉,不留半截摊子。

**遇到了怎么办**:别去 `touch` 文件(watcher 已经不在了,touch 谁都没用),重起 `pnpm dev`。

### 改了前端依赖版本 → 重新 `build:panel`,没有别的缓存要清

界面是 `vite build` 出来的面板 bundle,不经 dev server,所以 Vite 的依赖预打包缓存
(`app/node_modules/.vite/deps`,只有 dev server 用)对它不起作用。改了 react 之类的版本,
`cd app && npm run build:panel` 一次就是新的;浏览器仍看到旧版本,先直接问那份产物
(`curl -s 127.0.0.1:8900/panel/panel.js | grep -c <改动里独有的字面量>`)核它有没有真的重建,别去找缓存。

### 另起一份后端做冒烟/验收——三件必须做对,做错全是**静默**的

活体那份 8900 挂着调度中心(A 股任务真下单),所以要验"后端起不起得来""坏包会怎样"这类事,
**另起一份自己的**,别停它。三件一起做对才叫隔离:

```yaml
# <冒烟 data dir>/config.yaml
packages_dir: /tmp/.../pkgs      # ← 关键,见下
manage_containers: false
```
配 `STREAM_PORT=<别的口>` + `STREAM_DATA_DIR=<临时目录>`。**两个都要换**:单实例锁按
"端口 + pid 文件(或 `STREAM_DATA_DIR`)"判,只换端口要么起不来,要么两份后端对着同一份
`data/stream.db` 写。

- **`packages_dir` 不能指主检出那份**。第二份后端会加载全部内置包,它的 standby 管家
  `adopt()` 用户**正在跑**的容器,退出时 stop 掉——活体那份的 cell 状态还记着 "awake",
  `withAwake` 见 awake 直接短路,**再也不会把它拉回来**。表现是 AList 之类静默死掉,
  没有任何日志指向原因。指一个临时目录(空的,或只拷不声明 `stream.backend` 的包)即可。
- **软链没用,必须真拷贝**。`scanPackages` 用 `Dirent.isDirectory()` 判目录,软链目录返回
  `false`(它是 `isSymbolicLink()`)→ `loaded 0 plugin descriptors`,**不报错**。
- **用户层 recipe 目录是 `<STREAM_DATA_DIR>/data/recipes`,不是 `<STREAM_DATA_DIR>/recipes`**。
  `resolveDataDir` 取的是 `dirname(config.item_db)`,比 `STREAM_DATA_DIR` 深一层。

后两条的症状**一模一样**——"我放的包没加载",日志一个字不提。一起踩会表现成一片
`Unknown source`,很容易被读成"解析坏了"。

关进程按端口找 pid,别 `pkill -f`。任务中心的 8678 仪表盘会和活体撞 `EADDRINUSE`,
打一串栈但不影响后端启动。

## compose:只生成插件容器层

```bash
pnpm plugins compose        > docker-compose.yml            # 插件容器(baked 镜像)
pnpm plugins compose --dev  > docker-compose.override.yml   # 开发:声明了 backend.dev 的插件叠源码挂载+reload
docker compose up -d                                        # compose 自动合并两者
```

- 生成物里**没有 Stream 自己的 backend/frontend,也没有网关**——它们在宿主上。
- `docker-compose.override.yml` 是**生成物、已 gitignore**;改了 `packages/*/package.json` 后
  `pnpm plugins compose --dev` 重生成即带上新配置。
- **加一个 Plugin 不分叉**:descriptor 在 `packages/<id>/package.json` 的 `stream` 字段声明一次,两条 compose 都从它生成。
- 后端在宿主上够不到容器内网 DNS,所以插件走 **host 档**(`STREAM_PLUGIN_NETWORK=host`,`pnpm dev`
  已默认设好):每个插件容器发布一个 `127.0.0.1::<容器口>` loopback 随机口,standby 唤醒后 inspect
  出真实口直连。**生成物里只有插件容器**——登录态不经容器(扩展直推后端,见 `docs/PACKAGE.md` §5.2),
  所以插件全都是可选能力:一个不装,采集照跑。

### 自托管旁支(NAS/VPS):整套容器

```bash
pnpm plugins compose --selfhost > docker-compose.selfhost.yml   # 多出 serve-backend/gateway
docker compose -f docker-compose.selfhost.yml up -d
```

这一档里后端躲在 Caddy 后面(`STREAM_PORT=4555`,只 `expose`)、界面仍由后端自己的正门发、单一发布口仍是
`127.0.0.1:8900`。**它没有"用户的浏览器"那一侧**,登录源的拟人采集本来就不属于这个形态。

## 发布形态:分层安装(L0/L1/L2)—— 和 dev 流程是同一个后端

上面整份文档讲的是**本仓 dev 流程**(`pnpm dev`:宿主原生后端 + 扩展监视器,界面是预打包的面板 bundle)。**dev 与发布形态是同一个
东西**:两边跑的都是同一个原生 node 后端、同一个 `8900` 入口,差别只剩"谁把它拉起来"
(dev 是 `scripts/dev.sh`,发布是 MCP 客户端 spawn / OS 服务单元 / 用户自己敲 `stream`)和"前端从哪来"
(两边都是 `app/dist-panel/` 那几份面板 bundle,dev 只是要自己手动 `build:panel`)。

**L0 今天怎么装**:`npx @streamapp/stream`(包在 `cli/`,`node scripts/build-cli.mjs` 组装)。
启动契约只有一份——cwd 设成资源目录、跑 `server.mjs`、`STREAM_PORT`/`STREAM_DATA_DIR` 经 env 传。
**原生依赖不随 npm 包出货**,交给 npm 按用户平台装。数据默认落 `~/.stream`——和 native messaging 清单、Stream Desktop 的 data 指针
同一个目录,别再挑第二个。**任何会落盘的东西,缺省位置一律在这个根目录下**(`loadConfig` 里用
`underData(...)`,如 vault、各库、音乐下载 `music/`);只有用户自己在 `config.yaml` / 环境变量里设了才去别处。
别拿 `homedir()` 拼一个缺省路径——那是在用户家目录里凭空建一个他没要过的文件夹。

**发布形态**(用户装的 Stream)是分层安装:

```
L0 core 基座   node 后端 + MCP(一份代码,一个入口)   ← 始终存在,唯一不变量
L1 MCP 注册    stdio 命令写进客户端配置                ← 指向 L0,几乎总在
L2 常驻(可选) OS 服务单元(systemd user / LaunchAgent / 登录任务)  ← 指向 L0,运行时开关
```

**没有桌面壳这一层**:界面就是 8900 那扇门发的面板(以及用户 DSH 里那份 Stream UI 插件)。
纯 MCP 用户只装 L0+L1;常驻(L2)是一个正交的可选 add-on,只是"指向 L0"。权威定义见
[`docs/ARCHITECTURE.md` §Serving](./ARCHITECTURE.md#serving) +
`internal design record`。

**不落在这个分层模型里的只有自托管容器档**(整套 backend+frontend+Caddy 塞进 compose,面向
NAS/VPS)——它是第三条独立部署形态,见
`internal design record` §9。

## 发版验收:发出去的包在一台干净机器上成不成立

单元测试证明源码逻辑对;**发出去的 `@streamapp/stream` 在别人机器上装不装得上、起不起得来、功能通不通**
只有真装一次才知道(打包漏文件、原生依赖装不上、宿主版本注入错,单测全绿照样会栽)。每次 `npm publish`
之后对测试机跑一次:

```bash
scripts/release-verify-remote.sh win-test --version 0.0.26 --old 0.0.25   # Windows 测试机
scripts/release-verify-remote.sh mac      --version 0.0.26                 # Intel Mac
node scripts/release-verify.mjs --version 0.0.26 --old 0.0.25              # 本机(连不上测试机时先验脚本本身)
```

- **它不碰那台机器上正在用的 Stream**:新旧版本都 `npm i --prefix` 进临时目录,各起一份独立端口(8931/8932)、
  独立数据目录、`STREAM_NO_DESKTOP=1` 的后端(是脚本的子进程,不要登录会话、不要计划任务),测完连目录一起删。
  唯一的例外是**机器上有 `stream-*` 插件容器在跑**:验收后端会接管并在退出时停掉它们(见上一节冒烟那三件),
  所以这种情况脚本直接退出 2、不开跑。
- **判据只认副作用**:接口回来的真数据(认出的平台、真实视频标题、能加载的原生模块),不认「没报错」。
- **`--old` 跑负对照**:旧版必须**因为宿主版本**拒装 `--probe` 那个包、新版必须放行。只看新版放行证明不了
  闸门有牙。
- 退出码 0 全过 / 1 有检查失败 / 2 环境没备齐。标了「外网」的检查失败先排除网络。
- **一个发版让用户多了一件能做的事,就往脚本的 `CHECKS` 里加一条**——走用户会走的入口,断言回来的真东西。
- 测试机的坑:没人登录的 Windows 停在登录界面一会儿就睡眠(ping 不通);两台都要从 **Windows 侧 `ssh.exe`**
  连(WSL 直连卡在 SSH banner),预设写在 `release-verify-remote.sh` 头注里。界面那一层(按钮长得对不对、点了
  有没有反应)这个脚本验不到,要登录桌面后用 `drive-live-ui` 去看。

## 可选能力包:本地怎么试

`capabilities/netdisk/` 是**可选能力包**(填 `stream.capability` 槽位,契约见
[`PACKAGE.md` §5.9](./PACKAGE.md))。开发期跑它有三条路,按你要验什么挑:

| 要验什么 | 怎么跑 |
|---|---|
| **包自己的逻辑** | 在包目录里 `npm run typecheck` + `npm test` |
| **产物自包含**(有没有打漏一个相对 import) | `npm run bundle` 出 `dist/index.js`,再跑那个包的冒烟脚本(如 `capabilities/netdisk/scripts/smoke-managed.mjs`)。**冒烟跑产物不跑源码**——跑源码这条约束就白验了 |
| **整条缝**(安装门 → 落盘 → 动态 import → mount → 工具出现) | `scripts/qrun.sh node_modules/.bin/vitest run src/capabilities/optional-package.e2e.test.ts`。它真 `npm pack` 一个临时夹具包再走完整条路 |

**`stream add` 只认 registry**:安装门要 integrity 对得上,喂不进一个本地 tarball 或 `file:` 路径。
所以想在活体后端上试自己改的那份包,只有先 `npm publish` 一个预发版本这一条路;整条缝的回归靠上面
那条 e2e,不靠手工。

**装完不热装**:后端只在启动路径上扫一次 `<dataDir>/recipes/`,改完要重启它。装上了 `/api/packages`
里那一行的 `tools` 却是空的 —— 先重启,再排查。

## 带代码的内置包:出 npm 产物

`packages/` 里填了 `stream.code` 的 7 个包(bilibili / Douyin_TikTok_Download_API / xhs / netease / pansou /
eastmoney / alist)各出一份 `dist/index.js` 发 npm,内置层照旧以源码装载(契约见 [`PACKAGE.md` §3.8](./PACKAGE.md))。
`tsdown` 是**仓库根的 devDependency**,`pnpm packages:bundle`(`scripts/bundle-code-packages.mjs`)从根
`node_modules/.bin/tsdown` 取它逐包构建;包目录没有自己的 node_modules,`tsdown.config.ts` 因此写成裸对象、
不 `import 'tsdown'`。worktree 里根依赖没刷新时 `STREAM_TSDOWN_BIN=<主检出>/node_modules/.bin/tsdown` 借一份;
两处都没有脚本带安装提示退出 1,不静默跳过。`dist/` 是 gitignore 的构建物,`scripts/bundle-code-packages.real.test.ts`
真跑一次 xhs 的构建钉产物形状(找不到 tsdown 时红而不是跳过)。

## worktree 工作流

见 CONTRIBUTING.md 「Workflow」:每个任务开一个 worktree,不在 `main` 上 inline。热更新栈
bind-mount 的是 **main 检出**,worktree 的改动落到 main 才会被跑着的栈接住。

## Plugin backend 起容器

见 [PACKAGE.md](./PACKAGE.md) §7 / CONTRIBUTING.md 「Plugins」:唯一支持的方式是生成的 compose,
**禁止手写 `docker run` / `docker build`**——那会绕过共享 `stream` 网络、健康检查和凭据 broker。
