/**
 * `pluginTarget()` 答空时的**现场**：分类 + 渲染成一条 DebugEntry。纯函数，没有 I/O。
 *
 * 为什么要有它（spec `docs/superpowers/specs/2026-08-19-plugin-target-empty-observability-design.md`）：
 * 答空在调用方一律被 `?? ''` 吃成空串，下游只剩一句 `Failed to parse URL from /api/...`。
 * 2026-08-15 一个时间窗口内 6 条抖音 item 全部这么废掉，重跑又全过——瞬时，而且现场什么都没留下。
 *
 * **本模块只做观测，不修根因。** 缓存失效 / `withAwake` 重取那两条要先能复现「容器在飞行中被
 * 重建」才谈得上改。这里要保证的是：撞一次，就能从记录里直接读出是哪一条。
 */
import type { DebugEntry, DebugField } from '../debug.ts'
import type { EventInput } from '../events/store.ts'
import type { PluginNetMode } from './plugin-target.ts'
import type { StandbyDiagnosis } from './standby/manager.ts'
import type { StandbyInertReason } from './standby/wire.ts'

/** 答空的几条路径。**每条都有名字**——没名字的原因就没法被搜索、没法被断言、也没法被回答。 */
export type PluginTargetMissReason =
  /** 钩子没接：bootstrap 没跑（stdio / 单测），或内核已 dispose。 */
  | 'resolver-unbound'
  /** 这台机器没有容器门（桌面档）——按设计如此，不是故障。 */
  | 'net-mode-none'
  /** compose 档：合并名册里没有这个 service，或它没声明 backend。 */
  | 'no-backend-declared'
  /** compose 档：名册里有它，静态解析仍答空。今天走不到，守 `string | null` 契约。 */
  | 'compose-target-unresolved'
  /** host 档：standby 没接线（没 Docker / 没插件声明 standby → inert）。 */
  | 'standby-unbound'
  /** host 档：standby 名册里没有这个 service —— **名单漏了它**。 */
  | 'not-managed'
  /** host 档：cell 在，但不是 awake（asleep / starting / stopping）—— **根本没醒**。 */
  | 'not-awake'
  /** host 档：cell 报 awake 却没有 origin —— **哑状态**（缓存那一侧的病）。 */
  | 'awake-without-origin'

export interface PluginTargetMissInputs {
  service: string
  mode: PluginNetMode
  /** `isPluginTargetBound()` */
  resolverBound: boolean
  /** compose 档：合并名册（BackendDirectory）里这个 service 有没有 backend 声明。 */
  backendDeclared: boolean
  /** standby 的只读对质结果；**null = standby 没接线**（不是"查不到"）。 */
  standby: StandbyDiagnosis | null
  /**
   * `standby === null` 时**为什么**没接线（见 StandbyInertReason）。
   *
   * 为什么必须有它：`standby-unbound` 这一个 reason 混着两种性质相反的成因——「Docker 不在」
   * （外部事故，所有容器插件一起失效，该喊）和「没插件声明 standby / 桌面档没有容器门」
   * （按设计如此，喊了就是骚扰）。只看 `standby === null` 分不出来，于是过去一律不喊，
   * 影响面最大的那一种反而最安静。
   *
   * 可选：生产上只有一个构造点（makePluginTargetMissReporter）会填，由它自己的测试钉着。
   * 没传 → 判据保持沉默（"不知道"不等于"出事了"）。
   */
  standbyInert?: StandbyInertReason | null
}

export interface PluginTargetMissFacts extends PluginTargetMissInputs {
  reason: PluginTargetMissReason
  /** 本节流窗口内被压掉的答空次数（见 MissThrottle）。 */
  suppressed: number
}

/** 「按设计如此」的那两条不算故障——把它们标红只会教人忽略这个频道。 */
const BY_DESIGN: ReadonlySet<PluginTargetMissReason> = new Set(['net-mode-none', 'resolver-unbound'])

