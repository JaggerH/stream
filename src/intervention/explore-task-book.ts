export interface ExploreTaskBookInput {
  runId: string
  facility: string
  target: string
  goal: string
  mcpToolNames: string[]
  limits: { maxStates: number; maxDepth: number }
}

/**
 * 探索版任务书（spec §7）。和修复版的差别只有一条，但它是整条线的地基：
 * **agent 不能自己点页面**——点、认、记边、算 frontier、判收敛全在 Stream 这一侧，
 * 它只经五个建图工具出主意。所以这份任务书必须把「你只能这么干」说在最前面，
 * 并且明说自己动手会被拒（审批门那一侧是 `classifyPermissionExplore`，两处说法要对得上：
 * 只写门不写任务书的话，agent 会先撞一堆拒绝才学会换工具，白烧几轮）。
 */
export function buildExploreTaskBook(i: ExploreTaskBookInput): string {
  const readTools = i.mcpToolNames.filter((t) => t.includes('cdp_')).join('、') || 'cdp_look、cdp_shot'
  return [
    `你在帮 Stream 给 facility \`${i.facility}\` 探索状态图。目标（人写的一句话）：${i.goal}。`,
    `探索面是 \`${i.target}\`（用户自己的 Chrome 里一张标签）。这条 run 的 id 是 \`${i.runId}\`——下面每个建图工具都要带它。`,
    '',
    '**你不能自己点页面。** 你只能：',
    '1. `graph_frontier({runId})` 看当前状态下还能点什么（带编号）。',
    '2. `graph_act({runId, ref, note?})` 让我点其中一个；我会告诉你这条边通向哪个状态（`to`），或 `unknown`（没见过的屏）/ `unchanged`（点了没变）。',
    '   回执里还有一格 `at`：**你此刻在哪一屏**。它和 `to` 常常不同——我要判这条边退不退得回，会先退一次再走回来，退不回就留在原地。下一次 `graph_frontier` 列的是 `at` 那一屏，别照着 `to` 猜。',
    '   还有一格 `effect`：`reversible` 我能带你回去，`one-way` 回不去（这种屏我不再往下展开），`noop` 这个元素是死键。',
    `3. 我说 \`unknown\` 时，用 \`graph_record_state({runId, id, features})\` 给这一屏起名：id 必须是 \`${i.facility}/<名字>\`，特征只能是 \`url\`（pattern 用 * 通配整串）或 \`dom\`（css selector，可带 absent:true），要能**只**匹配这一屏；我会过区分度闸，撞了会告诉你撞了谁，你加特征再来。`,
    '   **起过的名可以再改**：发现特征太宽（把别的屏也认成它了）就在**那一屏上**再调一次 `graph_record_state`，同一个 id、换一组特征，我会替换掉旧的（回执 `replaced:true`）。',
    '4. `graph_back({runId})` 退到上一个状态。',
    '5. 一屏与目标明显无关（广告、设置、个人资料）就 `graph_mark_irrelevant({runId, state})`，我不再展开它。',
    `你还有 ${readTools} 可以看页面（只读）。`,
    '',
    `我会在 frontier 空了、或状态数到 ${i.limits.maxStates} / 深度到 ${i.limits.maxDepth} 时收尾并交出整图，你不用判断「探够了」。`,
    '每一轮尽量多走几步；一轮结束我会把进度发回给你。探不下去（要登录、整站是验证码）就在最后写一行 `UNREPAIRABLE: <原因>`。',
    '**不要**用 cdp_act 点击 / 输入 / 提交——会被直接拒绝。',
  ].join('\n')
}
