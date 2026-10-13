import { afterEach, describe, expect, test, vi } from 'vitest'
import { api, LOCAL } from './api.ts'
import { firstUrlIn, isEditableTarget, itemFromFetched, resolvePastedLink } from './pasteLink.ts'

afterEach(() => { vi.restoreAllMocks() })

describe('firstUrlIn', () => {
  test('从小红书分享文案里抠出短链，不带后面的中文引导语', () => {
    const text = '58 【周末去哪 - 小明 | 小红书】 😆 abcDEF 😆 http://xhslink.com/a/AbC123，复制本条信息，打开【小红书】App查看精彩内容！'
    expect(firstUrlIn(text)).toBe('http://xhslink.com/a/AbC123')
  })

  test('句末的英文标点不算链接的一部分', () => {
    expect(firstUrlIn('see https://example.com/a?b=1.')).toBe('https://example.com/a?b=1')
    expect(firstUrlIn('(https://example.com/x)')).toBe('https://example.com/x')
  })

  test('没有链接回 null', () => {
    expect(firstUrlIn('just some words')).toBeNull()
    expect(firstUrlIn('')).toBeNull()
  })
})

describe('isEditableTarget', () => {
  test('输入框、文本域、contenteditable 里都算可编辑', () => {
    const input = document.createElement('input')
    const area = document.createElement('textarea')
    const rich = document.createElement('div')
    rich.setAttribute('contenteditable', 'true')
    const inner = document.createElement('span')
    rich.appendChild(inner)
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(area)).toBe(true)
    expect(isEditableTarget(inner)).toBe(true)
  })

  test('普通元素和 body 不算', () => {
    expect(isEditableTarget(document.body)).toBe(false)
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('itemFromFetched', () => {
  test('有图就是图集，标题缺省时用正文第一行', () => {
    const item = itemFromFetched('https://x.test/n/1', {
      platform: 'xhs', author: '小明', text: '\n第一行\n第二行',
      media: [{ kind: 'image', url: 'https://img.test/1.jpg' }],
    })
    expect(item.title).toBe('第一行')
    expect(item.author).toBe('小明')
    expect(item.content).toMatchObject({ archetype: 'gallery', text: '\n第一行\n第二行', media: [{ kind: 'image', url: 'https://img.test/1.jpg' }] })
  })

  test('有视频就是视频', () => {
    const item = itemFromFetched('https://x.test/v/1', {
      platform: 'douyin', title: '一条视频',
      media: [{ kind: 'video', url: 'https://v.test/1.mp4', poster: 'https://v.test/1.jpg' }],
    })
    expect(item.content?.archetype).toBe('video')
    expect(item.title).toBe('一条视频')
  })
})

describe('resolvePastedLink', () => {
  test('有包认领：用展开后的地址去现取', async () => {
    vi.spyOn(api, 'recognizeLink').mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/1', package: 'p', platform: 'xhs' })
    const from = vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'xhs', title: '笔记', media: [] })
    const r = await resolvePastedLink(LOCAL, 'http://xhslink.com/a/1')
    expect(from).toHaveBeenCalledWith(LOCAL, 'https://www.xiaohongshu.com/explore/1')
    expect(r).toMatchObject({ item: { title: '笔记', url: 'https://www.xiaohongshu.com/explore/1' } })
  })

  // 认领了却没取到，不能退成网页正文——平台页面抽出来只会是登录墙。
  test('有包认领但现取失败：报失败，不退网页正文', async () => {
    vi.spyOn(api, 'recognizeLink').mockResolvedValue({ url: 'https://www.xiaohongshu.com/explore/1', package: 'p', platform: 'xhs' })
    vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'unknown', media: [], error: '扩展没连上' })
    expect(await resolvePastedLink(LOCAL, 'https://www.xiaohongshu.com/explore/1')).toEqual({ error: '扩展没连上' })
  })

  test('没人认领的网页：做成 link 原型，详情自己抽正文', async () => {
    vi.spyOn(api, 'recognizeLink').mockResolvedValue(null)
    vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'unknown', media: [], error: '不是支持的媒体来源' })
    const r = await resolvePastedLink(LOCAL, 'https://blog.test/post')
    expect(r).toMatchObject({ item: { url: 'https://blog.test/post', content: { archetype: 'link' } } })
  })

  test('没人认领的图片直链：照现取结果打开', async () => {
    vi.spyOn(api, 'recognizeLink').mockResolvedValue(null)
    vi.spyOn(api, 'mediaFromUrl').mockResolvedValue({ platform: 'image', media: [{ kind: 'image', url: 'https://img.test/a.png' }] })
    const r = await resolvePastedLink(LOCAL, 'https://img.test/a.png')
    expect(r).toMatchObject({ item: { content: { archetype: 'gallery' } } })
  })

  test('网络错误收成一句原因，不抛', async () => {
    vi.spyOn(api, 'recognizeLink').mockRejectedValue(new Error('后端没起'))
    expect(await resolvePastedLink(LOCAL, 'https://a.test')).toEqual({ error: '后端没起' })
  })
})
