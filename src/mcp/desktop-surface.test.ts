import { describe, it, expect } from 'vitest'
import { desktopAct, desktopLook, desktopOpen } from './desktop-surface.ts'
import { DesktopUnavailable } from '../replay/desktop-failure.ts'
import type { A11yElement, ActOutcome, DesktopDriver } from '../replay/desktop-driver.ts'
import type { ActionSpec } from '../replay/interactive-gate.ts'

/**
 * 桌面动作有两条本质不同的路，这组测试盯的就是"哪一下走了哪条"：
 *
 * - **invoke**：收件人是 a11y 元素句柄，不算坐标、不受遮挡影响、**不需要前台**（锁屏也生效）。
 * - **坐标输入**：投给屏幕上的一个位置，谁在上面谁收下，所以必须先把目标窗口抢到前台。
 *
 * 把两条押在同一道闸下（无条件先 focusApp）的后果是：每次后台定时采集都把用户的屏幕抢过去，
 * 而"人不在时后台干活"正是这条链路的主要用途。
 */

const el = (over: Partial<A11yElement> = {}): A11yElement => ({
  ref: 'r1',
  role: 'Button',
  name: '播放',
  className: '',
  rect: { x: 10, y: 20, w: 30, h: 40 },
  ...over,
})

/** 一个记录调用顺序的假 driver——**顺序本身是断言对象**（抢屏发生在哪一步是重点）。 */
function fakeDriver(
  over: Partial<DesktopDriver> & { found?: A11yElement[]; focusOk?: boolean; unbuilt?: string } = {},
) {
  const calls: string[] = []
  const found = over.found ?? [el()]
  const d: DesktopDriver = {
    async focusApp() {
      calls.push('focusApp')
      return over.focusOk ?? true
    },
    async windows() {
      calls.push('windows')
      return [{ id: 'w0', process: 'chrome.exe', title: 'x', foreground: true }]
    },
    async scopeWindow(match) {
      calls.push('scopeWindow')
      return { id: 'w0', process: match.process ?? '', title: match.title ?? '', foreground: false }
    },
    async find() {
      calls.push('find')
      return { elements: found, ...(over.unbuilt ? { unbuilt: over.unbuilt } : {}) }
    },
    async invoke(ref): Promise<ActOutcome> {
      calls.push(`invoke:${ref}`)
      return { via: 'invoke', confirmed: true }
    },
    async setValue(ref, text): Promise<ActOutcome> {
      calls.push(`setValue:${ref}=${text}`)
      return { via: 'value' }
    },
    async click(rect): Promise<ActOutcome> {
      calls.push(`click:${rect.x},${rect.y}`)
      return { via: 'coords' }
    },
    async moveMouse() {
      calls.push('moveMouse')
      return {}
    },
    async nudge() {
      calls.push('nudge')
      return true
    },
    async status() {},
    async clearInput(): Promise<ActOutcome> {
      calls.push('clearInput')
      return { via: 'coords' }
    },
    async scroll(dir, amount): Promise<ActOutcome> {
      calls.push(`scroll:${dir},${amount}`)
      return { via: 'coords' }
    },
    async type(text): Promise<ActOutcome> {
      calls.push(`type:${text}`)
      return { via: 'coords' }
    },
    async readSubtree() {
      return []
    },
    async screenshot() {
      return null
    },
    async captureWindow() {
      return null
    },
    async readText() {
      return null
    },
    async readElements() {
      return null
    },
    async findImage() {
      return null
    },
    async press() {
      return {}
    },
    async url() {
      return ''
    },
    async sleep() {},
    async ensureApp() {
      return { running: true, started: false, process: 'chrome' }
    },
    ...over,
  }
  return { d, calls }
}

const clickSpec = (over: Partial<ActionSpec> = {}): ActionSpec => ({
  kind: 'click',
  domain: '',
  selector: '{"role":"Button","name":"播放"}',
  ...over,
})

const match = { process: 'chrome.exe' }

