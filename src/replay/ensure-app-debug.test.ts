import { describe, expect, it } from 'vitest'
import { ensureAppDebugEntry } from './ensure-app-debug.ts'

const field = (e: ReturnType<typeof ensureAppDebugEntry>, label: string) =>
  e.fields.find((f) => f.label === label)?.value

describe('ensureAppDebugEntry', () => {
  it('回执被原样打进 entry —— 包括只有它才带的 pid/window', () => {
    const e = ensureAppDebugEntry('first', {
      running: true,
      started: true,
      pid: 4242,
      process: 'chrome.exe',
      window: { id: 'w1', process: 'chrome.exe', title: '新标签页 - Google Chrome', foreground: true },
    }, 1_700_000_000_000)
    expect(e.channel).toBe('desktop')
    expect(e.key).toBe('ensureApp')
    expect(e.ok).toBe(true)
    expect(field(e, 'running')).toBe('true')
    expect(field(e, 'started')).toBe('true')
    expect(field(e, 'pid')).toBe('4242')
    expect(field(e, 'process')).toBe('chrome.exe')
    expect(field(e, 'window')).toContain('新标签页 - Google Chrome')
    expect(field(e, 'window')).toContain('w1')
  })

  /** 窗口拿不准时 host-agent 不给这个字段——entry 必须说"没有"，不能把它悄悄省掉：
   *  「唤起了却没窗口」正是托盘 Chrome 的签名。 */
  it('缺 window 时留一条显式的空位，且不影响 ok', () => {
    const e = ensureAppDebugEntry('first', { running: true, started: false, process: 'chrome.exe' }, 1)
    expect(e.ok).toBe(true)
    expect(field(e, 'window')).toContain('没拿准')
    expect(field(e, 'pid')).toContain('无')
    expect(e.summary).toContain('本来就在')
  })

  it('running:false = 真失败', () => {
    const e = ensureAppDebugEntry('force', { running: false, started: true, process: 'chrome.exe' }, 1)
    expect(e.ok).toBe(false)
    expect(e.title).toContain('force')
  })

  /** 唤起失败（调用抛错被 catch 成 undefined）比成功更需要留痕。 */
  it('没有回执时也打一条，且是 bad', () => {
    const e = ensureAppDebugEntry('force', undefined, 1)
    expect(e.ok).toBe(false)
    expect(e.summary).toContain('没有回执')
    expect(e.fields[0]?.tone).toBe('bad')
  })

  it('两次 ensure 的 id 不撞（phase 编进 id）', () => {
    const a = ensureAppDebugEntry('first', undefined, 5)
    const b = ensureAppDebugEntry('force', undefined, 5)
    expect(a.id).not.toBe(b.id)
  })
})
