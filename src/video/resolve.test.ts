import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadPageKind, resolveDownloads } from './resolve.ts'
import { setLinkDeclarationSource } from '../links/recognize.ts'
import type { LinkTableEntry } from '../replay/recipe-package.ts'

// 声明表来自包的 links.patterns（真实包的声明由 src/packages/resource-sites.real.test.ts 钉着）；
// 这里挂一份夹具，测的是机制本身。
const DL: LinkTableEntry = {
  package: '@x/dl',
  hosts: [{ host: 'dl.example', platform: 'dl' }],
  shortHosts: [],
  patterns: [
    { kind: 'download-page', pattern: '^https://(www\\.)?dl\\.example/tdown/\\d+\\.html$', platform: 'dl', yields: 'magnet' },
    { kind: 'download-page', pattern: '^https://(www\\.)?dl\\.example/pdown/\\d+\\.html$', platform: 'dl', yields: 'unknown' },
  ],
}
const setDownloadPageSource = (entries: () => LinkTableEntry[]) => setLinkDeclarationSource(entries)
beforeEach(() => setDownloadPageSource(() => [DL]))
afterEach(() => { vi.unstubAllGlobals(); setDownloadPageSource(() => []) })

describe('downloadPageKind ↔ resolveDownloads 的认领对齐', () => {
  // 这两个函数分别喂解析器（needsResolve 标）和 Provider 成员（真解析）。这里钉的是
  // 「打了标的 URL 解析端认账」：分家漂移的症状是前端给出解析按钮、后端 400 拒。
  it('声明为 magnet 的页两边都认领：kind=magnet 且解析端受理', async () => {
    const url = 'https://www.dl.example/tdown/842351654.html'
    expect(downloadPageKind(url)).toBe('magnet')
    vi.stubGlobal('fetch', async () => new Response('<a href="magnet:?xt=urn:btih:ABC123">下载</a>'))
    expect(await resolveDownloads(url)).toEqual([{ url: 'magnet:?xt=urn:btih:ABC123', type: 'magnet' }])
  })

  it('声明为 unknown 的页在册但没有通用解法——decline，不是崩', async () => {
    const url = 'https://www.dl.example/pdown/123.html'
    expect(downloadPageKind(url)).toBe('unknown')
    await expect(resolveDownloads(url)).rejects.toThrow('unsupported url')
  })

  it('册子外的 URL 两边都不认：kind=null，解析 decline 且不发请求（SSRF 白名单）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    for (const url of ['https://pan.quark.cn/s/abc', 'https://evil.com/tdown/1.html', 'https://example.com/x', 'https://dl.example/tdown/1.html?x=1']) {
      expect(downloadPageKind(url)).toBeNull()
      await expect(resolveDownloads(url)).rejects.toThrow('unsupported url')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('包没装（声明表空）→ 谁都不认', async () => {
    setDownloadPageSource(() => [])
    expect(downloadPageKind('https://www.dl.example/tdown/1.html')).toBeNull()
    await expect(resolveDownloads('https://www.dl.example/tdown/1.html')).rejects.toThrow('unsupported url')
  })

  it('受理了但页面里没有磁力 → 报 no magnet found（上游问题，消费端映 502）', async () => {
    vi.stubGlobal('fetch', async () => new Response('<html>empty</html>'))
    await expect(resolveDownloads('https://www.dl.example/tdown/1.html')).rejects.toThrow('no magnet found')
  })
})
