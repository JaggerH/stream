import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UserStore } from '../store/user-store.ts'
import { Registry } from '../registry/registry.ts'
import type { SourceManifest } from '../manifest/types.ts'
import { callSitesOf, ensureSystemRows, ensureTranscribeRow, pruneDeadMembers, systemProviderIds } from './seed.ts'
import { allIdentities, setPackageIdentities } from './identities.ts'
import { ProviderExecutor } from './executor.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'

/** 17 条宿主身份里除 transcribe 之外的那些 —— `ensureSystemRows` 建的就是这一批。 */
const ALWAYS_SEEDED = [...SYSTEM_IDENTITIES.keys()].filter((id) => id !== 'transcribe')

/** Registry 只要 id 就够（`pruneDeadMembers` 只问"在不在"）；其余字段按 schema 填够形状。 */
const mkManifest = (id: string): SourceManifest => ({
  id, title: id, adapter: 'fake', description: '', auth: { type: 'none' },
  params_schema: {}, capabilities: [], pluginId: 'fake',
} as unknown as SourceManifest)

/** 一条包声明的 Provider 行。`packageName` 会被盖进建出来那条行的 `options.declaredBy`。 */
const PKG_ROW = {
  facility: 'pkg',
  packageName: '@t/pkg',
  declaration: {
    id: 'pkg-track', category: 'resolve' as const, serveKeys: ['pkg', 'pkg.com'],
    strategy: 'sequential' as const, label: 'PKG 取歌', description: 'd',
    members: [{ mode: 'auto' as const, matches: 'pkg.com/song' }],
  },
}

/** 两条包声明的播放解析行（各自包的 `package.json#stream.providers`）——宿主静态表里没有任何平台行，
 *  「按 serves-key 分发、不串台」那条覆盖里它们代表两个不同包各出一行、同一 category 不同键。 */
const BILI_ROW = {
  facility: 'bilibili',
  packageName: '@streamapp/bilibili',
  declaration: {
    id: 'video-bilibili', category: 'resolve' as const, serveKeys: ['bilibili-video'],
    strategy: 'sequential' as const, label: 'bilibili 视频解析', description: 'd',
    members: [{ source: 'bilibili-resolve' }], callsites: ['video.resolve'],
  },
}
const DOUYIN_ROW = {
  facility: 'Douyin_TikTok_Download_API',
  packageName: '@streamapp/douyin-tiktok-download-api',
  declaration: {
    id: 'video-douyin', category: 'resolve' as const, serveKeys: ['douyin-video'],
    strategy: 'sequential' as const, label: 'douyin 视频解析', description: 'd',
    members: [{ source: 'douyin-resolve' }], callsites: ['video.resolve'],
  },
}

