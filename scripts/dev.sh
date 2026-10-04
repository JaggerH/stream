#!/usr/bin/env bash
#
# Dev launcher — 一条命令，零容器，一个入口：
#   • 先 dev-stop 清干净，无论上一次是怎么结束的
#   • 后端原生跑在宿主上（:8900，caged 热重载）——它自己就是那扇门：/api、/ws、/_p、/panel
#     自己应答，其余落 8900 的独立正门（src/http/standalone-page.ts）
#   • **没有 Vite**：界面由
#     `app/dist-panel/panel*.js` 这几份构建产物发出去——**改了面板源码要手动构建**：
#     `cd app && npm run build:panel -- main`（只建你在改的那一份，约 5s；不带参数全量 25s）。
#     没给它挂 watch 是量过的取舍：单个 `vite build --watch` 实测 522MB RSS + 2% 单核空转，
#     五个入口约 3GB，而即便挂上页面**仍要手动刷新**（<script> 装进去的东西没有热替换通道）
#   • 插件容器走 host 档（loopback 门），后端在宿主上照样够得到；没起插件容器也不影响启动
#   • Ctrl-C / 关终端 = 全部收摊（dev-stop），零孤儿
#
# 后端出容器之前这里是 docker compose（gateway + serve-backend + serve-frontend）；那套现在
# 只剩自托管旁支，见 docs/DEVELOPMENT.md。
set -euo pipefail
cd "$(dirname "$0")/.."
export STREAM_DEV_UNIT="${STREAM_DEV_UNIT:-stream-back-dev}"
export STREAM_PORT="${STREAM_PORT:-8900}"
# 后端在宿主上，够不到 compose 内网 DNS —— 插件一律走那扇 loopback 门
export STREAM_PLUGIN_NETWORK="${STREAM_PLUGIN_NETWORK:-host}"
# 后端热重载走**轮询**，不走 inotify。**别把这行删了改回默认。**
#
# 默认那档（inotify）在这个仓库里会静默漏改动，而且是不可逆地漏：tsx watch 不监视目录，只对
# "子进程加载过的每个模块"逐个挂 watch；chokidar 的文件监听器整体包在一个「同路径 5ms 节流」里，
# 而"文件被换了 inode → 重新挂 watch"的补救逻辑就在这个节流**里面**。任何写法只要让两个事件
# 挤进同一个 5ms 窗口（原地写完紧接着 rename 换 inode——编辑器、格式化工具、agent 的写文件工具
# 都是这个形状），补救就被丢掉，watch 从此停在死 inode 上。更糟的是它**不自愈**：chokidar 的
# `_handleFile` 开头有 `if (parent.has(basename)) return`，重启子进程后重新登记这个路径是空操作。
# 于是那个文件对这个 tsx 父进程**永久失聪**，而且随运行时间累积——实测跑了 15 小时的父进程已经
# 聋掉 78 个 src 文件，包含 app.ts / bootstrap.ts 这种核心文件。
#
# 症状极贵：页面正常、health 200、日志干净，你改的每一行都不生效。此时"开关没通电"和"改了也
# 没差别"长得一模一样——照后者下结论就是错的（已经因此白跑过一整轮 A/B 实测）。
#
# 代价是实测的：轮询让 watcher 常驻约 **3% 单核**（放大档量的：1084 个文件 5.95%，真实监视集
# 约 490 个文件）。默认 inotify 档是 0%。这个交换值得——3% 换"改了就一定生效"。
# 嫌贵就调 `CHOKIDAR_INTERVAL`（默认 100ms，调大省 CPU、换重启延迟变长），别关轮询。
export CHOKIDAR_USEPOLLING="${CHOKIDAR_USEPOLLING:-1}"

scripts/dev-stop.sh # guarantee a clean start regardless of how the last session ended
cleanup() {
  trap - EXIT INT TERM # disarm so teardown runs exactly once
  scripts/dev-stop.sh
  # 把 8900 交回常驻服务（scripts/stream-back.service）。**开发结束不等于这台机器不需要后端**
  # ——调度中心跑在里面，A 股的申购/逆回购按点触发要靠它活着。Ctrl-C 之后留下一台没有后端的
  # 机器，正是这个仓库已经踩过两次的那种静默死法。服务没装（enable 过）就什么都不做。
  if systemctl --user list-unit-files stream-back.service >/dev/null 2>&1; then
    systemctl --user start stream-back.service 2>/dev/null \
      && echo "[dev] 8900 交回常驻服务 stream-back.service"
  fi
}
trap cleanup EXIT INT TERM

