import Schema from 'schemastery'

/** config row 的 id，同时是 `/api/config/ai-agent` 的路径段。 */
export const AGENT_ROW_ID = 'ai-agent'

export interface AgentCommand { command: string; args: string[] }
export interface AgentGateLimits { turns: number; tokens: number; wallMs: number }
export interface AgentConfig { command: AgentCommand; limits: AgentGateLimits }

/**
 * 三闸默认值（spec §7.2）。**闸是兜底不是判据**：真正的停止条件是 agent 交出过校验的 v+1；
 * 这三个数只是防它跑飞。撞了进 `paused`，人点「继续」抬一档（见 gates.ts）。
 */
export const DEFAULT_LIMITS: AgentGateLimits = { turns: 12, tokens: 1_500_000, wallMs: 30 * 60_000 }

/**
 * 只有一个 `command` 字串，按空白切——**不支持引号**。要复杂参数的用户写一个包装脚本再填它：
 * 这里的取值就是 ACP registry 那几条（`npx -y @agentclientprotocol/claude-agent-acp`、
 * `gemini --experimental-acp`、`opencode acp`），没有一条需要引号。
 */
export const agentRowSchema = Schema.object({
  command: Schema.string().default('').description(
    '开发时用哪个 agent：一条 ACP agent 的启动命令，如 npx -y @agentclientprotocol/claude-agent-acp；留空 = 不介入，隔离只落通知',
  ),
  maxTurns: Schema.number().default(DEFAULT_LIMITS.turns).description('一次修复最多几轮对话（撞了暂停等你续）'),
  maxTokens: Schema.number().default(DEFAULT_LIMITS.tokens).description('一次修复最多多少 token（agent 不报用量时此闸不生效）'),
  maxWallMinutes: Schema.number().default(DEFAULT_LIMITS.wallMs / 60_000).description('一次修复最多多少分钟'),
})

export function parseAgentCommand(line: string): AgentCommand | null {
  const parts = line.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return null
  return { command: parts[0]!, args: parts.slice(1) }
}

const positive = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback

/** `null` = 没配 = 这条线不介入（Broker 退回只落通知）。 */
export function readAgentConfig(row: Record<string, unknown>): AgentConfig | null {
  const command = typeof row.command === 'string' ? parseAgentCommand(row.command) : null
  if (!command) return null
  return {
    command,
    limits: {
      turns: positive(row.maxTurns, DEFAULT_LIMITS.turns),
      tokens: positive(row.maxTokens, DEFAULT_LIMITS.tokens),
      wallMs: positive(row.maxWallMinutes, DEFAULT_LIMITS.wallMs / 60_000) * 60_000,
    },
  }
}
