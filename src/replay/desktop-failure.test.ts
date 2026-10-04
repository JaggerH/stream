import { describe, it, expect } from 'vitest'
import { classifyDesktopError, type DesktopFailure } from './desktop-failure.ts'
import { makeDesktopDriver } from './desktop-driver.ts'

/** 本 change 的承重条。
 *
 *  2026-08-01 那次真实故障里，两种完全不同的失败从外面看一模一样：一次点击落到了别的标签上
 *  （返回 `errors: []`，看着像成功），另一次是桌面锁着（底层只丢一句 `blocked by UIPI`）。
 *  **只要它们混成一种，调用方就只能靠反推**——那次反推了两轮才想到去查锁屏。
 *
 *  所以这里逐档钉死：每一种失败都能被认出来，且认不出的**不猜**。 */
describe('桌面失败分类', () => {
  const cases: Array<[string, DesktopFailure]> = [
    ['desktop-locked: 桌面已锁屏，系统不会把合成输入投递到锁着的桌面（读仍然可以）', 'desktop-locked'],
    ['no-foreground-target: 还没确立目标窗口，先 focusApp', 'no-foreground-target'],
    ['foreground-lost: 目标窗口 123 已不在前台（现在是 456）', 'foreground-lost'],
    ['foreground-lost-midway: 打字过程中目标窗口 123 丢了前台（现在是 456）——可能只发出去一部分', 'foreground-lost-midway'],
    ['ambiguous-window: 2 个窗口都匹配，请用 title 指名一个；候选：「扩展程序」、「新标签页」', 'ambiguous-window'],
    ['no-window-match: 没有窗口匹配 AppMatch { process: "telegram.exe" }', 'no-window-match'],
    ['agent-disconnected: Stream Desktop not connected', 'agent-disconnected'],
  ]

  it.each(cases)('%s → %s', (message, reason) => {
    expect(classifyDesktopError(message)).toBe(reason)
  })

  /** 这两档最容易被并成一档（一个是另一个的字符串前缀）。并了的后果很具体：
   *  照 `foreground-lost` 的下一步去重试，会把打了一半的那条消息**再发一遍**。 */
  it('foreground-lost 不许吞掉 foreground-lost-midway', () => {
    expect(classifyDesktopError('foreground-lost-midway: 打到一半')).toBe('foreground-lost-midway')
    expect(classifyDesktopError('foreground-lost: 一个字都没发')).toBe('foreground-lost')
  })

  it('每档两两不同——混任意两档都会让调用方做出错误决定', () => {
    const reasons = cases.map(([, r]) => r)
    expect(new Set(reasons).size).toBe(cases.length)
  })

  it('认不出的错误归 undefined，**不猜**', () => {
    // 把一个陌生错误硬塞进某一档，比不归类更坏：调用方会照着一个错误的判断去重试或放弃
    expect(classifyDesktopError('UIA element not found')).toBeUndefined()
    expect(classifyDesktopError('some-other-code: whatever')).toBeUndefined()
    expect(classifyDesktopError('')).toBeUndefined()
  })
})

describe('做完确认的三态', () => {
  const driverWith = (reply: unknown) => makeDesktopDriver({ send: async () => reply })

  it('agent 报 confirmed:true → 验过且兑现', async () => {
    expect(await driverWith({ confirmed: true }).click({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ confirmed: true })
  })

  it('agent 报 confirmed:false → 动作发出了但预期没兑现（不是错误）', async () => {
    expect(await driverWith({ confirmed: false }).click({ x: 0, y: 0, w: 1, h: 1 })).toEqual({ confirmed: false })
  })

  it('agent 报 {} → **没验**，绝不补成 true', async () => {
    // 没给 expect 却报 confirmed:true 就是撒谎，而这条链路上最贵的一类错误正是这个形状：
    // 一个恒 true 的 focusApp 曾让整晚三次实验的结论全建在流沙上
    expect(await driverWith({}).click({ x: 0, y: 0, w: 1, h: 1 })).toEqual({})
    expect(await driverWith(undefined).type('x')).toEqual({})
  })
})

describe('expect 只在给了的时候才上线', () => {
  const spy = () => {
    const sent: Array<Record<string, unknown>> = []
    const driver = makeDesktopDriver({
      send: async (op) => {
        sent.push(op as unknown as Record<string, unknown>)
        return {}
      },
    })
    return { sent, driver }
  }

  it('给了 expect 就随动作一起发下去', async () => {
    const { sent, driver } = spy()
    await driver.click({ x: 1, y: 2, w: 3, h: 4 }, 'left', { role: 'Text', name: '已保存' })
    expect((sent[0]!.args as Record<string, unknown> | undefined)?.expect).toEqual({ role: 'Text', name: '已保存' })
  })

  it('没给就不发这个字段（别让 agent 侧去分辨 undefined 和"没传"）', async () => {
    const { sent, driver } = spy()
    await driver.click({ x: 1, y: 2, w: 3, h: 4 })
    expect((sent[0]!.args as Record<string, unknown>)).not.toHaveProperty('expect')
  })

  it('type / scroll / invoke 也都带得上——漏一个就是一条验不了的动作通道', async () => {
    const { sent, driver } = spy()
    const e = { role: 'Text', name: 'ok' }
    await driver.type('4K', e)
    await driver.scroll('down', 300, e)
    await driver.invoke('el-1', e)
    expect(sent.map((s) => (s.args as Record<string, unknown>).expect)).toEqual([e, e, e])
  })
})
