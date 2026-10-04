import type { SchedulingDomain } from '../kernel/plugins/scheduling.ts'
import type { Stores } from '../kernel/plugins/storage.ts'
import type { ProviderService } from '../kernel/plugins/provider.ts'
import type { AgentDomain } from '../kernel/plugins/agent.ts'
import type { StreamServiceLike } from './tools.ts'
import type { McpExtras } from './tool-catalog.ts'
import { NoopSourceHealthStore } from '../source-health-store.ts'

export class NeedsBackendError extends Error {
  readonly code = 'needs_backend' as const
  // 消息在**每一种能产生它的情形下都必须是真话**。这个 guard 是无条件抛的:它自己不知道
  // 上层有没有装 spawn 路由,所以不能一口咬定"是 STREAM_STDIO_NO_SPAWN 拦住了自动启动"——
  // 没设过这个变量的用户(也就是自动 spawn 真的失败了的那批)会被指去 unset 一个他根本没有的
  // 变量。改成按 env 分两种措辞:
  //   1) NO_SPAWN=1(用户主动退出自动 spawn)→ 指回那个开关;
  //   2) 其余情况 → 只讲"后端没在跑,自己起一个",不臆测原因。spawn 真的试过并失败时,
  //      spawn-router.ts 会在这句话后面追加 "(spawn attempt failed: …)" 说明为什么没起来。
  // "needs the Stream backend running" is a load-bearing sentinel substring — spawn-router.ts
  // (looksNeedsBackend) matches on it to decide whether to spawn a backend and retry. Keep it
  // verbatim if this message changes again.
  constructor(action: string, env: NodeJS.ProcessEnv = process.env) {
    const head = `${action} needs the Stream backend running`
    super(
      env.STREAM_STDIO_NO_SPAWN === '1'
        ? `${head}, and STREAM_STDIO_NO_SPAWN=1 has opted this process out of starting one automatically — unset it to auto-start on demand, or start the backend yourself (open the app, or \`docker compose up\` for a Compose deployment), then retry.`
        : `${head} — start it (open the app, or \`docker compose up\` for a Compose deployment), then retry.`
    )
    this.name = 'NeedsBackendError'
  }
}

// 四半拼的，四格分住四个域：`service`/`scheduler` 住采集调度域（`ctx.scheduling`）、
// `discoveredChannels` 住存储域（`ctx.stores`）、`providerStats` 住 Provider 执行面
// （`ctx.provider`）、`mcpExtras` 住 agent 域（`ctx.agent`）。
// **这一处不走 HttpDeps**——disk 档根本没有 HTTP 层，它直接吃内核，所以搬域时它不会
// 被 HttpDeps 那条扫描扫到。
type DiskServiceDeps = Pick<SchedulingDomain, 'service' | 'scheduler'>
  & Pick<AgentDomain, 'mcpExtras'>
  & Pick<Stores, 'discoveredChannels'>
  & Pick<ProviderService, 'providerStats'>

const guard =
  (action: string) =>
  (): never => {
    throw new NeedsBackendError(action)
  }

// refreshStream is the one guarded method with a Promise-returning signature (Promise<TickResult>)
// — callers (and this file's own test) do `await`/`.catch()` on it, so it must reject, not throw
// synchronously. A plain `guard()` here would throw before the Promise machinery ever engages.
const asyncGuard =
  (action: string) =>
  async (): Promise<never> => {
    throw new NeedsBackendError(action)
  }

/** Wraps a disk-opened Boot's real service+extras: read methods delegate for real (the
 *  registry/scheduler/store this Boot opened from disk — see stdio-entry.ts for how that Boot
 *  gets built without starting the scheduler); write/action methods throw NeedsBackendError
 *  instead of touching the DB or driving a live browser. The stdio process may be the DB's sole
 *  accessor when this runs (D5), but it must still never write — a backend that starts later
 *  would inherit stale in-memory state from a write it never saw (D4/D6). */
