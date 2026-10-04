import { describe, it, expect } from 'vitest'
import { normHost, parseUrl, splitSource, matchTemplate } from './radar.ts'

describe('normHost', () => {
  it('lowercases and strips a leading www.', () => {
    expect(normHost('WWW.Xiaohongshu.com')).toBe('xiaohongshu.com')
    expect(normHost('space.bilibili.com')).toBe('space.bilibili.com')
  })
})

describe('parseUrl', () => {
  it('extracts host/pathname/query for a plain URL', () => {
    const r = parseUrl('https://www.xiaohongshu.com/user/profile/5ff00abc')!
    expect(r.host).toBe('xiaohongshu.com')
    expect(r.pathname).toBe('/user/profile/5ff00abc')
  })
  it('folds a #/ SPA hash into pathname + query (netease)', () => {
    const r = parseUrl('https://music.163.com/#/song?id=1824045033')!
    expect(r.host).toBe('music.163.com')
    expect(r.pathname).toBe('/song')
    expect(r.query.get('id')).toBe('1824045033')
  })
  it('returns null on non-URL input', () => {
    expect(parseUrl('just some text')).toBeNull()
  })
})

describe('splitSource', () => {
  it('splits host and path at the first slash', () => {
    expect(splitSource('xiaohongshu.com/user/profile/:user_id')).toEqual({ host: 'xiaohongshu.com', path: '/user/profile/:user_id' })
    expect(splitSource('music.163.com/song')).toEqual({ host: 'music.163.com', path: '/song' })
    expect(splitSource('hao6v.com/')).toEqual({ host: 'hao6v.com', path: '/' })
    expect(splitSource('hao6v.com')).toEqual({ host: 'hao6v.com', path: '/' })
  })
})

describe('matchTemplate', () => {
  it('extracts a named param', () => {
    expect(matchTemplate('/user/profile/:user_id', '/user/profile/5ff')).toEqual({ user_id: '5ff' })
  })
  it('matches a literal-only template', () => {
    expect(matchTemplate('/song', '/song')).toEqual({})
  })
  it('rejects extra path segments', () => {
    expect(matchTemplate('/user/profile/:id', '/user/profile/5ff/extra')).toBeNull()
  })
  it('allows an absent optional trailing param', () => {
    expect(matchTemplate('/u/:id/:tab?', '/u/42')).toEqual({ id: '42' })
  })
  it('returns null when a required segment is missing', () => {
    expect(matchTemplate('/user/:id', '/user')).toBeNull()
  })
})

import { RadarMatcher } from './radar.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  } as SourceManifest
}

const registry = new Registry([
  mk({ id: 'douyin-user', description: '抖音用户', params_schema: { sec_user_id: { type: 'string', required: true } },
    radar: [{ source: ['douyin.com/user/:sec_user_id'] }] }),
  // recipe 投影出来的 radar 规则**没有 `target`**（`recipeToManifest` 只把 meta.radar 的模式串
  // 摊成 `{source}`）。所以这一条同时钉住：source 路径本身不带参数时，required 参数仍能从
  // query 里按名取到——netease 的 `#/song?id=` 正是这个形状，没有它贴 URL 订阅就抽不出 id。
  mk({ id: 'toubiec-download', description: '网易云 下载', adapter: 'replay',
    params_schema: { id: { required: true }, level: { required: false } },
    radar: [{ source: ['music.163.com/song'] }] }),
], undefined, [
  mk({ id: 'rsshub:xiaohongshu/user/:user_id/:category/:routeParams?', route: '/xiaohongshu/user/:user_id/:category/:routeParams?',
    description: '小红书 用户', params_schema: { user_id: { required: true }, category: { required: true }, routeParams: { required: false } },
    radar: [{ source: ['xiaohongshu.com/user/profile/:user_id'], target: '/user/:user_id/notes' }] }),
  mk({ id: 'rsshub:xueqiu/user/:id', route: '/xueqiu/user/:id', description: '雪球 用户',
    auth: { type: 'cookie', domain: 'xueqiu.com', inject: { kind: 'env', name: 'XUEQIU_COOKIES' } },
    params_schema: { id: { required: true } }, radar: [{ source: ['xueqiu.com/u/:id'], target: '/user/:id' }] }),
  mk({ id: 'rsshub:hao6v/latestMovies', route: '/hao6v/latestMovies', description: 'hao6v 电影', radar: [{ source: ['hao6v.com/'] }] }),
  mk({ id: 'rsshub:hao6v/latestTVSeries', route: '/hao6v/latestTVSeries', description: 'hao6v 剧集', radar: [{ source: ['hao6v.com/'] }] }),
])
const matcher = new RadarMatcher(registry)

