import { fileURLToPath } from 'node:url'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { loadRecipePackages, BUILTIN_LAYER_SCAN, mergeRecipePackagesByFacility } from './recipe-package.ts'
import { loadPlugins } from '../plugins/loader.ts'
import { parseStreamDescriptor } from '../packages/descriptor.ts'

// Guard the REAL shipped recipe packages against manifest-schema drift.
//
// The per-recipe tests (e.g. xhs-like.recipe.test.ts) load a recipe's JSON directly and run
// RecipeRunner — they NEVER go through loadRecipePackages, so they don't validate manifests.yaml
// against manifestSchema. A manifest missing a required field (capabilities/cadence_hint_seconds/…)
// passes every per-recipe test but crashes the backend at boot (bootstrap → mountRecipePackages,
// fail-loud). This test closes that gap: it loads the actual `packages/` dir the same way boot
// does —— 同一个目录里还住着插件包，所以立场也要和 boot 一致（BUILTIN_LAYER_SCAN）。
const PACKAGES_DIR = fileURLToPath(new URL('../../packages', import.meta.url))
const load = () => loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN)

describe('shipped recipe packages load (manifest schema)', () => {
  it('every packages/<facility> recipe package parses without throwing', () => {
    expect(() => load()).not.toThrow()
  })

  // §9.1-④：**一条裸名都不许剩**。装载期加前缀这件事漏掉任何一条路径，都表现成"某个源还是老 id"
  // ——它照样能被解析（`Registry.get` 的第 3 级），所以功能上一切正常，只有等到第三方装一个同名包
  // 才炸。数字守卫在这里，不靠人看 diff。
  it('内置包装载出的 id 全部带命名空间前缀（一条裸名都不剩）', () => {
    const loaded = load()
    const ids = [...new Set([
      ...loaded.descriptors.flatMap((d) => d.sources.map((s) => s.id)),
      ...loaded.recipes.keys(),
    ])]
    expect(ids.length).toBeGreaterThan(20)
    // 全名一定含 `/`，且第一个 `/` 之前那一段是 npm 包名——不含 `:`（catalog id 才含）。
    expect(ids.filter((id) => !id.includes('/') || id.slice(0, id.indexOf('/')).includes(':'))).toEqual([])
  })

  // 并轨后的守卫：插件包的 manifests.yaml 归 curated 投影，recipe 这条投影不许再吃一遍——
  // 吃了就是同一份 manifest 进两个 registry group，Registry.swapGroup 当场抛 Duplicate manifest id。
  it('内置层不把插件包的 manifests.yaml 当成 recipe 源', () => {
    const ids = new Set(load().descriptors.flatMap((d) => d.sources.map((s) => s.id)))
    // packages/btbtla/manifests.yaml 里的一条（同一个包还带 recipe，最容易被 recipe 投影吃第二遍）
    expect(ids.has('@streamapp/btbtla/magnet-btbtla')).toBe(false)
    expect(ids.has('@streamapp/btbtla/btbtla-search')).toBe(true)
    expect(ids.size).toBeGreaterThan(0)
  })

  // 慢慢买归**比价档**，不是内容档：它 `provides: search-price`，由 price-search 那行的 auto 段扇出，
  // 而不是 content-search。回退成 search-content 会让价格行被网页搜索淹没在 content_search 里（正是
  // 独立成档要修的病），且没有任何报错——所以这里钉住它的 provides 标签。
  it('manmanbuy-search 归比价档（provides: search-price，capability: search）', () => {
    const src = load().descriptors.flatMap((d) => d.sources).find((s) => s.id === '@streamapp/manmanbuy/manmanbuy-search')
    expect(src, 'manmanbuy-search source should load').toBeTruthy()
    expect(src!.provides).toEqual(['search-price'])
    expect(src!.capabilities).toContain('search')
    expect(src!.key_param).toBe('keyword')
  })

  // 转转回收归**残值档**，既不是比价档也不是内容档：`provides: search-resale`，由 resale-search 那行扇出。
  // 掉进 search-price 的后果比掉进内容档更坏——回收价会混在新品报价里、被模型当成一个便宜的购买选项。
  it.each(['@streamapp/zhuanzhuan/zhuanzhuan-recycle', '@streamapp/aihuishou/aihuishou-recycle', '@streamapp/goofish/goofish-search'])(
    '%s 归残值档（provides: search-resale，capability: search）',
    (id) => {
      const src = load().descriptors.flatMap((d) => d.sources).find((s) => s.id === id)
      expect(src, `${id} should load`).toBeTruthy()
      expect(src!.provides).toEqual(['search-resale'])
      expect(src!.capabilities).toContain('search')
      expect(src!.key_param).toBe('keyword')
    },
  )

  // 搜索腿的**累计**闸门就是这一格声明的数字。钉住它，是因为它坏起来完全无声：把 perHour 从
  // package.json 里删掉、或者被哪一层的类型/schema 悄悄吃掉，活体表现只是「限速没生效」——
  // 而那件事要等到 Google 整个出口回 /sorry/index 才看得见（IP 级，连 Brave 一起弹）。
  it('google / brave 声明了每小时累计预算 —— 光有 perMinute 挡不住 Google 那种按累计量拦人', () => {
    const rateLimitOf = (facility: string) => load().descriptors.find((d) => d.facility === facility)?.rateLimit
    expect(rateLimitOf('google')).toMatchObject({ burst: 6, perMinute: 30, perHour: 100 })
    expect(rateLimitOf('brave')?.perHour).toBe(100)
    // 百度实测不按累计量拦人，故意不声明——见 packages/baidu-search 的 _why_no_perHour。
    expect(rateLimitOf('baidu-search')?.perHour).toBeUndefined()
    expect(rateLimitOf('baidu-search')?.perMinute).toBe(10) // 这条腿确实被加载到了，不是找错了名字
  })

  it('mounts the xhs interaction source (xhs-like)', () => {
    const loaded = load()
    const ids = loaded.descriptors.flatMap((d) => d.sources.map((s) => s.id))
    expect(ids).toContain('@streamapp/xhs/xhs-like')
    expect(ids).toContain('@streamapp/xhs/xhs-home')
    expect(ids).toContain('@streamapp/xhs/xhs-detail')
    expect(loaded.recipes.has('@streamapp/xhs/xhs-like')).toBe(true)
  })

  // 上游给 xiaohongshu 的两条路由（用户笔记 / 专辑）标了 requirePuppeteer，实际带 cookie 纯 HTTP 能跑。
  // 「这个标记是虚的」由认领它的包声明；源码不点名任何站，所以这条断言是它进目录的唯一保证。
  it('xhs 包声明 xiaohongshu 命名空间不需要浏览器（目录不因 requirePuppeteer 丢掉它）', () => {
    const xhs = load().descriptors.find((d) => d.facility === 'xhs')!
    expect(xhs.rsshubNoBrowserNamespaces).toEqual(['xiaohongshu'])
  })

  it('mounts the telegram-search desktop recipe as a search source', () => {
    const loaded = load()
    const ids = loaded.descriptors.flatMap((d) => d.sources.map((s) => s.id))
    expect(ids).toContain('@streamapp/telegram/telegram-search')
    const recipe = loaded.recipes.get('@streamapp/telegram/telegram-search')
    expect(recipe?.kind).toBe('desktop')
    const src = loaded.descriptors.flatMap((d) => d.sources).find((s) => s.id === '@streamapp/telegram/telegram-search')
    expect(src?.capabilities).toContain('search')
  })

  // cloak 退役的守门人：**没有任何** shipped recipe 还骑 cloak。
  //
  // 断言"一个都没有"而不是逐个点名 douyin-search / xueqiu-user：那两个是 2026-07-28 迁走的最后
  // 两个，点名的写法拦不住"明天有人新写一份 recipe 又写上 cloak"——而那正是让 cloak 悄悄复活的
  // 动作。`transport:'ext-cdp'` 是**合法**的（no-op，迁移期留下的显式声明），所以这里只数 cloak，
  // 不数"有没有 transport 键"。装载点（validateRecipe）现在也拒 cloak；两道一起留着，因为守的不
  // 是同一件事：那道守"这一份能不能装进来"，这道守"仓库里有没有已经混进一份"。
  it('no shipped recipe rides cloak (transport retirement guard)', () => {
    const loaded = load()
    const onCloak: string[] = []
    for (const [id, recipe] of loaded.recipes) {
      const session = 'session' in recipe ? (recipe.session as { transport?: string } | undefined) : undefined
      if (session?.transport === 'cloak' || (recipe as { transport?: string }).transport === 'cloak') onCloak.push(id)
    }
    expect(onCloak).toEqual([])
  })

  // groq-create-key 的抽取能不能落地，全看它的 manifest 里那条 secret 声明——sink 是从
  // `runtime_config.ref` + 声明成 secret 的字段绑出来的，声明掉了抽取就静默拒写。
  // 这条断言守的就是"声明还在"，而不是 recipe 文件还在。
  it('mounts groq-create-key with the secret slot its extract writes into', () => {
    const loaded = load()
    const src = loaded.descriptors.flatMap((d) => d.sources).find((s) => s.id === '@streamapp/groq/groq-create-key')
    expect(src?.runtime_config).toEqual(
      expect.objectContaining({ ref: 'groq', fields: expect.objectContaining({ apiKey: expect.objectContaining({ type: 'secret' }) }) }),
    )
    const recipe = loaded.recipes.get('@streamapp/groq/groq-create-key')
    expect(recipe && 'extract' in recipe ? recipe.extract : undefined).toMatchObject({
      field: 'apiKey',
      pattern: 'gsk_[A-Za-z0-9_-]{20,}',
    })
  })

  // 智谱和 groq 是同一件事的两副面孔：groq 把明文渲染一次（页面文本能读到），智谱从不把明文放进
  // DOM（只经 /api_keys/copy/<id> 进剪贴板）。所以这一条钉的是**第二副面孔**——抽取来源必须是
  // network，而且那个 glob 必须真有 observer 接着；两者脱钩就是运行期一句"抽取拒绝"，看不出真因。
  it('mounts zhipu-create-key whose secret comes off the wire, carried by NO declared observer', () => {
    const loaded = load()
    const src = loaded.descriptors.flatMap((d) => d.sources).find((s) => s.id === '@streamapp/zhipu/zhipu-create-key')
    expect(src?.runtime_config).toEqual(
      expect.objectContaining({ ref: 'zhipu', fields: expect.objectContaining({ apiKey: expect.objectContaining({ type: 'secret' }) }) }),
    )
    const recipe = loaded.recipes.get('@streamapp/zhipu/zhipu-create-key')
    const extract = recipe && 'extract' in recipe ? recipe.extract : undefined
    expect(extract).toMatchObject({ field: 'apiKey', from: { network: '*/api_keys/copy/*' } })
    // 关键不变量：这类 recipe **不挂** observer。挂了它就进 items 管线，抓到的凭证响应会被空
    // output 判成 malformed → drift，而 drift 盖住 extract 的真实结论（活体踩过）。
    const observers = recipe && 'observers' in recipe ? recipe.observers ?? [] : []
    expect(observers).toEqual([])
  })

  describe('内置 lizhi 包：facility 知识住在包里', () => {
    // 一个空的"用户层"目录，建一次、用完删掉。每次 pkg() 现 mkdtemp 的话，一轮测试留两个空目录
    // 在 /tmp 里——这个仓库被磁盘写满咬过，留垃圾不是小事。
    let userDir = ''
    beforeAll(() => { userDir = mkdtempSync(join(tmpdir(), 'stream-empty-recipes-')) })
    afterAll(() => { if (userDir) rmSync(userDir, { recursive: true, force: true }) })
    const pkg = () => mergeRecipePackagesByFacility(PACKAGES_DIR, userDir).byFacility.get('lizhi')!
    it('声明了 .lizhi.fm 的送字节策略与备选 CDN', () => {
      const p = pkg()
      expect(p.serving?.[0]).toMatchObject({ match: '.lizhi.fm', label: '荔枝 FM' })
      expect(p.serving?.[0].hosts).toEqual(['cdn101.lizhi.fm', 'cdn102.lizhi.fm', 'cdn.gzlzfm.com', 'cdn101.gzlzfm.com'])
    })
    it('声明了它顶掉的 RSSHub 路由', () => {
      expect(Object.keys(pkg().retires ?? {})).toEqual(['rsshub:lizhi/user/:id'])
    })
    it('recipe mapping 带 track_id', () => {
      const recipe = loadRecipePackages(PACKAGES_DIR, BUILTIN_LAYER_SCAN).recipes.get('@streamapp/lizhi/lizhi-user') as { mapping?: Record<string, string> }
      expect(recipe?.mapping?.track_id).toBe('voiceInfo.voiceId')
    })
  })

  describe('内置 netease 包：网易云的知识住在包里', () => {
    let userDir = ''
    beforeAll(() => { userDir = mkdtempSync(join(tmpdir(), 'stream-empty-recipes-')) })
    afterAll(() => { if (userDir) rmSync(userDir, { recursive: true, force: true }) })
    const pkg = () => mergeRecipePackagesByFacility(PACKAGES_DIR, userDir).byFacility.get('netease')!

    it('声明了取歌 Provider 行与它的两个调用点', () => {
      const row = pkg().providers![0]
      expect(row).toMatchObject({ id: 'netease-track', category: 'resolve', strategy: 'sequential' })
      expect(row.serveKeys).toEqual(['netease', 'netease-track'])
      expect(row.callsites).toEqual(['music.track.resolve', 'music.track.download'])
      expect(row.members).toEqual([{ mode: 'auto', matches: 'music.163.com/song', params: { id: '$input', level: 'lossless' } }])
    })

    it('声明了曲目 URL 文法与 RSSHub 命名空间', () => {
      expect(pkg().links?.hosts).toEqual([{ host: 'music.163.com', platform: 'netease' }])
      expect(pkg().links?.patterns.map((p) => p.kind)).toEqual(['track', 'track'])
      expect(pkg().rsshubNamespaces).toEqual(['163'])
    })

    // 歌词源的清单走**插件路径**挂载（`manifests.yaml` + `stream.code.adapters`），不是
    // recipe 路径——这个包一个 `*.recipe.json` 都没有。所以断言对着 `loadPlugins` 的产物，
    // 它给的 id 就是活体注册的那个全名。
    it('歌词源在这个包里，带 lyrics 类目与 key_param', () => {
      const m = (loadPlugins(PACKAGES_DIR).find((p) => p.id === 'netease')!.sources ?? [])
        .find((s) => s.id === '@streamapp/netease/netease-lyrics')!
      expect(m.adapter).toBe('netease-lyrics')
      expect(m.categories).toEqual(expect.arrayContaining(['music', 'lyrics']))
      expect(m.key_param).toBe('input')
    })
  })

  describe('内置 bilibili 包：一个视频站的知识住在包里', () => {
    let userDir = ''
    beforeAll(() => { userDir = mkdtempSync(join(tmpdir(), 'stream-empty-recipes-')) })
    afterAll(() => { if (userDir) rmSync(userDir, { recursive: true, force: true }) })
    const pkg = () => mergeRecipePackagesByFacility(PACKAGES_DIR, userDir).byFacility.get('bilibili')!
    // `code` 槽位不在 RecipePackage 上（它归插件装载路径），所以直接过描述符解析器读 package.json。
    const descriptor = () => parseStreamDescriptor(
      JSON.parse(readFileSync(join(PACKAGES_DIR, 'bilibili', 'package.json'), 'utf8')), 'bilibili',
    )
    const sources = () => loadPlugins(PACKAGES_DIR).find((p) => p.id === 'bilibili')!.sources ?? []

    it('两条 Provider 行：播放解析（video.resolve）与链接抓媒体（content.enrich）', () => {
      const rows = pkg().providers!
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject({ id: 'video-bilibili', category: 'resolve', serveKeys: ['bilibili-video'], callsites: ['video.resolve'] })
      expect(rows[1]).toMatchObject({ id: 'bilibili-url', category: 'transform', callsites: ['content.enrich'] })
      expect(rows[1].serveKeys).toEqual(['bilibili-link'])
      expect(pkg().links?.hosts.map((h) => h.host)).toEqual(['bilibili.com', 'b23.tv'])
      expect(pkg().links?.shortHosts).toEqual(['b23.tv'])
    })

    it('顶掉目录里同一条 vsearch 路由，RSSHub cookie 模板与命名空间随包走', () => {
      const p = pkg()
      expect(Object.keys(p.retires ?? {})).toEqual(['rsshub:bilibili/vsearch/:kw/:order?/:embed?/:tid?'])
      expect(p.rsshubCookieEnv).toBe('BILIBILI_COOKIE_{DedeUserID}')
      expect(p.rsshubNamespaces).toContain('bilibili')
    })

    it('代码槽位申报三个 enricher 与一个 connect 域', () => {
      const d = descriptor()
      expect(d.code?.enrichers).toEqual(['bilibili-comments', 'bilibili-owner', 'bilibili-user'])
      expect(d.code?.connect).toEqual(['bilibili.com'])
    })

    // 搜索源的 auth 必须与它承接的目录路由一致：deriveCookieAuth 对 `BILIBILI_COOKIE_*` 派生的形状。
    // 写成 `none` 的代价是 RSSHub vsearch 没 cookie 落进浏览器分支，而 worker 没有浏览器。
    it('搜索源带 optional 的 transform cookie auth；链接源的成员合同是单个对象', () => {
      const search = sources().find((s) => s.id === '@streamapp/bilibili/bilibili-search')!
      expect(search.auth).toEqual({
        type: 'cookie', domain: 'bilibili.com', inject: { kind: 'transform', ref: 'bilibili' }, optional: true,
      })
      const fetchUrl = sources().find((s) => s.id === '@streamapp/bilibili/bilibili-fetch-url')!
      expect(fetchUrl.output).toBe('object')
    })
  })
})
