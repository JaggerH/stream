/**
 * 实例的工具接口（D3）：`stream.tools.list()` / `call()`。与 `/api/mcp` 是**同一份**——同一个 service、同一份
 * `mcpExtras`、同一个能力包宿主，经 `tool-registry.ts` 的 `toolSpecs` 出去；MCP 端点只是它外面的协议层。
 *
 * 两格都按**引用**取、不取快照：`mcpExtras` 里有按域可用性现算的 getter，能力包在运行期装卸——`withCapabilityTools`
 * 用原型委托而不是 spread，理由同 `serve.ts` 挂 MCP 那一处。
 */
import type { Context } from 'cordis'
import type { AgentDomain } from '../kernel/plugins/agent.ts'
import { withCapabilityTools } from '../mcp/capability-tools.ts'
import { createStreamTools, type StreamTools } from '../mcp/tool-registry.ts'
import type { StreamCapabilities } from './capabilities.ts'

export type {
  StreamTools,
  ToolAnnotations,
  ToolCallContext,
  ToolDescriptor,
  ToolProgress,
  ToolResult,
} from '../mcp/tool-registry.ts'

export function createTools(kernel: Context, capabilities: StreamCapabilities): StreamTools {
  return createStreamTools(
    kernel.scheduling.service,
    withCapabilityTools((kernel.agent as AgentDomain).mcpExtras, () => capabilities.host.toolDefs()),
  )
}
