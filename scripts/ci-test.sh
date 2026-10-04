#!/usr/bin/env bash
# ci-test.sh — "GitHub 优先跑测试"的本地入口：把当前 HEAD 推到 ci/* 临时分支，
# 触发 .github/workflows/test.yml，等结果，最后删掉临时分支。只做这一件事。
set -euo pipefail

if [ -n "$(git status --porcelain)" ]; then
  echo "错误：工作区不 clean，先 commit 再跑（CI 只测已提交的 HEAD）" >&2
  exit 1
fi
gh auth status >/dev/null

branch=$(git rev-parse --abbrev-ref HEAD)
sha=$(git rev-parse HEAD)
short=$(git rev-parse --short HEAD)
if [ "$branch" = "main" ] || [ "$branch" = "HEAD" ]; then
  name="ci/main-$short"
else
  name="ci/${branch//\//-}"
fi

echo "==> 推 HEAD ($short) 到 origin/$name"
git push -f origin "HEAD:refs/heads/$name"

cleanup() {
  case "$name" in
    ci/*) echo "==> 删远端临时分支 $name"
          git push origin ":refs/heads/$name" >/dev/null 2>&1 || true ;;
  esac
}
trap cleanup EXIT

echo "==> 等 workflow run 出现（最多 60s）"
run_id=""
for _ in $(seq 1 30); do
  run_id=$(gh run list --commit "$sha" --workflow test.yml \
    --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)
  [ -n "$run_id" ] && break
  sleep 2
done
if [ -z "$run_id" ]; then
  echo "错误：60s 内没等到 run（workflow 没触发？）" >&2
  exit 1
fi

echo "==> 盯 run $run_id"
rc=0
gh run watch "$run_id" --exit-status || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "==> 失败日志（tail -80）"
  gh run view "$run_id" --log-failed | tail -80 || true
fi
exit "$rc"
