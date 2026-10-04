/**
 * 说话人认名：列出这条内容的声纹簇，认成某个人（或新建一个人）。一个簇都没有时它换成
 * 「补说话人」的入口（`voiceprint.recluster`：不重跑转写，只对已存的那份转写补一遍识别）——
 * 音频这条路上「转写完成但没有说话人标签」只有这一扇门。
 *
 * 卡片自己刷新，不向上要回调：认名/补说话人的结果全在这一格里可见，没有第二处要跟着变。
 *
 * **归属**（免得长出第三份）：这一份服务**音频/转写**，唯一的消费者是对话里的转成文字工具卡。
 * 视频分段那套（谁在第几分钟说话、只看谁）是 `MovieChannel` 的 `SpeakerSegmentPanel`，
 * 形态不同不合并。再有第三个消费者，用这一份，不许再抄。
 *
 * **这里没有「试听 / 只看TA」**：那两颗按钮曾经是可选的（给得出播放句柄的消费者才画），
 * 唯一给得出的是详情页转写档，而它 2026-08-12 已撤销。工具卡够不着播放器实例，留着两个
 * 永远没人传的回调等于给下一个人埋一条不存在的路（spec 2026-08-12-speaker-axis-in-chat §5）。
 */
import { useCallback, useEffect, useState } from 'react'
import { toast } from '../acrylic/sonner.tsx'

import { ApiError, api, LOCAL } from '../../lib/api.ts'
import type { SpeakerCluster, VoicePerson } from '../../lib/types.ts'
import { cn } from '../../lib/utils.ts'
import { Badge } from '../acrylic/badge.tsx'
import { Button } from '../acrylic/button.tsx'
import { Card, CardTitle } from '../acrylic/card.tsx'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '../acrylic/item.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'

const TYPE = {
  callout: 'text-[12px] leading-[1.4] [letter-spacing:var(--text-callout-tracking)]',
} as const

