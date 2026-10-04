import { randomUUID } from 'node:crypto'
import type { UserStore } from '../store/user-store.ts'
import type { ChannelRecord, StreamRecord, ProviderRecord, SourceBinding } from '../store/types.ts'
import { SYSTEM_CHANNEL_RECORDS } from '../store/types.ts'
import type { StreamBundleV1, EmbeddedRecipePackage } from './bundle-format.ts'
import { resolveRecipeConflict, type RecipeDecision } from './recipe-conflict.ts'
import { embeddedPackageIdentity, embeddedDirNameIssue } from './recipe-embed.ts'
import type { ImportRun, ImportItem } from './import-run-store.ts'
import type { MappingSet } from '../netdisk/types.ts'
import { newMappingId } from '../netdisk/mapping-store.ts'
import { coercePresent } from '../store/present.ts'
import { readSlots } from '../store/slots.ts'
import { isParked } from '../providers/parked.ts'

export interface ImportDeps {
  store: UserStore
  /** 本机已装的代码插件 id 集合（归一后）。 */
  installedPlugins: Set<string>
  /** 本机已装 recipe 包：id → {version?}（T3：当前 facility 单包 version 可缺）。 */
  installedRecipes: Map<string, { version?: string }>
  /** 把内嵌 recipe 包落到 <dataDir>/recipes/<facility>/（Task 12 提供实现）。 */
  installRecipePackage(pkg: EmbeddedRecipePackage): void
  /** 可注入的新 id 生成器（测试可控）。 */
  genId?(base: string): string
  /** 可注入的 run id 生成器（测试可控），缺省 imp-<8hex>。 */
  genRunId?(): string
  /** 网盘对齐 binding 分享（B）：暂存 pending MappingSet。absent → 未接 AList，netdisk binding 跳过。 */
  mappingStore?: { get(id: string): MappingSet | undefined; save(set: MappingSet): void }
  /** 可注入的 MappingSet id 生成器（测试可控），缺省 newMappingId。 */
  genMappingId?(): string
  /**
   * 把 bundle 里的成员 id 解析成本机的**全名**。新 bundle 自带全名（导出端写的），这条只对
   * **旧 bundle 的裸名**起作用。歧义时**抛** `AmbiguousSourceIdError`（`Registry.get` 的第 4 级）
   * —— 本模块接住它落一条 `source-ambiguous` open item，不静默挑一个、也不让整份导入失败。
   * 不给这个 dep = 不解析，成员原样落库（运行时再由 registry 现解析，与命名空间化之前一致）。
   */
  resolveSource?(sourceId: string): string | undefined
}

const SYSTEM_CHANNEL_IDS = new Set(SYSTEM_CHANNEL_RECORDS.map((c) => c.id))

const PARKED_PROVIDER_CHOICES = ['use-imported', 'keep-mine', 'append', 'dismiss']
const SLOT_CONFLICT_CHOICES = ['keep-mine', 'use-imported', 'dismiss']

/** 键序无关的规范化序列化——比较 params(自由 JSON) 时不受本机行/包行的键顺序差异影响。 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
}

/** 两个流是否确系同一个流：members(plugin/source/params，逐位) 完全一致即同源。
 *  同 id 撞车时据此复用本机行，而非 fork 一个空 `-imported` 孪生流（历史迁移残留的成因）。 */
function sameMembers(a: SourceBinding[], b: SourceBinding[]): boolean {
  return a.length === b.length && a.every((m, i) => canon(m) === canon(b[i]))
}

/** §5.1 导入侧：频道 `options.slots` 的 provider id 过 providerIdMap 改写（否则悬空——bug）。
 *  改写后，引用随包 provider 的键此时指向 park-on-import 行，不能直接生效——整键摘到
 *  `candidateSlots`（同形状，id 已 remap），激活对应 Provider 时（见 activate-provider.ts）
 *  再搬回 `slots`。键里任一 id 既不在本包 providerIdMap、又不在本机 store（防御历史包，
 *  导出侧本应净化）→ 整键剥离（回 `dangling`，由调用方落 notice），不落 slots 也不落 candidateSlots。 */
