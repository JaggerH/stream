/**
 * 一条用户任务的整行编辑器：建、改、删。「配置」分页里那一半。
 *
 * **为什么是整行而不是补丁**：后端写路由只有 upsert 一条、且要整行（`PUT /api/tasks/:id`，
 * 少一个键就是 400）。所以这里手上始终是一份完整的草稿，保存时整份发出去。
 *
 * **执行体二选一**：一条**外部命令**（command/args/cwd/env），或者一个**包提供的动作**
 * （`action`，`<包 id>:<动作名>`）。两个都给、两个都空都是 400，所以下拉切档时要把另一边
 * 清干净——那正是 `TaskEditor.test.tsx` 里"填过命令再切到动作"那条守的。
 *
 * **命令档的参数就在 `args`/`env` 里，没有第二层参数模型。** 那一档的全部可配置面就是它的
 * 命令行：`--alias jagger` 是"用哪个账号跑"。所以"账号配置"不是一个要另找地方安置的东西——
 * 它是 argv 里的一个词，就该和 command 并排放在一起看。**不要**为它升级成「声明式参数表单」
 * 而顺手去改用户现有那几行的 argv：那几行是真下单的，为一个更好看的下拉框重写它们的命令行
 * 不划算。**动作档反过来**：它没有 argv，参数全部来自下面「账号 / 密钥」那一格（配置 row），
 * 因为 `GET /api/tasks` 会把整行回显——值进了 argv 就是明文进任务列表和 `ps`。
 *
 * **表单按人问的四个问题分组**，不按字段类型堆：这条任务是谁（id/label）→ 跑什么
 * （执行体 + 它那一档的字段）→ 什么时候跑（schedule/timezone）→ 怎么跑（启用/串行/重试/超时）。
 * 之前是三块两列网格加两条全宽列表交替排，于是 timezone 离 schedule 隔着两块、args 浮在
 * 中间——每个字段单看都对，合起来读的人得自己重排一遍。
 *
 * **id 建了就不能改**：它是账本、排期、撞名判定共用的那把钥匙。要换名字改 `label`。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { Button } from '../acrylic/button.tsx'
import { Input } from '../acrylic/input.tsx'
import { ScheduleEditor } from './ScheduleEditor.tsx'
import { SchemaForm } from '../config/SchemaForm.tsx'
import { api, type Connection } from '../../lib/api.ts'
import { deleteTask, putTask, type TaskInput, type TaskListItem } from '../../lib/api.tasks.ts'

/** 新建时的草稿。**默认停用**：一条刚建出来、还没跑过一次的任务，默认就挂上节拍器是没道理的；
 *  让人先手动跑一次看结果，再自己打开。 */
function emptyDraft(): TaskInput {
  return {
    id: '', label: '', schedule: '0 0 9 * * *',
    command: '', args: [],
    serial: true, maxAttempts: 1, enabled: false,
  }
}

