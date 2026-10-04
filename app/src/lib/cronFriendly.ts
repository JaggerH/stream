/**
 * cron 表达式 ↔ 人话 的双向翻译，外加「接下来几次什么时候跑」。
 *
 * **本仓的 cron 是 6 段（含秒）**——写路由也是这么校验的（`src/http/task-routes.ts`）。给 5 段
 * 的话 node-cron 会把「分」当成「秒」，一条本该每天跑一次的任务变成每分钟跑一次，且不报错。
 *
 * 三条不许破的规矩：
 *
 * 1. **认不出就说认不出。** 翻译只覆盖预设文法（每 N 秒/分/时、每小时第 M 分、每天/每周/每月
 *    某时刻）。超出这个范围一律返回 null，由 UI 退回原始表达式——假装看懂一个复杂表达式、
 *    给用户显示一句错的人话，比不翻译危险得多（用户照那句话安排自己的事）。
 * 2. **算不准就不算。** `nextRuns` 在两种情况下返回 null 而不是猜：任务声明的时区**与本机的
 *    UTC 偏移不同**（浏览器里没有免依赖的跨时区 cron 求解），以及「日」和「周几」同时被限定
 *    （Vixie cron 取并集、别的实现取交集，两种语义差着一个数量级的触发次数）。预设文法永远
 *    不会产出后者。**判据是偏移不是名字**——`Asia/Shanghai` 与 `Asia/Singapore` 名字不同、
 *    墙钟恒等，按名字比会把一批本可以算的任务判成算不出来（见 `localClockMatches`）。
 * 3. **为什么不装 cronstrue。** 它只解「翻译」那一半（~46KB min，含 zh_CN），另一半「下次什么
 *    时候跑」还得再装一个 cron-parser 之类；而下次触发时间必须自己有一个字段匹配器，有了它
 *    翻译那一半就是几十行。加上本仓约定 worktree 分支不增删依赖（见 AGENTS.md），所以这两件事
 *    合在这一个文件里做，代价是覆盖面窄——而窄由第 1 条兜住：窄不会变成错。
 */

// ---------------------------------------------------------------------------
// 预设文法：UI 的排期选择器只会写出这几种形状，翻译与回读也围绕它们展开
// ---------------------------------------------------------------------------

export type Preset =
  /** 每 N 秒 */
  | { kind: 'everySeconds'; n: number }
  /** 每 N 分钟 */
  | { kind: 'everyMinutes'; n: number }
  /** 每小时的第 minute 分 */
  | { kind: 'hourly'; minute: number }
  /** 每天 hour:minute */
  | { kind: 'daily'; hour: number; minute: number }
  /** 每周（weekdays 非空；0=周日）hour:minute */
  | { kind: 'weekly'; weekdays: number[]; hour: number; minute: number }
  /** 每月 day 日 hour:minute */
  | { kind: 'monthly'; day: number; hour: number; minute: number }

export type PresetKind = Preset['kind']

export const PRESET_KINDS: PresetKind[] = ['everySeconds', 'everyMinutes', 'hourly', 'daily', 'weekly', 'monthly']

export const PRESET_LABELS: Record<PresetKind, string> = {
  everySeconds: '每隔几秒',
  everyMinutes: '每隔几分钟',
  hourly: '每小时',
  daily: '每天',
  weekly: '每周',
  monthly: '每月',
}

const WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function weekdayLabel(d: number): string {
  return WEEK_LABELS[d] ?? String(d)
}

/** 兼容旧口径：「几点几分 + 周几」那一档。空 weekdays = 每天。 */
export interface Friendly {
  hour: number
  minute: number
  /** 0=周日 … 6=周六；空数组 = 每天 */
  weekdays: number[]
}

// ---------------------------------------------------------------------------
// 字段解析：`*` / `*/n` / `a-b` / `a-b/n` / 逗号列表
// ---------------------------------------------------------------------------

/** 一段字段的解析结果。`all` 说的是这一段写的就是 `*`——它和「列全了所有取值」不是一回事：
 *  翻译要靠它区分「每天」和「周日至周六」，两句话的语气差很多。 */
interface Field {
  all: boolean
  // 单一步进写法（星号斜杠 n）的 n；其余形状为 null。翻译「每 N 分钟」只认这一种。
  // 注：这一行是行注释而不是块注释——块注释里写不出那个字面量，它会把注释提前关掉。
  step: number | null
  /** 升序去重的取值集合 */
  values: number[]
}

