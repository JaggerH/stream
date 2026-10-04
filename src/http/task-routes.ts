/**
 * 任务的可见面（spec 2026-08-28 §3.3）。两条需求：有哪些任务、每条的历次执行。
 *
 * **为什么不用 Sidequest 自带的 /_p/sidequest**：那是 job 视角的面板，而所有任务共用同一个
 * Job 类（`StreamTaskJob`，taskId 只是参数），在那儿会糊成一堆，分不出谁是谁。
 *
 * **builtin 任务只读**：它们是 stream 自己的内脏（cookie 刷新、standby 回收），改排期就该
 * 改代码走 review，不该在 UI 里改。写路由对它们一律 403。
 */
import type { Hono, Context } from 'hono'
import { errText } from '../err-text.ts'
import type { TaskStore, UserTaskRow, UserTaskInput } from '../tasks/task-store.ts'
import type { RunLedger } from '../tasks/run-history.ts'
import { BUILTIN_TASK_IDS } from '../tasks/builtin.ts'

export interface TaskRoutesDeps {
  store: Pick<TaskStore, 'list' | 'get' | 'upsert' | 'remove'>
  ledger: Pick<RunLedger, 'runs' | 'lastRun'>
  /** `group` 也得带出来：内置任务占了任务表的一半，不带的话页面上是一大坨「未分组」。
   *  `exclusiveOn` 同理——列表上那枚互斥标记要能画在内置行上，否则"谁在跟谁抢"只看得见一半。 */
  builtins: () => Array<{
    id: string; label: string; schedule: string; timezone?: string; group?: string
    exclusiveOn?: string; whenBusy?: 'queue' | 'skip'
  }>
  /** 可选的**动作**清单（`<包 id>:<动作名>`）：任务编辑器拿它当下拉项，写路由拿它验名字。 */
  actions: () => string[]
  /** 建/改之后按新定义重排 */
  apply: (row: UserTaskRow) => Promise<void>
  /** 删/停用之后摘掉那条 cron */
  unapply: (id: string) => Promise<void>
  runNow: (id: string) => Promise<boolean>
}

/** 一次最多回多少条历次执行——账本二十几万行，不夹一下一次查就能把页面拖死。 */
const MAX_RUNS = 200

function validate(
  body: unknown,
  knownActions: readonly string[],
): { ok: true; value: UserTaskInput } | { ok: false; why: string } {
  const b = body as Partial<UserTaskInput>
  if (typeof b?.id !== 'string' || b.id.trim() === '') return { ok: false, why: 'id 必填' }
  if (typeof b.label !== 'string' || b.label.trim() === '') return { ok: false, why: 'label 必填' }
  // 执行体二选一。**两个都空**是一条永远跑不起来的任务（症状是每轮红一次，而行看着很正常）；
  // **两个都给**就没人说得清跑的是哪个——两种都在这里拒，别留到运行时。
  const hasCommand = typeof b.command === 'string' && b.command.trim() !== ''
  const hasAction = typeof b.action === 'string' && b.action.trim() !== ''
  if (hasCommand && hasAction) return { ok: false, why: 'command 和 action 只能给一个' }
  if (!hasCommand && !hasAction) return { ok: false, why: 'command 或 action 必填一个' }
  // 动作名当场核对：打错一个字的表现是这条任务每轮红一次，而错误发生在几小时后的某轮调度里。
  if (hasAction && !knownActions.includes(b.action!.trim())) {
    return {
      ok: false,
      why: `没有这个动作：${b.action!.trim()}${knownActions.length ? `（可选：${knownActions.join('、')}）` : '（当前一个包动作都没有）'}`,
    }
  }
  if (!Array.isArray(b.args) || b.args.some((a) => typeof a !== 'string')) return { ok: false, why: 'args 必须是字符串数组' }
  if (typeof b.schedule !== 'string') return { ok: false, why: 'schedule 必填' }
  // 6 段而不是 5——本仓的调度中心带秒。给 5 段的话 node-cron 会把"分"当成"秒"，
  // 一条本该每天跑一次的任务变成每分钟跑一次，而且不报错。宁可 400。
  if (b.schedule.trim().split(/\s+/).length !== 6) return { ok: false, why: 'schedule 必须是 6 段（含秒），如每天 09:45 = "0 45 9 * * *"' }
  // 不带整数校验，1.5 这样的行能一路走到引擎的重试配置里——重试次数打对折是什么效果没人试过。
  if (typeof b.maxAttempts !== 'number' || !Number.isInteger(b.maxAttempts) || b.maxAttempts < 1) {
    return { ok: false, why: 'maxAttempts 必须是 ≥ 1 的整数' }
  }
  // 只认这两个词。放行别的字的后果是它一路落库，然后在 hydrate 那层被当成默认的 `queue`——
  // 一条以为自己设了"迟到就别做"的任务，其实一直在排队补跑，而没有任何一处会提。
  if (b.whenBusy !== undefined && b.whenBusy !== 'queue' && b.whenBusy !== 'skip') {
    return { ok: false, why: 'whenBusy 只能是 queue（排着）或 skip（这一班不跑）' }
  }
  return {
    ok: true,
    value: {
      id: b.id, label: b.label, schedule: b.schedule,
      ...(typeof b.timezone === 'string' ? { timezone: b.timezone } : {}),
      ...(hasCommand ? { command: b.command! } : {}),
      ...(hasAction ? { action: b.action!.trim() } : {}),
      args: b.args as string[],
      ...(typeof b.cwd === 'string' ? { cwd: b.cwd } : {}),
      ...(b.env && typeof b.env === 'object' ? { env: b.env as Record<string, string> } : {}),
      ...(typeof b.timeoutMs === 'number' ? { timeoutMs: b.timeoutMs } : {}),
      serial: b.serial !== false,
      // 空串 = 不互斥（编辑器里那格清空发的就是空串），理由同下面 configRef/group 那两格：
      // 存下一个空字符串组名，队列名就成了 `x:`，而界面上看着像"没设"。
      ...(typeof b.exclusiveOn === 'string' && b.exclusiveOn.trim() !== '' ? { exclusiveOn: b.exclusiveOn.trim() } : {}),
      ...(b.whenBusy === 'skip' || b.whenBusy === 'queue' ? { whenBusy: b.whenBusy } : {}),
      maxAttempts: b.maxAttempts,
      // 空串 = 没绑（前端的"不绑"选项发的就是空串）。不归一化的话库里会存下一个空字符串 ref，
      // 编辑器照着它去请求 `/api/config/source:` 拿一个 404。
      ...(typeof b.configRef === 'string' && b.configRef.trim() !== '' ? { configRef: b.configRef.trim() } : {}),
      // 空串 = 没分组（编辑器里那个「不分组」选项发的就是空串），理由同上面 configRef 那格：
      // 不归一化的话库里会存下一个空字符串分组，页面上就顶出一个没有名字的分组小标题。
      ...(typeof b.group === 'string' && b.group.trim() !== '' ? { group: b.group.trim() } : {}),
      enabled: b.enabled !== false,
    },
  }
}

