import type { PluginDescriptor } from './types.ts'
import type { StandbyHooks } from './standby/hook.ts'

/** 后端所在网络形态：compose=与插件同 stream 内网、可直连容器 DNS；host=后端在宿主上、
 *  经 loopback 随机口进容器（「一扇门」，spec 2026-07-22-host-plugin-door）；none=够不着，全关。
 *  值来自 `AppConfig.deployment.plugin_network`（`STREAM_PLUGIN_NETWORK` 的翻译在 bootstrap），不读 env。 */
export type PluginNetMode = 'compose' | 'host' | 'none'

export function pluginNetMode(env: NodeJS.ProcessEnv): PluginNetMode {
  const v = env.STREAM_PLUGIN_NETWORK
  return v === 'compose' ? 'compose' : v === 'host' ? 'host' : 'none'
}

/** 后端转发 / 自 fetch 一个插件用的完整 origin。compose 形态从 descriptor 推容器 DNS
 *  `http://<service>:<port>`；none（桌面无门）一律 null → 调用方不注册 /_p、核心照跑。
 *  与「客户端拿到的根相对 /_p/<service>」（pluginGatewayUrl）分家，消 base 一身二用。 */
export function resolvePluginTarget(
  service: string,
  opts: { descriptors: PluginDescriptor[]; mode: PluginNetMode },
): string | null {
  // host 档静态解析不可能:随机宿主口是容器 start 时才分配的,停着时不存在。
  // 动态解析走 standby Cell 缓存(本文件 StandbyHooks.origin),bootstrap 按档选 resolver。
  if (opts.mode !== 'compose') return null
  const d = opts.descriptors.find((p) => (p.backend?.service ?? p.id) === service || p.id === service)
  if (!d?.backend) return null
  const name = d.backend.service ?? d.id
  return `http://${name}:${d.backend.port}`
}

// 「内置 + 第三方」的合并名单不住在这里：它是 `BackendDirectory`
// （`src/kernel/plugins/backend-directory.ts`），全仓只合并一次、四个消费点共用同一份引用。

/**
 * 一个实例的后端取址服务（`ctx.packages.targets`，`src/kernel/plugins/packages.ts` 装配）。
 *
 * 过去 resolver 与 miss reporter 住在模块级变量里，由 bootstrap 启动时绑一次——同进程跑第二个
 * 实例时两个内核读写的是同一对全局，互相污染且无法区分「接对了」和「读到残留」。现在两个实例
 * 各持一份：resolver / 喊声出口与 standby 钩子（`StandbyHooks`，host 档的动态取址与唤醒都在
 * 里面）同生共死，随内核 dispose 复位为 null。
 *
 * 未接线（单测 / stdio / 内核还没装配完）时 `target()` 一律 null，等价 mode=none。
 *
 * 传 `null` 复位（内核销毁时 `bindModuleHook` 的 disposer 走这条）。
 */
export class PluginTargets {
  private resolver: ((service: string) => string | null) | null = null
  private missReporter: ((service: string) => void) | null = null

  constructor(readonly standby: StandbyHooks) {}

  /** packages 域在 descriptors 加载完毕后绑一次；内核 dispose 时经 bindModuleHook 复位。 */
  bind(resolver: ((service: string) => string | null) | null, missReporter: ((service: string) => void) | null): void {
    this.resolver = resolver
    this.missReporter = missReporter
  }

  /** 只读探测：现在接上了吗。给启动完成处的「hooks unbound」那一行用（module-hooks.ts）。 */
  get bound(): boolean {
    return this.resolver !== null
  }

  /** 取址的两种意图。**只影响喊不喊，不影响答什么**。 */
  target(service: string, opts?: { peek?: boolean }): string | null {
    const target = this.resolver ? this.resolver(service) : null
    if (!target && !opts?.peek && this.missReporter) {
      // 观测出问题绝不能反过来打死主链路：reporter 抛什么都吞掉，照常返回 null。
      try {
        this.missReporter(service)
      } catch {
        /* 记录现场失败了就失败了,取址该答什么还答什么 */
      }
    }
    return target
  }
}