function splitSlots(
  rawSlots: unknown,
  providerIdMap: Map<string, string>,
  store: UserStore,
): { slots: Record<string, string[]>; candidateSlots: Record<string, string[]>; dangling: string[] } {
  const slots: Record<string, string[]> = {}
  const candidateSlots: Record<string, string[]> = {}
  const dangling: string[] = []
  if (!rawSlots || typeof rawSlots !== 'object') return { slots, candidateSlots, dangling }
  for (const [callsiteId, rawIds] of Object.entries(rawSlots as Record<string, unknown>)) {
    if (!Array.isArray(rawIds) || !rawIds.every((x) => typeof x === 'string')) continue
    const ids = rawIds as string[]
    const resolvable = ids.every((id) => providerIdMap.has(id) || !!store.getProvider(id))
    if (!resolvable) { dangling.push(callsiteId); continue } // 悬空引用：既不在包内也不在本机 → 整键剥离
    const rewritten = ids.map((id) => providerIdMap.get(id) ?? id)
    const referencesImported = ids.some((id) => providerIdMap.has(id)) // 命中随包行 → 现处于 parked-on-import
    if (referencesImported) candidateSlots[callsiteId] = rewritten
    else slots[callsiteId] = rewritten
  }
  return { slots, candidateSlots, dangling }
}

/** 槽键内各 provider 的现状投影（label/parked），给 slot-conflict 的 mine/theirs 当上下文。 */
function projectProviders(ids: string[], store: UserStore): { id: string; label: string; parked: boolean }[] {
  return ids.map((id) => {
    const p = store.getProvider(id)
    return { id, label: p?.label ?? id, parked: !!p && isParked(p) }
  })
}

