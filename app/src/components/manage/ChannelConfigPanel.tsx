/**
 * 一个频道的配置面——名称 / 所属空间 / 订阅列表 / 能力槽位 / 删除频道。
 *
 * **它是一块内容，不是一个浮层**：谁需要就地嵌一份配置面，就渲染它。目前两处宿主——
 * - 各 Present 顶栏下的「配置」分页（`ChannelTabs`），这是主入口；
 * - `ChannelManageSheet`，老版 UI 里从别处唤起的那张右侧抽屉，现在只是套了个 Sheet 外壳。
 * 两处因此永远是同一份内容，不会出现「抽屉里能改、分页里改不了」这种谁都不会去测的漂移。
 *
 * 订阅列表整块交给 `ChannelStreamList`（库存页用的是同一个组件），本文件只管频道**自己**的
 * 属性。`onEditStream` 往上抛的理由见那个文件的头注。
 */
import { useEffect, useRef, useState, type ComponentType, type ReactElement } from 'react'
import { toast } from '../acrylic/sonner.tsx'
import { api, type Connection } from '../../lib/api.ts'
import { Badge } from '../acrylic/badge.tsx'
import { Button } from '../acrylic/button.tsx'
import { Input } from '../acrylic/input.tsx'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../acrylic/dialog.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../acrylic/select.tsx'
import { useChannels } from '../../lib/channels.tsx'
import { ChannelSlotFields } from './ChannelSlotFields.tsx'
import { ChannelStreamList } from './ChannelStreamList.tsx'
import { EmbedUrlSection } from './EmbedUrlSection.tsx'
import { orphanedStreams } from './manage-helpers.ts'
import type { ChannelStream, ChannelView, PresentView, ProviderView, SpaceView } from '../../lib/types.ts'
import type { PreviewTarget } from '../../lib/previewStage.ts'

/** 按 present id 注入自定义管理区块的口子（如 video 未来的网盘绑定入口）。
 *  机制：管理面 = f(Present)，Present 专属能力从这里挂，不改配置面本体。
 *  - `embed`：面板地址（`options.url`），见 `EmbedUrlSection`。 */
export const PRESENT_EXTRAS: Partial<Record<string, ComponentType<{ conn: Connection; channel: ChannelView }>>> = {
  embed: EmbedUrlSection,
}

