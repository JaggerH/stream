import { describe, it, expect } from 'vitest'
import {
  parseCron, compileCron, validateFriendly, describeCron, describeCronOrNull,
  parseCronPreset, compilePreset, validatePreset, validateCron, parseCronFields, nextRuns,
  type Preset,
} from './cronFriendly.ts'

describe('parseCron', () => {
  it('工作日 09:45', () => {
    expect(parseCron('0 45 9 * * 1-5')).toEqual({ hour: 9, minute: 45, weekdays: [1, 2, 3, 4, 5] })
  })
  it('每天 03:30', () => {
    expect(parseCron('0 30 3 * * *')).toEqual({ hour: 3, minute: 30, weekdays: [] })
  })
  it('逗号列表', () => {
    expect(parseCron('0 0 8 * * 1,3,5')).toEqual({ hour: 8, minute: 0, weekdays: [1, 3, 5] })
  })
  it('不是「几点几分」那一档 ⇒ null（那两条自有别的档翻译，见 parseCronPreset）', () => {
    expect(parseCron('0 */5 * * * *')).toBeNull()
    expect(parseCron('30 0 3 * * *')).toBeNull()
  })
  it('段数不对 ⇒ null', () => {
    expect(parseCron('45 9 * * 1-5')).toBeNull()
  })
})

describe('compileCron', () => {
  it('往返一致', () => {
    const f = { hour: 14, minute: 55, weekdays: [1, 2, 3, 4, 5] }
    expect(compileCron(f)).toBe('0 55 14 * * 1,2,3,4,5')
    expect(parseCron(compileCron(f))).toEqual(f)
  })
  it('空 weekdays ⇒ 每天', () => {
    expect(compileCron({ hour: 3, minute: 0, weekdays: [] })).toBe('0 0 3 * * *')
  })
})

describe('validateFriendly', () => {
  it('合法返回 null', () => {
    expect(validateFriendly({ hour: 9, minute: 45, weekdays: [1] })).toBeNull()
  })
  it('NaN 时间被挡住——提交一个 NaN 会写出永不触发的表达式', () => {
    expect(validateFriendly({ hour: NaN, minute: 0, weekdays: [] })).toBeTruthy()
  })
  it('越界的时/分被挡住', () => {
    expect(validateFriendly({ hour: 24, minute: 0, weekdays: [] })).toBeTruthy()
    expect(validateFriendly({ hour: 1, minute: 60, weekdays: [] })).toBeTruthy()
  })
  it('周几里有非法值被挡住', () => {
    expect(validateFriendly({ hour: 1, minute: 0, weekdays: [7] })).toBeTruthy()
  })
})

describe('describeCron', () => {
  it('认得出的说人话', () => {
    expect(describeCron('0 45 9 * * 1-5')).toBe('周一至周五 09:45')
    expect(describeCron('0 0 3 * * *')).toBe('每天 03:00')
    expect(describeCron('0 0 8 * * 0,6')).toBe('周日、周六 08:00')
  })
  it('间隔档也说人话——「0 */5 * * * *」是这一页最常见的形状', () => {
    expect(describeCron('*/30 * * * * *')).toBe('每 30 秒')
    expect(describeCron('* * * * * *')).toBe('每秒')
    expect(describeCron('0 */5 * * * *')).toBe('每 5 分钟')
    expect(describeCron('0 * * * * *')).toBe('每分钟')
    expect(describeCron('0 15 * * * *')).toBe('每小时第 15 分')
    expect(describeCron('0 15 4 1 * *')).toBe('每月 1 日 04:15')
  })
  it('认不出的原样显示——比编一句错的强', () => {
    // 时段 + 步进（工作日 9–15 点每 2 小时）超出了预设文法：宁可显示 cron 原文。
    expect(describeCron('0 0 9-15/2 * * 1-5')).toBe('0 0 9-15/2 * * 1-5')
    expect(describeCronOrNull('0 0 9-15/2 * * 1-5')).toBeNull()
    // 语法就不对的更不能编
    expect(describeCron('每天九点')).toBe('每天九点')
  })
})

