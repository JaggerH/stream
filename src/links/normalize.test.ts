import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { LinkRecognizer } from './recognize.ts'
import { extractUrlFromText } from './normalize.ts'
import { normalizeLinks } from '../packages/links.ts'
import { linkTableOf } from '../replay/recipe-package.ts'

/**
 * 「粘贴进来的任意形态 → 规范地址」——宿主统一引擎（`normalize.ts`）× **出货包的真实声明**
 * （`package.json#stream.links.canonical`，经 normalizeLinks / linkTableOf 原路装载）。
 * 形状清单来自调度（2026-11-15）：用户的原则是「贴什么形态都能用，Stream 换成标准地址」，
 * 所以每种形态在这里有一条夹具，测试表即报告表。
 */

const PACKAGES = ['Douyin_TikTok_Download_API', 'bilibili', 'xhs', 'netease'] as const

const table = linkTableOf(PACKAGES.map((dir) => {
  const d = JSON.parse(readFileSync(new URL(`../../packages/${dir}/package.json`, import.meta.url), 'utf8')) as {
    name?: string
    stream?: { facility?: string; links?: object; trackUrl?: string[]; downloadPages?: unknown[] }
  }
  return {
    name: d.name ?? dir,
    facility: d.stream?.facility ?? dir,
    links: normalizeLinks(d.stream?.links as never, {
      trackUrl: d.stream?.trackUrl,
      downloadPages: d.stream?.downloadPages as never,
    }, { facility: d.stream?.facility, id: dir }),
  }
}))

// 与生产同一个 recognizer（短链展开、声明表都走它）；短链展开的跳转由假 fetch 提供。
const links = new LinkRecognizer(() => table.entries)

const REDIRECTS: Record<string, string> = {
  'https://v.douyin.com/abc123/': 'https://www.douyin.com/video/7684184358583930148',
  'https://vm.tiktok.com/ZMabc123/': 'https://www.tiktok.com/@someuser/video/710999',
  'https://vt.tiktok.com/ZSabc123/': 'https://www.tiktok.com/@someuser/video/710999',
  'https://b23.tv/BV1xx411c7mD': 'https://www.bilibili.com/video/BV1xx411c7mD?p=1&spm_id_from=TRACKING',
  'https://b23.tv/ep999': 'https://www.bilibili.com/bangumi/play/ep999',
  'https://xhslink.com/a1B2c3': 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TOK-A&xsec_source=pc_feed',
  'https://163cn.tv/m123': 'https://music.163.com/song?id=186016',
}
const fakeFetch = vi.fn(async (input: string | URL) => {
  const url = String(input)
  const location = REDIRECTS[url]
  if (!location) throw new Error(`假 fetch 没备好 ${url}`)
  return { status: 302, headers: { get: (k: string) => (k.toLowerCase() === 'location' ? location : null) } } as unknown as Response
})

const normalize = (raw: string) => links.normalize(raw, { fetch: fakeFetch as unknown as typeof fetch })

