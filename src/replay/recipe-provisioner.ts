import type { Recipe } from './recipe.ts'
import { isCanonicalBrowserRecipe } from './recipe.ts'

/**
 * 「这条 recipe 会替用户去把哪一格 runtime_config 填满」——全仓**唯一**判据。
 *
 * 它同时服务两个方向，这正是它必须是一个具名导出、而不是两处内联 if 的理由：
 *
 *  - **写那一侧**：`SessionRecipeExecutor.sinkFor` 靠它决定要不要给这次运行装上 secret sink。
 *  - **反查那一侧**：Source 域靠它建「ref → 谁能替我申请」的索引（`configProvisionerFor`），
 *    配置卡上那颗「一键帮我完成」按钮的显隐就是这份索引的投影。
 *
 * 两边一旦各写一份，漂移的形状是静音的：UI 亮着按钮、跑完却没人写（sink 没装），
 * 或者反过来——recipe 明明会写，界面上永远没有入口（今天 groq 就是后者）。
 *
 * 判据三条，与 sink 绑定逐字同源：
 *  1. 是 canonical browser recipe 且声明了 `extract`（只有它有这个字段）。
 *  2. 自己的 `meta.runtime_config` 在场——**目标 ref 只能是它自己那一格**，recipe 体没有任何
 *     办法指名去写别处（见 `RecipeExtract` 头注）。
 *  3. `extract.field` 已在那份声明里写成 `secret`。不能凭空往凭据存储塞一个键。
 *
 * 返回 null = 这条 recipe 不产出任何配置，别给它开写口、也别在界面上提它。
 *
 * **与装载期那道闸的关系**：`recipe-store.ts` 的 `validateExtract` 拿同一条规则**拒收**不合规的
 * recipe（响亮地抛）。所以对一条已经装载进来的 recipe，条件 3 事实上恒真——这里仍然查，是因为
 * 本函数也吃测试夹具和还没过闸的对象，而它的返回值直接决定"要不要给这次运行开凭据写口"。
 * 那种地方宁可多查一次。
 *
 * **不该吃它的一处**（免得下一个人再扫一遍）：`src/packages/inventory.ts` 收集「这个包会碰哪些
 * 配置格」时只读 `meta.runtime_config.ref`，不分产出还是需要——那一格问的就是"碰"，两种都算。
 */
export interface ProvisionedConfigSlot {
  /** 它会写进哪一格配置（`runtime_config.ref`）。 */
  ref: string
  /** 那一格里的哪个 secret 字段。 */
  field: string
}

export function provisionedConfigSlot(recipe: Recipe): ProvisionedConfigSlot | null {
  if (!isCanonicalBrowserRecipe(recipe)) return null
  const capture = recipe.extract
  if (!capture) return null
  const spec = recipe.meta?.runtime_config
  if (!spec) return null
  if (spec.fields[capture.field]?.type !== 'secret') return null
  return { ref: spec.ref, field: capture.field }
}
