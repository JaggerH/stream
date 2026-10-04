import { describe, it, expect, afterEach, vi } from 'vitest'
import { recognizeLink, recognizeLinkSync, setLinkDeclarationSource, setLinkDebugSink, type LinkDebug } from './recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

const PKG: LinkTableEntry = {
  package: '@x/pkg',
  hosts: [{ host: 'pkgsite.com', platform: 'pkg' }, { host: 'sho.rt', platform: 'pkg' }],
  shortHosts: ['sho.rt'],
  patterns: [
    { kind: 'track', pattern: '^https?://(?:www\\.)?pkgsite\\.com/song/(?<id>\\d+)', platform: 'pkg' },
    { kind: 'download-page', pattern: '^https://pkgsite\\.com/down/\\d+\\.html$', platform: 'pkg', yields: 'magnet' },
  ],
}
const OTHER: LinkTableEntry = {
  package: 'other',
  hosts: [{ host: 'm.pkgsite.com', platform: 'mob' }, { host: 'two.com', platform: 'two' }],
  shortHosts: [],
  patterns: [{ kind: 'track', pattern: '^https://two\\.com/(?<id>\\w+)', platform: 'two' }],
}

afterEach(() => { setLinkDeclarationSource(() => []); setLinkDebugSink(() => {}) })

describe('recognizeLinkSync', () => {
  it('pattern 命中给出 kind / id', () => {
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('https://www.pkgsite.com/song/42?x=1')).toEqual({ url: 'https://www.pkgsite.com/song/42?x=1', package: '@x/pkg', platform: 'pkg', kind: 'track', id: '42' })
    expect(recognizeLinkSync('https://pkgsite.com/down/7.html')).toEqual({ url: 'https://pkgsite.com/down/7.html', package: '@x/pkg', platform: 'pkg', kind: 'download-page', yields: 'magnet' })
  })

  it('track 大小写不敏感，download-page 不是', () => {
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('https://PKGSITE.com/SONG/1')?.id).toBe('1')
    expect(recognizeLinkSync('https://pkgsite.com/DOWN/7.html')?.kind).toBeUndefined()
  })

  it('只有主机命中 → 只给 platform', () => {
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('https://pkgsite.com/user/9')).toEqual({ url: 'https://pkgsite.com/user/9', package: '@x/pkg', platform: 'pkg' })
  })

  it('后缀按 label 边界：evil-pkgsite.com 不算，子域算', () => {
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('https://evil-pkgsite.com/song/1')).toBeNull()
    expect(recognizeLinkSync('https://a.b.pkgsite.com/x')?.platform).toBe('pkg')
  })

  it('嵌套主机分属两个包：最长后缀胜', () => {
    setLinkDeclarationSource(() => [PKG, OTHER])
    expect(recognizeLinkSync('https://m.pkgsite.com/x')).toMatchObject({ package: 'other', platform: 'mob' })
    expect(recognizeLinkSync('https://www.pkgsite.com/x')).toMatchObject({ package: '@x/pkg', platform: 'pkg' })
  })

  it('pattern 声明序先赢（先于主机判）', () => {
    setLinkDeclarationSource(() => [PKG, OTHER])
    expect(recognizeLinkSync('https://two.com/abc')).toMatchObject({ platform: 'two', kind: 'track', id: 'abc' })
  })

  it('非 http(s) / 非 URL / 没人认领 → null', () => {
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('magnet:?xt=urn:btih:a')).toBeNull()
    expect(recognizeLinkSync('pkgsite.com/song/1')).toBeNull()
    expect(recognizeLinkSync('https://example.com/')).toBeNull()
    expect(recognizeLinkSync('')).toBeNull()
  })

  it('每次现取声明表：换源立刻生效', () => {
    setLinkDeclarationSource(() => [])
    expect(recognizeLinkSync('https://pkgsite.com/song/1')).toBeNull()
    setLinkDeclarationSource(() => [PKG])
    expect(recognizeLinkSync('https://pkgsite.com/song/1')?.id).toBe('1')
  })
})

const redirect = (to: string) => new Response(null, { status: 302, headers: { location: to } })

describe('recognizeLink —— 短链先展开', () => {
  it('非短链不发请求', async () => {
    setLinkDeclarationSource(() => [PKG])
    const f = vi.fn()
    expect(await recognizeLink('https://pkgsite.com/song/3', { fetch: f })).toMatchObject({ id: '3' })
    expect(f).not.toHaveBeenCalled()
  })

  it('短链跟一跳，认到目标', async () => {
    setLinkDeclarationSource(() => [PKG])
    const f = vi.fn(async () => redirect('https://pkgsite.com/song/5'))
    expect(await recognizeLink('https://sho.rt/abc', { fetch: f as never })).toEqual({ url: 'https://pkgsite.com/song/5', package: '@x/pkg', platform: 'pkg', kind: 'track', id: '5' })
    expect(f).toHaveBeenCalledTimes(1)
    expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' })
  })

  it('只对 shortHosts 发请求：展开到非短链的认领主机就停，不再往下打', async () => {
    setLinkDeclarationSource(() => [PKG])
    const calls: string[] = []
    const f = vi.fn(async (u: string) => { calls.push(u); return redirect('https://pkgsite.com/x') })
    await recognizeLink('https://sho.rt/a', { fetch: f as never })
    expect(calls).toEqual(['https://sho.rt/a'])
  })

  it('最多 3 跳（短链指向短链的环）', async () => {
    setLinkDeclarationSource(() => [PKG])
    let n = 0
    const f = vi.fn(async () => redirect(`https://sho.rt/${++n}`))
    const r = await recognizeLink('https://sho.rt/0', { fetch: f as never })
    expect(f).toHaveBeenCalledTimes(3)
    expect(r).toMatchObject({ url: 'https://sho.rt/3', platform: 'pkg' })
  })

  it('下一跳主机没人认领 → 停下，按当前地址认，不替陌生主机发请求', async () => {
    setLinkDeclarationSource(() => [PKG])
    const debug: LinkDebug[] = []
    setLinkDebugSink((e) => debug.push(e))
    const f = vi.fn(async () => redirect('https://evil.example/landing'))
    const r = await recognizeLink('https://sho.rt/a', { fetch: f as never })
    expect(r).toMatchObject({ url: 'https://sho.rt/a', platform: 'pkg' })
    expect(f).toHaveBeenCalledTimes(1)
    expect(debug[0]?.ok).toBe(true)
  })

  it('展开失败 → 按原链接认，原因进 debug（不吞成没人认领）', async () => {
    setLinkDeclarationSource(() => [PKG])
    const debug: LinkDebug[] = []
    setLinkDebugSink((e) => debug.push(e))
    const f = vi.fn(async () => { throw new Error('ECONNRESET') })
    const r = await recognizeLink('https://sho.rt/a', { fetch: f as never })
    expect(r).toMatchObject({ url: 'https://sho.rt/a', platform: 'pkg' })
    expect(debug).toEqual([expect.objectContaining({ ok: false, summary: expect.stringContaining('ECONNRESET') })])
  })

  it('非 3xx（200 落地页）→ 按当前地址认', async () => {
    setLinkDeclarationSource(() => [PKG])
    const f = vi.fn(async () => new Response('ok', { status: 200 }))
    expect(await recognizeLink('https://sho.rt/a', { fetch: f as never })).toMatchObject({ url: 'https://sho.rt/a' })
  })
})
