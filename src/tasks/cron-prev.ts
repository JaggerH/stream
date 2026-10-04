/** 6 段 cron 的「最近一个应跑槽」计算——watchdog 专用的受限子集。
 *
 *  只支持本仓任务实际用到的形状：秒必须是常数；分/时支持 `数字 | * | *\/n`；日/月只支持 `*`；
 *  周支持 `* | 数字 | a-b | 逗号列表`（A 股任务是 `1-5`——不支持它就等于最该被兜住的两条任务
 *  反而没人兜，而且这个"没兜住"只有一行日志）。
 *  超出子集一律 throw（fail-loud）：watchdog 对不认识的表达式选择跳过并上报,绝不猜——
 *  猜错的后果是把没丢的班判成丢班重复补跑,或把丢了的班判成正常。
 *
 *  为什么不用 node-cron 本尊算：它只有 getNextMatch(向前),没有向后;且它是 sidequest 的传递依赖,
 *  直接 import 未声明的包正是 radix 双实例事故的来路(见 memory)。子集自算 40 行,语义无歧义。 */

type Field = { kind: 'any' } | { kind: 'step'; n: number } | { kind: 'const'; v: number }

function parseField(raw: string): Field {
  if (raw === '*') return { kind: 'any' }
  const step = /^\*\/(\d+)$/.exec(raw)
  if (step) return { kind: 'step', n: Number(step[1]) }
  if (/^\d+$/.test(raw)) return { kind: 'const', v: Number(raw) }
  throw new Error(`watchdog 不支持的 cron 字段: ${raw}`)
}

/** 周段：null = 不限；否则是允许的星期集合（0/7 都记作周日，与 JS `getDay()` 对齐）。 */
function parseDow(raw: string): Set<number> | null {
  if (raw === '*') return null
  const out = new Set<number>()
  for (const piece of raw.split(',')) {
    const range = /^(\d)-(\d)$/.exec(piece)
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])]
      // 不支持跨周回绕（`5-1`）：cron 的方言在这里并不一致，猜错就是把某几天判成丢班重复补跑
      if (a > b) throw new Error(`watchdog 不支持回绕的周范围: ${raw}`)
      for (let v = a; v <= b; v++) out.add(v === 7 ? 0 : v)
      continue
    }
    if (!/^\d$/.test(piece)) throw new Error(`watchdog 不支持的周字段: ${raw}`)
    out.add(Number(piece) === 7 ? 0 : Number(piece))
  }
  return out
}

interface Parsed {
  sec: number
  min: Field
  hour: Field
  dow: Set<number> | null
}

/** 解析并校验受支持子集;不支持 → throw。 */
export function assertSupportedCron(expr: string): Parsed {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 6) throw new Error(`watchdog 只认 6 段 cron: ${expr}`)
  const sec = parseField(parts[0])
  if (sec.kind !== 'const') throw new Error(`watchdog 要求秒段为常数: ${expr}`)
  for (const p of parts.slice(3, 5)) {
    if (p !== '*') throw new Error(`watchdog 只支持日/月为 *: ${expr}`)
  }
  return { sec: sec.v, min: parseField(parts[1]), hour: parseField(parts[2]), dow: parseDow(parts[5]) }
}

function fieldMatches(f: Field, v: number): boolean {
  if (f.kind === 'any') return true
  if (f.kind === 'step') return v % f.n === 0
  return v === f.v
}

/** 往回扫多远。25 小时覆盖"每天一班"再留余量，**同时也是补跑的上限**：更早的槽一律不补。
 *  这个上限是有意的——周五的班在周一早上补跑，补的其实是周一的行情，不是那一班。 */
const SCAN_LIMIT_MINUTES = 25 * 60

/** 最近一个 ≤ from 的应跑槽(epoch ms);25 小时内没有匹配 → null。 */
export function prevMatch(expr: string, fromMs: number): number | null {
  const { sec, min, hour, dow } = assertSupportedCron(expr)
  const cursor = new Date(fromMs)
  cursor.setMilliseconds(0)
  cursor.setSeconds(sec)
  if (cursor.getTime() > fromMs) cursor.setTime(cursor.getTime() - 60_000)
  for (let i = 0; i < SCAN_LIMIT_MINUTES; i++) {
    if (
      fieldMatches(min, cursor.getMinutes())
      && fieldMatches(hour, cursor.getHours())
      && (dow === null || dow.has(cursor.getDay()))
    ) {
      return cursor.getTime()
    }
    cursor.setTime(cursor.getTime() - 60_000)
  }
  return null
}
