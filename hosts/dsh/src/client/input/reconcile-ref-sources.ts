/**
 * `@` 的另外两组候选：**一条订阅** 和 **一个网盘目录**。
 *
 * 为什么和 `stream-ref-source.ts`（引一条内容）分开注册成两个源：`InputTriggerSource.name`
 * 就是菜单里的分组标题，三件东西本来就是三组——用户打 `@` 之后看到的是「内容 / 订阅 /
 * 网盘目录」，而不是一锅混在一起的列表。
 *
 * ## 为什么用 `{ text }` 而不是 `{ insert }` + codec
 *
 * 引一条内容要随附正文，所以那边必须走 `codec.serialize`（发送那一刻现取）。这两组不一样：
 * 它们要送进模型的东西**又短又不会变**——一条订阅就是它的 id，一个目录就是它的路径。
 * 管线的 `{ text }` 那一档正是为这种情况留的（把触发 token 原地换成字面文本，没有占位符、
 * 没有 occurrence 身份），省掉整套 codec 机制。
 *
 * ## 屏幕上是名字，送出去的是 id
 *
 * 插进草稿的那串字**同时带着两样**：`「某档节目」(stream:radio-user-z7o4v)`。
 * 光给名字，模型还得再搜一次、同名近名会搜错；而**整理动的是真文件，认错一条流的代价
 * 不是重来一次**（spec 2026-08-25-reconcile-as-conversation §3.2）。
 *
 * ## 目录候选怎么问 —— **路径不带前导斜杠**
 *
 * `@quark/来自` → 列 `/quark`、按 `来自` 过滤；`@quark/` → 列 `/quark` 全部；`@` → 列挂载根。
 *
 * **不能写成 `@/quark/`**：`/` 本身是 DSH 的另一个触发字符，紧跟在 `@` 后面的那个 `/` 会被
 * 斜杠命令管线抢走（活体实测：菜单弹出来的是 compact / export / model）。这不是我们能绕开的
 * 边角——两个触发器在同一个输入机上，先到先得。所以查询从**第一段目录名**起写，前导斜杠
 * 由这里补。（查询中间的 `/` 不受影响：它不在词边界上，斜杠管线不认它。）
 *
 * **只出目录不出文件**：这一组回答的是"整理哪个文件夹"。要看文件夹里有什么是 AI 的活
 * （`netdisk_browse`），不是这个菜单的活——候选菜单是随手引用，不是文件浏览器。
 */
import type {
  CandidateRequest,
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** 菜单分组名（同一个触发字符下必须唯一，重名注册会抛）。 */
export const SUBSCRIPTION_SOURCE_NAME = 'subscription'
export const NETDISK_SOURCE_NAME = 'netdisk-dir'

/** 每组最多列几条。 */
const MENU_LIMIT = 12

/** 一条订阅（只用得上这两样）。 */
export interface RefStream {
  id: string
  label: string
}

/** 插进草稿的那串字：人读名字，模型读 id。两样在同一串里，谁都不用再猜。 */
export function subscriptionRefText(s: RefStream): string {
  return `「${s.label}」(stream:${s.id})`
}

/** 目录的引用形态就是它自己——路径本身既无歧义又是模型要的那个值。 */
export function netdiskRefText(path: string): string {
  return path
}

/**
 * 把 `@` 后面那串字拆成「列哪个目录」+「按什么过滤」。**查询不带前导斜杠**（见头注）。
 *
 * 含 `/` → 最后一个 `/` 之前是目录、之后是过滤词；不含 → 列挂载根、整串当过滤词。
 * @param query - `@` 之后用户已经打出来的那串（不含 `@`）。
 * @returns `dir` 要去列的目录（绝对路径），`filter` 过滤词。
 */
export function splitDirQuery(query: string): { dir: string; filter: string } {
  // 用户手打或粘贴出前导斜杠时照收——`/quark/x` 与 `quark/x` 是同一件事，
  // 别为一个多余的斜杠给出空结果。
  const q = query.replace(/^\/+/, '')
  const cut = q.lastIndexOf('/')
  if (cut === -1) return { dir: '/', filter: q }
  return { dir: `/${q.slice(0, cut)}`, filter: q.slice(cut + 1) }
}

const includesFold = (haystack: string, needle: string): boolean =>
  needle === '' || haystack.toLowerCase().includes(needle.toLowerCase())

/**
 * 「引一条订阅」这一组。
 * @param listStreams - 取订阅名册（调用方注入，好让这个模块不认识 fetch）。
 */
export function makeSubscriptionRefSource(
  listStreams: (signal: AbortSignal) => Promise<readonly RefStream[]>,
): InputTriggerSource {
  // 候选行名 → 那条订阅。pick 只带回候选本身，要从行名找回 id 就得有这张表；
  // 菜单 pick 一定跟在一次 candidates() 之后，所以"上一次的表"就是对的那份。
  let byName = new Map<string, RefStream>()

  return {
    trigger: '@',
    name: SUBSCRIPTION_SOURCE_NAME,
    // 排在「内容」之后：打 `@` 最常引的还是正在看的那条内容。
    order: 1,
    async candidates(_session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      // 打出 `/` 就整组让位——那一刻用户明显在写路径，是网盘那一组的活。
      // **判据是"含不含 `/`"而不是"以 `/` 开头"**：路径查询不带前导斜杠（见头注），
      // 按开头判会让这一组在 `@quark/来自` 时还硬挤在菜单里。
      if (req.query.includes('/')) return []
      const streams = await listStreams(req.signal)
      const next = new Map<string, RefStream>()
      const taken = new Set<string>()
      const rows = streams
        .filter((s) => includesFold(s.label, req.query) || includesFold(s.id, req.query))
        .slice(0, MENU_LIMIT)
        .map((s) => {
          // 行名同组唯一——重名会让 pick 回查到错的那条，而整理动的是真文件。
          const name = taken.has(s.label) ? `${s.label}（${s.id}）` : s.label
          taken.add(name)
          next.set(name, s)
          return { name, description: s.id }
        })
      byName = next
      return rows
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      const s = byName.get(candidate.name)
      // 表里没有 = 这个候选不是我们出的（或表已被下一次 candidates 换掉）。让管线走默认落点，
      // 别插一个指向空气的引用。
      if (s === undefined) return undefined
      return { text: subscriptionRefText(s) }
    },
  }
}

/**
 * 「引一个网盘目录」这一组。
 * @param listDirs - 列一个目录下的**子目录名**（调用方注入）。
 */
export function makeNetdiskRefSource(
  listDirs: (dir: string, signal: AbortSignal) => Promise<readonly string[]>,
): InputTriggerSource {
  let byName = new Map<string, string>()

  return {
    trigger: '@',
    name: NETDISK_SOURCE_NAME,
    order: 2,
    async candidates(_session: ClientSessionContext, req: CandidateRequest): Promise<readonly InputTriggerCandidate[]> {
      const split = splitDirQuery(req.query)
      const names = await listDirs(split.dir, req.signal)
      const next = new Map<string, string>()
      const rows = names
        .filter((n) => includesFold(n, split.filter))
        .slice(0, MENU_LIMIT)
        .map((n) => {
          const full = split.dir === '/' ? `/${n}` : `${split.dir}/${n}`
          // 行名用**全路径**：同一个菜单里两个不同目录可以叫同一个名字（`/quark/更新` 与
          // `/aliyun/更新`），只拿末段当行名就会回查到错的那个。
          next.set(full, full)
          return { name: full }
        })
      byName = next
      return rows
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      const path = byName.get(candidate.name)
      if (path === undefined) return undefined
      return { text: netdiskRefText(path) }
    },
  }
}