function toDraft(task: TaskListItem): TaskInput {
  return {
    id: task.id,
    label: task.label,
    schedule: task.schedule,
    ...(task.timezone !== undefined ? { timezone: task.timezone } : {}),
    // 二选一，**照原样带过来**：把缺席的那个补成空串，保存时就会被判成"两个都给了"。
    ...(typeof task.action === 'string' ? { action: task.action } : { command: task.command ?? '' }),
    args: task.args ?? [],
    ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
    ...(task.env !== undefined ? { env: task.env } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    serial: task.serial !== false,
    ...(task.exclusiveOn !== undefined ? { exclusiveOn: task.exclusiveOn } : {}),
    ...(task.whenBusy !== undefined ? { whenBusy: task.whenBusy } : {}),
    maxAttempts: task.maxAttempts ?? 1,
    ...(task.configRef !== undefined ? { configRef: task.configRef } : {}),
    ...(task.group !== undefined ? { group: task.group } : {}),
    enabled: task.enabled,
  }
}

/**
 * 前端先校验一遍，**判据逐条抄自后端** `src/http/task-routes.ts` 的 `validate()`。
 *
 * 抄一份不是不信后端——后端那份仍然是唯一说了算的。这一份的作用是让人在**按下保存之前**
 * 就看见问题（尤其 6 段 cron 那条：写成 5 段后端会 400，但人不知道自己错在哪）。两份漂移
 * 的代价是"前端放行、后端 400"，所以下面每一条都对着那个文件写，改那边就得改这边。
 */
function validateDraft(d: TaskInput, existingIds: string[], isNew: boolean): string | null {
  if (d.id.trim() === '') return 'id 必填——它是账本和排期共用的钥匙，建好之后改不了'
  if (isNew && existingIds.includes(d.id.trim())) return `已经有一条 id 是 ${d.id.trim()} 的任务了`
  if (d.label.trim() === '') return 'label 必填——任务表上显示的就是它'
  // 执行体二选一（后端同判据）：外部命令，或者包提供的动作。
  const hasCommand = (d.command ?? '').trim() !== ''
  const hasAction = (d.action ?? '').trim() !== ''
  if (hasCommand && hasAction) return 'command 和 action 只能给一个'
  if (!hasCommand && !hasAction) return 'command 或 action 必填一个'
  if (d.schedule.trim().split(/\s+/).length !== 6) {
    return 'schedule 必须是 6 段（含秒），如每天 09:45 = "0 45 9 * * *"'
  }
  if (!Number.isInteger(d.maxAttempts) || d.maxAttempts < 1) return 'maxAttempts 必须是 ≥ 1 的整数'
  if (d.timeoutMs !== undefined && (!Number.isFinite(d.timeoutMs) || d.timeoutMs <= 0)) return 'timeoutMs 要么不填，要么是正数'
  return null
}

/** 一组字段 = 人问的一个问题。标题是那个问题的答案的名字，不是字段类型的分类。 */
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-[var(--acr-border-soft)] px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold [letter-spacing:var(--text-title3-tracking)]">{title}</span>
        {hint !== undefined && <span className="text-[11px] text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </section>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactElement | ReactElement[] }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
      {hint !== undefined && <span className="text-[11px] text-muted-foreground/80">{hint}</span>}
    </label>
  )
}

/**
 * `args` 的列表编辑器：一格一个词。
 *
 * **一格一个词，不是一行字符串**：`--alias jagger` 拆成两格是 argv 的真实形状，而把它写成
 * 一行再拿空格切，会在参数里含空格那天（路径、带空格的标的名）静默切错——切错的表现是
 * 少一个参数、多一个参数，命令照跑，错在别处才现形。
 */
