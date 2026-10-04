import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BROWSER_UA, getImageNoReferer, getNoReferer } from './image-fetch.ts'
import { setServingPolicySource } from '../media/serving.ts'

let server: Server | undefined
afterEach(() => server?.close())

async function refererEcho(): Promise<{ base: string; seen: Array<string | undefined> }> {
  const seen: Array<string | undefined> = []
  server = createServer((req, res) => {
    seen.push(req.headers.referer)
    res.setHeader('content-type', 'image/png')
    res.end('img')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const { port } = server!.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, seen }
}

/** UA 回声：本地 server 把收到的 `user-agent` 记下来。**钉的是"发出去的 header 里有没有它"
 *  这个可断言的事实**——"某个 CDN 收不收"要联网才有意义，那种用例进了 CI 只会假绿或乱红。 */
async function uaEcho(): Promise<{ base: string; seen: Array<string | undefined> }> {
  const seen: Array<string | undefined> = []
  server = createServer((req, res) => {
    seen.push(req.headers['user-agent'])
    res.setHeader('content-type', 'image/png')
    res.end('img')
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  const { port } = server!.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, seen }
}

describe('getNoReferer', () => {
  it('默认无 Referer（xhs 语义）——本地 server 收到的 referer 为 undefined', async () => {
    const { base, seen } = await refererEcho()
    const r = await getNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000))
    expect(r.status).toBe(200)
    expect(r.contentType).toBe('image/png')
    expect(seen[0]).toBeUndefined()
  })

  // 「这台主机的字节要带哪个 Referer」是包的 serving 声明（站点的图床脾气住它的包里，宿主不认识站）。
  it('serving 表里声明了 referer 的主机：自动带上；没声明的主机照旧不带', async () => {
    const { base, seen } = await refererEcho()
    setServingPolicySource(() => [{ match: '127.0.0.1', label: '夹具', referer: 'https://site.example/' }])
    try {
      await getNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000))
      expect(seen[0]).toBe('https://site.example/')
      setServingPolicySource(() => [{ match: 'other.example', label: '别家', referer: 'https://other.example/' }])
      await getNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000))
      expect(seen[1]).toBeUndefined()
    } finally { setServingPolicySource(() => []) }
  })

  it('显式 opts.referer 透传', async () => {
    const { base, seen } = await refererEcho()
    await getNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000), { referer: 'https://movie.douban.com/' })
    expect(seen[0]).toBe('https://movie.douban.com/')
  })

  // UA 曾经是写死的默认值（跟着豆瓣那次修复顺手进来的，从没被单独证实过），而它是一串固定
  // 指纹，WAF 可以直接拿它当靶子。实测 10 个图床 ×4 种 UA 全部不劣 → 默认改成不发。
  it('默认不发 User-Agent', async () => {
    const { base, seen } = await uaEcho()
    await getNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000))
    expect(seen[0]).toBeUndefined()
  })

  it('图片代理那条也不发（getImageNoReferer 走同一条出站）', async () => {
    const { base, seen } = await uaEcho()
    const r = await getImageNoReferer(`${base}/pic.png`, AbortSignal.timeout(5000))
    expect(r.status).toBe(200)
    expect(seen[0]).toBeUndefined()
  })

  // 视频代理那条**显式**传 UA（那条路没有活体样本能测，所以不跟着改）。这条钉的是"想发就发得出去"。
  it('显式 opts.userAgent 透传', async () => {
    const { base, seen } = await uaEcho()
    await getNoReferer(`${base}/v.mp4`, AbortSignal.timeout(5000), { userAgent: BROWSER_UA })
    expect(seen[0]).toBe(BROWSER_UA)
  })

  it('透传 Range 并回填 content-range/content-length', async () => {
    const seen: Array<string | undefined> = []
    server = createServer((req, res) => {
      seen.push(req.headers.range)
      res.statusCode = 206
      res.setHeader('content-range', 'bytes 0-3/100')
      res.setHeader('content-length', '4')
      res.end('abcd')
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const { port } = server!.address() as AddressInfo
    const r = await getNoReferer(`http://127.0.0.1:${port}/v.mp4`, AbortSignal.timeout(5000), { range: 'bytes=0-3' })
    expect(seen[0]).toBe('bytes=0-3')
    expect(r.contentRange).toBe('bytes 0-3/100')
    expect(r.contentLength).toBe('4')
  })
})
