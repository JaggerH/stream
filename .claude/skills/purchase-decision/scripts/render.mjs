#!/usr/bin/env node
// 把 purchase_decide 的回执画成 markdown——给没有对比卡的宿主（Claude Code / Codex）用。
// 只摆回执里有的数，不算任何东西；顺序和工作台卡片一致：覆盖率 → 口径 → 斩杀 → 前沿 → 表 → 缺口。
//
//   node render.mjs receipt.json        # 或从 stdin 读
import fs from 'node:fs'

const src = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : fs.readFileSync(0, 'utf8')
const parsed = JSON.parse(src)
// 喂进来的既可以是回执本身，也可以是 get_agent_run 的整份返回（回执在 `receipt` 里）。
const r = parsed.receipt && !parsed.coverage ? parsed.receipt : parsed
if (!r.coverage) {
  console.error(parsed.status && parsed.status !== 'done' ? `这次 run 还没跑完（status=${parsed.status}，${parsed.stage ?? ''}）` : '不是一份决策回执：没有 coverage')
  process.exit(1)
}
const c = r.coverage ?? {}
const out = []

out.push(`## 选品对比：${(r.constraints?.category ?? []).join('、') || '—'}`)
out.push('')
out.push(
  `枚举 ${c.universe ?? '?'} 台 · 横评点名 ${c.named ?? '?'} 台 · 进比较 ${r.products?.length ?? 0} 台 · ` +
    `读成横评 ${c.reviewsRead ?? '?'}/${c.reviewsFound ?? '?'} 篇` +
    (c.seeded > 0 ? ` · 其中 ${c.seeded} 个是横评点名、枚举漏掉后补进来的` : '') +
    (c.stopped === 'truncated' ? ' · **清单不全（枚举源没取完，不是市面上的全部）**' : '') +
    (c.stopped === 'interrupted' ? ' · **横评没读成，没有体验序**' : ''),
)
if (r.residual?.mode === 'purchase_only') out.push(`\n> ⚠️ ${r.residual.note}`)
if (typeof c.unmatched === 'number' && c.unmatched > 0) {
  out.push(`\n横评提到但不在全集里：${(r.unmatchedRaw ?? []).join('、')}（共 ${c.unmatched} 个，可能是全集漏了）`)
}

const dominated = r.dominated ?? []
if (dominated.length > 0) {
  out.push('\n### 已排除')
  for (const d of dominated) out.push(`- ~~${d.name}~~ ← 被「${d.by}」${d.why}`)
}
const frontier = r.frontier ?? []
if (frontier.length > 1) out.push(`\n### 仍需你定：${frontier.join(' · ')}\n互不支配——它们之间的差别是你的偏好，不是客观优劣。`)
else if (frontier.length === 1) out.push(`\n### 前沿：${frontier[0]}`)

const products = r.products ?? []
if (products.length > 0) {
  out.push('\n| 型号 | 代价 | 最低价 | 优点 | 契合 | 依据 |')
  out.push('|---|---|---|---|---|---|')
  const fset = new Set(frontier)
  for (const p of products) {
    // 单位价（元/百抽）和日均持有成本（元/天）都是小数，一律两位——不然表格里会出现
    // `1.7045454545454546 元/百抽` 这种东西，那是把浮点误差当精度印给用户看。
    const cost = typeof p.comparable_cost === 'number' ? `${p.comparable_cost.toFixed(2)} ${p.cost_unit ?? ''}` : '—'
    // 快消品档：候选名是品牌（横评说话的粒度），**能买的是这个 sku**，不带上等于让用户
    // 拿着「洁柔」两个字去下单。
    const sku = p.cost?.kind === 'unit' && p.cost.sku && p.cost.sku !== p.name ? `<br><sub>按 ${p.cost.sku} 算</sub>` : ''
    const price = p.prices?.[0] ? `${p.prices[0].price}（${p.prices[0].platform}）` : '—'
    const ev = (p.evidence ?? []).slice(0, 2).map((e) => (e.url ? `[${e.source}](${e.url})` : e.source)).join('；') || '—'
    out.push(`| ${fset.has(p.name) ? '★ ' : ''}${p.name}${sku} | ${cost} | ${price} | ${(p.pros ?? []).join('、') || '—'} | ${p.fit ?? '—'} | ${ev} |`)
  }
} else {
  out.push('\n没有一台进比较。')
}

const uc = r.unrankedCounts ?? {}
const tail = []
if (uc.no_mention) tail.push(`${uc.no_mention} 台没被横评点名（缺的是可核的依据，不是不合格）`)
if (uc.no_price) tail.push(`${uc.no_price} 台没拿到可算的价格`)
if (uc.unit_mismatch) tail.push(`${uc.unit_mismatch} 台单位不可比（不是买不到，也不是不好）`)
if ((r.gaps ?? []).length) tail.push(`${r.gaps.length} 处取数失败`)
if (tail.length) out.push(`\n${tail.join('；')}。`)

process.stdout.write(out.join('\n') + '\n')
