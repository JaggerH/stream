// shared/research/run-guid.ts — research run 的 feed guid 与 run id 之间那一层前缀，
// 后端拼、前端剥，**同一份代码**。
//
// 为什么住 shared/：这里曾经只有"拼"没有"剥"。生产者 `src/board/run-source.ts` 吐
// `research-run:<runId>` 当 guid（feed 全局去重键要跨源不撞），live 列表原样填进
// `LiveItem.id`，前端拿 `it.id` 当 run id 去导航，详情路由的段校验不放行 `:` → 整条列表
// 点进去每一行都是 400。中间没有任何一处剥前缀，而**两侧的测试夹具各写各的**（列表侧 `r1`、
// 路由侧 `20260801-000000-aaaaaa`），两边各自都绿。
//
// 所以剥前缀这件事不能在前端就地写一个字面量——那只是把同一个前缀抄成第二份，漂了没人报警。
// 拼和剥住在一起，改一处两侧一起动，跨边界回归（src/http/research-routes.test.ts 末尾那档）
// 拿真实生产者的输出喂进真实路由的校验。
export const RUN_GUID_PREFIX = 'research-run:'

/** run id → feed guid（生产者侧）。 */
export function runGuid(runId: string): string {
  return `${RUN_GUID_PREFIX}${runId}`
}

/** feed guid → run id（消费者侧）。没带前缀的原样返回：live 列表里的 id 也可能来自
 *  别的生产者（`LiveStreamService` 在 guid 缺失时会兜一个 `<source>:<n>`），
 *  对那些原样交给下游去判，别在这里造一个"看起来像 run id"的东西。 */
export function runIdFromGuid(guid: string): string {
  return guid.startsWith(RUN_GUID_PREFIX) ? guid.slice(RUN_GUID_PREFIX.length) : guid
}
