import type { ProviderBinding, ProviderRecord } from '../store/types.ts'
import { readSlots } from '../store/slots.ts'
import type { UserStore } from '../store/user-store.ts'
import { providerCallsite, type ProviderCallsiteDescriptor } from './callsites.ts'
import { isParked } from './parked.ts'
import type { ProviderDirectory } from './directory.ts'
import { strategySupportsCollect } from './strategies/index.ts'

export interface SlotContext { channelId?: string }

/** `ensureDefaults` 的回执：新建了几条绑定、往已有的 dispatch 绑定里并进了几个默认行。 */
export interface EnsureDefaultsResult { inserted: number; augmented: number }

/** §5.1:槽位是显式意图。填了槽、但槽里挑不出可用 Provider(全 parked/已删)→ 显式报错,
 *  不做任何 fallback(既不回落全局 binding,也不回落调用点写死的默认值)。只在 ctx 带
 *  channelId 且该 callsite 确实填了槽时才可能抛——无 ctx / 未填槽的调用点结构上够不到这里。 */
export class SlotBrokenError extends Error {
  constructor(readonly channelId: string, readonly callsiteId: string, readonly providerIds: string[]) {
    super(`channel ${channelId} slot ${callsiteId} has no usable provider (${providerIds.join(',')})`)
  }
}

/** 开机体检回落掉的一处引用（`auditCollect` 的回执，调用方据此发通知）。 */
export interface CollectAuditFallback {
  /** `binding` = 全局绑定被重置为调用点默认行；`slot` = 某频道的槽位那一键被摘掉。 */
  scope: 'binding' | 'slot'
  callsiteId: string
  /** 仅 scope='slot'。 */
  channelId?: string
  previousProviderIds: string[]
  /** 不支持全收语义的那几行（连同它们的策略名，事件正文要说清"为什么"）。 */
  offending: { providerId: string; strategy: string }[]
  /** 回落到哪儿：全局 binding 落默认行；槽位是摘掉（null = 回落全局 binding）。 */
  fallbackProviderIds: string[] | null
}

export class ProviderBindings {
  constructor(
    private readonly store: Pick<UserStore, 'getProvider' | 'getProviderBinding' | 'putProviderBinding' | 'removeProviderBinding' | 'listProviderBindings' | 'providerCallsitesReferencing' | 'getChannel' | 'listChannels' | 'patchChannel'>,
    /** 「这一行服务这个键吗」的唯一判据（`'*'` 兜底的翻译也在它里面）；`get()` 另供
     *  validateSelection 读**合并行**的 strategy（系统行的身份归代码，库里那一列可能是旧值）。 */
    private readonly directory: Pick<ProviderDirectory, 'servesKey' | 'get'>,
  ) {}

