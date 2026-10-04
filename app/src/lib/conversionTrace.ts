// 一次转换的**走法**怎么念成人话：耗时、以及「这条产物是 Provider 梯子上的谁做的」。
//
// 逻辑放在这里而不是组件里，是因为 hover card 的正文在 jsdom 里测不可靠（Radix 浮层，见
// MusicChannel.toolbar.test.tsx 的同款处置）。念法是这条功能真正会出错的地方——尤其是
// miss 与 error 不能混——所以它必须是可直接断言的纯函数，而不是藏在一个打不开的浮层里。
import type { LadderRung, LadderTrace } from './types.ts'

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}

/** 一档的结局怎么念。**miss 和 error 必须是两个词**：一个是"它弃权了"（下一步去配置），
 *  一个是"它试了但失败"（下一步去查故障）——方向相反。合并成一句"没成功"，就是把这条链路上
 *  最费时间的那次误诊重新造一遍。 */
const RUNG_VERB: Record<LadderRung['outcome'], string> = {
  win: '出的结果',
  miss: '弃权',
  error: '失败',
  rejected: '答过被否',
}

/** 一档念成一行：`实例名 · 源 id · 耗时 · 结局`。实例名与源 id 同名时不重复念
 *  （没起实例名的成员，寻址键本来就是源 id）。 */
export function rungLine(r: LadderRung): string {
  const who = r.member === r.source ? r.member : `${r.member} · ${r.source}`
  return `${who} · ${formatMs(r.ms)} · ${RUNG_VERB[r.outcome]}`
}

export interface LadderSummary {
  /** 台面上那一小行：赢家的寻址键，或"无人产出"。 */
  label: string
  /** 赢的那一档（没有 = 梯子上没人产出结果）。 */
  won?: LadderRung
  /** hover 里的第一句。 */
  title: string
}

/** 走法的摘要；`null` = 这条记录没有走法（老记录），调用方据此**什么都不画**——
 *  画一个"未知"图标会让每一条历史记录都看着像出了事。 */
export function ladderSummary(ladder?: LadderTrace): LadderSummary | null {
  if (!ladder?.rungs.length) return null
  const won = ladder.rungs.find((r) => r.outcome === 'win')
  return {
    label: ladder.via ?? '无人产出',
    won,
    title: won ? `由「${won.source}」产出` : '梯子上没有成员产出结果',
  }
}