function parseField(raw: string, min: number, max: number): Field | null {
  if (raw === '*') return { all: true, step: null, values: range(min, max, 1) }
  const values = new Set<number>()
  let soleStep: number | null = null
  const parts = raw.split(',')
  for (const part of parts) {
    const m = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part)
    if (!m) return null
    const [, spec, stepRaw] = m
    const step = stepRaw === undefined ? 1 : Number(stepRaw)
    if (step < 1) return null
    let lo: number
    let hi: number
    if (spec === '*') { lo = min; hi = max }
    else if (spec!.includes('-')) {
      const [a, b] = spec!.split('-').map(Number) as [number, number]
      lo = a; hi = b
    }
    else { lo = Number(spec); hi = stepRaw === undefined ? Number(spec) : max }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null
    for (const v of range(lo, hi, step)) values.add(v)
    if (parts.length === 1 && spec === '*' && stepRaw !== undefined) soleStep = step
  }
  if (values.size === 0) return null
  return { all: false, step: soleStep, values: [...values].sort((a, b) => a - b) }
}

function range(lo: number, hi: number, step: number): number[] {
  const out: number[] = []
  for (let v = lo; v <= hi; v += step) out.push(v)
  return out
}

export interface CronFields {
  second: Field
  minute: Field
  hour: Field
  dayOfMonth: Field
  month: Field
  dayOfWeek: Field
}

/** 6 段全部解析成功才返回；任何一段不合法 ⇒ null。UI 的原始表达式输入框就拿它做实时校验。 */
export function parseCronFields(expr: string): CronFields | null {
  const f = expr.trim().split(/\s+/)
  if (f.length !== 6) return null
  const second = parseField(f[0]!, 0, 59)
  const minute = parseField(f[1]!, 0, 59)
  const hour = parseField(f[2]!, 0, 23)
  const dayOfMonth = parseField(f[3]!, 1, 31)
  const month = parseField(f[4]!, 1, 12)
  // 周日写 7 的方言不收：node-cron 认 0-6，收下 7 就得替用户改写表达式，而改写是背着他改排期。
  const dayOfWeek = parseField(f[5]!, 0, 6)
  if (!second || !minute || !hour || !dayOfMonth || !month || !dayOfWeek) return null
  return { second, minute, hour, dayOfMonth, month, dayOfWeek }
}

/** 合法返回 null，不合法返回一句能照着改的话。 */
export function validateCron(expr: string): string | null {
  const segments = expr.trim() === '' ? [] : expr.trim().split(/\s+/)
  if (segments.length !== 6) {
    return `要 6 段（含秒），现在是 ${segments.length} 段——每天 09:45 = "0 45 9 * * *"`
  }
  return parseCronFields(expr) ? null : '有一段看不懂：只支持 * / */n / a-b / a-b/n / 逗号列表，且秒分 0–59、时 0–23、日 1–31、月 1–12、周 0–6'
}

// ---------------------------------------------------------------------------
// 表达式 → 人话
// ---------------------------------------------------------------------------

function isFixed(f: Field): number | null {
  return !f.all && f.step === null && f.values.length === 1 ? f.values[0]! : null
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function describeWeekdays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  // 连续区间说成「周一至周五」，否则逐个列
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1)
  if (contiguous && sorted.length > 2) return `${weekdayLabel(sorted[0]!)}至${weekdayLabel(sorted.at(-1)!)}`
  return sorted.map(weekdayLabel).join('、')
}

/** 认得出就给一句人话，认不出返回 null（**不要**在这里编一句近似的）。 */
export function describeCronOrNull(expr: string): string | null {
  const p = parseCronPreset(expr)
  if (!p) return null
  switch (p.kind) {
    case 'everySeconds': return p.n === 1 ? '每秒' : `每 ${p.n} 秒`
    case 'everyMinutes': return p.n === 1 ? '每分钟' : `每 ${p.n} 分钟`
    case 'hourly': return `每小时第 ${p.minute} 分`
    case 'daily': return `每天 ${hhmm(p.hour, p.minute)}`
    case 'weekly': return `${describeWeekdays(p.weekdays)} ${hhmm(p.hour, p.minute)}`
    case 'monthly': return `每月 ${p.day} 日 ${hhmm(p.hour, p.minute)}`
  }
}

/** 认得出说人话，认不出**原样返回表达式**——给用户看一句错的比看一串 cron 危险得多。 */
export function describeCron(expr: string): string {
  return describeCronOrNull(expr) ?? expr
}

// ---------------------------------------------------------------------------
// 表达式 ↔ 预设
// ---------------------------------------------------------------------------

