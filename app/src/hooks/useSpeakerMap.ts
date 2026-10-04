import { useEffect, useMemo, useState } from 'react'
import { api, LOCAL } from '../lib/api.ts'
import type { Block } from '../lib/speaker-timeline.ts'
import type { SpeakerCluster } from '../lib/types.ts'

/** One person's airtime in this item. */
export interface SpeakerMapPerson {
  label: string
  /** 这个人在本集的**总发言时长**（簇口径，来自 /clusters）——不是下面那些块加起来。
   *  两者差得很远：一个说满 310s 但每段都不长的人，块口径可能只剩几十秒甚至 0。 */
  seconds: number
  /** 够长的连续发言块（时间轴上的色段 / 「只看 TA」跳播用）。可以是空的：
   *  说得零碎的人照样在名单里，只是没有段可点。 */
  blocks: Block[]
}

export interface SpeakerMap {
  /** every speaker's qualifying blocks for this item (empty until identify has run) */
  blocks: Block[]
  /** blocks grouped per speaker, longest talker first — drives chips and the segment list */
  people: SpeakerMapPerson[]
  /** null = show everyone and don't skip; a list = only play these labels */
  activeSpeakers: string[] | null
  toggleSpeaker: (label: string) => void
  /** `forItemId` 用于「打开另一集并只看某人」：那一刻 hook 的 itemId 还是上一集（setState 未提交），
   *  不显式指定就会把选择挂到错的 item 上、随后被切集清掉。 */
  soloSpeaker: (label: string, forItemId?: string) => void
  /** Re-fetch the item's blocks. Enrolling a cluster to a person RENAMES its label in the stored
   *  transcript, so the panel must re-read after 认人 or it keeps showing the old `SPEAKER_NN`. */
  refresh: () => void
  /** label → 人看的名字：认领过的显示人名，没认领的显示「说话人 N」（N 是按发言时长排的序号）。
   *  **每个显示说话人的界面都必须用这一份**——右侧面板和播放器进度条上的标记各算各的，就会出现
   *  同一个人在面板叫「说话人 2」、在进度条叫「SPEAKER_21」。 */
  names: Record<string, string>
  /** 还没认领到人的标签（面板据此才给「认成…」）。 */
  unnamed: Set<string>
  /** label → 待确认的抽名：自我介绍里抽到名字、但演职员表查无此人，不硬认，问用户一次。
   *  **每个显示说话人的界面都得用这一份**——只挂在音频侧那块面板上时，影视频道里同一集有两条
   *  待确认也只显示「说话人 1/2」，用户无从认起（这条就是那次的回归守卫）。 */
  pending: Record<string, { name: string; evidence: string }>
}

/** 后端给匿名簇的机器标签（`SPEAKER_03` 等）。认成人之后 enroll 会把标签改写成人名，所以
 *  「还没认领」这件事直接从标签形状就能判出来——不必等 /clusters 回来，声纹库 503 时也照样成立。 */
const RAW_SPEAKER_LABEL = /^(speaker|spk)[_\s-]?\d+$/i

/** 连续发言块的下限：块是给「时间轴色段 / 只看 TA 跳播」用的，太碎的段跳来跳去没法看。
 *  **它不是名单的门槛**——曾经是（120s），结果 S03E02 上 12 个说话人只列出 3 个：徐不弃说满
 *  310s 却拆成 74/84/77 三段，一段都够不到，整个人连同他那条待确认一起消失。 */
const BLOCK_MIN_SECONDS = 30
/** 进名单的门槛，按**总发言时长**算。碎渣簇（diarization 的 1–2 秒残渣）掉出去。 */
const ROSTER_MIN_SECONDS = 30

/**
 * The item's speaker map — one implementation shared by every surface that plays it
 * (the timeline's inline player and the video channel's fullscreen player).
 *
 * `itemId` is whatever key the transcript is stored under: an inbox item's id, or a
 * netdisk-bound episode's leftKey (`tmdb:<id>:S03E02`). Selection is carried WITH that id so
 * switching episodes drops the previous filter instead of leaking it onto the next one.
 */
