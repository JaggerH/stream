import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UserStore } from '../store/user-store.ts'
import { ProviderBindings, SlotBrokenError } from './bindings.ts'
import { PROVIDER_CALLSITES } from './callsites.ts'
import { ProviderDirectory } from './directory.ts'
import { SYSTEM_IDENTITIES } from './system/index.ts'
import { allIdentities, setPackageIdentities } from './identities.ts'
import { ensureSystemRows } from './seed.ts'

const dirs: string[] = []
const makeStore = () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-bindings-'))
  dirs.push(dir)
  const store = new UserStore(join(dir, 'stream.db'))
  for (const provider of [
    // video.detail.* 是 collect 调用点（要全收语义），所以 metadata 这两行是 concurrent；
    // meta-seq 是专门用来验"绑一条首胜行进 collect 调用点会被拒"的那一条。
    { id: 'meta-a', category: 'metadata', strategy: 'concurrent' }, { id: 'meta-b', category: 'metadata', strategy: 'concurrent' },
    { id: 'meta-seq', category: 'metadata', strategy: 'sequential' },
    // video.detail.images 是 images 类的 collect 调用点——它的槽位只可能绑到 images 类的行，
    // 所以那儿的"违规行"也得是 images 类的，别拿 metadata 行去演一个现实里写不进去的组合。
    { id: 'img-seq', category: 'images', strategy: 'sequential' },
    { id: 'bili', category: 'resolve', serves: ['bilibili-video'] }, { id: 'fallback', category: 'resolve', serves: ['*'] },
  ]) store.putProvider({ label: provider.id, description: '', strategy: 'sequential', members: [], contract: null, options: {}, serves: provider.serves ?? [], ...provider } as any)
  return store
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('ProviderBindings', () => {
  it('validates fixed bindings and exposes reverse references', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('video.detail.metadata', ['meta-a'])
    expect(bindings.fixed('video.detail.metadata')).toBe('meta-a')
    expect(bindings.references('meta-a')).toEqual(['video.detail.metadata'])
    expect(() => bindings.put('video.detail.metadata', ['meta-a', 'meta-b'])).toThrow('exactly one')
    expect(() => bindings.put('video.detail.metadata', ['bili'])).toThrow('not compatible')
    store.close()
  })

  // collect 调用点的闸门前移到写入侧：绑一条首胜行进来，写的那一刻就拒，
  // 别拖到详情页真去取数时才在执行器里炸。
  it('collect 调用点拒绝不支持全收语义的行', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    expect(() => bindings.put('video.detail.metadata', ['meta-seq'])).toThrow(/要求全收语义（collect）/)
    expect(() => bindings.put('video.detail.metadata', ['meta-seq'])).toThrow(/sequential/)
    // 非 collect 调用点不受这条约束（同一条 sequential 行照绑不误）。
    expect(() => bindings.put('video.resolve', ['bili'])).not.toThrow()
    store.close()
  })

  // dispatch 是按键选行，所以用户的**次序**才是他的选择，成员集合不是：缺席的默认行补在末尾，
  // 不会顶掉谁（键不同就各走各的），而漏补的代价是用户装了包却永远派发不到它。
  it('limits dispatch matching to its ordered binding; ensureDefaults 只在末尾补齐缺席的默认行', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('video.resolve', ['fallback', 'bili'])
    expect(bindings.dispatch('video.resolve', 'bilibili-video', undefined, { fallback: true })).toBe('bili')
    bindings.ensureDefaults(PROVIDER_CALLSITES)
    const defaults = PROVIDER_CALLSITES.find((c) => c.id === 'video.resolve')!.defaultProviderIds
    expect(bindings.binding('video.resolve')?.providerIds).toEqual(['fallback', 'bili', ...defaults])
    store.close()
  })

  // 每个调用点自己表态要不要兜底：同一份 binding、同一个键，两个答案。
  it('dispatch: 无具名命中时，fallback 决定落不落兜底行', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('video.resolve', ['fallback', 'bili'])
    expect(bindings.dispatch('video.resolve', 'douyin-video', undefined, { fallback: true })).toBe('fallback')
    expect(bindings.dispatch('video.resolve', 'douyin-video', undefined, { fallback: false })).toBeNull()
    // 具名命中不受 fallback 影响（兜底行排在前面也压不住具名行）。
    expect(bindings.dispatch('video.resolve', 'bilibili-video', undefined, { fallback: false })).toBe('bili')
    store.close()
  })
})