export function buildDiskService(deps: DiskServiceDeps): { service: StreamServiceLike; extras: McpExtras } {
  const svc = deps.service

  // Guarantee the invariant at the source, not just at the call sites below: read/preview
  // methods delegate into Scheduler.fetchSource, whose catch block records ANY auth-classified
  // failure to SourceHealthStore even on ad-hoc reads (the auth branch bypasses the
  // `recordHealth` gate — see fetchSource's own comment). A real SourceHealthStore.record()
  // does a writeFileSync+renameSync on <dataDir>/source-health.json — exactly the disk write
  // D4/D6 forbid. Installing a no-op ledger here means it holds regardless of what bootstrap
  // wired the Boot's scheduler with.
  deps.scheduler.setHealthStore(new NoopSourceHealthStore())

  // Same invariant, a second source: content_search/video_search (McpExtras.contentSearch/
  // videoSearch, passed through untouched below — legitimate reads that must keep serving live
  // in disk mode) transitively write through providerExecutor.invoke() into provider_calls on
  // cache.db (ProviderStatsStore.record), and video_search additionally writes discovered_channel
  // on discovered.db (DiscoveredChannels.record, via facetOneSource's recordChannels callback).
  // resolve_target (McpExtras.resolve.resolveTarget) reaches the same provider_calls write through
  // ResolveEngine's providerRows.count callback — disableWrites() below closes that one too, for
  // free, since it mutates the shared store instance rather than guarding each call site.
  // disableWrites() flips a flag in place (not a store swap, unlike setHealthStore above) because
  // ProviderExecutor/ResolveEngine/bootstrap's searchOneGroup+facetResources closures all capture
  // these exact store instances by reference at construction time — mutating the instance reaches
  // every holder with no extra wiring at those call sites.
  deps.providerStats.disableWrites()
  deps.discoveredChannels.disableWrites()

  const service: StreamServiceLike = {
    resolvePluginAndSource: svc.resolvePluginAndSource.bind(svc),
    list: svc.list.bind(svc),
    categories: svc.categories.bind(svc),
    plugins: svc.plugins.bind(svc),
    pluginSources: svc.pluginSources.bind(svc),
    searchAllPluginSources: svc.searchAllPluginSources.bind(svc),
    pluginSourceDetail: svc.pluginSourceDetail.bind(svc),
    search: svc.search.bind(svc),
    read: svc.read.bind(svc),
    previewStream: svc.previewStream.bind(svc),
    readStreamInSourceOrder: svc.readStreamInSourceOrder.bind(svc),
    previewSource: svc.previewSource.bind(svc),
    sources: svc.sources.bind(svc),
    status: svc.status.bind(svc),
    streamsResource: svc.streamsResource.bind(svc),
    topics: svc.topics.bind(svc),
    subscribe: guard('stream_subscribe'),
    ensureChannel: guard('stream_subscribe'),
    // 读频道清单是**读**，不该被写闸门挡住：disk 模式下 subscribe 本来就会拒，但"有哪些频道"
    // 这个问题在没后端时也答得出来（它就在同一份库里）。挡住它只会让模型拿不到候选、
    // 于是编一个频道名出来。
    listChannels: svc.listChannels.bind(svc),
    unsubscribe: guard('stream_unsubscribe'),
    refreshStream: asyncGuard('refreshStream'),
    scheduleFlowStream: guard('scheduleFlowStream'),
    scheduleResourceStream: guard('scheduleResourceStream'),
    updateResourceStream: guard('updateResourceStream'),
    rescheduleResourceStream: guard('rescheduleResourceStream'),
    unscheduleResourceStream: guard('unscheduleResourceStream'),
  }

  return { service, extras: guardExtras(deps.mcpExtras) }
}

