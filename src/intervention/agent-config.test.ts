import { describe, it, expect } from 'vitest'
import { parseAgentCommand, readAgentConfig, DEFAULT_LIMITS, agentRowSchema } from './agent-config.ts'

describe('parseAgentCommand', () => {
  it('按空白切 argv；首段是命令', () => {
    expect(parseAgentCommand('npx -y @agentclientprotocol/claude-agent-acp')).toEqual({
      command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    })
  })
  it('空串 / 全空白 → null', () => {
    expect(parseAgentCommand('')).toBeNull()
    expect(parseAgentCommand('   ')).toBeNull()
  })
})

describe('readAgentConfig', () => {
  it('command 缺席 → null（= 没配，不介入）', () => {
    expect(readAgentConfig({ command: '' })).toBeNull()
    expect(readAgentConfig({})).toBeNull()
  })
  it('只给 command → 三闸取默认', () => {
    const c = readAgentConfig({ command: 'gemini --experimental-acp' })!
    expect(c.command).toEqual({ command: 'gemini', args: ['--experimental-acp'] })
    expect(c.limits).toEqual(DEFAULT_LIMITS)
  })
  it('三闸可改；非正数按默认', () => {
    const c = readAgentConfig({ command: 'x', maxTurns: 3, maxTokens: 0, maxWallMinutes: 5 })!
    expect(c.limits).toEqual({ turns: 3, tokens: DEFAULT_LIMITS.tokens, wallMs: 5 * 60_000 })
  })
  it('schema 的默认值与 DEFAULT_LIMITS 同一份', () => {
    const v = agentRowSchema({}) as Record<string, unknown>
    expect(v.maxTurns).toBe(DEFAULT_LIMITS.turns)
    expect(v.maxTokens).toBe(DEFAULT_LIMITS.tokens)
    expect(v.maxWallMinutes).toBe(DEFAULT_LIMITS.wallMs / 60_000)
  })
})