// 用 `download.resolve` 演：它是 resolve 类的 **fixed** 调用点，而 `fixedServing` 讲的正是
// fixed 那一路（`music.track.*` 已经是 dispatch，拿它当例子只会误导读的人）。
// fixedServing = fixed() + 一道 serves 闸门,**只**加在全局 binding 那一路：绑定行没声明这个
// 平台键就当没绑（返回 null，调用点自己回落到按键分发），免得「音乐取流」的绑定被拿去跑播客。
// 频道槽位那一路是显式意图，语义与 fixed() 一字不差（含全 parked 抛 SlotBrokenError）。
describe('fixedServing — 全局 binding 的 serves 闸门', () => {
  it('绑定行 serves 覆盖该键 → 照用；不覆盖 → null（由调用点回落）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('download.resolve', ['bili'])           // serves: ['bilibili-video']
    expect(bindings.fixedServing('download.resolve', 'bilibili-video')).toBe('bili')
    expect(bindings.fixedServing('download.resolve', 'xiaoyuzhou')).toBeNull()
    // fixed() 本身语义不变：不认键,照返绑定行。
    expect(bindings.fixed('download.resolve')).toBe('bili')
    store.close()
  })

  it("serves 含 '*' 的兜底行覆盖任何键（与 dispatch 的通配同义）", () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('download.resolve', ['fallback'])       // serves: ['*']
    expect(bindings.fixedServing('download.resolve', 'xiaoyuzhou')).toBe('fallback')
    store.close()
  })

  it('没有 binding / binding 指向已删除的行 → null', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    expect(bindings.fixedServing('download.resolve', 'some-key')).toBeNull()
    bindings.put('download.resolve', ['bili'])
    store.removeProvider('bili')
    // 行没了就读不到 serves——读不到就不猜,回落到按键分发。
    expect(bindings.fixedServing('download.resolve', 'bilibili-video')).toBeNull()
    store.close()
  })
})

