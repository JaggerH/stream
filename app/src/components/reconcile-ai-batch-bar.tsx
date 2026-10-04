/**
 * 整理面板的历史一致率读数（`AiTrackRecord`）。批量取证与采纳的入口在对话
 * （spec 2026-08-24-conversational-reconcile）——这里只剩这条只读读数。
 */

import type { SuggestionSummary } from '../lib/types.ts'

/**
 * 「到目前为止它说对了几次」——AI 建议与人最终选择的历史一致率。
 *
 * **它是自动采纳那道门的门槛读数，不是一个成就徽章。** 摆在这里是因为人正是在这一屏一张张
 * 回答的：他每答一张，这个数就多一条真实样本；看得见才会知道离"可以放手"还有多远。
 *
 * 三条显示规矩：
 *  · **分歧数永远显示，哪怕是 0**——那才是决定放不放开的那一格。藏起来就成了报喜。
 *  · **只讲已经答过的**（`agreed + disagreed`），还没答的和没法比的不进分母；把它们并进去
 *    一致率会虚高，而虚高的准确率正是这套机制最不该产出的东西。
 *  · 一条样本都没有时整条不出现——「0 / 0 一致」不是信息。
 */
export function AiTrackRecord({ summary }: { summary: SuggestionSummary | null }) {
  // 门槛只看 `is-episode`：要放开的就是那一半（「都不是」错了是把东西搬走，更难发现）。
  const k = summary?.byKind['is-episode']
  const judged = (k?.agreed ?? 0) + (k?.disagreed ?? 0)
  if (!k || judged === 0) return null
  return (
    <div data-testid="ai-track-record" className="px-1 text-[11px] text-muted-foreground">
      它建议「就是这一集」的 {judged} 次里，你认同 {k.agreed} 次、改判 {k.disagreed} 次
      {k.open > 0 && `（另有 ${k.open} 条还没答）`}
    </div>
  )
}