describe('desktopAct — 抢不抢屏由实际走的那条路决定', () => {
  it('click 命中元素句柄 → 走 invoke，全程不 focusApp（不抢用户的屏）', async () => {
    const { d, calls } = fakeDriver()
    const out = await desktopAct(d, match, clickSpec())
    expect(calls).toEqual(['scopeWindow', 'find', 'invoke:r1'])
    expect(calls).not.toContain('focusApp')
    expect(out.via).toBe('invoke')
  })

  it('只限定范围、不抢焦点 —— 找元素这一步本身不该改变屏幕', async () => {
    const { d, calls } = fakeDriver()
    await desktopAct(d, match, clickSpec())
    // scopeWindow 必须在 find 之前：不限范围就是在整个桌面上搜，别的窗口的元素会漏进来
    expect(calls.indexOf('scopeWindow')).toBeLessThan(calls.indexOf('find'))
  })

  it('x/y 坐标点击：不查 a11y、不 scopeWindow，先 focusApp 再按点击（自绘应用没有树可查）', async () => {
    const { d, calls } = fakeDriver({ found: [] })
    const out = await desktopAct(d, match, clickSpec({ selector: undefined, x: 1106, y: 237 }))
    expect(calls).toEqual(['focusApp', 'click:1106,237'])
    expect(out.via).toBe('coords')
  })

  it('x/y 只给一半 → 报错，什么都不发', async () => {
    const { d, calls } = fakeDriver({ found: [] })
    await expect(desktopAct(d, match, clickSpec({ selector: undefined, x: 5 }))).rejects.toThrow(/x 与 y 要一起给/)
    expect(calls).toEqual([])
  })

  it('没有句柄才退回坐标 —— 这时才 focusApp，且顺序是 focus 在 click 之前', async () => {
    const { d, calls } = fakeDriver({ found: [el({ ref: '' })] })
    const out = await desktopAct(d, match, clickSpec())
    expect(calls).toEqual(['scopeWindow', 'find', 'focusApp', 'click:10,20'])
    expect(out.via).toBe('coords')
  })

  it('坐标路抢不到前台 → 拒绝，且一个输入都不发出', async () => {
    const { d, calls } = fakeDriver({ found: [el({ ref: '' })], focusOk: false })
    await expect(desktopAct(d, match, clickSpec())).rejects.toThrow(DesktopUnavailable)
    expect(calls).toEqual(['scopeWindow', 'find', 'focusApp'])
  })

  it('抢不到前台报的是 foreground-lost —— 可区分的失败档不能塌成一句笼统的错误', async () => {
    const { d } = fakeDriver({ focusOk: false })
    await expect(desktopAct(d, match, { kind: 'type', domain: '', text: '4K' })).rejects.toMatchObject({
      reason: 'foreground-lost',
    })
  })

  it('type / scroll 仍然先 focusApp —— 键盘打给焦点窗口、滚轮打给光标位置', async () => {
    const { d, calls } = fakeDriver()
    await desktopAct(d, match, { kind: 'type', domain: '', text: '4K' })
    await desktopAct(d, match, { kind: 'scroll', domain: '', px: -300 })
    expect(calls).toEqual(['focusApp', 'type:4K', 'focusApp', 'scroll:up,300'])
  })

  it('选择器一个都没匹配上 → 报错，不退化成对着屏幕乱点', async () => {
    const { d, calls } = fakeDriver({ found: [] })
    await expect(desktopAct(d, match, clickSpec())).rejects.toThrow(/没有元素匹配/)
    expect(calls).not.toContain('focusApp')
  })

  /** 「一个都没匹配上」有两种成因：真的没有，和**根本没读到**（Electron 的 a11y 树懒建，
   *  窗口不在前台时任何查询都回空数组）。agent 挂了旗，报错就必须把它说出来——不然用户
   *  只看到"没有元素匹配 X"，然后去改选择器（而选择器一点毛病都没有）。 */
  it('agent 说树可能没建 → 定位失败的报错里必须带上这句话', async () => {
    const { d } = fakeDriver({ found: [], unbuilt: 'a11y-unbuilt: 窗口 123 不在前台' })
    await expect(desktopAct(d, match, clickSpec())).rejects.toThrow(/a11y-unbuilt/)
  })

  it('expect 原样传给动作，confirmed 原样带回来', async () => {
    const seen: unknown[] = []
    const { d } = fakeDriver({
      async invoke(ref, expectQuery) {
        seen.push(expectQuery)
        return { via: 'invoke', confirmed: false }
      },
    })
    const out = await desktopAct(d, match, clickSpec({ expect: '{"role":"Text","name":"已暂停"}' }))
    expect(seen).toEqual([{ role: 'Text', name: '已暂停' }])
    // 「动作发出了、预期没兑现」不是错误，但也绝不能报成笼统的成功
    expect(out.confirmed).toBe(false)
  })
})

