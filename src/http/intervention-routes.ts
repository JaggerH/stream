import type { Context, Hono } from 'hono'
import { dirname, join, basename } from 'node:path'
import { writeFileSync, renameSync } from 'node:fs'
import type { InterventionRunStore } from '../intervention/run-store.ts'
import type { RunStatus } from '../intervention/types.ts'
import type { RepairManager } from '../intervention/repair-manager.ts'
import type { ExploreManager } from '../intervention/explore-manager.ts'
import { DEFAULT_EXPLORE_LIMITS } from '../intervention/explore-session.ts'
import type { ExploreDraft } from '../intervention/explore-graph.ts'
import type { StateGraphStore } from '../replay/state-graph-store.ts'
import { localNameOf } from '../registry/source-id.ts'
import { assertStateIdPrefix, validateStateGraph, type StateGraph, type Transition } from '../replay/state-graph.ts'
import { validateRecipe } from '../replay/recipe-store.ts'
import type { Recipe } from '../replay/recipe.ts'
import { errText } from '../err-text.ts'
import { unknownKey, unknownKeyMessage } from './strict-input.ts'

/** accept 的 body 只认这一个键（API.md 第 2 条：写错键名要响亮的 400，不许静默丢弃）。加字段就加进来。 */
export const ACCEPT_BODY_KEYS = ['stateId'] as const
/** 答权限的 body 只认这一个键——同上一条纪律。 */
export const PERMISSION_BODY_KEYS = ['optionId'] as const
/** 插话的 body 只认这一个键。 */
export const MESSAGE_BODY_KEYS = ['text'] as const
/** 手动开一条探索的 body 只认这四个键。 */
export const EXPLORE_BODY_KEYS = ['facility', 'target', 'goal', 'limits'] as const
/** `limits` 里只认这两个数（第三闸 `maxWallMinutes` 随 `ai-agent` 行走，不从这儿开口子）。 */
export const EXPLORE_LIMIT_KEYS = ['maxStates', 'maxDepth'] as const

/**
 * 校验后原子写回 `path` 本身。**别按 `<dir>/<sourceId>.json` 另拼一个文件名**：引擎只装载
 * `*.recipe.json`，写到那儿等于新增一个没人读的文件，真正那份候选一字未动，而回执是 `applied:true`。
 * 同目录临时文件 + `renameSync`，与 `repair-ledger.ts` 的 `persist()` 同一套写法：半份文件
 * 不会被并发读者看到。localSourceId 从 `path` 的文件名取（`<local>.recipe.json`），
 * 只用于 `validateRecipe` 报错时点名，不参与校验逻辑。
 */
