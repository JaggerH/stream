import { useCallback, useEffect, useState } from 'react'
import { Loader2, PackageCheck } from 'lucide-react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../acrylic/sheet.tsx'
import { Button } from '../acrylic/button.tsx'
import { NetdiskAdvice } from './NetdiskAdvice.tsx'
import { NetdiskBindings } from './NetdiskBindings.tsx'
import { ReconcilePanel } from '../ReconcilePanel.tsx'
import { api, ApiError, type Connection } from '../../lib/api.ts'
import { showsForStream } from '../../lib/reconcileShows.ts'
import type { MappingSet, ReconcileShowConfig, Stream } from '../../lib/types.ts'

/**
 * 一条订阅的**网盘全景**——散在几处的网盘入口收进来的那一个面板。
 *
 * 收的是**入口，不是数据**。面板上两块，它们不是并列的两份，而是**同一条传送带的两端**：
 *
 * | 这一块 | 它是传送带的哪一端 |
 * |---|---|
 * | 整理 | **进料口那一端**：这一轮认上的搬去哪个货架 + 一扇通往整理面板的门（`ReconcileShowConfig`，靠 `bindingId` 一对一挂在下面那条绑定上） |
 * | 配对情况 | **出料口**：那条**绑定**上逐集配没配上 |
 *
 * 所以两块摆在一起才读得懂：上面是「东西会搬去哪」，下面看「捡的结果落到了哪一集」。各自照旧
 * 读自己那一份真相源（整理配置 / 绑定），这里不合并、不另算——真并成一张表就是把两层搅成
 * 一锅，之后谁也说不清某个数出自哪一层。
 *
 * **这一整个面板是只读的**（唯一的写是挂载/卸载已经撤走之后剩下的零处）：来源目录是一次性
 * 进料，改它 = 开新的一轮整理，那件事归对话（`reconcile_open`）。别在这儿加配置表单。
 *
 * 深加工仍在原来的界面里（整理的逐卡裁决），这里只给现状 + 一扇门。
 *
 * **把一个网盘目录当节目源订阅**不在这儿——那就是普通的「添加来源」（`alist-audio` 源，
 * 它的 `path` 参数自带目录选择器）。它写的是订阅的**成员表**，和这条传送带没有关系；曾经
 * 在这儿复制过一份成员编辑器，只是因为那个源当时 `discoverable:false`、通用入口挑不到它。
 *
 * **两档：按订阅（播客）/ 按绑定（影视）。** 影视没有「订阅」这个宿主——一部作品是一条 tmdb
 * 绑定，没有 streamId。整理那一块因此换成「整理这个目录」，而「该用整理还是该另找来源」那句
 * 建议不出（它按订阅的节目单算，影视这一档没有那个数）。
 */
