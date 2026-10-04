import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chunkRanges, prefetchToFile } from './prefetch.ts'

// 真 HTTP server 测真实 Range 语义——预取的正确性全在字节偏移上，mock 证明不了它。
const PAYLOAD = Buffer.from(
  Array.from({ length: 200_000 }, (_, i) => `line ${i}\n`).join(''),
)

let server: Server
let base: string
let rangeMode: 'ranges' | 'ignore' | 'error' = 'ranges'
const seenRanges: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file' })
      res.end()
      return
    }
    const range = req.headers.range
    if (range) seenRanges.push(range)
    if (rangeMode === 'error') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    if (range && rangeMode === 'ranges') {
      const m = range.match(/bytes=(\d+)-(\d+)/)!
      const [start, end] = [Number(m[1]), Number(m[2])]
      res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${PAYLOAD.length}` })
      res.end(PAYLOAD.subarray(start, end + 1))
      return
    }
    res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
    res.end(PAYLOAD)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(() => new Promise<void>((r) => server.close(() => r())))

describe('chunkRanges', () => {
  it('切出的区间连续覆盖 [0, size) 且互不重叠', () => {
    const ranges = chunkRanges(1001, 4)
    expect(ranges[0][0]).toBe(0)
    expect(ranges.at(-1)![1]).toBe(1000)
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1)
  })

  it('size 为 0 → 没有区间', () => {
    expect(chunkRanges(0, 4)).toEqual([])
  })
})

describe('prefetchToFile', () => {
  it('并行分块拉下来的文件逐字节等于原文件', async () => {
    rangeMode = 'ranges'
    seenRanges.length = 0
    const r = await prefetchToFile(`${base}/file`, { size: PAYLOAD.length, connections: 4 })
    try {
      expect(r.connections).toBe(4)
      expect(seenRanges.length).toBe(4)
      const got = await readFile(r.path)
      expect(got.equals(PAYLOAD)).toBe(true) // 偏移错一个字节这里就炸
    } finally {
      await r.cleanup()
    }
  })

  it('服务端不认 Range（回 200）→ 退回单连接整拉，文件仍然正确', async () => {
    rangeMode = 'ignore'
    const r = await prefetchToFile(`${base}/file`, { size: PAYLOAD.length, connections: 4 })
    try {
      expect(r.connections).toBe(1)
      expect((await readFile(r.path)).equals(PAYLOAD)).toBe(true)
    } finally {
      await r.cleanup()
    }
  })

  it('跟随重定向（CDN 常见）', async () => {
    rangeMode = 'ranges'
    const r = await prefetchToFile(`${base}/redirect`, { size: PAYLOAD.length, connections: 2 })
    try {
      expect((await readFile(r.path)).equals(PAYLOAD)).toBe(true)
    } finally {
      await r.cleanup()
    }
  })

  it('硬失败（5xx）→ 抛出且临时目录已清', async () => {
    rangeMode = 'error'
    await expect(prefetchToFile(`${base}/file`, { size: PAYLOAD.length })).rejects.toThrow('返回 500')
  })

  it('崩溃留下的陈年孤儿目录在下一次预取时被回收，新鲜的和别人的不碰', async () => {
    const { mkdtemp, mkdir, utimes, stat: statP } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const parent = await mkdtemp(join(tmpdir(), 'sweep-test-'))
    const orphan = join(parent, 'stream-prefetch-orphan')
    const fresh = join(parent, 'stream-prefetch-fresh')
    const foreign = join(parent, 'someone-elses-tmp')
    await mkdir(orphan); await mkdir(fresh); await mkdir(foreign)
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(orphan, old, old)
    await utimes(foreign, old, old) // 一样老，但不是我们的前缀

    rangeMode = 'ranges'
    const r = await prefetchToFile(`${base}/file`, { size: PAYLOAD.length, dir: parent })
    await r.cleanup()

    await expect(statP(orphan)).rejects.toThrow() // 孤儿被扫掉
    await expect(statP(fresh)).resolves.toBeTruthy() // 新鲜的（可能正在被别的提取用）不碰
    await expect(statP(foreign)).resolves.toBeTruthy() // 别人的临时文件绝不碰
  })

  it('cleanup 之后本地文件消失', async () => {
    rangeMode = 'ranges'
    const r = await prefetchToFile(`${base}/file`, { size: PAYLOAD.length })
    await r.cleanup()
    await expect(readFile(r.path)).rejects.toThrow()
  })
})
