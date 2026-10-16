/**
 * 「环境没就绪，这一轮压根没跑」——**不是关于源的任何判断**。
 *
 * 典型场景：ext-cdp 档的采集需要用户的 Chrome 连着中继，而用户晚上关了电脑。此时 recipe 一步
 * 都没执行，我们对这个源一无所知：它既没成功也没失败。
 *
 * **为什么必须和普通失败分开**：普通失败会记进 health、掉档、点亮告警——那是在说"这个源有问题"。
 * 把"浏览器没开"记成源的失败，等于一夜没开电脑、第二天所有 ext-cdp 的源全是红的，而它们一个毛病
 * 都没有。反过来记成成功更糟：那会把一个真的坏掉的源永久掩盖。**正确答案是第三种：什么都不记。**
 *
 * **判据宁窄勿宽。** 只有"确定没跑成"才算——`ExtRelayDisconnected`（socket 为 null，命令根本没发出去）
 * 算；`ExtRelayTimeout` **不算**（那是连着的、某条命令挂了，可能是真故障，吞掉它会藏住 bug）。
 *
 * **为什么住在 `shared/failure/` 而不是 `src/failure.ts`**：`src/failure.ts` 为了 `classifyError`
 * 的嗅探值引用了 replay 引擎，谁 import 它就把整条引擎（含 compute-sandbox / browser-drive）
 * 拖进自己的运行时闭包。中继（`shared/browser-relay/relay.ts`）只需要这一个错误类，却因此背上
 * 30 个模块——那正是「插件能不能 import 这个库」卡住的地方。这个文件是叶子：零 import。
 */
export class EnvironmentUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvironmentUnavailableError'
  }
}

/**
 * 不继承本类、但同样「确定没跑成」的错误，靠声明这个标记加入（如设备离线 `DeviceOffline`、
 * 设备排队超时 `DeviceFetchQueueTimeout`——请求一帧都没发出）。**不走继承**：那些错误各有自己的
 * 类层次（`DeviceError`），继承这里会把重试语义、`blockedOf` 的分支顺序一起搅乱
 * （`CoolingDownError` 继承本类，就曾被报成"扩展没连接"）。
 */
export interface DeclaresEnvironmentUnavailable {
  readonly environmentUnavailable: true
}

/** 这次失败是不是"环境没就绪"——调度侧据此跳过本轮而不是判故障。 */
export function isEnvironmentUnavailable(e: unknown): boolean {
  if (e instanceof Error && (e as Partial<DeclaresEnvironmentUnavailable>).environmentUnavailable === true) return true
  return e instanceof EnvironmentUnavailableError
}
