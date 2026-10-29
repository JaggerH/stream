/**
 * Stream 的库入口（openspec `embeddable-engine`）：给一个数据目录，回一份 Stream 实例。
 *
 * 它**不读环境变量、不监听端口、不注册进程信号**——那些是进程入口（`serve.ts`）的事：读环境 → `createStream()`
 * → 挂 HTTP → 监听。所以同一个进程里可以起多份（各自一个数据目录），也可以嵌进别的进程里用。
 *
 * 环境变量的翻译在 `src/config-env.ts`；本文件可达的模块不许出现 `process.env`
 * （`src/engine/no-process-env.guard.test.ts` 钉着，白名单只减不增）。
 */
import { join } from 'node:path'
import type { Context } from 'cordis'
import { bootstrap, deploymentFromEnv, readConfig, resolveDataDir, type BootOptions, type Logger } from '../bootstrap.ts'
import { createKernel, quiesceKernel } from '../kernel/context.ts'
import type { AppConfig } from '../types.ts'
import { lockDataDir } from './data-dir-lock.ts'
import { loadOrCreateApiToken, loadOrCreateExtToken } from '../http/secrets.ts'
import { createRuntime, type StreamRuntime } from './runtime.ts'
import { openDevices, wireDeviceChanges, type StreamDevices } from './devices.ts'
import { createCapabilities, loadOptional, provideBrowserCookies, type StreamCapabilities } from './capabilities.ts'
import { TaskCenter } from '../tasks/center.ts'
import type { TaskSettledEvent } from '../tasks/types.ts'
import { lazyNotify, type EventsService } from '../events/service.ts'
import type { StandbyManager } from '../plugins/standby/manager.ts'
import { startBackground } from './background.ts'
import { callerFetchGuardPolicy, configureCallerFetchGuard } from '../net/caller-fetch-guard.ts'

export type { StreamRuntime } from './runtime.ts'
export { createRuntime } from './runtime.ts'
export type { StreamDevices, DeviceChange, DeviceSnapshot } from './devices.ts'
export { deviceGateway } from './device-gateway.ts'
export type { DeviceGateway, DeviceGatewayOptions } from './device-gateway.ts'
export type { StreamCapabilities } from './capabilities.ts'
export type { StreamTools, ToolAnnotations, ToolCallContext, ToolDescriptor, ToolProgress, ToolResult } from './tools.ts'
import { createTools, type StreamTools } from './tools.ts'

/** 宿主层递进来的回调：实例往外推东西（ws 广播、调试总线、归因、任务结果）只经这几个口，自己不持有任何连接。 */
export type StreamHostHooks = Pick<
  BootOptions,
  'onItem' | 'onDebug' | 'broadcast' | 'track' | 'trackSync' | 'mcpEndpoint' | 'secretSource'
> & {
  /** 这个实例里每条调度任务每次运行结束（成功/失败）时调用。回调抛错只记日志，不影响任务。 */
  onTaskSettled?: (e: TaskSettledEvent) => void
}

export interface CreateStreamOptions {
  /** 实例的根目录（与 `STREAM_DATA_DIR` 同义：`config.yaml` 在它下面，可写状态在它的 `data/` 下）。 */
  dataDir: string
  /** 缺省 = 读 `<dataDir>/config.yaml`（没有就全用代码默认）。**不做环境回落**：要环境变量的调用方自己翻译好再传。 */
  config?: AppConfig
  log?: Logger
  /** 进程级共享资源（D4）。不传 = 自建一份，`close()` 时一起关。 */
  runtime?: StreamRuntime
  hooks?: StreamHostHooks
}

export interface Stream {
  /** 这份实例的内核（cordis 根 context）。服务全部住在它上面。 */
  readonly kernel: Context
  readonly config: AppConfig
  /** 可写状态的根（`resolveDataDir(config)`），数据目录锁就拿在这里。 */
  readonly stateDir: string
  readonly runtime: StreamRuntime
  /** 设备 / 节点 / 身份表（执行位置的真相源）。 */
  readonly devices: StreamDevices
  /** 实例的两把令牌（落在可写状态目录，0600，重启不变）。 */
  readonly secrets: StreamSecrets
  /** 能力包宿主与已装载的可选包。 */
  readonly capabilities: StreamCapabilities
  /** 工具目录的进程内接口（D3）：与 MCP 端点同一份工具、同一套结果。 */
  readonly tools: StreamTools
  /** 这份实例的调度中心（账本在可写状态目录下的 `sidequest.sqlite`）。`close()` 先停它。 */
  readonly tasks: TaskCenter
  /** 撤掉内核上的全部 effect（库句柄、定时器、子进程、采集标签的归还），放掉数据目录锁。幂等。 */
  close(): Promise<void>
}

export interface StreamSecrets {
  /**
   * 扩展 / 本机进程中继的共享 secret。**实例从不把它发出去**：扩展经 native messaging 让本机进程读同一个文件自取，
   * 后端只在 `/api/ext/verify` 上用它签一条 proof 自证身份。
   */
  extToken: string
  /**
   * `/api/*` 与 `/ws` 的访问令牌。**默认就有**（没配 `api_token` 时自动生成一份持久的）：后端绑 0.0.0.0 是有意的
   * （用户要从手机访问），那就必须有一把默认的锁。本机 loopback 免密（判据见 http/access-guard.ts）。
   */
  apiToken: string
}

