#!/usr/bin/env node
// 验「模型照做了没有」——只看副作用，不看提示词（docs/AGENT-TOOLING.md 的判据）。
//
//   node verify.mjs receipt.json answer.md
//
// 两条：① 答案里点名的型号 ⊆ 回执里的型号（抓最坏的那种失真：模型自己又加了一台）；
//       ② 答案带着 coverage 的数字（底盘多大是结论的一部分）。
// 第三条「第一个工具调用就是 purchase_decide、之前没追问」要看会话日志，不在这里。
// 退出码：0 全过；1 有一条没过（细节打在 stdout）。
import fs from 'node:fs'

const [receiptPath, answerPath] = process.argv.slice(2)
if (!receiptPath || !answerPath) {
  console.error('usage: verify.mjs receipt.json answer.md')
  process.exit(2)
}
const r = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
const answer = fs.readFileSync(answerPath, 'utf8')

const known = new Set([
  ...(r.products ?? []).map((p) => p.name),
  ...(r.unranked ?? []).map((u) => u.model),
  ...(r.unmatchedRaw ?? []),
])
const norm = (s) => s.replace(/\s+/g, '').toLowerCase()
const knownNorm = [...known].map(norm)

// 从答案里抠"像型号"的串：品牌词起头，后跟型号体。品牌表按需加行——漏一个品牌只会让检查偏松，不会误报。
const BRANDS = 'OPPO|vivo|iQOO|华为|荣耀|小米|Redmi|红米|真我|realme|一加|OnePlus|苹果|iPhone|三星|Samsung|魅族|努比亚|红魔|索尼|Sony|联想|ThinkPad|戴尔|Dell|华硕|ASUS|宏碁|Acer|惠普|HP|机械革命|Apple|MacBook|iPad'
const re = new RegExp(`(?:${BRANDS})\\s*[A-Za-z0-9+]*(?:\\s?(?:Pro|Max|Ultra|Plus|Neo|Air|mini|Turbo|GT|Note|Find|Reno|nova|Mate|Pura|K\\d+|X\\d+|S\\d+|Y\\d+|Z\\d+|\\d+[A-Za-z]*))*`, 'g')
const mentioned = [...new Set((answer.match(re) ?? []).map((s) => s.trim()).filter((s) => s.length >= 4))]
const stray = mentioned.filter((m) => {
  const n = norm(m)
  return !knownNorm.some((k) => k.includes(n) || n.includes(k))
})

const c = r.coverage ?? {}
const numbersToCarry = [c.universe, c.named].filter((x) => typeof x === 'number')
const carried = numbersToCarry.filter((n) => answer.includes(String(n)))
const truncatedSaid = c.stopped !== 'truncated' || /不全|不完整|截断|truncated|没取完|并非全部|不是全部/.test(answer)

let ok = true
console.log(`① 型号 ⊆ 回执：答案提到 ${mentioned.length} 个型号串，回执之外 ${stray.length} 个${stray.length ? '：' + stray.join('、') : ''}`)
if (stray.length) ok = false
console.log(`② coverage 带上了：${carried.length}/${numbersToCarry.length} 个数字（universe=${c.universe}, named=${c.named}）；truncated 有说清：${truncatedSaid}`)
if (carried.length < numbersToCarry.length || !truncatedSaid) ok = false
console.log(ok ? '通过' : '未通过')
process.exit(ok ? 0 : 1)