# 后端（:8900，caged 热重载）。**`--exclude` 那一段不能删**：RSSHub 是从仓库外的绝对路径引进来的
# （tsconfig 的 `@/*` → `$RSSHUB_SRC/lib`），tsx watch 跟着 import 走，会一路去盯它的 node_modules
# ——那是几万个文件：轮询档会拿它们白烧 CPU，inotify 档则把配额打穿、watcher 当场 `ENOSPC` 崩掉。
# 崩掉的样子极其阴险：**后端子进程不会跟着死**，它变成孤儿继续正常服务，只是从此再也不重载。
# 表现是"改了代码没反应"，health 200、日志无异常，查半天查不到——已经因此白查过一整轮
# （所以 health 现在会报 commit：`curl 127.0.0.1:8900/api/health` 一眼就能核）。
# 只排掉 node_modules，RSSHub 自己的 lib/ 照常热重载。
#
# **`--include` 那一段同样不能删**：tsx watch 只盯"子进程 import 过的模块"，而包清单
# （`packages/*/manifests.yaml`）是运行期用 fs 读进来的，不是 import 的——不显式加进来，
# 改了清单活体永远是旧的：source 的标题、参数 schema、discoverable 全停在上次启动那一份，
# 而 health 的 commit 是对的、日志一个字都没有。同一个坑扩展和工作台插件各栽过一次
# （见下面那两条 watch 的头注），判据都是"这份东西不经 import 进来"。
#
# **`STREAM_RESTART_MODE=watch` + `--include restart-sentinel` 是一对，别只删一半**：`POST /api/restart`
# 在这一档不自己退——tsx watch 不看退出码，子进程退了它就干等下一次改文件——而是碰一下仓库根的
# `restart-sentinel`，让 tsx 按"文件变了"那条路 SIGTERM + 拉起。不显式说自己是 watch 档的话，
# 后端会按 env 自动判：这个脚本常在 `systemd-run --user --scope` 里跑，那时 `INVOCATION_ID` 是从
# systemd 用户服务**继承**来的，会被误判成"有监护者"→ 退 75 → 没人拉起，后端死到下一次改文件。
RSSHUB_SRC="${RSSHUB_SRC:-../RSSHub}"
export STREAM_RESTART_MODE=watch
scripts/serve-caged.sh --unit "$STREAM_DEV_UNIT" \
  npx tsx watch --exclude "$RSSHUB_SRC/node_modules/**" --include "packages/*/manifests.yaml" --include restart-sentinel src/serve.ts &

# 扩展的热重载（:5279）——WXT 监视 extension/src，改一行就重建 .output/chrome-mv3-dev 并通过
# WS 让扩展自己 chrome.runtime.reload()。装载只做一次（chrome://extensions 装那个 -dev 目录），
# 之后开发流程里不再需要人去点「重新加载」。
# 它自己不开浏览器（webExt.disabled）——骑的是用户自己那个带登录态的 Chrome。
# 没装 extension/node_modules 就跳过：扩展是独立 workspace，主线开发不该被它拦住。
# `tail -f /dev/null |` 是给它一个**永不 EOF 的 stdin**：wxt 读到 stdin 结束就退出（在终端里
# 跑不会发生，但从脚本/后台/CI 里起就会——表现是"起来了、建了一次、然后静默退出"，热重载就此
# 失效而没有任何报错）。别删这段管道。
if [ -x extension/node_modules/.bin/wxt ]; then
  ( cd extension && tail -f /dev/null | node_modules/.bin/wxt ) &
else
  echo "[dev] 跳过扩展热重载：extension/node_modules 缺失（cd extension && pnpm install 装上）"
fi

# 工作台 UI 插件（hosts/dsh，npm `@streamapp/dsh-plugin-stream-ui`）的自动重建——它是**构建产物**：工作台只装载
# lib/client.js，不认 src/。没有这条 watch 时"改了源码、界面还是旧的"且零报错（活体
# 2026-08-25：「查看全文」按钮合进 main 后在页面上不存在，就因为没人重新 bundle）。
# 改动落盘 → tsdown 重建 lib/ → 浏览器里刷新工作台页即生效（插件资产按请求现读，后端不用动）。
# stdin 管道同 wxt 那条的理由：后台起的进程读到 stdin EOF 就可能静默退出，别删。
if [ -x hosts/dsh/node_modules/.bin/tsdown ]; then
  ( cd hosts/dsh && tail -f /dev/null | node_modules/.bin/tsdown --watch ) &
else
  echo "[dev] 跳过工作台插件自动重建：hosts/dsh/node_modules 缺失（cd hosts/dsh && npm install 装上）"
fi

# `capabilities/desktop` **不在这里 watch**：它是内置能力，后端直接 import 它的 TS 源码
# （`src/host-agent/mount.ts`），跟着后端自己那条 tsx watch 热重载走——它没有构建产物、也没有
# tsdown 配置了。往这儿加一条 watch 的代价不是多跑一个进程：tsdown 找不到 config 会**1 秒退出**，
# 而下面那句 `wait -n` 是"哪条腿先倒就整摊收掉"，于是 dev 栈开机即死。

echo "[dev] 唯一入口 http://127.0.0.1:${STREAM_PORT} — 后端原生(caged, 热重载) + 扩展 WXT :5279(自动 reload) + DSH 的 stream-ui 插件 tsdown watch(自动 bundle)。面板产物不在 watch 里：改了 app/src 要 npm run build:panel -- <入口>"
# `wait -n`（哪条腿先倒就返回）而不是 `wait`（等所有腿都倒）：一条腿静默死掉、其余照常服务，
# 是这套东西最贵的坏法——后端的 watcher 崩了之后子进程会变孤儿继续跑旧代码，页面正常、
# health 200、日志干净，而你改的每一行都不生效。宁可整摊收掉（trap 里的 dev-stop 会收干净），
# 让你当场看见，也不要留一个看起来还活着的半截摊子。
wait -n
