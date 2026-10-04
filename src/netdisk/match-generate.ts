/**
 * 季归属的语义判断 —— netdisk 里唯一出现 LLM 的地方(运行时零 LLM 的边界落在此文件)。
 * 结构指纹 + 嵌套干净名都判不出季归属时,让模型读一个可能被"防和谐"手法混淆过的文件夹名
 * (形近字/谐音/偏旁拆字/西里尔字母混排…),在候选季号里挑一个,或坦白判不出。
 *
 * **匹配规格(MatchSpec)本身不在这里生成**:写谱的是对话工作台里的那个模型——它读
 * `netdisk_residue`、自己产一份谱、`netdisk_preview_spec` dry-run 看 changed、满意了再
 * `netdisk_apply_spec`,比"后端偷偷发一发 prompt、一发定生死"多了一整个反馈循环。
 * 两条路最后过同一个 validateSpec(`match-spec.ts`)。
 */

/**
 * netdisk 的 LLM 端口(bootstrap 注入):input = { messages, temperature },返回 content 或 null
 * (未配置/失败)。季归属是运行时唯一的 LLM 调用点,故此类型落在这里。
 */
export type InvokeLlm = (input: {
  messages: Array<{ role: 'system' | 'user'; content: string }>
  temperature?: number
}) => Promise<string | null>

const SEASON_RESOLVE_PROMPT = `你在判断一批网盘文件夹分别属于一部剧集的哪一季。国内综艺/剧集资源站常用"防和谐"手法把文件夹名写成机器认不出来的样子——形近字替换、谐音字、偏旁拆字、西里尔字母/圈码数字混排、无关昵称掩护等，但人类读者靠形近/谐音大多还能猜出真实含义。

这些文件夹都是同一部剧的不同分享来源（同一个人从不同渠道各自转存的资源），互相独立——不是"一文件夹一季"的硬性排他关系，同一季完全可能同时出现在多个文件夹里。

给你：folders（每项含 folderName + tree 该文件夹下的目录结构，已跳过顶层文件夹自身 + extraFiles 文件夹里非"一集视频"的文件名，如压缩包/说明文件——真实的季度线索常年藏在这类文件名里，例如一个叫"XX 第二季.zip"的压缩包）、takenSeasons（已经被其它文件夹确定占用的季号，仅供你做排除法参考，不是排他规则——如果某个文件夹自己的线索明确指向一个"已占用"的季号，仍然应该给出这个季号，不要因为它在 takenSeasons 里就回避）、candidates（候选季号列表，每项带该季的集数，可作交叉参考，不必强求集数吻合）。

给 folders 里每一个文件夹判断一个季号，判不出就是 unknown。只输出一个 JSON 对象，key 是文件夹名（原样照抄，不要改写），value 是季号数字或字符串 "unknown"；不要输出任何解释、不要 markdown 围栏。`

/** 喂给 resolveSeasonsByLlm 的文件夹上下文——只给目录结构和非"一集"文件名,不给每一集视频的
 *  文件名(季度判断用不上,白占 token;上限见 season-resolve.ts 的 folderContext)。 */
export interface FolderContext { tree: string[]; extraFiles: string[] }

/**
 * 结构指纹 + 嵌套干净名 + 缓存都判不出季归属的文件夹,批量丢给模型一次判完——不是一个文件夹
 * 问一次:(1) 省调用次数;(2) 让模型能看见"哪些季号已经被别的文件夹确定占用了"(takenSeasons)
 * 做排除法,比每个文件夹各自蒙一次准。输出里某文件夹的季号不在候选列表里(模型瞎编/幻觉)、或者
 * 模型压根没给这个文件夹答案,一律当没判出来,不当真——宁可留 unresolved 进残留人工看一眼,
 * 不把错季号当真结论用。folders 为空时直接返回空结果,不发起调用。
 */
export async function resolveSeasonsByLlm(
  folders: { folderName: string; context: FolderContext }[],
  takenSeasons: number[],
  candidates: { season: number; episodeCount: number }[],
  invokeLlm: InvokeLlm,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (folders.length === 0) return out
  const payload = {
    folders: folders.map((f) => ({ folderName: f.folderName, tree: f.context.tree, extraFiles: f.context.extraFiles })),
    takenSeasons,
    candidates,
  }
  const messages = [
    { role: 'system' as const, content: SEASON_RESOLVE_PROMPT },
    { role: 'user' as const, content: JSON.stringify(payload) },
  ]
  const content = await invokeLlm({ messages, temperature: 0 }).catch(() => null)
  const m = content?.match(/\{[\s\S]*\}/)
  let parsed: unknown
  try { parsed = m ? JSON.parse(m[0]) : null } catch { parsed = null }
  // 未配置/调用失败/解析不出 JSON,answers 就空着——下面这个循环仍然给每个文件夹显式落一个 null,
  // 不留"这个文件夹到底问没问过"的歧义(调用方靠 Map.has 或 .get 都能拿到明确答案)。
  const answers = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  const known = new Set(candidates.map((c) => c.season))
  for (const f of folders) {
    const raw = answers[f.folderName]
    const season = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
    out.set(f.folderName, Number.isFinite(season) && known.has(season) ? season : null)
  }
  return out
}
