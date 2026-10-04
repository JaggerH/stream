#!/usr/bin/env bash
# 取 ONNX Runtime 1.20.1 的动态库（Stream Desktop 识别层的唯一推理引擎，spec
# docs/superpowers/specs/2026-09-14-desktop-ocr-onnxruntime-design.md §3）。
#
#   export-ort.sh <win32-x64|darwin-x64|darwin-arm64|linux-x64> <目标目录>
#
# 从微软官方 GitHub release 下载归档、只解出库文件本体、改成约定文件名放到目标目录：
#   win32-x64    onnxruntime.dll        （另外三件 VC++ 运行时不在归档里，见下）
#   darwin-x64   libonnxruntime.dylib   （归档里叫 libonnxruntime.1.20.1.dylib）
#   darwin-arm64 libonnxruntime.dylib
#   linux-x64    libonnxruntime.so      （只给开发机 cargo test 用，不出货）
#
# Windows 还要 msvcp140.dll / vcruntime140.dll / vcruntime140_1.dll（onnxruntime.dll 依赖 VC++
# 运行时，干净装机没有）。它们不在任何可脚本下载的归档里：从一台装了 VC++ 2015–2022 x64 运行时
# 的 Windows 机器的 C:\Windows\System32 拷（微软 Visual Studio REDIST 名单允许随应用分发），
# 版本记在 platforms/ort-win32-x64.sha256 的注释里。release `desktop-ort-v1` 上挂的就是这六个文件。
set -euo pipefail
ver=1.20.1
plat=${1:?平台} ; dest=${2:?目标目录}
case "$plat" in
  win32-x64)    arch=onnxruntime-win-x64-$ver;   inner=$arch/lib/onnxruntime.dll;                 out=onnxruntime.dll ;;
  darwin-x64)   arch=onnxruntime-osx-x86_64-$ver; inner=$arch/lib/libonnxruntime.$ver.dylib;      out=libonnxruntime.dylib ;;
  darwin-arm64) arch=onnxruntime-osx-arm64-$ver;  inner=$arch/lib/libonnxruntime.$ver.dylib;      out=libonnxruntime.dylib ;;
  linux-x64)    arch=onnxruntime-linux-x64-$ver;  inner=$arch/lib/libonnxruntime.so.$ver;         out=libonnxruntime.so ;;
  *) echo "不认识的平台 $plat" >&2; exit 2 ;;
esac
base=https://github.com/microsoft/onnxruntime/releases/download/v$ver
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$dest"
if [ "$plat" = win32-x64 ]; then
  curl -fsSL "$base/$arch.zip" -o "$tmp/a.zip"
  unzip -q -o "$tmp/a.zip" "$inner" -d "$tmp"
else
  curl -fsSL "$base/$arch.tgz" -o "$tmp/a.tgz"
  tar -xzf "$tmp/a.tgz" -C "$tmp" "$inner"
fi
cp "$tmp/$inner" "$dest/$out"
echo "$dest/$out"
