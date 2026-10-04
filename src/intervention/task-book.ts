import type { RecipeValidation } from './types.ts'

export interface TaskBookInput {
  sourceId: string
  localSourceId: string
  facility: string
  reason: string
  affectedSources: string[]
  /** 工作副本里那份文件的绝对路径 */
  recipePath: string
  currentVersion: number
  /** data/failures 里最近的截图路径（可空） */
  failureShots: string[]
  lastFailureAt?: string
  /** 我们这次给它的 MCP 工具名（cdp_look 等） */
  mcpToolNames: string[]
}

/** agent 判定修不了时，最后一条消息里带这个前缀 + 原因。结构化，不靠猜语气。 */
export const UNREPAIRABLE_MARKER = 'UNREPAIRABLE:'

/**
 * 第一条 `session/prompt`（spec §5.2 第 3 步）。**产物要求与禁令写在任务书里**，但真正的
 * 守门是我们自己的校验（recipe-validation.ts）——任务书是提示，不是闸。
 */
export function buildTaskBook(i: TaskBookInput): string {
  const others = i.affectedSources.filter((s) => s !== i.sourceId)
  const lines = [
    `你在修 Stream 的一份采集 recipe。源 \`${i.sourceId}\`（facility \`${i.facility}\`）连续几次漂移，已被隔离。`,
    `最近一次失败原因：${i.reason}${i.lastFailureAt ? `（${i.lastFailureAt}）` : ''}。`,
    ...(others.length ? [`这份 recipe 被共用，跟着哑的还有：${others.join('、')}。`] : []),
    '',
    `要改的文件（当前目录是那个包的工作副本，不是正在跑的那份）：\`${i.recipePath}\`，当前 version ${i.currentVersion}。`,
    ...(i.failureShots.length ? [`失败现场截图：${i.failureShots.join('、')}（用你的读文件/看图能力看）。`] : []),
    '',
    `你手里有 Stream 的 MCP 工具：${i.mcpToolNames.join('、')}。用 cdp_look / cdp_shot 看活页面、验选择器；`,
    '看不懂 recipe 语法就读你本机 `~/.claude/skills/write-recipe/`（或 `.agents/skills/write-recipe/`）——那是 Stream 装给你的 skill。',
    '',
    '产物要求：',
    `1. 改好后把 version 改成 ${i.currentVersion + 1}（必须恰好 +1）。`,
    '2. 只修定位（选择器 / urlPattern / 字段映射 / 步骤参数）。**绝不改任何 `expect`、`loginCheck`、observer 的 `input.assert`**——那些是任务的定义，改了等于自己给自己发毕业证；我们会逐字比对，改了整份不收。',
    '3. 不在真账号上做不可逆的事（发消息、下单、删除、关注）。cdp_act 只用 scroll / exists / look。',
    '4. 改完直接结束这一轮回复；我们会自动校验并把结果发回给你，过了才算完。',
    `5. 判定修不了（要登录、站点改版到面目全非、判据本身错了）就在最后一条消息里写一行 \`${UNREPAIRABLE_MARKER} <原因>\`，不要硬改。`,
  ]
  return lines.join('\n')
}

/** 校验没过时发回去的下一条 prompt：只说没过的格。 */
export function buildValidationFeedback(v: RecipeValidation): string {
  const bad: string[] = []
  if (v.schema !== 'ok') bad.push(`schema：${v.schema}`)
  if (v.version !== 'ok') bad.push(`version：${v.version}`)
  if (v.assertions !== 'ok') bad.push(`断言：${v.assertions}`)
  if (v.probe !== 'ok' && !v.probe.startsWith('skipped-')) bad.push(`活体 probe：${v.probe}`)
  return `校验没过，请修正后再结束回复：\n- ${bad.join('\n- ')}`
}

export function parseUnrepairable(text: string): string | null {
  const i = text.indexOf(UNREPAIRABLE_MARKER)
  if (i < 0) return null
  const rest = text.slice(i + UNREPAIRABLE_MARKER.length).split('\n')[0]!.trim()
  return rest || '（agent 没写原因）'
}
