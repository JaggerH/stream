import { describe, it, expect, vi } from 'vitest'
import { Hono } from 'hono'
import { mountTaskRoutes, type TaskRoutesDeps } from './task-routes.ts'
import type { UserTaskRow } from '../tasks/task-store.ts'

const userRow: UserTaskRow = {
  id: 'dl-freshness', label: '数据新鲜度巡检', schedule: '0 0 * * * *',
  command: '/bin/python', args: ['-m', 'x'], serial: true, maxAttempts: 1,
  enabled: true, createdAt: 1, updatedAt: 1,
}

/** 一份完整的 store 替身。三处 `mk({ store })` 的覆盖都从这儿造，免得每加一个 store 成员
 *  就要挨个补——漏补的表现是 tsc 报错，响亮，但没必要每次都手抄一遍。 */
function mkStore(rows: UserTaskRow[]): TaskRoutesDeps['store'] {
  const m = new Map<string, UserTaskRow>(rows.map((r) => [r.id, r]))
  return {
    list: () => [...m.values()],
    get: (id) => m.get(id),
    upsert: (input) => { const r = { ...input, createdAt: 1, updatedAt: 2 }; m.set(r.id, r); return r },
    remove: (id) => m.delete(id),
  }
}

function mk(over: Partial<TaskRoutesDeps> = {}) {
  const deps: TaskRoutesDeps = {
    store: mkStore([userRow]),
    ledger: {
      runs: () => [{ id: 1, taskId: 'dl-freshness', state: 'completed', insertedAt: 1, attemptedAt: 1, completedAt: 3, durationMs: 2, attempt: 1, summary: '干完了', detail: undefined, errors: undefined, failure: null }],
      lastRun: () => ({ id: 1, taskId: 'dl-freshness', state: 'completed', insertedAt: 1, attemptedAt: 1, completedAt: 3, durationMs: 2, attempt: 1, summary: '干完了', detail: undefined, errors: undefined, failure: null }),
    },
    builtins: () => [{ id: 'cookie-refresh', label: '登录态刷新', schedule: '0 */5 * * * *' }],
    actions: () => ['eastmoney:subscribe', 'eastmoney:repo'],
    apply: vi.fn().mockResolvedValue(undefined),
    unapply: vi.fn().mockResolvedValue(undefined),
    runNow: vi.fn().mockResolvedValue(true),
    ...over,
  }
  const app = new Hono()
  mountTaskRoutes(app, deps)
  return { app, deps }
}