export function SpeakerEnrollList({
  itemId,
  names,
}: {
  itemId: string
  /** label → 人看的名字（`useSpeakerMap().names`）。缺席 → 显示原始簇标签。**别在这里自己把
   *  `SPEAKER_03` 翻译第二遍**：那份映射是全站唯一一处，见 useSpeakerMap 的头注。 */
  names?: Record<string, string>
}) {
  const [clusters, setClusters] = useState<SpeakerCluster[]>([])
  const [persons, setPersons] = useState<VoicePerson[]>([])
  const [identifying, setIdentifying] = useState(false)

  const refreshVoice = useCallback(async () => {
    try {
      const [cs, ps] = await Promise.all([api.voiceprint.listClusters(LOCAL, itemId), api.voiceprint.listPersons(LOCAL)])
      setClusters(cs)
      setPersons(ps)
    } catch {
      setClusters([])
    }
  }, [itemId])

  useEffect(() => {
    void refreshVoice()
  }, [refreshVoice])

  // 补说话人是分钟级的后台活（重提音频 + diarize），期间没有别的完成信号——唯一的信号就是
  // 簇长出来。排队后定时重拉，簇出现（或组件卸载）即停。
  useEffect(() => {
    if (!identifying) return
    if (clusters.length > 0) {
      setIdentifying(false)
      return
    }
    const timer = setInterval(() => void refreshVoice(), 10_000)
    return () => clearInterval(timer)
  }, [identifying, clusters.length, refreshVoice])

  const enrollCluster = async (cluster: string, personId: string) => {
    try {
      await api.voiceprint.enroll(LOCAL, itemId, cluster, personId)
      await refreshVoice()
    } catch (e) {
      toast.error('认人失败', { description: e instanceof ApiError ? e.message : '' })
    }
  }

  const recluster = async () => {
    try {
      await api.voiceprint.recluster(LOCAL, itemId)
      setIdentifying(true)
      toast.success('已排队补说话人', { description: '不重跑转写，只识别发言人；完成后自动刷新' })
    } catch (e) {
      // 409 = 这条已经有识别/转写在跑（后端显式区分了「没配」503 和「有活儿」409）——
      // 它不是失败，是「已经在做了」，照样进轮询等结果。
      if (e instanceof ApiError && e.status === 409) {
        setIdentifying(true)
        toast.info('这条已有识别任务在跑', { description: '跑完这里会自己出说话人' })
        return
      }
      toast.error('补说话人失败', { description: e instanceof ApiError ? e.message : '' })
    }
  }

  // 「转写完成了、但没有说话人标签」——这一格就是那条路的入口。旧的转成文字结果面板里有它
  // （`不重跑 STT，只补说话人`），面板删掉后音频这条路上一度无解：`recluster` 剩下的唯一
  // 前端消费者是影视频道的视频路径。簇为空时画按钮而不是直接 return null，就是补回它。
  if (clusters.length === 0) {
    return (
      <Card className="px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={cn('text-muted-foreground', TYPE.callout)}>这条还没有说话人</span>
          <Button variant="neutral" size="small" className="ml-auto" disabled={identifying} onClick={recluster}>
            {identifying ? '识别发言人中…' : '补说话人'}
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="px-4 py-3">
      <CardTitle className={cn('mb-2 self-start text-muted-foreground', TYPE.callout, 'font-medium')}>说话人</CardTitle>
      <ItemGroup className="gap-1">
        {clusters.map((c) => (
          <Item key={c.cluster} variant="muted" size="sm">
            <ItemContent className="min-w-0">
              <ItemTitle>{c.personName ?? names?.[c.cluster] ?? c.cluster}</ItemTitle>
              {c.pending ? (
                // 待确认的抽名:自我介绍抽到「X」但演职员表查无此人(不硬认)。问用户一次。
                <ItemDescription className="truncate">
                  抽到「{c.pending.name}」，演职员表里没有——{c.pending.evidence}
                </ItemDescription>
              ) : null}
            </ItemContent>
            <Badge variant="secondary" size="sm" className="tabular-nums">{Math.round(c.seconds)}s</Badge>
            {c.pending ? (
              // 认 = 走既有 enroll 通道(新建同名人物再绑此簇);不认 = 记否决,同名同作品不再问。
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="neutral"
                  size="small"
                  onClick={async () => {
                    try {
                      const created = await api.voiceprint.createPerson(LOCAL, c.pending!.name)
                      await enrollCluster(c.cluster, created.id)
                    } catch (err) {
                      toast.error('认人失败', { description: err instanceof ApiError ? err.message : '' })
                    }
                  }}
                >
                  认
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={async () => {
                    try {
                      await api.voiceprint.rejectPending(LOCAL, itemId, c.cluster)
                      await refreshVoice()
                    } catch (err) {
                      toast.error('操作失败', { description: err instanceof ApiError ? err.message : '' })
                    }
                  }}
                >
                  不认
                </Button>
              </div>
            ) : (
              <Select
                value=""
                onValueChange={async (v) => {
                  if (!v) return
                  if (v === '__new__') {
                    const name = prompt('人物名')?.trim()
                    if (!name) return
                    try {
                      const created = await api.voiceprint.createPerson(LOCAL, name)
                      await enrollCluster(c.cluster, created.id)
                    } catch (err) {
                      toast.error('新建人物失败', { description: err instanceof ApiError ? err.message : '' })
                    }
                    return
                  }
                  await enrollCluster(c.cluster, v)
                }}
              >
                <SelectTrigger size="small" className="ml-auto w-[7.5rem]" aria-label="认成">
                  <SelectValue placeholder="认成…" />
                </SelectTrigger>
                <SelectContent>
                  {persons.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                  ))}
                  <SelectItem value="__new__">＋ 新建人物</SelectItem>
                </SelectContent>
              </Select>
            )}
          </Item>
        ))}
      </ItemGroup>
    </Card>
  )
}