describe('desktopOpen — 唤起应用', () => {
  /** 假 driver 的 ensureApp 只记参数、回一个固定 outcome；这里断言的全是「传下去的是什么」。 */
  function openDriver() {
    const seen: unknown[] = []
    const { d, calls } = fakeDriver({
      async ensureApp(spec) {
        calls.push('ensureApp')
        seen.push(spec)
        return { running: true, started: true, pid: 4242, process: spec.process ?? 'chrome' }
      },
    })
    return { d, calls, seen }
  }

  const openSpec = (over: Partial<ActionSpec> = {}): ActionSpec => ({ kind: 'open', domain: 'desktop', ...over })

  it('把 target 里的进程名 + exe/args 原样交给 ensureApp，并把回执透传', async () => {
    const { d, seen } = openDriver()
    const out = await desktopOpen(d, { process: 'Telegram.exe' }, openSpec({
      exe: 'C:\\Users\\x\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe',
      args: [],
    }))
    expect(seen[0]).toEqual({
      process: 'Telegram.exe',
      exe: 'C:\\Users\\x\\AppData\\Roaming\\Telegram Desktop\\Telegram.exe',
      args: [],
    })
    // 回执是回读出来的事实（running/started/pid），不是"我发过启动命令"
    expect(out).toEqual({ status: 'done', result: { running: true, started: true, pid: 4242, process: 'Telegram.exe' } })
  })

  it('两个都缺席 → 什么都不塞，整份交给 agent 的默认（那默认就是"唤醒用户的 Chrome"）', async () => {
    const { d, seen } = openDriver()
    await desktopOpen(d, { process: 'chrome.exe' }, openSpec())
    expect(seen[0]).toEqual({ process: 'chrome.exe' })
  })

  /** 默认参数属于"默认目标"。agent 的默认 args 是 Chrome 专属的 `--no-startup-window`，
   *  一旦调用方指名了别的可执行文件就不该被继承——喂给 Telegram 轻则被当成待打开的文件名、
   *  重则拒绝启动。所以给了 exe 而没给 args 时，这里替调用方钉成空数组。 */
  it('给了 exe 但没给 args → 补成 []，绝不落到 Chrome 专属的默认参数上', async () => {
    const { d, seen } = openDriver()
    await desktopOpen(d, { process: 'Telegram.exe' }, openSpec({ exe: 'C:\\T\\Telegram.exe' }))
    expect(seen[0]).toEqual({ process: 'Telegram.exe', exe: 'C:\\T\\Telegram.exe', args: [] })
  })

  /** 不指名就没有意义：要开的进程按定义还没有窗口，拿前台窗口当目标只会去"确保已经在最前面的
   *  那个应用还活着"——一个永远成功的空动作，比报错更坏。 */
  it('target 是 desktop（不指名）→ 报错，且一次 ensureApp 都不发', async () => {
    const { d, calls } = openDriver()
    await expect(desktopOpen(d, null, openSpec())).rejects.toThrow(/app:<进程>/)
    expect(calls).not.toContain('ensureApp')
  })

  /** 唤起不该动屏幕：Z 序、焦点、最小化状态一律不碰（`ensureApp` 的语义就是"让进程活着"）。 */
  it('全程不 focusApp、不 scopeWindow', async () => {
    const { d, calls } = openDriver()
    await desktopOpen(d, { process: 'Telegram.exe' }, openSpec({ args: [] }))
    expect(calls).toEqual(['ensureApp'])
  })
})

/**
 * `cdp_look` 是这条链路上唯一「读」的动词，也是这面旗的主战场：模型/人拿到的就是这个 JSON，
 * **不看日志**就得分得出「这个界面上没有这个元素」和「这次根本没读到」。
 */
describe('desktopLook — 空结果要能自证是哪一种空', () => {
  it('agent 挂了 unbuilt 旗 → 回包里带着它出去', async () => {
    const { d } = fakeDriver({ found: [], unbuilt: 'a11y-unbuilt: 窗口 123 不在前台' })
    const out = (await desktopLook(d, match, '{"role":"Button"}')) as { value: unknown; unbuilt?: string }
    expect(out.value).toEqual([])
    expect(out.unbuilt).toContain('a11y-unbuilt')
  })

  it('没挂旗就没有这个字段 —— "没验到"和"验过了、结果是空"不能塌成一个形状', async () => {
    const { d } = fakeDriver({ found: [] })
    const out = (await desktopLook(d, match, '{"role":"Button"}')) as { value: unknown; unbuilt?: string }
    expect(out.value).toEqual([])
    expect(out).not.toHaveProperty('unbuilt')
  })
})
