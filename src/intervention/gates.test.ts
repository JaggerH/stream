import { describe, it, expect } from 'vitest'
import { RepairGates, EXTEND_STEP } from './gates.ts'

describe('RepairGates', () => {
  const limits = { turns: 2, tokens: 100, wallMs: 1000 }
  it('轮数到上限撞 turns', () => {
    const g = new RepairGates(limits, () => 0)
    g.noteTurn(); expect(g.check()).toEqual({ hit: null })
    g.noteTurn(); expect(g.check()).toEqual({ hit: 'turns' })
  })
  it('token 累加到上限撞 tokens', () => {
    const g = new RepairGates(limits, () => 0)
    g.noteTokens(60); expect(g.check()).toEqual({ hit: null })
    g.noteTokens(40); expect(g.check()).toEqual({ hit: 'tokens' })
  })
  it('墙钟按 now 判', () => {
    let t = 0
    const g = new RepairGates(limits, () => t)
    t = 999; expect(g.check()).toEqual({ hit: null })
    t = 1000; expect(g.check()).toEqual({ hit: 'wall' })
  })
  it('extend 各抬一档，撞了的闸解开', () => {
    const g = new RepairGates(limits, () => 0)
    g.noteTurn(); g.noteTurn()
    expect(g.check()).toEqual({ hit: 'turns' })
    expect(g.extend()).toEqual({ turns: 2 + EXTEND_STEP.turns, tokens: 100 + EXTEND_STEP.tokens, wallMs: 1000 + EXTEND_STEP.wallMs })
    expect(g.check()).toEqual({ hit: null })
  })
})
