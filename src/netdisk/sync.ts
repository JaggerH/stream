import type { MappingStore } from './mapping-store.ts'
import { type AlistClient, toGatewayAlistUrl, isObjectNotFound } from './alist-client.ts'
import type { MappingSet, MappingLeft, MappingEntry, MatchSpec, PlayableHit, SpecResidue, SpecPreview, SpecChange, SpecConflict } from './types.ts'
import { newMappingId } from './mapping-store.ts'
import { matchByFingerprint } from './match-fingerprint.ts'
import { DEFAULT_MATCH_SPEC, MOVIE_MATCH_SPEC, validateSpec } from './match-spec.ts'
import type { SpecMatchResult, SpecLeft, SpecRight } from './match-spec.ts'
import { matchByEvidenceResult } from './match-engine/adapt.ts'
import { fingerprintsFromLeft, matchBySeason, resolveFolderSeasons, type FolderGroup, type SeasonFingerprint } from './season-resolve.ts'
import type { InvokeLlm } from './match-generate.ts'
import type { NetdiskFolderCapability } from './folder-capability.ts'

/** AList driver → netdisk.folder/play 的 dispatch 键前缀。仅这里做 driver→网盘 映射，
 *  NetdiskService 逻辑与 Provider 都不含网盘字样。加百度=加一行。 */
const NETDISK_DRIVER_BACKEND: Record<string, string> = { Quark: 'quark' }

/** 左侧清单读取——bootstrap 注入（按 left.kind 分派：订阅流走 ItemStore，tmdb 走权威分集索引） */
export interface LeftEntry {
  leftKey: string
  title: string
  durationS?: number
  /**
   * 源站这一集要不要钱。**三态，每一态是一件不同的事**（`undefined` 不是"false 的省略写法"）：
   *  · `true`      要钱 = 源站自己放不出音频 = **网盘那份是唯一可播来源**。
   *  · `false`     显式免费 = 权威清单知道源站自己放得出这一集（订阅流那支永远知道，读得出就是 false）。
   *  · `undefined` **paid 这个概念不在场**——tmdb 影视绑定：源站本来就不播，网盘是唯一来源。
   *    它与 `false` 差得最远，绝不能合并：`false` 说"另有可播来源"，`undefined` 说"不知道有没有"。
   *
   * **谁都不读它做判断**——认集这条路上没有任何判定层读（读了就是第二个判定脑），归档器的
   * **处置**那一侧也不读。「网盘这份要不要留」问的是下面的 `needsSupply`，不是它。
   * 它活着只为**解释原因**：账本、证据卡、权威清单统计里那句「源站要钱」。
   */
  paid?: boolean
  /**
   * **这一集要不要人往网盘供货**——归档器处置层唯一读的那一位。
   *  · `true`  源站自己放不出 → 网盘那份可能是唯一可播来源，**不许自动删**。
   *  · `false` 源站自己就能放 → 网盘那份是冗余，可以删（付费货架契约，见 `docs/MATCHING.md`）。
   *  · 缺席   → 按 `true` 办（保守档：删不可逆、留着只占空间）。tmdb 影视那支就走这里。
   *
   * **它不是 `paid` 的取反**，这是它存在的全部理由：`paid` 答的是「要不要钱」，而这里问的是
   * 「源站自己放不放得出」。两者在「没给地址、也不要钱」的 app 独占集上分道扬镳——那种集
   * `paid` 读不出任何东西，而网盘那份是它唯一的来源。判据见 `left-from-stream.ts` 的
   * `hasPlayableMedia`：看这一集自己带没带一个可播地址。
   *
   * 填它的是权威清单那一支（`authorityFromStream`）。tmdb 分集索引不填（网盘本就是唯一来源）。
   */
  needsSupply?: boolean
  /** 分集剧照 URL（仅 tmdb 剧集索引带；绑定对齐用不到，详情页分集卡拿它当 16:9 缩略图）。 */
  still?: string
  /** TMDb 该集播出日期（仅 tmdb 剧集索引带；绑定对齐用不到，详情页拿它判「未播出」）。 */
  airDate?: string
}
/**
 * 吃整个 `left` 而不是 streamId：左侧是**清单从哪来**，streamId 只是其中一种来源的参数。
 * 异步是因为有的来源要出网（tmdb 分集索引）；订阅流那支同步返回、包一层 Promise 即可。
 */
export type ListLeft = (left: MappingLeft) => Promise<LeftEntry[]>

/** 库存默认谱按左侧种类选：tmdb 电影 → solo；其余（tmdb 剧集 / 订阅流 / 歌单）→ 通用默认。 */
function defaultSpecFor(left: MappingLeft): MatchSpec {
  return left.kind === 'tmdb' && left.media === 'movie' ? MOVIE_MATCH_SPEC : DEFAULT_MATCH_SPEC
}

/**
 * 绑定实际生效的谱。**自定义谱**（有 `generatedBy`，AI/用户产的）冻结尊重；**库存默认**（bind 时存的
 * 那份，无 `generatedBy`）不含用户意图，是「当时默认」的快照——随默认演进**重解析到当前默认**。
 * 否则默认修好了、存量绑定还用着冻结的旧谱（幸运女神 0/7 就是这么来的：绑定里冻着 season-episode
 * 之前的两阶段默认）。
 *
 * **导出给归档器用**（`reconcile/service.ts`）：归档器判"这个文件是哪一集"跑的就是这个匹配器，
 * 生效的谱必须与绑定同步是同一份——两份就是两个脑，会在同一批文件上给出两种说法。
 *
 * **例外一位：`needsSupply` 跨过这次重解析带过来。** 上面那条"库存默认不含用户意图"对**判据**
 * 成立，对它不成立——它就是用户意图本身（人工覆盖"这条绑定的集要不要供货"）。而绑定绝大多数
 * 用的正是库存默认，不带过来的表现是：开关点了、下一轮 sync/整理照旧按算出来的走，**静默失效**。
 */
