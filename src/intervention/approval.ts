import { resolve, sep } from 'node:path'
import type { PermissionOption, RequestPermissionRequest } from '@agentclientprotocol/sdk'

export type ApprovalDecision = { verdict: 'allow'; why: string } | { verdict: 'ask'; why: string }

/** 我们自己的只读动词（spec §5.3 第一档）。名字可能被 adapter 加前缀（`mcp__stream__cdp_look`），按后缀认。 */
export const READ_ONLY_STREAM_TOOLS = ['cdp_look', 'cdp_shot', 'cdp_pages'] as const
/** `cdp_act` 里不改页面的那几档。 */
export const CDP_ACT_READ_KINDS = ['scroll', 'exists', 'look'] as const

const READ_KINDS = new Set(['read', 'search', 'think', 'fetch'])

/**
 * 取工具的**名字**（不是动作描述）。`name` 是 ACP 里标 UNSTABLE/experimental 的字段，
 * adapter 不一定发；对 MCP 工具，adapter 生成的 `title` 本身就是工具名（如 `cdp_shot`）——
 * 是 adapter 定的，不是模型现编的自然语言。所以拿 `title` 当名字兜底不违反"不看 title
 * 里的动词"：我们只用它整段去匹配白名单里的工具名，不解析其中的词。兜底也取不到名字时，
 * 后续匹配自然全部落空，退化成一律问（fail-safe）——不会因为兜底而多放行什么。
 */
function toolName(tc: RequestPermissionRequest['toolCall']): string {
  return (tc.name ?? tc.title ?? '').trim()
}
function endsWithTool(name: string, tool: string): boolean {
  return name === tool || name.endsWith(`_${tool}`) || name.endsWith(`/${tool}`) || name.endsWith(`.${tool}`)
}
function insideWorkDir(path: string, workDir: string): boolean {
  const root = resolve(workDir) + sep
  return resolve(path).startsWith(root)
}

/**
 * 审批门（spec §5.3）：白名单，越界是**等人**不是失败。判据只看 ACP 给的结构化字段
 * （`kind` / `locations` / `name` / `rawInput`），不看自然语言 title 里的动词——title 是给人看的。
 * **默认是问**：没 kind、没见过的名字、写文件却没说写哪，全都问。宁可多问一次，别放一个不该放的。
 */
export function classifyPermission(req: RequestPermissionRequest, workDir: string): ApprovalDecision {
  const tc = req.toolCall
  const name = toolName(tc)
  if (READ_ONLY_STREAM_TOOLS.some((t) => endsWithTool(name, t))) return { verdict: 'allow', why: `${name} 只读` }
  if (endsWithTool(name, 'cdp_act')) {
    const kind = (tc.rawInput as { kind?: unknown } | undefined)?.kind
    if (typeof kind === 'string' && (CDP_ACT_READ_KINDS as readonly string[]).includes(kind)) return { verdict: 'allow', why: `cdp_act ${kind} 不改页面` }
    return { verdict: 'ask', why: `cdp_act ${typeof kind === 'string' ? kind : '(未知 kind)'} 会动页面` }
  }
  if (tc.kind && READ_KINDS.has(tc.kind)) return { verdict: 'allow', why: `${tc.kind} 类只读` }
  if (tc.kind === 'edit' || tc.kind === 'delete' || tc.kind === 'move') {
    const paths = (tc.locations ?? []).map((l) => l.path)
    if (paths.length && paths.every((p) => insideWorkDir(p, workDir))) return { verdict: 'allow', why: '写的是工作副本' }
    return { verdict: 'ask', why: paths.length ? `要写副本外的文件：${paths.join('、')}` : '要写文件但没说写哪' }
  }
  if (tc.kind === 'execute') return { verdict: 'ask', why: `要执行命令：${tc.title ?? name}` }
  return { verdict: 'ask', why: `没见过的动作：${name || '(无名)'}${tc.kind ? ` / ${tc.kind}` : ''}` }
}

/** 探索门比修复门多一档：**自动拒**。修复期越界是等人，探索期越界是拒（见 `classifyPermissionExplore`）。 */
export type ExploreDecision = ApprovalDecision | { verdict: 'reject'; why: string }

/**
 * 探索 run 的门（spec §3 / §5.3 第一道闸）：**只许看，不许动**。动页面要经 `graph_act`——
 * 由 Stream 点、由 Stream 判效果、由 Stream 落边。
 *
 * 为什么越界是**拒**而不是**等人**：探索是一条无人值守的长循环，agent 一轮里会发几十个动作请求。
 * 在这条线上「等人」等于把整条 run 挂住，而人看到的是一串他根本不该被问的问题（「要不要让它点
 * 这个按钮」——答案永远是不要，那是 `graph_act` 的活）。拒还能把理由**送回给 agent**，它下一步
 * 就改用 `graph_act`；等人则什么都教不会它。
 */
export function classifyPermissionExplore(req: RequestPermissionRequest): ExploreDecision {
  const tc = req.toolCall
  const name = toolName(tc)
  if (READ_ONLY_STREAM_TOOLS.some((t) => endsWithTool(name, t))) return { verdict: 'allow', why: `${name} 只读` }
  if (endsWithTool(name, 'cdp_act')) {
    const kind = (tc.rawInput as { kind?: unknown } | undefined)?.kind
    if (typeof kind === 'string' && (CDP_ACT_READ_KINDS as readonly string[]).includes(kind)) return { verdict: 'allow', why: `cdp_act ${kind} 不改页面` }
    return { verdict: 'reject', why: `探索期你不能自己动页面（cdp_act ${typeof kind === 'string' ? kind : '(未知 kind)'}）——要点就用 graph_act，由我来点、我来判效果` }
  }
  if (tc.kind && READ_KINDS.has(tc.kind)) return { verdict: 'allow', why: `${tc.kind} 类只读` }
  return { verdict: 'reject', why: `探索期只看不动：${name || '(无名)'}${tc.kind ? ` / ${tc.kind}` : ''}` }
}

export function pickOption(options: PermissionOption[], want: 'allow' | 'reject'): PermissionOption | undefined {
  const order = want === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always']
  for (const k of order) { const o = options.find((x) => x.kind === k); if (o) return o }
  return undefined
}
