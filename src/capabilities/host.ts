/**
 * **能力包在 Stream 后端里的唯一宿主实现。**
 *
 * 一个能力包（`shared/capability/types.ts` 的 `Capability`）不认识宿主：它只吃一个
 * `CapabilityContext`，由宿主把自己翻译成那七格。Stream 后端就是**唯一**的那个宿主
 * （spec 2026-09-06-stream-single-host-aggregation-design §3.2），所以这份翻译只有一处——
 * 内置的 Stream Desktop 与用户 `stream add` 装进来的可选包走的是同一个 `mount()`，
 * 区别只在「模块怎么到场」（静态 import vs 从 `<dataDir>/recipes/` 动态 import）。
 *
 * ## 三条硬规矩，都是「失败得很安静」的反面
 *
 * 1. **工具名撞名硬拒**，在**进表之前**查两张名单（已收的 defs + 后端自己的工具名），撞了就抛。
 *    不是"覆盖 + 记一行"：用户能 `stream add` 任意包，一个第三方包起个 `extract` 就能把后端
 *    自己的动词顶掉，而模型只会觉得这个工具忽然变笨了——**没有一处会喊**。
 *    这也是「内置先、可选后」那个挂载顺序的意义：硬拒之下，顺序直接决定谁被拒。
 * 2. **`provide` 同名硬拒**。服务总线上一个名字只能有一个主人；后来的静默覆盖会让先到的那个
 *    包的消费者拿到一份它不认识的东西，而两边单看都正常。
 * 3. **mount 抛错要回滚**。抛在半路的包已经注册的工具必须一起撤掉，否则工具面上挂着一个
 *    没装成的包的动词——调用必然炸，且没有任何一处会说这个包没装上。
 *
 * ## 「一个包起不来不该拖死别的包」在哪一层
 *
 * 不在这里：`mount()` 照常把错抛给调用方。装载器（`load.ts`）逐包 try/catch 记一行、接着装
 * 下一个；`src/host-agent/mount.ts` 对内置那半同样自己兜。把兜底放进 host 就没人分得清
 * 「装上了」和「装的时候炸了」——而那正好是两种完全不同的排错方向。
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Capability, CapabilityContext, ToolDef } from '../../shared/capability/types.ts'

export interface CapabilityHostOptions {
  /** Stream 的 data 根。每个能力拿到的是它下面的 `capabilities/<name>/`。 */
  dataDir: string
  /** 一行日志的出口。缺省 `console.log`——后端的 stdout 就是它的日志面。 */
  log?: (line: string) => void
  /**
   * 后端**自己**的 MCP 工具名，能力包与它撞名即拒。
   *
   * 是 thunk 不是数组：工具面按域的可用性现算（`buildMcpExtras` 里一批 getter），装配那一刻
   * 取一次会把「此刻还没醒的那些工具」永久算成不存在，于是一个第三方包可以拿走它们的名字。
   */
  reservedToolNames?: () => Iterable<string>
}

/**
 * 一次 mount 的回执。`dispose()` 只收摊这一个能力（host.dispose 收摊全部）：它的工具下表、
 * 它申报的登录态域、**它 provide 过的每一格服务**、以及它登记的 `onDispose` 一起走。
 */
export interface MountedCapability {
  name: string
  /** 这个能力注册了哪些工具（注册顺序）。 */
  tools: string[]
  dispose(): Promise<void>
}

/** 挂载时由**包描述符**带过来的申报（不是模块自己说的，见 `credentials` 那一格的理由）。 */
export interface MountDeclaration {
  /**
   * 这个包在 `package.json#stream.credentials` 申报的登录态域。
   *
   * **申报点在包描述符上，不在模块上**：那一格过安装门（schema 校验 + 确认页逐域点名让用户
   * 批准），而模块级属性是装完之后才读得到的——放模块上等于「用户批准的名单」和「实际拿去
   * 同步的名单」分成两份，而两份漂移了没有任何一处会喊。
   */
  credentials?: string[]
}