export function resolveSpec(set: { left: MappingLeft; matchSpec?: MatchSpec }): MatchSpec {
  if (set.matchSpec?.generatedBy) return set.matchSpec
  const base = defaultSpecFor(set.left)
  return set.matchSpec?.needsSupply != null ? { ...base, needsSupply: set.matchSpec.needsSupply } : base
}

/**
 * 一部作品挂多条绑定时的作品级选路：优先返回**未标 broken** 的那条（残留条只咬 item 入口，(b) 会把
 * 目录已删的绑定标 broken）。全坏时仍返回第一条——「这部片子绑没绑」的事实不能因为绑定坏了就丢，
 * 面板照样要显示绑定 + 其 broken 健康态。空集合返回 undefined（= 没绑）。
 */
function preferHealthy(matches: MappingSet[]): MappingSet | undefined {
  return matches.find((s) => !s.broken) ?? matches[0]
}

export interface NetdiskDeps {
  store: MappingStore
  alist: AlistClient
  listLeft: ListLeft
  invokeLlm: InvokeLlm
  log?: (msg: string) => void
  /** 注入便于测试；默认 setTimeout。waitDirReady 用它退避重试。 */
  sleep?: (ms: number) => Promise<void>
  /** 「跳转网盘」解析能力（netdisk.folder dispatch）。未接则只能回落 AList 链接。
   *  夸克专属逻辑住在 netdisk-folder-quark Provider 的成员 source 里，不在这里。 */
  folder?: NetdiskFolderCapability
  /**
   * 网盘文件 → 时长（秒）的批量探测（生产装配走 `reconcile/duration.ts` 的 `durationsFor`：
   * ffprobe 只读文件头 + `size:path` 缓存 + 预算）。**时长档的进料口**——匹配器是纯函数，
   * 自己绝不做 I/O。未注入 = 右侧无时长 = 时长档整档无信号 = 逐字退回文件名规则链。
   * 探不到的文件不会出现在返回的 Map 里（未知 ≠ 0）。
   */
  durations?: (files: { path: string; size: number }[]) => Promise<Map<string, number>>
}

/** 转存后等 AList 看到新目录：poll 次数与间隔（最多 ~7.5s，覆盖夸克→AList 的 index 延迟）。 */
const DIR_READY_TRIES = 6
const DIR_READY_INTERVAL_MS = 1500

/** 左侧清单备忘的存活时间。够覆盖一整轮"改规则"会话（residue → preview ×N → apply），
 *  又短到新出的季/集会自己进来。 */
const LEFT_MEMO_TTL_MS = 10 * 60_000

/**
 * 给一次取数标上**是哪一端**，并对瞬时失败重试一次。
 *
 * 存在的理由是一句真实的错误原文：`Error: fetch failed`（活体 2026-09-02）。它既没说挂的是
 * tmdb 还是网盘，也没重试——拿到它的人（这里往往是对话里的模型）只能猜，然后去调一个别的
 * 工具试连通性。两端要用户做的事完全不同：一端是墙外抖动等一下就好，另一端是 AList 没起来。
 */
async function attributed<T>(side: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (first) {
    try {
      return await run()
    } catch (e) {
      throw new Error(`取${side}失败（已重试一次）：${(e as Error).message || String(first)}`)
    }
  }
}

export class NetdiskService {
  constructor(private readonly deps: NetdiskDeps) {}

  /** 正在自愈同步中的绑定 id——去重，避免用户对着死链狂点播放触发一堆重复重列（见 resyncAfterGone）。 */
  private readonly healing = new Set<string>()

  /** 左侧清单的短命备忘（键 = 左侧标识本身，见 `leftOf`）。进程内，不落盘。 */
  private readonly leftMemo = new Map<string, { at: number; entries: LeftEntry[] }>()

  // ---- 播放路径 ----
  lookup(leftKey: string): PlayableHit | undefined {
    return this.deps.store.findByLeftKey(leftKey)
  }

  /**
   * 一个 leftKey 的**全部**可播命中（跨绑定），健康的排前、已标 broken 的排后（同健康态按 lastSyncAt
   * 新→旧）。(c) item 入口回退用：一部作品挂多条绑定、残留条目录已删时，`lookup`（findByLeftKey 的单条
   * 赢家，按 lastSyncAt 取）可能正好返回坏的那条；item 解析撞 object-not-found 后按本表换同 leftKey 的
   * 下一条重试。
   *
   * 为什么按 leftKey 而非作品 ref：item 解析路径手里只有 leftKey（handle → netdiskKeyFor），这本就是
   * 现有关联键（findByLeftKey / 播放索引都以它为键）。两条绑定同时有同一个**可播** leftKey，按构造就是
   * 同作品的同一集（tmdb 键 `tmdb:id:SxxExx` 权威带坐标；订阅流 `item:<id>` 就是同一条 item）——比作品
   * ref 更准：作品 ref 会把「同作品但没配到这一集」的绑定也算进来，对本次解析毫无用处。
   */
  lookupAll(leftKey: string): PlayableHit[] {
    const rows: { hit: PlayableHit; broken: boolean; lastSyncAt: string }[] = []
    for (const set of this.deps.store.list()) {
      const e = set.entries.find(
        (x) => x.leftKey === leftKey && x.rightFile && (x.status === 'auto' || x.status === 'confirmed'),
      )
      if (!e) continue
      rows.push({
        hit: {
          setId: set.id,
          dirPath: set.right.path,
          rightFile: e.rightFile!,
          lastSyncAt: set.lastSyncAt,
        },
        broken: !!set.broken,
        lastSyncAt: set.lastSyncAt ?? '',
      })
    }
    return rows
      .sort((a, b) => (a.broken === b.broken ? b.lastSyncAt.localeCompare(a.lastSyncAt) : a.broken ? 1 : -1))
      .map((r) => r.hit)
  }