export function classifyPluginTargetMiss(i: PluginTargetMissInputs): PluginTargetMissFacts {
  const facts = (reason: PluginTargetMissReason): PluginTargetMissFacts => ({ ...i, reason, suppressed: 0 })
  // 钩子没接先于一切：没接线时下面所有档位判断说的都不是这次答空的原因。
  if (!i.resolverBound) return facts('resolver-unbound')
  if (i.mode === 'none') return facts('net-mode-none')
  if (i.mode === 'compose') return facts(i.backendDeclared ? 'compose-target-unresolved' : 'no-backend-declared')
  // host 档：取址走 standby Cell 缓存，所以四条细分全在 standby 那一侧。
  if (!i.standby) return facts('standby-unbound')
  if (!i.standby.managed) return facts('not-managed')
  if (i.standby.state !== 'awake') return facts('not-awake')
  return facts('awake-without-origin')
}

/** 每条 reason 的一句白话——读的人不该先去查表才知道发生了什么。 */
const SUMMARY: Record<PluginTargetMissReason, string> = {
  'resolver-unbound': '取址钩子没接线（bootstrap 没跑或内核已销毁），所有插件取址一律为空',
  'net-mode-none': '这台机器没有容器门（STREAM_PLUGIN_NETWORK 未设为 host/compose），按设计取不到地址',
  'no-backend-declared': 'compose 档：合并名册里没有这个 service 的 backend 声明',
  'compose-target-unresolved': 'compose 档：名册里有它，静态解析却答空（不该发生）',
  'standby-unbound': 'host 档：standby 没接线（没 Docker 或没插件声明 standby），随机口无从查起',
  'not-managed': 'host 档：standby 名册里没有这个 service —— 名单漏了它，容器再健康也取不到口',
  'not-awake': 'host 档：容器没醒（standby 状态不是 awake），此刻没有 loopback 口',
  'awake-without-origin': 'host 档：standby 报 awake 却没有缓存 origin —— 哑状态，缓存与实际已分家',
}

/**
 * 渲染成 DebugBox 的一条。三个必答问题各占一行：**容器在不在** / **standby 认为它是什么状态** /
 * **inspect 出来的口是什么**；`缓存 origin` 与 `inspect 宿主口` 并排摆着，两个数不一样 =
 * 缓存陈旧（Cell 那一侧），容器 running 而 standby asleep = 根本没醒（withAwake 那一侧）。
 */
export function pluginTargetMissEntry(f: PluginTargetMissFacts, at: number): DebugEntry {
  const fields: DebugField[] = [
    { label: 'reason', value: f.reason, tone: BY_DESIGN.has(f.reason) ? 'muted' : 'bad' },
    { label: 'net 档', value: f.mode },
    { label: '取址钩子', value: f.resolverBound ? '已接线' : '未接线', tone: f.resolverBound ? 'ok' : 'warn' },
  ]
  if (f.mode === 'compose') fields.push({ label: 'backend 声明', value: f.backendDeclared ? '有' : '无' })
  if (!f.standby) {
    // 「为什么没接线」是这一格最值钱的一句：这两种成因一个是事故、一个是常态，
    // 而排查的人第一眼看的就是这条频道（详情同 pluginTargetMissDetail）。
    fields.push({
      label: 'standby',
      value: `未接线（inert：${INERT_REASON_TEXT[f.standbyInert ?? 'unknown']}）`,
      tone: f.standbyInert === 'docker-unreachable' ? 'bad' : 'warn',
    })
  } else {
    const s = f.standby
    fields.push(
      { label: 'standby 名册', value: s.managed ? '管着它' : '没有它', tone: s.managed ? 'ok' : 'bad' },
      { label: 'standby 状态', value: s.state ?? '(不在名册)' },
      { label: '缓存 origin', value: s.cachedOrigin ?? '(无)' },
      { label: '容器', value: s.containerId ? `${s.container} (${s.containerId})` : s.container, tone: s.container === 'running' ? 'ok' : 'warn' },
      { label: 'inspect 宿主口', value: s.hostPort === null ? '(取不到)' : String(s.hostPort) },
    )
    if (s.note) fields.push({ label: 'note', value: s.note, tone: 'muted' })
  }
  if (f.suppressed > 0) fields.push({ label: '本窗口另有', value: `${f.suppressed} 次答空被压掉`, tone: 'muted' })
  return {
    id: `plugin-target:${f.service}@${at}`,
    at,
    channel: 'plugin-target',
    key: f.service,
    title: `${f.service} 取址答空`,
    summary: missSummary(f),
    ok: BY_DESIGN.has(f.reason),
    fields,
  }
}