describe('GET /api/tasks', () => {
  it('合并两个来源并标注 source，带上次结果', async () => {
    const { app } = mk()
    const body = await (await app.request('/api/tasks')).json()
    expect(body.tasks.map((t: { id: string; source: string }) => [t.id, t.source]))
      .toEqual([['cookie-refresh', 'builtin'], ['dl-freshness', 'user']])
    const user = body.tasks[1]
    expect(user.lastRun.summary).toBe('干完了')
    expect(user.enabled).toBe(true)
    // 不撞名的行**没有**这个键（不是 false）：缺席即正常，界面上不该为它留位置。
    expect('shadowed' in user).toBe(false)
  })

  // 内置任务占了任务表的一半。它们的 group 不带出来的话，页面上就是一大坨「未分组」——
  // 分组这件事等于只做了一半，而看上去像是内置任务全都没归类。
  it('builtin 的 group 也带出来', async () => {
    const { app } = mk({
      builtins: () => [{ id: 'cookie-refresh', label: '登录态刷新', schedule: '0 */5 * * * *', group: '登录态' }],
      store: mkStore([{ ...userRow, group: '宏观' }]),
    })
    const body = await (await app.request('/api/tasks')).json()
    expect(body.tasks.map((t: { id: string; group?: string }) => [t.id, t.group]))
      .toEqual([['cookie-refresh', '登录态'], ['dl-freshness', '宏观']])
  })

  // 互斥组同理，而且更硬：用户任务和内置任务常常在抢同一样东西（同一份网盘登录态）。
  // 内置那几个组名不带出来，列表上"谁在跟谁抢"就只看得见一半，编辑器里的候选也少一半。
  it('builtin 的 exclusiveOn 也带出来', async () => {
    const { app } = mk({
      builtins: () => [{ id: 'netdisk-autosync', label: '网盘绑定自动同步', schedule: '0 0 */6 * * *', exclusiveOn: 'netdisk' }],
      store: mkStore([{ ...userRow, exclusiveOn: 'netdisk', whenBusy: 'skip' }]),
    })
    const body = await (await app.request('/api/tasks')).json()
    expect(body.tasks.map((t: { id: string; exclusiveOn?: string }) => [t.id, t.exclusiveOn]))
      .toEqual([['netdisk-autosync', 'netdisk'], ['dl-freshness', 'netdisk']])
    expect(body.tasks[1].whenBusy).toBe('skip')
  })

  // 存量撞名行：调度中心按「内置优先」丢掉它，它一次也不会跑。清单必须说出来——否则行主
  // 看到的是一条外表完全正常的任务，唯一的证据在一行他看不到的后端日志里。
  it('撞了内置 id 的用户行标 shadowed，且照常列出（不过滤——看不见的行删不掉）', async () => {
    const stale: UserTaskRow = { ...userRow, id: 'cookie-refresh', label: '我自己的刷新' }
    const { app } = mk({ store: mkStore([stale]) })
    const body = await (await app.request('/api/tasks')).json()
    const user = body.tasks.find((t: { source: string }) => t.source === 'user')
    expect(user.id).toBe('cookie-refresh')
    expect(user.shadowed).toBe(true)
  })

  // 判据必须是静态名单。`builtins()` 是本机此刻的条件装配结果，查询档下恒为空——用它判
  // 会把一条永远不跑的行报成"一切正常"，正是这个标要防的那种静默。
  it('builtins() 报空也照标 shadowed——静态名单是权威的', async () => {
    const stale: UserTaskRow = { ...userRow, id: 'standby-reaper' }
    const { app } = mk({
      builtins: () => [],
      store: mkStore([stale]),
    })
    const body = await (await app.request('/api/tasks')).json()
    expect(body.tasks[0].shadowed).toBe(true)
  })
})

describe('GET /api/tasks/:id/runs', () => {
  it('返回历次执行', async () => {
    const { app } = mk()
    const body = await (await app.request('/api/tasks/dl-freshness/runs')).json()
    expect(body.runs[0].summary).toBe('干完了')
  })

  it('limit 超上限被夹到 200，不让一次查把页面拖死', async () => {
    const runs = vi.fn().mockReturnValue([])
    const { app } = mk({ ledger: { runs, lastRun: () => undefined } })
    await app.request('/api/tasks/dl-freshness/runs?limit=99999')
    expect(runs).toHaveBeenCalledWith('dl-freshness', 200)
  })
})