export function importBundle(bundle: StreamBundleV1, deps: ImportDeps): ImportRun {
  const { store } = deps
  const now = new Date().toISOString()
  const genId = deps.genId ?? ((base) => `${base}-imported`)
  const remaps: Record<string, string> = {}

  // ── run 骨架：一次导入 = 一个可寻址资源，遗留事项统一进 items（spec §2）──
  const items: ImportItem[] = []
  let itemSeq = 0
  const pushItem = (item: Omit<ImportItem, 'id' | 'status'>): void => {
    items.push({ id: `itm-${++itemSeq}`, status: 'open', ...item })
  }
  const pushNotice = (reason: string, detail: string, subjectExtra: Record<string, unknown> = {}): void => {
    pushItem({ kind: 'notice', subject: { reason, ...subjectExtra }, choices: ['dismiss'], detail })
  }

  const uniqueId = (base: string, exists: (id: string) => boolean): string => {
    let candidate = genId(base)
    while (exists(candidate)) candidate = `${base}-${randomUUID().slice(0, 6)}`
    return candidate
  }

  // ── 1) recipe 版本合并（先决，落盘或搁置）──
  const recipeDecisions: Record<string, RecipeDecision> = {}
  for (const [id, pkg] of Object.entries(bundle.embedded.recipes)) {
    // C1 防目录穿越：落盘身份（name 或回落 facility）是不可信输入，非法一律记 corrupt + 跳过
    // 这一个包（不崩整个导入——一个坏内嵌包不该掀翻同 bundle 里正常的 provider/channel/stream）。
    const dirIssue = embeddedDirNameIssue(pkg)
    if (dirIssue) {
      pushNotice('corrupt', `内嵌 recipe「${id}」落盘身份非法：${dirIssue}，已跳过`, { dep: id })
      continue
    }
    // 「已装」判定用与落盘同一把尺的 identity（name ?? facility），否则 npm 装的 @scope/xhs
    // 和 bundle 的 facility=xhs 认不出是同一个包 → 重复落盘、重启撞 duplicate sourceId（I-2）。
    const installed = deps.installedRecipes.get(embeddedPackageIdentity(pkg)) ?? null
    const decision = resolveRecipeConflict({ id, version: pkg.version }, installed ? { id, version: installed.version } : null)
    recipeDecisions[id] = decision
    if (decision.action === 'ask') {
      pushNotice('cross-major', `recipe ${id} 跨 major：本机 ${decision.from} → 包内 ${decision.to}，已搁置`, { dep: id, installed: decision.from, incoming: decision.to })
      continue // 跨 major：不装，等用户显式选择
    }
    if (decision.action === 'reuse') continue // 复用已装，不动
    deps.installRecipePackage(pkg) // install / upgrade
  }

  // ── 2) 缺代码插件 / 待补录声明（只声明，不装代码、不碰凭证）──
  for (const req of bundle.requires.plugins) {
    if (!deps.installedPlugins.has(req.id)) {
      pushNotice('missing-plugin', `代码插件 ${req.id} 未安装${req.homepage ? `（${req.homepage}）` : ''}`, { dep: req.id })
    }
  }
  for (const cred of bundle.requires.credentials) {
    pushNotice('pending-credential', `需要 ${cred.domain} 的登录态：${cred.reason}`, { domain: cred.domain })
  }
  for (const rc of bundle.requires.runtimeConfig) {
    pushNotice('pending-runtime-config', `Source ${rc.ref} 需补运行时配置：${rc.fields.join(', ')}`, { ref: rc.ref, fields: rc.fields })
  }

  // ── 3) 配置行 remap（streams / providers），system channel 复用 ──
  // M1：remap 目标不仅要避开本机已有 id，还要避开**本包内其它行**的 id（含不撞车、保留原 id 的那些）
  // 与已分配的目标 id——否则「s1(撞车)→s1-imported」会和包内另一行 s1-imported 撞。两遍：先占非撞车 id。
  const streamIdMap = new Map<string, string>()
  const takenStream = new Set<string>()
  const reusedStreams = new Set<string>() // 同 id 且 members 一致 → 复用本机行（不 fork、不覆盖）
  for (const st of bundle.streams) {
    const existing = store.getStream(st.id)
    if (!existing) { streamIdMap.set(st.id, st.id); takenStream.add(st.id); continue }
    // 同 id 撞车但确系同一个流（同源）→ 复用本机行，避免空 `-imported` 孪生残留（历史迁移尾巴的成因）。
    // members 不一致才是真「异流撞 id」→ 落到下一轮 fork 出新 id。
    if (sameMembers(existing.members, st.members)) {
      streamIdMap.set(st.id, st.id); takenStream.add(st.id); reusedStreams.add(st.id)
    }
  }
  for (const st of bundle.streams) {
    if (streamIdMap.has(st.id)) continue
    const newId = uniqueId(st.id, (id) => !!store.getStream(id) || takenStream.has(id))
    streamIdMap.set(st.id, newId); takenStream.add(newId); remaps[st.id] = newId
  }
  const incomingProviders = bundle.providers ?? []
  const incomingBindings = bundle.providerBindings ?? []
  const providerIdMap = new Map<string, string>()
  const takenProvider = new Set<string>()
  for (const p of incomingProviders) {
    if (!store.getProvider(p.id)) { providerIdMap.set(p.id, p.id); takenProvider.add(p.id) }
  }
  for (const p of incomingProviders) {
    if (providerIdMap.has(p.id)) continue
    const newId = uniqueId(p.id, (id) => !!store.getProvider(id) || takenProvider.has(id))
    providerIdMap.set(p.id, newId); takenProvider.add(newId); remaps[p.id] = newId
  }

  // 成员 id 归一：新 bundle 自带全名，旧 bundle 是裸名。裸名在本机有多个同名候选、又分不出
  // 内置那条时 `resolveSource` 抛 —— 不静默挑一个（那是最贵的静默失真），也不让整份导入失败：
  // 落一条 open item 等用户拍板，成员先按原样落库（拍板后由 decideImportItem 改写）。
  const resolveMember = (streamId: string, m: SourceBinding): SourceBinding => {
    if (!deps.resolveSource) return m
    try {
      const full = deps.resolveSource(m.source)
      return full ? { ...m, source: full } : m
    } catch (e) {
      const candidates = (e as { candidates?: string[] }).candidates ?? []
      pushItem({
        kind: 'source-ambiguous',
        subject: { streamId, source: m.source },
        theirs: { source: m.source, candidates },
        choices: [...candidates, 'dismiss'],
        detail: `流「${streamId}」引用的源 \`${m.source}\` 在本机有 ${candidates.length} 个同名候选：${candidates.join('、')}。请选一个。`,
      })
      return m
    }
  }

  // 写 streams（新 id）——复用本机同源流的跳过，保留本机行不覆盖（label/options 不动）。
  for (const st of bundle.streams) {
    if (reusedStreams.has(st.id)) continue
    const id = streamIdMap.get(st.id)!
    store.putStream({ ...st, id, members: st.members.map((m) => resolveMember(id, m)) } as StreamRecord)
  }
  // providerBindings 覆盖 → 落到对应（remap 后）parked provider 的 options.candidateBinding（T2）。
  const candidateByProvider = new Map<string, { callsiteId: string }>()
  for (const pb of incomingBindings) {
    for (const oldPid of pb.providerIds) {
      const newPid = providerIdMap.get(oldPid)
      if (newPid) candidateByProvider.set(newPid, { callsiteId: pb.callsiteId })
    }
  }
  // 写 providers（新 id + 改写 {provider} 组合成员）——一律 park-on-import（options.parked=true）：
  // 落库但不接线、不入 dispatch（parked 被 serves 匹配点排除），激活时才生效。每行一个待拍板 item。
  for (const p of incomingProviders) {
    const newId = providerIdMap.get(p.id)!
    const members = p.members.map((m) => ('provider' in m && typeof (m as { provider?: unknown }).provider === 'string' && providerIdMap.has((m as { provider: string }).provider))
      ? { ...m, provider: providerIdMap.get((m as { provider: string }).provider)! }
      : m)
    const candidate = candidateByProvider.get(newId)
    store.putProvider({
      ...p,
      id: newId,
      members,
      options: { ...(p.options ?? {}), parked: true, ...(candidate ? { candidateBinding: candidate } : {}) },
    } as ProviderRecord)
    pushItem({
      kind: 'parked-provider',
      subject: { providerId: newId, label: p.label, category: p.category, serves: p.serves, ...(candidate ? { candidateBinding: candidate } : {}) },
      choices: PARKED_PROVIDER_CHOICES,
      detail: `导入的 Provider「${p.label}」（${p.category}: ${p.serves.join(', ')}）已落库待激活`,
    })
  }
  // 写 channels：system 复用（stream_ids append + 槽位合并/冲突落 item）、其余 remap（stream_ids 改写）
  for (const ch of bundle.channels) {
    const remappedStreamIds = ch.stream_ids.map((sid) => streamIdMap.get(sid) ?? sid)
    const rawOptions = (ch.options ?? {}) as Record<string, unknown>
    const { slots, candidateSlots, dangling } = splitSlots(rawOptions.slots, providerIdMap, store)
    for (const callsiteId of dangling) {
      pushNotice('slot-dangling', `频道 ${ch.id} 槽位 ${callsiteId} 引用的 Provider 既不随包也不在本机，已剥离`, { channelId: ch.id, callsiteId })
    }
    if (SYSTEM_CHANNEL_IDS.has(ch.id)) {
      // system 频道本机必然已存在且可能已配置——导入不破坏本机任何已生效配置（spec §4.2）：
      // 本机未配置的 callsite 静默合并（引用随包 parked 行的落 candidateSlots，激活时搬回）；
      // 已配置（slots ∪ candidateSlots 任一有键——只看 slots 会让包内 candidateSlots 键在激活时
      // 盖掉本机活槽）的落 slot-conflict item，包内那份只进 run，不落频道 options 的任何字段。
      const existing = store.getChannel(ch.id)
      const merged = [...new Set([...(existing?.stream_ids ?? []), ...remappedStreamIds])]
      const localOpts = (existing?.options ?? {}) as Record<string, unknown>
      const localSlots = readSlots(localOpts)
      const localCandidate = readSlots({ slots: localOpts.candidateSlots }) // 同一份合法性定义，读的是 candidateSlots
      const nextSlots = { ...((localOpts.slots as Record<string, unknown> | undefined) ?? {}) }
      const nextCandidate = { ...((localOpts.candidateSlots as Record<string, unknown> | undefined) ?? {}) }
      let touched = false
      for (const [callsiteId, ids] of [...Object.entries(slots), ...Object.entries(candidateSlots)]) {
        const mineIds = localSlots[callsiteId] ?? localCandidate[callsiteId]
        if (mineIds) {
          pushItem({
            kind: 'slot-conflict',
            subject: { channelId: ch.id, callsiteId },
            mine: { providerIds: mineIds, from: localSlots[callsiteId] ? 'slots' : 'candidateSlots', providers: projectProviders(mineIds, store) },
            theirs: { providerIds: ids, providers: projectProviders(ids, store) },
            choices: SLOT_CONFLICT_CHOICES,
            detail: `频道 ${ch.id} 槽位 ${callsiteId}：本机已配 [${mineIds.join(', ')}]，包内传入 [${ids.join(', ')}]；本机继续生效，待拍板`,
          })
          continue
        }
        if (callsiteId in slots) nextSlots[callsiteId] = ids
        else nextCandidate[callsiteId] = ids
        touched = true
      }
      const patch: Partial<ChannelRecord> = { stream_ids: merged }
      if (touched) {
        const nextOptions: Record<string, unknown> = { ...localOpts }
        if (Object.keys(nextSlots).length) nextOptions.slots = nextSlots
        if (Object.keys(nextCandidate).length) nextOptions.candidateSlots = nextCandidate
        patch.options = nextOptions as ChannelRecord['options']
      }
      store.patchChannel(ch.id, patch)
      continue
    }
    const clash = !!store.getChannel(ch.id)
    const newId = clash ? uniqueId(ch.id, (id) => !!store.getChannel(id)) : ch.id
    if (clash) remaps[ch.id] = newId
    const present = coercePresent((ch as { present?: unknown; variant?: unknown }).present ?? (ch as { variant?: unknown }).variant) ?? 'timeline'
    const options: Record<string, unknown> = { ...rawOptions }
    if (Object.keys(slots).length) options.slots = slots; else delete options.slots
    if (Object.keys(candidateSlots).length) options.candidateSlots = candidateSlots; else delete options.candidateSlots
    store.putChannel({ ...ch, id: newId, present, stream_ids: remappedStreamIds, options } as ChannelRecord)
  }

  // ── 落库即孤儿：写进来了、但没有任何频道引用它的流 ────────────────────────────
  //
  // **必须在写完 channels 之后问**——判据要看的是导入结束后的最终状态，包里那些频道刚刚才
  // 把 stream_ids 写进去。
  //
  // 为什么这条一定要说出来（活体 2026-09-05，给另一台机分享一条播客流时撞到）：
  // stream-rooted 的包里 `channels: []`，导入不给它任何频道归属。于是——
  // 导入回 **201 + 一个正常的 run**、`streams` 表里**确实有那一行**，但 `GET /api/streams`
  // 看不见它、`refresh` 报 `not_found`、**重启之后它就没了**。
  //
  // 根因是一处**刻意的不对称**（见 `UserStore.isCollected` 的头注）：开机装载走
  // `collectedStreamIds()`，那份清单**只收被某个频道引用的流**；而运行期的 `isCollected`
  // 对「没被任何频道引用」答 true。设计上守这条的是 `POST /api/streams`——它收 `channel_id`，
  // 「先记归属，再问判据」。**导入这条路没有等价物**：既不问用户放哪个频道、也不给默认归属，
  // 还报成功。
  //
  // 「最终该落到哪个频道」还没拍板（三条路的代价不同，见 `docs/TODO.md`）。但**三条路都需要
  // 这条兜底**，而且它是这条缺陷里最贵的那一半：今天用户拿到的是一次"成功"，手里却有一条
  // 永远不会被采集、重启就消失的流，**没有一处会喊**。
  //
  // 判据不在这里另写一份：`referencedStreamIds()` 就是 `collectedStreamIds()` 用的那一半
  // （见 user-store.ts）。写第二份 present 判断的下场，那个文件的头注已经写过了。
  const referenced = store.referencedStreamIds()
  for (const st of bundle.streams) {
    if (reusedStreams.has(st.id)) continue // 复用本机行：归属是本机既有的，不归这次导入管
    const id = streamIdMap.get(st.id)!
    if (referenced.has(id)) continue
    pushNotice(
      'stream-unchanneled',
      `流「${st.label ?? id}」已落库，但没有任何频道引用它——**它不会被采集，重启后也不会再出现**。` +
        `把它加进一个频道即可（PATCH /api/channels/<id> {stream_ids:[…, "${id}"]}）。`,
      { streamId: id },
    )
  }

  // ── 网盘对齐 binding 搭车（B）：暂存为 pending MappingSet（right 未解析、autoSync=false）。
  //    导入零执行：只 save，不转存/不 sync/不采集——对方转存后走既有 rebind 完成。──
  const netdiskBindingsTodo: { id: string; title: string; shareUrl?: string }[] = []
  const incomingNetdisk = bundle.netdiskBindings ?? []
  const genMappingId = deps.genMappingId ?? newMappingId
  if (incomingNetdisk.length && deps.mappingStore) {
    for (const nb of incomingNetdisk) {
      let id = genMappingId()
      while (deps.mappingStore.get(id)) id = newMappingId()
      const left = nb.left.kind === 'stream'
        ? { ...nb.left, streamId: streamIdMap.get(nb.left.streamId) ?? nb.left.streamId }
        : nb.left
      const set: MappingSet = {
        id, left,
        right: { kind: 'alist-dir', path: '', boundAt: now }, // pending 占位（T2）
        rightHistory: [], autoSync: false,                    // 不让轮询碰它
        // entry status 中和为 'pending'：否则 confirmed/auto 会被 MappingStore.rebuildIndex 以 dirPath:''
        // 索引 → findByLeftKey 返坏 hit → 播放 502。rightFile + corrected 保留（rebind 后 sync 重算/钉住）。
        entries: (nb.entries ?? []).map((e) => ({ ...e, status: 'pending' as const })) as MappingSet['entries'],
        ...(nb.matchSpec ? { matchSpec: nb.matchSpec } : {}),
      }
      // stream-left 且 stream 既不在 remap 表也不在本机 → 落 notice（rebind 后左侧清单会为空），不静默半建。
      if (nb.left.kind === 'stream' && !streamIdMap.has(nb.left.streamId) && !store.getStream(nb.left.streamId)) {
        pushNotice('netdisk-stream-missing', `netdisk binding 的 stream \`${nb.left.streamId}\` 未随包/本机缺失，rebind 后左侧清单为空`, { dep: id })
      }
      deps.mappingStore.save(set)
      netdiskBindingsTodo.push({ id, title: left.title, ...(nb.shareUrl ? { shareUrl: nb.shareUrl } : {}) })
    }
  } else if (incomingNetdisk.length) {
    pushNotice('netdisk-unavailable', `包含 ${incomingNetdisk.length} 个网盘 binding，但本机未接入 AList/网盘，已跳过`)
  }

  return {
    id: deps.genRunId?.() ?? `imp-${randomUUID().slice(0, 8)}`,
    at: now,
    meta: { title: bundle.meta.title, ...(bundle.meta.author ? { author: bundle.meta.author } : {}), revision: bundle.meta.revision },
    remaps,
    recipeDecisions,
    netdiskBindings: netdiskBindingsTodo,
    items,
  }
}
