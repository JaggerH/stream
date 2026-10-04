import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildDiskService, NeedsBackendError } from './disk-service.ts'
import { withCapabilityTools } from './capability-tools.ts'
import { StreamService } from './tools.ts'
import { Registry } from '../registry/registry.ts'
import { Scheduler } from '../scheduler.ts'
import { DedupStore } from '../dedup-store.ts'
import { UserStore } from '../store/user-store.ts'
import { SourceHealthStore } from '../source-health-store.ts'
import { ProviderStatsStore } from '../providers/stats-store.ts'
import { DiscoveredChannels } from '../search/discovered.ts'
import type { Adapter } from '../adapters/types.ts'
import type { SourceManifest } from '../manifest/types.ts'
import type { Stream } from '../streams/types.ts'
import type { McpExtras } from './tool-catalog.ts'

/** `isCommunitySource` 是 McpExtras 上唯一的必填格（搜索分档谓词）；disk 档原样透传它，
 *  本文件不验分档，统一给恒 false。 */
const noTier: McpExtras = { isCommunitySource: () => false }

function mk(partial: Partial<SourceManifest> & { id: string }): SourceManifest {
  return {
    schema_version: 1, adapter: 'fake', type: 'post', description: partial.id,
    topics: [], example_queries: [], capabilities: ['timeline'], auth: { type: 'none' },
    params_schema: {}, cadence_hint_seconds: 1800, discoverable: true, ...partial,
  }
}
const fake: Adapter = { id: 'fake', init: async () => {}, fetch: async () => [{ guid: '1', title: 't' }] }
// classifyError (src/failure.ts) reads "login"/"cookie"/"unauthor" etc. as category 'auth' —
// this mirrors a real facility login-wall (xhs/quark/douyin) surfacing mid-read.
const authFailAdapter: Adapter = {
  id: 'fake-auth', init: async () => {},
  fetch: async () => { throw new Error('login required — cookie expired') },
}
const manifests: SourceManifest[] = [
  mk({ id: 'hn-best', description: 'hacker news' }),
  mk({ id: 'auth-src', description: 'needs login', adapter: 'fake-auth' }),
]
const stream: Stream = { id: 'my-tech', description: 'my tech feed', sources: [{ source_id: 'hn-best', params: {} }], cadence_seconds: 1800, vault_subdir: 'tech' }