  /** 一个网盘文件绝对路径 → 它所属的绑定（`right.path` 是该路径的目录前缀）。转码播放路由(netdisk-play)
   *  只握着文件 path、不握 setId，靠这个反查出绑定来触发自愈。多绑定按最长前缀取最具体的那个。 */
  bindingForPath(path: string): MappingSet | undefined {
    return this.deps.store
      .list()
      .filter((s) => path === s.right.path || path.startsWith(s.right.path.replace(/\/$/, '') + '/'))
      .sort((a, b) => b.right.path.length - a.right.path.length)[0]
  }

  /**
   * 播放时判定文件已不在（AList `object not found`）后的后台自愈：递归重列绑定目录跑一次 `sync`。
   * 这一条路同时处理两种情况（见与用户确认的语义）——**目录内改名/移动**会被重新配上（文件还在树里），
   * **真删除/移出目录**降级成 unmatched（卡片从可播变灰卡「找资源」）。fire-and-forget：不阻塞、不改
   * 播放响应；同一绑定在飞的自愈去重，错误只记日志（自愈是尽力而为，失败下次点播再触发）。
   */
  resyncAfterGone(setId: string): void {
    if (this.healing.has(setId)) return
    const set = this.deps.store.get(setId)
    if (!set) return
    this.healing.add(setId)
    void this.sync(set)
      .catch((e) => this.deps.log?.(`[self-heal] 绑定 ${setId} 自愈同步失败: ${(e as Error).message}`))
      .finally(() => this.healing.delete(setId))
  }
  /**
   * 某个 TMDb 作品的绑定。影视二级页据此显示「绑没绑、哪几集配上了」——一个作品级绑定就是
   * 「这部片子 ↔ 这个网盘目录」，所以按 (id, media) 唯一。
   */
  bindingForTmdb(id: string, media: 'movie' | 'tv'): MappingSet | undefined {
    return preferHealthy(
      this.deps.store.list().filter((s) => s.left.kind === 'tmdb' && s.left.id === id && s.left.media === media),
    )
  }

  /**
   * 「跳转网盘」的目标 URL —— 直接落到网盘自己的 web UI 那个文件夹（夸克用 fid 定位，不是路径）。
   * 只对**夸克挂载**解析（按 AList 挂载点的 driver 判）；非夸克 / 解析不到 → null，调用方回落 AList 链接。
   * fid 解析一次缓存进 `set.right.browseFid`，之后不再问夸克 API（目录改名/移动后失效则重求）。
   */
  async browseUrl(set: MappingSet): Promise<string | null> {
    if (set.right.browseUrl) return set.right.browseUrl // 缓存的网页 URL（backend 无关）
    if (!this.deps.folder) return null
    const path = set.right.path
    const mount = '/' + (path.split('/')[1] ?? '')
    let driver: string | undefined
    try {
      driver = (await this.deps.alist.listStorages()).find((s) => s.mount_path === mount)?.driver
    } catch (e) { this.deps.log?.(`[browse] listStorages 抛错 → 回落 AList: ${(e as Error).message}`); return null }
    const backend = NETDISK_DRIVER_BACKEND[driver ?? ''] // driver → netdisk.folder dispatch 键前缀
    if (!backend || !this.deps.folder.supports(backend)) {
      this.deps.log?.(`[browse] ${mount} driver=${JSON.stringify(driver)} 无跳转 Provider → 回落 AList`)
      return null
    }
    const segments = path.slice(mount.length + 1).split('/').filter(Boolean)
    const folder = await this.deps.folder.folderUrl(backend, segments) // dispatch 到 netdisk-folder-<网盘>
    if (!folder) return null
    set.right.browseUrl = folder.url
    this.deps.store.save(set) // 缓存 URL，下次直接用
    return folder.url
  }

  /** Whether a stream is constrained to AList-backed playback, regardless of per-item matches. */
  hasBindingForStream(streamId: string): boolean {
    return !!this.bindingForStream(streamId)
  }
  /**
   * 某关注流的绑定（按 streamId 唯一）。详情页据此给**非 TMDb 作品**（综艺 / canonical 验不出坐标的片子）
   * 显示「绑没绑、配上几集、绑在哪个目录」——`bindingForTmdb` 只认 TMDb 坐标，够不着这类流。
   */
  bindingForStream(streamId: string): MappingSet | undefined {
    return preferHealthy(
      this.deps.store.list().filter((set) => set.left.kind === 'stream' && set.left.streamId === streamId),
    )
  }
  /**
   * 解析失败上报：**只有** AList「目录/文件已不在」（object-not-found，见 isObjectNotFound）才把整条
   * 绑定标 broken；超时 / CDN 抖 / cookie 失效那类临时 500 一律不标（否则一次网络抖动就误把好绑定判死）。
   * 所有 resolve 路径（播放 resolveUrl、转写 transcribe/source|media）统一经它上报，标记只有这一个源。
   */
  noteResolveError(setId: string, error: unknown): void {
    const message = String((error as Error)?.message ?? error)
    if (!isObjectNotFound(message)) return
    const set = this.deps.store.get(setId)
    if (!set) return
    set.broken = { at: new Date().toISOString(), message }
    this.deps.store.save(set)
  }

  /** 解析成功 → 清除 broken 标记（目录恢复 / 换绑修好）。无标记则零写盘，不拖慢播放热路径。 */
  noteResolveOk(setId: string): void {
    const set = this.deps.store.get(setId)
    if (!set?.broken) return
    delete set.broken
    this.deps.store.save(set)
  }