// ── 通知那一格 ────────────────────────────────────────────────────────────────
// debug bus 是 200 条的内存 ring：很吵、会被冲掉、后端一重启就全没。用户感知到症状
// （内容刷不出来）时现场大概率已经没了，所以**真指向缺陷**的那两档要主动出现在他面前。
// 反过来，**每条答空都通知 = 骚扰 = 用户学会忽略这个铃铛**，比不通知更糟。
// 判据与「为什么排除其余 6 条」见 spec 2026-08-19-silent-failure-notifications-design §2.1。

/** 值得打扰用户的几种形状。有名字才搜得到、钉得住（放宽一档就有测试变红）。 */
export type PluginTargetDefect =
  /** 容器**正在跑**，standby 却认为它睡着 —— 状态机和现实分家（withAwake 那一侧）。 */
  | 'container-never-woke'
  /** 缓存的 loopback 口 ≠ 现场 inspect 出的口 —— 容器被重建过，Cell 缓存陈旧。 */
  | 'stale-origin'
  /** 这台机器上**够不着 Docker** —— 所有带容器的插件一起失效。外部事故，不是我们的状态机错了。 */
  | 'docker-unreachable'

/**
 * 「够不着 Docker」这一条的去重键**不带 service**。
 *
 * 它是一个**全局事实**，不属于任何一个插件：Docker 一挂，8 个带容器的插件挨个取址一次，
 * 按 service 去重就是 8 条一模一样的通知。同理，boot 期就发现（serve.ts 那条）和真要用时
 * 才发现（这里）说的也是同一件事，共用这个键 —— 一件事占一行。
 */
export const DOCKER_UNREACHABLE_DEDUPE_KEY = 'plugin-target:docker-unreachable'

/**
 * inert 原因在诊断现场里的说法。
 *
 * `unknown` = **此刻还答不上来**，不是"没有原因"（两者必须分得开，理由同这张表其余几格）。
 * 它在生产里真的会出现，而且不是缺陷：boot 期比 `wireStandby` 更早的取址就落在这一格——
 * 活体实测（2026-09-02）AList 在 bootstrap 接管前打的那次 `/ping` 正是如此，那一刻接线
 * 还没跑完，原因确实尚不存在。所以措辞不能写得像 bug。
 */
const INERT_REASON_TEXT: Record<StandbyInertReason | 'unknown', string> = {
  'docker-unreachable': '够不着 Docker（端点解不出，或 ping 不通）',
  'not-gated': '按设计如此：没插件声明 standby，或这台机器没有容器门',
  'no-resolvable-services': '声明了 standby，但一个 target 都解不出',
  unknown: '此刻还不知道（这次取址早于 standby 接线，或调用方没传）',
}

/** 这一格的一句白话。**有准确原因就别再说两可的话**——`standby-unbound` 的固定文案
 *  写的是「没 Docker 或没插件声明 standby」，一个是事故一个是常态，而排查的人第一眼
 *  读的就是这句（2026-09-02 就是这么读的）。 */
