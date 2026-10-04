import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadRsshubCatalog, radarApex, isRetiredRoute, hostClaimsNamespace } from './rsshub-catalog.ts'

const FIXTURE = {
  bilibili: {
    name: 'bilibili 哔哩哔哩',
    routes: {
      '/user/dynamic/:uid': {
        path: '/user/dynamic/:uid',
        name: 'UP 主动态',
        categories: ['social-media'],
        parameters: { uid: '用户 id' },
        features: { requirePuppeteer: false, requireConfig: [{ name: 'BILIBILI_COOKIE_*' }], nsfw: false },
        description: '::: tip\n在 UP 主页 URL 里找到 uid 填入。\n:::',
        url: 'space.bilibili.com',
        radar: [
          { source: ['space.bilibili.com/:uid', 'space.bilibili.com/:uid/dynamic'], target: '/user/dynamic/:uid' },
          { source: ['space.bilibili.com/:uid'], target: '/user/dynamic/:uid' },
        ],
      },
      '/ranking/:rid?': {
        path: '/ranking/:rid?',
        name: '排行榜',
        parameters: { rid: '分区' },
        features: { requirePuppeteer: true }, // should be skipped
      },
    },
  },
  hackernews: {
    name: 'Hacker News',
    routes: { '/best': { path: '/best', name: 'Best' } },
  },
  // Real RSSHub data shapes the loader must tolerate: `source` as a bare string
  // (not an array), and `radar` as a single object (not an array). A route like
  // this in the real catalog previously threw `(r.source ?? []).filter is not a
  // function` and killed the entire catalog load.
  gov: {
    name: 'Gov',
    routes: {
      '/gzw/:category': {
        path: '/gzw/:category',
        name: '国资委',
        parameters: { category: '栏目' },
        radar: { source: 'gzw.cq.gov.cn/:category', target: '/gzw/:category' } as never,
      },
      '/notice/:id': {
        path: '/notice/:id',
        name: '通知',
        parameters: { id: 'id' },
        radar: [{ source: 'notice.example.com/:id' } as never],
      },
    },
  },
  github: {
    name: 'GitHub',
    routes: {
      '/search/:query/:sort?': {
        path: '/search/:query/:sort?',
        name: '仓库搜索',
        categories: ['programming'],
        parameters: {
          query: '关键词',
          sort: {
            description: '排序',
            default: 'best',
            options: [
              { label: '最佳匹配', value: 'best' },
              { label: '最近更新', value: 'updated' },
            ],
          },
        },
      },
    },
  },
  xiaohongshu: {
    name: '小红书',
    routes: {
      '/user/:user_id/:category/:routeParams?': {
        path: '/user/:user_id/:category/:routeParams?',
        name: '用户笔记/收藏',
        categories: ['social-media'],
        parameters: {
          user_id: 'user id, length 24 characters',
          category: {
            description: 'category, notes or collect',
            options: [
              { value: 'notes', label: 'notes' },
              { value: 'collect', label: 'collect' },
            ],
            default: 'notes',
          },
          routeParams: {
            description: 'displayLivePhoto',
            default: '0',
          },
        },
        features: { requirePuppeteer: true, antiCrawler: true, requireConfig: [{ name: 'XIAOHONGSHU_COOKIE' }] },
        example: '/xiaohongshu/user/593032945e87e77791e03696/notes',
        radar: [{ source: ['www.xiaohongshu.com/user/profile/:user_id'], target: '/user/:user_id/notes' }],
      },
    },
  },
  weibo: {
    name: '微博',
    routes: {
      // array-of-descriptors requireConfig — the current RSSHub shape (not a boolean).
      // This login route carries NO radar (real RSSHub shape); the domain must come from
      // a sibling public route's radar via namespace aggregation.
      '/user/:uid': {
        path: '/user/:uid',
        name: '博主',
        categories: ['social-media'],
        parameters: { uid: '用户 id' },
        features: { requireConfig: [{ name: 'WEIBO_COOKIES', description: 'login cookie' }] },
      },
      '/timeline/:uid': {
        path: '/timeline/:uid',
        name: '时间线',
        categories: ['social-media'],
        parameters: { uid: '用户 id' },
        radar: [{ source: ['s.weibo.com/:uid', 'weibo.com/:uid'], target: '/timeline/:uid' }],
      },
    },
  },
  xueqiu: {
    name: '雪球',
    routes: {
      '/user/:id': {
        path: '/user/:id',
        name: '用户动态',
        categories: ['finance'],
        parameters: { id: '用户 id' },
        features: { requireConfig: [{ name: 'XUEQIU_COOKIES' }] },
        radar: [{ source: ['xueqiu.com/u/:id'], target: '/user/:id' }],
      },
    },
  },
  // requireConfig but NO radar anywhere in the namespace → domain underivable → auth:none
  // (must not throw, must not crash the catalog build).
  apionly: {
    name: 'API Only',
    routes: {
      '/feed': {
        path: '/feed',
        name: 'Feed',
        features: { requireConfig: [{ name: 'APIONLY_TOKEN' }] },
      },
    },
  },
  '4gamers': {
    name: '4Gamers',
    routes: {
      '/': {
        path: ['/', '/category/:category'],
        name: 'Unknown',
      },
      '/category/:category': {
        path: ['/', '/category/:category'],
        name: 'Unknown',
      },
      '/topic/:topic': {
        path: '/topic/:topic',
        name: '主題',
        categories: ['game'],
        parameters: { topic: '主题，可在首页上方页面内找到' },
      },
      '/tag/:tag': {
        path: '/tag/:tag',
        name: '标签',
        categories: ['game'],
        parameters: { tag: '标签名，可在标签 URL 中找到' },
      },
    },
  },
  '163': {
    name: '网易',
    routes: {
      '/music/playlist/:id': {
        path: '/music/playlist/:id',
        name: '歌单',
        categories: ['multimedia'],
        parameters: { id: '歌单 ID' },
        radar: [{ source: ['music.163.com/playlist'], target: '/music/playlist/:id' }],
      },
    },
  },
  anime1: {
    name: 'Anime1',
    routes: {
      'search/:keyword': {
        path: 'search/:keyword',
        name: 'Search',
        parameters: { keyword: 'Anime1 Search Keyword' },
      },
      'anime/:category/:name': {
        path: 'anime/:category/:name',
        name: 'Anime',
        parameters: { category: 'Anime1 Category', name: 'Anime1 Name' },
      },
    },
  },
}

