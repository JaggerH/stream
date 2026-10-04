#!/usr/bin/env node
/**
 * 把扩展的最新源码装进用户的 Chrome，一条命令走完，回执是「扩展真的重启了」。
 *
 *   node scripts/ext-reload.mjs            # build → 物化 → 点「重新加载」→ 等中继重连
 *   node scripts/ext-reload.mjs --no-build # 跳过 build（产物已经是新的）
 *
 * 为什么要有这条：Chrome 装载的**不是** `extension/.output/chrome-mv3`，是它的一份拷贝
 * `<dataDir>/extension/`（`materializeExtension`，扩展引导那条路铸的）。所以「改完 build 一下」
 * 之后 Chrome 里跑的还是旧代码——build 只更新了没人装载的那个目录。2026-09-21 就这么白验了两轮：
 * 用户按我说的点了两次「重新加载」，加载的都是三天前的产物。三步缺一步都是假重载，所以写成一条：
 *
 *   1. `pnpm build`（extension/）                  → `.output/chrome-mv3`
 *   2. `POST /api/extension/materialize`           → 拷进 `<dataDir>/extension/`
 *   3. `POST /api/extension/reload`                → 一条桌面 recipe（`src/browser/extension-reload.ts`）：
 *      Stream Desktop 开窗 → 地址栏进扩展详情页 → 点「重新加载」→ 等中继以新连接回来
 *
 * 第 3 步**全程不经中继**：这条脚本最要紧的用场是扩展断连（后端重启后中继没回来），任何走扩展的路
 * 那时都够不着要救的那个东西。
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readExtensionConsole, printConsole } from './ext-console.mjs'

const BASE = process.env.STREAM_BACKEND_URL ?? 'http://127.0.0.1:8900'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

if (!process.argv.includes('--no-build')) {
  console.log('[ext-reload] 1/3 build')
  execFileSync('pnpm', ['build'], { cwd: resolve(root, 'extension'), stdio: 'inherit' })
}

console.log('[ext-reload] 2/3 materialize → <dataDir>/extension')
const mat = await (await fetch(`${BASE}/api/extension/materialize`, { method: 'POST' })).json()
if (!mat.dir) throw new Error(`materialize 失败：${JSON.stringify(mat)}`)

console.log('[ext-reload] 3/3 Stream Desktop 点「重新加载」，等中继重连')
const res = await fetch(`${BASE}/api/extension/reload`, { method: 'POST' })
const out = await res.json()
if (out.status === 'reloaded') {
  console.log(`[ext-reload] 扩展已重启，中继重连于 ${out.since}`)
} else {
  console.error(`[ext-reload] 没成：${JSON.stringify(out)}`)
  // 没连回来的原因只在扩展后台的控制台里（它的 debug-log 那条路此时也是断的）——顺手读出来。
  if (out.status === 'no-reconnect') {
    console.error('[ext-reload] 扩展后台控制台：')
    printConsole(await readExtensionConsole(BASE))
  }
  process.exit(1)
}
