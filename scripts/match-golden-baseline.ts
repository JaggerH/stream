/**
 * 重录金样基线（`src/netdisk/match-engine/golden-baseline.json`）。
 *
 * 用法：node_modules/.bin/tsx scripts/match-golden-baseline.ts ["为什么重录"]
 *
 * **什么时候该跑**：确认某次改动是**有意的行为变更**（多半同时有一条裁决表格子在动），
 * 金样测试因此红了——重跑本脚本、把 diff 看一遍、在 commit 信息里写清哪几组为什么变。
 * **什么时候不该跑**：测试红了但说不清哪条规则变了。那是回归，先查根因。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBaseline, runGolden, fmtDrift, type GoldenBaseline } from '../src/netdisk/match-engine/golden.ts'
import { allCases } from '../src/netdisk/match-engine/golden-cases.ts'

const here = join(fileURLToPath(import.meta.url), '..')
const out = join(here, '../src/netdisk/match-engine/golden-baseline.json')

const note = process.argv[2] ?? `录于 ${new Date().toISOString().slice(0, 10)}`
const cases = allCases()
const baseline = buildBaseline(cases, note)

// 自检：录完立刻拿它对照一遍。快照器本身不确定（读了时钟/遍历顺序不稳）的话，这里就红。
const check: GoldenBaseline = JSON.parse(JSON.stringify(baseline)) as GoldenBaseline
const s = runGolden(cases, check)
if (s.drifted > 0) {
  console.error('录完自检不过——快照不稳定，别落盘：')
  for (const r of s.reports.filter((x) => !x.identical)) console.error(fmtDrift(r))
  process.exit(1)
}

writeFileSync(out, `${JSON.stringify(baseline, null, 2)}\n`)
console.log(`已录 ${cases.length} 组 → ${out}`)
console.log(`说明：${note}`)
