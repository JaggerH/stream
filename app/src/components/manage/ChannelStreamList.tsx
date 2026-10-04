/**
 * 一个频道的「订阅列表」——Stream 卡 + 它们身上的全部写操作，自带确认框与来源配置流程。
 *
 * **一份实现，多处渲染**：频道配置面的两个宿主（面板的「配置」分页 / `ChannelManageSheet`）
 * 都用它。别为某个新宿主再画一份：这两处曾经各画各的——一边是带健康点、抓取方式、周期徽标、
 * 逐来源健康态的卡，另一边只有一行「名字 + N 个来源」。同一条 Stream 在两个地方长得不一样、
 * 能做的事也不一样，而且**漂移了不会有任何测试报警**（两边各测各的）。
 *
 * 写操作全在这里面，不往外抛：`useChannels()` 的共享名录 + `api.*`。外面只需要知道
 * 「改完了」（`onChanged`），不需要知道改了什么。两个例外由调用方决定摆在哪，因为它们**不是
 * 就地发生的**：
 * - `onEditStream`：整条 Stream 的抓取设置是一整页（`StreamSettingPage`），配置分页把它当浮层
 *   盖——摆哪儿是宿主的布局问题，所以往上抛而不是在这里决定。
 * - `onPreview`：预览要 `PreviewContext`（弹窗归 App 画），面板里没有那个 Provider。**不传就
 *   不画预览键**，而不是画一个点了抛错的键。
 */
import { useEffect, useState, type ReactElement } from 'react'
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react'
import { toast } from '../acrylic/sonner.tsx'
import { cn } from '../../lib/utils.ts'
import { api, type Connection } from '../../lib/api.ts'
import { unsubscribe } from '@subscribe/subscribe.ts'
import { webTransport, toChannelSummaries } from '../../lib/subscribe-shell.ts'
import { useChannels } from '../../lib/channels.tsx'
import { fetchSourceHealth, statusLabel, needsAttention, type SourceHealthView } from '../../lib/api.source-health.ts'
import { manageBridge } from '../../panel/manage-bridge.ts'
import { Badge } from '../acrylic/badge.tsx'
import { Button } from '../acrylic/button.tsx'
import { Input } from '../acrylic/input.tsx'
import { ItemGroup } from '../acrylic/item.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../acrylic/dialog.tsx'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '../ui/acrylic-card.tsx'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '../ui/empty.tsx'
import { ButtonGroup, ButtonGroupSeparator } from '../acrylic/button-group.tsx'
import { SourceItem, type SourceItemData } from '../SourceItem.tsx'
import { SourceHealthDot, SourceHealthHover } from '../SourceHealthDot.tsx'
import { SourceBrowserModal } from '../source/SourceBrowserModal.tsx'
import { SourceConfigSheet } from '../source/SourceConfigSheet.tsx'
import { streamRawMembers, type ConfigTarget } from '../source/destination.ts'
import { planStreamMove } from '../../lib/move-stream.ts'
import { attachCandidates } from './manage-helpers.ts'
import type { PreviewTarget } from '../../lib/previewStage.ts'
import type {
  ChannelStream, ChannelView, DependencyIssue, PresentView, SourceDetail, SourceHealthError,
  SourceSummary, Stream, StreamMember,
} from '../../lib/types.ts'

type Health = 'healthy' | 'degraded' | 'dead'

const DOT_CLASS: Record<Health, string> = {
  healthy: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  dead: 'bg-rose-500',
}

const HEALTH_LABEL: Record<Health, string> = {
  healthy: '正常',
  degraded: '降级',
  dead: '失效',
}

const STRATEGY_LABEL: Record<string, string> = {
  fanout: '聚合',
  exclusive: '互斥·优先级',
}

/** 一条 Stream 的健康态 = 它最坏的那个来源。 */
export function streamHealth(s: ChannelStream): Health {
  let worst: Health = 'healthy'
  for (const src of s.sources) {
    if (src.health === 'dead') return 'dead'
    if (src.health === 'degraded') worst = 'degraded'
  }
  return worst
}

