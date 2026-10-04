// src/content/images/parse-ocr-dep.ts
//
// article 分支逐图 OCR 的 `ocr` dep：把 `parse` 能力行一次 invoke 的结果，翻译成
// `OcrImagesDeps.ocr` 的 `string | null` 契约。单独抽出来（而不是留在 bootstrap() 的闭包里）
// 是因为要守住的判据——全员 decline vs 有成员真的失败——值得一份自己的测试；bootstrap() 太重，
// 起不起得来跟这个判据对不对没关系。
import type { InvokeResult } from '../../providers/executor.ts'
import { realFailureReason } from '../../providers/ladder-trace.ts'
import type { OcrImagesDeps } from './ocr-images.ts'

/** `providerExecutor` 用得到的那一小片接口——不依赖它的完整类型，测试给个假的就行。 */
export interface ParseInvoker {
  invoke(ref: string, input: unknown): Promise<InvokeResult | null>
}

/** `parse` 行 → `OcrImagesDeps['ocr']`。sequential 行的 `value: null` 有两种完全不同的真相：
 *  全员 decline（没配视觉模型、MinerU 容器没起——这台机器**没有**这个能力）vs 有成员试了但真的
 *  失败（如 ocr-vlm 抛「视觉模型返回空正文」——**有**能力，这次没干成）。两者若都原样返回
 *  `null`，下游 `ocr-images` 会把两者一起写成同一句「图上没有可读文字」——后者下这是假话
 *  （图上可能全是字，只是模型挂了或端点掉了），而下游还有个模型会认真复述这句假话。
 *
 *  判据见 `realFailureReason`：干净 decline 才当"没识别出东西"处理，原样返回 `null`；
 *  真失败要抛出去，把 member+reason 带给用户，而不是悄悄吞成"没结果"。
 *
 *  抛出的 message 会**原样进用户读的正文**（`ocr-images` 写成 `[未识别：<message>]`）——
 *  上游可能回一整页 HTML 错误页，整篇塞进正文中间就把文章毁了，所以截断到 200 字符。 */
export function makeParseOcrDep(executor: ParseInvoker, signal?: AbortSignal): OcrImagesDeps['ocr'] {
  return async (bytes, mime) => {
    if (signal?.aborted) return null
    try {
      const res = await executor.invoke('parse', { bytes, mime })
      const seq = res && res.strategy === 'sequential' ? res : null
      if (seq && seq.value !== null) return (seq.value as { markdown?: string } | null)?.markdown ?? null
      const reason = realFailureReason(seq?.misses ?? [])
      if (reason) throw new Error(reason)
      return null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(msg.length > 200 ? `${msg.slice(0, 200)}…` : msg)
    }
  }
}
