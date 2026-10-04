import type { PluginDescriptor } from '../types.ts'
import type { PluginNetMode } from '../plugin-target.ts'
import { resolveDockerEndpoint, makeDockerClient, type DockerClient, type DockerEndpoint } from './docker-api.ts'
import { makeStandbyManager, type StandbyManager, type StandbyManagerDeps } from './manager.ts'
import { planStandbyServices, standbyManagingLabel } from './service-list.ts'
import { setStandbyManager } from './hook.ts'

/**
 * inert 的三条出口,**各自有名字**。
 *
 * 为什么不能只返回一个光秃秃的 `manager: null`:调用方要据此决定**喊不喊人**,而这三条的
 * 性质完全不同——`docker-unreachable` 是外部事故(所有带容器的插件一起失效,该喊),另外两条
 * 是按设计如此(桌面档没有容器门、这台机器就没有插件声明 standby;喊了只会教用户忽略通知)。
 * 原因在这个函数内部丢掉,这个区分就永远没法在外面做。
 *
 * 2026-09-02 活体撞到的正是它:Docker 引擎挂着的窗口里重启后端,全站网盘搜索静默归零
 * (pansou/alist 取址恒空),唯一的线索是一行没人看的启动日志。
 */
export type StandbyInertReason =
  /** 两道构造闸没过:没插件声明 standby,或网络形态够不着容器。**按设计如此,不是故障。** */
  | 'not-gated'
  /** 声明了 standby,但 Docker 端点解不出 / ping 不通。**外部事故。** */
  | 'docker-unreachable'
  /** 声明了 standby,但一个 target 都解不出(今天走不到,守类型契约)。 */
  | 'no-resolvable-services'

export interface StandbyWiring {
  /** 接线成功时的管理器;任何一道闸没过 → null(standby inert,容器保持常驻)。
   *  reaper 轮次不再由这里自建的裸定时器驱动——已收编进调度中心的 standby-reaper 任务
   *  （src/tasks/builtin.ts），按 TaskDeps.standbyManager.tick() 定期调用。 */
  manager: StandbyManager | null
  /** manager 为 null 时**必有**;接上了就没有这个字段。 */
  inertReason?: StandbyInertReason
  /** 本次 inert 让哪些 service 失去了唤醒(报给用户时用来说清影响面)。
   *  `not-gated` 时天然为空——那一档本来就没有 standby 服务。 */
  affected?: string[]
}

export interface StandbyWiringDeps {
  /**
   * **合并名单**（内置 + 用户装的第三方，`BackendDirectory.all()`），不是只有内置那层。
   *
   * 为什么第三方必须也在里面：`src/packages/container-policy.ts` 给第三方兜了
   * `standby: { idleMinutes: 30 }`，而这个数会出现在安装确认页上——那是对用户的一句承诺。
   * 名册只吃内置那一层的话，第三方容器建起来就一直跑：没有 cell、没有 reaper、
   * `withAwake` 也认不出它，而**任何日志和界面都不会提到这件事**。
   *
   * 重名（第三方 service 名 = 包 id，与内置撞）在名册构造期抛（manager.ts）。**那一抛不掀翻
   * 启动**：serve.ts 的 `buildStandbyOrDegrade` 把它降级成一行日志，代价是**全体** standby
   * 失效（所有插件容器不再回收/唤醒）。所以真正承重的是安装期那道闸（`withInstalled` 把已装
   * 第三方的 service 名并进占用表），这里只是最后一道、且它的失败是静默的。
   */
  descriptors: PluginDescriptor[]
  mode: PluginNetMode
  isEnabled: (p: PluginDescriptor) => boolean
  /** 下面这些默认就是生产实现;全部可注入,因为这段接线过去是 serve.ts 里的匿名闭包、谁都测不到。 */
  resolveEndpoint?: () => DockerEndpoint | null
  makeClient?: (ep: DockerEndpoint) => DockerClient
  makeManager?: (deps: StandbyManagerDeps) => StandbyManager
  setHook?: (m: StandbyManager | null) => void
  log?: (msg: string) => void
  /** 注入点,理由同 service-list.ts 自己的 resolveTarget:下面两条防御分支(有 skipped、
   *  services 全空)**通过真实 planner 走不到**——声明了 backend.standby 的 descriptor 必然带
   *  backend,resolvePluginTarget 就一定解得出 origin。它们守的是 `string | null` 这个类型契约
   *  哪天真的落到 null 的那一天。要测它们只能从这里换掉 planner;靠拧夹具去"假装"够到一个
   *  不可达状态,测的就不是真东西了。 */
  planServices?: typeof planStandbyServices
}