describe('写路由', () => {
  it('POST 建一条并重排', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'new-one' }),
    })
    expect(res.status).toBe(200)
    expect(deps.apply).toHaveBeenCalled()
  })

  it('POST 冒名内置任务 id ⇒ 403，且没碰库', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'cookie-refresh' }),
    })
    expect(res.status).toBe(403)
    expect(deps.apply).not.toHaveBeenCalled()
    expect(deps.store.get('cookie-refresh')).toBeUndefined()
  })

  it('PUT 改 builtin ⇒ 403，且没碰库', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks/cookie-refresh', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(userRow),
    })
    expect(res.status).toBe(403)
    expect(deps.apply).not.toHaveBeenCalled()
    // 只查 apply 没调用，抓不住"先 upsert 再判 builtin 才 403"这种漏洞——那样 apply 确实不会被
    // 调，但 cookie-refresh 已经被当成一条 user 行写进库了。直接问库才是真的没碰库。
    expect(deps.store.get('cookie-refresh')).toBeUndefined()
  })

  it('冒名内置 id ⇒ 403，即便 builtins() 报空（查询档 taskDeps 未装配的形状）——静态名单是权威的', async () => {
    const { app, deps } = mk({ builtins: () => [] })
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'cookie-refresh' }),
    })
    expect(res.status).toBe(403)
    expect(deps.apply).not.toHaveBeenCalled()
    expect(deps.store.get('cookie-refresh')).toBeUndefined()
  })

  it('DELETE builtin ⇒ 403，且没碰库', async () => {
    const { app, deps } = mk()
    expect((await app.request('/api/tasks/cookie-refresh', { method: 'DELETE' })).status).toBe(403)
    expect(deps.unapply).not.toHaveBeenCalled()
    // remove 不是 mock，查不到调用记录；用"dl-freshness 还在库里"侧面证明 remove 没被
    // 错误地对别的 id 生效，同时 cookie-refresh 依旧没被当成 user 行创建。
    expect(deps.store.get('dl-freshness')).toBeDefined()
    expect(deps.store.get('cookie-refresh')).toBeUndefined()
  })

  // 存量撞名行的唯一出路。写路由 403、删也 403 的话，它既改不动又删不掉，只能让用户去翻
  // 数据库——而它本来就一次都不会执行。内置任务从不入库，所以「库里有」= 这是用户自己的行。
  it('DELETE 撞了内置 id 的存量用户行 ⇒ 删得掉（先查库再判内置）', async () => {
    const stale: UserTaskRow = { ...userRow, id: 'cookie-refresh' }
    const { app, deps } = mk({ store: mkStore([stale]) })
    expect((await app.request('/api/tasks/cookie-refresh', { method: 'DELETE' })).status).toBe(200)
    expect(deps.unapply).toHaveBeenCalledWith('cookie-refresh')
    expect(deps.store.get('cookie-refresh')).toBeUndefined()
  })

  it('DELETE user ⇒ 摘掉 cron 再删行', async () => {
    const { app, deps } = mk()
    expect((await app.request('/api/tasks/dl-freshness', { method: 'DELETE' })).status).toBe(200)
    expect(deps.unapply).toHaveBeenCalledWith('dl-freshness')
  })

  it('enabled=false 的行只入库不排期', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks/dl-freshness', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, enabled: false }),
    })
    expect(res.status).toBe(200)
    expect(deps.unapply).toHaveBeenCalledWith('dl-freshness')
    expect(deps.apply).not.toHaveBeenCalled()
    // 只查 unapply 调用抓不住"停用被实现成删除"这种错——那样 unapply 也会被调。
    // 直接问库：这一行必须还在，且落库的 enabled 确实是 false（不是老行侥幸没删掉）。
    const row = deps.store.get('dl-freshness')
    expect(row).toBeDefined()
    expect(row?.enabled).toBe(false)
  })

  it('body 缺 command ⇒ 400，不入库', async () => {
    const { app, deps } = mk()
    const { command: _c, ...bad } = userRow
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bad),
    })
    expect(res.status).toBe(400)
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('cron 段数不是 6 ⇒ 400（5 段是 crontab 习惯，这里要秒）', async () => {
    const { app } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'x', schedule: '45 9 * * 1-5' }),
    })
    expect(res.status).toBe(400)
  })

  it('maxAttempts 不是整数 ⇒ 400（1.5 不该一路走到引擎的重试配置里）', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'x', maxAttempts: 1.5 }),
    })
    expect(res.status).toBe(400)
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('group 存得下，前后空白削掉（分组是拿来当小标题的，两头空白看不见却分成两组）', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'g1', group: '  宏观  ' }),
    })
    expect(res.status).toBe(200)
    expect(deps.store.get('g1')!.group).toBe('宏观')
  })

  // 空串是编辑器里「不分组」发出来的东西。不归一化的话库里存下一个空字符串分组，
  // 任务页上就是一个没有名字的分组小标题。判据同 configRef 那格。
  it.each([['空串', ''], ['只有空白', '   '], ['不是字符串', 42], ['缺席', undefined]])(
    'group %s ⇒ 归一化成"没有分组"，不是存一个空分组',
    async (_why, group) => {
      const { app, deps } = mk()
      const body: Record<string, unknown> = { ...userRow, id: 'g2' }
      if (group === undefined) delete body.group
      else body.group = group
      const res = await app.request('/api/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      expect('group' in deps.store.get('g2')!).toBe(false)
    },
  )

  it('exclusiveOn 存得下，前后空白削掉（组名两头带空白就是两个组，而界面上看不出来）', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'x1', exclusiveOn: '  jq-bridge  ', whenBusy: 'skip' }),
    })
    expect(res.status).toBe(200)
    expect(deps.store.get('x1')!.exclusiveOn).toBe('jq-bridge')
    expect(deps.store.get('x1')!.whenBusy).toBe('skip')
  })

  it.each([['空串', ''], ['只有空白', '   '], ['不是字符串', 42], ['缺席', undefined]])(
    'exclusiveOn %s ⇒ 归一化成"不互斥"，不是存一个名字是空串的组（那会让队列名变成 x:）',
    async (_why, exclusiveOn) => {
      const { app, deps } = mk()
      const body: Record<string, unknown> = { ...userRow, id: 'x2' }
      if (exclusiveOn !== undefined) body.exclusiveOn = exclusiveOn
      const res = await app.request('/api/tasks', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status).toBe(200)
      expect('exclusiveOn' in deps.store.get('x2')!).toBe(false)
    },
  )

  // 放行一个非法值的后果是它落库、然后在 hydrate 那层被当成默认的"排着"——一条以为自己
  // 设了"迟到就别做"的任务其实一直在补跑，而没有任何一处会提。宁可 400。
  it.each(['SKIP', 'nope', 1, null])('whenBusy 非法值 %s ⇒ 400', async (whenBusy) => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'w1', whenBusy }),
    })
    expect(res.status).toBe(400)
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('whenBusy 缺席 ⇒ 不写这一格（默认就是排着）', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...userRow, id: 'w2' }),
    })
    expect(res.status).toBe(200)
    expect('whenBusy' in deps.store.get('w2')!).toBe(false)
  })

  it('POST /:id/run 立即跑一次；任务不存在 404', async () => {
    const { app } = mk({ runNow: vi.fn().mockResolvedValue(false) })
    expect((await app.request('/api/tasks/nope/run', { method: 'POST' })).status).toBe(404)
  })

})

