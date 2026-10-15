#!/usr/bin/env bash
# 在开发机上对一台测试机跑发版验收（scripts/release-verify.mjs）。
#
#   scripts/release-verify-remote.sh win-test --version 0.0.26 --old 0.0.25
#   scripts/release-verify-remote.sh mac      --version 0.0.26
#
# 脚本本体经 ssh 的 stdin 喂给测试机上的 node（`node --input-type=module -`）：不用先拷文件，也绕开
# 远端 shell 的引号问题。测试机上只需要一个 node（两台都有）和能连 npm 官方源的网。
#
# 机器相关的设置放在 scripts/release-verify.env（不进 git；照 release-verify.env.example 抄一份），
# 启动时自动读入；同名环境变量也可以直接 export：
#   RV_WIN_TARGET  win-test 的 ssh 目标（user@host）
#   RV_MAC_TARGET  mac 的 ssh 目标（user@host）
#   RV_SSH_BIN     ssh 程序。缺省：在 WSL 里用 Windows 侧的 ssh.exe，其他系统用 ssh
#   RV_SSH_KEY     私钥路径（可选）
# 要连别的机器，用环境变量覆盖：
#   RV_SSH   ssh 命令（含参数与目标），例：RV_SSH='ssh me@10.9.8.20'
#   RV_NODE  远端 node 的路径
#
# 为什么 WSL 里用 ssh.exe：从 WSL 直连测试机会卡在 SSH banner（WSL 镜像网络吞掉对端第一个数据段），
# Windows 自己的栈正常。私钥要用 Windows 那份拷贝（Windows 的 ssh 不读 \\wsl.localhost 上的私钥）。
#
# 退出码透传 release-verify.mjs：0 全过 / 1 有检查失败 / 2 环境没备齐。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target="${1:-}"; shift || true

env_file="$here/release-verify.env"
# 已经 export 的变量优先于文件里的同名设置。
if [[ -f "$env_file" ]]; then
  while IFS='=' read -r k v; do
    [[ "$k" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [[ -n "${!k:-}" ]] && continue
    v="${v%$'\r'}"; v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    export "$k=${v/#\~/$HOME}"
  done < "$env_file"
fi
need() {
  [[ -n "${!1:-}" ]] && return
  echo "$target 需要 $1（$2）。在 $env_file 里设置，模板见 $here/release-verify.env.example" >&2
  exit 2
}

wsl_ssh=/mnt/c/Windows/System32/OpenSSH/ssh.exe
if [[ -n "${RV_SSH_BIN:-}" ]]; then ssh_bin="$RV_SSH_BIN"
elif [[ -x "$wsl_ssh" ]]; then ssh_bin="$wsl_ssh"
else ssh_bin=ssh; fi
known_hosts=/dev/null
[[ "$ssh_bin" == *.exe ]] && known_hosts=NUL
preset_ssh=("$ssh_bin" -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known_hosts" -o BatchMode=yes)
[[ -n "${RV_SSH_KEY:-}" ]] && preset_ssh+=(-i "$RV_SSH_KEY")

case "$target" in
  win-test)
    need RV_WIN_TARGET 'Windows 测试机的 ssh 目标，如 user@host'
    ssh_cmd=("${preset_ssh[@]}" "$RV_WIN_TARGET")
    node_bin='"C:\Program Files\nodejs\node.exe"' ;;
  mac)
    need RV_MAC_TARGET 'Mac 测试机的 ssh 目标，如 user@host'
    ssh_cmd=("${preset_ssh[@]}" "$RV_MAC_TARGET")
    node_bin='$HOME/node/bin/node' ;;
  custom)
    [[ -n "${RV_SSH:-}" && -n "${RV_NODE:-}" ]] || { echo "custom 需要 RV_SSH 与 RV_NODE" >&2; exit 2; }
    read -r -a ssh_cmd <<< "$RV_SSH"
    node_bin="$RV_NODE" ;;
  *)
    echo "用法：$0 <win-test|mac|custom> --version <x> [--old <y>] [--probe <包@版本>] [--keep]" >&2
    exit 2 ;;
esac
[[ -n "${RV_SSH:-}" && "$target" != custom ]] && read -r -a ssh_cmd <<< "$RV_SSH"
[[ -n "${RV_NODE:-}" && "$target" != custom ]] && node_bin="$RV_NODE"

# Windows 的 ssh.exe 读不了 WSL 路径下的相对 cwd 之外的东西无所谓：脚本走 stdin，不经文件。
# 远端命令拼成一个字符串（远端 shell 解析它），参数都是版本号 / 包名，不含空格。
"${ssh_cmd[@]}" "$node_bin --input-type=module - $*" < "$here/release-verify.mjs"
