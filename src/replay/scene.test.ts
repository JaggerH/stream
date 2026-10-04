import { describe, it, expect } from 'vitest'
import { captureBrowserScene, captureDesktopScene } from './scene.ts'
import type { PageDriver } from '../../shared/browser-relay/page-driver.ts'
import type { DesktopDriver } from './desktop-driver.ts'

const pageDriver = (over: Partial<PageDriver>): PageDriver => ({
  goto: async () => {}, scrollOnce: async () => {}, click: async () => true, back: async () => {},
  type: async () => true, submit: async () => true, sleep: async () => {}, exists: async () => false,
  moveMouse: async () => {}, ...over,
})

describe('captureBrowserScene', () => {
  it('url / 标题 / 正文 / 截图 / 元素清单各自 best-effort，一项失败不影响其它', async () => {
    let calls = 0
    const d = pageDriver({
      currentUrl: async () => 'https://x.com/s?q=1',
      // 按调用顺序分派，不按内容子串匹配：真实 inventoryExpression() 的源码里本身就含
      // "document.title"（它也回 title 字段），子串匹配会让两次调用都命中同一分支。
      evalJson: async () => {
        calls++
        if (calls === 1) return { t: '搜索', x: '结果 1\n结果 2' }
        // 元素清单表达式（inventoryExpression）→ 返回清单形状
        return { url: 'https://x.com/s', title: '搜索', count: 1, truncated: false, items: [{ n: 1, tag: 'button', name: '搜索', rect: { x: 1, y: 2, w: 30, h: 20 } }] }
      },
      shotOf: async () => { throw new Error('tab closing') },
    })
    const s = await captureBrowserScene(d, 'https://x.com')
    expect(s.side).toBe('browser')
    expect(s.url).toBe('https://x.com/s?q=1')
    expect(s.title).toBe('搜索')
    expect(s.text).toContain('结果 1')
    expect(s.shot).toBeUndefined()
    expect(s.elements).toEqual([{ n: 1, tag: 'button', name: '搜索', rect: { x: 1, y: 2, w: 30, h: 20 } }])
    expect(calls).toBe(2)
  })

  it('driver 没有 evalJson / shotOf 时元素为空、截图缺席，不抛', async () => {
    const s = await captureBrowserScene(pageDriver({}), 'https://fallback')
    expect(s.url).toBe('https://fallback')
    expect(s.elements).toEqual([])
    expect(s.shot).toBeUndefined()
  })

  it('driver 有 shotViewport → 用整屏那张，不碰 shotOf', async () => {
    let bodyShots = 0
    const s = await captureBrowserScene(
      pageDriver({
        shotViewport: async () => 'VklFVw==',
        shotOf: async () => { bodyShots++; return 'Qk9EWQ==' },
      }),
      'https://x',
    )
    expect(s.shot).toEqual({ mime: 'image/jpeg', base64: 'VklFVw==' })
    expect(bodyShots).toBe(0)
  })

  /** null 是「试过了、没有」——**不许**再拿 body 裁图去补（那张在滚过几十屏之后必然也失败）。 */
  it('shotViewport 回 null → 现场就没有截图，不回落到 shotOf', async () => {
    let bodyShots = 0
    const s = await captureBrowserScene(
      pageDriver({ shotViewport: async () => null, shotOf: async () => { bodyShots++; return 'Qk9EWQ==' } }),
      'https://x',
    )
    expect(s.shot).toBeUndefined()
    expect(bodyShots).toBe(0)
  })

  it('driver 没有 shotViewport（老 driver）→ 才退回 shotOf(body)', async () => {
    const s = await captureBrowserScene(pageDriver({ shotOf: async () => 'Qk9EWQ==' }), 'https://x')
    expect(s.shot).toEqual({ mime: 'image/jpeg', base64: 'Qk9EWQ==' })
  })
})

describe('captureDesktopScene', () => {
  it('整窗截图 + 元素表 + 文字表缝成一张，元素带 kind', async () => {
    const d = {
      captureWindow: async () => ({ jpeg: Buffer.from('abc'), window: { x: 0, y: 0, w: 800, h: 600 }, scale: 1 }),
      readElements: async () => ({ elements: [{ rect: { x: 1, y: 1, w: 10, h: 10 }, name: '发送', kind: 'a11y' }], window: { x: 0, y: 0, w: 800, h: 600 }, scale: 1 }),
      readText: async () => ({ texts: [{ text: '张三', rect: { x: 5, y: 5, w: 40, h: 12 } }], window: { x: 0, y: 0, w: 800, h: 600 }, scale: 1 }),
      url: async () => 'QQ',
    } as unknown as DesktopDriver
    const s = await captureDesktopScene(d)
    expect(s.side).toBe('desktop')
    expect(s.shot).toEqual({ mime: 'image/jpeg', base64: Buffer.from('abc').toString('base64') })
    expect(s.elements[0]).toMatchObject({ name: '发送', kind: 'a11y' })
    expect(s.text).toContain('张三')
  })

  it('老 agent（readElements / readText 回 null）→ 元素空、文字缺席，不抛', async () => {
    const d = {
      captureWindow: async () => null, readElements: async () => null, readText: async () => null, url: async () => '',
    } as unknown as DesktopDriver
    const s = await captureDesktopScene(d)
    expect(s.elements).toEqual([])
    expect(s.text).toBeUndefined()
    expect(s.shot).toBeUndefined()
  })
})