describe('buildDiskService', () => {
  let dir: string
  let dedup: DedupStore
  let userStore: UserStore
  let service: StreamService
  let scheduler: Scheduler
  let providerStats: ProviderStatsStore
  let discoveredChannels: DiscoveredChannels

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'disk-svc-'))
    dedup = new DedupStore(join(dir, 'dedup.db'))
    userStore = new UserStore(join(dir, 'stream.db'))
    scheduler = new Scheduler({
      registry: new Registry(manifests), streams: [stream],
      adapters: new Map([['fake', fake], ['fake-auth', authFailAdapter]]), resolveCreds: async () => ({}),
      vaultRoot: join(dir, 'vault'), dedup,
      // a real ledger — same as bootstrap.ts wires for the HTTP/backend path — so the test
      // proves buildDiskService neutralizes it, not that the test forgot to wire one.
      health: new SourceHealthStore(join(dir, 'source-health.json')),
    })
    service = new StreamService({ registry: new Registry(manifests), scheduler, channels: userStore })
    // real stores — same as bootstrap.ts wires for the HTTP/backend path — so the content/video
    // search tests below prove buildDiskService neutralizes them, not that the test forgot to wire one.
    providerStats = new ProviderStatsStore(join(dir, 'cache.db'))
    discoveredChannels = new DiscoveredChannels(join(dir, 'discovered.db'))
  })

  it('delegates read methods for real', () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    expect(disk.service.list()).toEqual(service.list())
    expect(disk.service.status()).toEqual(service.status())
  })

  // I2:这条错误是用户唯一会看到的东西,它在**每一种能产生它的情形下**都必须是真话。
  // guard 是无条件抛的,所以措辞不能一口咬定"是 NO_SPAWN 拦的"——没设过它的用户(自动 spawn
  // 试过并失败的那批)会被指去 unset 一个自己根本没有的变量。
  describe('NeedsBackendError wording is true in each case it can be produced', () => {
    it('opt-out case: names STREAM_STDIO_NO_SPAWN', () => {
      const m = new NeedsBackendError('transcribe', { STREAM_STDIO_NO_SPAWN: '1' }).message
      expect(m).toContain('needs the Stream backend running') // 载荷哨兵,spawn-router 靠它侦测
      expect(m).toContain('STREAM_STDIO_NO_SPAWN=1')
      expect(m).toContain('unset it')
    })
    it('spawn-attempted / plain case: never mentions a variable the user did not set', () => {
      const m = new NeedsBackendError('transcribe', {}).message
      expect(m).toContain('needs the Stream backend running')
      expect(m).not.toContain('STREAM_STDIO_NO_SPAWN')
      expect(m).not.toContain('unset')
    })
  })

  it('subscribe throws NeedsBackendError and never touches the store', () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    const before = userStore.listStreams()
    expect(() => disk.service.subscribe(stream)).toThrow(NeedsBackendError)
    expect(userStore.listStreams()).toEqual(before)
  })

  it('unsubscribe throws NeedsBackendError and never removes anything', () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    expect(() => disk.service.unsubscribe('my-tech')).toThrow(NeedsBackendError)
    expect(service.status().some((s) => s.id === 'my-tech')).toBe(true)
  })

  it('remaining five write/schedule methods all guard', () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    expect(() => disk.service.scheduleFlowStream(stream)).toThrow(NeedsBackendError)
    expect(() => disk.service.scheduleResourceStream(stream)).toThrow(NeedsBackendError)
    expect(() => disk.service.updateResourceStream(stream)).toThrow(NeedsBackendError)
    expect(() => disk.service.rescheduleResourceStream(stream)).toThrow(NeedsBackendError)
    expect(() => disk.service.unscheduleResourceStream('my-tech')).toThrow(NeedsBackendError)
    expect(disk.service.refreshStream('my-tech')).rejects.toThrow(NeedsBackendError)
  })

  // Critical-finding regression (Task 2.1 review): read()/previewStream()/previewSource() all
  // reach Scheduler.fetchSource, whose catch block records ANY auth-classified failure to
  // SourceHealthStore even on ad-hoc reads (recordHealth defaults false, but the auth branch
  // bypasses that gate — see fetchSource's comment). SourceHealthStore.record() does a real
  // writeFileSync+renameSync on <dataDir>/source-health.json. A disk-only stdio process must
  // NEVER write the data dir (D4/D6) — a backend that starts later would inherit a write it
  // never saw, a non-atomic lost-update race. disk-service's own doc comment claims exactly
  // this: "it must still never write".
  const healthFile = () => join(dir, 'source-health.json')

  it('read() on an auth-failing source never writes source-health.json', async () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    await expect(disk.service.read('auth-src')).rejects.toThrow()
    expect(existsSync(healthFile())).toBe(false)
  })

  it('previewSource() on an auth-failing source never writes source-health.json', async () => {
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    const result = await disk.service.previewSource('auth-src')
    expect(result.errors.length).toBeGreaterThan(0) // previewSource never throws — errors[] instead
    expect(existsSync(healthFile())).toBe(false)
  })

  it('previewStream() over a stream whose only source auth-fails never writes source-health.json', async () => {
    const authStream: Stream = { id: 'my-auth', description: 'auth feed', sources: [{ source_id: 'auth-src', params: {} }], cadence_seconds: 1800, vault_subdir: 'auth' }
    scheduler.add(authStream)
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    const result = await disk.service.previewStream('my-auth')
    expect(result.errors.length).toBeGreaterThan(0)
    expect(existsSync(healthFile())).toBe(false)
  })

  it('leaves the data dir with no new/modified files at all after a disk-mode auth-failing read', async () => {
    const before = readdirSync(dir).sort()
    const disk = buildDiskService({ service, scheduler, mcpExtras: noTier, providerStats, discoveredChannels })
    await expect(disk.service.read('auth-src')).rejects.toThrow()
    expect(readdirSync(dir).sort()).toEqual(before)
  })

  // Final-review finding (Task 2.1 audit only covered the 15 StreamServiceLike methods): the
  // McpExtras passthrough contentSearch/videoSearch (content_search/video_search — legitimate
  // reads that must keep serving live in disk mode, so they must NOT be guarded into
  // NeedsBackendError) transitively write through providerExecutor.invoke() into provider_calls
  // on cache.db, and video_search additionally writes discovered_channel on discovered.db via
  // facetOneSource's recordChannels callback. These spies stand in for that real call chain
  // (providerExecutor/facetOneSource) without needing to wire a full ProviderExecutor/registry
  // fixture — they call the SAME real store instances buildDiskService is handed, so the
  // assertion proves disableWrites() actually neutralizes the shared instance, not a spy's own
  // no-op behavior.
  // WAL-mode sqlite writes land in the `-wal` sidecar, not the main .db file — so a
  // filename-only diff, or an mtime check on just cache.db/discovered.db, would MISS a real
  // write. Snapshot every file's mtime (main db + `-wal` sidecar) and require the whole map
  // unchanged.
  //
  // **`-shm` 不算数**：它是 WAL 的共享内存索引，**读**也会碰它（连接打开、取锁都可能刷新它的
  // mtime），而这条用例恰恰要求搜索**照常读**。把它算进来就是把"读了一下"当成"写了数据"——
  // 表现为一条 1/7 概率随机变红的用例（2026-08-12 循环 7 轮复现，差的正是 `cache.db-shm`
  // 一个文件、相差 230ms，而 `cache.db` 与 `cache.db-wal` 纹丝不动）。守卫的牙齿不在它身上：
  // 真写一定会动 `-wal`。
  const dirSnapshot = () =>
    Object.fromEntries(
      readdirSync(dir).sort().filter((f) => !f.endsWith('-shm')).map((f) => [f, statSync(join(dir, f)).mtimeMs])
    )

  it('content_search/video_search stay live but leave cache.db/discovered.db untouched in disk mode', async () => {
    const before = dirSnapshot()

    const contentSearchSpy = async (q: string) => {
      providerStats.record('content-search', 'fake-source') // stands in for providerExecutor.invoke's real call
      return [{ id: q }]
    }
    const videoSearchSpy = async (q: string) => {
      providerStats.record('resource-search', 'fake-source')
      discoveredChannels.record('fake-source', ['chan-a']) // stands in for facetOneSource's recordChannels
      return { shows: [], loose: [], sources: [{ key: 'fake-source', label: 'fake', ms: 0, count: 0, dropped: 0, status: 'ok' as const }] }
    }
    const extras: McpExtras = { ...noTier, contentSearch: contentSearchSpy, videoSearch: videoSearchSpy }
    const disk = buildDiskService({ service, scheduler, mcpExtras: extras, providerStats, discoveredChannels })

    await disk.extras.contentSearch!('q')
    await disk.extras.videoSearch!('q')

    // the tools must have stayed LIVE (not guarded into NeedsBackendError)
    expect(await disk.extras.contentSearch!('q2')).toEqual([{ id: 'q2' }])

    // but the underlying stores must never actually have written
    expect(providerStats.all()).toEqual({})
    expect(discoveredChannels.list('fake-source')).toEqual([])
    expect(dirSnapshot()).toEqual(before)
  })

  it('guards the action-shaped extras, passes through the rest', async () => {
    const extractSpy = () => ({ status: 'done' as const })
    const applySpecSpy = async () => ({ id: 'x', coverage: {} as never, lastSyncAt: '', matchSpec: {} as never })
    // main's unified-CDP-facade refactor collapsed chromeAct/facilityAct/chromeCdp/chromeCloseTab/
    // chromeLook/chromeShot/chromeTabs/facilityLook/facilityShot into 4 target-dispatched verbs —
    // cdpLook/cdpShot/cdpAct/cdpPages (cdp-router.ts). cdpAct is the one live-driving verb (every
    // branch is a LaneAction act call) — guarded.
    // cdpLook/cdpShot/cdpPages stay passthrough: even though cdpLook's chrome+url branch and
    // cdpPages' close branch fold in the old chromeCdp/chromeCloseTab mutating behavior, both
    // bottom out in ExtRelay.send(), which rejects cleanly on the permanently-null socket in disk
    // mode (see disk-service.ts's guardExtras comment) — no disk write, no process spawn.
    const cdpLookSpy = async () => ({ value: 'looked' })
    const cdpShotSpy = async () => ({ shot: null })
    const cdpActSpy = async () => ({ ok: true } as never)
    const cdpPagesSpy = async () => ({ pages: [] })
    const extras: McpExtras = {
      ...noTier,
      extract: extractSpy,
      netdisk: { bindings: () => [], browse: async () => ({}), residue: async () => ({}), previewSpec: async () => ({}), applySpec: applySpecSpy, reconcileStatus: async () => ({}), reconcileDecide: () => ({ ok: true }), reconcileExecute: async () => ({}), reconcileUndoRun: async () => ({}), sync: async () => ({}) },
      cdpLook: cdpLookSpy,
      cdpShot: cdpShotSpy,
      cdpAct: cdpActSpy,
      cdpPages: cdpPagesSpy,
      searchAgent: { start: (goal: string) => ({ runId: goal, status: 'running' }), get: (id: string) => ({ status: 'running', id }) },
      purchaseDecide: () => {
        throw new Error('disk 档里不该真跑到这儿')
      },
    }
    const disk = buildDiskService({ service, scheduler, mcpExtras: extras, providerStats, discoveredChannels })

    // extract 现在过 digest 层返回 Promise<unknown>（extract-digest.ts）——同 cdpAct/applySpec
    // 一样必须拒绝而不是同步抛，callers `await`/`.rejects` 才接得住。
    await expect(disk.extras.extract!('item1')).rejects.toThrow(NeedsBackendError)
    await expect(disk.extras.netdisk!.applySpec('set1', {})).rejects.toThrow(NeedsBackendError)
    expect(() => disk.extras.searchAgent!.start('goal')).toThrow(NeedsBackendError)

    // purchase_decide 同 webSearch：它的横评那一格走 contentSearch → ExtRelay，disk 档里必断。
    // 而它自己的容错会把这次断线记成一条 gap、照常交一份**只有价格没有体验序**的回执——
    // 一份看起来跑通了的残次品比拒答有害得多。它现在是同步起 run（回 runId），所以同步 throw。
    expect(() =>
      disk.extras.purchaseDecide!({
        category: ['手机'],
        priceRange: {},
        softCriteria: ['拍照'],
        holdDays: 730,
        willResell: false,
      }),
    ).toThrow(NeedsBackendError)

    // cdpAct (drives a live tab: click/type/navigate/eval on chrome or cloak) is the Act side of
    // the Act-vs-Look split — delta spec names "driving a browser" as a live-operation that must
    // degrade. Must reject (not throw sync): Promise-returning, callers `await`/`.rejects` on it.
    await expect(disk.extras.cdpAct!({ target: 'chrome:1', type: 'click', selector: 'a' } as never)).rejects.toThrow(NeedsBackendError)

    // read-shaped extras pass through untouched, including cdpPages (list form)
    await expect(disk.extras.cdpLook!({ target: 'chrome:1', js: 'x' })).resolves.toEqual({ value: 'looked' })
    await expect(disk.extras.cdpShot!({ target: 'chrome:1' })).resolves.toEqual({ shot: null })
    await expect(disk.extras.cdpPages!({ target: 'chrome' })).resolves.toEqual({ pages: [] })
    expect(disk.extras.netdisk!.bindings()).toEqual([])
    expect(disk.extras.searchAgent!.get('r1')).toEqual({ status: 'running', id: 'r1' })
  })

  // 逐成员登记：网盘那一格有十来个成员，写形状的**每一个**都要挡住，而 `applySpec` 之外的四个
  // 曾经全是敞开的（`reconcileExecute` 是搬 + 删，`sync` 名字听起来像读、其实 `store.save`）。
  // 这条用例的形状就是那张登记表：往 `extras.netdisk` 加成员时，来这儿给它一行归属。
  it('网盘那一格：写形状的逐个 guard，读形状的逐个放行', async () => {
    const netdisk: NonNullable<McpExtras['netdisk']> = {
      bindings: () => [],
      browse: async () => ({ ok: 'browse' }),
      residue: async () => ({ ok: 'residue' }),
      previewSpec: async () => ({ ok: 'preview' }),
      applySpec: async () => ({}) as never,
      reconcileStatus: async () => ({ ok: 'status' }),
      reconcileDecide: () => ({ ok: true }),
      reconcileExecute: async () => ({ moved: 9 }),
      reconcileUndoRun: async () => ({ undone: 9 }),
      sync: async () => ({ ok: 'sync' }),
      shareVerify: async () => ({ validity: 'alive' }),
      follow: async (setId, action) => ({ setId, action }),
      adjudicate: async () => ({ applied: 1 }),
      revokeAdjudication: async () => ({ ok: true, revoked: 1 }),
    }
    const disk = buildDiskService({ service, scheduler, mcpExtras: { ...noTier, netdisk }, providerStats, discoveredChannels })
    const nd = disk.extras.netdisk!

    // 写：真动用户的文件 / 真改状态
    await expect(nd.applySpec('s1', {})).rejects.toThrow(NeedsBackendError)
    await expect(nd.reconcileExecute('show1')).rejects.toThrow(NeedsBackendError)
    await expect(nd.reconcileUndoRun('run1')).rejects.toThrow(NeedsBackendError)
    // `sync` 重算完就 `store.save(set)`（src/netdisk/sync.ts）——名字像读，落的是真写。
    await expect(nd.sync('s1')).rejects.toThrow(NeedsBackendError)
    // 裁决器两个手动入口都写：一个落决策账本+可能重新归档，一个删决策行。
    await expect(nd.adjudicate!('s1')).rejects.toThrow(NeedsBackendError)
    await expect(nd.revokeAdjudication!('run1')).rejects.toThrow(NeedsBackendError)
    // follow 的三个动词：run 会转存 + 删副本，enable/disable 改的是常驻循环的开关。
    for (const action of ['run', 'enable', 'disable'] as const) {
      await expect(nd.follow!('s1', action)).rejects.toThrow(NeedsBackendError)
    }

    // 读：disk 档答得出来，拒答只会让"后端没跑"连累一件本来做得到的事
    expect(nd.bindings()).toEqual([])
    await expect(nd.browse('/x', false)).resolves.toEqual({ ok: 'browse' })
    await expect(nd.residue('s1')).resolves.toEqual({ ok: 'residue' })
    await expect(nd.previewSpec('s1', {})).resolves.toEqual({ ok: 'preview' })
    await expect(nd.reconcileStatus('show1')).resolves.toEqual({ ok: 'status' })
    await expect(nd.shareVerify!({ link: 'x' })).resolves.toEqual({ validity: 'alive' })
    // follow 的 view 是读，和三个写动词共用一个入参——按 action 分档，别整格挡掉。
    await expect(nd.follow!('s1', 'view')).resolves.toEqual({ setId: 's1', action: 'view' })
  })

  // harvest_capability 是唯一一个**读形状却仍要 guard** 的 extra，理由不是写盘而是"答案会是假话"：
  // disk 档里 relay 的 socket 恒为 null（serve.ts 从没跑过 attachExtRelay），所以它必然报
  // "扩展掉线了、去 reload 扩展"，而真相是"后端没在跑"。诊断工具给错方向比拒答有害得多。
  it('harvest_capability 在 disk 档 guard 掉 —— 不发一个必然为假的「扩展掉线了」', async () => {
    const extras: McpExtras = {
      ...noTier,
      harvestCapability: async () => ({
        state: 'disconnected',
        connected: false,
        since: null,
        everSeen: true,
        chrome: { selected: null, origin: null, candidates: [], mustChoose: false },
      }),
    }
    const disk = buildDiskService({ service, scheduler, mcpExtras: extras, providerStats, discoveredChannels })
    await expect(disk.extras.harvestCapability!()).rejects.toThrow(NeedsBackendError)
  })

  // guardExtras 曾经是 `{ ...extras, …}`。spread 会毁掉 McpExtras 上两类东西，两条都很安静：
  //  1. **getter**（按域可用性现算的那几格）——只拷贝展开那一刻的求值结果，此后再没醒过来的
  //     容器永远算成不在，工具面少几个动词且没有任何一处会喊；
  //  2. **原型链上的属性**——`withCapabilityTools` 交回来的那份自有属性只有 `capabilityTools`
  //     一格，其余全靠委托，spread 会把它们整片丢掉。
  describe('guardExtras 不毁掉 getter 与原型链', () => {
    const guarded = (extras: McpExtras) =>
      buildDiskService({ service, scheduler, mcpExtras: extras, providerStats, discoveredChannels }).extras

    it('base 上的 getter 过了这一层仍然每次现算', () => {
      let n = 0
      const base = { get liveField() { return `v${++n}` } } as unknown as McpExtras
      const out = guarded(base) as unknown as { liveField: string }
      expect(out.liveField).toBe('v1')
      expect(out.liveField).toBe('v2')
    })

    it('withCapabilityTools 委托来的 capabilityTools 与 getter 一起活着', () => {
      let n = 0
      const base = { get liveField() { return `v${++n}` } } as unknown as McpExtras
      const live: import('../../shared/capability/types.ts').ToolDef[] = []
      const out = guarded(withCapabilityTools(base, () => live))
      expect(out.capabilityTools?.()).toEqual([])
      // thunk 还是 thunk：后挂上的工具跟得上。
      live.push({
        name: 'late_verb', description: 'x', parameters: {},
        output: { schema: { type: 'json' }, render: () => [{ type: 'text', text: '' }] },
        execute: async () => ({}),
      })
      expect(out.capabilityTools?.().map((t) => t.name)).toEqual(['late_verb'])
      expect((out as unknown as { liveField: string }).liveField).toBe('v1')
    })

    it('该挡的还是挡着（保住 getter 不能把守卫一起放过去）', async () => {
      const out = guarded(withCapabilityTools({ ...noTier, extract: async () => ({}) } as McpExtras, () => []))
      await expect(out.extract!({} as never)).rejects.toThrow(NeedsBackendError)
    })
  })
})