// The McpExtras action面: methods that drive a live operation (extract kicks off an async
// backend jobs; searchAgent.start launches a T3 job) or write persisted state (netdisk.applySpec
// writes a MatchSpec into the netdisk store) — same DB-single-writer/split-brain concern as the
// StreamServiceLike write methods above, so guarded the same way.
//
// main landed a unified-CDP-facade refactor (see cdp-router.ts) that collapsed the old
// per-transport fields — chromeAct/facilityAct/chromeCdp/chromeCloseTab/chromeLook/chromeShot/
// chromeTabs/facilityLook/facilityShot — into 4 target-dispatched verbs: cdpLook/cdpShot/cdpAct/
// cdpPages (each takes a `target`: chrome[:tabId] / facility:<name> / desktop). Old→new mapping:
//   chromeAct, facilityAct                          → cdpAct   (guarded)
//   chromeCdp (open tab + eval, url branch of look)  → folded into cdpLook (passthrough — see below)
//   chromeLook, facilityLook                         → folded into cdpLook (passthrough)
//   chromeShot, facilityShot                         → folded into cdpShot (passthrough)
//   chromeTabs, chromeCloseTab                       → folded into cdpPages (passthrough — see below)
//
// cdpAct is guarded wholesale: cdp-router.act() dispatches to chromeAct/facilityAct (both
// LaneAction verbs with a `confirmed` gate — click/type/navigate on a live tab) for every target
// (and to the desktop driver, which is absent in disk mode). There is
// no read-shaped branch in cdpAct at all, so guarding the whole verb is exact, not an
// approximation. Promise-returning — asyncGuard, same reasoning as netdisk.applySpec below.
//
// cdpLook/cdpShot/cdpPages are passed through WHOLESALE, not guarded, even though cdp-router.ts
// folds two former mutating verbs into them:
//   - cdpLook({target:'chrome', url, js}) routes to the OLD chromeCdp behavior (opens a real tab
//     via extLauncher.launch, evals arbitrary JS, closes it unless interactive) — a genuine
//     browser-driving action, not a read.
//   - cdpPages({target:'chrome', close}) routes to the OLD chromeCloseTab behavior (closes a real
//     tab) when `close` is given; only the close-less form is a pure list.
// Both are safe to leave unguarded because of a fact verified against the actual call chain, not
// assumed: every one of these paths bottoms out in ExtRelay.send() (chromeCdp→extLauncher.launch→
// relay.newTab→send; chromeCloseTab→relay.closeTab→send), and ExtRelay.send() rejects immediately
// with ExtRelayDisconnected when `this.socket` is null — no disk write, no process spawn, nothing
// mutates before that check. bootstrap() only constructs `new ExtRelay()`; the WS wiring the
// extension actually connects to (`attachExtRelay(server, ...)`) is called only from serve.ts on
// the HTTP server, which a disk-only stdio process never starts. So extRelay.socket is permanently
// null here and these calls always reject cleanly via the same null-socket short-circuit that
// already made the OLD chromeTabs/chromeLook/chromeShot/facilityLook/facilityShot passthrough
// safe — guarding would only upgrade the error message (opaque ExtRelayDisconnected → clean
// NeedsBackendError), not change any safety property, and the unified verb can't be guarded
// per-branch without duplicating cdp-router's target-dispatch logic here. facility targets on
// cdpLook/cdpShot (facilityLook/facilityShot) were already passthrough reads before the refactor
// and are unchanged by it.
//
// One read-shaped extra is nevertheless guarded — harvestCapability, because in disk mode its
// answer is necessarily FALSE rather than merely unavailable (see its entry below). It is the
// exception to the next paragraph, not a counterexample to the write/action rule.
//
// Everything else on McpExtras is read/probe-shaped and passes through untouched: contentSearch,
// readUrl, videoSearch, conversions.list, resolve.* (resolveIntent/classifyIntent/
// resolveTarget/listSources), netdisk.bindings/residue/previewSpec, cdpLook, cdpShot, cdpPages,
// searchAgent.get.
//
// readUrl 不 guard，理由和 contentSearch 同一条：纯读、而且**不经后端**（打 article-extract
// 梯子）。disk 档里它照常能答，拒答只会让「后端没跑」连累一件本来做得到的事。
//
// **webSearch 要 guard**，理由和 harvestCapability 同一条（见下面那段）：它今天的实现是借
// 用户的浏览器打真搜索页，整条路 bottoms out 在 ExtRelay.send()，而上面已经论证过 disk 档里
// `extRelay.socket` 恒为 null。不 guard 的话，用户拿到的是一句 ExtRelayDisconnected
// （「扩展掉线了」），而真相是「后端根本没在跑」——把人指向错误的排查方向比拒答有害得多。
//
// contentSearch/videoSearch (and resolve.resolveTarget) are passed through UNGUARDED on purpose —
// they're legitimate reads that must keep serving live in disk mode — but they transitively write
// provider_calls/discovered_channel stats. buildDiskService neutralizes that at the source (see
// the disableWrites() calls above), not by guarding these tools into NeedsBackendError.
/**
 * 把一组覆盖项盖到 `base` 上，**保住 base 的属性描述符与原型链**。
 *
 * 为什么不是 `{ ...base, ...overrides }`：`McpExtras` 上有两类东西 spread 会毁掉——
 *  1. **getter**（`buildMcpExtras` 里一批按域可用性现算的格子，如声纹那一档 `identify`、`extract`）：
 *     spread 只拷贝**展开那一刻的求值结果**，此后再没醒过来的容器永远算成不在。
 *     AGENTS.md 为它记过两次，两次都是"工具面少几个动词且没有任何一处会喊"。
 *  2. **原型链上的属性**：`withCapabilityTools` 交回来的那份是 `Object.create(base)`，
 *     自有属性只有 `capabilityTools` 一格，其余全靠委托——spread 会把它们整片丢掉。
 * 两条都失败得很安静，所以这里不能是普通对象字面量。
 */