export function useSpeakerMap(itemId: string | null | undefined): SpeakerMap {
  const [blocks, setBlocks] = useState<Block[]>([])
  const [reloadKey, setReloadKey] = useState(0)
  const [request, setRequest] = useState<{ itemId: string; labels: string[] } | null>(null)
  const activeSpeakers = request && request.itemId === itemId ? request.labels : null

  useEffect(() => {
    if (!itemId) {
      setBlocks([])
      return
    }
    let alive = true
    void api.voiceprint
      .blocks(LOCAL, itemId, { minSeconds: BLOCK_MIN_SECONDS })
      .then((b) => { if (alive) setBlocks(b) })
      .catch(() => { if (alive) setBlocks([]) })
    return () => {
      alive = false
    }
  }, [itemId, reloadKey])

  const toggleSpeaker = (label: string) => {
    if (!itemId) return
    setRequest((cur) => {
      const base = cur && cur.itemId === itemId ? cur.labels : []
      const set = new Set(base)
      if (set.has(label)) set.delete(label)
      else set.add(label)
      return set.size ? { itemId, labels: [...set] } : null // empty = back to "no filter"
    })
  }
  const soloSpeaker = (label: string, forItemId?: string) => {
    const target = forItemId ?? itemId
    if (target) setRequest({ itemId: target, labels: [label] })
  }

  const refresh = () => setReloadKey((k) => k + 1)

  // 认领状态只在这一集**确实有说话人块**时才去问——没识别过的条目（绝大多数 inbox item 都是）
  // 问了也只会拿到空或 503，白打一趟。声纹库没配时同样静默降级成「全是未认领」。
  const [clusters, setClusters] = useState<SpeakerCluster[]>([])
  useEffect(() => {
    if (!itemId || blocks.length === 0) {
      setClusters([])
      return
    }
    let alive = true
    void api.voiceprint
      .listClusters(LOCAL, itemId)
      .then((cs) => { if (alive) setClusters(cs) })
      .catch(() => { if (alive) setClusters([]) })
    return () => {
      alive = false
    }
  }, [itemId, reloadKey, blocks.length])

  /** 名单 = 这一集的簇（按**总发言时长**过门槛），块只是挂在每个人身上的时间轴素材。
   *  簇信息拿不到时（声纹库 503 / 端点还没答）退回按块聚合——降级成旧口径，总好过空白。 */
  const people = useMemo(() => {
    const blocksByLabel = new Map<string, Block[]>()
    for (const b of blocks) {
      const cur = blocksByLabel.get(b.label)
      if (cur) cur.push(b)
      else blocksByLabel.set(b.label, [b])
    }
    if (clusters.length === 0) {
      return [...blocksByLabel.entries()]
        .map(([label, bs]) => ({ label, seconds: bs.reduce((s, b) => s + (b.end - b.start), 0), blocks: bs }))
        .sort((a, b) => b.seconds - a.seconds)
    }
    return clusters
      .filter((c) => c.seconds >= ROSTER_MIN_SECONDS || c.pending)
      .map((c) => ({ label: c.cluster, seconds: c.seconds, blocks: blocksByLabel.get(c.cluster) ?? [] }))
      .sort((a, b) => b.seconds - a.seconds)
  }, [blocks, clusters])

  const { names, unnamed } = useMemo(() => {
    const names: Record<string, string> = {}
    const unnamed = new Set<string>()
    people.forEach((p, i) => {
      const enrolled = clusters.find((c) => c.cluster === p.label)?.personName
      const known = enrolled ?? (RAW_SPEAKER_LABEL.test(p.label) ? null : p.label)
      names[p.label] = known ?? `说话人 ${i + 1}`
      if (known === null) unnamed.add(p.label)
    })
    return { names, unnamed }
  }, [people, clusters])

  // 待确认只对「这一集确实有发言块的那些簇」有意义——碎渣簇进不了 people，也就没有一行能挂。
  const pending = useMemo(() => {
    const out: Record<string, { name: string; evidence: string }> = {}
    for (const c of clusters) if (c.pending) out[c.cluster] = c.pending
    return out
  }, [clusters])

  return { blocks, people, activeSpeakers, toggleSpeaker, soloSpeaker, refresh, names, unnamed, pending }
}