function missSummary(f: PluginTargetMissFacts): string {
  if (f.reason === 'standby-unbound' && f.standbyInert) {
    return `host 档：standby 未接线——${INERT_REASON_TEXT[f.standbyInert]}`
  }
  return SUMMARY[f.reason]
}

/** 缓存 origin 里的那个口；解析不出（不是 URL / 没有显式端口）→ null，**不猜默认口**。 */
const originPort = (origin: string | null): number | null => {
  if (!origin) return null
  try {
    const p = Number(new URL(origin).port)
    return Number.isInteger(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/**
 * 这次答空是不是**真缺陷**。不是 → null，只留 debug bus。
 *
 * 最要紧的排除项是 `not-awake` + 容器 `stopped`：那是「本来就睡着、这次调用没走唤醒路径」，
 * 是**正常态**，生产里在稳定产生（voiceprint）。通知它就是纯骚扰。
 */
export function pluginTargetNotifiableDefect(f: PluginTargetMissFacts): PluginTargetDefect | null {
  const s = f.standby
  // 「够不着 Docker」排在最前:容器状态都问不到的时候,下面那两条结论(它该醒着 / 那个口过期了)
  // 根本无从谈起。它有两条到达路径,对用户是同一件事——
  //   1. standby 压根没接线,而 inert 的原因是 boot 那会儿 Docker 就不在;
  //   2. 接线了,但 diagnose 去问 Docker 失败(container='unknown' 只在它的 catch 里产生,
  //      判据干净,不必去解析 note 的文本)——**后端跑着、Docker 半路挂**,比 1 更常见。
  // 另外两种 inert(没插件声明 standby / 桌面档没有容器门)是按设计如此,喊了只会教用户
  // 忽略这个铃铛;原因根本没传下来时同样沉默——别拿"不知道"当"出事了"。
  if (!s) return f.standbyInert === 'docker-unreachable' ? 'docker-unreachable' : null
  if (s.container === 'unknown') return 'docker-unreachable'
  // 先判这条：它说的是「standby 整个状态模型错了」，比「某个口过期了」更靠近根因。
  if (f.reason === 'not-awake' && s.container === 'running') return 'container-never-woke'
  const cached = originPort(s.cachedOrigin)
  // 两个数都拿到才敢判——拿不到证据不等于有缺陷。
  if (cached !== null && s.hostPort !== null && cached !== s.hostPort) return 'stale-origin'
  return null
}

/**
 * 渲染成通知中心的一条。读的人只做架构把关，**不读代码不读术语**：三个问题各答一句
 * ——什么能力受影响了 / 现在能读出什么结论 / 要看详情去哪。
 *
 * `dedupeKey` 按 **service + 缺陷形状**：同一个容器反复失败是同一件事（未读时原地刷新，
 * 不刷屏）；两种形状是两个不同的结论，合并会让后到的正文被前一条吃掉。
 * **端口号不进 key** —— 否则容器每重建一次就多一行新通知，去重形同虚设。
 */
/**
 * 通知的 `detail`：**和上面那条 DebugEntry 同一批值**（不重新去问 Docker，重问会得到另一个时刻的
 * 现场，两份记录就对不上了），只是渲染成一段能直接粘进对话框的纯文本。
 *
 * debug bus 是 200 条的内存 ring、重启即失；用户看到通知时想排查，唯一手边还在的就是这一段。
 * 取不到的格子写 `未接线` / `(无)` / `(取不到)`，**不填 0、不填 null** —— 那是"查过了、就是没有"
 * 和"根本没查"的分界。
 */
export function pluginTargetMissDetail(f: PluginTargetMissFacts): string {
  const rows: Array<[string, string]> = [
    ['service', f.service],
    ['reason', f.reason],
    ['net 档', f.mode],
    ['取址钩子', f.resolverBound ? '已接线' : '未接线'],
  ]
  if (f.mode === 'compose') rows.push(['backend 声明', f.backendDeclared ? '有' : '无'])
  const s = f.standby
  if (!s) {
    // 「为什么没接线」是这一格最值钱的一句：过去只能写成"没 Docker，或没插件声明 standby"
    // 这种两可的话，而这两者一个是事故、一个是常态。原因传下来了就直说。
    const why = INERT_REASON_TEXT[f.standbyInert ?? 'unknown'] ?? INERT_REASON_TEXT.unknown
    rows.push(['standby', `未接线（inert：${why}）`])
  } else {
    rows.push(
      ['standby 名册', s.managed ? '管着它' : '没有它'],
      ['standby 状态', s.state ?? '(不在名册)'],
      ['缓存 origin', s.cachedOrigin ?? '(无)'],
      ['容器', s.containerId ? `${s.container} (${s.containerId})` : s.container],
      ['inspect 宿主口', s.hostPort === null ? '(取不到)' : String(s.hostPort)],
    )
    if (s.note) rows.push(['note', s.note])
  }
  if (f.suppressed > 0) rows.push(['本窗口另有被压掉', `${f.suppressed} 次`])
  return rows.map(([k, v]) => `${k}=${v}`).join('\n')
}

export function pluginTargetMissNotification(f: PluginTargetMissFacts): EventInput | null {
  const defect = pluginTargetNotifiableDefect(f)
  if (!defect) return null
  const dedupeKey = `plugin-target:${f.service}:${defect}`
  const detail = pluginTargetMissDetail(f)
  if (defect === 'docker-unreachable') {
    // 标题不点名插件:坏的不是某个插件,是这台机器上的 Docker。是在访问谁的时候撞上的
    // 进 detail(排查要用),不进正文——用户不关心哪个插件先撞上,他要知道的是范围和该干嘛。
    return {
      type: 'plugin.target-miss', severity: 'error',
      title: 'Docker 不可用，带容器的插件都取不到内容',
      body: 'Stream 现在连不上这台机器上的 Docker，凡是要跑容器的插件（网盘搜索、网盘挂载、抖音等）这一轮都会空手而归——界面上看起来只是"没搜到"。把 Docker 起回来之后重启一次后端，它会重新认一遍。详情看诊断面板的 plugin-target 频道。',
      detail,
      dedupeKey: DOCKER_UNREACHABLE_DEDUPE_KEY,
    }
  }
  if (defect === 'container-never-woke') {
    return {
      type: 'plugin.target-miss', severity: 'error',
      title: `插件后端没被唤醒：${f.service}`,
      body: '这个插件的容器明明在运行，Stream 却以为它还睡着，于是这一轮没能取到它的地址——用到它的内容会空手而归。重启后端可以让它重新认一次。详情看诊断面板的 plugin-target 频道。',
      detail,
      dedupeKey,
    }
  }
  return {
    type: 'plugin.target-miss', severity: 'error',
    title: `插件后端地址过期：${f.service}`,
    body: `这个插件的容器换了端口（Stream 记着 ${originPort(f.standby!.cachedOrigin)}，实际在 ${f.standby!.hostPort}），还在按旧地址找它，这一轮取不到任何东西。多半是容器刚被重建过；重启后端会重新认一次地址。详情看诊断面板的 plugin-target 频道。`,
    detail,
    dedupeKey,
  }
}

/**
 * 按 **service** 节流，冷却窗口内只放第一条，压掉的次数攒进下一条。
 *
 * 为什么必须有：`mode==='none'` 的桌面档每次调用都答空，不节流会把 200 条的 ring 冲干净——
 * 一个诊断频道把别人的诊断挤掉，比没有还糟。
 *
 * 为什么按 service 而不是 (service, reason)：**reason 要等 Docker 查完才知道**，而节流决定
 * 必须在同步那一刻做完（否则一次并发风暴会同时打出 N 个 Docker 请求）。代价是 60s 内的状态
 * 跃迁只看得到第一条——本轮接受，要复现的那个时序本来就得靠专门的台架，不靠这条日志的分辨率。
 */
export class MissThrottle {
  private readonly last = new Map<string, { at: number; suppressed: number }>()

  constructor(private readonly cooldownMs = 60_000) {}

  admit(service: string, now: number): { ok: boolean; suppressed: number } {
    const prev = this.last.get(service)
    if (prev && now - prev.at < this.cooldownMs) {
      prev.suppressed += 1
      return { ok: false, suppressed: 0 }
    }
    this.last.set(service, { at: now, suppressed: 0 })
    return { ok: true, suppressed: prev?.suppressed ?? 0 }
  }
}

export interface MissReporterDeps {
  /** 这台机器的容器门形态（`pluginNetMode()`，装配期定死，进程内不变）。 */
  mode: PluginNetMode
  /** `isPluginTargetBound()` —— 调用时现取，别存快照。 */
  resolverBound: () => boolean
  /** 合并名册（BackendDirectory）里这个 service 声明了 backend 吗。 */
  backendDeclared: (service: string) => boolean
  /** `standbyDiagnose()`；未接线 → null。**只在 host 档调**。 */
  standbyDiagnose: (service: string) => Promise<StandbyDiagnosis | null>
  /** `standbyInertReason()` —— 上面那个答 null 时**为什么**。调用时现取（接线状态会变）。
   *  缺席 → 判据保持沉默，不会把"不知道"当成"出事了"。 */
  standbyInertReason?: () => StandbyInertReason | null
  emit: (entry: DebugEntry) => void
  /**
   * 通知中心的入口。**必须是调用时才解引用的那种**（`lazyNotify(() => ctx.streamEvents)`）：
   * 事件层在装配序上比本域晚建，装配期取到的一律是 undefined。缺席 = 只记 debug bus。
   */
  notify?: (input: EventInput) => void
  now?: () => number
  throttle?: MissThrottle
}

/**
 * `setPluginTargetMissReporter()` 要绑的那个函数。
 *
 * 形状是**同步进、异步出**：节流决定必须同步做完（否则一次并发风暴会同时打出 N 个 Docker
 * 请求），Docker 那一问只能异步，所以查完再 emit 一条完整记录，而不是先后两条要人拼的半截。
 * 诊断延后几十毫秒无害。
 *
 * 三条吞错的地方（观测绝不能反过来打死主链路）：节流、诊断、emit 全在同一个 try 里。
 */
export function makePluginTargetMissReporter(deps: MissReporterDeps): (service: string) => void {
  const now = deps.now ?? Date.now
  const throttle = deps.throttle ?? new MissThrottle()
  return (service: string): void => {
    const gate = throttle.admit(service, now())
    if (!gate.ok) return
    void (async () => {
      try {
        // compose / none 档取址不经 standby，那几个数放进记录只会误导读的人。
        const standby = deps.mode === 'host' ? await deps.standbyDiagnose(service) : null
        const facts = classifyPluginTargetMiss({
          service,
          mode: deps.mode,
          resolverBound: deps.resolverBound(),
          backendDeclared: deps.backendDeclared(service),
          standby,
          // 只在真没接线时才有意义（接上了 standby 非 null，这一格不参与判据）。
          standbyInert: standby ? null : deps.standbyInertReason?.() ?? null,
        })
        const full: PluginTargetMissFacts = { ...facts, suppressed: gate.suppressed }
        deps.emit(pluginTargetMissEntry(full, now()))
        // 通知是**第二道闸门**（debug bus 照记全部，通知只放真缺陷那两档）；它抛了也不许
        // 影响上面那条已经记好的账，所以单独包一层。
        const notice = pluginTargetMissNotification(full)
        if (notice) {
          try {
            deps.notify?.(notice)
          } catch {
            /* 通知发不出去不该反过来打死主链路 */
          }
        }
      } catch {
        /* 记录现场失败了就失败了，取址那条路早已照常返回 null */
      }
    })()
  }
}