/**
 * standby 的全部接线:算计划 → 解 Docker 端点 → ping → 造管理器 → 接 hook → adopt。
 * reaper 轮次不在这里 arm——已收编进调度中心的 standby-reaper 任务（src/tasks/builtin.ts）。
 *
 * 为什么它必须是一个**能被单独调用的函数**,而不是 serve.ts 里那段 inline 闭包:整段逻辑的安全属性
 * 是"任何构造失败都降级成一行日志 + standby inert,绝不掀翻 main()",而这个属性只有在 adopt()
 * **待在受保护区里面**时才成立。它过去待在一个匿名闭包里,没有任何测试能拿到——
 * 把 adopt() 挪到 buildStandbyOrDegrade 外面,「配置错掀翻开机」会悄悄回来而套件全绿。
 * 抽出来之后,wire.test.ts 直接对着这些失败路径断言。
 *
 * 契约:失败**照抛**(端点解不出 / ping 不通这类"预期内的没有 Docker"除外,那是 inert 不是失败)。
 * 降级由调用方的 buildStandbyOrDegrade 负责——两件事分家,这里只管接线是否成立。
 */
export async function wireStandby(deps: StandbyWiringDeps): Promise<StandbyWiring> {
  const log = deps.log ?? ((m: string) => console.log(m))
  const inert = (reason: StandbyInertReason, affected: string[] = []): StandbyWiring =>
    ({ manager: null, inertReason: reason, ...(affected.length ? { affected } : {}) })

  const plan = (deps.planServices ?? planStandbyServices)({
    descriptors: deps.descriptors,
    mode: deps.mode,
    isEnabled: deps.isEnabled,
  })
  // 两道构造闸(见 service-list.ts):没插件声明 standby,或网络形态不是 compose。
  // 没过就连 Docker 端点都不该去解析。
  if (!plan.gated) return inert('not-gated')

  const ep = (deps.resolveEndpoint ?? (() => resolveDockerEndpoint(process.env, process.platform)))()
  const docker = ep ? (deps.makeClient ?? makeDockerClient)(ep) : null
  // Docker 端点解析不出 / ping 不通 → 只打一行日志、不接线 —— 容器保持常驻,绝不能让插件调用
  // 因为 standby 探测失败而跟着炸(降级是这个特性的核心安全属性,不是可选项)。
  //
  // 但**降级不等于闭嘴**:这一档下所有带容器的插件都不再被唤醒,而它们的失败形状是
  // 「取址答空 → base 变空串 → 一句 Failed to parse URL」,没有任何一处会说出真正的原因。
  // 原因带出去交给调用方(serve.ts)喊人,见 StandbyInertReason 的头注。
  if (!docker || !(await docker.ping())) {
    log('[standby] docker API unreachable — standby disabled, containers stay resident')
    return inert('docker-unreachable', plan.services.map((s) => s.service))
  }

  if (plan.skipped.length > 0) log(`[standby] skipping (no resolvable target): ${plan.skipped.join(', ')}`)
  if (plan.services.length === 0) {
    // 每个声明了 standby 的插件都没能解出 target——没有 cell 可管,接一个空管理器只会白白 arm
    // 一个永远无事可做的 60s 定时器、把 hook 指向一个 snapshot() 恒为空的对象。
    log('[standby] no resolvable services — standby inert this boot')
    return inert('no-resolvable-services')
  }

  const manager = (deps.makeManager ?? makeStandbyManager)({ docker, services: plan.services })
  const setHook = deps.setHook ?? setStandbyManager
  // hook 先接、再 adopt:adopt 要逐个查 Docker,期间到达的请求必须已经能看到管理器,
  // 否则它们会打在一个还没被收养、可能已停的容器上。
  setHook(manager)
  try {
    await manager.adopt()
    log(`[standby] managing: ${standbyManagingLabel(plan)}`)
    return { manager }
  } catch (e) {
    // adopt 半路抛:hook 已经指向这个管理器了,必须复位,否则后续 withAwake 会打在一个
    // 收养到一半、状态不完整的管理器上。
    setHook(null)
    throw e
  }
}