  /** 每个调用点补一条默认绑定（已有的不动）。
   *
   *  **默认行为空的跳过，不写空绑定**：默认行现在可以由包声明填（`callsiteDefaultsFor`），
   *  一台没装那个包的机器上它就是空的。写一条空绑定的代价不是"绑了个空"——是**下次开机
   *  这一格就补不上了**（判据是"有没有绑定"，空绑定也算有），用户装完包重启仍然没有默认行，
   *  而没有任何一处会喊。跳过 = 这一格保持"未绑定"，包一到位下次开机自然补齐。 */
  ensureDefaults(descriptors: ProviderCallsiteDescriptor[]): EnsureDefaultsResult {
    let inserted = 0
    let augmented = 0
    for (const descriptor of descriptors) {
      if (descriptor.defaultProviderIds.length === 0) continue
      const existing = this.store.getProviderBinding(descriptor.id)
      if (!existing) {
        this.store.putProviderBinding({
          callsiteId: descriptor.id,
          providerIds: descriptor.defaultProviderIds,
          offeredDefaults: [...descriptor.defaultProviderIds],
        })
        inserted++
        continue
      }
      // **dispatch 调用点的已有绑定要并进还没提过的包默认行。** 只补空绑定是不够的：升级前
      // 装机上 `music.track.resolve` 已经绑着一条行，于是第二个平台包声明同一个调用点时整格
      // 是 no-op——用户装了包、行也建出来了，就是永远派发不到它，而没有任何一处会喊。
      // dispatch 是**按键选行**，多一条行不会顶掉谁（键不同就各走各的），所以并进去是安全的。
      // `fixed` 不并：那一格只有一个答案，已有的那个是用户的选择，不替他改。
      //
      // **判据是"提过没有"，不是"在不在绑定里"。** 后者分不出「这条默认行是新来的」和
      // 「用户把它删掉了」——两者在库里长得一模一样，于是用户每删一次、每次重启它又长回来。
      // 提过的记在 `offeredDefaults` 里（缺席 = 一条都没提过，升级后第一次开机照提一遍）。
      if (descriptor.mode !== 'dispatch') continue
      const offered = existing.offeredDefaults ?? []
      const missing = descriptor.defaultProviderIds.filter((id) => !existing.providerIds.includes(id) && !offered.includes(id))
      const nextOffered = [...new Set([...offered, ...descriptor.defaultProviderIds])]
      // 一个不缺、账也没变 → 一次写都不发（每次开机都跑，幂等要真幂等）。
      if (missing.length === 0 && nextOffered.length === offered.length) continue
      this.store.putProviderBinding({
        ...existing,
        providerIds: [...existing.providerIds, ...missing],
        offeredDefaults: nextOffered,
      })
      augmented += missing.length
    }
    return { inserted, augmented }
  }
  /**
   * 开机体检：把**存量**里绑进 collect 调用点、却不支持全收语义的行清出去。
   *
   * 为什么在 boot 做：`validateSelection` 那道闸只管**写入的那一刻**，拦不住升级前就躺在库里的
   * 绑定——collect 标记是这一期才加到 `video.detail.*` 上的，升级前用户完全可以把一条自建的
   * sequential/expand 行绑上去，升级后那三个调用点每次取数都会在执行器里抛
   * `does not support collect`，而它们是**详情页整页级**的失败（一条不成整页不成）。
   *
   * 为什么回落而不是留着响亮地炸：这里的取舍是「静默降级」对「整页瘫痪」。回落到默认行 +
   * 发一条事件是第三条路——**响但不瘫**：页面照常出内容，用户在通知中心看得见"你的那条自定义
   * 绑定被换掉了、为什么"，可以自己改回一条并发行。开机时抛错等于让一条历史配置把整个进程
   * 掀翻，那比失真更糟。
   *
   * 两处都体检（同一份判据）：全局 binding 重置为该调用点的默认行；频道 `options.slots` 里那一
   * 键**摘掉**（槽是显式意图，挑不出合法的行就不该继续声明——摘掉后按未填槽处理，回落全局
   * binding，而全局那一份刚刚被这同一趟体检保过了）。
   *
   * 幂等：合格的一个都不动，所以每次启动跑一遍不会重复吵（调用方的事件还带 dedupeKey 兜一层）。
   */
  auditCollect(descriptors: ProviderCallsiteDescriptor[]): CollectAuditFallback[] {
    const out: CollectAuditFallback[] = []
    // 频道表只读一次：体检期间没有别人在写库（开机路径、单线程），唯一的变动来自这趟自己的
    // patchChannel，而那一份就地回写进手里这个对象（见下），所以后一个 descriptor 读到的仍是
    // 最新的 slots——重读整表只是把同样的答案再查一遍。**别省掉那次回写**：不回写就会拿陈旧的
    // options 去 patch，把前一个 descriptor 刚摘掉的槽位又写回去。
    const channels = this.store.listChannels()
    for (const descriptor of descriptors) {
      if (!descriptor.collect) continue
      const binding = this.store.getProviderBinding(descriptor.id)
      if (binding) {
        const offending = this.offendingForCollect(binding.providerIds)
        if (offending.length > 0) {
          // 走 store 而不是 put()：体检发生在开机路径上，任何一处抛错都会把进程掀翻，
          // 而默认行的合法性由 `ensureSystemRows` + 调用点声明保证，不需要再过一次闸。
          //
          // **默认行为空时删掉绑定，而不是写一条空的**（默认行可以由包声明填，没装包就是空的）：
          // 写空绑定和留着那条不合格的绑定一样坏——空绑定也算"有绑定"，`ensureDefaults` 下次
          // 开机就跳过这一格，包到位了也补不上。删掉 = 回到"未绑定"，调用方按没绑处理，
          // 包一到位下次开机自然补齐。
          if (descriptor.defaultProviderIds.length === 0) this.store.removeProviderBinding(descriptor.id)
          else this.store.putProviderBinding({ callsiteId: descriptor.id, providerIds: descriptor.defaultProviderIds })
          out.push({ scope: 'binding', callsiteId: descriptor.id, previousProviderIds: binding.providerIds, offending, fallbackProviderIds: descriptor.defaultProviderIds })
        }
      }
      for (const channel of channels) {
        const slotted = readSlots(channel.options)[descriptor.id]
        if (!slotted) continue
        const offending = this.offendingForCollect(slotted)
        if (offending.length === 0) continue
        const rawSlots = (channel.options as { slots?: unknown }).slots
        const rest = { ...(rawSlots as Record<string, unknown>) }
        delete rest[descriptor.id]
        const nextOptions = { ...channel.options, slots: rest }
        this.store.patchChannel(channel.id, { options: nextOptions })
        channel.options = nextOptions // 就地回写：下一个 descriptor 读的是同一个对象
        out.push({ scope: 'slot', channelId: channel.id, callsiteId: descriptor.id, previousProviderIds: slotted, offending, fallbackProviderIds: null })
      }
    }
    return out
  }
  /** 候选 id 里不支持全收语义的那些（行已删的跳过——那是另一类问题，不归这道体检管）。
   *  strategy 取**合并行**，与 validateSelection 同一条判据：系统行的身份归代码。 */
  private offendingForCollect(providerIds: string[]): { providerId: string; strategy: string }[] {
    const out: { providerId: string; strategy: string }[] = []
    for (const providerId of providerIds) {
      const provider = this.store.getProvider(providerId)
      if (!provider) continue
      const strategy = (this.directory.get(providerId) ?? provider).strategy
      if (!strategySupportsCollect(strategy)) out.push({ providerId, strategy })
    }
    return out
  }
  binding(callsiteId: string): ProviderBinding | null { return this.store.getProviderBinding(callsiteId) }
  /** params 是可选的调用点覆盖（Task 9 消费，如 llm 调用点的 model 覆盖）。整体替换：不传 params
   *  会清掉已有值（restore() 依赖这个语义把覆盖一并复位）。 */
  put(callsiteId: string, providerIds: string[], params?: Record<string, unknown>): ProviderBinding {
    this.validateSelection(callsiteId, providerIds)
    return this.store.putProviderBinding({ callsiteId, providerIds, ...(params !== undefined ? { params } : {}) })
  }
  /** 恢复默认。**默认行为空时是清掉这条绑定，不是写一条空绑定**——`put([])` 过不了
   *  `validateSelection`（抛 → 「恢复默认」那个按钮回 400）。默认行可以由包声明填，
   *  一台没装那个包的机器上它天然就是空的，那是常态不是错误；清掉 = 这一格回到"未绑定"，
   *  包一到位下次开机 `ensureDefaults` 自然补齐（同那边"不写空绑定"的理由）。 */
  restore(callsiteId: string): ProviderBinding | null {
    const descriptor = this.requireDescriptor(callsiteId)
    if (descriptor.defaultProviderIds.length === 0) {
      this.store.removeProviderBinding(callsiteId)
      return null
    }
    return this.put(callsiteId, descriptor.defaultProviderIds)
  }
  clear(callsiteId: string): boolean { this.requireDescriptor(callsiteId); return this.store.removeProviderBinding(callsiteId) }
  fixed(callsiteId: string, ctx?: SlotContext): string | null {
    const slotted = this.slottedFixed(callsiteId, ctx)
    if (slotted !== undefined) return slotted
    return this.binding(callsiteId)?.providerIds[0] ?? null
  }
  /** fixed() 加一道 serves 闸门,**只**加在全局 binding 那一路：绑定行没声明 key 就当没绑（返回
   *  null，由调用点自己回落到按 key 分发）。给的是「一个 fixed 调用点，但输入本身带平台/路由键」
   *  的场合——播放解析就是：绑定与 platform 无关，不设闸门就会拿「音乐取流」的梯子去跑播客，
   *  整条跑完 declined 才回落（实测每次固定烧 ~6.8s）。
   *  槽位那一路不过闸门：槽是显式意图，语义与 fixed() 一字不差（含全 parked 抛 SlotBrokenError）。 */
  fixedServing(callsiteId: string, key: string, ctx?: SlotContext): string | null {
    const slotted = this.slottedFixed(callsiteId, ctx)
    if (slotted !== undefined) return slotted
    const id = this.binding(callsiteId)?.providerIds[0]
    if (!id) return null
    // serves 读不到（行已删）就不猜——当没绑，回落分发。兜底行认所有键，与 dispatch 同义。
    const provider = this.store.getProvider(id)
    if (!provider) return null
    return this.directory.servesKey(provider, key, { fallback: true }) ? id : null
  }
  /**
   * 绑定候选里挑一个接 `key` 的行：先具名，没有再看 `opts.fallback` 允不允许落兜底行。
   *
   * **`opts.fallback` 没有默认值，每个调用点自己表态**——这是那个漏洞的补法：网盘三个能力
   * 在 `match()` 那一路挡了兜底、在这一路没挡，于是给调用点绑一条兜底行就能从背后绕进去，
   * 拿回一个语义上无意义的「结果」而不是诚实的「不支持」。签名上不给默认值，绕不过去。
   */
  dispatch(callsiteId: string, key: string, ctx: SlotContext | undefined, opts: { fallback: boolean }): string | null {
    const descriptor = this.requireDescriptor(callsiteId)
    if (descriptor.mode !== 'dispatch') throw new Error(`${callsiteId} is not a dispatch callsite`)
    const slotted = this.slotProviderIds(callsiteId, ctx)
    // 排除 parked 行：即便被塞进 binding 也不选（park 机制过滤点之二）。
    const ids = slotted ?? this.binding(callsiteId)?.providerIds ?? []
    const providers = this.liveProviders(ids)
    if (slotted && providers.length === 0) throw new SlotBrokenError(ctx!.channelId!, callsiteId, slotted)
    const specific = providers.find((provider) => this.directory.servesKey(provider, key, { fallback: false }))
    if (specific) return specific.id
    if (!opts.fallback) return null
    return providers.find((provider) => this.directory.servesKey(provider, key, { fallback: true }))?.id ?? null
  }
  references(providerId: string): string[] { return this.store.providerCallsitesReferencing(providerId) }
  /** id 列表 → 存在且非 parked 的行(getProvider + !isParked 类型守卫)。fixed/dispatch 的槽位分支
   *  和全局 binding 分支共用同一条"排除 parked"规则,这里抽出来别两处重复内联。 */
  private liveProviders(ids: string[]): ProviderRecord[] {
    return ids.map((id) => this.store.getProvider(id)).filter((p): p is ProviderRecord => !!p && !isParked(p))
  }
  /** fixed 类调用点的槽位分支：填了槽 → 选中的行 id（全 parked/已删 → 抛 SlotBrokenError,§5.1）；
   *  没填/无 ctx → undefined = "槽不表态",由调用方回落全局 binding。fixed() 与 fixedServing()
   *  共用这一段,槽位语义只有这一处实现。 */
  private slottedFixed(callsiteId: string, ctx?: SlotContext): string | undefined {
    const slotted = this.slotProviderIds(callsiteId, ctx)
    if (!slotted) return undefined
    const live = this.liveProviders(slotted)
    if (live.length === 0) throw new SlotBrokenError(ctx!.channelId!, callsiteId, slotted)
    return live[0].id
  }
  /** 频道槽位:填了(非空字符串数组)= 显式意图,整体替代全局 binding;没填/频道不存在 = null → 回落全局。
   *  §5.1:槽里的 id 全是 parked/已删行时**不**回落——fixed()/dispatch() 在调用处抛 SlotBrokenError,
   *  因为槽位是显式意图,挑不出可用 Provider 就该显式报错,不是静默换路。 */
  private slotProviderIds(callsiteId: string, ctx?: SlotContext): string[] | null {
    if (!ctx?.channelId) return null
    const channel = this.store.getChannel(ctx.channelId)
    return readSlots(channel?.options)[callsiteId] ?? null
  }
  private requireDescriptor(id: string): ProviderCallsiteDescriptor {
    const descriptor = providerCallsite(id)
    if (!descriptor) throw new Error(`unknown provider callsite: ${id}`)
    return descriptor
  }
  /** callsite id + 候选 provider id 列表 → 抛错即校验失败。put() 与频道槽位写入共用同一条规则
   *  （fixed 恰好 1 个、dispatch 至少 1 个、去重、variant 匹配、collect 调用点要全收语义）
   *  ——槽位不另立规则。 */
  validateSelection(callsiteId: string, providerIds: string[]): void {
    const descriptor = this.requireDescriptor(callsiteId)
    if (descriptor.mode === 'fixed' && providerIds.length !== 1) throw new Error(`${descriptor.id} requires exactly one provider`)
    if (descriptor.mode === 'dispatch' && providerIds.length < 1) throw new Error(`${descriptor.id} requires at least one provider`)
    if (new Set(providerIds).size !== providerIds.length) throw new Error('provider ids must be unique')
    for (const providerId of providerIds) {
      const provider = this.store.getProvider(providerId)
      if (!provider) throw new Error(`provider not found: ${providerId}`)
      if (provider.category !== descriptor.category) throw new Error(`${providerId} is not compatible with ${descriptor.id}`)
      // collect 调用点前移的那道闸：绑一条首胜（sequential）或两跳（expand）的行，
      // 写入时就拒，别等到详情页真去取数时才在执行器里炸。strategy 取**合并行**——
      // 系统行的身份归代码，库里那一列可能是旧值。
      if (descriptor.collect) {
        const strategy = (this.directory.get(providerId) ?? provider).strategy
        if (!strategySupportsCollect(strategy)) {
          throw new Error(`${descriptor.id} 要求全收语义（collect）：${providerId} 的策略 "${strategy}" 不支持 collect，请改用并发（concurrent）策略的 Provider 行`)
        }
      }
    }
  }
}
