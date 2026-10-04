/**
 * 任务页：三条需求——「我有哪些任务」「下次什么时候跑」「每条历次执行的效果」。
 *
 * **为什么是表格不是卡片。** 这一页的任务同构（每条都是同样五个字段），而三条需求里有两条是
 * **横向比较**：谁下次先跑、谁上次红了。列对齐天生答得比卡片快。更硬的一条理由在材质上：
 * acrylic 的 `Card` 按设计**没有描边**（`acrylic/card.tsx` 头注），而 light 档
 * `--background` 与 `--acr-surface` 都是 `#ffffff`（`entry.css`）——纯文字卡贴在白底上没有
 * 任何边界，整页看不见行的分界。其余几档看得见，只是因为卡里有封面图撑出轮廓。`Table` 是
 * **透明控件**，靠 `--acr-border-soft` 发丝线分行、靠 `--acr-hover` 出行高亮，两个主题都成立。
 * 所以这不是审美偏好，是"卡片这个材质答不了这一页"。
 *
 * 顶栏与时间线/音乐/影视/研究**同一格**（标题行 32px + 上留白 12px、没有图标，
 * 见 `StreamPanel.tsx` 里那条 `panel-timeline-header` 的注释）：五档 Present 在同一个壳里换来
 * 换去，顶栏差一个像素都会看见跳。**下边线得自己带**——其余几档的那条线是底下那排分页
 * （`ChannelTabs`）画的，这一页没有分页，不自己带就是一个飘在内容上、没有边界的标题
 * （判据与 `MovieChannel.tsx` 单频道那档同一条）。标题本身是菜单触发器（`ChannelTitleMenu`），
 * 菜单项是「重新读取」——这一页的数据现读不入库，没有"抓取"这回事。
 *
 * **两段表，不是一张。** 「我的任务」（`source==='user'`，库里的行）和「内置运维任务」
 * （写在代码里的行）是**两种不同的东西**：前者能暂停、能改排期、里面有真花钱的那几条，
 * 后者只能看和手动跑一次。混在一张表里，这个区别只能靠"这一行有没有那两颗按钮"去反推，
 * 而"按钮不在"和"我还没注意到"长得一模一样。分段之后标题直接把话说了，逐行那枚「内置」
 * 标签也就多余了——撤掉它还能把宽度还给任务名（窄窗格下名字本来就不够放）。
 * 一段没有行就**整段不画**，标题也不画：空标题说的是"这里本该有东西"，而真相是"没有"。
 *
 * 列的次序就是那三个问题的次序：**这是什么**（状态点 + 名字 + 标签）、**什么时候跑**
 * （人话 → 下次）、**上次怎么样**、**能做什么**。
 *
 * **什么留在行上、什么降到展开层**，判据是"不看它会不会做错决定"：
 * - cron 原文降到展开层——它是给人复制、和后端对账用的，不是扫一眼要读的。**但人话翻不出来
 *   时它升回行上**：那一刻它是唯一的真相，藏起来等于这一行什么都没说。两处**永远只画一处**，
 *   不然同一个 testid 会同时出现两个。
 * - 「此后两次」降到展开层：扫一眼只需要最近那一次。
 * - **撞名（`shadowed`）和写失败留在行上**：它们是"这一行现在有问题"，藏在一次点击后面，
 *   行主永远不会知道。
 */
