#!/usr/bin/env node
// 读一份或多份 `stream-desktop ocr-bench` 的 JSON，配上图集旁的 `*.targets.json`，打一张表：
// 每个候选 × 每种输入的耗时（冷 / 热 / 缓存）与准确率（全等命中 / 包含命中）。
//
// 用法：
//   node scripts/ocr-score.mjs --targets tests/fixtures out-win.json out-mac.json
//   node scripts/ocr-score.mjs --targets tests/fixtures --golden tests/fixtures/ocr-golden.json out.json
//
// **为什么准确率要判两档**：`desktop-see.ts` 的生产 `squash` 只去空白（`s.replace(/\s+/g,'')`），
// 所以一个只差全角冒号的识别结果在生产里就是不命中；而"这行字到底有没有读出来"这个问题
// 不该被一个标点写法判死。两档都报，别只报宽的那一档——只报宽的等于悄悄放宽了验收线。
//
// 没有任何依赖（worktree 里没有 node_modules，装包也不许）。

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

const args = process.argv.slice(2)
let targetsDir = null
let goldenPath = null
const files = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--targets') targetsDir = args[++i]
  else if (args[i] === '--golden') goldenPath = args[++i]
  else files.push(args[i])
}
if (!files.length) {
  console.error('用法：node ocr-score.mjs --targets <图目录> [--golden <ocr-golden.json>] <bench.json>...')
  process.exit(2)
}

/** 生产语义：只去空白（`src/replay/desktop-see.ts`）。 */
const squashProd = (s) => s.replace(/\s+/g, '')
/** 放宽一档：再把全角 ASCII 折半角、弯引号折直引号、省略号折句点、字母折小写。
 *  与 `ocr.rs` 测试里那份 `squash` 同源——判的是"这行字读出来没有"，不是"挑中了哪个码位的冒号"。 */
const squashWide = (s) => {
  let out = ''
  for (const ch of squashProd(s)) {
    const c = ch.codePointAt(0)
    let k = ch
    if (c >= 0xff01 && c <= 0xff5e) k = String.fromCodePoint(c - 0xfee0)
    else if (ch === '…') k = '.'
    else if (ch === '‘' || ch === '’') k = "'"
    else if (ch === '“' || ch === '”') k = '"'
    else k = ch.toLowerCase()
    if (k === '.' && out.endsWith('.')) continue
    out += k
  }
  return out
}

function targetsFor(image) {
  if (!targetsDir) return null
  const p = join(targetsDir, basename(image).replace(/\.(jpe?g|png)$/i, '.targets.json'))
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

/** 一个单元的命中情况。`lines` 是引擎认出来的每一行文字，`wants` 是这一格的目标串。 */
function score(lines, wants, squash) {
  const each = lines.map(squash)
  const joined = each.join('')
  let exact = 0
  let contains = 0
  const missed = []
  for (const w of wants) {
    const s = squash(w)
    if (each.some((t) => t === s)) exact++
    if (joined.includes(s)) contains++
    else missed.push(w)
  }
  return { n: wants.length, exact, contains, missed }
}

const med = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}

const rows = []
const acc = []
for (const f of files) {
  const j = JSON.parse(readFileSync(f, 'utf8'))
  // `engine` 今天只会是 `ort`；标签仍带它，好和研究档里切换前的 tract 行并排读。
  const tag = `${j.engine}/${j.platform}${j.prewarm ? ' +预热' : ''}`
  for (const u of j.units) {
    const key = u.region ?? 'full'
    rows.push({
      tag,
      file: basename(f),
      image: u.image,
      unit: key,
      px: `${u.w}x${u.h}`,
      det: `${u.detInput[0]}x${u.detInput[1]}`,
      load: u.loadMs,
      cold: u.coldMs,
      warm: u.warmMedianMs,
      cached: u.cachedMs,
      detMs: u.detMs,
      boxes: u.boxes,
      lines: u.lines,
      prewarmMs: u.prewarmed ? u.prewarmed.totalMs : null,
    })
    const t = targetsFor(u.image)
    if (!t) continue
    const wants = u.region ? (t.regions ?? {})[u.region] : t.full
    if (!wants || !wants.length) continue
    const texts = u.texts.map((x) => x.text)
    acc.push({
      tag,
      image: u.image,
      unit: key,
      prod: score(texts, wants, squashProd),
      wide: score(texts, wants, squashWide),
    })
    if (u.cachedLines !== u.lines) {
      console.error(`⚠ ${u.image}/${key}: 缓存那一遍 ${u.cachedLines} 行、热态 ${u.lines} 行——缓存改变了结果`)
    }
  }
}

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)

console.log('## 耗时（毫秒）\n')
console.log(
  `| ${pad('候选', 22)} | ${pad('图', 14)} | ${pad('格', 6)} | ${pad('像素', 10)} | ${pad('det 输入→档位', 22)} | ${num('load', 5)} | ${num('cold', 5)} | ${num('warm', 5)} | ${num('cache', 5)} | ${num('det', 5)} | ${num('框', 4)} | ${num('行', 4)} |`,
)
console.log(`|${'-'.repeat(24)}|${'-'.repeat(16)}|${'-'.repeat(8)}|${'-'.repeat(12)}|${'-'.repeat(24)}|------:|------:|------:|------:|------:|-----:|-----:|`)
for (const r of rows) {
  console.log(
    `| ${pad(r.tag, 22)} | ${pad(r.image, 14)} | ${pad(r.unit, 6)} | ${pad(r.px, 10)} | ${pad(r.det, 22)} | ${num(r.load, 5)} | ${num(r.cold, 5)} | ${num(r.warm, 5)} | ${num(r.cached, 5)} | ${num(r.detMs, 5)} | ${num(r.boxes, 4)} | ${num(r.lines, 4)} |`,
  )
}