export function compilePreset(p: Preset): string {
  switch (p.kind) {
    case 'everySeconds': return `*/${p.n} * * * * *`
    case 'everyMinutes': return `0 */${p.n} * * * *`
    case 'hourly': return `0 ${p.minute} * * * *`
    case 'daily': return `0 ${p.minute} ${p.hour} * * *`
    case 'weekly': return `0 ${p.minute} ${p.hour} * * ${[...p.weekdays].sort((a, b) => a - b).join(',')}`
    case 'monthly': return `0 ${p.minute} ${p.hour} ${p.day} * *`
  }
}

/** 把一条现成的表达式读回预设——排期选择器靠它决定「打开时停在哪一档」。读不回来就是自定义档。 */
export function parseCronPreset(expr: string): Preset | null {
  const c = parseCronFields(expr)
  if (!c) return null
  const { second, minute, hour, dayOfMonth, month, dayOfWeek } = c
  if (!month.all) return null

  // 每 N 秒：秒是 */n，其余全 *
  if (second.step !== null && minute.all && hour.all && dayOfMonth.all && dayOfWeek.all) {
    return { kind: 'everySeconds', n: second.step }
  }
  if (second.all && minute.all && hour.all && dayOfMonth.all && dayOfWeek.all) {
    return { kind: 'everySeconds', n: 1 }
  }
  // 剩下的形状都要求「秒固定」——秒不固定（列表、区间）说的事超出了预设能表达的范围
  const sec = isFixed(second)
  if (sec !== 0) return null

  if (hour.all && dayOfMonth.all && dayOfWeek.all) {
    if (minute.step !== null) return { kind: 'everyMinutes', n: minute.step }
    if (minute.all) return { kind: 'everyMinutes', n: 1 }
  }
  const min = isFixed(minute)
  if (min === null) return null

  if (hour.all && dayOfMonth.all && dayOfWeek.all) return { kind: 'hourly', minute: min }
  const h = isFixed(hour)
  if (h === null) return null

  if (dayOfMonth.all && dayOfWeek.all) return { kind: 'daily', hour: h, minute: min }
  if (dayOfMonth.all && !dayOfWeek.all && dayOfWeek.step === null) {
    return { kind: 'weekly', weekdays: dayOfWeek.values, hour: h, minute: min }
  }
  if (dayOfWeek.all) {
    const d = isFixed(dayOfMonth)
    if (d !== null) return { kind: 'monthly', day: d, hour: h, minute: min }
  }
  return null
}

/** 预设自身的合法性。合法返回 null，否则一句能照着改的话。 */
export function validatePreset(p: Preset): string | null {
  const int = (v: number): boolean => Number.isInteger(v)
  switch (p.kind) {
    case 'everySeconds': return int(p.n) && p.n >= 1 && p.n <= 59 ? null : '间隔必须是 1–59 秒'
    case 'everyMinutes': return int(p.n) && p.n >= 1 && p.n <= 59 ? null : '间隔必须是 1–59 分钟'
    case 'hourly': return int(p.minute) && p.minute >= 0 && p.minute <= 59 ? null : '分钟必须是 0–59 的整数'
    case 'monthly':
      if (!int(p.day) || p.day < 1 || p.day > 31) return '日必须是 1–31 的整数'
      return timeError(p.hour, p.minute)
    case 'weekly':
      if (p.weekdays.length === 0) return '至少选一个星期几'
      if (p.weekdays.some((d) => !int(d) || d < 0 || d > 6)) return '周几只能是 0（周日）到 6（周六）'
      return timeError(p.hour, p.minute)
    case 'daily': return timeError(p.hour, p.minute)
  }
}

function timeError(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '小时必须是 0–23 的整数'
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '分钟必须是 0–59 的整数'
  return null
}

// ---------------------------------------------------------------------------
// 下次什么时候跑
// ---------------------------------------------------------------------------

/** 往前找几年就放弃——「2 月 30 日」这类永不触发的表达式必须能停下来，否则页面直接卡死。 */
const SEARCH_DAYS = 366 * 4

export function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone }
  catch { return '' }
}

/**
 * 某个时区在 `at` 这一刻相对 UTC 的偏移（分钟，东为正）。取不到 → null。
 *
 * 用来回答唯一一个问题：**这一刻，那边的墙钟和本机的墙钟是不是同一个**。相等的话，本机
 * 按本地时区算出来的「09:45」就是那边的「09:45」，一秒不差。
 */
function zoneOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value
    if (name === undefined) return null
    if (name === 'GMT' || name === 'UTC') return 0
    const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name)
    if (!m) return null
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? '0'))
  }
  catch { return null }
}

/**
 * 本机能不能替 `timeZone` 算这一刻的墙钟。
 *
 * **判据是偏移，不是名字。** 名字不同不等于时刻不同——活体实测：浏览器报 `Asia/Singapore`，
 * 任务写的是 `Asia/Shanghai`，两者恒等 UTC+8，而按名字比会把这几条任务的「下次」全判成
 * 「算不出来」。那几条恰好是真花钱的那几条，而这一页存在的三个理由之一就是「下次什么时候
 * 跑」——它一声不吭地什么都没答。
 */
function localClockMatches(timeZone: string, at: Date): boolean {
  const there = zoneOffsetMinutes(timeZone, at)
  if (there === null) return false
  return there === -at.getTimezoneOffset()
}

/**
 * 接下来 `count` 次触发时刻（本机时区）。
 *
 * 返回 null = **这次算不出来**，不是「没有下次」；算不出来的两种情形写在文件头注里。
 * 「有解但一次都不触发」返回空数组（如 `0 0 0 30 2 *`）——两者 UI 上说的话不一样。
 */
export function nextRuns(
  expr: string,
  { from = new Date(), count = 3, timeZone }: { from?: Date; count?: number; timeZone?: string } = {},
): Date[] | null {
  const c = parseCronFields(expr)
  if (!c) return null
  // 跨时区的 cron 求解在浏览器里没有免依赖的做法。宁可什么都不显示，也不能把「北京时间 09:45」
  // 按本机时区画成一个错的时刻——用户会照着它安排事情。
  // 但「跨时区」的判据是**偏移不同**，不是名字不同（见 `localClockMatches`）。
  const foreignZone = timeZone !== undefined && timeZone !== '' && timeZone !== localTimeZone() ? timeZone : null
  if (foreignZone !== null && !localClockMatches(foreignZone, from)) return null
  // 「日」和「周几」同时被限定时，各家实现取并集还是取交集不一致（触发次数差一个数量级）。
  if (!c.dayOfMonth.all && !c.dayOfWeek.all) return null

  const out: Date[] = []
  const day0 = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < SEARCH_DAYS && out.length < count; i += 1) {
    const day = new Date(day0.getFullYear(), day0.getMonth(), day0.getDate() + i)
    if (!c.month.values.includes(day.getMonth() + 1)) continue
    if (!c.dayOfMonth.all && !c.dayOfMonth.values.includes(day.getDate())) continue
    if (!c.dayOfWeek.all && !c.dayOfWeek.values.includes(day.getDay())) continue
    for (const h of c.hour.values) {
      for (const m of c.minute.values) {
        for (const s of c.second.values) {
          const t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, s)
          if (t.getTime() <= from.getTime()) continue
          out.push(t)
          if (out.length >= count) break
        }
        if (out.length >= count) break
      }
      if (out.length >= count) break
    }
  }
  // 借来的偏移只在**这一刻**验过。夏令时会让两个此刻同偏移的时区在几天后分家（Asia/Shanghai
  // 与 Asia/Singapore 都没有 DST，但这条不该赌在具体是哪两个时区上）。逐个再验一次：只要有
  // 一次分家，就回 null 说"算不出来"，绝不画一个差一小时的时刻——用户会照着它安排事情。
  if (foreignZone !== null && out.some((t) => !localClockMatches(foreignZone, t))) return null
  return out
}

// ---------------------------------------------------------------------------
// 旧口径的三个薄封装：「几点几分 + 周几」是 daily/weekly 两档的另一种说法
// ---------------------------------------------------------------------------

export function parseCron(expr: string): Friendly | null {
  const p = parseCronPreset(expr)
  if (!p) return null
  if (p.kind === 'daily') return { hour: p.hour, minute: p.minute, weekdays: [] }
  if (p.kind === 'weekly') return { hour: p.hour, minute: p.minute, weekdays: p.weekdays }
  return null
}

export function compileCron(f: Friendly): string {
  return compilePreset(f.weekdays.length === 0
    ? { kind: 'daily', hour: f.hour, minute: f.minute }
    : { kind: 'weekly', weekdays: f.weekdays, hour: f.hour, minute: f.minute })
}

export function validateFriendly(f: Friendly): string | null {
  return validatePreset(f.weekdays.length === 0
    ? { kind: 'daily', hour: f.hour, minute: f.minute }
    : { kind: 'weekly', weekdays: f.weekdays, hour: f.hour, minute: f.minute })
}