function ArgsEditor({ args, onChange }: { args: string[]; onChange: (next: string[]) => void }): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">args（一格一个词）</span>
      {args.map((a, i) => (
        // key 只能用下标：argv 里重复的词很常见（两个 `--flag`），用值当 key 会撞。
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="flex items-center gap-1">
          <span className="w-5 shrink-0 text-right font-mono text-[11px] text-muted-foreground">{i}</span>
          <Input
            data-testid={`task-arg-${i}`} aria-label={`第 ${i} 个参数`}
            value={a} spellCheck={false} autoComplete="off"
            className="h-7 flex-1 px-2 font-mono text-[12px]"
            onChange={(e) => onChange(args.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <Button
            type="button" icon size="small" variant="ghost"
            data-testid={`task-arg-remove-${i}`} aria-label={`删掉第 ${i} 个参数`}
            onClick={() => onChange(args.filter((_, j) => j !== i))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div>
        <Button type="button" size="small" variant="ghost" data-testid="task-arg-add" onClick={() => onChange([...args, ''])}>
          <PlusIcon />
          加一个参数
        </Button>
      </div>
    </div>
  )
}

/** `env` 的键值编辑器。空键的行在保存时丢掉——半填的一行不该变成一个名字是空串的变量。 */
function EnvEditor({ env, onChange }: { env: Record<string, string>; onChange: (next: Record<string, string>) => void }): ReactElement {
  const rows = Object.entries(env)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">env</span>
      {rows.map(([k, v], i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="flex items-center gap-1">
          <Input
            data-testid={`task-env-key-${i}`} aria-label={`第 ${i} 个环境变量的名字`}
            value={k} spellCheck={false} autoComplete="off"
            className="h-7 w-40 px-2 font-mono text-[12px]"
            onChange={(e) => {
              const next: Record<string, string> = {}
              rows.forEach(([kk, vv], j) => { next[j === i ? e.target.value : kk] = vv })
              onChange(next)
            }}
          />
          <Input
            data-testid={`task-env-value-${i}`} aria-label={`${k} 的值`}
            value={v} spellCheck={false} autoComplete="off"
            className="h-7 flex-1 px-2 font-mono text-[12px]"
            onChange={(e) => onChange({ ...env, [k]: e.target.value })}
          />
          <Button
            type="button" icon size="small" variant="ghost"
            data-testid={`task-env-remove-${i}`} aria-label={`删掉 ${k}`}
            onClick={() => {
              const next = { ...env }
              delete next[k]
              onChange(next)
            }}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button" size="small" variant="ghost" data-testid="task-env-add"
          onClick={() => onChange({ ...env, '': '' })}
          disabled={Object.prototype.hasOwnProperty.call(env, '')}
        >
          <PlusIcon />
          加一个环境变量
        </Button>
      </div>
    </div>
  )
}

export function TaskEditor({
  apiBase, conn, task, existingIds, actions = [], groups = [], exclusiveGroups = [], onSaved, onDeleted, onCancel,
}: {
  apiBase: string
  /** 账号那份表单要它（`/api/config/*` 走 `Connection`，带 token）。 */
  conn: Connection
  /** null = 新建 */
  task: TaskListItem | null
  /** 已有的 id，用来在新建时当场拦下重名（后端也会 409/403，但那要等一个来回） */
  existingIds: string[]
  /** 这台机器上装的包提供了哪些动作（`GET /api/tasks` 顺带回的那份）。空 = 只能跑外部命令。 */
  actions?: string[]
  /** 现有任务已经用过的分组名（去重后）。**只是提示，不是白名单**：敲一个新的照样能存。 */
  groups?: string[]
  /** 现有任务已经用过的互斥组名。同样只是提示——第一个抢某样东西的人得自己起名字。 */
  exclusiveGroups?: string[]
  onSaved: (saved: TaskListItem) => void
  onDeleted: (id: string) => void
  onCancel: () => void
}): ReactElement {
  const isNew = task === null
  const [draft, setDraft] = useState<TaskInput>(() => (task === null ? emptyDraft() : toDraft(task)))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // 删除要两步：删掉的是账本的锚点——那条任务的历次执行记录跟着一起没了，改不回来。
  // **保存不设闸**：写错了还能再改，而真正不可撤销的那个动作（「立即跑一次」）的闸在任务表上。
  const [armed, setArmed] = useState<'delete' | null>(null)
  const isAction = typeof draft.action === 'string'

  // 「用哪一格」的可选项 = 这台机器上装的包里，recipe 声明过的 runtime_config ref
  // （`/api/packages` 的 `slots.config`）。读失败不挡编辑：把原因显示出来，ref 仍可手填。
  const [refs, setRefs] = useState<string[]>([])
  const [refsErr, setRefsErr] = useState<string | null>(null)

  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  useEffect(() => {
    let alive = true
    api.packages(conn)
      .then((ps) => {
        if (!alive) return
        setRefs([...new Set(ps.flatMap((p) => p.slots.config ?? []))].sort())
        setRefsErr(null)
      })
      .catch((e: Error) => { if (alive) setRefsErr(e.message) })
    return () => { alive = false }
  }, [conn.baseUrl])

  // 待确认状态会自己过期，理由同任务表上那颗按钮：晾着不撤的话，回到页面时它又变成"一点就成"。
  useEffect(() => {
    if (armed === null) return
    const t = setTimeout(() => setArmed(null), 5000)
    return () => clearTimeout(t)
  }, [armed])

  // 换了要编辑的对象就换一份草稿——否则点到下一条任务，表单里还是上一条的内容，
  // 而保存会把上一条的命令写进下一条。
  useEffect(() => { setDraft(task === null ? emptyDraft() : toDraft(task)); setErr(null); setArmed(null) }, [task])

  const invalid = validateDraft(draft, existingIds, isNew)

  const save = useCallback(async () => {
    setBusy(true)
    setErr(null)
    try {
      // 空键的 env 行不发出去（半填的一行）；args 里的空格两头去掉但**不丢空串**——
      // 空串是一个合法的 argv 成员，替用户丢掉它就是替他改命令。
      const clean: TaskInput = {
        ...draft,
        id: draft.id.trim(),
        label: draft.label.trim(),
        // 只剩空白的分组当没填。不这么做的话库里会存下一个名字是几个空格的组，
        // 页面上就是一个看不见名字的分组小标题（后端也归一化，这里省一次来回）。
        group: (draft.group ?? '').trim() === '' ? undefined : draft.group!.trim(),
        // 只剩空白的互斥组当没填，同上——存下去队列名就成了 `x:`，而界面上看着像"没设"。
        exclusiveOn: (draft.exclusiveOn ?? '').trim() === '' ? undefined : draft.exclusiveOn!.trim(),
        // 只发在场的那个执行体：动作型的行发一个空 command 过去，会被后端判成"两个都给了"。
        ...(typeof draft.command === 'string' && draft.command.trim() !== ''
          ? { command: draft.command.trim() } : { command: undefined }),
        ...(typeof draft.action === 'string' && draft.action.trim() !== ''
          ? { action: draft.action.trim() } : { action: undefined }),
        ...(draft.env ? { env: Object.fromEntries(Object.entries(draft.env).filter(([k]) => k.trim() !== '')) } : {}),
      }
      const saved = await putTask(apiBase, clean)
      if (!aliveRef.current) return
      onSaved(saved)
    }
    catch (e) { if (aliveRef.current) setErr((e as Error).message) }
    finally { if (aliveRef.current) { setBusy(false); setArmed(null) } }
  }, [apiBase, draft, onSaved])

  const remove = useCallback(async () => {
    if (task === null) return
    setBusy(true)
    setErr(null)
    try {
      await deleteTask(apiBase, task.id)
      if (!aliveRef.current) return
      onDeleted(task.id)
    }
    catch (e) { if (aliveRef.current) setErr((e as Error).message) }
    finally { if (aliveRef.current) { setBusy(false); setArmed(null) } }
  }, [apiBase, onDeleted, task])

  return (
    // 标题归弹窗（`DialogTitle`，读屏也认它）——这里再写一份就是同一句话画两遍。
    <div data-testid="task-editor" className="flex flex-col gap-3">
      <Group title="这条任务">
        <div className="grid grid-cols-2 gap-3">
          <Field label="id" hint={isNew ? '账本和排期共用的钥匙，建好之后改不了' : '建好之后改不了；要换名字改 label'}>
            <Input
              data-testid="task-field-id" value={draft.id} disabled={!isNew}
              spellCheck={false} autoComplete="off" className="h-7 px-2 font-mono text-[12px]"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
          </Field>
          <Field label="label" hint="任务表上显示的名字">
            <Input
              data-testid="task-field-label" value={draft.label}
              className="h-7 px-2 text-[13px]"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </Field>
        </div>
        {/* 分组是**可输入的下拉**（`list` + `datalist`），不是纯 select：建同一组的第二条任务时
            不该让人重新拼一遍组名（拼歪一个字就是多出一个只有一条的组），但组名的集合又不是
            后端定义的白名单——新分组必须能当场敲出来。两个需求只有这一种控件同时满足。
            **不给它任何执行语义**：它只决定这一行在任务页上落进哪个小标题（见后端 `types.ts`）。 */}
        <Field label="分组" hint="只影响任务页怎么摆；留空 = 不分组，落在「未分组」那一节">
          <Input
            data-testid="task-field-group" value={draft.group ?? ''}
            list="task-group-options" spellCheck={false} autoComplete="off"
            className="h-7 px-2 text-[13px]"
            onChange={(e) => setDraft({ ...draft, group: e.target.value === '' ? undefined : e.target.value })}
          />
          <datalist id="task-group-options">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </Field>
      </Group>

      {/* 命令 + 参数 + 环境变量在同一块里：它们合起来才是"到点执行的那一行"。
          「换个账号跑」改的就是这块里 args 的某一格，不在别处。 */}
      {/* 两种执行体：一条外部命令，或者一个装进来的包提供的动作。**同一块里二选一**，
          不分成两页——它们回答的是同一个问题（到点干什么），分开放会让人以为是两种任务。
          动作那档没有 command / args / cwd / env：它的参数在下面那格配置里（值不进 argv，
          否则 `GET /api/tasks` 会把整行回显，密码就明文进了任务列表）。 */}
      <Group
        title="跑什么"
        hint={isAction
          ? '装进来的包提供的动作；它要的参数在下面「账号 / 密钥」那一格里填'
          : '到点执行的就是这一行命令；参数（账号、开关）就是 argv 里的词'}
      >
        <Field label="执行体" hint={actions.length === 0 ? '当前没有任何包提供动作，只能跑外部命令' : '外部命令，或者某个包提供的动作'}>
          <select
            data-testid="task-field-kind"
            className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
            value={isAction ? 'action' : 'command'}
            onChange={(e) => setDraft(e.target.value === 'action'
              ? { ...draft, command: undefined, args: [], cwd: undefined, env: undefined, action: actions[0] ?? '' }
              : { ...draft, action: undefined, command: '' })}
          >
            <option value="command">外部命令</option>
            <option value="action" disabled={actions.length === 0}>包提供的动作</option>
          </select>
        </Field>
        {isAction ? (
          <Field label="action" hint="`<包 id>:<动作名>`">
            <select
              data-testid="task-field-action"
              className="h-7 w-full rounded-md border border-input bg-transparent px-2 font-mono text-[12px]"
              value={draft.action ?? ''}
              onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            >
              {actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </Field>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="command" hint="可执行文件的绝对路径">
                <Input
                  data-testid="task-field-command" value={draft.command ?? ''}
                  spellCheck={false} autoComplete="off" className="h-7 px-2 font-mono text-[12px]"
                  onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                />
              </Field>
              <Field label="cwd" hint="不填 = 后端自己的工作目录">
                <Input
                  data-testid="task-field-cwd" value={draft.cwd ?? ''}
                  spellCheck={false} autoComplete="off" className="h-7 px-2 font-mono text-[12px]"
                  onChange={(e) => setDraft({ ...draft, cwd: e.target.value === '' ? undefined : e.target.value })}
                />
              </Field>
            </div>
            <ArgsEditor args={draft.args} onChange={(args) => setDraft({ ...draft, args })} />
            <EnvEditor env={draft.env ?? {}} onChange={(env) => setDraft({ ...draft, env })} />
          </>
        )}
      </Group>

      {/* timezone 紧跟 schedule：它改的是同一句话里的"按谁的钟"，隔开放的时候读的人要跨两块
          才拼得出下一次什么时候跑。 */}
      <Group title="什么时候跑">
        <ScheduleEditor
          taskId={draft.id || 'new'} schedule={draft.schedule} timezone={draft.timezone}
          // 嵌入档：只报结果，不画自己的保存键（整行的保存在下面）。
          onChange={(schedule) => { if (schedule !== null && schedule !== draft.schedule) setDraft((d) => ({ ...d, schedule })) }}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="timezone" hint="不填 = 本机时区">
            <Input
              data-testid="task-field-timezone" value={draft.timezone ?? ''}
              spellCheck={false} autoComplete="off" className="h-7 px-2 font-mono text-[12px]"
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value === '' ? undefined : e.target.value })}
            />
          </Field>
        </div>
      </Group>

      {/* 账号/密钥不进 argv 也不进 env：那等于把交易密码摊在 `ps` 和任务列表里。它住配置 row
          （`/api/config/source:<ref>`，密文只写不回显），这里只是把那份表单**搬到这条任务
          面前**——要填的东西和用它的任务在同一屏，不用去别的页面找。 */}
      <Group
        title="账号 / 密钥"
        hint="值存在 Stream 的配置里，不写进命令行；这份表单自己保存，和上面的任务表单是两回事"
      >
        <Field
          label="用哪一格"
          hint={
            refsErr !== null
              ? `读不到可选项（${refsErr}）——仍可手填 ref`
              : '由包里的 recipe 声明。选「不绑」= 这条任务不需要账号'
          }
        >
          <select
            data-testid="task-field-config-ref" value={draft.configRef ?? ''}
            className="h-7 rounded-md border border-[var(--acr-input-border)] bg-[var(--acr-input)] px-2 text-[13px]"
            onChange={(e) => setDraft({ ...draft, configRef: e.target.value === '' ? undefined : e.target.value })}
          >
            <option value="">不绑</option>
            {/* 当前值即使不在清单里也要列出来（清单读失败、或那个包被卸了）：
                下拉里没有它就等于被 select 悄悄改成「不绑」，一保存这一格就没了。 */}
            {[...new Set([...(draft.configRef ? [draft.configRef] : []), ...refs])].sort().map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
        {draft.configRef !== undefined && draft.configRef !== '' && (
          <SchemaForm conn={conn} rowId={`source:${draft.configRef}`} />
        )}
      </Group>

      <Group title="怎么跑">
        <div className="grid grid-cols-2 gap-3">
          <Field label="maxAttempts" hint="失败重试几次算总共几次">
            <Input
              type="number" min={1} data-testid="task-field-attempts" value={draft.maxAttempts}
              className="h-7 px-2 text-[13px]"
              onChange={(e) => setDraft({ ...draft, maxAttempts: e.target.value === '' ? NaN : Number(e.target.value) })}
            />
          </Field>
          <Field label="timeoutMs" hint="不填 = 不设上限">
            <Input
              type="number" min={1} data-testid="task-field-timeout" value={draft.timeoutMs ?? ''}
              className="h-7 px-2 text-[13px]"
              onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value === '' ? undefined : Number(e.target.value) })}
            />
          </Field>
        </div>
        {/* 互斥组是**可输入的下拉**，理由同上面的分组：第一个抢某样东西的人得自己起名字，
            后来的人不该重敲一遍（敲歪一个字，两条任务就各排各的队，而界面上看不出来）。
            **组名是那样东西的名字**——`jq-bridge`（我要不要走这座桥，看一眼采集器就知道），
            不是 `cn-data`（"我这条算不算"永远说不清）。
            旁边那格问的是同一件事的另一半：轮不上的时候怎么办。 */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="互斥组" hint="这条任务独占的那样东西的名字；留空 = 不跟任何人抢">
            <Input
              data-testid="task-field-exclusive-on" value={draft.exclusiveOn ?? ''}
              list="task-exclusive-options" spellCheck={false} autoComplete="off"
              className="h-7 px-2 font-mono text-[12px]"
              onChange={(e) => setDraft({ ...draft, exclusiveOn: e.target.value === '' ? undefined : e.target.value })}
            />
            <datalist id="task-exclusive-options">
              {exclusiveGroups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </Field>
          {/* 判据写在 hint 里，因为这一格最容易照"这条任务重不重要"去选——那是错的判据：
              重要的补数任务晚一小时照样有价值，不重要的打新晚一分钟就是做了一件错事。 */}
          <Field label="轮不上的时候" hint="判据：迟到之后还算不算同一件事。补数/导出算 → 排着；有截止时间的（申购、报盘）不算 → 这一班不跑">
            <select
              data-testid="task-field-when-busy"
              className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-[12px]"
              value={draft.whenBusy ?? 'queue'}
              onChange={(e) => setDraft({ ...draft, whenBusy: e.target.value === 'skip' ? 'skip' : 'queue' })}
            >
              <option value="queue">排着，前面跑完就跑</option>
              <option value="skip">这一班不跑（留一条记录）</option>
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox" data-testid="task-field-enabled" checked={draft.enabled}
              onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            />
            启用（挂上节拍器）
          </label>
          {/* 「不叠着跑」说的是**这一条和它自己**：上一轮没跑完就跳过这一轮。它不让这条任务
              跟别的任务错开——那是上面互斥组的事。 */}
          <label className="flex items-center gap-1.5 text-[13px]">
            <input
              type="checkbox" data-testid="task-field-serial" checked={draft.serial}
              onChange={(e) => setDraft({ ...draft, serial: e.target.checked })}
            />
            不叠着跑（上一轮没跑完就跳过这一轮）
          </label>
        </div>
      </Group>

      {invalid !== null && <div data-testid="task-editor-invalid" className="text-[12px] text-destructive">{invalid}</div>}
      {err !== null && <div data-testid="task-editor-error" className="text-[12px] text-destructive">{err}</div>}

      <div className="flex items-center gap-2">
        <Button
          type="button" size="small" variant="default"
          data-testid="task-editor-save" disabled={busy || invalid !== null}
          onClick={() => { void save() }}
        >
          {busy ? '保存中…' : isNew ? '建这条任务' : '保存'}
        </Button>
        <Button type="button" size="small" variant="ghost" data-testid="task-editor-cancel" onClick={onCancel}>
          取消
        </Button>
        {!isNew && (
          <Button
            type="button" size="small" variant={armed === 'delete' ? 'destructive' : 'ghost'}
            data-testid="task-editor-delete" disabled={busy}
            onClick={() => {
              if (armed !== 'delete') { setArmed('delete'); return }
              void remove()
            }}
          >
            <Trash2Icon />
            {armed === 'delete' ? '确认删除？' : '删除'}
          </Button>
        )}
      </div>
    </div>
  )
}
