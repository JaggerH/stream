import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeeCache } from './see-cache.ts'

const win = { x: 0, y: 0, w: 1920, h: 1080 }
describe('SeeCache', () => {
  it('键只看 see 内容 + 窗口尺寸 + 缩放比 + 查哪张表；换缩放或换表键就变', () => {
    const c = new SeeCache(mkdtempSync(join(tmpdir(), 'see-')))
    const k1 = c.key({ text: '搜索' }, win, 2, 'read')
    expect(k1).toBe(c.key({ text: '搜索', region: undefined }, { ...win, x: 500 }, 2, 'read'))
    expect(k1).not.toBe(c.key({ text: '搜索' }, win, 1, 'read'))
    expect(k1).not.toBe(c.key({ text: '搜索', region: 'top' }, win, 2, 'read'))
    // 同一个 see，动作路指的是元素框、判据路指的是文字框——共用一把钥匙就会让判据种下的
    // 文字模板被动作路当靶子，每趟命中、每趟点在按钮内部靠左。
    expect(k1).not.toBe(c.key({ text: '搜索' }, win, 2, 'action'))
  })
  it('point 进键——漏编的表现是拿上一个的模板去下一个的地方匹配，每趟都命中、每趟都点空', () => {
    const c = new SeeCache(mkdtempSync(join(tmpdir(), 'see-')))
    expect(c.key({ point: '消息输入框' }, win, 1, 'action')).not.toBe(c.key({ point: '搜索框' }, win, 1, 'action'))
    // 和同名的 text 目标也不是一把钥匙：两者问的是不同的问题，各自的框也不一样。
    expect(c.key({ point: '搜索' }, win, 1, 'action')).not.toBe(c.key({ text: '搜索' }, win, 1, 'action'))
  })
  it('put/get 带模板；invalidate 后 get 为 null', () => {
    const c = new SeeCache(mkdtempSync(join(tmpdir(), 'see-')))
    const k = c.key({ icon: '放大镜' }, win, 1, 'action')
    c.put(k, { via: 'model', rect: { x: 1, y: 2, w: 3, h: 4 }, at: 1 }, Buffer.from('png'))
    expect(c.get(k)?.entry.via).toBe('model')
    expect(c.get(k)?.template?.toString()).toBe('png')
    c.invalidate(k)
    expect(c.get(k)).toBeNull()
  })
  it('interrupts.json 缺席 → []；坏 JSON → []；正常读出', () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(dir)
    expect(c.interrupts()).toEqual([])
    writeFileSync(join(dir, 'interrupts.json'), '{')
    expect(c.interrupts()).toEqual([])
    writeFileSync(join(dir, 'interrupts.json'), JSON.stringify([{ see: { text: '跳过' }, dismiss: { kind: 'press', key: 'Escape' } }]))
    expect(c.interrupts()).toHaveLength(1)
  })

  /**
   * 这份 JSON 是复盘工具写的，**没经过 recipe 装载器的任何一道闸**。放行一条
   * `dismiss:{kind:'invoke'}`（既没 see 也没 query），runner 就会去 `find({})`——窗口里的
   * 第一个元素，然后 invoke 它。那是替用户按一个谁也不知道是什么的按钮。
   * 坏的那条只丢它自己：一条写坏了不该让今天所有的弹窗都关不掉。
   */
  it('不合法的条目被丢掉（不抛、不连坐），合法的照常返回', () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(dir)
    writeFileSync(join(dir, 'interrupts.json'), JSON.stringify([
      { see: { text: '跳过' }, dismiss: { kind: 'press', key: 'Escape' } },
      { see: { text: 'x' }, dismiss: { kind: 'invoke' } }, // 没有 see 也没有 query
    ]))
    const got = c.interrupts()
    expect(got).toHaveLength(1)
    expect(got[0].see).toEqual({ text: '跳过' })
  })

  it('see 本身写坏的条目也丢掉（text 与 icon 同时给 / 一个都不给）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(dir)
    writeFileSync(join(dir, 'interrupts.json'), JSON.stringify([
      { see: { text: 'a', icon: 'b' }, dismiss: { kind: 'press', key: 'Escape' } },
      { see: {}, dismiss: { kind: 'press', key: 'Escape' } },
      { see: { text: '好的' }, dismiss: { kind: 'invoke', query: { role: 'Button', name: '关闭' } } },
    ]))
    expect(c.interrupts().map((i) => i.see)).toEqual([{ text: '好的' }])
  })

  // 本机这张表不属于任何 recipe，没有顶层 areas 可引用——`interrupts()` 调用 `validateInterrupt`
  // 时不带 opts，`see.area` 在这里必须继续被拒（丢弃这一条，不连坐），别被 recipe 那侧新开的口子带松。
  it('see.area 在本机打断表里不能用，条目被丢弃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'see-'))
    const c = new SeeCache(dir)
    writeFileSync(join(dir, 'interrupts.json'), JSON.stringify([
      { see: { text: 'x', area: '气泡区' }, dismiss: { kind: 'press', key: 'Escape' } },
    ]))
    expect(c.interrupts()).toEqual([])
  })
})