/** 采集周期 → 紧凑展示：取最接近的整单位（48h 显示成 2d），小数截到最近整数。 */
export function fmtCadence(s: number): string {
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

/** 一个来源成员的展示身份**就是**后端那份 publicSource() 投影，原样渲染、零 id 猜测；
 *  只把绑定态（主力 / 健康 / 依赖）嫁接上去。 */
function sourceView(src: StreamMember): SourceItemData & {
  active?: boolean; health?: Health; healthError?: SourceHealthError; dependencyIssues?: DependencyIssue[]
} {
  return {
    id: src.source.id,
    title: src.source.title,
    description: src.source.description,
    pluginName: src.source.pluginName,
    facility: src.source.facility,
    active: src.active,
    health: src.health,
    healthError: src.healthError,
    dependencyIssues: src.dependencyIssues,
  }
}

/**
 * 「这个源自己是绿的，但它依赖的东西坏了」——那个静音故障唯一的出口。
 *
 * 为什么挂在**用它的人**身上而不是坏掉的那个源身上：被共用的那个源（xhs 的 detail）往往不是
 * 任何一条 Stream 的成员，界面上压根没有属于它的行；而 home/search 的行**天天在用户眼前**，
 * 且正是它们看起来一切正常。反过来（在 detail 行上写「另有 N 个源依赖我」）今天没有落脚点。
 *
 * **只在真出问题时出现，不常驻。** 全库今天只有一条 `uses` 关系，常驻等于给每一行加一句恒真的
 * 废话；而这句话唯一的用处就是解释「为什么这条绿着的源其实是残的」——没问题时它没有内容。
 */
export function DependencyIssueNote({ issues }: { issues: DependencyIssue[] }) {
  if (!issues.length) return null
  return (
    <div className="mt-0.5 flex flex-col gap-0.5 pl-1">
      {issues.map((iss) => (
        <p key={iss.kind + iss.id} className="flex items-start gap-1 text-[11px] leading-relaxed text-amber-500">
          <TriangleAlertIcon className="mt-0.5 size-3 shrink-0" />
          <span>
            {iss.kind === 'broken'
              ? `依赖的「${iss.title || iss.id}」${HEALTH_LABEL[iss.health]}——本来源自己仍在正常采集，但内容可能是残的。`
              : `申报依赖的「${iss.id}」找不到（对应的包没装，或 id 写错了）——内容可能是残的。`}
          </span>
        </p>
      ))}
    </div>
  )
}

export function ChannelStreamList({
  conn, channel, present, title, columns = 1, onChanged, onEditStream, onPreview,
}: {
  conn: Connection
  channel: ChannelView
  /** 这一区的小标题（如「订阅列表」/「绑定的数据源」）。加/挂两个入口**恒在标题这一行的右侧**
   *  ——它们是这一区的动作，摆在区首才指得住；摆在列表末尾时，卡一多就被推到屏幕外，
   *  用户得先滚过全部订阅才找得到"再加一个"。不传标题，那一行就只有右侧那两个键。 */
  title?: string
  /** 用来判 live 档（数据现读不入库，那类频道没有未读和订阅提醒，要说出来）。 */
  present?: PresentView
  /** 最多排几列。**是上限不是定值**：真实列数按容器宽度自己收（`@container`，见下面那段
   *  className）——面板浮层态只有 420px，写死三列就是三列挤扁的卡，而那时视口明明很宽。 */
  columns?: 1 | 2 | 3
  /** 写完了。共享名录这边自己会重拉，这个回调是给**名录之外**的东西用的（面板的频道导航等）。 */
  onChanged?: () => void
  /** 「编辑」一整条 Stream 的抓取设置。不传就不画这个键——见文件头注。 */
  onEditStream?: (stream: ChannelStream) => void
  /** 预览这条 Stream 的时间线效果。不传就不画预览键——见文件头注。 */
  onPreview?: (target: PreviewTarget) => void
}): ReactElement {
  const { channels, reload: reloadChannels, patchChannel } = useChannels()
  const [busy, setBusy] = useState(false)
  const [repairing, setRepairing] = useState<Record<string, SourceHealthView>>({})
  useEffect(() => {
    let alive = true
    fetchSourceHealth(conn.baseUrl)
      .then((d) => { if (alive) setRepairing(Object.fromEntries(d.sources.map((v) => [v.source.id, v]))) })
      .catch(() => { /* 附加信息：读不到就不画状态词，健康点仍在 */ })
    return () => { alive = false }
  }, [conn.baseUrl, channel.id])
  const [allStreams, setAllStreams] = useState<Stream[]>([])
  const [attachOpen, setAttachOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState<{ stream: ChannelStream; reason?: 'last-source' } | null>(null)
  const [browseTarget, setBrowseTarget] = useState<ConfigTarget | null>(null)
  const [addTarget, setAddTarget] = useState<{ target: ConfigTarget; source: SourceDetail } | null>(null)
  const [editing, setEditing] = useState<{ streamId: string; memberIndex: number; source: SourceDetail; params: Record<string, string> } | null>(null)

  // 写完统一走这里：共享名录重拉（本组件和同屏的别处看到的是同一份）+ 通知外面。
  const changed = async (): Promise<void> => {
    await reloadChannels()
    onChanged?.()
  }

  const streams = channel.streams

  const refreshStream = (stream: ChannelStream): void => {
    const label = stream.description || stream.id
    const p = api.refreshStream(conn, stream.id)
    toast.promise(p, {
      loading: `正在重新抓取「${label}」…`,
      success: (r) => `「${label}」已刷新：抓取 ${r.fetched} 条，新增 ${r.written} 条`,
      error: (e) => `刷新失败：${e instanceof Error ? e.message : String(e)}`,
    })
    void p.then(() => void changed()).catch(() => {})
  }

  const commitRename = async (stream: ChannelStream): Promise<void> => {
    const next = renameDraft.trim()
    setRenamingId(null)
    if (!next || next === stream.description) return
    try {
      await api.renameStream(conn, stream.id, next)
      await changed()
    } catch (e) {
      toast.error(`重命名失败：${(e as Error).message}`)
    }
  }

  // 移动：先加进目标再从源里摘（中途失败只会两边都在，绝不会变成孤儿）。移之前先问一句这一下
  // 到底会发生什么（判据见 lib/move-stream.ts）——两种情况结果和用户预期不一样且都不报错。
  const moveStream = async (streamId: string, destId: string): Promise<void> => {
    const dest = channels.find((c) => c.id === destId)
    const moving = streams.find((s) => s.id === streamId)
    if (!dest || !moving || dest.id === channel.id) return
    const plan = planStreamMove(moving, channel, dest)
    if (plan.kind === 'duplicate-source') {
      toast.error(plan.message)
      return
    }
    setBusy(true)
    try {
      await patchChannel(dest.id, { stream_ids: [...new Set([...dest.streams.map((s) => s.id), streamId])] })
      await patchChannel(channel.id, { stream_ids: streams.map((s) => s.id).filter((id) => id !== streamId) })
      await changed()
      // 目标本来就有它 → 这一下的实际效果是「从源频道移除」，必须说出来；用户否则只会看到
      // 目标频道毫无变化，而源频道那条不见了。
      if (plan.kind === 'already-there') toast.info(plan.message)
    } catch (e) {
      toast.error(`移动失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // 从本频道移除一条 Stream。走**共享**的 `unsubscribe` op（与扩展弹窗的「✓ 已订阅 → 移除」
  // 同一条代码路径）：解引用 + 孤儿 GC——没有别的频道还引用它就连抓取一起停掉。没有来源的
  // 退化流表达不成那个 op 的候选，只从引用列表里剔除。
  const doDelete = async (): Promise<void> => {
    if (pendingDelete === null) return
    const { stream } = pendingDelete
    setBusy(true)
    try {
      const summaries = toChannelSummaries(channels)
      const current = summaries.find((c) => c.id === channel.id)
      const first = stream.sources[0]
      if (current && first) {
        await unsubscribe(webTransport(conn), { sourceId: first.source.id, params: first.params, title: stream.description }, current, summaries)
      } else if (current) {
        await patchChannel(channel.id, { stream_ids: current.streamIds.filter((id) => id !== stream.id) })
      }
      setPendingDelete(null)
      await changed()
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  // 摘掉一条 Stream 的**最后一个**来源 = 把整条流清空 = 删掉它，所以那一档转到删除确认上去
  // （一句明确的警告），而不是静默 patch 出一个空成员表。
  const removeMember = async (stream: ChannelStream, memberIndex: number): Promise<void> => {
    if (stream.sources.length <= 1) {
      setPendingDelete({ stream, reason: 'last-source' })
      return
    }
    setBusy(true)
    try {
      await api.patchStreamMembers(conn, stream.id, streamRawMembers(stream).filter((_, i) => i !== memberIndex))
      await changed()
    } catch (e) {
      toast.error(`删除来源失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const openEditMember = async (stream: ChannelStream, memberIndex: number): Promise<void> => {
    const m = stream.sources[memberIndex]
    if (m === undefined) return
    try {
      const detail = await api.pluginSourceDetail(conn, m.source.pluginId, m.source.id)
      setEditing({
        streamId: stream.id,
        memberIndex,
        source: detail,
        params: Object.fromEntries(Object.entries(m.params ?? {}).map(([k, v]) => [k, String(v ?? '')])),
      })
    } catch (e) { toast.error((e as Error).message) }
  }

  const pickForAdd = async (target: ConfigTarget, s: SourceSummary): Promise<void> => {
    try {
      const detail = await api.pluginSourceDetail(conn, s.pluginId, s.id)
      setBrowseTarget(null)
      setAddTarget({ target, source: detail })
    } catch (e) { toast.error((e as Error).message) }
  }

  // 挂已有的：纯引用操作——把 stream id 并进本频道的引用列表。候选表要全库的 Stream，
  // 所以打开这个框时才拉（平时不拉：这是个很少点的入口，没必要给每次渲染加一次请求）。
  const openAttach = (): void => {
    setAttachOpen(true)
    void api.streams(conn).then(setAllStreams).catch((e: Error) => { toast.error(`读不到流库存：${e.message}`) })
  }

  const attach = async (streamId: string): Promise<void> => {
    setBusy(true)
    try {
      await patchChannel(channel.id, { stream_ids: [...streams.map((s) => s.id), streamId] })
      setAttachOpen(false)
      await changed()
    } catch (e) {
      toast.error(`挂入失败：${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const addButtons = (
    <div className="flex shrink-0 gap-2">
      <Button type="button" variant="neutral" size="small" onClick={() => setBrowseTarget({ kind: 'pick' })}>
        <PlusIcon />
        添加来源
      </Button>
      <Button type="button" variant="neutral" size="small" onClick={openAttach}>挂已有的</Button>
    </div>
  )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {title === undefined
          ? <span />
          : <h3 className="text-[12px] font-semibold text-muted-foreground">{title}</h3>}
        {addButtons}
      </div>
      {present?.data === 'live' ? (
        <p className="text-[11px] text-muted-foreground">
          这类频道的数据是打开时现读的，不入库——因此没有未读和订阅提醒。
        </p>
      ) : null}

      {streams.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>这个频道还没有内容源</EmptyTitle>
            <EmptyDescription>用上面的「添加来源」为「{channel.label}」加一个来源，开始采集内容。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {/* 列数按**容器**宽度收，不按视口——这张列表住在工作台面板那一列里（也可能是更窄的
              抽屉），视口宽不代表这块地方宽。`@` 变体查的是最近的**祖先**容器，所以
              `@container` 得由宿主声明（`ChannelConfigPanel` 上有一处），挂在这个 div 上是
              无效的：容器查询不查自己。 */}
          <div className={cn(
            'grid gap-4',
            columns >= 2 ? '@xl:grid-cols-2' : '',
            columns >= 3 ? '@3xl:grid-cols-3' : '',
          )}>
            {streams.map((stream) => {
              const health = streamHealth(stream)
              const sources = stream.sources.map(sourceView)
              const label = stream.description || stream.id
              return (
                <Card key={stream.id} className="flex flex-col py-4">
                  {/* Stream 头：只放这条流**自己**的属性 */}
                  <CardHeader className="px-4">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-[13.5px]">
                      {renamingId === stream.id ? (
                        <Input
                          autoFocus
                          size="medium"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={() => void commitRename(stream)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void commitRename(stream) }
                            else if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                          }}
                          className="min-w-0 flex-1"
                          aria-label={`重命名 ${label}`}
                        />
                      ) : (
                        <span
                          className="min-w-0 cursor-text truncate"
                          onDoubleClick={() => { setRenameDraft(stream.description || ''); setRenamingId(stream.id) }}
                        >
                          {label}
                        </span>
                      )}
                      <span title={HEALTH_LABEL[health]} className={`inline-block size-2 shrink-0 rounded-full ${DOT_CLASS[health]}`} />
                      {stream.strategy ? (
                        <Badge variant="secondary" size="sm" className="shrink-0">{STRATEGY_LABEL[stream.strategy] ?? stream.strategy}</Badge>
                      ) : null}
                      <Badge variant="secondary" size="sm" className="shrink-0">{fmtCadence(stream.cadence_seconds)}</Badge>
                    </CardTitle>
                    <CardAction className="flex shrink-0 items-center gap-1.5">
                      {onPreview !== undefined || onEditStream !== undefined ? (
                        <ButtonGroup variant="attached" size="small">
                          {onPreview !== undefined ? (
                            <Button
                              variant="ghost" size="small"
                              aria-label={`预览 ${label} 的时间线效果`} title="预览"
                              onClick={() => onPreview({ kind: 'stream', streamId: stream.id, label })}
                            >
                              预览
                            </Button>
                          ) : null}
                          {onPreview !== undefined && onEditStream !== undefined ? <ButtonGroupSeparator /> : null}
                          {onEditStream !== undefined ? (
                            <Button variant="ghost" size="small" onClick={() => onEditStream(stream)}>编辑</Button>
                          ) : null}
                        </ButtonGroup>
                      ) : null}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="small" icon aria-label={`${label} 更多操作`} disabled={busy}>
                            <MoreHorizontalIcon />
                          </Button>
                        </DropdownMenuTrigger>
                        {/* 关闭时不抢焦点：选「重命名」后焦点会在输入框挂上来之前被拉回触发器 */}
                        <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                          <DropdownMenuItem onSelect={() => refreshStream(stream)}>
                            <RefreshCwIcon className="size-3.5" />
                            手动刷新
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => setBrowseTarget({ kind: 'stream', streamId: stream.id })}>添加来源</DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => { setRenameDraft(stream.description || ''); setRenamingId(stream.id) }}>重命名</DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>移动到…</DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                              {channels.filter((t) => t.id !== channel.id).length === 0 ? (
                                <DropdownMenuItem disabled>无其他频道</DropdownMenuItem>
                              ) : (
                                channels.filter((t) => t.id !== channel.id).map((t) => (
                                  <DropdownMenuItem key={t.id} onSelect={() => void moveStream(stream.id, t.id)}>
                                    <span className="min-w-0 flex-1 truncate">{t.label}</span>
                                    <Badge variant="secondary" size="sm">{t.system ? '系统' : '自定义'}</Badge>
                                  </DropdownMenuItem>
                                ))
                              )}
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onSelect={() => { void navigator.clipboard?.writeText(stream.id) }}>复制 StreamID</DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-destructive data-[highlighted]:bg-destructive data-[highlighted]:text-destructive-foreground"
                            onSelect={() => setPendingDelete({ stream })}
                          >
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </CardAction>
                  </CardHeader>

                  <CardContent className="space-y-3 px-4">
                    {/* 来源成员——一条 Stream 直接列它的 Source，中间没有别的层 */}
                    {sources.length === 0 ? (
                      <p className="text-[12px] text-muted-foreground italic">暂无来源。</p>
                    ) : (
                      <ItemGroup className="gap-1">
                        {sources.map((src, i) => (
                          <div key={src.id + i}>
                          <SourceHealthHover
                            error={src.healthError}
                            sourceLabel={src.title}
                            stateLabel={src.health ? HEALTH_LABEL[src.health] : ''}
                          >
                            <SourceItem
                              source={src}
                              muted={src.health === 'dead'}
                              status={
                                <>
                                  {src.health ? <SourceHealthDot colorClass={DOT_CLASS[src.health]} label={HEALTH_LABEL[src.health]} /> : null}
                                  <RepairStatusWord view={repairing[src.id]} />
                                </>
                              }
                              actions={
                                <>
                                  {src.active ? <Badge size="sm">主力</Badge> : null}
                                  <div className="flex flex-col gap-0.5">
                                    <Button variant="ghost" size="mini" disabled={busy} onClick={() => void openEditMember(stream, i)}>编辑</Button>
                                    <Button variant="ghost" size="mini" disabled={busy} onClick={() => void removeMember(stream, i)}>删除</Button>
                                  </div>
                                </>
                              }
                            />
                          </SourceHealthHover>
                          {/* 挂在行**外**：`SourceHealthHover` 是「我自己坏了」的悬浮卡触发器，
                              而这条讲的是别人坏了——塞进去会被那张卡吃掉，且只有悬停才看得见。 */}
                          <DependencyIssueNote issues={src.dependencyIssues ?? []} />
                          </div>
                        ))}
                      </ItemGroup>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </>
      )}

      <Dialog open={pendingDelete !== null} onOpenChange={(o) => { if (!o) setPendingDelete(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{pendingDelete?.reason === 'last-source' ? '删除最后一个来源' : '删除 Stream'}</DialogTitle>
            <DialogDescription>
              {pendingDelete?.reason === 'last-source'
                ? <>这是「{pendingDelete.stream.description || pendingDelete.stream.id}」的最后一个来源，删除它将删除整个订阅流并停止抓取。</>
                : <>将从本频道移除「{pendingDelete?.stream.description || pendingDelete?.stream.id}」；若没有其他频道引用它，将一并停止抓取并删除。</>}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="neutral" size="large" disabled={busy} onClick={() => setPendingDelete(null)}>取消</Button>
            <Button type="button" variant="destructive" size="large" disabled={busy} onClick={() => void doDelete()}>
              {busy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={attachOpen} onOpenChange={setAttachOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>挂入已有的 Stream</DialogTitle>
            <DialogDescription>Stream 是全局身份，可被多个频道同时引用；挂入不影响它在其他频道的存在。</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-80 flex-col gap-1 overflow-y-auto px-4 pb-4 scrollbar-mac">
            {attachCandidates(channel, allStreams, channels).length === 0 ? (
              <p className="text-[12px] text-muted-foreground">库里没有可挂入的流。</p>
            ) : (
              attachCandidates(channel, allStreams, channels).map(({ stream, referencedBy }) => (
                <div key={stream.id} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px]">{stream.description || stream.id}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {referencedBy.length > 0 ? `已在：${referencedBy.join('、')}` : '未被任何频道引用'}
                    </div>
                  </div>
                  <Button size="mini" disabled={busy} aria-label={`挂入 ${stream.description || stream.id}`} onClick={() => void attach(stream.id)}>挂入</Button>
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      {browseTarget !== null ? (
        <SourceBrowserModal
          open
          onOpenChange={(o) => { if (!o) setBrowseTarget(null) }}
          conn={conn}
          surface="stream"
          onPick={(s) => void pickForAdd(browseTarget, s)}
        />
      ) : null}
      {addTarget !== null ? (
        <SourceConfigSheet
          open
          onOpenChange={(o) => { if (!o) setAddTarget(null) }}
          conn={conn}
          source={addTarget.source}
          target={addTarget.target}
          streams={streams}
          // 故意传空：`SourceConfigSheet` 靠 providers.length 决定要不要给「追加到某个 Provider 行」
          // 这个目的地。这里的语境是「给这个频道加一条订阅」，Provider 行不是频道的东西，列出来
          // 只会把用户引到一个跟本频道无关的地方。不是漏传，别补回去。
          providers={[]}
          channels={channels}
          defaultChannelId={channel.id}
          onSubmitted={() => void changed()}
        />
      ) : null}
      {editing !== null ? (
        <SourceConfigSheet
          open
          onOpenChange={(o) => { if (!o) setEditing(null) }}
          conn={conn}
          source={editing.source}
          target={{ kind: 'stream', streamId: editing.streamId, memberIndex: editing.memberIndex }}
          initialParams={editing.params}
          streams={streams}
          providers={[]}
          channels={channels}
          onSubmitted={() => void changed()}
        />
      ) : null}
    </div>
  )
}

/** 源行上的修复状态词（spec 2026-09-12 §4 入口 2）。宿主登记了桥才是按钮；没登记（DSH）只显示，不许诺一个点了没反应的入口。 */
function RepairStatusWord({ view }: { view?: SourceHealthView }): ReactElement | null {
  if (!view) return null
  const cls = `shrink-0 text-[11px] ${needsAttention(view.status) ? 'text-amber-600 font-semibold' : 'text-muted-foreground'}`
  const label = statusLabel(view.status)
  if (!manageBridge.available()) return <span className={cls}>{label}</span>
  return (
    <button type="button" className={`${cls} underline-offset-2 hover:underline`} onClick={(e) => { e.stopPropagation(); manageBridge.open({ view: 'source-health', sourceId: view.source.id }) }}>
      {label}
    </button>
  )
}
