import { createHash } from 'node:crypto'
import type { A11yQuery } from './desktop-driver.ts'
import type { SeeRegionRect, TextWhere } from './desktop-recipe.ts'

/** 一个状态的名字，`<包>/<状态>` 形状，人写的。 */
export type StateId = string

/**
 * 认状态用的特征。**特征回答「是什么」，约束回答「是哪个」**——相对位置关系那类属于约束，
 * 归定位层（`see`），不进这里。混进同一张表就写不出判据。
 *
 * `absent: true` 不是补充而是必需的一档：「已登录」最可靠的判据往往就是「登录按钮不在了」。
 *
 * **背景色不作为特征**——它跟随系统主题变化，跨机器不可移植。类型上拦不住，靠 review。
 */
export type Feature =
  | { kind: 'url'; pattern: string }
  | { kind: 'dom'; selector: string; absent?: boolean }
  | { kind: 'a11y'; query: A11yQuery; absent?: boolean }
  | { kind: 'text'; text: string; region?: SeeRegionRect; absent?: boolean; where?: TextWhere }
  /**
   * 屏上有没有一小块长成这样。用于**文字答不了的那些**：只有图标没有标签的按钮、
   * 输入框拿到焦点时的那圈高亮、头像角上的未读徽标。
   *
   * `png` 是 base64 的参考图。判法是 NCC 模板匹配（`find_image`，仓库里已有的生产实现），
   * **不是感知哈希**——NCC 抗线性亮度/对比度变化，而且已经带粗搜加速。
   *
   * **它扛不住明暗主题切换**（那是反色，不是线性变化）。主题变了就得重录参考图，这是这一档
   * 的固有边界，不是选错了算法。
   */
  | { kind: 'image'; png: string; minScore?: number; absent?: boolean; where?: TextWhere }

export interface StateDef {
  id: StateId
  /** 全部命中才算认出（AND）。空数组非法——它会匹配一切。 */
  features: Feature[]
  /** 人写的一句话，只进轨迹和提议，不参与匹配。 */
  note?: string
  /**
   * **同组的状态互斥，跨组可以同时成立。** 自由字符串，人写的。
   *
   * 为什么需要它：屏幕上常常同时有几件互不相干的事。活体实测（QQ）——「中间列开着搜索面板」
   * 和「右侧是和某人的对话」**同时为真**，两条都对。没有这一格，区分度闸会把它们报成撞车，
   * 而那是误报，会挡住一个完全合法的状态定义。
   *
   * **这不是"把屏幕切成区"**（那条路已经否掉，见视觉 spec §5.1）：它是语义标签，
   * 想让"有未读"自成一组也行，和几何没有关系。
   *
   * 省略 = 都在同一个默认组里，于是照旧两两互比——存量图不受影响。
   * 它**不参与匹配**，运行时的互斥仍然靠 `absent` 撑开。
   */
  group?: string
  /**
   * **这是条死路**,值是给人看的理由。认出它就该立刻停,而不是等防转圈撞满三次、
   * 或者把预算耗光才停——**区分「再等等就好」和「再等也没用」,比认出「这是什么」更值钱**。
   * 防转圈是最后一道网,不是判据。
   */
  deadEnd?: string
}

export interface Transition {
  from: StateId
  /**
   * 省略 = **没有目的地**,走完只能重认。全局状态(spec §3.5)的出口都是这一种:
   * 从挑战页清出来之后落在哪,取决于本来要去哪。
   *
   * 这类转移**不参与找路**:它是逃生口,不是路线。
   */
  to?: StateId
  /** 复用现有 recipe 的步骤类型，不新造。走完**不假定**一定到了 `to`。 */
  steps: unknown[]
}

export interface StateGraph {
  states: StateDef[]
  transitions: Transition[]
  /** 预留：迷路时的「家」。本期不实现，见 spec §10。 */
  anchor?: StateId
}

/** 某个状态的一次实测：那一刻为真的特征键。用于区分度闸。 */
export interface Observation {
  state: StateId
  truths: string[]
}

/** 特征的规范化键。`absent` 与否是两条不同的键——「它在」和「它不在」不是同一件事。 */
export function featureKey(f: Feature): string {
  switch (f.kind) {
    case 'url':
      return `url:${f.pattern}`
    case 'dom':
      return `dom:${f.absent ? '!' : ''}${f.selector}`
    case 'a11y':
      return `a11y:${f.absent ? '!' : ''}${JSON.stringify(f.query)}`
    case 'text':
      // `where` 必须进键：「名字在屏上」和「名字在那个图标左边同一行」是两条不同的判据，
      // 键一样的话区分度闸会把后者当成前者，放过一个其实会撞车的状态。
      return (
        `text:${f.absent ? '!' : ''}${f.text}` +
        `${f.region ? `@${JSON.stringify(f.region)}` : ''}` +
        `${f.where ? `~${JSON.stringify(f.where)}` : ''}`
      )
    case 'image':
      // 参考图本身进键，但只取一段摘要——整张 base64 进键会让轨迹和撞车报告没法读。
      // **摘要必须是内容哈希，不能截前缀**：PNG 的 base64 头几十个字符是签名 + IHDR 开头，
      // 所有 PNG 都长一样，截前缀等于键只由长度决定——两张等长的小图标就共用一个键，
      // 区分度闸会把「有 A 图标」当成「有 B 图标」，而这道闸的全部意义就是防这个。
      return (
        `image:${f.absent ? '!' : ''}${createHash('sha256').update(f.png).digest('hex').slice(0, 12)}` +
        `${f.where ? `~${JSON.stringify(f.where)}` : ''}`
      )
  }
}