/**
 * 执行体之二：一条用户任务可以指向包提供的动作。**东方财富那三条就是这么跑的**——它们不是
 * 特例，是这条通道的第一个用户（排期、启停、账号都在这一行和它绑的配置 row 里）。
 */
describe('动作型任务行', () => {
  const actionRow = {
    id: 'em-repo', label: '东财 撤单+逆回购', schedule: '0 55 14 * * 1-5',
    action: 'eastmoney:repo', args: [], serial: true, maxAttempts: 1,
    configRef: 'eastmoney', enabled: true,
  }

  it('建一条指向包动作的任务 ⇒ 落库并排期', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(actionRow),
    })
    expect(res.status).toBe(200)
    expect(deps.store.get('em-repo')).toMatchObject({ action: 'eastmoney:repo', configRef: 'eastmoney' })
    expect(deps.apply).toHaveBeenCalled()
  })

  // 打错一个字的表现是这条任务每轮红一次，而错误发生在几小时后的某轮调度里——当场拒最便宜。
  it('动作名不存在 ⇒ 400，并把可选项列出来', async () => {
    const { app, deps } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...actionRow, action: 'eastmoney:repoo' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('eastmoney:repo')
    expect(deps.apply).not.toHaveBeenCalled()
  })

  it('command 和 action 都给 ⇒ 400（说不清跑的是哪个）', async () => {
    const { app } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...actionRow, command: '/bin/true' }),
    })
    expect(res.status).toBe(400)
  })

  it('两个都不给 ⇒ 400（一条永远跑不起来的任务，不该能建出来）', async () => {
    const { app } = mk()
    const res = await app.request('/api/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...actionRow, action: undefined }),
    })
    expect(res.status).toBe(400)
  })

  // 编辑器要拿它画「执行什么」那个下拉。单开一条端点只是多一次往返。
  it('清单顺带回可选动作名', async () => {
    const { app } = mk()
    const body = await (await app.request('/api/tasks')).json()
    expect(body.actions).toEqual(['eastmoney:subscribe', 'eastmoney:repo'])
  })
})