export function ChannelConfigPanel({
  conn, channelId, onChanged, onDeleted, onEditStream, onPreview, showHeader = true,
}: {
  conn: Connection
  channelId: string
  /** 改完了（名录之外的东西要跟着刷的，比如面板的频道导航）。 */
  onChanged?: () => void
  /** 频道被删掉了——宿主得把自己关掉/换一个频道，光刷名录不够。 */
  onDeleted?: () => void
  /** 「编辑」一整条 Stream 的抓取设置；不传就不画那个键（见 `ChannelStreamList` 头注）。 */
  onEditStream?: (stream: ChannelStream) => void
  /** 预览一条 Stream；不传就不画预览键（同上）。 */
  onPreview?: (target: PreviewTarget) => void
  /** 顶上那行「频道名 + Present 徽标」。抽屉里要（它就是标题），分页里不要（标题栏已经在上面了）。 */
  showHeader?: boolean
}): ReactElement {
  // 频道记录读写都走共享状态（lib/channels.tsx）——本面与「找资源」里的 SlotSwitcher chip
  // 订阅同一份，任一处改完另一处立刻看到，也就不会互相覆盖。
  const { channels, reload: reloadChannels, patchChannel } = useChannels()
  const [presents, setPresents] = useState<PresentView[]>([])
  const [spaces, setSpaces] = useState<SpaceView[]>([])
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const renameDoneRef = useRef(false)
  const renameInputRef = useRef<HTMLInputElement | null>(null)

  const load = async (): Promise<void> => {
    const [, prs, pvs, sps] = await Promise.all([
      reloadChannels(),
      api.presents(conn).then((r) => r.items),
      api.providers(conn),
      // 空间读不到只该让「所属空间」那一格消失，不该把整张配置面拖垮（其余几件事都还能做）。
      api.spaces(conn).catch(() => [] as SpaceView[]),
    ])
    setPresents(prs); setProviders(pvs); setSpaces(sps)
    setLoadError(null)
    setLoaded(true)
  }
  const loadOrFail = (): void => void load().catch((e) => {
    const message = (e as Error).message
    toast.error(message)
    setLoadError(message)
  })
  // loaded 复位是区分「还在拉」和「拉完了但这个频道/Present 不存在」的唯一依据——
  // 少了它，频道在别处被删 / present 值不在 /api/presents 里都只会永远转圈。
  useEffect(() => { setLoaded(false); loadOrFail() }, [channelId])

  const channel = channels.find((c) => c.id === channelId) ?? null
  const present = channel ? presents.find((p) => p.id === channel.present) : null

  // 走 loadOrFail 而非裸 load：写成功后的重拉也会失败（后端刚重启/网络抖动），裸 load 会静默
  // 吞掉它、让界面继续显示写之前的旧数据——用户看不出自己在看陈旧内容。
  const changed = (): void => { loadOrFail(); onChanged?.() }

  // 写失败一律 toast（与加载失败同一条反馈通道）；不吞。改名另外要把输入框拉回服务器真相：
  // 它是非受控 defaultValue + key={channel.label}，label 没变 = key 没变 = 用户输的新名字会
  // 留在屏幕上，界面就在断言一个服务器已经拒绝的值。
  const commitRename = async (next: string): Promise<void> => {
    if (renameDoneRef.current || !channel) return
    renameDoneRef.current = true
    const label = next.trim()
    if (!label || label === channel.label) return
    try {
      await patchChannel(channel.id, { label })
      changed()
    } catch (e) {
      toast.error(`重命名失败：${(e as Error).message}`)
      if (renameInputRef.current) renameInputRef.current.value = channel.label
    }
  }

  const doDelete = async (): Promise<void> => {
    if (!channel) return
    setBusy(true)
    try {
      await api.deleteChannel(conn, channel.id)
      setConfirmDelete(false)
      onDeleted?.()
      onChanged?.()
    } catch (e) {
      toast.error(`删除失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  if (!channel || !present) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-[12px] text-muted-foreground">
        {loadError !== null ? (
          <>
            <span>加载失败：{loadError}</span>
            <Button type="button" variant="neutral" size="small" onClick={loadOrFail}>重试</Button>
          </>
        ) : !loaded ? (
          <span>加载中…</span>
        ) : !channel ? (
          <span>这个频道已不存在（可能在别处被删除了）。</span>
        ) : (
          <span>这个频道的 Present「{channel.present}」已不存在，无法管理。</span>
        )}
      </div>
    )
  }

  const Extra = PRESENT_EXTRAS[channel.present]
  const orphans = orphanedStreams(channel, channels)

  return (
    // `@container` 而不是屏幕断点：这张面板住在工作台的一列里，宽度跟视口没关系——按视口断点
    // 排版会在窄面板里排出三列挤扁的卡，而那时视口明明很宽。
    <div className="@container flex flex-col gap-5 px-4 py-4">
      {showHeader ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="min-w-0 truncate">{channel.label}</span>
          <Badge variant="secondary" size="sm">{present.label}</Badge>
          {channel.system ? <Badge variant="secondary" size="sm">系统保留</Badge> : null}
        </div>
      ) : null}

      {/* 名称与所属空间一左一右：两者都是一行输入，各占满宽是一整片留白。 */}
      <div className="grid gap-4 @xl:grid-cols-2">
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold text-muted-foreground">名称</h3>
        <Input
          key={channel.label}
          ref={renameInputRef}
          // 与右边「所属空间」那个 Select 同一档（两者都是 h-9）——并排的两格高度不一样，
          // 看起来像其中一个坏了。改一个就要改另一个。
          size="xl"
          defaultValue={channel.label}
          disabled={channel.system}
          onFocus={() => { renameDoneRef.current = false }}
          onBlur={(e) => void commitRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void commitRename((e.target as HTMLInputElement).value) }
          }}
          aria-label="频道名称"
        />
      </section>

      {/* 所属空间（侧栏分组那一层）。**已有频道只能从这里换组**——侧栏那边只管建/删/改空间
          本身，把频道搬来搬去是频道自己的属性，归这张配置面。一个空间都读不到就整格不画：
          一个只有当前值、换不了的下拉是纯噪音。 */}
      {spaces.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[12px] font-semibold text-muted-foreground">所属空间</h3>
          <Select
            value={spaces.some((s) => s.id === channel.space_id) ? channel.space_id : spaces[0]!.id}
            disabled={busy}
            onValueChange={(next) => {
              setBusy(true)
              patchChannel(channel.id, { space_id: next })
                .then(changed)
                .catch((err: unknown) => { toast.error(`换空间失败：${(err as Error).message}`) })
                .finally(() => { setBusy(false) })
            }}
          >
            <SelectTrigger size="xl" className="w-full" aria-label="所属空间"><SelectValue /></SelectTrigger>
            <SelectContent>
              {spaces.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </section>
      ) : null}
      </div>

      {present.needsStreams ? (
        <section className="flex flex-col gap-2">
          {/* 小标题由列表自己画：加/挂两个入口要跟它同一行（见 ChannelStreamList 的 `title`）。 */}
          <ChannelStreamList
            conn={conn}
            channel={channel}
            present={present}
            title={present.data === 'live' ? '绑定的数据源' : '订阅列表'}
            columns={2}
            onChanged={onChanged}
            onEditStream={onEditStream}
            onPreview={onPreview}
          />
        </section>
      ) : null}

      {present.slots.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[12px] font-semibold text-muted-foreground">能力槽位</h3>
          <ChannelSlotFields channel={channel} slots={present.slots} providers={providers} columns={2} onSaved={changed} />
        </section>
      ) : null}

      {Extra ? <Extra conn={conn} channel={channel} /> : null}

      {/* 导出为分享包**不在这张面上**：它在频道标题菜单里（`ChannelTitleMenu`，「重新抓取」
          下面一项）。那儿是"对这个频道整体做一件事"的入口，而这张面是"改这个频道的某个属性"。
          对应的**导入**在包与插件页（设置 → Stream）——导入那一刻频道还不存在。 */}

      {!channel.system ? (
        <section className="border-t border-border pt-4">
          <Button type="button" variant="destructive" size="medium" onClick={() => setConfirmDelete(true)}>
            删除频道
          </Button>
        </section>
      ) : null}


      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除频道</DialogTitle>
            <DialogDescription>
              将删除「{channel.label}」。Stream 不会被删除，只解除引用
              {orphans.length > 0
                ? <>；以下流将不再被任何频道引用：{orphans.map((s) => s.description || s.id).join('、')}</>
                : null}。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="neutral" size="large" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</Button>
            <Button type="button" variant="destructive" size="large" disabled={busy} onClick={() => void doDelete()}>
              {busy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
