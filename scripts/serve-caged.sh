#!/usr/bin/env bash
#
# Launch a command (default `pnpm serve`) inside a memory-capped cgroup-v2 scope.
#
# USAGE:
#   scripts/serve-caged.sh                             # caged `pnpm serve` (no watch)
#   scripts/serve-caged.sh npx tsx watch src/serve.ts  # caged hot-reload dev backend
#
# WHY ONE CAGE COVERS EVERYTHING:
#   - RSSHub runs IN-PROCESS (rsshub-adapter.ts does `await import(RSSHUB_PKG)`),
#     so its memory IS this node process's memory — no separate process to cap.
#   - The shared headless chromium is a CHILD process, so it lands in the same
#     cgroup scope automatically.
#   ⇒ A single scope around `pnpm serve` bounds stream + RSSHub + chromium together.
#
# WHY MemorySwapMax=0:
#   The freeze-then-crash you saw was swap thrashing: when RAM filled, the VM paged
#   to the 8G swap on the vhdx and ground to a halt for minutes BEFORE the OOM
#   killer fired. Forbidding swap makes a runaway hit the wall fast and get
#   OOM-killed inside the cage — the rest of WSL stays responsive.
#
# Tunables (env): STREAM_MEM_MAX (default 6G), STREAM_NODE_HEAP_MB (default 3072).
set -euo pipefail
cd "$(dirname "$0")/.."

MEM="${STREAM_MEM_MAX:-6G}"
HEAP_MB="${STREAM_NODE_HEAP_MB:-3072}"

# Optional named scope: `--unit NAME` makes the cgroup scope `NAME.scope`, so teardown can
# deterministically `systemctl --user stop NAME.scope` (kills the whole cage incl. chrome).
UNIT=""
if [ "${1:-}" = "--unit" ]; then UNIT="$2"; shift 2; fi

# The command to cage — default `pnpm serve`, or pass a custom one (e.g. the watch
# dev backend: `serve-caged.sh npx tsx watch src/serve.ts`).
CMD=("$@")
[ ${#CMD[@]} -eq 0 ] && CMD=(pnpm serve)

# Bound RSSHub's in-process V8 heap: if it leaks, node hits the heap limit and
# exits (cleanly restartable) instead of growing RSS until the cage OOMs.
export NODE_OPTIONS="--max-old-space-size=${HEAP_MB} ${NODE_OPTIONS:-}"

# Pre-flight: without systemd-run there is no cage — run UNCAGED but say so loudly. A
# silent no-op would feel "protected" while leaving WSL exposed to the freeze-then-crash.
if ! command -v systemd-run >/dev/null 2>&1; then
  echo "[serve-caged] WARN: systemd-run not found — running UNCAGED: ${CMD[*]}" >&2
  exec "${CMD[@]}"
fi
# Soft check: MemoryMax only bites if the 'memory' controller is delegated to the user
# session. On a rebuilt WSL / systemd-off this can be missing → the cap is silently ignored.
if ! grep -qsw memory "/sys/fs/cgroup/user.slice/user-$(id -u).slice/cgroup.controllers"; then
  echo "[serve-caged] WARN: 'memory' controller not delegated to the user session — MemoryMax may be IGNORED" >&2
fi

SCOPE=(--user --scope)
[ -n "$UNIT" ] && SCOPE+=(--unit="$UNIT")
echo "[serve-caged] unit=${UNIT:-<anon>} MemoryMax=${MEM} swap=off node-heap=${HEAP_MB}MB cmd='${CMD[*]}'"
exec systemd-run "${SCOPE[@]}" \
  -p MemoryMax="${MEM}" \
  -p MemorySwapMax=0 \
  -- "${CMD[@]}"