// 每个候选 × 每种格的中位数汇总——单张图的数字有噪声，选型看的是这张表。
console.log('\n## 按格汇总（中位数，毫秒）\n')
console.log(`| ${pad('候选', 22)} | ${pad('格', 6)} | ${num('cold', 6)} | ${num('warm', 6)} | ${num('cache', 6)} | ${num('n', 3)} |`)
console.log(`|${'-'.repeat(24)}|${'-'.repeat(8)}|-------:|-------:|-------:|----:|`)
const groups = new Map()
for (const r of rows) {
  const k = `${r.tag}|#|${r.unit}`
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}
for (const [k, g] of groups) {
  const [tag, unit] = k.split('|#|')
  console.log(
    `| ${pad(tag, 22)} | ${pad(unit, 6)} | ${num(med(g.map((r) => r.cold)), 6)} | ${num(med(g.map((r) => r.warm)), 6)} | ${num(med(g.map((r) => r.cached)), 6)} | ${num(g.length, 3)} |`,
  )
}

if (acc.length) {
  console.log('\n## 准确率（目标字符串命中 / 总数）\n')
  console.log(`| ${pad('候选', 22)} | ${pad('图', 14)} | ${pad('格', 6)} | ${num('全等', 7)} | ${num('包含', 7)} | ${num('全等宽', 7)} | ${num('包含宽', 7)} | 漏掉的 |`)
  console.log(`|${'-'.repeat(24)}|${'-'.repeat(16)}|${'-'.repeat(8)}|--------:|--------:|--------:|--------:|---|`)
  for (const a of acc) {
    console.log(
      `| ${pad(a.tag, 22)} | ${pad(a.image, 14)} | ${pad(a.unit, 6)} | ${num(`${a.prod.exact}/${a.prod.n}`, 7)} | ${num(`${a.prod.contains}/${a.prod.n}`, 7)} | ${num(`${a.wide.exact}/${a.wide.n}`, 7)} | ${num(`${a.wide.contains}/${a.wide.n}`, 7)} | ${a.wide.missed.join(' / ')} |`,
    )
  }
  console.log('\n### 准确率合计\n')
  const tot = new Map()
  for (const a of acc) {
    const t = tot.get(a.tag) ?? { n: 0, pe: 0, pc: 0, we: 0, wc: 0, missed: [] }
    t.n += a.prod.n
    t.pe += a.prod.exact
    t.pc += a.prod.contains
    t.we += a.wide.exact
    t.wc += a.wide.contains
    t.missed.push(...a.wide.missed.map((m) => `${a.image}/${a.unit}:${m}`))
    tot.set(a.tag, t)
  }
  console.log(`| ${pad('候选', 22)} | ${num('全等', 9)} | ${num('包含', 9)} | ${num('全等宽', 9)} | ${num('包含宽', 9)} |`)
  console.log(`|${'-'.repeat(24)}|----------:|----------:|----------:|----------:|`)
  for (const [tag, t] of tot) {
    console.log(
      `| ${pad(tag, 22)} | ${num(`${t.pe}/${t.n}`, 9)} | ${num(`${t.pc}/${t.n}`, 9)} | ${num(`${t.we}/${t.n}`, 9)} | ${num(`${t.wc}/${t.n}`, 9)} |`,
    )
  }
  for (const [tag, t] of tot) if (t.missed.length) console.log(`\n**${tag} 漏掉**：${t.missed.join('、')}`)
}

// Windows 五张 fixture 对参照实现（onnxruntime）的行级命中率。判据与 `ocr.rs` 的
// `read_认得出参照实现认出的每一段` 同源：只对 score ≥ 0.8 的参照段较真、末尾省略号不算内容。
if (goldenPath) {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'))
  console.log('\n## 对 ocr-golden.json 的行级命中率（只算整图那一格）\n')
  console.log(`| ${pad('候选', 22)} | ${pad('图', 14)} | ${num('命中/参照', 10)} | 漏掉的 |`)
  console.log(`|${'-'.repeat(24)}|${'-'.repeat(16)}|-----------:|---|`)
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'))
    const tag = `${j.engine}/${j.platform}`
    for (const u of j.units) {
      if (u.region) continue
      const rows2 = golden[u.image]
      if (!rows2) continue
      const got = u.texts.map((x) => squashWide(x.text)).join('')
      let hit = 0
      let n = 0
      const missed = []
      for (const r of rows2) {
        if (r.score < 0.8) continue
        const want = squashWide(r.text).replace(/\.+$/, '')
        if (want.length < 2) continue
        n++
        if (got.includes(want)) hit++
        else missed.push(r.text)
      }
      console.log(`| ${pad(tag, 22)} | ${pad(u.image, 14)} | ${num(`${hit}/${n}`, 10)} | ${missed.join(' / ')} |`)
    }
  }
}

// 图集里有没有哪张图一个目标都没标——沉默地少算一张图，表看起来照样正常。
if (targetsDir) {
  const imgs = readdirSync(targetsDir).filter((f) => /\.(jpe?g|png)$/i.test(f))
  const labelled = new Set(acc.map((a) => a.image))
  const bare = imgs.filter((f) => !labelled.has(f))
  if (bare.length) console.error(`\n⚠ 这些图没有目标标注（没算进准确率）：${bare.join('、')}`)
}