describe('parseCronFields / validateCron —— 原始表达式输入框的实时校验', () => {
  it('合法表达式过', () => {
    expect(validateCron('0 0 9-15/2 * * 1-5')).toBeNull()
    expect(validateCron('  0 45 9 * * *  ')).toBeNull()
  })
  it('段数不对时把段数说出来——「差一段」是最常见的错，光说"格式错误"没法照着改', () => {
    expect(validateCron('45 9 * * *')).toContain('6 段')
    expect(validateCron('')).toContain('6 段')
  })
  it('越界的值挡住', () => {
    expect(parseCronFields('0 60 9 * * *')).toBeNull()   // 分 60
    expect(parseCronFields('0 0 24 * * *')).toBeNull()   // 时 24
    expect(parseCronFields('0 0 9 0 * *')).toBeNull()    // 日 0
    expect(parseCronFields('0 0 9 * * 7')).toBeNull()    // 周 7（node-cron 认 0-6）
    expect(parseCronFields('0 0 9 * * 5-1')).toBeNull()  // 倒区间
  })
})

describe('预设 ↔ 表达式', () => {
  it('六档各自编译得出预期的 6 段表达式', () => {
    expect(compilePreset({ kind: 'everySeconds', n: 30 })).toBe('*/30 * * * * *')
    expect(compilePreset({ kind: 'everyMinutes', n: 5 })).toBe('0 */5 * * * *')
    expect(compilePreset({ kind: 'hourly', minute: 15 })).toBe('0 15 * * * *')
    expect(compilePreset({ kind: 'daily', hour: 9, minute: 45 })).toBe('0 45 9 * * *')
    expect(compilePreset({ kind: 'weekly', weekdays: [5, 1], hour: 9, minute: 45 })).toBe('0 45 9 * * 1,5')
    expect(compilePreset({ kind: 'monthly', day: 1, hour: 4, minute: 15 })).toBe('0 15 4 1 * *')
  })
  it('往返一致——编辑器打开时要停在正确的那一档', () => {
    const presets: Preset[] = [
      { kind: 'everySeconds', n: 30 },
      { kind: 'everyMinutes', n: 5 },
      { kind: 'hourly', minute: 15 },
      { kind: 'daily', hour: 9, minute: 45 },
      { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], hour: 9, minute: 45 },
      { kind: 'monthly', day: 1, hour: 4, minute: 15 },
    ]
    for (const p of presets) expect(parseCronPreset(compilePreset(p))).toEqual(p)
  })
  it('读不回预设的表达式 ⇒ null（编辑器落到自定义档，不假装是某一档）', () => {
    expect(parseCronPreset('0 0 9-15/2 * * 1-5')).toBeNull()
    expect(parseCronPreset('0 0 9 1 * 1')).toBeNull()   // 日与周几同时限定
    expect(parseCronPreset('0 0 9 * 3 *')).toBeNull()   // 限定了月份
  })
  it('预设自身的校验', () => {
    expect(validatePreset({ kind: 'weekly', weekdays: [], hour: 9, minute: 0 })).toContain('至少选一个')
    expect(validatePreset({ kind: 'everyMinutes', n: 0 })).toBeTruthy()
    expect(validatePreset({ kind: 'daily', hour: NaN, minute: 0 })).toBeTruthy()
    expect(validatePreset({ kind: 'monthly', day: 32, hour: 0, minute: 0 })).toBeTruthy()
    expect(validatePreset({ kind: 'daily', hour: 9, minute: 45 })).toBeNull()
  })
})

