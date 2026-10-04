#!/usr/bin/env bash
# qrun.sh — 重活（全量测试 / 重构建）的统一排队入口。
#
# 为什么单槽：一次全量 vitest 默认 16 worker 已吃满 16 核，两个并发全量只会互相拖慢
# 且内存翻倍（单 worker 实测最大 2.4GB，两会话并发曾把 23GB 打穿触发 OOM）。
# 为什么 MemoryMax：systemd scope 给任务一个内存硬顶，超了 OOM 只死这个任务，不死整机。
# 注意：排队（等锁）时间会计入调用方的 Bash 超时——给足 timeout 再来排。
#
# 用法：scripts/qrun.sh <命令...>    例：scripts/qrun.sh node_modules/.bin/vitest run
set -euo pipefail

LOCK="${QRUN_LOCK:-/tmp/stream-heavy.lock}"

if command -v systemd-run >/dev/null 2>&1; then
  # --same-dir：scope 在调用方 cwd 里跑（本机 systemd 实测支持）。
  exec flock "$LOCK" systemd-run --user --scope -q --same-dir \
    -p MemoryMax=12G -p MemorySwapMax=2G "$@"
else
  exec flock "$LOCK" "$@"
fi