import { Fragment, useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { ChevronDownIcon, ChevronRightIcon, PauseIcon, PlayIcon, PencilLineIcon, PlusIcon } from 'lucide-react'
import { Button } from '../acrylic/button.tsx'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../acrylic/table.tsx'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../acrylic/dialog.tsx'
import { ChannelTitleMenu } from '../ChannelTitleMenu.tsx'
import { ChannelTabs, type ChannelTab } from '../manage/ChannelTabs.tsx'
import { NextRuns, fmtRelative, scheduleSentence } from './SchedulePreview.tsx'
import type { Connection } from '../../lib/api.ts'
import { TaskEditor } from './TaskEditor.tsx'
import { fetchTasks, fetchRuns, runTaskNow, saveTask, type TaskListItem, type TaskRunView } from '../../lib/api.tasks.ts'

/** 详情行要横跨整张表。列数改了这里也得改——写死一个数字比 `colSpan={999}` 诚实。 */
const COLUMNS = 4

/**
 * 任务名左边那一截的宽度：展开箭头 20px + 间距 6 + 状态点 6 + 间距 6 = 38px。
 *
 * **三个地方必须用同一个数**：名字所在那一行（由这几个元素自然堆出来）、它下面那排标签、
 * 以及展开层的内容。展开层不缩进的话，一屏里它和别的行的**名字**左对齐不上，读的人得回头
 * 数一遍才知道这段详情是哪一条的；缩进到和名字同一条竖线上，归属一眼就成立。
 */
const NAME_INDENT = 'pl-[38px]'

/**
 * 摘要开头那颗状态 emoji 不画（`🟢 LIVE 申购 3 笔` → `LIVE 申购 3 笔`）。
 *
 * 摘要是**外部命令自己打印的**（东财那两条来自另一个仓库的 python），它按自己在终端里的
 * 习惯给了个绿点。而这一行左边已经有一颗状态点了——同一件事画两遍，其中一颗还是别人家的
 * 字体渲染出来的 emoji，跟这一页其余部分对不上。
 *
 * **只削开头的装饰，不动内容**：`\p{Extended_Pictographic}` + 变体选择符 + 紧跟的空白，
 * 出现在句中的一律留着（那多半是真话的一部分）。摘要被削成空串时按"没报摘要"处理，
 * 而不是显示一个空格。
 */
export function stripLeadingEmoji(s: string): string {
  return s.replace(/^(?:[\p{Extended_Pictographic}️‍]+\s*)+/u, '')
}

/**
 * 这一次执行在行上显示成一句什么。`title` 上仍挂原文（含 emoji）——削的是显示，不是证据。
 *
 * 按状态分三档，**失败的 run 不看 summary**：失败的基本没有 summary，照 summary 画出来就是
 * 一句「没报摘要」——把"为什么失败"整个藏掉，读的人以为是任务忘了汇报（活体 2026-09-06，
 * 一条被后端重启打断的预热任务就这样被当成"任务报错"）。
 * - 失败：后端给的 `failure`（errors 里第一句，引擎的英文已翻译）；连这个都没有才说"没有说明"。
 * - 完成：summary；没有 summary 说清是"跑完了但这条任务不写摘要"——不是没跑、也不是坏了。
 * - 其余（排队 / 在跑）：说它在跑。
 */
export function runText(run: Pick<TaskRunView, 'state' | 'summary' | 'failure'>): string {
  if (run.state === 'failed') {
    const f = run.failure ?? null
    if (f !== null && f.trim() !== '') return stripLeadingEmoji(f).trim()
    const s = run.summary === null ? '' : stripLeadingEmoji(run.summary).trim()
    return s === '' ? '失败，没有说明' : s
  }
  const s = run.summary === null ? '' : stripLeadingEmoji(run.summary).trim()
  if (s !== '') return s
  if (run.state === 'completed') return '跑完了（这条任务不写摘要）'
  if (run.state === 'canceled') return '被取消'
  return '还在跑…'
}

/**
 * 把一段任务按 `group` 收成若干节。**只管顺序和归属，不管画法。**
 *
 * 三条要求，每条都有它的反例：
 * - **组的顺序按组名排**，不吃 `tasks` 的到达顺序、更不吃对象键的枚举顺序——后者是"这次凑巧
 *   这样"，加一条任务就可能整页重排，读的人会以为自己看错了。
 * - **组内顺序原样保留**：进来时已经是稳定的（用户行按 id、内置行按定义顺序），这里再排一次
 *   只会把那份稳定换成另一份。
 * - **没有 group 的落在最后一节，且那一节没有名字**（`group: null`，由画的人决定写什么）。
 *   不在这里替它们编一个组名：编出来的名字看着和真组名一样，而它表示的是"没填"。
 */
export function groupTasks(
  tasks: TaskListItem[],
): Array<{ group: string | null; tasks: TaskListItem[] }> {
  const named = new Map<string, TaskListItem[]>()
  const loose: TaskListItem[] = []
  for (const t of tasks) {
    const g = t.group === undefined || t.group.trim() === '' ? null : t.group
    if (g === null) { loose.push(t); continue }
    const bucket = named.get(g)
    if (bucket) bucket.push(t)
    else named.set(g, [t])
  }
  const sections: Array<{ group: string | null; tasks: TaskListItem[] }> = [...named.keys()]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
    .map((group) => ({ group, tasks: named.get(group)! }))
  if (loose.length > 0) sections.push({ group: null, tasks: loose })
  return sections
}

function fmtTime(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toLocaleString()
}

function fmtDuration(ms: number | null): string {
  if (ms === null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function RunRow({ run }: { run: TaskRunView }): ReactElement {
  const [open, setOpen] = useState(false)
  const bad = run.state === 'failed'
  return (
    <div className="border-t border-[var(--acr-border-soft)] py-1 text-[12px]">
      <button type="button" className="flex w-full gap-3 text-left" onClick={() => setOpen((v) => !v)}>
        <span className="w-40 shrink-0 text-muted-foreground">{fmtTime(run.attemptedAt ?? run.insertedAt)}</span>
        <span className={`w-16 shrink-0 ${bad ? 'text-destructive' : 'text-muted-foreground'}`}>{run.state}</span>
        <span className="w-16 shrink-0 text-muted-foreground">{fmtDuration(run.durationMs)}</span>
        <span className="flex-1 truncate">{runText(run)}</span>
      </button>
      {open && (run.detail !== undefined || run.errors !== undefined) && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-[var(--acr-card-nested)] p-2 text-[11px]">
          {JSON.stringify({ detail: run.detail, errors: run.errors }, null, 2)}
        </pre>
      )}
    </div>
  )
}

/**
 * 状态：**四档要人看，第五档「正常」一个像素都不画。**
 *
 * 一页任务里绝大多数时候一切正常。给常态也画一颗灰点、写两个「正常」，等于让整页都在说
 * 一句没有信息量的话，而**真出事的那一条就淹在里面**——一列全是点的时候，多一颗红点不显眼。
 * 所以 `quiet` 那一档：点用 `invisible`（**占位保留**，不然有点的行和没点的行名字左边界会
 * 差 12px，一列名字像被踢乱了），文字降 `sr-only`（读屏和测试照拿）。
 *
 * 剩下四档都是"要人管"或"正在发生"：不会执行（红）、已停用（灰，它确实不跑）、在跑（蓝，
 * 会呼吸）、上次失败（红）。
 */
function statusOf(task: TaskListItem): { label: string; dot: string; tone: string; quiet: boolean } {
  if (task.shadowed) return { label: '不会执行', dot: 'bg-destructive', tone: 'text-destructive', quiet: false }
  if (!task.enabled) return { label: '已停用', dot: 'bg-muted-foreground/50', tone: 'text-muted-foreground', quiet: false }
  const state = task.lastRun?.state
  if (state === 'running' || state === 'claimed' || state === 'waiting') {
    return { label: '在跑', dot: 'bg-primary animate-pulse', tone: 'text-primary', quiet: false }
  }
  if (state === 'failed') return { label: '上次失败', dot: 'bg-destructive', tone: 'text-destructive', quiet: false }
  return { label: '正常', dot: 'bg-muted-foreground/40', tone: 'text-muted-foreground', quiet: true }
}

/**
 * 编辑一条任务 = 一个模态弹窗。
 *
 * **为什么不摊在行里**：整份编辑器有六组字段、还嵌着排期编辑器和账号那份表单——摊进展开层
 * 会把它下面的历史顶到屏幕外，一张表也就不成表了。改一条任务是**一次有始有终的动作**
 * （改完保存或放弃），模态正是这个形状：进来时其余部分静音，出去时回到原位。
 *
 * `key` 换人就重挂，草稿跟着换：不换的话关掉再点下一条，表单里还是上一条的内容，
 * 而保存会把上一条的命令写进下一条。**只在开着时挂**——编辑器一挂载就去拉可选的凭据格
 * （`/api/packages`），关着的时候没有理由发这个请求。
 */
function TaskEditorDialog({
  open, onOpenChange, apiBase, conn, task, existingIds, actions, groups, exclusiveGroups, onSaved, onDeleted,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  apiBase: string
  conn: Connection
  /** null = 新建 */
  task: TaskListItem | null
  existingIds: string[]
  actions: string[]
  /** 现有任务用过的分组名，给编辑器那个可输入下拉当候选。 */
  groups: string[]
  /** 现有任务用过的互斥组名，同样是候选而不是白名单。 */
  exclusiveGroups: string[]
  onSaved: (saved: TaskListItem) => void
  onDeleted: (id: string) => void
}): ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 比默认的 max-w-lg 宽一档：两列网格 + args/env 两条列表在 32rem 里会挤成一列。
          高度给上限并让内容自己滚——一条 env 多的任务能长过整屏。 */}
      <DialogContent className="max-w-[46rem] max-h-[86vh] overflow-y-auto scrollbar-mac">
        <DialogHeader>
          <DialogTitle>{task === null ? '新建任务' : `编辑：${task.label}`}</DialogTitle>
          <DialogDescription className="text-[11px]">
            {task === null
              ? '建出来默认是停用的——先手动跑一次看结果，再自己打开。'
              : '改完保存整行；账号那一格是独立保存的。'}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <TaskEditor
            key={task?.id ?? 'new'}
            apiBase={apiBase}
            conn={conn}
            task={task}
            existingIds={existingIds}
            actions={actions}
            groups={groups}
            exclusiveGroups={exclusiveGroups}
            onSaved={(saved) => { onOpenChange(false); onSaved(saved) }}
            onDeleted={(id) => { onOpenChange(false); onDeleted(id) }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 一条任务 = 主行 + （展开时）一条跨列的详情行。返回 Fragment，由 `TableBody` 直接收下。 */
function TaskRows({
  apiBase, conn, task, actions, groups, exclusiveGroups, onChanged, onRemoved,
}: {
  apiBase: string
  conn: Connection
  task: TaskListItem
  /** 包提供的动作名单，给编辑弹窗里「跑什么」那个下拉。 */
  actions: string[]
  /** 现有分组名，给编辑弹窗里「分组」那个可输入下拉。 */
  groups: string[]
  /** 现有互斥组名，给编辑弹窗里「互斥组」那个可输入下拉。 */
  exclusiveGroups: string[]
  onChanged: (next: TaskListItem) => void
  /** 这一行被删了。整页重拉，不做本地摘除——删完排期那边也重排过，重拉是唯一说得准的。 */
  onRemoved: (id: string) => void
}): ReactElement {
  const [runs, setRuns] = useState<TaskRunView[] | null>(null)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 「立即跑一次」一律两步：第一次点变成「确认」，再点才真跑。
  //
  // **不按任务分档。** 这道闸曾经只对标着 `effect: 'external'` 的行生效，而那个字段是行主
  // 自己填的一个枚举——没有任何后端校验或消费，填错不报错，闸就静悄悄地不在了。把闸挂在
  // 一个自述字段上，等于把"这次点击撤不撤得回"交给填表时的记性。
  //
  // 一律两步的代价是给只读任务多一次点击（可忽略），换来的是这道闸不再有缺口：A 股逆回购
  // 任务误点一下就是撤掉全部挂单 + 全仓买入逆回购，且当天撤不回来。
  const [armed, setArmed] = useState(false)

  // 和上层 TasksPage 同一套「组件已卸载就别再 setState」的防护，这里用 ref 而非局部变量，
  // 因为要在事件处理器（不是 effect）里跨渲染读到最新的存活状态。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // 待确认状态会自己过期。留着不撤的话，几分钟后回到页面上那颗按钮又变成"一点就跑"——
  // 确认闸就白设了，而且是以为设了的那种白设。
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  const loadRuns = useCallback(async () => {
    if (runs !== null) return
    try {
      const fetched = await fetchRuns(apiBase, task.id)
      if (aliveRef.current) setRuns(fetched)
    }
    catch (e) { if (aliveRef.current) setErr((e as Error).message) }
  }, [apiBase, runs, task.id])

  const write = useCallback(async (patch: { schedule?: string; enabled?: boolean }) => {
    setBusy(true)
    setErr(null)
    try {
      const next = await saveTask(apiBase, task, patch)
      if (!aliveRef.current) return
      onChanged(next)
      setEditing(false)
    }
    catch (e) { if (aliveRef.current) setErr((e as Error).message) }
    finally { if (aliveRef.current) setBusy(false) }
  }, [apiBase, onChanged, task])

  const status = statusOf(task)
  // 行上那一格不带时区（后缀会把主句挤没，见下面那格的注释）；`title` 和展开层带。
  const sentence = scheduleSentence(task.schedule)
  const sentenceWithZone = scheduleSentence(task.schedule, task.timezone)
  const editable = task.source === 'user' && !task.shadowed
  const last = task.lastRun
  // 展开层在编辑排期时也得开着：点「改排期」时行还是收着的，编辑器没地方落脚。
  // 编辑弹窗和展开层是**两件事**：弹窗改这条任务，展开层看它的历史。开弹窗不再顺手展开行
  // ——那会在弹窗背后偷偷改变页面，关掉之后人看到的不是他离开时那一屏。
  const expanded = open
  const toggleExpanded = (): void => {
    const next = !expanded
    setOpen(next)
    if (next) void loadRuns()
    else setEditing(false)
  }

  return (
    <>
      <TableRow
        data-testid={`task-row-${task.source}-${task.id}`}
        // 展开时主行与详情行是**一个整体**，中间不该有分隔线。`!` 是必需的：分隔线那条规则
        // 写在 `TableBody` 上（`[&_tr:not(:last-child)>td]:border-b`），权重高过写在本行上的
        // 任何普通工具类，不加 `!` 这一行会静默没效果。
        className={`cursor-pointer ${expanded ? '[&>td]:border-b-transparent!' : ''}`}
        // 整行都是展开的触发区，不只那颗箭头：行上的文字和空白点了也展开。
        // 落在控件上的点击（按钮 / 链接 / 输入框）归控件自己——箭头按钮也在其中，
        // 否则它自己切一次、行再切一次，等于没点。
        onClick={(e) => {
          if ((e.target as HTMLElement).closest('button, a, input, select, textarea, [role=button]')) return
          toggleExpanded()
        }}
      >
        <TableCell>
          {/* 第一行只有身份：展开箭头 + 状态点 + 名字（+ 要人管时那两个字）。
              标签挪到第二行——名字是这一列唯一不该被挤的东西，而"这条任务写到哪儿"晚半行看到
              不影响任何判断。实测：标签同行时最长的名字只拿得到 131px（需要 190px）。 */}
          <div className="flex min-w-0 items-center gap-1.5">
            <Button
              icon size="small" variant="ghost" className="shrink-0"
              data-testid={`task-expand-${task.id}`}
              aria-label={expanded ? '收起执行记录' : '展开执行记录'}
              onClick={toggleExpanded}
            >
              {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            </Button>
            {/* `invisible` 而不是不渲染：占位得留着，否则有点/没点的行名字左边界差 12px。 */}
            <span
              className={`size-1.5 shrink-0 rounded-full ${status.dot} ${status.quiet ? 'invisible' : ''}`}
              aria-hidden title={status.label}
            />
            <span className="truncate text-[13px] font-semibold [letter-spacing:var(--text-title3-tracking)]" title={task.label}>{task.label}</span>
            <span
              data-testid={`task-status-${task.source}-${task.id}`}
              className={status.quiet ? 'sr-only' : `shrink-0 text-[12px] ${status.tone}`}
            >{status.label}</span>
            {/* 互斥组是**行内一枚小标记**，不是新开一列：绝大多数任务没有它，为它让出一整列
                会让每一行都为少数几行付宽度。有标记的行才画，没有的行一个像素都不占。
                `skip` 那一档标出来（轮不上会整班不跑，那是"这条任务可能什么都没干"的原因，
                查起来第一个要问的就是它）。 */}
            {task.exclusiveOn !== undefined && task.exclusiveOn !== '' && (
              <span
                data-testid={`task-exclusive-${task.source}-${task.id}`}
                className="max-w-[9rem] shrink-0 truncate rounded border border-[var(--acr-border-soft)] px-1 font-mono text-[11px] text-muted-foreground"
                title={`互斥组「${task.exclusiveOn}」：同组的任务同时只跑一条${
                  task.whenBusy === 'skip' ? '；轮不上时这一班不跑' : '；轮不上就排着'}`}
              >
                {task.exclusiveOn}{task.whenBusy === 'skip' ? ' · 不排队' : ''}
              </span>
            )}
          </div>
        </TableCell>

        {/* 排期：常态只给人话，cron 原文降到展开层。翻不出人话时**原文升回来**——
            那一刻它是唯一的真相，藏起来这一格就什么都没说了。
            **时区后缀不进这一格**：「（Asia/Shanghai）」把这一格从 107px 撑到 242px，而列宽
            只有 140px——一个后缀把主句挤没了。时区在展开层，`下次` 那一格也带着它。 */}
        <TableCell className="truncate text-[13px]" title={sentenceWithZone ?? task.schedule}>
          {sentence ?? (
            <span className="flex min-w-0 items-baseline gap-1.5">
              <span className="shrink-0 text-[11px] text-muted-foreground">翻不成人话</span>
              <code data-testid={`task-cron-${task.id}`} className="truncate font-mono text-[11px]">{task.schedule}</code>
            </span>
          )}
        </TableCell>

        {/* 「上次」和「下次」合成一格、上下两行。
            **为什么合**：这一页最长也最会变的一格是上次摘要（实测最长要 1613px），而五列各占
            一份宽时它只分到 62px——四个字，等于没显示。两列合成一格之后，摘要拿到的是整格宽度
            （约 220px，12 条里 9 条能完整显示），而「下次」那一行本来就是定长的，两者不再抢。
            **为什么不并成一行**：并成一行还是同一场抢夺，只是换了个位置。
            行内前缀「上次 / 下次」留着：两行都以时间开头，没有前缀得靠格式去猜哪行是哪行。
            「这一行现在有问题」（撞名 / 写失败）也落在这里，**绝不能藏进展开层**——行主不会去点。 */}
        <TableCell>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="w-6 shrink-0 text-[11px] text-muted-foreground">上次</span>
            {task.shadowed ? (
              // 这一条要人动手，所以允许它折行占满格子——被截断的排错指令等于没写。
              <span className="min-w-0 whitespace-normal text-[12px] leading-snug text-destructive">
                与内置任务 {task.id} 重名，调度中心已丢弃这一行——它不会执行。删掉它：DELETE /api/tasks/{task.id}
              </span>
            ) : last ? (
              <>
                <span className="shrink-0 text-[12px] text-muted-foreground">{fmtRelative(last.attemptedAt ?? last.insertedAt, Date.now())}</span>
                <span
                  className={`min-w-0 flex-1 truncate text-[13px] ${last.state === 'failed' ? 'text-destructive' : ''}`}
                  title={(last.state === 'failed' ? last.failure : last.summary) ?? undefined}
                >
                  {runText(last)}
                </span>
              </>
            ) : (
              <span className="text-[13px] text-muted-foreground">还没跑过</span>
            )}
          </div>
          <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
            <span className="w-6 shrink-0 text-[11px] text-muted-foreground">下次</span>
            {task.enabled
              // 行上只要最近那一次；「此后两次」在展开层。`bare`：前缀已经在左边写着。
              ? <NextRuns bare schedule={task.schedule} timezone={task.timezone} count={1} testId={`task-next-${task.id}`} />
              : <span className="text-[12px] text-muted-foreground">节拍器上没有它，已停用</span>}
          </div>
          {err && <div data-testid={`task-error-${task.id}`} className="mt-0.5 whitespace-normal text-[12px] leading-snug text-destructive">{err}</div>}
        </TableCell>

        {/* 动作全是次要控件（ghost）——这一页的主角是「排期对不对」，不是按钮。
            暂停/改排期收成图标（带 aria-label + title），「立即跑一次」保持文字：
            它有 armed →「确认执行？」的文字态，那道闸必须看得见自己变了。 */}
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {editable && (
              <>
                <Button
                  type="button" icon size="small" variant="ghost" disabled={busy}
                  data-testid={`task-toggle-${task.id}`}
                  aria-label={task.enabled ? '暂停' : '恢复'} title={task.enabled ? '暂停' : '恢复'}
                  onClick={() => { void write({ enabled: !task.enabled }) }}
                >
                  {task.enabled ? <PauseIcon /> : <PlayIcon />}
                </Button>
                <Button
                  type="button" icon size="small" variant="ghost"
                  data-testid={`task-edit-${task.id}`}
                  aria-label="编辑" title="编辑"
                  onClick={() => { setEditing(true) }}
                >
                  <PencilLineIcon />
                </Button>
              </>
            )}
            <Button
              type="button" size="small" variant={armed ? 'destructive' : 'neutral'}
              data-testid={`task-run-${task.id}`}
              onClick={() => {
                if (!armed) { setArmed(true); return }
                setArmed(false)
                void runTaskNow(apiBase, task.id).catch((e: Error) => { if (aliveRef.current) setErr(e.message) })
              }}
            >
              {armed ? '确认执行？' : '立即跑一次'}
            </Button>
          </div>
        </TableCell>
      </TableRow>

      {expanded && (
        // 详情行不是一条"可选中的行"：`!` 压掉 TableBody 的 hover 药丸（那条规则的权重
        // 同样高过普通工具类），否则鼠标扫过整片详情会把它点亮成一行。
        <TableRow className="[&>td]:bg-[var(--acr-card-nested)]! [&>td]:hover:bg-[var(--acr-card-nested)]!">
          <TableCell colSpan={COLUMNS} className="whitespace-normal px-3 py-3" data-nested-surface="true">
            {/* 缩进到和任务名同一条竖线上——归属靠对齐说清，不靠读的人回头数行（见 NAME_INDENT）。 */}
            <div className={`flex flex-col gap-2 ${NAME_INDENT}`}>
              {/* 人话翻得出来时，原文在这里；翻不出来时它已经在行上了，不重复画。 */}
              {sentence !== null && (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[12px] text-muted-foreground">排期表达式</span>
                  <code data-testid={`task-cron-${task.id}`} className="select-all font-mono text-[12px]">{task.schedule}</code>
                  {task.timezone && <span className="text-[12px] text-muted-foreground">{task.timezone}</span>}
                </div>
              )}
              {task.enabled && <NextRuns schedule={task.schedule} timezone={task.timezone} count={3} />}

              {/* 历史最多 50 条，一条跑得勤的任务（如「登录态刷新」）展开就能把下面十几行全顶出屏幕——
                  在卡片里只是长，在表格里是"整张表没了"。给它自己的滚动条，展开层的高度就
                  和有多少条历史无关了。 */}
              <div className="max-h-64 overflow-y-auto scrollbar-mac">
                {runs === null ? <div className="text-[12px] text-muted-foreground">读取中…</div>
                  : runs.length === 0 ? <div className="text-[12px] text-muted-foreground">还没有执行记录</div>
                    : runs.map((r) => <RunRow key={r.id} run={r} />)}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}

      <TaskEditorDialog
        open={editing && editable}
        onOpenChange={setEditing}
        apiBase={apiBase}
        conn={conn}
        task={task}
        // 改一条已有任务不需要重名清单：id 那一格本来就是锁死的（`disabled`）。
        existingIds={[]}
        actions={actions}
        groups={groups}
        exclusiveGroups={exclusiveGroups}
        onSaved={onChanged}
        onDeleted={onRemoved}
      />
    </>
  )
}

/**
 * 一段带标题的表。**空了就整段不画**（标题也不画）——一个「我的任务」标题下面空着，
 * 说的是"这里本该有东西"，而实际情况是"这台机器上就没有自定义任务"，两件事完全不同。
 *
 * 两段的列宽刻意**逐字相同**：它们上下堆在一起，列一旦对不齐就不像"一张表分了两段"，
 * 而像两张凑巧挨着的表。所以列头写在这里一份，两段共用。内置那段的「操作」其实只有一颗
 * 按钮（内置任务不能暂停、不能改排期），150px 有富余——但**宁可留白也不缩**，缩了就错位。
 */
function TaskSection({
  id, heading, hint, tasks, apiBase, conn, actions, groups, exclusiveGroups, onChanged, onRemoved,
}: {
  id: string
  heading: string
  hint: string
  tasks: TaskListItem[]
  apiBase: string
  conn: Connection
  actions: string[]
  groups: string[]
  exclusiveGroups: string[]
  onChanged: (next: TaskListItem) => void
  onRemoved: (id: string) => void
}): ReactElement | null {
  if (tasks.length === 0) return null
  const sections = groupTasks(tasks)
  // **一个组都没有时，一条组标题都不画。** 这时唯一的那一节是「未分组」，给它加个标题等于
  // 在段标题下面再写一行"以下是全部"——没有信息量，而且把这一页从"两段表"变成"到处是标题"。
  // 判据是"有没有出现过真的分组"，不是"节数 > 1"：两者在这里等价，但前者说的才是理由。
  const showGroupHeadings = sections.some((s) => s.group !== null)
  return (
    <section data-testid={`tasks-section-${id}`} className="flex flex-col">
      <div className="flex flex-wrap items-baseline gap-x-2 px-3 pb-1 pt-3">
        <h2 className="text-[13px] font-semibold [letter-spacing:var(--text-title3-tracking)]">{heading}</h2>
        <span className="text-[12px] text-muted-foreground">{hint}</span>
      </div>
      {/* scrollable={false}：Table 自带的 overflow-x-auto 包裹层会抢走 sticky 表头要贴的
          滚动容器（外面那层 overflow-y-auto）。table-fixed：列宽由表头一次定死，
          某一行的长摘要才拽不动整张表。 */}
      <Table scrollable={false} className="table-fixed">
        <TableHeader sticky>
          <TableRow>
            {/* 宽度是对着活体量出来的，不是估的。**约束先说清**：对话工作台里这块面板常态
                只有约 890px。五列的时候怎么分都不够——最长的任务名要 190px、最长的摘要要
                1613px，两个一起要不来。四列是**合并**换来的：上次和下次共用一格、上下两行，
                定长的那一行（下次）和会变长的那一行（上次摘要）从此不再抢同一份宽度。
                「排期」「操作」给固定 px 而不是百分比：它们装的是长度几乎不变的东西
                （一句人话、几个按钮），跟着窗口一起放大只是白占地方。
                「上次 / 下次」不给宽度，让它吃剩下的——摘要最长也最会变，弹性留给它。 */}
            <TableHead className="w-[30%]">任务</TableHead>
            <TableHead className="w-[140px]">排期</TableHead>
            <TableHead>上次 / 下次</TableHead>
            <TableHead className="w-[150px] text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {/* 分组标题是**表内的一行**，不是把表拆成好几张：这一页刻意让所有行共用一套列宽
              （见上面那段注释），拆表就等于每个分组各画一张列宽自己算的表，上下对不齐。
              标题行不吃点击、不吃 hover 药丸——它不是一条能选中的任务。 */}
          {sections.map((s) => (
            <Fragment key={s.group ?? ' ungrouped'}>
              {showGroupHeadings && (
                <TableRow
                  data-testid={`tasks-group-${id}-${s.group ?? 'ungrouped'}`}
                  className="[&>td]:bg-[var(--acr-card-nested)]! [&>td]:hover:bg-[var(--acr-card-nested)]!"
                >
                  <TableCell colSpan={COLUMNS} className="py-1">
                    <span className="text-[12px] font-semibold text-muted-foreground [letter-spacing:var(--text-title3-tracking)]">
                      {/* 没分组的那一节直说"未分组"——它是一句实话，而不是一个组名。 */}
                      {s.group ?? '未分组'}
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {/* key 带上 source：撞名时同一个 id 会出现两行（内置一条、用户存量一条），
                  光用 id 会撞 React 的重复 key，两行的展开状态还会串在一起。分成两段之后
                  那两行落在**不同的段**里，但 key 的理由没变——段内仍按 (source, id) 认人。 */}
              {s.tasks.map((t) => (
                <TaskRows
                  key={`${t.source}:${t.id}`}
                  apiBase={apiBase} conn={conn} task={t} actions={actions} groups={groups}
                  exclusiveGroups={exclusiveGroups}
                  onChanged={onChanged} onRemoved={onRemoved}
                />
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </section>
  )
}

/**
 * 「配置」分页：**新建一条任务**，只有这一件事。
 *
 * 改和删不在这儿——在「内容」里那条任务自己的展开层（`TaskRows` 的编辑档）。分家的判据是
 * "改哪一条"这个上下文：在这一页挑一条来改，人得先在脑子里记住刚才在列表里看的是哪一条、
 * 再到这儿把它认出来；而在那条自己的行上点编辑，上下文本来就在手上。**参数同理**——
 * 参数是这条任务的一部分，不该有第二个地方。
 *
 * 内置任务两处都没有：它们的排期写在代码里，改它要走 review（写路由对内置 id 一律 403）。
 */
function TasksConfigPanel({
  apiBase, conn, tasks, actions, groups, exclusiveGroups, onChanged,
}: {
  apiBase: string
  conn: Connection
  /** 只该传 `source==='user'` 那一段——新建时用它当场拦下重名 */
  tasks: TaskListItem[]
  /** 包提供的动作名单，给「跑什么」那个下拉。 */
  actions: string[]
  /** 现有分组名，给「分组」那个可输入下拉。 */
  groups: string[]
  /** 现有互斥组名，给「互斥组」那个可输入下拉。 */
  exclusiveGroups: string[]
  /** 建完让上层重新读一次：id 是新的，节拍器那边也重排了。 */
  onChanged: () => void
}): ReactElement {
  const [creating, setCreating] = useState(false)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 className="text-[13px] font-semibold [letter-spacing:var(--text-title3-tracking)]">新建任务</h2>
        <span className="text-[12px] text-muted-foreground">
          改现有的那几条：去「内容」点它自己那一行的编辑
        </span>
      </div>

      <div className="flex flex-col items-start gap-2">
        <Button
          type="button" size="small" variant="neutral"
          data-testid="task-config-new" onClick={() => setCreating(true)}
        >
          <PlusIcon />
          新建任务
        </Button>
        <div className="text-[13px] text-muted-foreground">
          从一条空的开始——建出来默认是停用的，先手动跑一次看结果，再自己打开。
        </div>
      </div>

      {/* 新建和改用**同一个弹窗**：两件事填的是同一份字段，形状不该有两套。 */}
      <TaskEditorDialog
        open={creating}
        onOpenChange={setCreating}
        apiBase={apiBase}
        conn={conn}
        task={null}
        existingIds={tasks.map((t) => t.id)}
        actions={actions}
        groups={groups}
        exclusiveGroups={exclusiveGroups}
        onSaved={() => onChanged()}
        onDeleted={() => onChanged()}
      />
    </div>
  )
}

export function TasksPage({
  apiBase, title = '定时任务', conn,
}: {
  apiBase: string
  title?: string
  /**
   * 给账号那份表单用（`SchemaForm` 吃的是 `Connection`，因为 `/api/config/*` 要带 token）。
   *
   * 缺省成 `{ baseUrl: apiBase }` 只为测试和"就一个地址"的嵌入档；**真实面板必须显式传
   * `LOCAL`**，否则 token 在这一层被丢掉，表现是别的都正常、只有那份表单 401。
   */
  conn?: Connection
}): ReactElement {
  const connection: Connection = conn ?? { baseUrl: apiBase }
  const [tasks, setTasks] = useState<TaskListItem[] | null>(null)
  const [actions, setActions] = useState<string[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [tab, setTab] = useState<ChannelTab>('content')
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const t = await fetchTasks(apiBase)
      if (aliveRef.current) { setTasks(t.tasks); setActions(t.actions); setErr(null) }
    }
    catch (e) { if (aliveRef.current) setErr((e as Error).message) }
  }, [apiBase])

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => { aliveRef.current = false }
  }, [load])

  // 改完一行就地换掉那一行，不整页重拉：重拉会把已经展开的历史、正在编辑的排期一起收掉。
  // key 带 source 的理由见下面，这里换行也得按 (source, id) 认人。
  const replace = useCallback((next: TaskListItem) => {
    setTasks((prev) => prev?.map((t) => (t.source === next.source && t.id === next.id ? next : t)) ?? prev)
  }, [])

  // 按 source 分段。**判据只有 `source` 这一个字段**，不看 id、不看有没有 command——
  // 后端就是拿它区分"这行在库里"和"这行在代码里"的（见 `api.tasks.ts`）。
  const mine = tasks?.filter((t) => t.source === 'user') ?? []
  const builtin = tasks?.filter((t) => t.source !== 'user') ?? []

  // 分组候选**取自全部任务，两段都算**：用户想把自己的一条归进「网盘」（内置那几条用的名字）
  // 是完全正常的，候选里没有它就得手敲，敲歪一个字就多出一个只有一条的组。
  const groups = [...new Set((tasks ?? []).flatMap((t) => (t.group ? [t.group] : [])))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  // 互斥组候选同样两段都算，理由更硬：**内置任务和用户任务抢的常常就是同一样东西**
  // （用户那条网盘脚本和内置的「网盘绑定自动同步」用的是同一份登录态）。候选里没有内置
  // 那几个组名，用户就只能手敲，敲歪一个字 = 两条任务各排各的队，而它们其实在抢同一样东西。
  const exclusiveGroups = [...new Set((tasks ?? []).flatMap((t) => (t.exclusiveOn ? [t.exclusiveOn] : [])))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶栏与其余四档 Present 同一格——数值是抄过来的，不是各画各的。**下边线不在这里**：
          底下那排分页（`ChannelTabs`）自己带一条铺满整宽的线，两条一起画会出现双线。 */}
      <div data-testid="panel-tasks-header" className="flex h-8 shrink-0 items-center gap-2 px-4 pt-3 pb-0 box-content">
        <ChannelTitleMenu
          title={title}
          onRefresh={() => { void load() }}
          // 这一页现读不入库，"抓取"这回事不存在——菜单不能说一件不会发生的事。
          refreshLabel="重新读取"
          className="min-w-0 flex-1"
        />
      </div>
      {/* 标题栏正下方那条「内容 | 配置」，和时间线/研究/外接面板同一个组件。 */}
      <ChannelTabs value={tab} onChange={setTab} />
      {tab === 'config' ? (
        <div data-testid="panel-tasks-config" className="relative min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <TasksConfigPanel apiBase={apiBase} conn={connection} tasks={mine} actions={actions} groups={groups} exclusiveGroups={exclusiveGroups} onChanged={() => { void load() }} />
        </div>
      ) : (
      /* `relative` 不是装饰：行里状态那格「正常」时是 `sr-only`（position:absolute），它的包含块
         是最近的定位祖先——这层不定位的话就落到面板根上，于是那些 absolute 的 span 逃出滚动
         容器、按页面坐标排进文档，整页被撑出一截空白（8900 独立页上滚到底多出 345px，
         实测 2026-09-06）。滚动容器自己当包含块，absolute 的东西就被它一起卷走。 */
      <div data-testid="panel-tasks-scroller" className="relative min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {err !== null && tasks === null ? (
          <div className="text-[13px] text-destructive">读不到任务列表：{err}</div>
        ) : tasks === null ? (
          <div className="text-[13px] text-muted-foreground">读取中…</div>
        ) : tasks.length === 0 ? (
          <div className="text-[13px] text-muted-foreground">一条任务也没有。</div>
        ) : (
          <>
            {/* 我的任务在上：这一段才是能动的（暂停 / 改排期 / 里面有真花钱的那几条），
                内置那段是运维底噪，绝大多数时候只需要"扫一眼没红就行"。
                两段都可能为空，`TaskSection` 空了就整段不画（连标题）。 */}
            <TaskSection
              id="user" heading="我的任务" hint="点编辑改这一条的全部：跑什么、参数、排期、账号"
              tasks={mine} apiBase={apiBase} conn={connection} actions={actions} groups={groups}
              exclusiveGroups={exclusiveGroups} onChanged={replace} onRemoved={() => { void load() }}
            />
            {/* 内置那段不再逐行挂「内置」标签——标题已经说了，那枚标签只是在每一行重复一遍
                同一句话，而它占的正是任务名的位置（窄窗格下名字本来就不够放）。 */}
            <TaskSection
              id="builtin" heading="内置运维任务" hint="排期写在代码里，这里只能看，或手动跑一次"
              tasks={builtin} apiBase={apiBase} conn={connection} actions={actions} groups={groups}
              exclusiveGroups={exclusiveGroups} onChanged={replace} onRemoved={() => { void load() }}
            />
          </>
        )}
      </div>
      )}
    </div>
  )
}
