import type { AgentGateLimits } from './agent-config.ts'

export type GateName = 'turns' | 'tokens' | 'wall'
/** 人点一次「继续」各抬一档（spec §7.2「可续期」）。 */
export const EXTEND_STEP: AgentGateLimits = { turns: 6, tokens: 1_000_000, wallMs: 20 * 60_000 }

/**
 * 三闸 or 在一起（spec §7.2）。**闸的刻度是轮数 + token + 墙钟，不是钱**（§8）。
 * token 那一闸只在 agent 报了用量时才可能撞——不报就永远不撞，这是如实的：我们不补 0，也不猜。
 */
export class RepairGates {
  private turns = 0
  private tokens = 0
  private readonly startedAt: number
  private limits: AgentGateLimits

  constructor(limits: AgentGateLimits, private readonly now: () => number = Date.now) {
    this.limits = { ...limits }
    this.startedAt = now()
  }

  noteTurn(): void { this.turns += 1 }
  noteTokens(total: number): void { this.tokens += total }

  check(): { hit: GateName } | { hit: null } {
    if (this.turns >= this.limits.turns) return { hit: 'turns' }
    if (this.tokens >= this.limits.tokens) return { hit: 'tokens' }
    if (this.now() - this.startedAt >= this.limits.wallMs) return { hit: 'wall' }
    return { hit: null }
  }

  extend(): AgentGateLimits {
    this.limits = { turns: this.limits.turns + EXTEND_STEP.turns, tokens: this.limits.tokens + EXTEND_STEP.tokens, wallMs: this.limits.wallMs + EXTEND_STEP.wallMs }
    return { ...this.limits }
  }

  snapshot(): { turns: number; tokens: number; wallMs: number; limits: AgentGateLimits } {
    return { turns: this.turns, tokens: this.tokens, wallMs: this.now() - this.startedAt, limits: { ...this.limits } }
  }
}
