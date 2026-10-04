/** 任务面的四个调用。薄封装：只管 URL 和 JSON，不管状态。 */
export interface TaskRunView {
  id: number
  state: string
  insertedAt: number
  attemptedAt: number | null
  completedAt: number | null
  durationMs: number | null
  attempt: number
  summary: string | null
  detail: unknown
  errors: unknown
  /** 失败的那句人话（后端从 errors 里取并翻译）；没失败或没说明就是 null。老后端没有这一格。 */
  failure?: string | null
}

export interface TaskListItem {
  id: string
  label: string
  schedule: string
  timezone?: string
  source: 'builtin' | 'user'
  enabled: boolean
  lastRun: TaskRunView | null
  /** 用户任务行的其余字段（`GET /api/tasks` 把整行原样带出来）。**内置任务没有它们**——
   *  内置任务不入库，改排期改代码。改一条用户任务要把整行发回去（见 `saveTask`），
   *  所以这些必须留在手上，不能在类型里丢掉。 */
  command?: string
  /** 执行体之二：包提供的动作（`<包 id>:<动作名>`）。与 `command` 二选一。 */
  action?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  serial?: boolean
  maxAttempts?: number
  /** 这条任务独占的资源名。同名的任务同时只跑一条；缺席 = 不跟任何人互斥。
   *  **内置任务也有这一格**（后端带出来的），列表上那枚互斥标记两段都画。 */
  exclusiveOn?: string
  /** 互斥组正忙时：排着（`queue`，缺省）还是这一班不跑（`skip`）。 */
  whenBusy?: 'queue' | 'skip'
  /** 这条任务的账号/密钥存在哪一格（配置 row 的 ref）。编辑这条任务时就地画出那份表单。 */
  configRef?: string
  /** 归属分组，**纯展示**：列表按它分节。**内置任务也有这一格**（后端带出来的），所以它
   *  不在上面那段"只有用户行才有"的字段里。改一条用户任务是整行 PUT 回去，这一格必须留在
   *  类型里——丢了的话改别的字段会顺手把分组抹掉，而界面上要等下次刷新才看得出来。 */
  group?: string
  /** 这一行的 id 撞了内置任务，调度中心按「内置优先」丢掉了它——它永远不会执行。
   *  后端只在存量行上打这个标（写路由 403 挡住新建撞名），所以界面上出现它就意味着
   *  有一行需要行主处理。缺席 = 正常，不是"未知"。 */
  shadowed?: boolean
}

async function jsonOrThrow(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status} ${body.slice(0, 300)}`)
  }
  return res.json()
}

/** 清单顺带回一份「这台机器上装的包提供了哪些动作」——编辑器拿它画「跑什么」那个下拉。
 *  跟着清单回而不是单开一条端点：它随后端启动固定，多一次往返只是多一次往返。 */
export async function fetchTasks(apiBase: string): Promise<{ tasks: TaskListItem[]; actions: string[] }> {
  const body = await jsonOrThrow(await fetch(`${apiBase}/api/tasks`)) as {
    tasks: TaskListItem[]; actions?: string[]
  }
  return { tasks: body.tasks, actions: body.actions ?? [] }
}

export async function fetchRuns(apiBase: string, id: string, limit = 50): Promise<TaskRunView[]> {
  const body = await jsonOrThrow(await fetch(`${apiBase}/api/tasks/${encodeURIComponent(id)}/runs?limit=${limit}`)) as { runs: TaskRunView[] }
  return body.runs
}

/**
 * 一条用户任务的**整行**（后端 `UserTaskInput` 的镜像，见 `src/tasks/task-store.ts`）。
 *
 * 写路由只有 upsert 一条、且要整行，所以编辑器手上必须是完整的一行而不是补丁——
 * 这也是为什么这个类型要在前端存在：少一个键就是一次 400，而且是保存那一刻才知道。
 */
export interface TaskInput {
  id: string
  label: string
  schedule: string
  timezone?: string
  /** 与 `action` 二选一。 */
  command?: string
  /** 与 `command` 二选一：包提供的动作（`<包 id>:<动作名>`）。 */
  action?: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
  serial: boolean
  /** 独占的资源名。空串 = 不互斥，后端会归一化掉。 */
  exclusiveOn?: string
  /** 互斥组正忙时排着还是这一班不跑。缺席 = `queue`。 */
  whenBusy?: 'queue' | 'skip'
  maxAttempts: number
  configRef?: string
  /** 归属分组（纯展示）。空串 = 不分组，后端会归一化掉。 */
  group?: string
  enabled: boolean
}

/** 建或改一条用户任务（后端同一条 upsert 路由）。回的是落库后的那一行。 */
export async function putTask(apiBase: string, input: TaskInput): Promise<TaskListItem> {
  const res = await jsonOrThrow(await fetch(`${apiBase}/api/tasks/${encodeURIComponent(input.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })) as { task: TaskListItem }
  return { ...res.task, source: 'user' }
}