describe('RadarMatcher.match', () => {
  it('resolves a native source with a path param', () => {
    const r = matcher.match('https://www.douyin.com/user/MS4wLjABAAAA')
    expect(r.matches).toContainEqual({ sourceId: 'douyin-user', params: { sec_user_id: 'MS4wLjABAAAA' }, title: '抖音用户' })
  })
  it('fills a target-literal param (xhs category=notes)', () => {
    const r = matcher.match('https://www.xiaohongshu.com/user/profile/5ff00abc')
    const m = r.matches.find((x) => x.sourceId.startsWith('rsshub:xiaohongshu'))!
    expect(m.params).toEqual({ user_id: '5ff00abc', category: 'notes' })
  })
  it('pulls an unbound target param from the query string (netease #/song?id=)', () => {
    const r = matcher.match('https://music.163.com/#/song?id=1824045033')
    const m = r.matches.find((x) => x.sourceId === 'toubiec-download')!
    expect(m.params).toEqual({ id: '1824045033' })
  })
  it('returns every source that claims the URL (multi-candidate)', () => {
    const r = matcher.match('https://hao6v.com/')
    expect(r.matches.map((m) => m.sourceId).sort()).toEqual(['rsshub:hao6v/latestMovies', 'rsshub:hao6v/latestTVSeries'])
  })
  it('carries a cookie source auth domain onto the match; omits it for public sources', () => {
    const cookie = matcher.match('https://xueqiu.com/u/1234')
    expect(cookie.matches.find((m) => m.sourceId === 'rsshub:xueqiu/user/:id')!.authDomain).toBe('xueqiu.com')
    const pub = matcher.match('https://www.douyin.com/user/MS4wLjABAAAA')
    expect(pub.matches.find((m) => m.sourceId === 'douyin-user')!.authDomain).toBeUndefined()
  })

  it('falls back to generic-url for an unmatched URL', () => {
    const r = matcher.match('https://example.com/nothing/here')
    expect(r.matches).toEqual([])
    expect(r.fallback).toBe('generic-url')
  })
  it('marks non-URL input as unknown', () => {
    expect(matcher.match('hello world').fallback).toBe('unknown')
  })
})

import { loadPlugins } from '../plugins/loader.ts'
import { loadScannedRecipePackages } from '../replay/recipe-package.ts'
import { scanPackages } from '../packages/scan.ts'
import { recipeToManifest } from '../replay/recipe-manifest.ts'

describe('native DTDL radar (real manifest)', () => {
  const dtdl = loadPlugins('packages').find((p) => p.id === 'Douyin_TikTok_Download_API')!
  // **两层都要装。** 一个包里的源可以来自 `manifests.yaml`（adapter 成员）**或** `*.recipe.json`
  // （浏览器采集），而 radar 声明跟着源走：抖音的用户时间线 2026-09-22 从前者搬到了后者（容器那条
  // 被 Argus 挡死）。只装 manifests 的话，这道守卫从此只能证明「manifest 里没有它」——搬家时最容易
  // 悄悄丢掉的正是 radar 那一格（丢了不报错，只是「贴个主页链接、Stream 认不出这是什么」）。
  const NS = '@streamapp/douyin-tiktok-download-api'
  // `recipes` 是按**局部 id** 键的、且混着全部包的，所以先把扫描结果收窄到这个包再装载 ——
  // 否则 `packages/douyin/` 的 douyin-search / douyin-collection 会被安上这个包的命名空间。
  const scanned = scanPackages('packages').filter((p) => p.pkgName === NS)
  const recipeSources = [...loadScannedRecipePackages(scanned).recipes.values()]
    .map((r) => recipeToManifest(r, 'douyin', NS))
  const reg = new Registry([...(dtdl.sources ?? []), ...recipeSources])
  const rm = new RadarMatcher(reg)

  // radar 报的 sourceId 是 manifest 的 id = 全名（前缀由 toPluginDescriptor 合成）。
  const dtdlId = (local: string) => `@streamapp/douyin-tiktok-download-api/${local}`

  it('resolves a douyin user URL to the native douyin-user source', () => {
    const r = rm.match('https://www.douyin.com/user/MS4wLjABAAAAxyz')
    expect(r.matches.some((m) => m.sourceId === dtdlId('douyin-user') && m.params.sec_user_id === 'MS4wLjABAAAAxyz')).toBe(true)
  })

  it('resolves a bilibili space URL to the native bilibili user timelines', () => {
    const r = rm.match('https://space.bilibili.com/12345')
    const ids = r.matches.map((m) => m.sourceId)
    expect(ids).toContain(dtdlId('bilibili-user-videos'))
    expect(ids).toContain(dtdlId('bilibili-user-dynamic'))
    expect(r.matches.find((m) => m.sourceId === dtdlId('bilibili-user-videos'))!.params.uid).toBe('12345')
  })
})
