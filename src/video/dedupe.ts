import { dedupeKey } from './parse.ts'
import type { GroupedRelease } from './aggregate.ts'
import type { Release } from './types.ts'

/** 一条 release 的所有链接（有 links[] 用它，否则退到单个 link）。 */
function linksOf(r: Release): Array<{ url: string; type: Release['sourceType']; password?: string }> {
  if (r.links?.length) return r.links
  return [{ url: r.link, type: r.sourceType, password: r.password }]
}

/**
 * 跨源去重：`aggregate.ts` 明写「No cross-source merge」，同一个磁力从 nyaa/u3c3/pansou
 * 来三份就是三份。这里补上——有状态，一个实例喂多个源，先来的赢。
 *
 * 身份 = 一条 release 全部链接的键集合。全部见过 → 整条丢；有一个新的 → 整条留。
 * 只做 links[] 内部的同键去重（一条消息把同一个链接列了两遍），**不**按类型收窄
 * links[]——那是前端过滤的职责。
 *
 * 调用方的顺序语义是它自己的选择：批量路按 Provider 成员声明顺序喂（确定性），
 * 流式路按到达顺序喂（先到先得——要按声明优先级就得等齐，那就废掉了流式）。
 */
export class Deduper {
  private readonly seen = new Set<string>()

  admit(grouped: GroupedRelease[]): { kept: GroupedRelease[]; dropped: number } {
    const kept: GroupedRelease[] = []
    let dropped = 0
    for (const g of grouped) {
      const all = linksOf(g.release)
      // links[] 内部同键去重(保留首次出现) + 找出未见过的键
      const byKey = new Map<string, (typeof all)[number]>()
      const freshKeys: string[] = []
      for (const l of all) {
        const key = dedupeKey(l.url, l.type)
        if (byKey.has(key)) continue
        byKey.set(key, l)
        if (!this.seen.has(key)) freshKeys.push(key)
      }
      if (freshKeys.length === 0) {
        dropped++
        continue
      }
      for (const key of byKey.keys()) this.seen.add(key)
      const uniq = [...byKey.values()]
      const primary = uniq[0]
      kept.push({
        ...g,
        release: {
          ...g.release,
          links: g.release.links?.length ? uniq : undefined,
          link: primary.url,
          sourceType: primary.type,
          password: primary.password,
        },
      })
    }
    return { kept, dropped }
  }
}
