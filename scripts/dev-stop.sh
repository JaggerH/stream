#!/usr/bin/env bash
#
# Deterministic teardown of the dev stack — idempotent, safe to run anytime. Clears every
# moving part so the next `pnpm dev` starts from a known-clean state (zero orphans, no
# port/lock conflicts):
#   1. backend cage  — stopping the named cgroup scope kills the node process it holds
#   3. serve lock    — /tmp/stream-serve.pid
# Best-effort throughout (no `set -e`): a missing piece is success, not failure.
#
# 这里不再收拾任何浏览器进程：2026-07-28 cloak 退役后 Stream 不自带浏览器，采集骑用户自己那个
# Chrome —— 那是**用户的**进程，dev 收摊绝不能碰它（关掉它等于关掉用户的浏览器）。
set -uo pipefail
UNIT="${STREAM_DEV_UNIT:-stream-back-dev}"

kill_port() { # SIGTERM whatever listens on $1
  local pids
  pids=$(ss -tlnp 2>/dev/null | grep ":$1 " | grep -oE 'pid=[0-9]+' | grep -oE '[0-9]+')
  [ -n "$pids" ] && kill $pids 2>/dev/null
}

# 0. 常驻后端服务（scripts/stream-back.service）。它和 dev 抢同一个 8900，serve.ts 的单实例
#    锁会让后起的那个直接退出——所以进场必须先把它停掉，否则 dev 起不来而且报的是一句
#    看不懂的"另一个 serve 活着"。dev.sh 退场时会把它起回来（见那边的 cleanup）。
#    单独跑 dev-stop 则是"把 8900 彻底清空"，包括常驻服务——那正是它承诺的事。
systemctl --user stop stream-back.service 2>/dev/null

# 1. backend cage — stopping the scope kills the whole cgroup. Fallbacks for the uncaged
#    case (no systemd-run): kill by pattern + by port. 8900 = 那扇门；4555 是容器时代的
#    旧口，自托管旁支还在用，本机残留也一并收掉。
systemctl --user stop "${UNIT}.scope" 2>/dev/null
pkill -f 'tsx.*src/serve.ts' 2>/dev/null
kill_port "${STREAM_PORT:-8900}"
kill_port 4555

# 2. :5273 曾经是老版 UI 的 Vite。那套已经下线，这里仍然收一次——存量的开发机上可能还留着
#    一个上一代 dev.sh 起的监听者，收掉它比让它继续占着口好。
kill_port 5273

# 3. 扩展热重载的 WXT dev server（:5279）。收掉它只是停掉「监视 + 推重载」，不碰浏览器里
#    已装载的扩展 —— 那是用户 profile 里的东西，dev 收摊无权动。
kill_port 5279
pkill -f 'wxt.*extension' 2>/dev/null

# 4. stale serve lock
rm -f /tmp/stream-serve.pid

echo "[dev-stop] cleaned: stream-back.service + backend cage(${UNIT}.scope) + ports(8900/4555/5273/5279) + lock"
exit 0
