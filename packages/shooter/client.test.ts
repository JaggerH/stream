import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { fetchShooterSubtitle, isAllowedShooterHost, searchShooter, shooterFilehash } from './client.ts'
import { ShooterSubtitleAdapter } from './adapter.ts'

// 搬家等价：以下用例搬自宿主 src/media/subtitle-scrape.test.ts（射手那一半），行为不变；
// 候选 id 是直链本身（宿主再编进 scrape: 命名空间）。

describe('shooterFilehash — 4-segment 4096B MD5 golden', () => {
  it('computes ;-joined md5 over the four offsets for a fixed byte sequence', async () => {
    const size = 40_000
    const full = Buffer.alloc(size)
    for (let i = 0; i < size; i++) full[i] = i % 256
    const read = async (offset: number, len: number) => full.subarray(offset, offset + len)
    const offsets = [4096, Math.floor((size / 3) * 2), Math.floor(size / 3), size - 8192]
    const expected = offsets.map((o) => createHash('md5').update(full.subarray(o, o + 4096)).digest('hex')).join(';')
    expect(await shooterFilehash(read, size)).toBe(expected)
  })
})

describe('searchShooter', () => {
  const read = async (_o: number, l: number) => new Uint8Array(l)

  it('single 0xff byte = no match → [] (not an error)', async () => {
    const fakeFetch = (async () => new Response(new Uint8Array([0xff]), { status: 200 })) as typeof fetch
    expect(await searchShooter({ videoFile: 'x.mkv', size: 40_000, read, fetchImpl: fakeFetch })).toEqual([])
  })

  it('parses Files[].Link into candidates on a hit', async () => {
    const payload = [{ Delay: 0, Files: [{ Ext: 'srt', Link: 'https://www.shooter.cn/files/abc.srt' }] }]
    const fakeFetch = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch
    const out = await searchShooter({ videoFile: 'x.mkv', size: 40_000, read, fetchImpl: fakeFetch })
    expect(out).toEqual([{ id: 'https://www.shooter.cn/files/abc.srt', name: '射手字幕 1', nameHint: 'unknown', label: '射手' }])
  })

  it('没有 size / read（宿主读不了字节）→ []，不打网络', async () => {
    let called = 0
    const f = (async () => { called++; return new Response('') }) as typeof fetch
    expect(await searchShooter({ videoFile: 'x.mkv', fetchImpl: f })).toEqual([])
    expect(called).toBe(0)
  })

  it('network error → []', async () => {
    const boom = (async () => { throw new Error('net') }) as typeof fetch
    expect(await searchShooter({ videoFile: 'x.mkv', size: 40_000, read, fetchImpl: boom })).toEqual([])
  })
})

describe('主机白名单 + 取字节（SSRF 边界住包里）', () => {
  it('allows only shooter hosts', () => {
    expect(isAllowedShooterHost('https://www.shooter.cn/files/x.srt')).toBe(true)
    expect(isAllowedShooterHost('https://evil.example.com/x.srt')).toBe(false)
    expect(isAllowedShooterHost('not a url')).toBe(false)
  })
  it('伪造的 id → 抛，不发请求', async () => {
    let called = 0
    const f = (async () => { called++; return new Response('x') }) as typeof fetch
    await expect(fetchShooterSubtitle('http://10.0.0.1/x', f)).rejects.toThrow(/拒绝/)
    expect(called).toBe(0)
  })
})

describe('ShooterSubtitleAdapter', () => {
  it('op:search 用宿主给的 read/size 算指纹；op:fetch 取字节', async () => {
    const payload = [{ Files: [{ Link: 'https://www.shooter.cn/files/abc.srt' }] }]
    const f = (async (u: string) => (String(u).includes('subapi') ? new Response(JSON.stringify(payload)) : new Response('sub'))) as unknown as typeof fetch
    const a = new ShooterSubtitleAdapter(f)
    let reads = 0
    const hits = await a.fetch({ op: 'search', name: 'x.mkv', size: 40_000, read: async (_o: number, l: number) => { reads++; return new Uint8Array(l) } }) as Array<{ id: string }>
    expect(reads).toBe(4)
    expect(hits).toHaveLength(1)
    const got = await a.fetch({ op: 'fetch', id: hits[0].id }) as Array<{ bytes: Uint8Array }>
    expect(Buffer.from(got[0].bytes).toString()).toBe('sub')
  })
})