export interface CapabilityHost {
  /** 挂一个能力。抛错 = 没挂上（已注册的工具与服务已回滚）。 */
  mount(cap: Capability, config?: unknown, declared?: MountDeclaration): Promise<MountedCapability>
  /** 此刻工具面上的全部能力工具。**每次现取**——见 CapabilityHostOptions.reservedToolNames 的理由。 */
  toolDefs(): ToolDef[]
  /** `{ <能力名>: [工具名…] }`，给「组件」页那一列。 */
  toolsByCapability(): Record<string, string[]>
  /**
   * 已挂上的能力**它那个包申报过的登录态域**（归一化、去重、排序）。
   *
   * 消费者是 `requiredCookieDomains` 的第三个来源：能力包是一等的登录态消费者
   * （与 manifest 的 `auth` 同级），不并进去就是扩展根本不去读那个域，而
   * `streamBrowserCookies` 拿到的空 cookie 和"用户没登录"长得一模一样。
   * **每次现取**：可选包在 boot 之后才装载，取一次快照等于永远只认内置那半。
   */
  credentialDomains(): string[]
  /** 宿主自己往服务总线上放一格（后端用它提供 `streamBrowserCookies`）。同名硬拒。 */
  provide(service: string, value: unknown): void
  /** 逆 mount 顺序收摊全部，逐个吞错记一行。 */
  dispose(): Promise<void>
}

interface Registered {
  capability: string
  def: ToolDef
}

