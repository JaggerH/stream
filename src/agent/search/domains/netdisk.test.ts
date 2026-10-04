// src/agent/search/domains/netdisk.test.ts
import { describe, it, expect, vi } from 'vitest'
import { netdiskDomain } from './netdisk.ts'

// spec 2026-09-26-boundary-stage9 §2.6：Discourse 形状的话题页补抓 .json；补抓失败（抛 / 不是 JSON）
// 回落到原页已经抓回来的文本——改写只是一次尝试，不能把一个本来抽得到链的页面变成空。
describe('netdiskDomain.parse — Discourse .json 补抓与回落', () => {
  const topic = 'https://forum.example.test/t/some-slug/42'
  const shellWithLink = '<html>壳页也可能带着链 https://pan.quark.cn/s/fromshell1</html>'
  const jsonBody = JSON.stringify({ post_stream: { posts: [{ cooked: '合集 https://pan.quark.cn/s/fromjson1' }] } })

  it('改写后的请求回 JSON → 在 JSON 正文上抽', async () => {
    const fetchText = vi.fn(async () => jsonBody)
    const hits = await netdiskDomain({ fetchText }).parse(shellWithLink, topic)
    expect(fetchText).toHaveBeenCalledWith(`${topic}.json`)
    expect(hits.map((h) => h.link)).toEqual(['https://pan.quark.cn/s/fromjson1'])
  })

  it('改写后的请求抛错（非 2xx / 网络）→ 回落原页文本', async () => {
    const fetchText = vi.fn(async () => { throw new Error('HTTP 404') })
    const hits = await netdiskDomain({ fetchText }).parse(shellWithLink, topic)
    expect(hits.map((h) => h.link)).toEqual(['https://pan.quark.cn/s/fromshell1'])
  })

  it('改写后的请求回的不是 JSON（这站只是路径长得像 Discourse）→ 回落原页文本', async () => {
    const fetchText = vi.fn(async () => '<html>not found https://pan.quark.cn/s/notfoundpage</html>')
    const hits = await netdiskDomain({ fetchText }).parse(shellWithLink, topic)
    expect(hits.map((h) => h.link)).toEqual(['https://pan.quark.cn/s/fromshell1'])
  })

  it('不是话题形状 → 不补抓，直接抽原页', async () => {
    const fetchText = vi.fn(async () => jsonBody)
    const hits = await netdiskDomain({ fetchText }).parse(shellWithLink, 'https://forum.example.test/c/cat/3')
    expect(fetchText).not.toHaveBeenCalled()
    expect(hits.map((h) => h.link)).toEqual(['https://pan.quark.cn/s/fromshell1'])
  })
})