/**
 * 状态 id 的形状是 `<facility>/<状态>`：**进哪张图由前缀说了算**。写错前缀的状态不会报错，
 * 它只是谁也认不出——包自带的那张图查不到它，学到的那张也挂不上，而 identify 照常返回
 * "没认出来"。所以两个入口（包扫描器读 `states.json`、接受提议写学到那层）都得先过这一关。
 */
export function assertStateIdPrefix(facility: string, id: string): void {
  if (!id.startsWith(`${facility}/`)) throw new Error(`状态 id 必须带前缀 ${facility}/：${id}`)
}

export function validateStateGraph(g: StateGraph): void {
  const byId = new Map<StateId, StateDef>()
  for (const s of g.states) {
    if (s.features.length === 0) {
      throw new Error(`状态 ${s.id} 特征为空——它会匹配一切，等于把 identify 关掉`)
    }
    if (byId.has(s.id)) throw new Error(`状态 id 重复：${s.id}`)
    byId.set(s.id, s)
  }
  for (const t of g.transitions) {
    const from = byId.get(t.from)
    if (!from) throw new Error(`转移的 from 指向不存在的状态：${t.from}`)
    if (t.to !== undefined && !byId.has(t.to)) throw new Error(`转移的 to 指向不存在的状态：${t.to}`)
    // 死路却又声明了出口:两者矛盾。留着的话，读图的人和引擎会各信一半。
    if (from.deadEnd) throw new Error(`状态 ${t.from} 已声明为死路（${from.deadEnd}），不该再有出口`)
  }
  if (g.anchor !== undefined && !byId.has(g.anchor)) {
    throw new Error(`anchor 指向不存在的状态：${g.anchor}`)
  }
}

/** 这组特征在这次观测里是否全部成立（AND）。 */
export function matchesObservation(features: Feature[], o: Observation): boolean {
  const truths = new Set(o.truths)
  return features.every((f) => truths.has(featureKey(f)))
}

/**
 * 区分度闸：判据不是「这条特征能不能描述当前页」，而是**「它能不能只匹配当前页」**。
 *
 * 拿候选的**整组**特征去撞所有已知状态的历史观测，命中就是撞车。看整组而不是逐条，是因为
 * 单条不够、两条合起来唯一是完全正当的写法。
 *
 * 不设这道闸，状态库会越长越糊，最后每个状态都匹配上——而且查不出是哪天开始坏的。
 */
export function checkDiscriminative(
  candidate: StateDef,
  existing: StateDef[],
  observations: Observation[],
): { ok: true } | { ok: false; collidesWith: StateId[] } {
  // **只和同组的比。** 跨组同时成立是正当的（一个屏上可以既"开着搜索面板"又"在某人的对话里"），
  // 拿它当撞车会挡住合法的定义。省略 `group` 的都在同一个默认组，所以存量图照旧两两互比。
  const g = candidate.group ?? ''
  const others = new Set(
    existing.filter((s) => s.id !== candidate.id && (s.group ?? '') === g).map((s) => s.id),
  )
  // **撞上一个就够**，不是"撞上所有才算"。一条特征只要还会在别的状态上成立，它就回答不了
  // "我在哪"——而放行它的代价不是一次误判：状态库会越长越糊，最后每个状态都匹配上，
  // 且查不出是哪天开始坏的。
  const collidesWith = [
    ...new Set(
      observations
        .filter((o) => others.has(o.state) && matchesObservation(candidate.features, o))
        .map((o) => o.state),
    ),
  ]
  return collidesWith.length === 0 ? { ok: true } : { ok: false, collidesWith }
}

/**
 * BFS 找最短路。**刻意不是 Dijkstra**：除非边权有实测来源（耗时 / 成功率），否则 cost 是编的，
 * 而编出来的权重只会让路径选择变得没法解释。步数最少即可。
 */
export function findPath(g: StateGraph, from: StateId, to: StateId): Transition[] | null {
  if (from === to) return []
  const out = new Map<StateId, Transition[]>()
  for (const t of g.transitions) {
    // 逃生口没有目的地，规划不了——它只在"当前正踩在 from 上"时才有意义（见 escapesFrom）。
    if (t.to === undefined) continue
    const list = out.get(t.from) ?? []
    list.push(t)
    out.set(t.from, list)
  }
  const seen = new Set<StateId>([from])
  const queue: Array<{ at: StateId; path: Transition[] }> = [{ at: from, path: [] }]
  while (queue.length > 0) {
    const { at, path } = queue.shift()!
    for (const t of out.get(at) ?? []) {
      // 上面已跳过无 to 的转移，此处 t.to 必为已知
      const dest = t.to!
      if (seen.has(dest)) continue
      const next = [...path, t]
      if (dest === to) return next
      seen.add(dest)
      queue.push({ at: dest, path: next })
    }
  }
  return null
}

/** 某个状态的逃生口（没有目的地的转移）。清掉障碍用它，找路不用。 */
export function escapesFrom(g: StateGraph, from: StateId): Transition[] {
  return g.transitions.filter((t) => t.from === from && t.to === undefined)
}