describe('radarApex', () => {
  it('takes the apex of a single path-bearing source host', () => {
    expect(radarApex(['space.bilibili.com/:uid'])).toBe('bilibili.com')
    expect(radarApex(['s.weibo.com/u/:id'])).toBe('weibo.com')
    expect(radarApex(['xueqiu.com/u/:id'])).toBe('xueqiu.com')
    expect(radarApex(['www.xiaohongshu.com/user/profile/:id'])).toBe('xiaohongshu.com')
  })

  it('dedups multiple sources that share an apex', () => {
    expect(radarApex(['s.weibo.com/:uid', 'weibo.com/:uid', 'm.weibo.com/u/:id'])).toBe('weibo.com')
  })

  it('picks the majority apex; ties and empties are undefined', () => {
    expect(radarApex(['a.foo.com/x', 'b.foo.com/y', 'bar.com/z'])).toBe('foo.com')
    expect(radarApex(['foo.com/x', 'bar.com/y'])).toBeUndefined() // tie
    expect(radarApex([])).toBeUndefined()
    expect(radarApex(['nohost'])).toBeUndefined()
  })
})

describe('loadRsshubCatalog', () => {
  let dir: string
  let path: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cat-'))
    path = join(dir, 'routes.json')
    writeFileSync(path, JSON.stringify(FIXTURE))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds catalog manifests, skips puppeteer routes', () => {
    const cat = loadRsshubCatalog(path)
    const ids = cat.map((m) => m.id)
    expect(ids).toContain('rsshub:bilibili/user/dynamic/:uid')
    expect(ids).toContain('rsshub:hackernews/best')
    expect(ids).not.toContain('rsshub:bilibili/ranking/:rid?') // puppeteer skipped
    // 没有包出面反证那个标记 → 标了 puppeteer 的一律丢，源码不点名任何站。
    expect(ids).not.toContain('rsshub:xiaohongshu/user/:user_id/:category/:routeParams?')
  })

  it('noBrowserNamespaces（包声明）里的命名空间：标了 puppeteer 的路由照常进目录，别的命名空间仍丢', () => {
    const ids = loadRsshubCatalog(path, { noBrowserNamespaces: new Set(['xiaohongshu']) }).map((m) => m.id)
    expect(ids).toContain('rsshub:xiaohongshu/user/:user_id/:category/:routeParams?')
    expect(ids).not.toContain('rsshub:bilibili/ranking/:rid?')
  })

  it('退役路由不进 catalog——名单来自包声明（stream.retires），不是源码', () => {
    const withLizhi = {
      ...FIXTURE,
      lizhi: { name: '荔枝 FM', routes: { '/user/:id': { name: '用户音频', categories: ['multimedia'] } } },
    }
    writeFileSync(path, JSON.stringify(withLizhi))
    const retired = new Map([['rsshub:lizhi/user/:id', '荔枝关掉了 web 端接口']])
    expect(loadRsshubCatalog(path, { retired }).map((m) => m.id)).not.toContain('rsshub:lizhi/user/:id')
    // 没有包声明它退役 → 照常进目录（源码不再有自己的名单）
    expect(loadRsshubCatalog(path).map((m) => m.id)).toContain('rsshub:lizhi/user/:id')
  })

  it('isRetiredRoute 只查传入的表', () => {
    const retired = new Map([['rsshub:lizhi/user/:id', '理由']])
    expect(isRetiredRoute('rsshub:lizhi/user/:id', retired)).toBe(true)
    expect(isRetiredRoute('rsshub:bilibili/user/dynamic/:uid', retired)).toBe(false)
    expect(isRetiredRoute('rsshub:lizhi/user/:id', new Map())).toBe(false)
  })

  it('命名空间 normalizer：只有包声明的那些；没声明则 undefined', () => {
    const by = (id: string) => loadRsshubCatalog(path, { namespaceNormalizers: new Map([['163', { normalizer: 'netease', label: '网易云音乐' }]]) }).find((m) => m.id === id)!
    expect(by('rsshub:163/music/playlist/:id').normalizer).toBe('netease')
    expect(by('rsshub:163/music/playlist/:id').facility).toEqual({ key: '163', label: '网易云音乐' })
  })

  // 「包认领撞上宿主一律拒」的闸（parseRsshubCatalog 里 hostClaimsNamespace 那一步）真实调用时永远
  // 只吃 NS_NORMALIZER 的键集合（今天是空的），所以生产行为不变；但这道闸本身——拒 + onRefusedClaim
  // 出声、不许静默盖过——是活的守卫，不能因为宿主表空了就没有测试盯着。`CatalogOptions.hostNamespaces`
  // 是专为这个撞车场景开的测试口子（见 hostClaimsNamespace 头注），从外部把"宿主已认领某 ns"这件事
  // 重新变得可构造。
  it('包认领一个宿主已认领的命名空间 → 认领被丢弃并报出来（不许静默盖过宿主表）', () => {
    const refused: Array<{ ns: string; normalizer: string }> = []
    const cat = loadRsshubCatalog(path, {
      hostNamespaces: new Set(['163']),
      namespaceNormalizers: new Map([['163', { normalizer: 'impostor', label: '冒名顶替' }]]),
      onRefusedClaim: (r) => refused.push(r),
    })
    const m = cat.find((x) => x.id === 'rsshub:163/music/playlist/:id')!
    // 拒绝之后 nsClaims 里没有 '163' 这一行，normalizer 落回 NS_NORMALIZER['163']（表空 → undefined）；
    // 关键是它**不是** 'impostor'——包的认领没有静默生效。
    expect(m.normalizer).toBeUndefined()
    expect(m.facility?.label).not.toBe('冒名顶替')
    expect(refused).toEqual([{ ns: '163', normalizer: 'impostor' }])
  })

  it('hostClaimsNamespace 是那张宿主表的唯一问法（默认吃 NS_NORMALIZER 的键集合，表空时恒不触发；第二个参数只为测试重新变得可构造）', () => {
    expect(hostClaimsNamespace('anything')).toBe(false)
    expect(hostClaimsNamespace('163')).toBe(false)
    expect(hostClaimsNamespace('163', new Set(['163']))).toBe(true)
    expect(hostClaimsNamespace('anything', new Set(['163']))).toBe(false)
  })

  it('没有包认领时那个命名空间不带 normalizer（源码里不再有它的名字）', () => {
    expect(loadRsshubCatalog(path).find((m) => m.id === 'rsshub:163/music/playlist/:id')!.normalizer).toBeUndefined()
  })

  it('ingests radar source patterns into matchers (deduped union), omits when absent', () => {
    const cat = loadRsshubCatalog(path)
    const bili = cat.find((m) => m.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(new Set(bili.matchers)).toEqual(new Set(['space.bilibili.com/:uid', 'space.bilibili.com/:uid/dynamic']))
    const hn = cat.find((m) => m.id === 'rsshub:hackernews/best')!
    expect(hn.matchers).toBeUndefined()
  })

  it('carries structured radar rules (source + target) onto the manifest', () => {
    const cat = loadRsshubCatalog(path)
    const bili = cat.find((m) => m.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(bili.radar).toEqual([
      { source: ['space.bilibili.com/:uid', 'space.bilibili.com/:uid/dynamic'], target: '/user/dynamic/:uid' },
      { source: ['space.bilibili.com/:uid'], target: '/user/dynamic/:uid' },
    ])
    const hn = cat.find((m) => m.id === 'rsshub:hackernews/best')!
    expect(hn.radar).toBeUndefined()
  })

  it('tolerates string `source` and object (non-array) `radar` without dropping the catalog', () => {
    // Must not throw, and must normalize both odd shapes into array-form radar rules.
    const cat = loadRsshubCatalog(path)
    const gzw = cat.find((m) => m.id === 'rsshub:gov/gzw/:category')!
    expect(gzw.radar).toEqual([{ source: ['gzw.cq.gov.cn/:category'], target: '/gzw/:category' }])
    expect(gzw.matchers).toEqual(['gzw.cq.gov.cn/:category'])
    const notice = cat.find((m) => m.id === 'rsshub:gov/notice/:id')!
    expect(notice.radar).toEqual([{ source: ['notice.example.com/:id'], target: undefined }])
    // and the rest of the catalog still loads (regression: one bad shape killed everything)
    expect(cat.find((m) => m.id === 'rsshub:hackernews/best')).toBeDefined()
  })

  it('keeps a declared no-browser namespace discoverable even though its routes require Puppeteer', () => {
    const xhs = loadRsshubCatalog(path, { noBrowserNamespaces: new Set(['xiaohongshu']) })
      .find((x) => x.id === 'rsshub:xiaohongshu/user/:user_id/:category/:routeParams?')!
    expect(xhs.facility).toEqual({ key: 'xiaohongshu', label: '小红书' })
    expect(xhs.description).toBe('小红书 — 用户笔记/收藏')
    expect(xhs.params_schema.category).toEqual({
      type: 'string',
      required: true,
      description: 'category, notes or collect',
      default: 'notes',
      options: [
        { value: 'notes', label: 'notes' },
        { value: 'collect', label: 'collect' },
      ],
    })
  })

  it('derives route + required param from path', () => {
    const m = loadRsshubCatalog(path).find((x) => x.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(m.route).toBe('/bilibili/user/dynamic/:uid')
    expect(m.params_schema).toEqual({ uid: { type: 'string', required: true, description: '用户 id' } })
    expect(m.description).toContain('bilibili')
  })

  it('carries categories and tags search-capable routes', () => {
    const cat = loadRsshubCatalog(path)
    const bili = cat.find((x) => x.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(bili.categories).toContain('social-media')
    expect(bili.capabilities).toEqual(['timeline'])

    const gh = cat.find((x) => x.id === 'rsshub:github/search/:query/:sort?')!
    expect(gh.capabilities).toEqual(['search']) // /search path + query param
    expect(gh.categories).toContain('programming')
  })

  it('derives facility from the RSSHub namespace', () => {
    const cat = loadRsshubCatalog(path)
    const bili = cat.find((x) => x.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(bili.facility).toEqual({ key: 'bilibili', label: 'bilibili 哔哩哔哩' })
    const hn = cat.find((x) => x.id === 'rsshub:hackernews/best')!
    expect(hn.facility).toEqual({ key: 'hackernews', label: 'Hacker News' })
  })

  it('preserves structured parameter options from RSSHub routes', () => {
    const gh = loadRsshubCatalog(path).find((x) => x.id === 'rsshub:github/search/:query/:sort?')!
    expect(gh.params_schema.sort).toEqual({
      type: 'string',
      required: false,
      description: '排序',
      default: 'best',
      options: [
        { label: '最佳匹配', value: 'best' },
        { label: '最近更新', value: 'updated' },
      ],
    })
  })

  it('derives cookie auth from route data (requireConfig name + radar apex), none otherwise', () => {
    // xiaohongshu 那条标了 puppeteer，要它进目录得有包出面反证（见 noBrowserNamespaces）。
    const cat = loadRsshubCatalog(path, { noBrowserNamespaces: new Set(['xiaohongshu']) })
    const by = (id: string) => cat.find((m) => m.id === id)!
    // bilibili: wildcard requireConfig name (BILIBILI_COOKIE_*) → transform ref = namespace;
    // domain from its own radar apex (space.bilibili.com → bilibili.com).
    expect(by('rsshub:bilibili/user/dynamic/:uid').auth).toEqual({
      type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' },
    })
    // weibo login route has NO radar of its own; domain comes from a sibling route's radar
    // (s.weibo.com/weibo.com → weibo.com) via namespace aggregation. env name = requireConfig name.
    expect(by('rsshub:weibo/user/:uid').auth).toEqual({
      type: 'cookie', domain: 'weibo.com', inject: { kind: 'env', name: 'WEIBO_COOKIES' },
    })
    expect(by('rsshub:weibo/user/:uid').requireConfig).toBe(true)
    // xiaohongshu: env-kind, name from requireConfig, domain from radar apex.
    expect(by('rsshub:xiaohongshu/user/:user_id/:category/:routeParams?').auth).toEqual({
      type: 'cookie', domain: 'xiaohongshu.com', inject: { kind: 'env', name: 'XIAOHONGSHU_COOKIE' },
    })
    // xueqiu: the previously-silent casualty — now derived end-to-end.
    expect(by('rsshub:xueqiu/user/:id').auth).toEqual({
      type: 'cookie', domain: 'xueqiu.com', inject: { kind: 'env', name: 'XUEQIU_COOKIES' },
    })
    // An API key is NOT a cookie: a non-cookie-fed config name (YOUTUBE_KEY) must never mint a
    // cookie spec pointing the broker at the domain — stuffing a browser cookie into an API-key
    // env var sends garbage upstream, and it made subscribing report a bogus "no cookie for
    // youtube.com" for a route that needs no cookie at all. optional → the fetch proceeds without.
    const yt = cat.find((m) => m.id.startsWith('rsshub:youtube/'))
    if (yt) expect(yt.auth).toMatchObject({ type: 'token', name: 'YOUTUBE_KEY', optional: true })
    // apionly: an API TOKEN, not a cookie — so it no longer depends on a derivable radar domain
    // (tokens have no domain). Previously this fell back to auth:none purely because the cookie
    // derivation couldn't find an apex; now it's declared honestly and TokenProvider resolves it
    // from the env var of the same name.
    expect(by('rsshub:apionly/feed').auth).toEqual({ type: 'token', name: 'APIONLY_TOKEN' })
    expect(by('rsshub:apionly/feed').requireConfig).toBe(true)
    // github search: no requireConfig → public → none
    expect(by('rsshub:github/search/:query/:sort?').auth).toEqual({ type: 'none' })
    // hackernews: no requireConfig → none
    expect(by('rsshub:hackernews/best').auth).toEqual({ type: 'none' })
  })

  it('ingests catalog enrichment (notes/requireConfig/nsfw/homepage), stripping ::: fences', () => {
    const bili = loadRsshubCatalog(path).find((x) => x.id === 'rsshub:bilibili/user/dynamic/:uid')!
    expect(bili.requireConfig).toBe(true)
    expect(bili.nsfw).toBe(false)
    expect(bili.homepage).toBe('space.bilibili.com')
    expect(bili.notes).toBe('在 UP 主页 URL 里找到 uid 填入。') // ::: tip / ::: stripped
    expect(bili.docsMarkdown).toBe('::: tip\n在 UP 主页 URL 里找到 uid 填入。\n:::')
    // a route with no enrichment leaves the fields undefined
    const hn = loadRsshubCatalog(path).find((x) => x.id === 'rsshub:hackernews/best')!
    expect(hn.notes).toBeUndefined()
    expect(hn.requireConfig).toBe(false)
  })

  it('deduplicates routes expanded from one RSSHub path array', () => {
    const cat = loadRsshubCatalog(path)
    const fourGamers = cat.filter((x) => x.id.startsWith('rsshub:4gamers'))
    expect(fourGamers.map((x) => x.id)).toEqual([
      'rsshub:4gamers/',
      'rsshub:4gamers/topic/:topic',
      'rsshub:4gamers/tag/:tag',
    ])
  })

  it('keeps distinct routes that only share generic names', () => {
    const cat = loadRsshubCatalog(path)
    const anime1 = cat.filter((x) => x.id.startsWith('rsshub:anime1'))
    expect(anime1.map((x) => x.id)).toEqual([
      'rsshub:anime1/search/:keyword',
      'rsshub:anime1/anime/:category/:name',
    ])
    expect(anime1.map((x) => x.route)).toEqual([
      '/anime1/search/:keyword',
      '/anime1/anime/:category/:name',
    ])
  })
})
