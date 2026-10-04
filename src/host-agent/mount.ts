/**
 * Stream 后端自己养 Stream Desktop 的本机进程（可执行文件 `stream-desktop`）。
 *
 * **目录名 `host-agent` 是纯内部路径**（用户看不见），2026-09-07 那轮统一没跟着改。对外的那批
 * 名字全是 `desktop`：`stream-desktop` / `com.stream.desktop` / `@streamapp/desktop-<平台>` /
 * `STREAM_NO_DESKTOP`。它们是**线上常量**——写进配对过的机器上的浏览器 native messaging 清单与
 * 注册表，改了要让每台机器重新 `--register` 一次，不重配就静默失联（扩展拿不到 relay token，
 * 还不报错）。
 *
 * **为什么住在后端进程里**：Chrome 扩展要和后端配对，先得经 native messaging 向它要
 * 一把 relay token（`extension/src/lib/pairing.ts`：拿不到 token 一个候选都不问，直接停在
 * never-seen，而且不报错）。agent 的登记与拉起原本由 Stream 托管的 DSH 里那个桌面插件做；
 * DSH 剥离之后（spec 2026-09-05-stream-stops-hosting-dsh）一台只装了 `@streamapp/stream` 的
 * 机器上没人再做这两件事，扩展永远配不上——活体 2026-09-06 在 win-test 上照 README 走到第一步
 * 就撞出来的洞。`/api/host` 的消费者是后端，谁消费谁养，所以这一格收回后端。
 *
 * 复用的是 `capabilities/desktop/src/host-agent/` 那份宿主中立的核心（登记 native
 * messaging、拉起、退避重启、WSL 下翻路径）。**翻译那一层不在这里**：后端把自己翻译成
 * `CapabilityContext` 的实现只有一份，住 `src/capabilities/host.ts`，内置的这半与用户
 * `stream add` 装进来的可选包走同一个 `mount()`（spec 2026-09-06 §2 不变量 3）。本文件只
 * 负责「Stream Desktop 这个能力用什么配置挂、起不来怎么办」。
 *
 * 二进制从哪来：`capabilities/desktop/src/host-agent/binary.ts` 先 `require.resolve` 本机的
 * 平台包（`@streamapp/desktop-{win32-x64,darwin-x64,darwin-arm64}`，都是发行包
 * `cli/package.json` 的 optionalDependency，bundle 后从 `cli/node_modules` 解出），解不到再退到
 * `capabilities/desktop/platforms/` 下的本地构建（开发检出）。两档都没有就只记一行 warn，
 * 后端照常起。
 *
 * **有二进制 ≠ 桌面控制能用。** mac 上这只手只做「配对」（native messaging + `--register` 写
 * 浏览器根与 `~/.stream/datadir` 指针 → 扩展拿得到 relay token → 采集带得上登录态），桌面控制
 * 仍然只有 Windows，所以非 Windows 平台跑完 `--register` 就收、不养常驻 agent。判据是那个文件
 * 的 `DESKTOP_CONTROL_PLATFORMS`。
 */
import type { Capability, CapabilityContext } from '../../shared/capability/types.ts'
import { mountHostAgent as mountHostAgentCore, type HostAgentConfig } from '../../capabilities/desktop/src/host-agent/index.ts'
import { createCapabilityHost, type CapabilityHost } from '../capabilities/host.ts'

export interface HostAgentMountOpts {
  /**
   * 挂它的那个宿主。**serve.ts 必须把后端那一个共享的 host 递进来**——它是能力之间那张
   * 服务总线（Stream Desktop 提供 `streamBrowserCookies`，netdisk require 它）与那张工具表的
   * 唯一持有者。不给就现建一个只养这一个能力的，用于单独调用与测试。
   */
  host?: CapabilityHost
  /** 后端自己那扇门，agent 经它的 `/api/host` 握手。 */
  baseUrl: string
  /** Stream 的 data 根：agent 从 `<根>/data/ext-relay-token` 读握手令牌（`datadir.rs` 两种含义都收）。 */
  dataDir: string
  /** 扩展的固定 id，写进 native messaging 清单的 `allowed_origins`。 */
  extensionId: string
  log: (msg: string) => void
}

/**
 * 三种不起：显式关掉（`STREAM_NO_DESKTOP=1`，比如同一台机器上已有别的宿主在养 agent，
 * 两个 agent 抢同一条 `/api/host` 只会互相踢）；查询档（`STREAM_NO_SCHEDULER=1`，stdio MCP
 * 即用即回收的后端不该在用户桌面上留一只手）；测试。
 * @returns 不起时给一句可以直接打进日志的理由。
 */
export function hostAgentSkipReason(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // 名字跟着那个二进制（`stream-desktop`）走。**只有这一个名字**——改名那次没给旧名留别名：
  // 两个开关意味着两份要同步的真相，而漏掉一个的表现是"关了却还是起来了"。旧名在仓库里
  // 一处都搜不到，由 `src/capability-names.guard.test.ts` 的 `LEGACY_AGENT_NAME` 钉着。
  if (env.STREAM_NO_DESKTOP === '1') return 'STREAM_NO_DESKTOP=1，本次不养 Stream Desktop 的本机进程'
  if (env.STREAM_NO_SCHEDULER === '1') return '查询档（STREAM_NO_SCHEDULER=1）不养 Stream Desktop 的本机进程'
  if (env.VITEST) return '测试进程不养 Stream Desktop 的本机进程'
  return undefined
}

/** Stream Desktop 在宿主里的能力名。日志前缀（`[stream-desktop]`，正好等于产品名）与
 *  `<dataDir>/capabilities/` 下的子目录都由它派生。 */
export const DESKTOP_CAPABILITY_NAME = 'desktop'

/**
 * 挂上 Stream Desktop 并交回一个收摊函数。mount 自己抛了也只记日志——它是可选能力，起不来不许
 * 拖垮后端启动（Stream Desktop 自己已经把三种「起不来」都降成 warn，这里再兜一层是为 spawn
 * 之外的意外）。
 * @param mountFn - 注入点，只为测试。
 */
export async function mountHostAgent(
  opts: HostAgentMountOpts,
  mountFn: (ctx: CapabilityContext, config: HostAgentConfig) => Promise<void> = mountHostAgentCore,
): Promise<() => Promise<void>> {
  const host = opts.host ?? createCapabilityHost({ dataDir: opts.dataDir, log: opts.log })
  const capability: Capability<HostAgentConfig> = { name: DESKTOP_CAPABILITY_NAME, mount: mountFn }
  try {
    const mounted = await host.mount(capability, {
      streamBaseUrl: opts.baseUrl,
      streamDataDir: opts.dataDir,
      extensionId: opts.extensionId,
    })
    return () => mounted.dispose()
  } catch (err) {
    opts.log(
      `[stream-${DESKTOP_CAPABILITY_NAME}] WARN mount 失败，桌面控制与扩展配对本次不可用：` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return async () => {}
  }
}