export async function createStream(opts: CreateStreamOptions): Promise<Stream> {
  // 缺省配置：数据目录当 `STREAM_DATA_DIR` 用来定 config.yaml 与可写状态的位置；部署开关全按默认、没有环境回落。
  // 缺省配置：数据目录当 `STREAM_DATA_DIR` 用来定 config.yaml 与可写状态的位置。
  // 不读进程环境（deploymentFromEnv 只见这里显式给的 env）；config.yaml 里的 deployment
  // 键照读——嵌入方写文件关掉开箱订阅，就是走的这一格。
  const config = opts.config ?? readConfig(join(opts.dataDir, 'config.yaml'), { STREAM_DATA_DIR: opts.dataDir })
  // caller-fetch-guard 的进程级策略位：配置解析一次，名单写错在装配期就炸出来（缺省 = null = 关闭，
  // 所有抓取路径与没有这条配置时逐字节一致）。开关状态是进程级部署配置，不是实例级业务数据。
  // 只开不关：同一进程里后建的实例没写这一项，不能把先建的实例打开的守卫悄悄关掉。
  const guardPolicy = callerFetchGuardPolicy(config.caller_fetch_guard)
  if (guardPolicy) configureCallerFetchGuard(guardPolicy)
  const stateDir = resolveDataDir(config)
  // 锁拿在建内核之前：第二份实例连一张表都不该打开。
  const release = lockDataDir(stateDir)
  const secrets: StreamSecrets = {
    extToken: loadOrCreateExtToken(stateDir),
    apiToken: config.api_token || loadOrCreateApiToken(stateDir),
  }
  const ownsRuntime = !opts.runtime
  const runtime = opts.runtime ?? createRuntime()
  const kernel = createKernel()
  // 进程兜底网（runtime 持有）接住的异常落成本实例的通知。现取事件层：它比这里晚装配。
  const detachNotify = runtime.attachNotify(lazyNotify(() => kernel.streamEvents as EventsService | undefined))
  const log = opts.log ?? console.error
  const line = (l: string) => log(l)
  let devices: StreamDevices
  let capabilities: StreamCapabilities
  const tasks = new TaskCenter()
  // 宿主想知道任务结果：job 运行时经路由表够到本实例，运行结束的事实从那儿折回（见 center.emitSettled）。
  tasks.onTaskSettled = opts.hooks?.onTaskSettled
  // standby 管理器共享槽：后台接线写，实例关停（close）读。
  const standby: { current: StandbyManager | null } = { current: null }
  let closing: Promise<void> | undefined
  try {
    devices = openDevices(stateDir, kernel, log)
    capabilities = createCapabilities(stateDir, kernel, line)
    await bootstrap(config, log, {
      ...opts.hooks,
      kernel,
      runtime,
      // 「该同步哪些 cookie 域」的第三个来源：已挂能力包自己申报的那些。**现取**——可选包在 bootstrap 之后才装载，
      // 取快照等于永远只认内置那半，而漏一个域的表现是那个包每次都拿到空 cookie，和"用户没登录"一字不差。
      extraCookieDomains: () => capabilities.host.credentialDomains(),
      facilityDevices: devices.facilityBindings,
      extBindings: devices.extBindings,
      ...(devices.nodes ? { nodes: devices.nodes } : {}),
      ...(devices.identities ? { identities: devices.identities } : {}),
    })
    provideBrowserCookies(capabilities, kernel, line)
    // 设备 / 绑定的上下线事件（openspec embeddable-device-gateway）：两条中继注册表随 harvest 域
    // 在 bootstrap 里装配好，这里把它们的连接事件折进 `stream.devices.onChange`。
    wireDeviceChanges(devices, kernel.harvest, line)
    await loadOptional(capabilities, stateDir, config, line)
    const instance: Stream = {
      kernel,
      config,
      stateDir,
      runtime,
      devices,
      secrets,
      capabilities,
      tools: createTools(kernel, capabilities),
      tasks,
      close: () => closing ??= (async () => {
        try {
          // 先停调度中心：它的 job 读内核上的服务，内核撤完再跑就是对着关掉的库干活。
          await tasks.stop()
          // standby 的 reaper 随调度中心停了；管理器在这里收尾（容器 cell 落盘、撤销 adopt）。
          if (standby.current) await standby.current.shutdown().catch(() => {})
          await quiesceKernel(kernel)
        } finally {
          detachNotify()
          release()
          if (ownsRuntime) await runtime.close()
        }
      })(),
    }
    // 后台工作随实例启动（design D1 附注）：不调 routes() 的嵌入方拿到的也是一份会自己动的
    // 实例——订阅按时采集、任务按点跑。这一步抛错走下面的装配失败路径统一回收。
    await startBackground(instance, opts.hooks, line, standby)
    return instance
  } catch (e) {
    // 装到一半失败：已经挂上的那部分照样要撤，锁照样要放——否则同一个目录再也起不来。
    if (standby.current) await standby.current.shutdown().catch(() => {})
    await quiesceKernel(kernel).catch(() => {})
    detachNotify()
    release()
    if (ownsRuntime) await runtime.close().catch(() => {})
    throw e
  }
}
