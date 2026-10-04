/**
 * 构建面板产物：不带参数 = 全量，带参数 = 只建点名的那几份。
 *
 *   npm run build:panel            # 五份全建，约 25s
 *   npm run build:panel -- main    # 只建 panel.js，约 5s
 *   npm run build:panel -- movie manage
 *
 * **为什么要"只建一份"这个档**：面板产物没有 watch（那要五个常驻 vite，实测单个就 522MB
 * RSS + 2% 单核空转，五个约 3GB——为省一条命令付这个价不值）。所以日常流程是"改完手动建"，
 * 而绝大多数时候只改了一份。全量 25s 与单份 5s 的差别，就是这个脚本存在的全部理由。
 *
 * 入口清单来自 `panel-entries.mjs`（vite 配置读的是同一份），别在这里再抄一遍。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PANEL_ENTRY_NAMES } from '../panel-entries.mjs'

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const asked = process.argv.slice(2)

// 打错名字当场停，别默默少建一份：少的那一份要等到运行时才报「加载了但没有导出」。
const unknown = asked.filter((name) => !PANEL_ENTRY_NAMES.includes(name))
if (unknown.length > 0) {
  console.error(`[build-panel] 不认识的入口：${unknown.join(', ')}；可选：${PANEL_ENTRY_NAMES.join(', ')}`)
  process.exit(1)
}

const targets = asked.length > 0 ? asked : PANEL_ENTRY_NAMES
for (const name of targets) {
  console.log(`[build-panel] ${name}`)
  const r = spawnSync('npx', ['vite', 'build', '--config', 'vite.panel.config.ts'], {
    cwd: appDir,
    stdio: 'inherit',
    env: { ...process.env, PANEL_ENTRY: name },
  })
  // 一份失败就停：接着建下去只会让人以为整轮成功了，而缺的那一份照旧是运行时才炸。
  if (r.status !== 0) process.exit(r.status ?? 1)
}