  /** 命中 → AList 直链（浏览器可达：AList 内部 host 的代理链改走网关同源路由，见 toGatewayAlistUrl）；
   *  抛错由调用方接（播放路由静默回落 + markError 留痕）。绑定级健康态在这里置/清（object-not-found
   *  标 broken、成功清）——这是播放侧 resolve 的唯一 funnel。 */
  async resolveUrl(hit: PlayableHit): Promise<string> {
    try {
      const url = toGatewayAlistUrl(await this.deps.alist.rawUrl(`${hit.dirPath}/${hit.rightFile}`))
      this.noteResolveOk(hit.setId)
      return url
    } catch (e) {
      this.noteResolveError(hit.setId, e)
      throw e
    }
  }
  /** AList 文件路径 → 网盘 driver 侧文件 id（夸克即 fid）。转码播放解析(netdisk.play)按 fid 调。
   *  通用 AList 操作、非某网盘专属；夸克专属逻辑住在 netdisk-play-quark Provider 的成员 source 里。 */
  async fileId(path: string): Promise<string> {
    return this.deps.alist.fileId(path)
  }
  /** 路径 → 原始 AList 直链（网关同源）。转码播放代理的回落（无转码时仍能有画播放）。 */
  async rawGatewayUrl(path: string): Promise<string> {
    return toGatewayAlistUrl(await this.deps.alist.rawUrl(path))
  }
  /** 路径 → 文件字节数。抽音轨判「从原盘抽还是从网盘转码档抽」比的就是容器大小
   *  （音视频交织，抽音要流过整个容器），见 src/media/audio-route.ts。 */
  async fileSize(path: string): Promise<number> {
    return this.deps.alist.fileSize(path)
  }
  /** 目录 → 文件清单（相对路径 + 大小，浅递归带上 Subs/ 之类子目录）。外挂字幕发现
   *  （netdisk-subtitle-list → matchSiblingSubtitles）用；走 AList 缓存视图，不 refresh。 */
  async listDir(dirPath: string): Promise<{ name: string; size: number }[]> {
    return (await this.deps.alist.listDirRecursive(dirPath, 2)).map((f) => ({ name: f.name, size: f.size }))
  }
  /** 路径 → 原始 AList 直链（不改写，服务器侧直连用）。ffmpeg 抽字幕/音轨（src/media/extract.ts）
   *  拿这个当输入 URL——不像 rawGatewayUrl，不需要经浏览器同源网关绕一圈，这个进程自己能直连 AList。 */
  async rawUrl(path: string): Promise<string> {
    return this.deps.alist.rawUrl(path)
  }
  /** 直链失败留痕（entry.lastError），静默降级不打断播放 */
  markError(hit: PlayableHit, message: string): void {
    const set = this.deps.store.get(hit.setId)
    if (!set) return
    const e = set.entries.find((x) => x.rightFile === hit.rightFile)
    if (!e) return
    e.lastError = { at: new Date().toISOString(), message }
    this.deps.store.save(set)
  }