/**
 * 「答空了」的喊声出口（spec `2026-08-19-plugin-target-empty-observability-design.md`）。
 *
 * 答空是**静默的失败**：调用方一律 `?? ''`，于是 base 变空串，错误在下游变成一句
 * `Failed to parse URL from /api/...`——里面没有任何能分诊的东西（容器在不在？standby 认为它
 * 什么状态？inspect 出来的口是多少？）。2026-08-15 一个窗口内 6 条抖音 item 就是这么废的。
 *
 * **这一层不收集事实**：它只知道自己接没接线，别的一概不知。事实收集在
 * `src/kernel/plugins/packages.ts`（那里同时握着 netMode / backendDirectory / standby hook），
 * 分类与渲染在 `src/plugins/target-miss.ts`。与 resolver 同生共死。
 */
export interface PluginTargetOpts {
  /**
   * 窥视：**只是问一句地址，并不打算用它**——状态面板逐个插件取址只为显示、`available()` /
   * `configured()` 这类纯探测。host 档下 standby 管着的容器闲置就 stop，停着时没有 loopback
   * 宿主口，所以这类问法**答空是正确答案**，不是故障。
   *
   * 为什么必须分档：`plugin-target` 频道要抓的是「真要用它却拿不到地址」。2026-08-24 起的 777 条
   * 现场里 777 条来自窥视、0 条来自消费路径（消费一律先 `withAwake` 再取址，容器已醒 → 答得出来），
   * 信噪比 777:0，频道被淹。窥视档只掐掉喊声。
   *
   * **全部取址点的归类**（加一个新调用点就加一行；漏一处的表现是频道又被噪音淹，不报错）：
   * | 调用点 | 归类 |
   * |---|---|
   * | `src/plugins/status.ts` | **探测** → peek（`/api/plugins`、`/api/packages` 每次打开逐个取址，只为显示） |
   * | `src/voiceprint/engine-client.ts` `configured()` | **探测** → peek（`identifyReady` → `/api/conversion-kinds` 每次问一遍） |
   * | 同文件 `base` getter | 消费（在 `withAwake` 回调里求值，容器已醒；答空是真故障） |
   * | `src/docparse/client.ts` `resolveMineruUrl` | 消费（`MineruClient` 的 base/mode 读它，真要 parse 时才求值） |
   * | `src/kernel/plugins/conversions.ts` `mineruInstalled` | **探测** → peek（`/api/conversion-kinds` 每次问一遍 OCR 梯子亮不亮；且先问 `standbyManaged('mineru')`，管着就不取址——下面那条形状的现成实例） |
   * | `src/netdisk/alist-client.ts` `resolveAlistUrl` | 消费（`hostAlistClient` 取数、bootstrap 接管前打 `/ping`，都真发请求） |
   * | `src/kernel/plugins/packages.ts` `backendUrl` | 消费（交给包自己拿去 fetch 的 thunk；包的 adapter 在自己的 `baseUrl` getter 里、`withAwake` 回调内每次请求现取） |
   *
   * 一条已经吃过亏的形状：「配置了吗」这类早退门写成 `!deps.xxxUrl && !standbyManaged(...)`——`&&`
   * 左边先求值，于是每次都真去取一次址（2026-08-26→08-29 的 18 条现场里 15 条是这么来的，全部
   * `not-awake` 且「standby 管着它」）。**归类成「探测」是不够的**：peek 只掐喊声，而这道门连地址
   * 都不需要。要写这样的门，把 url 收成 thunk、先问 `standbyManaged(...)` 再求值 url
   * （`standbyManaged(svc) || Boolean(url())`，顺序即判据）——standby 管着就根本不去读地址。
   * 宿主里这样的门只有 conversions 域的 `mineruInstalled`（带容器的包在自己的 adapter 里用
   * `ctx.backendUrl` 现取），下一个要写的人照这个形状写、并给它一条钉顺序的测试。
   */
  peek?: boolean
}