function freshStore(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const store = new UserStore(join(dir, 'stream.db'))
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

describe('ensureSystemRows', () => {
  it('空表建齐全部系统行（transcribe 除外——它按 token 有无另建）', () => {
    const { store, cleanup } = freshStore('seed-')

    expect(ensureSystemRows(store)).toEqual({ inserted: ALWAYS_SEEDED.length, retired: [], keptAbsent: [] })
    expect(ALWAYS_SEEDED.length).toBe(17) // 18 条宿主身份 − transcribe（包声明的行不在这张表里）
    const ids = store.listProviders().map((p) => p.id)
    expect(ids).toEqual([...ALWAYS_SEEDED].sort()) // listProviders 是 ORDER BY id
    expect(ids).not.toContain('transcribe')
    // 看板数据平面退役（本任务）：这三条不再是系统身份，自然也不会被种进库。
    for (const id of ['run-list', 'run-metrics', 'run-timeseries']) expect(ids).not.toContain(id)
    // 平台解析行归包（`stream.providers`），没装包就没有这一行——宿主表里不该再有它。
    expect(ids).not.toContain('video-douyin')

    // 建行的字段取自身份：serves 的 `'*'` 由 fallback 布尔反向合成
    expect(store.getProvider('download-resolve')!.serves).toEqual(['download'])
    expect(store.getProvider('llm')!.contract).toBeNull()
    expect(store.getProvider('fetch-url')!.serves).toEqual(['*'])
    // 网盘行归各网盘的包（`packages/{quark,baidu}` 的 `stream.providers`），没装包就没有这几行。
    for (const id of ['netdisk-verify-quark', 'netdisk-verify-baidu', 'netdisk-save-quark', 'netdisk-play-quark', 'netdisk-folder-quark']) {
      expect(ids).not.toContain(id)
    }
    // 资源站的组合体行归包：宿主表里没有它，资源搜索行靠 auto 段的 provides 标签收它（不点名）。
    // 包行建行时带上 expand 由 identities.test.ts 钉着。
    expect(ids).not.toContain('btbtla')
    expect(store.getProvider('resource-search')!.members).toContainEqual({ mode: 'auto', provides: 'search-download', params: { keyword: '$input' } })
    expect(store.getProvider('resource-search')!.members.some((m) => 'provider' in m)).toBe(false)
    // `llm` 的种子不带成员——连接是用户自己加的 llm-openai 实例，占位比空列表坏
    expect(store.getProvider('llm')!.members).toEqual([])

    expect(ensureSystemRows(store)).toEqual({ inserted: 0, retired: [], keptAbsent: [] }) // 幂等
    cleanup()
  })

  it('删掉的行不复活、改过的行不覆盖；掉了 system 标志的旧行重申标志', () => {
    const { store, cleanup } = freshStore('seed-edits-')
    ensureSystemRows(store)

    store.patchProvider('music-search', { members: [{ source: 'user-picked' }] })
    store.putProvider({ ...store.getProvider('download-resolve')!, system: false })
    store.removeProvider('podcast-feed')

    expect(ensureSystemRows(store).inserted).toBe(1) // 只有 podcast-feed 缺着
    expect(store.getProvider('podcast-feed')!.system).toBe(true)
    expect(store.getProvider('download-resolve')!.system).toBe(true) // 标志重申
    expect(store.getProvider('music-search')!.members).toEqual([{ source: 'user-picked' }]) // 编辑存活

    // 用户删掉一条后再跑一次会补回来——这正是 `ensureSystemRows` 的语义：系统行必须在
    // （它是能力的落点，缺了就是一条静默哑掉的调用链）。
    store.removeProvider('podcast-feed')
    expect(ensureSystemRows(store).inserted).toBe(1)
    cleanup()
  })

  it('按 serves-key 分发：每平台一条 resolve 行（各自包声明的），不串台', () => {
    const { store, cleanup } = freshStore('seed-video-')
    setPackageIdentities([BILI_ROW, DOUYIN_ROW])
    try {
    ensureSystemRows(store, () => true)

    // 包行：裸名成员已补成全名（`<包名>/<局部名>`），建出来的行带 declaredBy
    expect(store.getProvider('video-bilibili')).toMatchObject({
      category: 'resolve', serves: ['bilibili-video'], members: [{ source: '@streamapp/bilibili/bilibili-resolve' }],
      system: true, options: { declaredBy: '@streamapp/bilibili' },
    })
    expect(store.getProvider('video-douyin')).toMatchObject({
      category: 'resolve', serves: ['douyin-video'], members: [{ source: '@streamapp/douyin-tiktok-download-api/douyin-resolve' }],
      system: true, options: { declaredBy: '@streamapp/douyin-tiktok-download-api' },
    })

    const executor = new ProviderExecutor({
      directory: new ProviderDirectory(store, allIdentities()),
      registry: { get: () => undefined } as never,
      stats: { record: () => {} } as never,
      fetchSource: async () => [],
    })
    expect(executor.match('resolve', 'bilibili-video').map((p) => p.id)).toEqual(['video-bilibili'])
    expect(executor.match('resolve', 'douyin-video').map((p) => p.id)).toEqual(['video-douyin'])
    } finally { setPackageIdentities([]); cleanup() }
  })

  it('影视详情三行的 category/成员顺序，且成员顺序归用户', () => {
    const { store, cleanup } = freshStore('seed-video-detail-')
    ensureSystemRows(store)

    expect(store.getProvider('video-canonical')).toMatchObject({
      // 详情三行走 collect（全收）——策略必须是 concurrent，首胜即停在这里自相矛盾。
      category: 'metadata', strategy: 'concurrent', members: [{ source: '@streamapp/builtin/tmdb-canonical' }], system: true,
    })
    expect(store.getProvider('video-metadata')).toMatchObject({
      category: 'metadata', members: [{ source: '@streamapp/builtin/tmdb-metadata' }, { source: '@streamapp/omdb/omdb-metadata' }], system: true,
    })
    expect(store.getProvider('video-images')).toMatchObject({
      category: 'images', members: [{ source: '@streamapp/builtin/tmdb-images' }, { source: '@streamapp/omdb/omdb-images' }], system: true,
    })

    store.patchProvider('video-metadata', { members: [{ source: '@streamapp/omdb/omdb-metadata' }, { source: '@streamapp/builtin/tmdb-metadata' }] })
    expect(ensureSystemRows(store).inserted).toBe(0)
    expect(store.getProvider('video-metadata')!.members).toEqual([
      { source: '@streamapp/omdb/omdb-metadata' }, { source: '@streamapp/builtin/tmdb-metadata' },
    ])
    cleanup()
  })

  // ── 清退：正向（补齐）的对称动作。判据 = `system = 1` 且 id 不在身份表里。 ──
  it('清退：system=1 但身份已从代码里删掉的行被删掉', () => {
    const { store, cleanup } = freshStore('seed-retire-')
    ensureSystemRows(store)
    // 存量库里真实躺着的那三条看板数据平面行（身份早已删除，成员指向不存在的 source）。
    for (const id of ['run-list', 'run-metrics', 'run-timeseries']) {
      store.putProvider({
        id, label: id, description: '', category: 'search', serves: ['*'], strategy: 'sequential',
        members: [{ source: `${id}-src` }], contract: null, options: {}, system: true,
      })
    }

    const result = ensureSystemRows(store)
    expect(result.inserted).toBe(0)
    expect(result.retired.map((r) => r.id).sort()).toEqual(['run-list', 'run-metrics', 'run-timeseries'])
    for (const id of ['run-list', 'run-metrics', 'run-timeseries']) expect(store.getProvider(id)).toBeNull()
    // 正常系统行一条不少
    expect(store.listProviders().map((p) => p.id)).toEqual([...ALWAYS_SEEDED].sort())
    cleanup()
  })

  it('清退不碰用户自建行：system=0 的行即使不在身份表里也原样留着', () => {
    const { store, cleanup } = freshStore('seed-retire-user-')
    ensureSystemRows(store)
    store.putProvider({
      id: 'my-own-row', label: '我自己建的', description: '', category: 'search', serves: ['*'],
      strategy: 'sequential', members: [{ source: 'whatever' }], contract: null, options: {}, system: false,
    })

    const result = ensureSystemRows(store)
    expect(result.retired).toEqual([])
    expect(store.getProvider('my-own-row')).toMatchObject({ members: [{ source: 'whatever' }], system: false })
    cleanup()
  })

  // `transcribe` 是唯一一条「system 列与身份表不一致」的行（落库刻意不写 system 列 ⇒ system=0，
  // 而 id 在身份表里）——清退判据的两个条件它一个都不满足，钉死它不会被误清。
  it('清退不碰 transcribe：它 system=0，且 id 在身份表里', () => {
    const { store, cleanup } = freshStore('seed-retire-transcribe-')
    ensureSystemRows(store)
    const row = ensureTranscribeRow(store)
    expect(row.system).toBeFalsy()

    expect(ensureSystemRows(store).retired).toEqual([])
    expect(store.getProvider('transcribe')!.members).toEqual(row.members)
    cleanup()
  })

  it('清退连带摘掉频道槽位里对它的悬空引用', () => {
    const { store, cleanup } = freshStore('seed-retire-slots-')
    ensureSystemRows(store)
    store.putProvider({
      id: 'run-list', label: 'run-list', description: '', category: 'search', serves: ['*'],
      strategy: 'sequential', members: [{ source: 'run-list-src' }], contract: null, options: {}, system: true,
    })
    store.putChannel({
      id: 'ch-1', label: '看板', present: 'timeline', stream_ids: [], system: false,
      options: { slots: { 'dashboard.list': ['run-list', 'music-search'], 'other.site': ['music-search'] } },
    })

    const result = ensureSystemRows(store)
    expect(result.retired).toEqual([{ id: 'run-list', clearedSlots: [{ channelId: 'ch-1', callsiteId: 'dashboard.list' }] }])
    expect((store.getChannel('ch-1')!.options as { slots: Record<string, string[]> }).slots).toEqual({
      'dashboard.list': ['music-search'], // 槽键留着（"曾被显式配置过"的痕迹），只摘掉悬空 id
      'other.site': ['music-search'],
    })
    cleanup()
  })

  it('systemProviderIds() 派生自合并身份表（不另立第二份名单）', () => {
    expect(systemProviderIds()).toEqual([...SYSTEM_IDENTITIES.keys()])
    expect(systemProviderIds()).toContain('transcribe')
  })

  it('systemProviderIds() 含包声明的行（合并表 = 宿主 ∪ 包）', () => {
    setPackageIdentities([PKG_ROW])
    try {
      expect(systemProviderIds()).toEqual([...SYSTEM_IDENTITIES.keys(), 'pkg-track'])
    } finally { setPackageIdentities([]) }
  })

  /**
   * 「不在身份表里」有两种成因，长得一模一样：代码删了它（永久）、这一轮这个包没装上（暂时）。
   * 后者清退是不可逆的——行没了、频道槽位被摘，而 `ensureDefaults` 只补"一条绑定都没有"的
   * 调用点，指着它的那条绑定从此静默不出结果。判据与 `pruneDeadMembers` 同源。
   */
  describe('清退分清「代码删了」与「这一轮没加载」', () => {
    const seedPkgRow = (store: UserStore) => {
      setPackageIdentities([PKG_ROW])
      ensureSystemRows(store)
      expect(store.getProvider('pkg-track')!.options).toMatchObject({ declaredBy: '@t/pkg' })
      setPackageIdentities([])   // 下一轮：这条身份不在表里了
    }

    it('包这一轮不在场 → 保住那条行并报出来', () => {
      const { store, cleanup } = freshStore('seed-absent-pkg-')
      try {
        seedPkgRow(store)
        const result = ensureSystemRows(store, () => false)
        expect(result.retired).toEqual([])
        expect(result.keptAbsent).toEqual([{ id: 'pkg-track', packageName: '@t/pkg' }])
        expect(store.getProvider('pkg-track')).not.toBeNull()
      } finally { cleanup() }
    })

    it('包装上了、但它不再声明这条行 → 照旧清退（那是代码删的）', () => {
      const { store, cleanup } = freshStore('seed-removed-pkg-')
      try {
        seedPkgRow(store)
        const result = ensureSystemRows(store, (name) => name === '@t/pkg')
        expect(result.keptAbsent).toEqual([])
        expect(result.retired.map((r) => r.id)).toEqual(['pkg-track'])
        expect(store.getProvider('pkg-track')).toBeNull()
      } finally { cleanup() }
    })

    it('没盖 declaredBy 的宿主行照旧清退（哪怕谓词说"都不在场"）', () => {
      const { store, cleanup } = freshStore('seed-host-orphan-')
      try {
        ensureSystemRows(store)
        store.putProvider({
          id: 'gone-host-row', label: 'x', description: '', category: 'search', serves: ['*'],
          strategy: 'sequential', members: [], contract: null, options: {}, system: true,
        })
        const result = ensureSystemRows(store, () => false)
        expect(result.retired.map((r) => r.id)).toEqual(['gone-host-row'])
        expect(result.keptAbsent).toEqual([])
      } finally { cleanup() }
    })
  })

  // 行那一半（包出的网盘行 category 都是 resolve）由 `src/packages/netdisk-providers.real.test.ts` 对真实包钉着。
  it('netdisk 调用点的 category 都是 resolve（key → 一个判决对象）', () => {
    for (const cs of ['netdisk.share.verify', 'netdisk.share.save', 'netdisk.play', 'netdisk.folder']) {
      expect(PROVIDER_CALLSITES.find((c) => c.id === cs)!.category).toBe('resolve')
    }
  })
})

/**
 * 成员指向一个**不存在的源**是静默死：行还在、界面上看着配好了，就是不出结果，没有一处会喊。
 * 真事：歌词源从 `@streamapp/builtin/netease-lyrics` 搬进 `@streamapp/netease/` 之后，
 * 存量库里 `lyrics-search` 那条行的 members 仍写着旧全名（`ensureSystemRows` 永不覆盖 members），
 * 于是歌词直接不出。
 */
describe('pruneDeadMembers', () => {
  /** 只要 `get`。**用 registry 的解析**（全名/裸名三级），不是字面比较。 */
  const lookup = (ids: string[]) => new Registry(ids.map((id) => mkManifest(id)))

  /**
   * 「这一轮装上了哪些包」——**与生产同构**：从 registry 里现有的源 id 反推包前缀
   * （见 provider 域的调用点，那里解释了为什么不去问包清单）。
   */
  const loadedFrom = (ids: string[]) => {
    const set = new Set<string>()
    for (const id of ids) {
      const cut = id.lastIndexOf('/')
      if (cut > 0 && !id.startsWith('rsshub:')) set.add(id.slice(0, cut))
    }
    return (pkgName: string) => set.has(pkgName)
  }
  /** 第四格必填（没有默认值，逼着每个调用点表态）；这一批用例里没有任何包退役目录路由。 */
  const prune = (store: UserStore, present: string[]) =>
    pruneDeadMembers(store, lookup(present), loadedFrom(present), () => new Map())

  /** 只看被测那一行：一份稀疏 registry 会把别的种子行的成员也判死，那是对的，只是与本条无关。 */
  const onRow = (out: ReturnType<typeof pruneDeadMembers>, id: string) => out.filter((p) => p.providerId === id)

  it('包装上了、它不再出这个 id → 清掉；同包里还活着的那条留下', () => {
    const { store, cleanup } = freshStore('prune-')
    ensureSystemRows(store)
    store.patchProvider('music-search', {
      members: [{ source: '@streamapp/p/alive' }, { source: '@streamapp/p/gone' }],
    })

    expect(onRow(prune(store, ['@streamapp/p/alive']), 'music-search')).toEqual([
      { providerId: 'music-search', sourceId: '@streamapp/p/gone', restoredDefaults: false },
    ])
    expect(store.getProvider('music-search')!.members).toEqual([{ source: '@streamapp/p/alive' }])
    cleanup()
  })

  /**
   * **这条是这条清理最重要的一条边界。** 用户那个包这一轮读不动（`package.json` 坏了）、或者
   * manifest 撞 id 被逐包重试摘掉了——缺席是**暂时的**，而清掉是**永久的**：包修好重启，
   * 那条成员也回不来了。所以"这一轮没装上"一律留着。
   */
  it('包这一轮没装上（读不动 / 撞 id 被摘）→ 成员留着，缺席是暂时的而清掉是永久的', () => {
    const { store, cleanup } = freshStore('prune-absent-pkg-')
    ensureSystemRows(store)
    store.patchProvider('music-search', { members: [{ source: '@streamapp/broken/its-source' }] })

    // registry 里一条 `@streamapp/broken/*` 都没有 ⇒ 这个包这一轮不在场 ⇒ 证不了是代码删的。
    expect(onRow(prune(store, ['@streamapp/other/x']), 'music-search')).toEqual([])
    expect(store.getProvider('music-search')!.members).toEqual([{ source: '@streamapp/broken/its-source' }])
    cleanup()
  })

  it('裸名成员一律留着——它不带包名，证不了"哪个包该出它"', () => {
    const { store, cleanup } = freshStore('prune-bare-')
    ensureSystemRows(store)
    store.patchProvider('music-search', { members: [{ source: 'zuna-search' }] })

    expect(onRow(prune(store, ['@streamapp/zuna/other']), 'music-search')).toEqual([])
    expect(store.getProvider('music-search')!.members).toEqual([{ source: 'zuna-search' }])
    cleanup()
  })

  it('rsshub: 目录路由留着——它不归任何包，随目录刷新增减', () => {
    const { store, cleanup } = freshStore('prune-rsshub-')
    ensureSystemRows(store)
    const before = store.getProvider('resource-search')!.members
    expect(before.some((m) => (m as { source?: string }).source?.startsWith('rsshub:'))).toBe(true)

    expect(onRow(prune(store, []), 'resource-search')).toEqual([])
    expect(store.getProvider('resource-search')!.members).toEqual(before)
    cleanup()
  })

  it('全名在 registry 里解析得到 → 留下（判活走解析，不是字面比）', () => {
    const { store, cleanup } = freshStore('prune-alive-')
    ensureSystemRows(store)
    store.patchProvider('music-search', { members: [{ source: '@streamapp/p/x' }] })

    expect(onRow(prune(store, ['@streamapp/p/x']), 'music-search')).toEqual([])
    cleanup()
  })

  it('清完 members 空了 → 回该行身份的默认成员', () => {
    const { store, cleanup } = freshStore('prune-restore-')
    ensureSystemRows(store)
    store.patchProvider('download-resolve', { members: [{ source: '@streamapp/p/gone' }] })

    expect(onRow(prune(store, ['@streamapp/p/still-here']), 'download-resolve')).toEqual([
      { providerId: 'download-resolve', sourceId: '@streamapp/p/gone', restoredDefaults: true },
    ])
    expect(store.getProvider('download-resolve')!.members)
      .toEqual(SYSTEM_IDENTITIES.get('download-resolve')!.defaultMembers)
    cleanup()
  })

  it('用户自建行（system=0）一个成员都不碰——那是他自己写的', () => {
    const { store, cleanup } = freshStore('prune-user-')
    store.putProvider({
      id: 'my-own-row', label: '我的', description: '', category: 'search', serves: [],
      strategy: 'sequential', members: [{ source: '@streamapp/p/gone' }], contract: null, options: {}, system: false,
    })

    expect(onRow(prune(store, ['@streamapp/p/other']), 'my-own-row')).toEqual([])
    expect(store.getProvider('my-own-row')!.members).toEqual([{ source: '@streamapp/p/gone' }])
    cleanup()
  })

  it('扩展式成员（mode:auto）不碰——它按"此刻有哪些源"现取，没有可指坏的目标', () => {
    const { store, cleanup } = freshStore('prune-auto-')
    ensureSystemRows(store)
    const before = store.getProvider('lyrics-search')!.members
    expect(before).toEqual([{ mode: 'auto', category: 'lyrics' }])

    expect(prune(store, []).map((p) => p.providerId)).not.toContain('lyrics-search')
    expect(store.getProvider('lyrics-search')!.members).toEqual(before)
    cleanup()
  })

  // 这条就是本次搬迁那个坑的原样复现：存量库里的 members 写着搬走之前的旧全名，而搬出去的那个
  // 包（`@streamapp/builtin`）这一轮**确实在场**、只是不再出这个 id。新包在内置层、局部名只命中
  // 它一个 —— 改指过去，而不是清掉再回默认。
  it('lyrics-search 的存量 members 指着搬走的旧源 id → 改指到内置层唯一同局部名的新全名', () => {
    const { store, cleanup } = freshStore('prune-lyrics-')
    ensureSystemRows(store)
    store.patchProvider('lyrics-search', { members: [{ source: '@streamapp/builtin/netease-lyrics' }] })

    const present = ['@streamapp/netease/netease-lyrics', '@streamapp/builtin/some-other-source']
    expect(onRow(prune(store, present), 'lyrics-search')).toEqual([
      { providerId: 'lyrics-search', sourceId: '@streamapp/builtin/netease-lyrics', restoredDefaults: false, movedTo: '@streamapp/netease/netease-lyrics' },
    ])
    expect(store.getProvider('lyrics-search')!.members).toEqual([{ source: '@streamapp/netease/netease-lyrics' }])
    cleanup()
  })

  // 第九批 §2.4：OMDb 两个源从 @streamapp/builtin 搬进 packages/omdb。存量库里影视详情两行写的是老全名
  // （用户可能还调过顺序）——改指到新包、顺序与 params 原样，不清成默认、也不静默指死。
  it('video-metadata / video-images 的存量 OMDb 老全名 → 改指到 @streamapp/omdb，用户排的顺序不动', () => {
    const { store, cleanup } = freshStore('prune-omdb-')
    ensureSystemRows(store)
    store.patchProvider('video-metadata', { members: [{ source: '@streamapp/builtin/omdb-metadata' }, { source: '@streamapp/builtin/tmdb-metadata' }] })
    store.patchProvider('video-images', { members: [{ source: '@streamapp/builtin/tmdb-images' }, { source: '@streamapp/builtin/omdb-images' }] })

    const present = [
      '@streamapp/builtin/tmdb-metadata', '@streamapp/builtin/tmdb-images',
      '@streamapp/omdb/omdb-metadata', '@streamapp/omdb/omdb-images',
    ]
    const out = prune(store, present)
    expect(onRow(out, 'video-metadata')).toEqual([
      { providerId: 'video-metadata', sourceId: '@streamapp/builtin/omdb-metadata', restoredDefaults: false, movedTo: '@streamapp/omdb/omdb-metadata' },
    ])
    expect(onRow(out, 'video-images')).toEqual([
      { providerId: 'video-images', sourceId: '@streamapp/builtin/omdb-images', restoredDefaults: false, movedTo: '@streamapp/omdb/omdb-images' },
    ])
    expect(store.getProvider('video-metadata')!.members).toEqual([
      { source: '@streamapp/omdb/omdb-metadata' }, { source: '@streamapp/builtin/tmdb-metadata' },
    ])
    expect(store.getProvider('video-images')!.members).toEqual([
      { source: '@streamapp/builtin/tmdb-images' }, { source: '@streamapp/omdb/omdb-images' },
    ])
    cleanup()
  })
})

/**
 * 源搬了包（从 `@streamapp/builtin` 搬进它自己的包）之后，存量系统行里的旧全名怎么处理。
 * 只清不改的话，行没空就不回默认——梯子上那一档永久消失、界面照样"配好了"。
 *
 * 规则：**只认内置层**、局部名**恰好命中一个**新全名才改指；命中 0 或 ≥2 维持删除。
 * 第三方层的同局部名源不算——否则装一个同名包就能接管用户的梯子（把用户的 URL / 音频改发给
 * 一个没人审过的包）。
 */
describe('pruneDeadMembers：搬了包的成员改指', () => {
  /** 构造函数收的整批算内置层；`thirdParty` 走 swapGroup 且不进 builtinIds，就是用户层。 */
  const layered = (builtin: string[], thirdParty: string[] = []) => {
    const reg = new Registry(builtin.map((id) => mkManifest(id)))
    if (thirdParty.length) reg.swapGroup('user-recipes', thirdParty.map((id) => mkManifest(id)))
    return reg
  }
  const loaded = (ids: string[]) => {
    const set = new Set(ids.map((id) => id.slice(0, id.lastIndexOf('/'))))
    return (pkgName: string) => set.has(pkgName)
  }
  const run = (store: UserStore, builtin: string[], thirdParty: string[] = []) =>
    pruneDeadMembers(store, layered(builtin, thirdParty), loaded([...builtin, ...thirdParty]), () => new Map())
      .filter((p) => p.providerId === 'music-search')
  const stale = '@streamapp/builtin/some-search'
  const other = { source: '@streamapp/toubiec/toubiec-search', params: { keyword: '$input' } }
  const seed = () => {
    const env = freshStore('prune-moved-')
    ensureSystemRows(env.store)
    env.store.patchProvider('music-search', { members: [{ source: stale, params: { keyword: '$input', extra: 1 } }, other] })
    return env
  }

  it('内置层恰好命中一个 → 改指，params 原样保留，结果里报出新全名（调用方据此打日志）', () => {
    const { store, cleanup } = seed()
    const out = run(store, ['@streamapp/builtin/other', '@streamapp/newpkg/some-search', other.source])
    expect(out).toEqual([{ providerId: 'music-search', sourceId: stale, restoredDefaults: false, movedTo: '@streamapp/newpkg/some-search' }])
    expect(store.getProvider('music-search')!.members).toEqual([
      { source: '@streamapp/newpkg/some-search', params: { keyword: '$input', extra: 1 } }, other,
    ])
    cleanup()
  })

  it('内置层命中两个 → 不改指，照旧删除（猜一个就是替用户做了选择）', () => {
    const { store, cleanup } = seed()
    const out = run(store, ['@streamapp/builtin/other', '@streamapp/a/some-search', '@streamapp/b/some-search', other.source])
    expect(out).toEqual([{ providerId: 'music-search', sourceId: stale, restoredDefaults: false }])
    expect(store.getProvider('music-search')!.members).toEqual([other])
    cleanup()
  })

  it('只有第三方层有同局部名的源 → 不改指，照旧删除', () => {
    const { store, cleanup } = seed()
    const out = run(store, ['@streamapp/builtin/other', other.source], ['@evil/pkg/some-search'])
    expect(out).toEqual([{ providerId: 'music-search', sourceId: stale, restoredDefaults: false }])
    expect(store.getProvider('music-search')!.members).toEqual([other])
    cleanup()
  })

  it('内置层一个 + 第三方层一个 → 只数内置层，改指到内置那个', () => {
    const { store, cleanup } = seed()
    const out = run(store, ['@streamapp/builtin/other', '@streamapp/newpkg/some-search', other.source], ['@evil/pkg/some-search'])
    expect(out.map((p) => p.movedTo)).toEqual(['@streamapp/newpkg/some-search'])
    cleanup()
  })
})

describe('pruneDeadMembers：被包顶掉的目录路由', () => {
  /** 这几条只问退役表，registry 里一条源都不用有。空 registry 会把别的种子行的全名成员也判死
   *  （那是对的、与本条无关），所以断言只看 content-search 这一行。 */
  const emptySources = new Registry([])
  const onRow = (out: ReturnType<typeof pruneDeadMembers>) => out.filter((p) => p.providerId === 'content-search')

  it('系统行上指向已退役目录路由的成员被清掉', () => {
    const { store, cleanup } = freshStore('prune-retired-')
    ensureSystemRows(store)
    store.patchProvider('content-search', { members: [
      { mode: 'auto', provides: 'search-content' },
      { source: 'rsshub:site/vsearch/:kw' },
    ] })

    const pruned = onRow(pruneDeadMembers(store, emptySources, () => true, () => new Map([['rsshub:site/vsearch/:kw', '本包已接管']])))
    expect(pruned.map((p) => p.sourceId)).toEqual(['rsshub:site/vsearch/:kw'])
    expect(store.getProvider('content-search')!.members).toEqual([{ mode: 'auto', provides: 'search-content' }])
    cleanup()
  })

  it('没被退役的目录路由照旧留着（rsshub: 一律不清那条规则仍在）', () => {
    const { store, cleanup } = freshStore('prune-not-retired-')
    ensureSystemRows(store)
    store.patchProvider('content-search', { members: [{ source: 'rsshub:site/vsearch/:kw' }] })

    expect(onRow(pruneDeadMembers(store, emptySources, () => true, () => new Map()))).toEqual([])
    expect(store.getProvider('content-search')!.members).toEqual([{ source: 'rsshub:site/vsearch/:kw' }])
    cleanup()
  })

  it('退役表是调用时现取的，不是传参那一刻的快照', () => {
    const { store, cleanup } = freshStore('prune-retired-thunk-')
    ensureSystemRows(store)
    store.patchProvider('content-search', { members: [{ source: 'rsshub:site/vsearch/:kw' }] })

    let table = new Map<string, string>()
    const thunk = () => table
    table = new Map([['rsshub:site/vsearch/:kw', '本包已接管']])
    expect(onRow(pruneDeadMembers(store, emptySources, () => true, thunk)).map((p) => p.sourceId)).toEqual(['rsshub:site/vsearch/:kw'])
    cleanup()
  })
})

/**
 * 这一行**无条件建、整份梯子都写进去**（2026-09-05 改掉了「按当次有哪些 key 筛成员」的旧写法）。
 *
 * 旧写法的真实代价不在这一行本身，而在 `conversions` 域：一把 key 都没有时它返回 null，
 * 而整整一批能力（转写 / 说话人识别 / 摘要）挂在「这一行建没建出来」下面——用户申请到 key 之后
 * 功能仍然不存在，要重启后端才冒出来。活体撞到过（2026-09-04，win-test 干净装机）。
 */
describe('ensureTranscribeRow', () => {
  it('一把 key 都没有也照样建——梯子的存在不该由此刻有没有钥匙决定', () => {
    const { store, cleanup } = freshStore('transcribe-none-')
    const row = ensureTranscribeRow(store)
    expect(row.members.map((m) => ('source' in m ? m.source : ''))).toEqual([
      '@streamapp/groq/groq-whisper', '@streamapp/cloudflare/cf-whisper', '@streamapp/builtin/openai-whisper',
    ])
    expect(store.getProvider('transcribe')!.members).toEqual(row.members)
    cleanup()
  })

  it('落的是身份声明的成本阶梯原样：groq → cloudflare → openai', () => {
    const { store, cleanup } = freshStore('transcribe-all-')
    const row = ensureTranscribeRow(store)
    expect(row.members).toEqual([
      { source: '@streamapp/groq/groq-whisper', params: { tokenName: 'groq' } },
      { source: '@streamapp/cloudflare/cf-whisper', params: { tokenName: 'cloudflare' } },
      { source: '@streamapp/builtin/openai-whisper', params: { tokenName: 'openai' } },
    ])
    expect(row.category).toBe('transcribe')
    expect(row.serves).toEqual(['*']) // fallback 身份反向合成
    expect(row.strategy).toBe('sequential')
    cleanup()
  })

  it('每个成员都带 tokenName —— 「这一档要哪把钥匙」是运行时逐档现问的依据', () => {
    // 少了它，`sttConfigured`（kernel/plugins/conversions.ts）就无从逐档判断钥匙在不在，
    // 而它是「配上 key 立刻能用、不用重启」的判据源。
    const { store, cleanup } = freshStore('transcribe-tokennames-')
    for (const m of ensureTranscribeRow(store).members) {
      expect((m as { params?: { tokenName?: string } }).params?.tokenName).toBeTruthy()
    }
    cleanup()
  })

  it('重跑幂等：成员不会越堆越多', () => {
    const { store, cleanup } = freshStore('transcribe-rerun-')
    const first = ensureTranscribeRow(store)
    const second = ensureTranscribeRow(store)
    expect(second.members).toEqual(first.members)
    expect(store.getProvider('transcribe')!.members).toHaveLength(3)
    cleanup()
  })

  // Cloudflare 那一档从 @streamapp/builtin 搬进了 packages/cloudflare。存量库里这一行写的是老全名——
  // 这一行每次启动整份重写，所以老全名不会活过一次启动（不需要迁移、也不需要别名）。
  it('存量行上的老全名 @streamapp/builtin/cf-whisper 在下一次启动被改写成新全名', () => {
    const { store, cleanup } = freshStore('transcribe-cf-moved-')
    ensureTranscribeRow(store)
    store.patchProvider('transcribe', { members: [{ source: '@streamapp/builtin/cf-whisper', params: { tokenName: 'cloudflare' } }] })
    ensureTranscribeRow(store)
    const sources = store.getProvider('transcribe')!.members.map((m) => ('source' in m ? m.source : ''))
    expect(sources).toContain('@streamapp/cloudflare/cf-whisper')
    expect(sources).not.toContain('@streamapp/builtin/cf-whisper')
    cleanup()
  })
})

describe('callSitesOf —— 调用位置注记', () => {
  // 复位放 afterEach，不放用例末尾：断言一红用例就中断了，末尾那句复位跑不到，
  // 包行会漏给后面的用例（这个文件里 `systemProviderIds()` 那条正好会被它带偏）。
  afterEach(() => setPackageIdentities([]))

  it('手写表里有的照旧', () => {
    expect(callSitesOf('music-search')).toEqual(['GET /api/search?scope=music'])
  })
  it('手写表里没有的（包行）按调用点 label 反查生成', () => {
    setPackageIdentities([{ facility: 'pkg', declaration: {
      id: 'pkg-track', category: 'resolve', serveKeys: ['pkg'], strategy: 'sequential',
      label: 'L', description: 'D', members: [{ mode: 'auto', matches: 'pkg.com/song' }],
      callsites: ['music.track.resolve', 'music.track.download'],
    } }])
    expect(callSitesOf('pkg-track')).toEqual(['音乐播放解析', '音乐下载解析'])
  })
  it('哪边都没有 → 空数组', () => {
    expect(callSitesOf('nobody')).toEqual([])
  })
})

describe('llm 调用点目录', () => {
  it('三条 llm 调用点齐备，默认都指向系统 llm 行', () => {
    for (const id of ['llm.summarize', 'llm.chat', 'netdisk.spec.suggest']) {
      const descriptor = PROVIDER_CALLSITES.find((c) => c.id === id)
      expect(descriptor, id).toBeDefined()
      expect(descriptor!.category).toBe('llm')
      expect(descriptor!.defaultProviderIds).toEqual(['llm'])
    }
  })
})
