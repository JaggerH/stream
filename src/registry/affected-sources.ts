import type { SourceManifest } from '../manifest/types.ts'

/**
 * 「这个 Source 坏了，会连累谁」——`uses` 声明的反向闭包。
 *
 * 一个 Source 可以在 `uses` 里申报它的产出**依赖另一个 Source**（`SourceManifest.uses`；
 * recipe 侧写在 `meta.uses`）。今天真实存在的那一条：xhs 的 home / search 两个源，打开一条
 * 笔记要靠共用的 `xhs-detail` 去取正文与评论——detail 那份 recipe 漂了，账本只会记在
 * `xhs-detail` 头上，而 home / search 两个源照常被判健康，没有任何一处能回答「还有谁跟着哑」。
 *
 * **方向是「用的人申报」，不是「被用的人登记自己的用户」。** 后者要求每来一个新消费方就回去
 * 改那份被共用的 recipe——那正是「包装层漏成员」的形状：漏了不报错，只是安静地少算一个。
 * 申报写在消费方自己的文件里，加一个消费方只碰它自己那一个文件。
 *
 * 反向索引**每次查询现算**，不缓存：`uses` 随 recipe 包热装卸变（`Registry.swapGroup`），
 * 一份装配期建好的索引就是冻在启动那一刻的答案，而且失效时不报错、只是少算几条边。
 * 查询本身是罕发的（一次漂移、一次人工提问），O(n) 扫一遍 manifest 便宜得多。
 */
export interface AffectedSourcesResult {
  /** 起点，归一成全名；解析不到时是原样输入 */
  id: string
  /** 受影响的全名（含起点自己），字典序 */
  affected: string[]
  /** 解析不到的 `uses` 边，形如 `<声明方全名> → <写下的 id>`。
   *
   *  **这是答案里的洞，不是噪音**：一条解析不到的边完全可能就指着本次查询的起点（第三方包没装、
   *  id 打错、裸名歧义），所以它必须跟着结果一起说出来。压掉它就是把「这条没验到」讲成「验过了」。 */
  unresolved: string[]
}

/** 把一个写下的 id 归一成注册表里的全名；解析不到（或歧义）返回 undefined。 */
export type ResolveSourceId = (id: string) => string | undefined

/**
 * 从 `startId` 出发，沿 `uses` 的反向边求传递闭包。
 *
 * 传递闭包而不是一层：A 用 B、B 用 C，C 坏了 A 也哑——只报 B 等于报了一半。环自带保护
 * （访问过的不再入队），因为 `uses` 是作者手写的，没有任何一处阻止他写出一个环。
 */
export function affectedSources(
  manifests: readonly SourceManifest[],
  resolve: ResolveSourceId,
  startId: string,
): AffectedSourcesResult {
  const start = resolve(startId) ?? startId
  const usedBy = new Map<string, string[]>()
  const unresolved: string[] = []
  for (const m of manifests) {
    for (const raw of m.uses ?? []) {
      const target = resolve(raw)
      if (!target) {
        unresolved.push(`${m.id} → ${raw}`)
        continue
      }
      const list = usedBy.get(target)
      if (list) { if (!list.includes(m.id)) list.push(m.id) } else usedBy.set(target, [m.id])
    }
  }
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    for (const consumer of usedBy.get(queue.shift()!) ?? []) {
      if (seen.has(consumer)) continue
      seen.add(consumer)
      queue.push(consumer)
    }
  }
  return { id: start, affected: [...seen].sort(), unresolved: unresolved.sort() }
}

/**
 * 反着问同一张图：「**我**依赖的东西里，有没有正坏着的」。
 *
 * 界面上要露的就是这一侧——一个绿着的源，可能因为它依赖的东西坏了而实际上是残的
 * （xhs 的 home/search 照常采集成功、健康全绿，而共用的 `xhs-detail` 一漂，点开每条笔记都是空的）。
 * 正向那一侧（「我坏了会连累谁」）在界面上没有落脚点：被共用的那个源往往不是任何一条 Stream 的
 * 成员，压根没有属于它的那一行。
 *
 * **不写第二份图遍历**，而是对每个坏源问一次正向闭包、看谁在答案里。多一份遍历就多一处会和
 * `uses` 语义漂移的实现，而漂移了不报错、只是有一边少算几条边。传递性也随之白来：
 * A 用 B、B 用 C，C 坏了 A 也在 `affectedOf(C)` 里。
 *
 * @param affectedOf 一次正向查询（`Registry.affectedSources`）
 * @param brokenIds 此刻非健康的源 id（任意存量形状，归一由 `affectedOf` 做）
 * @returns 消费方全名 → 连累它的那些坏源全名（字典序）。**不含它自己**：自己坏了由它自己那颗
 *          健康点说，在同一行再说一遍只是把噪音翻倍。
 */
export function brokenDependencies(
  affectedOf: (id: string) => AffectedSourcesResult,
  brokenIds: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const rawId of brokenIds) {
    const { id, affected } = affectedOf(rawId)
    for (const consumer of affected) {
      if (consumer === id) continue
      const list = out.get(consumer)
      if (list) { if (!list.includes(id)) list.push(id) } else out.set(consumer, [id])
    }
  }
  for (const list of out.values()) list.sort()
  return out
}
