import { describe, it, expect, vi } from 'vitest'
import {
  makeExtractDigester, buildDigestMessages,
  EXTRACT_FULL_TEXT_CHARS, EXTRACT_DIGEST_TTL_MS, EXTRACT_DIGEST_CAP,
} from './extract-digest.ts'
import type { LlmForTask } from '../llm/task.ts'

const LONG = 'A'.repeat(EXTRACT_FULL_TEXT_CHARS + 100)
const doneRecord = (text: string) => ({
  status: 'done',
  result: { text, format: 'markdown', branch: 'stt', detail: { segments: [{ at: 0, text: 'x' }], lang: 'zh' } },
})
const okLlm = (answer = '- 要点「引文」'): LlmForTask =>
  vi.fn(async () => ({ content: answer })) as unknown as LlmForTask
const deadLlm = (): LlmForTask => vi.fn(async () => null) as unknown as LlmForTask

describe('makeExtractDigester', () => {
  it('短文原样返回(同一引用),不打 LLM', async () => {
    const llm = okLlm()
    const d = makeExtractDigester(llm)
    const rec = doneRecord('short text')
    expect(await d.apply('i1', rec)).toBe(rec)
    expect(llm).not.toHaveBeenCalled()
  })

  it('running / error / 无 result.text 原样透传', async () => {
    const d = makeExtractDigester(okLlm())
    for (const rec of [{ status: 'running' }, { status: 'error', error: 'x' }, { status: 'done', result: { url: 'u' } }]) {
      expect(await d.apply('i1', rec)).toBe(rec)
    }
  })

  it('长文压成 digest:替换 text、剥 detail.segments、带 digested/full_text_chars/next_step,不改原 record', async () => {
    const d = makeExtractDigester(okLlm('- 保温杯 X100「原文引」'))
    const rec = doneRecord(LONG)
    const out = (await d.apply('item9', rec)) as { result: Record<string, unknown> }
    expect(out).not.toBe(rec)
    expect(out.result.text).toBe('- 保温杯 X100「原文引」')
    expect(out.result.digested).toBe(true)
    expect(out.result.full_text_chars).toBe(LONG.length)
    expect(String(out.result.next_step)).toContain('get_conversions')
    expect(String(out.result.next_step)).toContain('item9')
    expect(out.result.branch).toBe('stt')
    expect((out.result.detail as Record<string, unknown>).segments).toBeUndefined()
    expect((out.result.detail as Record<string, unknown>).lang).toBe('zh')
    // 原 record 未被改动
    expect((rec.result as Record<string, unknown>).text).toBe(LONG)
    expect((rec.result.detail as Record<string, unknown>).segments).toBeDefined()
  })

  it('长文没有绕过压缩的开关——opts 类型里根本没有 full 这一格(结构性,不是纪律)', async () => {
    const d = makeExtractDigester(okLlm())
    const out = (await d.apply('i1', doneRecord(LONG), {} as never)) as { result: Record<string, unknown> }
    expect(out.result.digested).toBe(true)
  })

  it('同 item+focus 第二次命中缓存不再打 LLM;不同 focus 各打各的', async () => {
    const llm = okLlm()
    const d = makeExtractDigester(llm)
    await d.apply('i1', doneRecord(LONG), { focus: 'a' })
    await d.apply('i1', doneRecord(LONG), { focus: 'a' })
    expect(llm).toHaveBeenCalledTimes(1)
    await d.apply('i1', doneRecord(LONG), { focus: 'b' })
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it('TTL 过期后重打 LLM', async () => {
    let t = 0
    const llm = okLlm()
    const d = makeExtractDigester(llm, () => t)
    await d.apply('i1', doneRecord(LONG))
    t = EXTRACT_DIGEST_TTL_MS + 1
    await d.apply('i1', doneRecord(LONG))
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it('LLM 不可用 → 兜底截断全文 + digest_failed,且不写缓存(下次重试)', async () => {
    const llm = deadLlm()
    const d = makeExtractDigester(llm)
    const out = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(out.result.digest_failed).toBe(true)
    expect(out.result.digested).toBe(true)
    expect((out.result.text as string).length).toBe(EXTRACT_FULL_TEXT_CHARS)
    expect(String(out.result.next_step)).toContain('DIGEST FAILED')
    await d.apply('i1', doneRecord(LONG))
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it('LLM 返回空串/纯空白 → 当失败处理:兜底截断 + digest_failed,且不写缓存', async () => {
    const llm = okLlm('   \n  ')
    const d = makeExtractDigester(llm)
    const out = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(out.result.digest_failed).toBe(true)
    expect((out.result.text as string).length).toBe(EXTRACT_FULL_TEXT_CHARS)
    await d.apply('i1', doneRecord(LONG))
    expect(llm).toHaveBeenCalledTimes(2) // 没写缓存,第二次重打
  })

  it('bypassCache + LLM 失败 → 旧缓存被废,后续非-bypass 调用不得命中旧稿(会重打 LLM)', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce({ content: '- 旧稿要点' }) // 先正常出一份缓存
      .mockResolvedValueOnce(null) // rerun 恰好失败
      .mockResolvedValueOnce({ content: '- 重试后的新稿' }) as unknown as LlmForTask
    const d = makeExtractDigester(llm)
    const first = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(first.result.text).toBe('- 旧稿要点')
    const rerun = (await d.apply('i1', doneRecord(LONG), { bypassCache: true })) as { result: Record<string, unknown> }
    expect(rerun.result.digest_failed).toBe(true) // LLM 失败,兜底截断
    // 旧稿已被废——下一次非-bypass 调用不能静默吃到 rerun 之前的陈旧摘要,必须重打 LLM。
    const after = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(after.result.text).toBe('- 重试后的新稿')
    expect(llm).toHaveBeenCalledTimes(3)
  })

  it('bypassCache 撞上 running 回执(早返回)也要先废旧稿,后续普通调用重打 LLM', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce({ content: '- 旧稿要点' })
      .mockResolvedValueOnce({ content: '- rerun 之后的新稿' }) as unknown as LlmForTask
    const d = makeExtractDigester(llm)
    await d.apply('i1', doneRecord(LONG))
    // rerun 轮询期间先来一发 running:走早返回,但旧 digest 必须同时作废
    const polling = await d.apply('i1', { status: 'running' }, { bypassCache: true })
    expect(polling).toEqual({ status: 'running' })
    const after = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(after.result.text).toBe('- rerun 之后的新稿')
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it('bypassCache: 跳过缓存读,但把新结果写回缓存供后续非-bypass 调用复用', async () => {
    const llm = vi.fn()
      .mockResolvedValueOnce({ content: '- 旧稿要点' })
      .mockResolvedValueOnce({ content: '- 新稿要点(带说话人)' }) as unknown as LlmForTask
    const d = makeExtractDigester(llm)
    const first = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(first.result.text).toBe('- 旧稿要点')
    const rerun = (await d.apply('i1', doneRecord(LONG), { bypassCache: true })) as { result: Record<string, unknown> }
    expect(rerun.result.text).toBe('- 新稿要点(带说话人)')
    expect(llm).toHaveBeenCalledTimes(2)
    // 新结果已写回缓存:后续非-bypass 调用直接命中,不再打 LLM
    const after = (await d.apply('i1', doneRecord(LONG))) as { result: Record<string, unknown> }
    expect(after.result.text).toBe('- 新稿要点(带说话人)')
    expect(llm).toHaveBeenCalledTimes(2)
  })

  it('容量上限:超过 CAP 逐出最老的', async () => {
    const llm = okLlm()
    const d = makeExtractDigester(llm)
    for (let i = 0; i <= EXTRACT_DIGEST_CAP; i++) await d.apply(`i${i}`, doneRecord(LONG))
    expect(llm).toHaveBeenCalledTimes(EXTRACT_DIGEST_CAP + 1)
    await d.apply('i0', doneRecord(LONG)) // 最老的 i0 已被逐出 → 重打
    expect(llm).toHaveBeenCalledTimes(EXTRACT_DIGEST_CAP + 2)
  })
})

describe('buildDigestMessages', () => {
  it('focus 进 system,原文进 user', () => {
    const msgs = buildDigestMessages('正文', '找型号')
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('找型号')
    expect(msgs[0].content).toContain('原样保留')
    expect(msgs[1]).toEqual({ role: 'user', content: '正文' })
  })
  it('无 focus 不出现视角行', () => {
    expect(buildDigestMessages('正文')[0].content).not.toContain('视角')
  })
})