export function NetdiskPanel({
  apiBase = '',
  open,
  onOpenChange,
  streamId,
  bindingId,
  streamTitle,
  onChanged,
}: {
  apiBase?: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 订阅显示名（影视这一档是作品名），用于抬头、整理标题与向导预填。 */
  streamTitle?: string
  /** 整理跑完之后回调宿主（频道列表要重新拉条目才能看见被认上的那些集）。 */
  onChanged?: () => void
} & (
  | { streamId: string; bindingId?: never }
  /** 影视：直接对着一条网盘绑定，没有订阅。 */
  | { bindingId: string; streamId?: never }
)) {
  const conn: Connection = { baseUrl: apiBase }
  const byBinding = !!bindingId
  const [stream, setStream] = useState<Stream | null>(null)
  const [shows, setShows] = useState<ReconcileShowConfig[] | null>(null)
  const [bindings, setBindings] = useState<MappingSet[] | null>(null)
  /** netdisk 整体没启用（后端 503）→ 整理那一块无从谈起，只说一句，不端出按钮。 */
  const [reconcileOff, setReconcileOff] = useState(false)
  const [reconcileOpen, setReconcileOpen] = useState(false)

  const load = useCallback(() => {
    // 影视这一档没有订阅也没有 show 配置：只有绑定那一份数据，别去问另外两扇门。
    if (byBinding) return
    api.streams(conn).then((list) => setStream(list.find((s) => s.id === streamId) ?? null)).catch(() => {})
    api.reconcile.config(conn)
      .then((r) => { setShows(r.shows); setReconcileOff(false) })
      .catch((e: unknown) => { if (e instanceof ApiError && e.status === 503) setReconcileOff(true) })
    api.netdisk.list(conn).then(setBindings).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase, streamId, byBinding])

  useEffect(() => { if (open) load() }, [open, load])

  const myShows = !byBinding && shows && bindings && streamId ? showsForStream(shows, bindings, streamId) : null

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full gap-0 sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle>网盘</SheetTitle>
            <SheetDescription>{streamTitle || stream?.description || streamId}</SheetDescription>
          </SheetHeader>

          {/* 功能区在上、列表在下。整理那块配置不过十几行，而配对清单动辄几百条——摆在
              清单后面就等于没有：要改配置得先滚过整张表。这里钉住不滚，下面那块自己滚。 */}
          <div className="shrink-0 space-y-3 border-b border-border px-4 pb-4">
            {streamId && <NetdiskAdvice streamId={streamId} apiBase={apiBase} />}

            <div className="grid gap-4">
              <section data-testid="netdisk-block-reconcile">
                <SectionTitle>{byBinding ? '整理这个目录' : '整理'}</SectionTitle>
                {byBinding ? (
                  <div className="space-y-2">
                    <p className="text-[12px] text-muted-foreground">
                      同一集攒了几份时留质量最高的那份，剩下的进「将删清单」等你确认。判不出来的会
                      变成待你决定的卡，可以让 AI 听一段再判。
                    </p>
                    <Button size="small" variant="neutral" onClick={() => setReconcileOpen(true)}>
                      <PackageCheck /> 打开整理
                    </Button>
                  </div>
                ) : reconcileOff ? (
                  <p className="text-[12px] text-muted-foreground">整理服务没接线。</p>
                ) : myShows === null ? (
                  <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> 正在读整理配置…
                  </p>
                ) : (
                  <div className="space-y-2">
                    {myShows.length === 0 ? (
                      <p className="text-[12px] text-muted-foreground">
                        还没配。整理是把网盘文件认到节目单上的某一集——源站还列着但放不出来的那些集靠它补。
                      </p>
                    ) : (
                      myShows.map((s) => (
                        <div key={s.id} className="text-[12px]" data-testid={`reconcile-show-${s.id}`}>
                          <div className="font-medium">{s.label}</div>
                          {/* 来源目录**不在这里列**：它是一次性进料，不是这条订阅的长期设置
                              （spec 2026-08-25-reconcile-as-conversation §1）。摆在面板上会让人
                              以为那是一项要维护的配置。货架不一样——它是绑定派生的，长期有效。 */}
                          {s.shelves && (
                            <div className="text-muted-foreground">
                              认上的搬去 {s.shelves.claimed}
                              {s.shelves.secondary ? `，下架的搬去 ${s.shelves.secondary}` : ''}
                            </div>
                          )}
                          {s.shelvesProblem && <div className="text-destructive">{s.shelvesProblem}</div>}
                        </div>
                      ))
                    )}
                    {/* 还没配过的那一档不再进"配置"表单——那个表单已经撤了，配整理归对话。
                        点进去的是同一个只读面板，里面唯一的动作就是「让 AI 整理」。 */}
                    <Button size="small" variant="neutral" onClick={() => setReconcileOpen(true)}>
                      <PackageCheck /> {myShows.length === 0 ? '整理' : '打开整理'}
                    </Button>
                  </div>
                )}
              </section>
            </div>
          </div>

          {/* 列表：这条订阅逐集配没配上。唯一会长的那一块，所以让它吃掉剩下的高度、自己滚。 */}
          <section data-testid="netdisk-block-matching" className="flex min-h-0 flex-1 flex-col">
            <div className="px-4 pt-3">
              <SectionTitle>配对情况</SectionTitle>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 scrollbar-mac">
              {/* 影视锁定到这一条绑定（`focusSetId`）——tmdb 绑定没有 streamId，按订阅那条路
                  根本够不着它。 */}
              {byBinding
                ? <NetdiskBindings focusSetId={bindingId} apiBase={apiBase} />
                : <NetdiskBindings streamId={streamId} apiBase={apiBase} />}
            </div>
          </section>
        </SheetContent>
      </Sheet>

      {/* 整理是 Sheet 的**兄弟**，不是它的孩子：Radix 的弹层各管各的关闭，套在 SheetContent
          里会跟着 Sheet 一起被收掉。 */}
      <ReconcilePanel
        apiBase={apiBase}
        open={reconcileOpen}
        onOpenChange={(o) => { setReconcileOpen(o); if (!o) { load(); onChanged?.() } }}
        {...(byBinding ? { bindingId } : { streamId })}
        streamTitle={streamTitle}
      />
    </>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-1.5 text-[13px] font-medium">{children}</h3>
}