export function mountTaskRoutes(app: Hono, deps: TaskRoutesDeps): void {
  // 一条撞了内置 id 的用户行**永远不会执行**：调度中心按「内置优先」去重，把它丢掉且只在
  // 后端日志留一句。清单必须把这件事说出来——否则行主看到的是一条外表完全正常的任务，
  // 而唯一的证据在一行他看不到的日志里。判据用静态名单（不是 `deps.builtins()`），理由同
  // 下面的 `isBuiltin`：条件装配的结果在查询档下恒为空，用它判会漏报成"一切正常"。
  //
  // 写路由今天 403 挡住新建/改撞名，所以 `shadowed` 只会出现在**存量**行上（那个 id 是后来
  // 才变成内置的）。它不该被清单过滤掉：看不见的行删不掉，那比"看得见但不跑"更糟。
  app.get('/api/tasks', (c) => {
    const builtin = deps.builtins().map((t) => ({
      ...t, source: 'builtin' as const, enabled: true, lastRun: deps.ledger.lastRun(t.id) ?? null,
    }))
    const user = deps.store.list().map((r) => ({
      ...r, source: 'user' as const, lastRun: deps.ledger.lastRun(r.id) ?? null,
      ...(isBuiltin(r.id) ? { shadowed: true as const } : {}),
    }))
    // `actions` 跟着清单一起回：编辑器要拿它画「执行什么」那个下拉，单独开一条端点只是
    // 多一次往返，而这份名单本来就随后端启动固定。
    return c.json({ tasks: [...builtin, ...user], actions: deps.actions() })
  })

  app.get('/api/tasks/:id/runs', (c) => {
    const raw = Number(c.req.query('limit'))
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_RUNS) : 50
    return c.json({ runs: deps.ledger.runs(c.req.param('id'), limit) })
  })

  // 静态名单是权威的——不读 deps.builtins()：那是「本机此刻实际装了哪些」的运行期条件装配
  // 结果，查询档下恒为 []、没 Docker 的机器上少一个 id，用它守撞名会在这两种情况下失守
  // （见 BUILTIN_TASK_IDS 头注）。
  const isBuiltin = (id: string): boolean => BUILTIN_TASK_IDS.includes(id)

  /** 建和改是同一件事（upsert）——分成两条路由只是为了 REST 语义和 id 的来源不同。 */
  const write = async (c: Context, id?: string) => {
    let body: unknown
    try { body = await c.req.json() } catch (e) { return c.json({ error: `body 不是合法 JSON: ${errText(e)}` }, 400) }
    if (id !== undefined && isBuiltin(id)) return c.json({ error: `${id} 是内置运维任务，排期改代码不改库` }, 403)
    const v = validate(id === undefined ? body : { ...(body as object), id }, deps.actions())
    if (!v.ok) return c.json({ error: v.why }, 400)
    if (isBuiltin(v.value.id)) return c.json({ error: `${v.value.id} 与内置任务重名` }, 403)
    const row = deps.store.upsert(v.value)
    // 停用的行只入库不排期——留着它的定义和历史，但节拍器上没有它
    if (row.enabled) await deps.apply(row)
    else await deps.unapply(row.id)
    return c.json({ task: row })
  }

  app.post('/api/tasks', (c) => write(c))
  app.put('/api/tasks/:id', (c) => write(c, c.req.param('id')))

  // **先查库再判内置**，顺序不能反。内置任务从不入库，所以「库里有这一行」就等于「这是用户
  // 自己的行」——哪怕它的 id 撞了内置。反过来先 403 的话，一条存量撞名行会既改不动（写路由
  // 403）又删不掉（这里 403），只能让用户去翻数据库；而它本来就不会执行，留着毫无意义。
  app.delete('/api/tasks/:id', async (c) => {
    const id = c.req.param('id')
    if (!deps.store.get(id)) {
      return isBuiltin(id)
        ? c.json({ error: `${id} 是内置运维任务，不能删` }, 403)
        : c.json({ error: `没有这个任务: ${id}` }, 404)
    }
    await deps.unapply(id)
    deps.store.remove(id)
    return c.json({ ok: true })
  })

  app.post('/api/tasks/:id/run', async (c) => {
    const id = c.req.param('id')
    return await deps.runNow(id)
      ? c.json({ ok: true })
      : c.json({ error: `没有这个任务或调度中心没起来: ${id}` }, 404)
  })
}
