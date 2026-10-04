/**
 * 渲染注册表的读口：把 `registry-table.json`（纯数据）读成有类型的行，并把 Stream 的
 * MCP 工具名翻成 DSH 那边的 wire 名。
 *
 * 表本身是 JSON 而不是 TS，因为它有**两个消费端**：这个包（决定注册哪几个渲染器），以及
 * Stream 主仓的 `src/mcp/dsh-ui-registry-parity.test.ts`（用 fs 读它，与真实 MCP 工具面做
 * 双向差集）。主仓那一端不能 import 本包的 TS 源码，所以真相必须落在一份两边都能读的文件里。
 */
import table from '../registry-table.json'

/** 一行的两种合法结论。「该做、这就补上」不是一个状态——补完就是 `custom`。 */
export type Treatment = 'custom' | 'generic'

/** 注册表的一行。 */
export interface RegistryRow {
  /** Stream 侧的 MCP 工具名（`extract`、`stream_subscribe`…），不带 wire 前缀。 */
  tool: string
  treatment: Treatment
  /** 为什么是这个结论。generic 行的理由是这条规则唯一的执行力所在。 */
  why: string
  /**
   * 缺省 = Stream 后端**核心面**上的 MCP 工具，任何一台跑着 Stream 的机器上都在。
   *
   * `'stream'` = 同样从 Stream 的 `/api/mcp` 出来（wire 名因此也是 `mcp__stream__<tool>`，
   * 与缺省那档**逐字相同**），但它来自一个**可选能力包**（`stream add @streamapp/<x>`）——
   * 用户没装那个包时这个工具根本不存在。所以这类行**不参与**与核心面的双向差集
   * （`src/mcp/dsh-ui-registry-parity.test.ts`：核心面天然没有它们，算进去就是一条必红的
   * 假警报），那边另有一条守卫钉它们必须是某个已知能力包真的注册的动词。
   */
  server?: 'stream'
}

/**
 * DSH 侧的 MCP server 名。**必须和 Stream 生成 DSH profile 时写进 mcp 配置的那个名字逐字
 * 相同**（期 A 的 `DshWorkbench` 把它钉成常量）：`dsh-mcp-client` 用 `mcp__<serverName>__<tool>`
 * 作为 wire 工具名，这个名字一分家，这里注册的每一个 key 都会静默落空——不报错，只是永远
 * 回落通用卡。
 */
export const STREAM_MCP_SERVER_NAME = 'stream'

/** Stream 工具名 → DSH wire 工具名（keyed slot 的 dispatch key）。 */
export function wireToolName(tool: string): string {
  return `mcp__${STREAM_MCP_SERVER_NAME}__${tool}`
}

/**
 * 这一行在 `tool.call.toolview` 槽里的 key = DSH 看到的工具名。
 *
 * **所有行都套 `mcp__stream__` 前缀**，包括可选能力包那几行：能力包唯一的归宿是被 Stream
 * 后端装载，它注册的动词和核心工具从同一个 `/api/mcp` 出去，DSH 看到的就是同一种 wire 名。
 * 前缀套错的表现是定制卡注册到一个永远不会出现的 key 上、静默回落通用卡，没有一处会喊——
 * 所以这个函数存在的意义是**只有一种答案**，而不是分档。
 */
export function slotKeyFor(row: Pick<RegistryRow, 'tool'>): string {
  return wireToolName(row.tool)
}

/** 全表，按 JSON 里的书写序。 */
export const registryRows: readonly RegistryRow[] = (table as { tools: RegistryRow[] }).tools

/** 只要定制卡那几行。 */
export const customRows: readonly RegistryRow[] = registryRows.filter((r) => r.treatment === 'custom')