describe('channel slot overrides', () => {
  const makeSlotStore = () => {
    const store = makeStore()
    for (const provider of [
      { id: 'resource-search', category: 'search' },
      { id: 'nsfw-search', category: 'search' },
      { id: 'nsfw-search-parked', category: 'search', options: { parked: true } },
      { id: 'netdisk-verify-quark', category: 'resolve', serves: ['quark-verify'] },
      { id: 'verify-alt', category: 'resolve', serves: ['quark-verify'] },
      { id: 'verify-parked', category: 'resolve', serves: ['quark-verify'], options: { parked: true } },
    ]) store.putProvider({ label: provider.id, description: '', strategy: 'sequential', members: [], contract: null, options: {}, serves: [], ...provider } as any)
    const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('search.resources', ['resource-search'])
    bindings.put('netdisk.share.verify', ['netdisk-verify-quark'])
    // 频道 c-nsfw 在 search.resources / netdisk.share.verify 槽都填了非全局的行；c-plain 没填任何槽；
    // c-parked 在 netdisk.share.verify 槽只填了一个 parked 行（过滤后为空,§5.1 应报错);
    // c-search-parked 在 search.resources 槽全 parked（fixed 侧的同款用例）；
    // c-search-partial 在 search.resources 槽混了一个 parked + 一个可用行（过滤后仍有可用行,不报错）。
    store.putChannel({ id: 'c-nsfw', label: '', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['nsfw-search'], 'netdisk.share.verify': ['verify-alt'] } } })
    store.putChannel({ id: 'c-plain', label: '', present: 'video', stream_ids: [], options: {} })
    store.putChannel({ id: 'c-parked', label: '', present: 'video', stream_ids: [], options: { slots: { 'netdisk.share.verify': ['verify-parked'] } } })
    store.putChannel({ id: 'c-search-parked', label: '', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['nsfw-search-parked'] } } })
    store.putChannel({ id: 'c-search-partial', label: '', present: 'video', stream_ids: [], options: { slots: { 'search.resources': ['nsfw-search-parked', 'nsfw-search'] } } })
    return { store, bindings }
  }

  it('fixed: slot wins over global binding within channel context', () => {
    const { store, bindings } = makeSlotStore()
    expect(bindings.fixed('search.resources', { channelId: 'c-nsfw' })).toBe('nsfw-search')
    store.close()
  })
  it('fixed: no ctx / channel without slot falls back to global binding', () => {
    const { store, bindings } = makeSlotStore()
    expect(bindings.fixed('search.resources')).toBe('resource-search')
    expect(bindings.fixed('search.resources', { channelId: 'c-plain' })).toBe('resource-search')
    expect(bindings.fixed('search.resources', { channelId: 'no-such-channel' })).toBe('resource-search')
    store.close()
  })
  it('dispatch: slot providerIds replace binding list, serves matching unchanged', () => {
    const { store, bindings } = makeSlotStore()
    expect(bindings.dispatch('netdisk.share.verify', 'quark-verify', { channelId: 'c-nsfw' }, { fallback: false })).toBe('verify-alt')
    expect(bindings.dispatch('netdisk.share.verify', 'quark-verify', undefined, { fallback: false })).toBe('netdisk-verify-quark')
    store.close()
  })
  it('dispatch: slot全 parked → 抛 SlotBrokenError（§5.1,不回落全局/不返回 null）', () => {
    const { store, bindings } = makeSlotStore()
    expect(() => bindings.dispatch('netdisk.share.verify', 'quark-verify', { channelId: 'c-parked' }, { fallback: false }))
      .toThrow(SlotBrokenError)
    try {
      bindings.dispatch('netdisk.share.verify', 'quark-verify', { channelId: 'c-parked' }, { fallback: false })
    } catch (e) {
      expect(e).toBeInstanceOf(SlotBrokenError)
      expect((e as SlotBrokenError).channelId).toBe('c-parked')
      expect((e as SlotBrokenError).callsiteId).toBe('netdisk.share.verify')
      expect((e as SlotBrokenError).providerIds).toEqual(['verify-parked'])
    }
    store.close()
  })
  it('fixed: slot全 parked → 抛 SlotBrokenError（§5.1)', () => {
    const { store, bindings } = makeSlotStore()
    expect(() => bindings.fixed('search.resources', { channelId: 'c-search-parked' })).toThrow(SlotBrokenError)
    store.close()
  })
  // serves 闸门只加在全局 binding 那一路。槽位是显式意图：填了就照用（键不匹配也用）、
  // 全 parked 照抛 SlotBrokenError——这两条与 fixed() 完全一致。
  it('fixedServing: 槽位不过 serves 闸门,填了什么就用什么', () => {
    const { store, bindings } = makeSlotStore()
    expect(bindings.fixedServing('search.resources', 'whatever-key', { channelId: 'c-nsfw' })).toBe('nsfw-search')
    store.close()
  })
  it('fixedServing: slot全 parked → 仍抛 SlotBrokenError（§5.1 不被闸门削弱）', () => {
    const { store, bindings } = makeSlotStore()
    expect(() => bindings.fixedServing('search.resources', 'whatever-key', { channelId: 'c-search-parked' }))
      .toThrow(SlotBrokenError)
    store.close()
  })
  it('fixed/dispatch: slot 部分 parked、部分可用 → 正常返回可用行,不抛', () => {
    const { store, bindings } = makeSlotStore()
    expect(bindings.fixed('search.resources', { channelId: 'c-search-partial' })).toBe('nsfw-search')
    store.close()
  })
})

