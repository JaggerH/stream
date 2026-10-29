#!/usr/bin/env node
// 全量测试跑完后，检查系统临时目录里有没有留下测试建的东西。
//
// 为什么是脚本而不是 vitest 的 globalSetup/teardown：多个会话 / agent 经常同时跑 Stream 的
// 全量、共用同一个 TMPDIR，进程级的全局检查会把别人的临时目录算到自己头上，随机变红。这里
// 自己开一个全新的 TMPDIR 给这次运行，只检查那一个目录。
//
// 用法：
//   node scripts/check-tmp-residue.mjs              # 跑全量再检查
//   node scripts/check-tmp-residue.mjs <测试文件…>   # 只跑指定的测试再检查
//
// 判据：运行结束后新 TMPDIR 里还有条目（工具链自己的缓存目录除外）→ 打印前缀并以 1 退出。
// `src/test-setup.ts` 会把测试通过 mkdtemp 建出来的目录统一收尾；这里兜住的是绕过它的路径
// （比如直接往 tmpdir() 里写文件）。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

// 工具链自己建的目录：Node 的编译缓存与 tsx 的管道目录（后者按 uid 命名）。它们不是测试数据。
const TOOLCHAIN = [/^node-compile-cache$/, /^tsx-\d+$/]

const runTmp = mkdtempSync(join(tmpdir(), 'stream-tmp-guard-'))
const leakLog = join(tmpdir(), `stream-tmp-guard-leaks-${process.pid}.log`)

const args = process.argv.slice(2)
// 与仓库里跑测试的约定一致：全量走同一个 flock，避免和别的会话/agent 抢 CPU 互相放大超时。
const vitest = spawnSync('flock', ['/tmp/stream-heavy.lock', 'node_modules/.bin/vitest', 'run', ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    TMPDIR: runTmp,
    STREAM_TEST_TMP_LEAK_LOG: leakLog,
    NODE_DISABLE_COMPILE_CACHE: '1',
    TSX_DISABLE_CACHE: '1',
  },
})

let failed = vitest.status !== 0

const residue = readdirSync(runTmp).filter((name) => !TOOLCHAIN.some((re) => re.test(name)))
if (residue.length > 0) {
  failed = true
  const prefixes = [...new Set(residue.map((name) => basename(name).replace(/-[A-Za-z0-9]{6,}$/, '')))].sort()
  console.error(`\n[tmp-residue] 全量跑完 TMPDIR 里还剩 ${residue.length} 个条目，前缀：${prefixes.join(', ')}`)
  for (const name of residue.slice(0, 40)) console.error(`  ${name}`)
  if (residue.length > 40) console.error(`  …还有 ${residue.length - 40} 个`)
} else if (!failed) {
  console.log('[tmp-residue] 通过：TMPDIR 里没有测试留下的条目。')
}

if (existsSync(leakLog)) {
  const lines = readFileSync(leakLog, 'utf8').trim().split('\n').filter(Boolean)
  if (lines.length > 0) {
    console.log(`\n[tmp-residue] 以下 ${lines.length} 个测试文件没有自己删临时目录（已由 src/test-setup.ts 收尾）：`)
    for (const line of lines) console.log(`  ${line}`)
  }
  rmSync(leakLog, { force: true })
}

rmSync(runTmp, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
