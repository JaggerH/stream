import { candidateKey } from '@subscribe/memberKey.ts'
import type { ChannelStream } from './types.ts'

/**
 * 「把这条流移到那个频道」之前先问一句：这一下真的会移过去吗？
 *
 * **为什么要有这个判据**：两种情况下"移动"的结果和用户预期不一样，而且都**不报错**——
 *
 * 1. 目标频道里已经有这条流（流可以被多个频道共享）。原来的实现照样跑两步 patch：给目标写一遍
 *    （去重后其实没变）、再把它从源频道摘掉。用户在目标频道看不到任何变化，以为"没移动"，
 *    而源频道那条其实已经消失了——**数据变了，人以为没变**，比什么都没发生更糟（实测确认）。
 * 2. 目标频道里已经有另一条流，但它的来源和要移的这条**完全相同**（同 source + 同参数）。
 *    移过去就是同一个频道里两条一模一样的采集，重复内容、重复消耗，没有人想要这个。
 *
 * 判据抽成具名函数是为了能单独钉测试：内联在事件处理里的 if 搜不到、也没法测。
 */
export type MovePlan =
  | { kind: 'move' }
  /** 目标频道本来就有这条流——这一下等于"从源频道移除"，做，但必须说清楚。 */
  | { kind: 'already-there'; message: string }
  /** 目标频道已有同来源的另一条流——不做，说清楚是哪一条挡着。 */
  | { kind: 'duplicate-source'; message: string; clashWith: string }

/** 一条流的全部来源键（source + params，判"是不是同一个来源"的唯一尺子，与订阅那条路同源）。 */
function sourceKeys(stream: ChannelStream): Set<string> {
  return new Set(stream.sources.map((m) => candidateKey(m.source.id, m.params)))
}

export function planStreamMove(
  moving: ChannelStream,
  from: { label: string },
  to: { label: string; streams: ChannelStream[] },
): MovePlan {
  const name = moving.description || moving.id

  if (to.streams.some((s) => s.id === moving.id)) {
    return {
      kind: 'already-there',
      message: `「${name}」本来就在「${to.label}」里，已把它从「${from.label}」移除`,
    }
  }

  const keys = sourceKeys(moving)
  const clash = to.streams.find((s) => [...sourceKeys(s)].some((k) => keys.has(k)))
  if (clash) {
    const clashName = clash.description || clash.id
    return {
      kind: 'duplicate-source',
      clashWith: clash.id,
      message: `「${to.label}」里已经有同一个来源的「${clashName}」，没有移动`,
    }
  }

  return { kind: 'move' }
}