function writeRecipeAtomic(path: string, recipe: Recipe): void {
  const local = basename(path).replace(/\.recipe\.json$/, '')
  validateRecipe(local, recipe)
  const dir = dirname(path)
  const tmp = join(dir, `.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(tmp, JSON.stringify(recipe, null, 2) + '\n')
  renameSync(tmp, path)
}

export interface InterventionRoutesDeps {
  store: Pick<InterventionRunStore, 'list' | 'get' | 'events' | 'proposals' | 'getProposal' | 'setProposalStatus' | 'setAnswerStatusByProposal'>
  graphs: Pick<StateGraphStore, 'learned' | 'graphFor' | 'addLearnedState' | 'replaceLearnedState' | 'addLearnedTransition'>
  /** 修复会话的动作面（agent 档）。没接 = 这五个端点一律 503 `agent-unavailable`。 */
  repairs?: Pick<RepairManager, 'answerPermission' | 'continue' | 'cancel' | 'say' | 'resume'>
  /** 探索会话的动作面（agent 档）。没接 = 开探索那一口 503 `agent-unavailable`。 */
  explorations?: Pick<ExploreManager, 'start'>
  /** facility → 该包第一个源的 id（露面挂那一行）；不认识回 undefined。 */
  facilityOf?: (facility: string) => { sourceId: string } | undefined
  /** 默认校验后原子写回 `path` 本身（`writeRecipeAtomic`）；测试注入假写盘。 */
  writeRecipe?: (path: string, recipe: Recipe) => void
  now?: () => Date
}

/**
 * AI 介入的可见面（spec §6.6 / §9）。只读三口 + 审核两口。**接受是这条链路上唯一会改状态图的动作**，
 * 而且只改学到的那一层（`<dataDir>/state-graphs/`），不碰包目录——包自带的 `states.json` 归作者改。
 */
export function mountInterventionRoutes(app: Hono, deps: InterventionRoutesDeps): void {
  const now = deps.now ?? (() => new Date())

  app.get('/api/interventions', (c) => {
    const source = c.req.query('source') || undefined
    const status = c.req.query('status')?.split(',').filter(Boolean) as RunStatus[] | undefined
    const limit = Number(c.req.query('limit') ?? 100)
    const max = Number.isFinite(limit) ? limit : 100
    // 三本账里 run 的 `sourceId` 不统一：运行时一问（broker）记的是裸名 `foo-search`，修复 / 探索
    // 记的是全名 `@scope/pkg/foo-search`。前端修复页拿全名来问历史，裸名那份就整段消失
    // （活体 2026-09-12：xhs-search 的「AI 替你答了一问」在源健康页历史里一行都没有）。
    // 两个键都查、按 id 去重，和 `SourceHealthIndex.keysOf` 同一个口径。
    const keys = source ? [...new Set([source, localNameOf(source)])] : [undefined]
    const seen = new Set<string>()
    const runs = keys
      .flatMap((k) => deps.store.list({ ...(k ? { sourceId: k } : {}), ...(status?.length ? { status } : {}), limit: max }))
      .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
      .slice(0, max)
    // pending 是**全局**计数（不跟着上面的过滤走）：列表页那枚红点问的是「还有多少条等我审」，
    // 按当前筛选算会在切过滤器时变成 0，而实际还有一堆等着。
    return c.json({ runs, pending: deps.store.proposals({ status: 'pending' }).length })
  })

  app.get('/api/interventions/:id', (c) => {
    const run = deps.store.get(c.req.param('id'))
    if (!run) return c.json({ error: { code: 'not-found', message: `没有这条 run：${c.req.param('id')}` } }, 404)
    return c.json({ run, proposals: deps.store.proposals({ runId: run.id }) })
  })

  app.get('/api/interventions/:id/events', (c) => {
    const run = deps.store.get(c.req.param('id'))
    if (!run) return c.json({ error: { code: 'not-found', message: `没有这条 run：${c.req.param('id')}` } }, 404)
    const since = Number(c.req.query('since') ?? 0)
    return c.json({ events: deps.store.events(run.id, { since: Number.isFinite(since) ? since : 0 }) })
  })

  app.post('/api/interventions/proposals/:pid/accept', async (c) => {
    const p = deps.store.getProposal(c.req.param('pid'))
    if (!p) return c.json({ error: { code: 'not-found', message: `没有这条 proposal：${c.req.param('pid')}` } }, 404)
    if (p.status !== 'pending') return c.json({ error: { code: 'not-pending', message: `提议已是 ${p.status}` } }, 409)
    // 老路径没带 facility 时退回 sourceId——和 Broker 同一条退路，两边必须一致：
    // 一边按 facility 写、另一边按 sourceId 读，学到的那张图就永远找不到。
    const facility = p.facility ?? p.sourceId
    const body = (await c.req.json().catch(() => ({}))) as { stateId?: string }
    // 严格输入闸：agent / 脚本写错一个键名（`state_id`、`name`）会拿到 200 + 一份看起来完全正常的
    // 回执，而改名根本没发生——那正是 API.md 第 2 条要防的。
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const bad = unknownKey(Object.keys(body), ACCEPT_BODY_KEYS)
      if (bad) return c.json({ error: { code: 'validation_error', message: unknownKeyMessage('字段', bad, ACCEPT_BODY_KEYS) } }, 400)
    }
    const origin = { proposalId: p.id, acceptedAt: now().toISOString() }

    if (p.kind === 'state') {
      const stateId = body.stateId ?? p.stateId
      if (!stateId || !stateId.startsWith(`${facility}/`)) {
        return c.json({ error: { code: 'bad-state-id', message: `stateId 必须是 ${facility}/<状态> 形状` } }, 400)
      }
      // **先查再写**：撞车在合成图上就看得见，所以查完再写，不用写完再回滚——回滚是另一次写，
      // 它自己也会失败，而失败在这条路上意味着学到的那一层留着一条没人认领的状态。
      let merged: StateGraph | undefined
      try {
        merged = deps.graphs.graphFor(facility)
      } catch (e) {
        // 合成本身就炸 = 学到的那一层和包自带早就撞了（别的提议接受时包还没这个名字）。
        // 这次接受不是元凶，但也确实写不进去，如实说。
        return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
      }
      if (merged?.states.some((s) => s.id === stateId)) {
        const inLearned = deps.graphs.learned(facility)?.states.some((s) => s.id === stateId) ?? false
        return c.json({
          error: inLearned
            ? { code: 'learned-rejected', message: `学到的那一层里已经有 ${stateId} 了` }
            : { code: 'clashes-with-authored', message: `${stateId} 是包自带 states.json 里的状态，换个名字` },
        }, 409)
      }
      try {
        const learned = deps.graphs.addLearnedState(facility, { id: stateId, features: p.features ?? [], note: p.rationale }, origin)
        deps.store.setProposalStatus(p.id, 'accepted')
        // 缓存里那条答案也得跟着变 accepted（同 reject 分支那条教训）：不跟的话同指纹再落空时
        // 缓存还报「有一条待审提议」——人刚接受掉的那一条，状态图明明已经吃了这个答案。
        deps.store.setAnswerStatusByProposal(p.id, 'accepted')
        return c.json({ proposal: deps.store.getProposal(p.id), learned, applied: true })
      } catch (e) {
        // 写被校验挡下来（特征为空、id 不合法…）：提议保持 pending，人改了名字还能再来一次。
        return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
      }
    }

    if (p.kind === 'discriminator') {
      const stateId = body.stateId
      if (!stateId) return c.json({ error: { code: 'need-state-id', message: '要把区分特征追加到哪个状态？body.stateId 必填' } }, 400)
      const target = deps.graphs.learned(facility)?.states.find((s) => s.id === stateId)
      if (!target) {
        // 只允许改学到的那一层。包自带的要改就去改源文件，别让本机悄悄分叉出一份和包不一样的定义。
        // `graphFor` 在两层 id 撞车时会抛（`state` 分支已经为此 try/catch 了）——这里不兜住就是
        // 一次无结构 500，而实际含义和 `state` 分支那次一模一样：学到的这一层已经写不进去了。
        let inAuthored: boolean
        try {
          inAuthored = deps.graphs.graphFor(facility)?.states.some((s) => s.id === stateId) ?? false
        } catch (e) {
          return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
        }
        return c.json({
          error: {
            code: inAuthored ? 'cannot-edit-authored' : 'unknown-state',
            message: inAuthored ? `${stateId} 在包自带的 states.json 里，请改源文件` : `没有这个状态：${stateId}`,
          },
        }, inAuthored ? 409 : 404)
      }
      let learned: StateGraph
      try {
        learned = deps.graphs.replaceLearnedState(facility, { ...target, features: [...target.features, ...(p.features ?? [])] })
      } catch (e) {
        // 与 `state` 分支同一类情形：包升级后 states.json 新增了和学到层同 id 的状态，
        // `target` 还能在学到层里查到、但写回时 `put()` 的合成校验会撞车拒绝——如实报，提议保持 pending。
        return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
      }
      deps.store.setProposalStatus(p.id, 'accepted')
      deps.store.setAnswerStatusByProposal(p.id, 'accepted')
      return c.json({ proposal: deps.store.getProposal(p.id), learned, applied: true })
    }

    if (p.kind === 'graph') {
      const draft = p.draft as ExploreDraft | undefined
      if (!draft || !Array.isArray(draft.states)) {
        return c.json({ error: { code: 'no-draft', message: '这条提议没有草稿图，接受不了' } }, 409)
      }
      // `noop` 边（点了什么都没变）草稿里本来就不落；真落了也不该进图——它不是一条路。
      // `effect` / `via` 是探索期的脚手架（怎么判、点的是谁），状态图只吃 `from/to/steps`。
      const transitions: Transition[] = (draft.transitions ?? [])
        .filter((t) => t.effect !== 'noop')
        .map((t) => ({ from: t.from, ...(t.to !== undefined ? { to: t.to } : {}), steps: t.steps }))
      let merged: StateGraph | undefined
      try {
        merged = deps.graphs.graphFor(facility)
      } catch (e) {
        return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
      }
      // **先把全部校验做完再写**：学到的那一层没有删接口，写到一半失败就留下一张半张的图，
      // 而回滚本身是另一次会失败的写。一条都不写，人改完名字还能整份重来。
      // **这个「整份不写」只在校验这一维成立**：落盘是逐条 `addLearnedState` / `addLearnedTransition`，
      // 每条各自一次 rename。进程在中途死掉（或盘写满）照样会留下半张图——校验挡的是「能不能写」，
      // 挡不了「写到一半机器没了」。要那一维的原子性得让 store 收一个批量写口，今天没有。
      const existing = new Set((merged?.states ?? []).map((s) => s.id))
      const clash = draft.states.find((s) => existing.has(s.id))
      if (clash) {
        return c.json({ error: { code: 'learned-rejected', message: `${clash.id} 已经在这个 facility 的图里了（包自带或之前学到的），整份草稿都没写进去` } }, 409)
      }
      try {
        for (const s of draft.states) assertStateIdPrefix(facility, s.id)
        validateStateGraph({
          states: [...(merged?.states ?? []), ...draft.states],
          transitions: [...(merged?.transitions ?? []), ...transitions],
        })
      } catch (e) {
        return c.json({ error: { code: 'learned-rejected', message: errText(e) } }, 409)
      }
      for (const s of draft.states) deps.graphs.addLearnedState(facility, s, origin)
      for (const t of transitions) deps.graphs.addLearnedTransition(facility, t)
      deps.store.setProposalStatus(p.id, 'accepted')
      return c.json({ proposal: deps.store.getProposal(p.id), applied: true, states: draft.states.length, transitions: transitions.length })
    }

    if (p.kind === 'recipe') {
      if (!p.recipe || !p.recipePath) return c.json({ error: { code: 'no-recipe-body', message: '这条提议没有候选 recipe 体，接受不了' } }, 409)
      const write = deps.writeRecipe ?? writeRecipeAtomic
      const path = p.recipePath
      try {
        write(path, p.recipe as Recipe)
      } catch (e) {
        // 没写成就别标接受：状态与磁盘对不上时，人会以为已经落地、隔离却永远解不开。
        return c.json({ error: { code: 'write-failed', message: `写回 recipe 失败：${errText(e)}` } }, 409)
      }
      deps.store.setProposalStatus(p.id, 'accepted')
      return c.json({ proposal: deps.store.getProposal(p.id), applied: true, path })
    }

    // transition / locator：**尚未落地到 recipe**（要改 steps，今天没有这条路）；只记「人认可了」。
    // `applied:false` 是如实说，不许补成 true——否则界面会显示"已生效"而实际什么都没改。
    deps.store.setProposalStatus(p.id, 'accepted')
    deps.store.setAnswerStatusByProposal(p.id, 'accepted')
    return c.json({ proposal: deps.store.getProposal(p.id), applied: false, note: 'transition / locator 提议只记录，尚未落地到 recipe' })
  })

  app.post('/api/interventions/proposals/:pid/reject', (c) => {
    const p = deps.store.getProposal(c.req.param('pid'))
    if (!p) return c.json({ error: { code: 'not-found', message: `没有这条 proposal：${c.req.param('pid')}` } }, 404)
    if (p.status !== 'pending') return c.json({ error: { code: 'not-pending', message: `提议已是 ${p.status}` } }, 409)
    deps.store.setProposalStatus(p.id, 'rejected-by-user')
    // 缓存里那条答案也得跟着拒（spec §4.3）。不跟的话同指纹再落空时缓存照旧命中，报的还是
    // 「有一条待审提议」——人刚拒掉的那一条，而拒绝这个动作等于白做。
    deps.store.setAnswerStatusByProposal(p.id, 'rejected-by-user')
    return c.json({ proposal: deps.store.getProposal(p.id) })
  })

  // 修复会话的五个动作端点（agent 档）。没挂 repairs（没配 ai-agent，或宿主没接线）→ 一律 503。
  const needRepairs = (c: Context) => c.json({ error: { code: 'agent-unavailable', message: 'agent 档没挂（介入域缺 repairs）' } }, 503)
  const codeOf: Record<string, 404 | 409> = { 'not-found': 404, 'no-such-permission': 409, 'not-paused': 409, 'not-resumable': 409, busy: 409 }
  /**
   * 人话。**code 原样保留**：前端「继续」那颗按钮按 `e.message.includes('not-found')` 判，
   * 而 `jsonOrThrow` 把整个 body 文本塞进 message——`code` 字段本身就含 `not-found`，
   * 所以只要不动 code，加人话不会打断它。加一个回执码就加一行；漏了只退化成回码本身。
   */
  const messageOf: Record<string, string> = {
    'not-found': '这条 run 不在内存里（后端重启过、或它已经收尾）——试试「恢复」',
    'no-such-permission': '没有这条权限请求：它可能已经被答过，或这条 run 已经收尾了',
    'not-paused': '这条修复会话现在不是 paused，没有闸可抬',
    'not-resumable': '这条修复会话续不了：要 paused、要有 agent 会话句柄、还要配着 ai-agent',
    busy: '这条修复会话正忙（已经有一个实例在跑），稍后再试',
  }
  const reply = (c: Context, r: string) => (r === 'ok' ? c.json({ ok: true }) : c.json({ error: { code: r, message: messageOf[r] ?? r } }, codeOf[r] ?? 409))

  /**
   * 手动开一条探索（spec 2026-09-12-explore §8）。**一 facility 一条**，撞了回 409 让人自己决定
   * 要不要先取消那条——不排队：探索骑的是人正在用的那张标签页，排队等于过一会儿突然自己动起来。
   */
  app.post('/api/interventions/explorations', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const bad = unknownKey(Object.keys(body), EXPLORE_BODY_KEYS)
    if (bad) return c.json({ error: { code: 'unknown-key', message: unknownKeyMessage('字段', bad, EXPLORE_BODY_KEYS) } }, 400)
    const facility = typeof body.facility === 'string' ? body.facility.trim() : ''
    const target = typeof body.target === 'string' ? body.target.trim() : ''
    const goal = typeof body.goal === 'string' ? body.goal.trim() : ''
    if (!facility || !target || !goal) return c.json({ error: { code: 'need-fields', message: 'body 要带 facility / target / goal' } }, 400)
    // 本期只探网页面。`facility:<name>` 是采集正骑着的那一页——放行等于让 agent 去抢它。
    if (!/^chrome:\d+$/.test(target)) return c.json({ error: { code: 'bad-target', message: '本期只探网页面：target 要是 chrome:<tabId>（用 cdp_pages 拿）' } }, 400)
    if (!deps.explorations || !deps.facilityOf) return needRepairs(c)
    const f = deps.facilityOf(facility)
    if (!f) return c.json({ error: { code: 'unknown-facility', message: `不认识 facility ${facility}（装了的 recipe 包里没有它）` } }, 400)
    const lim = (body.limits ?? {}) as Record<string, unknown>
    if (typeof lim !== 'object' || lim === null || Array.isArray(lim)) {
      return c.json({ error: { code: 'bad-limits', message: 'limits 要是个对象' } }, 400)
    }
    const badLimitKey = unknownKey(Object.keys(lim), EXPLORE_LIMIT_KEYS)
    if (badLimitKey) return c.json({ error: { code: 'unknown-key', message: `limits 里${unknownKeyMessage('字段', badLimitKey, EXPLORE_LIMIT_KEYS)}` } }, 400)
    // **正整数，不是「是个数」**：`0` 会让探索一步都不走却报成功，`2.5` / `-1` 一路传到三闸里
    // 变成一个永远比不过的阈值——两种都不报错，只是那一轮什么都没探出来。
    for (const k of EXPLORE_LIMIT_KEYS) {
      const v = lim[k]
      if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v > 0)) {
        return c.json({ error: { code: 'bad-limits', message: `limits.${k} 要是正整数，拿到的是 ${JSON.stringify(v)}` } }, 400)
      }
    }
    const r = deps.explorations.start({
      facility, sourceId: f.sourceId, target, goal,
      limits: {
        maxStates: typeof lim.maxStates === 'number' ? lim.maxStates : DEFAULT_EXPLORE_LIMITS.maxStates,
        maxDepth: typeof lim.maxDepth === 'number' ? lim.maxDepth : DEFAULT_EXPLORE_LIMITS.maxDepth,
      },
    })
    if (r === 'unconfigured') return c.json({ error: { code: 'agent-unavailable', message: '还没配 ai-agent（运维页「AI 介入」那一行）' } }, 503)
    if (r === 'busy') return c.json({ error: { code: 'explore-busy', message: `${facility} 已有一条探索在跑，先看那条或取消它` } }, 409)
    // 驾驭面取不到（agent 域没起 / 扩展没连）。**和「没配 ai-agent」分开说**：两种都让人去
    // 运维页，但要修的东西完全不同——配置行是填字，这一档是把扩展连上。
    if (r === 'surface-unavailable') {
      return c.json({ error: { code: 'agent-unavailable', message: '浏览器驾驭面不可用（agent 域没起 / 扩展没连）——先确认扩展连着，再用 cdp_pages 拿一个 tabId' } }, 503)
    }
    return c.json({ runId: r.runId }, 201)
  })

  app.post('/api/interventions/:id/permissions/:permId', async (c) => {
    if (!deps.repairs) return needRepairs(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const bad = unknownKey(Object.keys(body), PERMISSION_BODY_KEYS)
    if (bad) return c.json({ error: { code: 'unknown-key', message: unknownKeyMessage('字段', bad, PERMISSION_BODY_KEYS) } }, 400)
    if (typeof body.optionId !== 'string' || !body.optionId) return c.json({ error: { code: 'need-option-id', message: 'body 要带 optionId' } }, 400)
    return reply(c, deps.repairs.answerPermission(c.req.param('id'), c.req.param('permId'), body.optionId))
  })
  app.post('/api/interventions/:id/continue', (c) => (deps.repairs ? reply(c, deps.repairs.continue(c.req.param('id'))) : needRepairs(c)))
  app.post('/api/interventions/:id/cancel', async (c) => (deps.repairs ? reply(c, await deps.repairs.cancel(c.req.param('id'))) : needRepairs(c)))
  app.post('/api/interventions/:id/messages', async (c) => {
    if (!deps.repairs) return needRepairs(c)
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    const bad = unknownKey(Object.keys(body), MESSAGE_BODY_KEYS)
    if (bad) return c.json({ error: { code: 'unknown-key', message: unknownKeyMessage('字段', bad, MESSAGE_BODY_KEYS) } }, 400)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: { code: 'empty-text', message: 'text 不能为空' } }, 400)
    return reply(c, deps.repairs.say(c.req.param('id'), text))
  })
  app.post('/api/interventions/:id/resume', (c) => (deps.repairs ? reply(c, deps.repairs.resume(c.req.param('id'))) : needRepairs(c)))
}