  /**
   * 等 AList 看到目录里的文件再返回。转存通过网盘自己的 API 直接建目录（不经 AList），AList
   * 缓存视图有几秒延迟——立即 sync 会 `object not found` 或列到空，于是「转存了却没配上」。
   * poll（refresh）到有非目录文件为止，或超时返回 false（调用方照常 sync，只是这次可能空）。
   * 对已就绪的目录第一次 poll 即返回，无额外延迟。
   */
  async waitDirReady(dirPath: string): Promise<boolean> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    // 关键（活体实测）：直接列刚转存的子目录一直 `object not found`；必须先 refresh **父目录**，
    // AList 才建立到子目录的映射（即便父列表当下仍显示空），之后列子目录才拉得到。
    const parent = dirPath.replace(/\/[^/]+$/, '') || '/'
    for (let i = 0; i < DIR_READY_TRIES; i++) {
      try {
        await this.deps.alist.listDir(parent, true)
        const files = await this.deps.alist.listDirRecursive(dirPath, 5, true)
        if (files.some((f) => !f.isDir)) return true
      } catch {
        // object not found = AList 还没建立该路径映射 → 继续等
      }
      if (i < DIR_READY_TRIES - 1) await sleep(DIR_READY_INTERVAL_MS)
    }
    return false
  }

  // ---- 绑定生命周期 ----
  /** 建绑定 + 首次全量同步。种默认匹配规格 → 走确定性 spec 路径（运行时零 LLM）。 */
  async bind(input: { left: MappingLeft; dirPath: string; autoSync?: boolean }): Promise<MappingSet> {
    // 「一个 TMDb 作品最多一条绑定」——这条不变量 bindingForTmdb 的注释早就声明了（按 (id, media)
    // 唯一），但过去只有调用方在查重，bind 自己照单全收。两个转存请求并发时双双读到「没绑过」，
    // 各建一条：真实事故是《进击的巨人》的 map_18d863 / map_9fe142，boundAt 相差 0.3 秒。
    // 把约束下沉到这里——唯一性是数据不变量，不该指望每个调用方各自守住。
    if (input.left.kind === 'tmdb') {
      const existing = this.bindingForTmdb(input.left.id, input.left.media)
      if (existing) {
        return existing.right.path === input.dirPath
          ? await this.sync(existing)                          // 同目录 = 补集转存，重算配对
          : await this.rebind(existing.id, input.dirPath)      // 换了目录 = 换版本，指纹认亲继承 corrected
      }
    }
    const set: MappingSet = {
      id: newMappingId(),
      left: input.left,
      right: { kind: 'alist-dir', path: input.dirPath, boundAt: new Date().toISOString() },
      rightHistory: [],
      autoSync: input.autoSync ?? true,
      entries: [],
      // 电影：唯一视频文件即认领；其余（剧集/歌单）走季集/集号+标题。左侧的种类决定默认谱。
      // 存的是库存默认（无 generatedBy）——sync 里 resolveSpec 会随默认演进重解析，不冻结。
      matchSpec: defaultSpecFor(input.left),
      ...(input.left.kind === 'tmdb' && input.left.media === 'tv' ? { follow: { enabled: true, dryRuns: 0 } } : {}),
    }
    // 先同步落库占位，再去 await sync——把并发窗口关掉。save 是同步的（writeFileSync），
    // 从上面的查重到这一行没有 await，第二个并发请求的 bindingForTmdb 必然看得见这一条。
    this.deps.store.save(set)
    await this.sync(set)
    return set
  }

  /** 重绑：旧目录进 rightHistory；新目录先指纹认亲（confirmed 继承），剩余走常规漏斗 */
  async rebind(setId: string, newDirPath: string): Promise<MappingSet> {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    set.rightHistory.push({ path: set.right.path, unboundAt: new Date().toISOString() })
    set.right = { kind: 'alist-dir', path: newDirPath, boundAt: new Date().toISOString() }
    const inherited = matchByFingerprint(set.entries, await this.deps.alist.listDir(newDirPath, true))
    // 非继承项清空重配；继承项保 confirmed + 指纹
    set.entries = set.entries.map((e) => {
      const nf = inherited.get(e.leftKey)
      return nf
        ? { ...e, rightFile: nf, lastError: undefined }
        : { leftKey: e.leftKey, leftTitle: e.leftTitle, rightFile: null, status: 'unmatched' as const }
    })
    await this.sync(set)
    return set
  }

  /**
   * 同步：先给左侧新条目补 unmatched 壳，再跑确定性匹配器（证据图引擎，运行时零 LLM，硬约束）。
   * 生效的谱由 `resolveSpec` 定（自定义谱冻结、库存默认随默认重解析）。每次全量重算并存 `set.coverage`（源缺档 /
   * 文件孤儿两向可见）；用户已 confirmed/rejected/corrected 的条目被钉住、不被覆盖。
   */
  async sync(set: MappingSet): Promise<MappingSet> {
    // 走同一个备忘（见 `leftOf`）：会变的那一半是网盘，它在下面照旧每次现列；
    // 左侧走同一条口子，也顺带把"是哪一端挂了"标上。
    const left = await this.leftOf(set.left)
    // 左侧收缩清理：清单里已不存在的左项（如清单改成"只收费集"后被剔除的免费集）删除其条目，
    // 只保留人工订正过的样本（corrected，含旧数据的 confirmed/rejected）——那是跨清单变化都要守住
    // 的决定，也是重训规则的训练数据。否则旧的 auto 配对会残留，让免费集仍指向网盘。
    const leftKeys = new Set(left.map((l) => l.leftKey))
    set.entries = set.entries.filter(
      (e) => leftKeys.has(e.leftKey) || !!e.corrected || e.status === 'confirmed' || e.status === 'rejected',
    )
    const byKey = new Map(set.entries.map((e) => [e.leftKey, e]))
    // 左侧全集补位：新条目建 unmatched 壳；已有条目跟着左侧刷新 airDate（TMDb 会先列出未定档的集，
    // 日期后补——只在建壳那一刻写一次就永远是空的）。
    for (const l of left) {
      const existing = byKey.get(l.leftKey)
      if (!existing) {
        const e: MappingEntry = { leftKey: l.leftKey, leftTitle: l.title, rightFile: null, status: 'unmatched', ...(l.airDate ? { airDate: l.airDate } : {}) }
        set.entries.push(e)
        byKey.set(l.leftKey, e)
      } else if (l.airDate) {
        existing.airDate = l.airDate
      }
    }

    try {
      await this.syncBySpec(set, left, byKey)
    } catch (e) {
      // 目录整个没了（用户删了 / 被网盘清了）是**预期内的状态，不是异常**：标 broken 后正常返回。
      //
      // 此前它一路抛到端点：`POST /mappings/:id/sync` 回 500，更要命的是 6 小时一轮的
      // `netdisk-autosync` 任务「任一 set 失败 → 整个任务 throw」，一条目录被删的绑定就能让
      // 自动同步永久红着。而 broken 这个概念本就存在（preferHealthy 绕开它、面板照样显示
      // 「绑过、现在坏了」），只是过去仅由播放/转写的 resolve 失败触发——没人去点播就永远不标。
      // sync 每轮都要列目录，是最早发现的地方。
      //
      // **只认 object-not-found**：超时 / CDN 抖 / cookie 失效那类临时错误照常抛（同
      // noteResolveError 的判据），否则一次网络抖动就把好绑定判死。
      const message = String((e as Error)?.message ?? e)
      if (!isObjectNotFound(message)) throw e
      // entries 一律不动——corrected 是跨目录变化都要守住的决定，目录回来时 rebind 靠指纹认亲继承。
      set.broken = { at: new Date().toISOString(), message }
      set.lastSyncAt = new Date().toISOString()
      this.deps.store.save(set)
      return set
    }

    // 走到这里 = 目录成功列出（syncBySpec 的 listDirRecursive 没抛 object-not-found）→ 目录还在，
    // 清除坏绑定标记。resyncAfterGone 自愈成功、或换绑/手动 sync 修好后，broken 自然消。
    if (set.broken) delete set.broken
    set.lastSyncAt = new Date().toISOString()
    this.deps.store.save(set)
    return set
  }

  /**
   * 对**不在货架上**的一批文件跑一次认集——追更拿它判「这条分享能补几集」。同一套谱、同一个脑
   * （`matchWithSeasonAwareness`），差别只有两条：不落库；不探时长（文件不在 AList 上，探不到；
   * tmdb 左侧本来也没有时长，时长档整档无信号，走文件名链）。
   */
  async matchExternalFiles(set: MappingSet, files: { name: string; size: number }[]): Promise<SpecMatchResult> {
    // 只对 TMDb 左侧开放：订阅流左侧带时长，`withRightDurations` 会拿 `set.right.path` 去拼这些
    // **不在货架上**的文件的路径探 ffprobe——打的全是不存在的路径。tmdb 左侧没有时长，永远走不到那一行。
    if (set.left.kind !== 'tmdb') throw new Error('matchExternalFiles 只支持 TMDb 左侧的绑定（订阅流左侧会对不在货架上的文件探时长）')
    const left = await this.leftOf(set.left)
    // 在一份浅拷贝上跑：多季分区会把「文件夹名 → 季」的 LLM 判决写进 set.llmSeasonCache，而这里的
    // 文件夹是别人分享里的，名字不该进这条绑定的持久缓存（调用方随后的 store.save 会把它落盘）。
    const scratch: MappingSet = { ...set, llmSeasonCache: { ...(set.llmSeasonCache ?? {}) } }
    return this.matchWithSeasonAwareness(scratch, resolveSpec(set), left, files)
  }

  /**
   * 季归属**这一段单独开口**，给归档器用（Task 8）。归档器是同步的，够不着 `matchBySeason`
   * 那个异步壳，却必须走同一条分区路——所以把「问出文件夹属于哪一季」这一半在这里交出去，
   * 它拿到答案自己去调 `matchBySeasonResolved`。
   *
   * **缓存必须与同步是同一份**（`set.llmSeasonCache`，键是叶子目录名）：分家的话两边各问一次
   * LLM、答案还可能不一样，那就又是两个脑。所以这里也照同步的形状把缓存写回绑定并落盘。
   *
   * `groups` 的键由调用方给（相对哪一级由它自己定），本方法只透传——缓存命不命中完全取决于
   * 调用方用的键与同步一致，这是它的责任，不是这里能替它保证的。
   *
   * **只在缓存真的变了才落盘**：归档器每轮预览都调它一次，缓存全命中时写一次盘纯属白写
   * （这口子的意义是"与同步共用同一份缓存"，不是"每次预览都改一次绑定"）。
   */
  async resolveSeasons(setId: string, groups: FolderGroup[], fingerprints: SeasonFingerprint[]): Promise<Map<string, number | null>> {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const before = set.llmSeasonCache ?? {}
    const llmSeasonCache = new Map(Object.entries(before))
    const out = await resolveFolderSeasons(groups, fingerprints, { invokeLlm: this.deps.invokeLlm, llmSeasonCache })
    // 只增不改（LLM 那一层命中即缓存），所以"条数变了"就等价于"内容变了"；仍逐项比一次，
    // 免得将来有人给缓存加了改写语义之后这里静默地不再落盘。
    const changed = llmSeasonCache.size !== Object.keys(before).length
      || [...llmSeasonCache].some(([k, v]) => !(k in before) || before[k] !== v)
    if (!changed) return out
    set.llmSeasonCache = Object.fromEntries(llmSeasonCache)
    this.deps.store.save(set)
    return out
  }

  /**
   * 统一匹配入口：多季 tv 绑定(季数 > 1)先做季归属 + 分区匹配(消跨季撞桶,见 season-resolve.ts);
   * 其余(电影/单季 tv/订阅流)走单次匹配的快路径,不受影响。previewSpec 用它同时评估
   * base 和 candidate 两份谱,故 spec 是显式参数、不在方法内部推导。
   *
   * 匹配脑是**证据图引擎**（`match-engine/`：先收全证据、再裁决，spec 2026-08-02）。
   * 交出去的仍是 `SpecMatchResult` —— 换引擎与换接口形状是两件事，一次只做一件。
   */
  private async matchWithSeasonAwareness(
    set: MappingSet,
    spec: MatchSpec,
    left: LeftEntry[],
    files: { name: string; size: number }[],
  ): Promise<SpecMatchResult> {
    // durationS/paid 必须带过来：前者是时长档的主锚；后者**目前没有判定层读**，带着只为让
    // 「节目单 → 匹配层」这一步不丢信息、并进账本（别照旧注释推断它是某道保护的依据，见 LeftEntry.paid）。
    // 这一行过去只投影 leftKey/title，把两者都丢了（spec 2026-07-30 时长主锚）。
    // 人工订正钉死的配对提到匹配层预置——`right[].name` 这一侧是**相对子路径**，`entry.rightFile`
    // 存的正是同一形状，直接给。（归档器那侧的右侧是绝对路径，得自己拼，见 reconcile/service.ts。）
    const pinned = new Map(set.entries.filter((e) => e.corrected && e.rightFile).map((e) => [e.leftKey, e.rightFile!]))
    const specLeft: SpecLeft[] = left.map((l) => ({
      leftKey: l.leftKey,
      title: l.title,
      ...(l.durationS != null ? { durationS: l.durationS } : {}),
      // 三态原样带过：`false` 折成缺席就等于把「源站自己能播」说成「不知道」（见 LeftEntry.paid）。
      ...(l.paid != null ? { paid: l.paid } : {}),
      ...(pinned.has(l.leftKey) ? { pinnedRight: pinned.get(l.leftKey)! } : {}),
    }))
    const timedFiles = await this.withRightDurations(set, specLeft, files)
    if (set.left.kind === 'tmdb' && set.left.media === 'tv') {
      const fingerprints = fingerprintsFromLeft(left)
      if (fingerprints.length > 1) {
        // llmSeasonCache 跨 sync() 复用——文件夹没改名就不用重新问模型（分集数量增减不影响
        // 这份缓存,季归属只认文件夹名）。matchBySeason 内部按引用改这个 Map,调完写回 set。
        // **这条路自己从不 store.save**：真正落盘的是 sync() 那一步,以及归档器共用的
        // `resolveSeasons`（它只在缓存真的变了才写）。residue()/previewSpec() 也走这里,
        // 写回只在内存里,不会意外持久化预览阶段的结果。
        const llmSeasonCache = new Map(Object.entries(set.llmSeasonCache ?? {}))
        const result = await matchBySeason(spec, specLeft, timedFiles, fingerprints, { invokeLlm: this.deps.invokeLlm, llmSeasonCache })
        set.llmSeasonCache = Object.fromEntries(llmSeasonCache)
        return result
      }
    }
    return matchByEvidenceResult(spec, specLeft, timedFiles)
  }

  /**
   * 给右侧文件补时长（时长档的进料口）。**只在左侧真有时长时才探**——探了也没人比就是纯浪费，
   * TMDb 绑定（分集索引不给时长）因此一次探测都不发。探测本身失败一律降级成"没时长"：
   * 时长是增强不是替换，绝不该因为探不到就掀翻整次同步。
   */
  private async withRightDurations(
    set: MappingSet,
    left: SpecLeft[],
    files: { name: string; size: number }[],
  ): Promise<SpecRight[]> {
    if (!this.deps.durations || !left.some((l) => l.durationS != null)) return files
    const dir = set.right.path.replace(/\/$/, '')
    try {
      const byPath = await this.deps.durations(files.map((f) => ({ path: `${dir}/${f.name}`, size: f.size })))
      return files.map((f) => {
        const durationS = byPath.get(`${dir}/${f.name}`)
        return durationS == null ? f : { ...f, durationS }
      })
    } catch (e) {
      this.deps.log?.(`[netdisk] 右侧时长探测整批失败，本轮退回文件名规则链: ${(e as Error).message}`)
      return files
    }
  }

  /**
   * 确定性路径：递归列右侧全部文件，跑 spec 得配对 + 两向覆盖率。coverage 是“规格视角”
   * 的全量结果（含 confirmed 左项一并计入 total），用于判断源全不全 / 规则要不要重训。
   * 落 entries 时用户裁决优先：confirmed/rejected 原样保留，其 confirmed 文件也从池里让开。
   */
  private async syncBySpec(set: MappingSet, left: LeftEntry[], byKey: Map<string, MappingEntry>): Promise<void> {
    // refresh:true — 同步就是要看网盘现状（改名/增删），不能吃 AList 的目录缓存，否则「立即同步」白同步。
    const files = await this.deps.alist.listDirRecursive(set.right.path, 5, true)
    const sizeOf = new Map(files.map((f) => [f.name, f.size]))
    const leftMeta = new Map(left.map((l) => [l.leftKey, l]))
    const { assignments, coverage } = await this.matchWithSeasonAwareness(
      set, resolveSpec(set), left, files.map((f) => ({ name: f.name, size: f.size })),
    )
    set.coverage = coverage
    // 用户 confirmed 的文件预留：不许 spec 把它配给别的左项
    const confirmedFiles = new Set(
      set.entries.filter((e) => e.status === 'confirmed' && e.rightFile).map((e) => e.rightFile!),
    )
    for (const l of left) {
      const e = byKey.get(l.leftKey)!
      // 人工订正优先，不重算。**真正的保证在匹配层**（`pinnedRight` 预置：跑任何 stage 之前占位，
      // 被它占住的文件也不许配给别的集）；这里这一条只多守住 status/confidence/fingerprint 那几个
      // 字段不被覆盖。`confirmed`/`rejected` 是另外两种人工态，没有 pin 通道，仍靠这一条。
      if (e.corrected || e.status === 'confirmed' || e.status === 'rejected') continue
      const a = assignments.get(l.leftKey)
      if (a && !confirmedFiles.has(a.rightFile)) {
        e.rightFile = a.rightFile
        e.confidence = a.confidence
        e.status = a.status
        e.fingerprint = { size: sizeOf.get(a.rightFile) ?? 0, duration: leftMeta.get(l.leftKey)?.durationS }
        e.lastError = undefined
      } else {
        e.rightFile = null
        e.confidence = undefined
        e.status = 'unmatched'
        e.fingerprint = undefined
        e.lastError = undefined
      }
    }
  }

  // ---- 规则编辑三原语(surface 无关:App 内置 LLM 与外部 agent 都走这三个)----
  /**
   * 拉一次两侧现状(左清单 + 右递归文件)。residue/previewSpec 与 syncBySpec 同源:
   * refresh:true 看网盘现状,不吃 AList 目录缓存。
   */
  private async loadSides(set: MappingSet): Promise<{ left: LeftEntry[]; files: { name: string; size: number }[] }> {
    const left = await this.leftOf(set.left)
    const files = await attributed('网盘目录', () => this.deps.alist.listDirRecursive(set.right.path, 5, true))
    return { left, files: files.map((f) => ({ name: f.name, size: f.size })) }
  }

  /**
   * 左侧清单（带短命备忘 + 失败重试一次）。
   *
   * **只缓存左侧**：右侧是会变的那一半（用户刚往网盘丢了文件、刚改完名），每次必须现列；
   * 左侧是权威分集表，一次会话里不会变，而 tmdb 那一支是**出网**的（一部五季的剧 2 个请求、
   * 约 1MB）。改一次规则要连着 residue → preview ×N → apply，过去每一步都白付一趟往返，
   * 活体（2026-09-02）8 次调用里撞挂 2 次。
   *
   * TTL 而不是永久：新出的季/集要能自己进来（见 AGENTS.md「装配期取的值 = 冻住的答案」）。
   */
  private async leftOf(left: MappingLeft): Promise<LeftEntry[]> {
    const key = JSON.stringify(left)
    const hit = this.leftMemo.get(key)
    if (hit && Date.now() - hit.at < LEFT_MEMO_TTL_MS) return hit.entries
    const entries = await attributed('清单', () => this.deps.listLeft(left))
    this.leftMemo.set(key, { at: Date.now(), entries })
    return entries
  }

  /**
   * 残差视图:当前规格全量重算 → 没配上的左项 + 孤儿右文件 + 人工订正标签。喂给"谁改规则"都够用。
   * 人工已订正的左项不进 unmatchedLeft(已由人解决),单独走 corrected 当带标签样本,免得让生成器
   * 去"解决"一个已解决的条目。
   */
  async residue(setId: string): Promise<SpecResidue> {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const baseSpec = resolveSpec(set)
    const { left, files } = await this.loadSides(set)
    const { assignments, coverage } = await this.matchWithSeasonAwareness(set, baseSpec, left, files)
    const correctedKeys = new Set(set.entries.filter((e) => e.corrected).map((e) => e.leftKey))
    const unmatchedLeft = left
      .filter((l) => !assignments.has(l.leftKey) && !correctedKeys.has(l.leftKey))
      .map((l) => ({ leftKey: l.leftKey, title: l.title, durationS: l.durationS }))
    const sizeOf = new Map(files.map((f) => [f.name, f.size]))
    const orphanRight = coverage.orphanFiles.map((name) => ({ name, size: sizeOf.get(name) ?? 0 }))
    const corrected = set.entries
      .filter((e) => e.corrected)
      .map((e) => ({ leftKey: e.leftKey, title: e.leftTitle, rightFile: e.rightFile }))
    return { baseSpec, coverage, unmatchedLeft, orphanRight, corrected }
  }

  /**
   * 全量 dry-run 一份候选 spec(先闭集校验),只算不落:前后覆盖 + 会动的行 + 与人工订正的冲突。
   * before/after 都是"规格视角"(与存的 coverage 同口径,不含人工钉住的影响)。changed 只列
   * 非 corrected 左项(corrected 应用时钉住,不会真动),corrected 分歧单列 correctedConflicts。
   */
  async previewSpec(setId: string, candidate: unknown): Promise<SpecPreview> {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const candidateSpec = validateSpec(candidate)
    const { left, files } = await this.loadSides(set)
    const base = await this.matchWithSeasonAwareness(set, resolveSpec(set), left, files)
    const cand = await this.matchWithSeasonAwareness(set, candidateSpec, left, files)
    const correctedByKey = new Map(set.entries.filter((e) => e.corrected).map((e) => [e.leftKey, e.rightFile]))
    const changed: SpecChange[] = []
    const correctedConflicts: SpecConflict[] = []
    for (const l of left) {
      const to = cand.assignments.get(l.leftKey)?.rightFile ?? null
      if (correctedByKey.has(l.leftKey)) {
        const human = correctedByKey.get(l.leftKey) ?? null
        if (to !== human) correctedConflicts.push({ leftKey: l.leftKey, title: l.title, ruleSays: to, human })
        continue // 钉住,不进 changed
      }
      const from = base.assignments.get(l.leftKey)?.rightFile ?? null
      if (from !== to) changed.push({ leftKey: l.leftKey, title: l.title, from, to })
    }
    return { candidateSpec, before: base.coverage, after: cand.coverage, changed, correctedConflicts }
  }

  /** 校验候选闭集 → 落 binding.matchSpec → 重同步(sync 内 corrected/confirmed/rejected 自动钉住)。 */
  async applySpec(setId: string, spec: unknown): Promise<MappingSet> {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const validated = validateSpec(spec)
    // provenance 必须落上：`generatedBy` 有值 ⟺「有意的自定义谱、冻结尊重」，缺席则 resolveSpec 判成
    // 库存默认快照、下次 sync 就绕过它回退默认(0/N 的真凶——手工/外部 agent 递的谱常不自报 provenance)。
    // 能走到 applySpec 本身就意味着有意应用一份谱，故缺省补盖，别让它被当默认丢弃。
    set.matchSpec = validated.generatedBy
      ? validated
      : { ...validated, generatedBy: 'applied', generatedAt: new Date().toISOString() }
    return this.sync(set)
  }

  // ---- 修正 UI 的三个动作 ----
  /**
   * 人工订正一条 entry。语义（确认/拒绝的旧工作流已下线）：改 `rightFile` = 用户断言「这条的正确
   * 文件是 X（或没有）」。落成一条 ground-truth 样本：
   *  - 选了文件 → status `confirmed`（mapping-store 只索引 auto/confirmed 才可播，且被 sync 钉住）；
   *  - 清空（null）→ status `unmatched`，靠 `corrected` 被 sync 钉住，规则不再猜回去；
   *  - `corrected.autoFile` 记**首次**订正前规则给的答案（重复编辑不覆盖，保住规则原始错答）。
   * 仅带 `status`（无 rightFile）的旧式补丁仍支持（向后兼容），不改动 corrected。
   */
  setEntry(setId: string, leftKey: string, patch: { rightFile?: string | null; status?: MappingEntry['status'] }): MappingSet {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const e = set.entries.find((x) => x.leftKey === leftKey)
    if (!e) throw new Error(`条目不存在: ${leftKey}`)
    if (patch.rightFile !== undefined) {
      const autoFile = e.corrected ? e.corrected.autoFile : e.rightFile // 首次订正记规则原答案
      e.rightFile = patch.rightFile
      e.status = patch.rightFile ? 'confirmed' : 'unmatched'
      e.corrected = { at: new Date().toISOString(), autoFile }
      e.lastError = undefined
    } else if (patch.status) {
      e.status = patch.status
      if (e.status === 'rejected' || e.status === 'unmatched') e.rightFile = null
    }
    this.deps.store.save(set)
    return set
  }

  /** 移除临时人工订正，让下一次同步重新按绑定的自动规则匹配。 */
  clearCorrection(setId: string, leftKey: string): MappingSet {
    const set = this.deps.store.get(setId)
    if (!set) throw new Error(`绑定不存在: ${setId}`)
    const e = set.entries.find((x) => x.leftKey === leftKey)
    if (!e) throw new Error(`条目不存在: ${leftKey}`)
    e.rightFile = null
    e.status = 'unmatched'
    e.confidence = undefined
    e.fingerprint = undefined
    e.lastError = undefined
    delete e.corrected
    this.deps.store.save(set)
    return set
  }
}