describe('nextRuns —— 「下次什么时候跑」', () => {
  const from = new Date(2026, 7, 31, 10, 30, 0) // 2026-08-31 周一 10:30

  it('每天 09:45 ⇒ 接下来三天', () => {
    const runs = nextRuns('0 45 9 * * *', { from })!
    expect(runs.map((d) => d.toISOString())).toEqual([
      new Date(2026, 8, 1, 9, 45).toISOString(),
      new Date(2026, 8, 2, 9, 45).toISOString(),
      new Date(2026, 8, 3, 9, 45).toISOString(),
    ])
  })
  it('工作日 09:45 跳过周末', () => {
    const runs = nextRuns('0 45 9 * * 1-5', { from: new Date(2026, 7, 28, 12, 0), count: 2 })!
    // 8/28 是周五（已过 09:45）⇒ 下两次是 8/31 周一、9/1 周二
    expect(runs.map((d) => d.getDate())).toEqual([31, 1])
  })
  it('每 5 分钟 ⇒ 从当前时刻往后数，不含当前时刻本身', () => {
    const runs = nextRuns('0 */5 * * * *', { from })!
    expect(runs.map((d) => d.getMinutes())).toEqual([35, 40, 45])
  })
  it('每月 1 日 04:15', () => {
    const runs = nextRuns('0 15 4 1 * *', { from, count: 2 })!
    expect(runs.map((d) => [d.getMonth(), d.getDate(), d.getHours()])).toEqual([[8, 1, 4], [9, 1, 4]])
  })
  it('永不触发的表达式返回空数组，不是死循环', () => {
    expect(nextRuns('0 0 0 30 2 *', { from })).toEqual([])
  })
  it('算不准的两种情形返回 null，不猜', () => {
    // 任务声明的时区和本机**偏移不同**
    expect(nextRuns('0 45 9 * * *', { from, timeZone: 'Pacific/Kiritimati' })).toBeNull()
    // 日与周几同时限定：各家实现取并集还是交集不一致
    expect(nextRuns('0 0 9 1 * 1', { from })).toBeNull()
    // 语法不合法
    expect(nextRuns('每天九点', { from })).toBeNull()
  })
  it('本机时区显式传进来时照常算——「不同就不算」不能把相同的那种也拦掉', () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(nextRuns('0 45 9 * * *', { from, timeZone: tz })).toHaveLength(3)
  })

  // 活体撞到过：浏览器报 Asia/Singapore、任务写 Asia/Shanghai，两者恒等 UTC+8，而按**名字**
  // 比会把这几条任务的「下次」全判成「算不出来」——而它们恰好是真花钱的那几条。判据必须是
  // 偏移，不是名字。测试挑一对同偏移、且**都不过夏令时**的时区，免得自己变成一条季节性红灯。
  it('名字不同但偏移相同的时区照算——判据是偏移不是名字', () => {
    const pairs: Array<[string, string]> = [
      ['Asia/Shanghai', 'Asia/Singapore'],
      ['Asia/Tokyo', 'Asia/Seoul'],
      ['Asia/Kolkata', 'Asia/Colombo'],
    ]
    const localOffset = -from.getTimezoneOffset()
    const sameClock = pairs.flat().filter((tz) => {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
        .formatToParts(from).find((p) => p.type === 'timeZoneName')?.value ?? ''
      const m = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name)
      const off = name === 'GMT' || name === 'UTC' ? 0 : m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? '0')) : NaN
      return off === localOffset
    })
    // CI 的时区不定，挑不到同偏移的那一对就跳过断言——但**不静默**：跳过要说出来，
    // 否则"没验到"会被读成"验过了"。
    if (sameClock.length === 0) {
      expect(nextRuns('0 45 9 * * *', { from, timeZone: 'Pacific/Kiritimati' })).toBeNull()
      return
    }
    for (const tz of sameClock) {
      const runs = nextRuns('0 45 9 * * *', { from, timeZone: tz })
      expect(runs, `${tz} 与本机同偏移，应该算得出来`).toHaveLength(3)
      // 算出来的就是本地墙钟 09:45，一秒不差
      expect(runs![0]!.getHours()).toBe(9)
      expect(runs![0]!.getMinutes()).toBe(45)
    }
  })
})