export function createCapabilityHost(opts: CapabilityHostOptions): CapabilityHost {
  const log = opts.log ?? ((line: string) => console.log(line))
  const services = new Map<string, unknown>()
  /** 注册顺序即工具面顺序（`tools/list` 的稳定性靠它，不靠 Map 的插入顺序巧合）。 */
  const tools: Registered[] = []
  /** 全局收摊表，逆序执行。带能力名是为了单个能力自己收摊时能把自己那几条摘掉。 */
  const disposers: Array<{ capability: string; fn: () => void | Promise<void> }> = []
  const mounted = new Set<string>()
  /** 已挂能力申报的登录态域。key 是能力名，收摊时随它一起走。 */
  const credentials = new Map<string, string[]>()
  /**
   * 谁 provide 了哪几格服务。**单个能力 `dispose()` 也要撤自己那几格**——不撤的话，收摊之后
   * 总线上还留着一个指向已收摊对象的值：消费者 `require()` 得到的不是 undefined（那会走降级），
   * 而是一份看着正常、实际连不上的东西；而且重新挂同一个包时 `provide` 会撞上"已经有主人了"
   * 直接抛。`host.dispose()` 那一档早就整块 `services.clear()` 了，逐个收摊这一档漏了同一件事。
   */
  const provided = new Map<string, Set<string>>()

  const reserved = (): Set<string> => new Set(opts.reservedToolNames?.() ?? [])

  const dropCapability = (name: string) => {
    for (let i = tools.length - 1; i >= 0; i--) if (tools[i].capability === name) tools.splice(i, 1)
    for (let i = disposers.length - 1; i >= 0; i--) if (disposers[i].capability === name) disposers.splice(i, 1)
    credentials.delete(name)
    for (const service of provided.get(name) ?? []) services.delete(service)
    provided.delete(name)
  }

  const runDisposers = async (list: Array<{ capability: string; fn: () => void | Promise<void> }>) => {
    for (const d of list.reverse()) {
      try {
        await d.fn()
      } catch (err) {
        log(`[stream-${d.capability}] WARN dispose 失败：${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  const provide = (service: string, value: unknown, by: string) => {
    if (services.has(service)) {
      throw new Error(`能力 ${by} 提供的服务 "${service}" 已经有主人了——服务名在进程内必须独占`)
    }
    services.set(service, value)
    ;(provided.get(by) ?? provided.set(by, new Set()).get(by)!).add(service)
  }

  const contextFor = (name: string): CapabilityContext => {
    const dataDir = join(opts.dataDir, 'capabilities', name)
    return {
      // **读到才建**。不是洁癖：大多数能力（Stream Desktop 就是）从不落盘，而 `mkdir` 会因为
      // 权限/只读挂载失败——急着建目录就是让一个用不到的副作用去否决整个能力的挂载。
      get dataDir() {
        mkdirSync(dataDir, { recursive: true })
        return dataDir
      },
      log: {
        info: (msg) => log(`[stream-${name}] ${msg}`),
        warn: (msg) => log(`[stream-${name}] WARN ${msg}`),
      },
      require: <T>(service: string) => services.get(service) as T | undefined,
      provide: (service, value) => provide(service, value, name),
      registerTools: (defs) => {
        const taken = reserved()
        for (const def of tools) taken.add(def.def.name)
        for (const def of defs) {
          if (taken.has(def.name)) {
            throw new Error(
              `能力 ${name} 要注册的工具名 "${def.name}" 已被占用（后端自己的工具，或另一个已装的能力包）——请改一个别的名字`,
            )
          }
          taken.add(def.name)
          tools.push({ capability: name, def })
        }
      },
      destructiveGate: 'host',
      onDispose: (fn) => {
        disposers.push({ capability: name, fn })
      },
    }
  }

  return {
    async mount(cap, config, declared) {
      if (mounted.has(cap.name)) {
        throw new Error(`能力 "${cap.name}" 已经挂过了——同名能力只能有一个`)
      }
      mounted.add(cap.name)
      if (declared?.credentials?.length) credentials.set(cap.name, [...declared.credentials])
      const ctx = contextFor(cap.name)
      try {
        await cap.mount(ctx, (config ?? {}) as Record<string, unknown>)
      } catch (err) {
        // 回滚：这个包在抛错之前登记的工具 / 服务 / 收摊函数一起撤掉（见头注第 3 条）。
        // 服务那一格由 `dropCapability` 按 `provided` 表撤——和单个能力正常 `dispose()` 同一条路，
        // 两处分头实现过一次，结果是正常收摊那一档漏掉了服务。
        await runDisposers(disposers.filter((d) => d.capability === cap.name))
        dropCapability(cap.name)
        mounted.delete(cap.name)
        throw err
      }
      const own = tools.filter((t) => t.capability === cap.name).map((t) => t.def.name)
      return {
        name: cap.name,
        tools: own,
        dispose: async () => {
          if (!mounted.has(cap.name)) return
          mounted.delete(cap.name)
          await runDisposers(disposers.filter((d) => d.capability === cap.name))
          dropCapability(cap.name)
        },
      }
    },
    toolDefs: () => tools.map((t) => t.def),
    toolsByCapability: () => {
      const out: Record<string, string[]> = {}
      for (const t of tools) (out[t.capability] ??= []).push(t.def.name)
      return out
    },
    credentialDomains: () => {
      const out = new Set<string>()
      for (const list of credentials.values()) {
        for (const d of list) {
          const n = d.trim().toLowerCase().replace(/^\.+/, '')
          if (n) out.add(n)
        }
      }
      return [...out].sort()
    },
    provide: (service, value) => provide(service, value, 'stream'),
    dispose: async () => {
      const all = disposers.splice(0)
      mounted.clear()
      tools.splice(0)
      credentials.clear()
      provided.clear()
      // 服务总线也清空。留着它 = 收摊之后 `require('streamBrowserCookies')` 仍拿得到一个
      // 指向已关停的中继的对象，而且下一轮 `provide` 同名会被判成"已经有主人了"——
      // 一个进程内重建 host 的场合（测试、热重启）会因此在第二次 provide 上直接抛。
      services.clear()
      await runDisposers(all)
    },
  }
}
