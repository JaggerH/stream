#!/usr/bin/env bash
# 在开发机上对一台测试机跑发版验收（scripts/release-verify.mjs）。
#
#   scripts/release-verify-remote.sh win-test --version 0.0.26 --old 0.0.25
#   scripts/release-verify-remote.sh mac      --version 0.0.26
#
# 脚本本体经 ssh 的 stdin 喂给测试机上的 node（`node --input-type=module -`）：不用先拷文件，也绕开
# 远端 shell 的引号问题。测试机上只需要一个 node（两台都有）和能连 npm 官方源的网。
#
# 两台预设都走 **Windows 侧的 ssh.exe**：从 WSL 直连这两台会卡在 SSH banner（WSL 镜像网络吞掉对端第一个
# 数据段），Windows 自己的栈正常。私钥是 WSL 那把的 Windows 拷贝（Windows 的 ssh 不读 \\wsl.localhost 上的
# 私钥）。要连别的机器，用环境变量覆盖：
#   RV_SSH   ssh 命令（含参数与目标），例：RV_SSH='ssh me@10.0.0.20'
#   RV_NODE  远端 node 的路径
#
# 退出码透传 release-verify.mjs：0 全过 / 1 有检查失败 / 2 环境没备齐。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
target="${1:-}"; shift || true

win_ssh=(/mnt/c/Windows/System32/OpenSSH/ssh.exe -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL
         -o BatchMode=yes)
[[ -n "${RV_SSH_KEY:-}" ]] && win_ssh+=(-i "$RV_SSH_KEY")

case "$target" in
  win-test)
    ssh_cmd=("${win_ssh[@]}" 'laptop-i4grno1q\xiaomi@10.0.0.64')
    node_bin='"C:\Program Files\nodejs\node.exe"' ;;
  mac)
    ssh_cmd=("${win_ssh[@]}" 'jhuang@10.0.0.10')
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