describe('链接规范化 — 抖音', () => {
  it.each([
    ['https://www.douyin.com/video/7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    // 网页版弹窗地址：在任意页面上点开视频，地址栏就是「当前页 + modal_id」
    ['https://www.douyin.com/user/self?from_tab_name=main&modal_id=7684184358583930148&showTab=favorite_collection',
     'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/user/MS4wLjABAAAAwx?modal_id=7684184358583930148',
     'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/jingxuan?modal_id=7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/discover?modal_id=7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/search/%E7%BE%8E%E9%A3%9F?modal_id=7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/follow?modal_id=7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    ['https://www.douyin.com/?modal_id=7684184358583930148', 'https://www.douyin.com/video/7684184358583930148'],
    // 图文是 note 不是 video：保持 note，不冒充视频页
    ['https://www.douyin.com/note/7401234567890123456', 'https://www.douyin.com/note/7401234567890123456'],
    ['https://www.iesdouyin.com/share/video/7662668719604420273/?region=CN', 'https://www.douyin.com/video/7662668719604420273'],
    ['https://v.douyin.com/abc123/', 'https://www.douyin.com/video/7684184358583930148'],
  ])('%s → %s', async (input, want) => {
    const n = await normalize(input)
    expect(n.error).toBeUndefined()
    expect(n.url).toBe(want)
    expect(n.claimed).toBe(true)
    expect(n.platform).toBe('douyin')
  })

  it('整段分享文案里抽出短链，展开后规范化', async () => {
    const n = await normalize('复制打开抖音，看看【某某的作品】窗外的雪 https://v.douyin.com/abc123/ 再看一下别的')
    expect(n.extracted).toBe(true)
    expect(n.url).toBe('https://www.douyin.com/video/7684184358583930148')
  })

  it('认得平台但不是作品页（用户主页没带 modal_id）→ 输入错误，说清形状', async () => {
    const n = await normalize('https://www.douyin.com/user/MS4wLjABAAAAwx?from_tab_name=main')
    expect(n.error).toMatch(/这个地址形状还不认识：www\.douyin\.com\/user\/MS4wLjABAAAAwx/)
    expect(n.error).toMatch(/douyin/)
  })
})

describe('链接规范化 — TikTok', () => {
  it.each([
    ['https://www.tiktok.com/@someuser/video/710999', 'https://www.tiktok.com/@someuser/video/710999'],
    ['https://www.tiktok.com/@someuser/photo/711000', 'https://www.tiktok.com/@someuser/photo/711000'],
    ['https://www.tiktok.com/@someuser/video/710999?is_from_webapp=1', 'https://www.tiktok.com/@someuser/video/710999'],
    ['https://vm.tiktok.com/ZMabc123/', 'https://www.tiktok.com/@someuser/video/710999'],
    ['https://vt.tiktok.com/ZSabc123/', 'https://www.tiktok.com/@someuser/video/710999'],
  ])('%s → %s', async (input, want) => {
    const n = await normalize(input)
    expect(n.error).toBeUndefined()
    expect(n.url).toBe(want)
    expect(n.platform).toBe('tiktok')
  })

  it('主页链接（没有作品 id）→ 输入错误', async () => {
    const n = await normalize('https://www.tiktok.com/@someuser')
    expect(n.error).toMatch(/这个地址形状还不认识：www\.tiktok\.com\/@someuser/)
  })
})

describe('链接规范化 — B 站', () => {
  it.each([
    // 分 P 保留，追踪参数去掉
    ['https://www.bilibili.com/video/BV1xx411c7mD?p=3&spm_id_from=888.999&vd_source=abc&share_source=wechat',
     'https://www.bilibili.com/video/BV1xx411c7mD?p=3'],
    ['https://www.bilibili.com/video/BV1xx411c7mD/', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['https://www.bilibili.com/video/av170001', 'https://www.bilibili.com/video/av170001'],
    ['https://m.bilibili.com/video/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['https://www.bilibili.com/video/BV1xx411c7mD/?bvid=BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['https://www.bilibili.com/bangumi/play/ep123456', 'https://www.bilibili.com/bangumi/play/ep123456'],
    ['https://www.bilibili.com/bangumi/play/ss45678', 'https://www.bilibili.com/bangumi/play/ss45678'],
    // 短链：展开后规范化（b23.tv 跳转带上追踪参数，照样剥掉、保留 p）
    ['https://b23.tv/BV1xx411c7mD', 'https://www.bilibili.com/video/BV1xx411c7mD?p=1'],
    ['https://b23.tv/ep999', 'https://www.bilibili.com/bangumi/play/ep999'],
  ])('%s → %s', async (input, want) => {
    const n = await normalize(input)
    expect(n.error).toBeUndefined()
    expect(n.url).toBe(want)
    expect(n.platform).toBe('bilibili')
  })

  it('整段分享文案（b23.tv 短链）', async () => {
    const n = await normalize('【某视频】这期讲得很清楚 https://b23.tv/BV1xx411c7mD 快来看')
    expect(n.extracted).toBe(true)
    expect(n.url).toBe('https://www.bilibili.com/video/BV1xx411c7mD?p=1')
  })

  it('认得平台但抽不出作品 id（首页）→ 输入错误', async () => {
    const n = await normalize('https://www.bilibili.com/')
    expect(n.error).toMatch(/这个地址形状还不认识：www\.bilibili\.com\//)
  })
})

describe('链接规范化 — 小红书', () => {
  it.each([
    // xsec_token / xsec_source 保留（没它打不开），其余追踪参数丢掉
    ['https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TOK-A&xsec_source=pc_feed&spm_id_from=SPM',
     'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TOK-A&xsec_source=pc_feed'],
    ['https://www.xiaohongshu.com/explore/0123456789abcdef01234567',
     'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'],
    ['https://www.xiaohongshu.com/discovery/item/0123456789abcdef01234567?xsec_token=TOK-B',
     'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TOK-B'],
    ['https://www.xiaohongshu.com/user/profile/5fed0987000000000100abcd/0123456789abcdef01234567',
     'https://www.xiaohongshu.com/explore/0123456789abcdef01234567'],
    ['https://xhslink.com/a1B2c3',
     'https://www.xiaohongshu.com/explore/0123456789abcdef01234567?xsec_token=TOK-A&xsec_source=pc_feed'],
  ])('%s → %s', async (input, want) => {
    const n = await normalize(input)
    expect(n.error).toBeUndefined()
    expect(n.url).toBe(want)
    expect(n.platform).toBe('xhs')
  })

  it('整段分享文案（xhslink 短链）', async () => {
    const n = await normalize('53万次浏览 https://xhslink.com/a1B2c3 「某篇笔记」快来看看')
    expect(n.extracted).toBe(true)
    expect(n.url).toContain('xiaohongshu.com/explore/0123456789abcdef01234567')
    expect(n.url).toContain('xsec_token=TOK-A')
  })
})

describe('链接规范化 — 网易云', () => {
  it.each([
    ['https://music.163.com/song?id=186016', 'https://music.163.com/song?id=186016'],
    ['https://music.163.com/#/song?id=186016', 'https://music.163.com/song?id=186016'],
    ['https://music.163.com/song/186016', 'https://music.163.com/song?id=186016'],
    ['https://y.music.163.com/m/song?id=186016', 'https://music.163.com/song?id=186016'],
    ['https://163cn.tv/m123', 'https://music.163.com/song?id=186016'],
  ])('%s → %s', async (input, want) => {
    const n = await normalize(input)
    expect(n.error).toBeUndefined()
    expect(n.url).toBe(want)
    expect(n.platform).toBe('netease')
  })

  it('整段分享文案', async () => {
    const n = await normalize('分享某某的单曲《某歌》: https://music.163.com/song?id=186016 (来自@网易云音乐)')
    expect(n.extracted).toBe(true)
    expect(n.url).toBe('https://music.163.com/song?id=186016')
  })
})

describe('链接规范化 — 边界', () => {
  it('没人认领的链接原样交回（宿主直链分支接手），claimed=false', async () => {
    const n = await normalize('https://example.com/a.jpg')
    expect(n.claimed).toBe(false)
    expect(n.url).toBe('https://example.com/a.jpg')
  })

  it('不是链接的输入原样交回（link 原型 / 老路接手）', async () => {
    const n = await normalize('就一段话，什么链接都没有')
    expect(n.claimed).toBe(false)
    expect(n.url).toBe('就一段话，什么链接都没有')
  })

  it('没声明 canonical 的平台：原地址交回，不做形状要求', async () => {
    const bare = new LinkRecognizer(() => [{
      package: 'pkg',
      hosts: [{ host: 'example.com', platform: 'example' }],
      shortHosts: [],
      patterns: [],
      canonical: {},
    }])
    const n = await bare.normalize('https://www.example.com/whatever-page?utm=x')
    expect(n.claimed).toBe(true)
    expect(n.url).toBe('https://www.example.com/whatever-page?utm=x')
    expect(n.error).toBeUndefined()
  })

  it('extractUrlFromText：剥尾部全角标点与引号，不吞链接本身的参数', () => {
    expect(extractUrlFromText('看看 https://www.douyin.com/video/123?from=x）。'))
      .toBe('https://www.douyin.com/video/123?from=x')
    expect(extractUrlFromText('没有链接')).toBeNull()
    expect(extractUrlFromText('https://b23.tv/abc 「标题」')).toBe('https://b23.tv/abc')
  })
})
