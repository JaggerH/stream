import { describe, it, expect } from 'vitest'
import { realFailureReason } from './ladder-trace.ts'
import type { InvokeMiss } from './executor.ts'

// realFailureReason 是「全员 decline」与「有成员真的失败」这两件事的唯一判据来源。
// 判据用 InvokeMiss.stack 有没有值——decline / 合同拒绝都不写它，只有真 catch 到的抛出物才写
// （见 executor.ts InvokeMiss 的字段注释）。
describe('realFailureReason — 区分全员 decline 与有成员真的失败', () => {
  it('全员 decline（没有 stack）→ null（没有能力，不是失败）', () => {
    const misses: InvokeMiss[] = [
      { member: 'ocr-vlm', reason: 'declined (no result)' },
      { member: 'ocr-mineru', reason: 'declined (no result)' },
    ]
    expect(realFailureReason(misses)).toBeNull()
  })

  it('合同拒绝（没有 stack）也算 decline，不算失败', () => {
    const misses: InvokeMiss[] = [{ member: 'ocr-vlm', reason: 'result did not meet the contract' }]
    expect(realFailureReason(misses)).toBeNull()
  })

  it('有一个成员真的抛错（带 stack）→ 带着真实原因', () => {
    const misses: InvokeMiss[] = [
      { member: 'ocr-mineru', reason: 'declined (no result)' },
      { member: 'ocr-vlm', reason: '视觉模型返回空正文（model=glm-4v, mime=image/png, 12345 bytes）', stack: 'Error: ...' },
    ]
    const reason = realFailureReason(misses)
    expect(reason).toContain('ocr-vlm')
    expect(reason).toContain('视觉模型返回空正文')
    expect(reason).not.toContain('ocr-mineru') // decline 的那条不该混进真失败原因里
  })

  it('空 misses（行不存在/一个成员都没跑）→ null', () => {
    expect(realFailureReason([])).toBeNull()
  })
})
