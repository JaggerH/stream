import { fileURLToPath } from 'node:url'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { linkTableOf, mergeRecipePackagesByFacility, providerDeclarationsOf } from '../replay/recipe-package.ts'
import { recognizeLinkSync, setLinkDeclarationSource } from './recognize.ts'
import { linkDispatchKeyOf } from '../http/fetch-url.ts'
import { trackRefFromUrl } from '../audio/track-url.ts'
import { downloadPageKind } from '../video/resolve.ts'

/**
 * 迁移等价（spec 2026-09-26-link-recognition §8）：真实出货的 `packages/` 改成声明 `stream.links`、派发键改成
 * `<platform>-link` 之后，同一批 URL 给出和改之前一样的答案——`content.enrich` 派发到同一条行、曲目认出
 * 同一个 id、下载页认出同一个类型。右边那一列是改之前（主机键 / trackUrl / downloadPages）当年的答案。
 */
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const { list } = mergeRecipePackagesByFacility(PACKAGES_DIR, mkdtempSync(join(tmpdir(), 'links-mig-')))
const rows = providerDeclarationsOf(list).map((r) => r.declaration)

/** content.enrich 这一键派发到哪一行（只看声明了这个调用点的包行，与 bindings 的默认成员同一个口径）。 */
function enrichRowOf(url: string): string | undefined {
  const key = linkDispatchKeyOf(url)
  return rows.find((r) => r.callsites?.includes('content.enrich') && key && r.serveKeys.includes(key))?.id
}

beforeAll(() => {
  const table = linkTableOf(list)
  expect(table.rejected).toEqual([])
  setLinkDeclarationSource(() => table.entries)
})
afterAll(() => setLinkDeclarationSource(() => []))

describe('贴链接抓媒体：派发到的行不变', () => {
  it.each([
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili-url'],
    ['https://m.bilibili.com/video/BV1xx411c7mD', 'bilibili-url'],
    ['https://b23.tv/abc123', 'bilibili-url'],
    ['https://www.douyin.com/video/7300000000000000000', 'douyin-url'],
    ['https://v.douyin.com/iJqwerty/', 'douyin-url'],
    ['https://www.iesdouyin.com/share/video/7300000000000000000/', 'douyin-url'],
    ['https://www.tiktok.com/@someone/video/7300000000000000000', 'tiktok-url'],
    ['https://vm.tiktok.com/ZMabc/', 'tiktok-url'],
    ['https://www.xiaohongshu.com/explore/64f000000000000000000000', 'xhs-url'],
    ['http://xhslink.com/a/AbCdEf', 'xhs-url'],
  ])('%s → %s', (url, row) => {
    expect(enrichRowOf(url)).toBe(row)
  })

  it('没人认领的站仍没有具名行（落宿主兜底）', () => {
    expect(enrichRowOf('https://example.com/video/1')).toBeUndefined()
  })
})

describe('曲目：认出同一个 id', () => {
  it.each([
    ['https://music.163.com/song?id=186016', '186016'],
    ['https://music.163.com/#/song?id=186016', '186016'],
    ['https://music.163.com/song/186016', '186016'],
  ])('%s → netease:%s', (url, id) => {
    expect(trackRefFromUrl(url)).toEqual({ platform: 'netease', track_id: id })
  })
  it('同站非曲目页不是曲目（但仍归 netease）', () => {
    expect(trackRefFromUrl('https://music.163.com/playlist?id=1')).toBeNull()
    expect(recognizeLinkSync('https://music.163.com/playlist?id=1')?.platform).toBe('netease')
  })
})

describe('下载中转页：认出同一个类型', () => {
  it.each([
    ['https://www.btbtla.com/tdown/842351654.html', 'magnet'],
    ['https://btbtla.com/tdown/1.html', 'magnet'],
    ['https://btbtla.com/pdown/2.html', 'unknown'],
  ])('%s → %s', (url, kind) => {
    expect(downloadPageKind(url)).toBe(kind)
  })
  it('站内别的页不是中转页（SSRF 白名单不放宽）', () => {
    expect(downloadPageKind('https://www.btbtla.com/search/x')).toBeNull()
  })
})