// 存量体检：写入闸（validateSelection）只管写入那一刻，拦不住升级前就躺在库里的绑定——
// collect 标记是后加到 video.detail.* 上的。所以下面两条都**绕开 put()** 直接写库，
// 模拟"升级前用户手动绑了一条 sequential 行"。
describe('auditCollect — collect 调用点的开机体检', () => {
  it('存量绑定绑着 sequential 行 → 重置为默认行并回执（槽位那一份摘掉）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    store.putProviderBinding({ callsiteId: 'video.detail.metadata', providerIds: ['meta-seq'] })
    store.putChannel({ id: 'c-video', label: '', present: 'video', stream_ids: [], options: { slots: { 'video.detail.images': ['img-seq'], 'search.resources': ['meta-a'] } } })

    const fallbacks = bindings.auditCollect(PROVIDER_CALLSITES)

    const forBinding = fallbacks.find((f) => f.scope === 'binding')
    expect(forBinding).toMatchObject({
      callsiteId: 'video.detail.metadata',
      previousProviderIds: ['meta-seq'],
      offending: [{ providerId: 'meta-seq', strategy: 'sequential' }],
      fallbackProviderIds: ['video-metadata'],
    })
    expect(bindings.binding('video.detail.metadata')?.providerIds).toEqual(['video-metadata'])

    const forSlot = fallbacks.find((f) => f.scope === 'slot')
    expect(forSlot).toMatchObject({ callsiteId: 'video.detail.images', channelId: 'c-video', fallbackProviderIds: null })
    const slots = (store.getChannel('c-video')!.options as { slots: Record<string, string[]> }).slots
    expect(slots['video.detail.images']).toBeUndefined()
    // 非 collect 的槽位一个字都不动（sequential 行在那儿是合法的）。
    expect(slots['search.resources']).toEqual(['meta-a'])
    // 幂等：第二趟已经没有可回落的了——零回执（每次开机都跑，不能每次都吵一遍）。
    expect(bindings.auditCollect(PROVIDER_CALLSITES)).toEqual([])
    store.close()
  })

  it('同频道两个 collect 槽位都脏 → 两个键都摘掉，回执两条（钉住就地回写：没有它第二轮会拿陈旧 options 把第一轮刚摘掉的槽位写回去）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    store.putChannel({ id: 'c-video', label: '', present: 'video', stream_ids: [], options: { slots: { 'video.detail.canonical': ['meta-seq'], 'video.detail.images': ['img-seq'] } } })

    const fallbacks = bindings.auditCollect(PROVIDER_CALLSITES)

    const forCanonical = fallbacks.find((f) => f.callsiteId === 'video.detail.canonical')
    const forImages = fallbacks.find((f) => f.callsiteId === 'video.detail.images')
    expect(fallbacks).toHaveLength(2)
    expect(forCanonical).toMatchObject({ scope: 'slot', channelId: 'c-video', fallbackProviderIds: null })
    expect(forImages).toMatchObject({ scope: 'slot', channelId: 'c-video', fallbackProviderIds: null })

    const slots = (store.getChannel('c-video')!.options as { slots: Record<string, string[]> }).slots
    expect(slots['video.detail.canonical']).toBeUndefined()
    expect(slots['video.detail.images']).toBeUndefined()
    store.close()
  })

  // 默认行可以由包声明填（`callsiteDefaultsFor`），一台没装那个包的机器上它就是空的。
  // 体检要清掉一条不合格的绑定、却没有默认可回落时，**删掉**而不是写一条空绑定：空绑定也算
  // "有绑定"，`ensureDefaults` 下次开机会跳过这一格，包到位了也补不上，而没有一处会喊。
  it('不合格 + 默认行为空 → 删掉绑定（不写空的，否则这一格从此补不上）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    const base = PROVIDER_CALLSITES.find((c) => c.id === 'video.detail.metadata')!
    const noDefaults = [{ ...base, defaultProviderIds: [] }]
    store.putProviderBinding({ callsiteId: 'video.detail.metadata', providerIds: ['meta-seq'] })

    expect(bindings.auditCollect(noDefaults)).toMatchObject([
      { scope: 'binding', callsiteId: 'video.detail.metadata', previousProviderIds: ['meta-seq'], fallbackProviderIds: [] },
    ])
    expect(bindings.binding('video.detail.metadata')).toBeNull()
    expect(bindings.auditCollect(noDefaults)).toEqual([]) // 幂等：绑定没了，第二趟无话可说
    store.close()
  })

  /**
   * dispatch 调用点的**已有**绑定要并进包声明的默认行。只补空绑定是不够的：升级前的装机上
   * 取歌那一格已经绑着一条行，于是第二个平台包声明同一个调用点时整格是 no-op——用户装了包、
   * 行也建出来了，就是永远派发不到它，而没有任何一处会喊。
   */
  describe('ensureDefaults', () => {
    const dispatchBase = () => PROVIDER_CALLSITES.find((c) => c.id === 'video.resolve')!
    const fixedBase = () => PROVIDER_CALLSITES.find((c) => c.id === 'video.detail.metadata')!

    it('dispatch 已有绑定 [a] + 包默认 [a, b] → 并成 [a, b]（已有的在前，不重复）', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      store.putProviderBinding({ callsiteId: 'video.resolve', providerIds: ['bili'] })

      const descriptors = [{ ...dispatchBase(), defaultProviderIds: ['bili', 'fallback'] }]
      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 0, augmented: 1 })
      expect(bindings.binding('video.resolve')!.providerIds).toEqual(['bili', 'fallback'])
      // 幂等：都在了就一个不加
      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 0, augmented: 0 })
      store.close()
    })

    it('fixed 调用点的已有绑定不动（那一格只有一个答案，已有的是用户的选择）', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      store.putProviderBinding({ callsiteId: 'video.detail.metadata', providerIds: ['meta-a'] })

      expect(bindings.ensureDefaults([{ ...fixedBase(), defaultProviderIds: ['meta-a', 'meta-b'] }]))
        .toEqual({ inserted: 0, augmented: 0 })
      expect(bindings.binding('video.detail.metadata')!.providerIds).toEqual(['meta-a'])
      store.close()
    })

    // 「这条默认行是新来的」和「用户把它删掉了」在库里长得一模一样。判据必须是"提过没有"，
    // 否则用户每删一次、每次重启它又长回来，而没有一处会喊。
    it('用户删掉一条提过的默认行 → 下次开机不再塞回去', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      const descriptors = [{ ...dispatchBase(), defaultProviderIds: ['bili', 'fallback'] }]
      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 1, augmented: 0 })
      expect(store.getProviderBinding('video.resolve')!.offeredDefaults).toEqual(['bili', 'fallback'])

      bindings.put('video.resolve', ['bili'])   // 用户从页面把 fallback 删了
      expect(store.getProviderBinding('video.resolve')!.offeredDefaults).toEqual(['bili', 'fallback']) // 记账留着

      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 0, augmented: 0 })
      expect(bindings.binding('video.resolve')!.providerIds).toEqual(['bili'])
    })

    it('装了新包多一条默认行 → 补进去，但只补这一次', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      // 升级前的存量绑定：没有 offeredDefaults（一条都没提过）
      store.putProviderBinding({ callsiteId: 'video.resolve', providerIds: ['bili'] })
      expect(store.getProviderBinding('video.resolve')!.offeredDefaults).toBeUndefined()

      const descriptors = [{ ...dispatchBase(), defaultProviderIds: ['bili', 'fallback'] }]
      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 0, augmented: 1 })
      expect(bindings.binding('video.resolve')!.providerIds).toEqual(['bili', 'fallback'])

      bindings.put('video.resolve', ['bili'])   // 用户又把它删了
      expect(bindings.ensureDefaults(descriptors)).toEqual({ inserted: 0, augmented: 0 })
      expect(bindings.binding('video.resolve')!.providerIds).toEqual(['bili'])
    })

    it('restore() 照旧回到完整的默认行集合（记账不挡它）', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      // 要一个**有默认行**的 dispatch 调用点。网盘播放的默认由网盘包的 `callsites` 填（宿主不认识
      // 任何网盘，没装包时为空——那时 restore 的语义是清掉绑定、回 null），所以这里挂一条包行。
      setPackageIdentities([{
        facility: 'nd', packageName: '@t/nd',
        declaration: {
          id: 'nd-play', category: 'resolve', serveKeys: ['nd-play'], strategy: 'sequential', label: 'nd', description: 'd',
          members: [], callsites: ['netdisk.play'],
        },
      }])
      try {
        const callsite = PROVIDER_CALLSITES.find((c) => c.id === 'netdisk.play')!
        const defaults = callsite.defaultProviderIds
        expect(defaults).toEqual(['nd-play'])
        // restore 读的是真实调用点的默认行，所以那几条行得真在库里。
        for (const id of defaults) {
          store.putProvider({ id, label: id, description: '', category: 'resolve', serves: [id], strategy: 'sequential', members: [], contract: null, options: {} })
        }
        bindings.ensureDefaults([{ ...callsite, defaultProviderIds: ['bili', 'fallback'] }])
        bindings.put('netdisk.play', ['bili'])

        expect(bindings.restore('netdisk.play')!.providerIds).toEqual(defaults)
      } finally { setPackageIdentities([]) }
    })

    it('restore()：默认行为空的 dispatch 调用点（包还没装）→ 清掉绑定、回 null，不写空绑定', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      expect(dispatchBase().defaultProviderIds).toEqual([])
      store.putProviderBinding({ callsiteId: 'video.resolve', providerIds: ['bili'] })

      expect(bindings.restore('video.resolve')).toBeNull()
      expect(store.getProviderBinding('video.resolve')).toBeNull()
    })

    it('没有绑定 → 照旧新建一条', () => {
      const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
      expect(bindings.ensureDefaults([{ ...dispatchBase(), defaultProviderIds: ['bili'] }]))
        .toEqual({ inserted: 1, augmented: 0 })
      expect(bindings.binding('video.resolve')!.providerIds).toEqual(['bili'])
      store.close()
    })

    /**
     * 真绑定 + 真身份表：`dispatch()` 只在调用点**绑定里**的行中挑，所以包声明的 transform 行
     * 得经 `callsites: ['content.enrich']` 进默认才可达。曾经的前提是「按 serveKeys 命中即可，
     * 不用进默认」——那条行建出来了、键也对，`dispatch(..., {fallback:false})` 照样回 null，
     * 贴的链接全部落到宿主的 unknown 分支，而没有一处会喊。
     */
    it('包声明的 transform 行经 callsites 进 content.enrich 默认 → 按主机键派发得到；fetch-url 仍是兜底', () => {
      const store = makeStore()
      try {
        setPackageIdentities([{
          facility: 'pkg',
          declaration: {
            id: 'pkg-url', category: 'transform', serveKeys: ['x.example'], strategy: 'sequential',
            label: 'PKG 链接', description: 'd', members: [{ source: 'pkg-fetch-url' }], callsites: ['content.enrich'],
          },
        }])
        ensureSystemRows(store)   // 系统行（含 fetch-url 与包行）真建进库
        const bindings = new ProviderBindings(store, new ProviderDirectory(store, allIdentities()))
        bindings.ensureDefaults(PROVIDER_CALLSITES)

        expect(bindings.binding('content.enrich')!.providerIds).toEqual(['fetch-url', 'pkg-url'])
        expect(bindings.dispatch('content.enrich', 'x.example', undefined, { fallback: false })).toBe('pkg-url')
        expect(bindings.dispatch('content.enrich', 'other.example', undefined, { fallback: false })).toBeNull()
        expect(bindings.dispatch('content.enrich', 'other.example', undefined, { fallback: true })).toBe('fetch-url')
      } finally { setPackageIdentities([]); store.close() }
    })
  })

  // 默认行为空 = 那个包没装（取歌调用点的默认行全部由包声明填），是常态不是错误。
  // 写 `put([])` 会被 validateSelection 拒 → 「恢复默认」那个按钮回 400。
  it('restore：默认行为空 → 清掉绑定并回 null（不写空绑定、也不抛）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    expect(PROVIDER_CALLSITES.find((c) => c.id === 'music.track.resolve')!.defaultProviderIds).toEqual([])
    bindings.put('music.track.resolve', ['bili'])

    expect(bindings.restore('music.track.resolve')).toBeNull()
    expect(bindings.binding('music.track.resolve')).toBeNull()
    store.close()
  })

  it('全合格 → 一处不动、零回执（幂等，每次开机都跑）', () => {
    const store = makeStore(); const bindings = new ProviderBindings(store, new ProviderDirectory(store, SYSTEM_IDENTITIES))
    bindings.put('video.detail.metadata', ['meta-a'])
    store.putChannel({ id: 'c-video', label: '', present: 'video', stream_ids: [], options: { slots: { 'video.detail.images': ['meta-b'] } } })

    expect(bindings.auditCollect(PROVIDER_CALLSITES)).toEqual([])
    expect(bindings.binding('video.detail.metadata')?.providerIds).toEqual(['meta-a'])
    expect((store.getChannel('c-video')!.options as { slots: Record<string, string[]> }).slots['video.detail.images']).toEqual(['meta-b'])
    store.close()
  })
})
