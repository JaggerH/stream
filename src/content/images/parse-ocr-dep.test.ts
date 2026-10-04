import { describe, it, expect } from 'vitest'
import { makeParseOcrDep, type ParseInvoker } from './parse-ocr-dep.ts'
import type { InvokeResult } from '../../providers/executor.ts'

// makeParseOcrDep 是 article 分支逐图 OCR 的 `ocr` dep 的真实实现——把 `parse` 行一次 invoke
// 的结果翻译成 `OcrImagesDeps.ocr` 的 `string | null` 契约。这三条用例对应文档里的判据：
//  1) parse 行全员 decline（没配视觉模型/MinerU 没起）→ 干净的 null，ocr-images 写「图上没有
//     可读文字」，此时这句话是对的。
//  2) parse 行有成员真的失败（如 ocr-vlm 抛错）→ 必须抛出真实原因，不能被 `?? null` 抹平成
//     和情况 1 一样的 null——那会让 ocr-images 写出同一句假话。
//  3) 正常识别成功不能回归。
const fakeInvoker = (invoke: ParseInvoker['invoke']): ParseInvoker => ({ invoke })

describe('makeParseOcrDep', () => {
  it('parse 行全员 decline → 返回 null（干净的"没有能力"，不是失败）', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'parse', value: null, via: null,
      misses: [
        { member: 'ocr-vlm', reason: 'declined (no result)' },
        { member: 'ocr-mineru', reason: 'declined (no result)' },
      ],
      timings: [],
    }
    const ocr = makeParseOcrDep(fakeInvoker(async () => res))
    await expect(ocr(new Uint8Array([1]), 'image/png')).resolves.toBeNull()
  })

  // 修复前：`ocr` 直接 `won?.markdown ?? null`，把这种情况和情况 1 一起抹平成 null。
  // 这条用例在修复前是红的——ocr() 会 resolve(null) 而不是 reject。
  it('parse 行有成员真的失败（带 stack）→ 抛出真实原因，不是"没有可读文字"', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'parse', value: null, via: null,
      misses: [
        { member: 'ocr-vlm', reason: '视觉模型返回空正文（model=glm-4v, mime=image/png, 12345 bytes）', stack: 'Error: boom\n at x' },
      ],
      timings: [],
    }
    const ocr = makeParseOcrDep(fakeInvoker(async () => res))
    await expect(ocr(new Uint8Array([1]), 'image/png')).rejects.toThrow(/视觉模型返回空正文/)
  })

  it('抛出的原因太长时截断到 200 字符（不能把整页错误塞进正文）', async () => {
    const longReason = 'X'.repeat(500)
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'parse', value: null, via: null,
      misses: [{ member: 'ocr-vlm', reason: longReason, stack: 'Error' }],
      timings: [],
    }
    const ocr = makeParseOcrDep(fakeInvoker(async () => res))
    try {
      await ocr(new Uint8Array([1]), 'image/png')
      throw new Error('应该抛错但没抛')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg.length).toBeLessThanOrEqual(201) // 200 字符 + 省略号
      expect(msg.endsWith('…')).toBe(true)
    }
  })

  it('识别成功 → 返回 markdown（不能回归）', async () => {
    const res: InvokeResult = {
      strategy: 'sequential', provider: 'parse', value: { markdown: '图中文字：正常识别出来的字' }, via: 'ocr-vlm',
      misses: [],
      timings: [],
    }
    const ocr = makeParseOcrDep(fakeInvoker(async () => res))
    await expect(ocr(new Uint8Array([1]), 'image/png')).resolves.toBe('图中文字：正常识别出来的字')
  })

  it('signal 已中止 → 不调用 invoke，直接返回 null', async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    let called = false
    const ocr = makeParseOcrDep(fakeInvoker(async () => { called = true; return null }), ctrl.signal)
    await expect(ocr(new Uint8Array([1]), 'image/png')).resolves.toBeNull()
    expect(called).toBe(false)
  })
})