export async function deleteTask(apiBase: string, id: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`)
}

export async function runTaskNow(apiBase: string, id: string): Promise<void> {
  await jsonOrThrow(await fetch(`${apiBase}/api/tasks/${encodeURIComponent(id)}/run`, { method: 'POST' }))
}

/**
 * 改一条用户任务（暂停/恢复 = 改 `enabled`，改排期 = 改 `schedule`）。
 *
 * 后端只有 upsert 一条写路由（`PUT /api/tasks/:id`），**要整行**：只发 `{ enabled: false }`
 * 会被 400 挡在 `command 必填` 上。所以这里拿列表里那一行原样发回去、只覆盖要改的那几个键——
 * 契约不动，改的是我们发什么。
 *
 * 内置任务在这里就拒（后端也 403）：内置行本来就没有 command，硬发过去只会拿到一句
 * 看不懂的 400。
 *
 */
export async function saveTask(
  apiBase: string,
  task: TaskListItem,
  patch: { schedule?: string; enabled?: boolean },
): Promise<TaskListItem> {
  if (task.source !== 'user') throw new Error(`${task.id} 是内置运维任务，排期改代码不改库`)
  // 执行体二选一：外部命令的行有 command，动作型的行有 action。两个都没有 = 这一行不完整
  // （多半是清单还没刷新），硬发过去只会拿到一句看不懂的 400。
  if (typeof task.command !== 'string' && typeof task.action !== 'string') {
    throw new Error(`${task.id} 这一行既没有 command 也没有 action，改不了——请刷新页面重试`)
  }
  const body = {
    id: task.id,
    label: task.label,
    schedule: patch.schedule ?? task.schedule,
    ...(task.timezone !== undefined ? { timezone: task.timezone } : {}),
    ...(typeof task.command === 'string' ? { command: task.command } : {}),
    ...(typeof task.action === 'string' ? { action: task.action } : {}),
    args: task.args ?? [],
    ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
    ...(task.env !== undefined ? { env: task.env } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    serial: task.serial !== false,
    // 互斥那两格也得整行带回去——漏了它们，一次「暂停」就把这条任务的互斥组和迟到语义清掉，
    // 而表现只是"它开始跟别人一起跑了"，界面上一个字都不会变。
    ...(task.exclusiveOn !== undefined ? { exclusiveOn: task.exclusiveOn } : {}),
    ...(task.whenBusy !== undefined ? { whenBusy: task.whenBusy } : {}),
    maxAttempts: task.maxAttempts ?? 1,
    ...(task.configRef !== undefined ? { configRef: task.configRef } : {}),
    // 整行发回去，分组也得在里面——漏了它，一次「暂停」就把这条任务的分组清掉了。
    ...(task.group !== undefined ? { group: task.group } : {}),
    enabled: patch.enabled ?? task.enabled,
  }
  const res = await jsonOrThrow(await fetch(`${apiBase}/api/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })) as { task: TaskListItem }
  return { ...task, ...res.task, source: 'user' }
}
