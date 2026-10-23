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
import { createRuntime, type StreamRuntime } from './runtime.ts'

export type { StreamRuntime } from './runtime.ts'
export { createRuntime } from './runtime.ts'

/** 宿主层递进来的回调：实例往外推东西（ws 广播、调试总线、归因）只经这几个口，自己不持有任何连接。 */
export type StreamHostHooks = Pick<
  BootOptions,
  'onItem' | 'onDebug' | 'broadcast' | 'track' | 'trackSync' | 'mcpEndpoint' | 'extraCookieDomains'
>

export interface CreateStreamOptions {
  /** 实例的根目录（与 `STREAM_DATA_DIR` 同义：`config.yaml` 在它下面，可写状态在它的 `data/` 下）。 */
  dataDir: string
  /** 缺省 = 读 `<dataDir>/config.yaml`（没有就全用代码默认）。**不做环境回落**：要环境变量的调用方自己翻译好再传。 */
  config?: AppConfig
  log?: Logger
  /** 进程级共享资源（D4）。不传 = 自建一份，`close()` 时一起关。 */
  runtime?: StreamRuntime
  hooks?: StreamHostHooks
  /** 搬迁期过渡口：`serve.ts` 还有装配块在 `createStream` 之前要用到内核时传它自己建的那棵。 */
  kernel?: Context
  /** 搬迁期过渡口：设备 / 节点 / 身份表（D1 的 `devices`），见 tasks.md 1.4 的剩余项。 */
  boot?: Pick<BootOptions, 'facilityDevices' | 'extBindings' | 'nodes' | 'identities'>
}

export interface Stream {
  /** 这份实例的内核（cordis 根 context）。服务全部住在它上面。 */
  readonly kernel: Context
  readonly config: AppConfig
  /** 可写状态的根（`resolveDataDir(config)`），数据目录锁就拿在这里。 */
  readonly stateDir: string
  readonly runtime: StreamRuntime
  /** 撤掉内核上的全部 effect（库句柄、定时器、子进程、采集标签的归还），放掉数据目录锁。幂等。 */
  close(): Promise<void>
}

export async function createStream(opts: CreateStreamOptions): Promise<Stream> {
  // 缺省配置：数据目录当 `STREAM_DATA_DIR` 用来定 config.yaml 与可写状态的位置；部署开关全按默认、没有环境回落。
  const config = opts.config ?? {
    ...readConfig(join(opts.dataDir, 'config.yaml'), { STREAM_DATA_DIR: opts.dataDir }),
    deployment: deploymentFromEnv({}),
  }
  const stateDir = resolveDataDir(config)
  // 锁拿在建内核之前：第二份实例连一张表都不该打开。
  const release = lockDataDir(stateDir)
  const ownsRuntime = !opts.runtime
  const runtime = opts.runtime ?? createRuntime()
  const kernel = opts.kernel ?? createKernel()
  try {
    await bootstrap(config, opts.log ?? console.error, { ...opts.hooks, ...opts.boot, kernel })
  } catch (e) {
    // 装到一半失败：已经挂上的那部分照样要撤，锁照样要放——否则同一个目录再也起不来。
    await quiesceKernel(kernel).catch(() => {})
    release()
    if (ownsRuntime) await runtime.close().catch(() => {})
    throw e
  }
  let closing: Promise<void> | undefined
  return {
    kernel,
    config,
    stateDir,
    runtime,
    close: () => closing ??= (async () => {
      try {
        await quiesceKernel(kernel)
      } finally {
        release()
        if (ownsRuntime) await runtime.close()
      }
    })(),
  }
}