function overlay(base: McpExtras, overrides: Partial<McpExtras>): McpExtras {
  const out = Object.create(Object.getPrototypeOf(base) as object, Object.getOwnPropertyDescriptors(base)) as McpExtras
  return Object.defineProperties(out, Object.getOwnPropertyDescriptors(overrides)) as McpExtras
}

function guardExtras(extras: McpExtras): McpExtras {
  return overlay(extras, {
    // extract 现在过 digest 层(extract-digest.ts)返回 Promise<unknown> ——同 netdisk.applySpec
    // 下面那条理由：plain guard() 会在调用方拿到 promise 之前就同步抛，`await`/`.rejects` 接不住。
    extract: extras.extract ? asyncGuard('extract') : undefined,
    // Promise-returning like refreshStream above — a plain guard() would throw before a caller's
    // `await`/`.rejects` ever gets a promise to attach to; must reject, not throw synchronously.
    // 网盘那一格是**逐成员**判的，别只挡认得出名字的那个：`applySpec` 之外还有四个动词会真动
    // 用户的文件或状态——`reconcileExecute`（搬 + 删，这一格此前是漏的）、`reconcileUndoRun`
    // （反向搬回去）、`follow` 的 run/enable/disable（转存 + 删副本 + 改追更开关）。
    // 只读的 `bindings`/`browse`/`residue`/`previewSpec`/`reconcileStatus`/`shareVerify`
    // 照旧放行：它们在 disk 档答得出来，拒答只会让"后端没跑"连累一件本来做得到的事
    // （`reconcileStatus` 走的 `previewShow` 只读不落库，核过）。
    //
    // **`sync` 例外，它不是只读的**：`NetdiskService.sync` 重算完配对后 `store.save(set)`
    // （`src/netdisk/sync.ts`，成功和 broken 两条路各存一次），落的是 netdisk 库里的绑定行。
    // disk 档的铁律是一个字都不写（D4/D6：后来起来的后端会继承一次它没看见的写）。
    // 名字听起来像读的那一格，恰恰是最容易漏的一格。
    // `follow` 的 `view` 也是读，但它和三个写动词共用一个入参——按 action 分档，别整格挡掉。
    netdisk: extras.netdisk
      ? {
          ...extras.netdisk,
          applySpec: asyncGuard('netdisk_apply_spec'),
          reconcileExecute: asyncGuard('reconcile_execute'),
          reconcileUndoRun: asyncGuard('reconcile_undo_run'),
          sync: asyncGuard('netdisk_sync'),
          // 裁决器手动入口两个都写：`adjudicate` 落决策账本、必要时重新归档；`revokeAdjudication`
          // 删决策行——同 `reconcileUndoRun` 一类，disk 档答不出真话，只能拒答。
          ...(extras.netdisk.adjudicate ? { adjudicate: asyncGuard('reconcile_adjudicate') } : {}),
          ...(extras.netdisk.revokeAdjudication ? { revokeAdjudication: asyncGuard('reconcile_revoke_adjudication') } : {}),
          ...(extras.netdisk.follow
            ? {
                follow: async (setId: string, action: 'view' | 'enable' | 'disable' | 'run') =>
                  action === 'view'
                    ? extras.netdisk!.follow!(setId, action)
                    : asyncGuard(`netdisk_follow ${action}`)(),
              }
            : {}),
        }
      : undefined,
    // The unified facade's one live-driving verb — see the block comment above for why cdpLook/
    // cdpShot/cdpPages stay unguarded despite each folding in a former mutating field.
    // Promise-returning — asyncGuard, same reasoning as netdisk.applySpec.
    cdpAct: extras.cdpAct ? asyncGuard('cdp_act') : undefined,
    // 唯一一个**读形状却仍要 guard** 的 extra，理由不是写盘，是**答案在这里必然是假话**：
    // 上面已经论证过 disk 档里 extRelay.socket 恒为 null（attachExtRelay 只在 serve.ts 里跑，
    // 这个进程从不起 HTTP server），所以快判恒判成 `disconnected` —— 一句"扩展掉线了，去
    // 重新加载扩展"，而真相是"后端根本没在跑"。这个 tool 的产物是**给人照着走的判断**，
    // 把人指向错误的排查方向比拒答有害得多；NeedsBackendError 说的才是真话。
    // Promise-returning —— asyncGuard，同 netdisk.applySpec。
    harvestCapability: extras.harvestCapability ? asyncGuard('harvest_capability') : undefined,
    // 「替他去申请一把 key」是**写**：它在用户自己的 Chrome 里建一把真 key、把明文写进本机配置。
    // 整条路和 web_search 一样 bottoms out 在 ExtRelay.send()（disk 档里 socket 恒为 null），
    // 而且这一档的失败最贵——模型手里那份回执分不出「扩展掉线」和「后端没跑」，会让用户去
    // 重新加载扩展，而真相是这个进程压根没起 HTTP server。Promise-returning —— asyncGuard。
    // **只挡写那一半**：`configProvisionerFor` 是纯读（recipe 表上的反查），`capability_status`
    // 同理（读 kinds/registry/凭据层，全在盘上，disk 档答得出真话）——拒答它们只会让"后端
    // 没跑"连累一件本来做得到的事，而"哪一格缺 key、该去哪拿"恰恰是这一档最该答得出的问题。
    provisionConfigSlot: extras.provisionConfigSlot ? asyncGuard('provision_capability_key') : undefined,
    // 同上一条：网页搜索现在只有浏览器这一条实现，disk 档里必然断在 ExtRelay 上，报的却是
    // 「扩展掉线」。Promise-returning —— asyncGuard。
    webSearch: extras.webSearch ? asyncGuard('web_search') : undefined,
    // 同 webSearch：决策 job 的横评那一格走 contentSearch，disk 档里必然断在 ExtRelay 上，
    // 而它自己的容错会把这次断线记成一条 gap、照常交一份**只有价格没有体验序**的回执——
    // 一份看起来跑通了的残次品比拒答有害得多（它连"这是残的"都说得挺自然）。
    // Promise-returning —— asyncGuard。
    purchaseDecide: extras.purchaseDecide ? guard('purchase_decide') : undefined,
    // 两个「起一轮活」的动词都要 guard，**别只 guard 认得出名字的那个**：`enumerate` 和
    // `start` 是同一件事的两个域（都写 run 库、都发真网络/LLM 调用），漏掉它的表现是
    // disk 档里 `enumerate_candidates` 安静地真跑起来。`get` 是只读，照旧放行。
    searchAgent: extras.searchAgent
      ? {
          ...extras.searchAgent,
          start: guard('search_agent'),
          ...(extras.searchAgent.enumerate ? { enumerate: guard('enumerate_candidates') } : {}),
        }
      : undefined,
  })
}
