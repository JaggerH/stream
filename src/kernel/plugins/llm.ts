import type { Context } from 'cordis'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { LlmUsageStore } from '../../llm/usage-store.ts'
import { usageOf } from '../../llm/client.ts'
import { type LlmForTask } from '../../llm/task.ts'
import type { DebugEntry } from '../../debug.ts'

declare module 'cordis' {
  interface Context {
    /** LLM 网关这一域（`src/kernel/plugins/llm.ts`）——一次任务级调用的唯一通道 + 用量账本。 */
    llm: LlmService
  }
}

/**
 * 「任务级 LLM 调用」这一域：在 `ctx.provider.llmForTask` 外面裹一层账本。
 *
 * **它只有进程内这一个面。** 后端自己的调用点（总结、网盘裁决、搜索 agent 的对话关节…）
 * 全部经 `forTask` 走梯子，一步 HTTP 都不经过；对话工作台的模型是用户在 DSH「设置 - 模型」
 * 页里配的，与这一域没有任何关系——两条路各配各的，别把它们混成一个概念。
 */
export interface LlmService {
  /** 包装 `ctx.provider.llmForTask`：每次成功调用都落一笔账（`usageOf` 抠数，缺席记
   *  `usage_unreported`）。null / 抛错都不记账——没打出去或没人答，谈不上花没花钱。 */
  forTask: LlmForTask
  usage: LlmUsageStore
}

export interface LlmConfig {
  /** 用量账本落在这个库（cache.db——可再生诊断侧，与 `providerStats` 同一个文件，
   *  各开各的连接，照本仓库既有惯例）。 */
  cacheDb: string
  /** debug 总线（channel:'llm'）。`forTask` 每次完成（含 null 结果、含被否决重试过的那些）
   *  都发一条——"这条调用点这次打给了谁、算不算数"只有这里能查。 */
  onDebug?: (entry: DebugEntry) => void
}

/**
 * LLM 账本整域进内核。依赖只有一个，经 inject 取：
 *  - `ctx.provider` —— `llmForTask`（真正的梯子）。
 *
 * 句柄一个，登记成 effect：`usage` 在 cache.db 上开的一条 sqlite 连接。
 */
export const llmPlugin = {
  name: 'llm',
  inject: ['provider'],
  apply(ctx: Context, config: LlmConfig): void {
    mkdirSync(dirname(config.cacheDb), { recursive: true })
    const db = new DatabaseSync(config.cacheDb)
    const usage = new LlmUsageStore(db)
    ctx.effect(() => () => usage.close())

    const forTask: LlmForTask = async (callsiteId, input, opts) => {
      let member: string | null = null
      const result = await ctx.provider.llmForTask(callsiteId, input, {
        ...opts,
        onLadder: (ladder) => {
          member = ladder.via
          // 升级重试（task.ts 的 excludeMembers 循环）里被 validate 否决的每一档，各落一笔
          // rejected_unmetered——账本上必须看得见"有人答过、但没被采信"，不能因为它没算钱
          // 就悄悄不记。member 用那一档自己的 rung.member（不是最终赢家 via）。
          for (const r of ladder.rungs) {
            if (r.outcome === 'rejected') {
              usage.record({ callsiteId, member: r.member, promptTokens: null, completionTokens: null, kind: 'rejected_unmetered' })
            }
          }
          opts?.onLadder?.(ladder)
        },
      })
      // null = 梯子上没人答 / 没打出去——不记账，"没花钱"和"没打出去"不能混成一个数字。
      const u = result ? usageOf(result.raw) : undefined
      const kind = result ? (u ? 'metered' : 'usage_unreported') : 'no_result'
      if (result) {
        usage.record(
          u
            ? { callsiteId, member, promptTokens: u.promptTokens, completionTokens: u.completionTokens, kind: 'metered' }
            : { callsiteId, member, promptTokens: null, completionTokens: null, kind: 'usage_unreported' },
        )
      }
      // debug 总线：无论有没有结果、有没有被否决过都发——排查"这条调用点这次到底打给了谁、
      // 算不算数"不该靠反推账本。
      const at = Date.now()
      config.onDebug?.({
        id: `llm:${callsiteId}:${member ?? 'none'}@${at}`,
        at,
        channel: 'llm',
        key: callsiteId,
        title: member ? `${callsiteId} 打给 ${member}` : `${callsiteId} 无结果`,
        summary: result ? (u ? `metered · ${u.promptTokens ?? '—'}/${u.completionTokens ?? '—'} tokens` : 'usage_unreported') : '梯子上没人答 / 没打出去',
        ok: !!result,
        fields: [
          { label: 'callsiteId', value: callsiteId },
          { label: 'member', value: member ?? '—' },
          { label: 'kind', value: kind },
          ...(u?.promptTokens != null ? [{ label: 'promptTokens', value: String(u.promptTokens) }] : []),
          ...(u?.completionTokens != null ? [{ label: 'completionTokens', value: String(u.completionTokens) }] : []),
        ],
      })
      return result
    }

    ctx.provide('llm', { forTask, usage } satisfies LlmService)
  },
}
