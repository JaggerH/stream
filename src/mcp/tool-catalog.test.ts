// src/mcp/tool-catalog.test.ts
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { toolCatalog, type McpExtras } from './tool-catalog.ts'
import type { StreamService } from './tools.ts'

const fakeService = {} as StreamService
/** `isCommunitySource` 是 McpExtras 上唯一的必填格（搜索分档谓词，见 tool-catalog.ts 头注）。
 *  这里的用例没有一条碰 content_search / price_search 的排序，统一给一个恒 false 的。 */
const catalog = (extras: Omit<McpExtras, 'isCommunitySource'>) =>
  toolCatalog(fakeService, { isCommunitySource: () => false, ...extras })

// 通用网页搜索。它和 search_agent 是两件事：后者是**网盘资源获取**（夸克优先、返回获取目标），
// 拿它找一个 GitHub 仓库是用错工具。这条测试存在的理由是一次真实事故：用户问「github 地址」，
// 助手的推理写着「我现有的工具中没有直接搜索 GitHub 项目的功能」——而这个能力就在栈里，
// 只是没有任何一个工具的名字或描述提过它。
describe('toolCatalog — web_search', () => {
  const hits = Array.from({ length: 25 }, (_, i) => ({
    title: `hit ${i}`,
    url: `https://example.com/${i}`,
    snippet: `s${i}`,
  }))

  it('webSearch extra 在场才暴露 web_search', () => {
    expect(catalog({}).map((t) => t.name)).not.toContain('web_search')
    expect(catalog({ webSearch: async () => ({ hits: [] }) }).map((t) => t.name)).toContain('web_search')
  })

  it('把 query 透传下去，并**截断**结果——一次网页搜索的原始产出能有几万字，整份灌进对话就是撑爆上下文', async () => {
    const seen: string[] = []
    const tool = catalog({
      webSearch: async (q) => (seen.push(q), { hits }),
    }).find((t) => t.name === 'web_search')!

    const out = (await tool.run({ query: 'Product Manager Skills github' })) as { hits: unknown[]; note?: string }

    expect(seen).toEqual(['Product Manager Skills github'])
    expect(out.hits.length).toBe(10)
    expect(out.hits[0]).toEqual({ title: 'hit 0', url: 'https://example.com/0', snippet: 's0' })
    expect(out.note).toBeUndefined()
  })

  // 「这次有引擎没应答」必须走到模型面前：0 条结果 + note 才分得清「不存在」和「没查成」。
  // 抛错会让每次真·搜不到都变成工具 error（实测一轮 22 条），所以这一格必须是软信号。
  it('note 原样带到工具结果里——空结果时它是唯一能说明「没查成」的东西', async () => {
    const tool = catalog({
      webSearch: async () => ({ hits: [], note: '本次搜索有引擎没有应答——brave: CAPTCHA' }),
    }).find((t) => t.name === 'web_search')!

    const out = (await tool.run({ query: 'x' })) as { hits: unknown[]; note?: string }

    expect(out.hits).toEqual([])
    expect(out.note).toContain('brave')
  })
})

// 「搜到了却读不了」是同一个缺口的另一半：web_search 给回一串 URL，而在这条工具之前，全站
// 没有任何工具能把一个普通网页读成文字（stream_fetch_url 是**媒体**导向的，对 github 这类页面
// 返回 {platform:'unknown', media:[]} 的空成功）。实测助手因此对同一个 URL 连打三次
// stream_fetch_url，每次拿回空、每次不知道为什么，最后步数用尽、答案没给出来。
describe('toolCatalog — read_url', () => {
  it('readUrl extra 在场才暴露 read_url', () => {
    expect(catalog({}).map((t) => t.name)).not.toContain('read_url')
    expect(catalog({ readUrl: async () => ({ text: 'x' }) }).map((t) => t.name)).toContain('read_url')
  })

  it('截断超长正文，并明说被截了——半篇文章被无声吃掉比说清楚更糟', async () => {
    const long = 'a'.repeat(30_000)
    const tool = catalog({ readUrl: async () => ({ text: long }) }).find((t) => t.name === 'read_url')!
    const out = (await tool.run({ url: 'https://example.com/a' })) as { text: string; truncated?: boolean; chars?: number }
    expect(out.text.length).toBeLessThan(long.length)
    expect(out.truncated).toBe(true)
    expect(out.chars).toBe(30_000)
  })

  it('抓不到正文时说「抓不到」，不返回一段空文本冒充成功', async () => {
    const tool = catalog({ readUrl: async () => ({ text: '' }) }).find((t) => t.name === 'read_url')!
    const out = (await tool.run({ url: 'https://example.com/a' })) as { error?: string }
    expect(out.error).toBeTruthy()
  })
})

describe('toolCatalog — search agent tools', () => {
  it('exposes search_agent + get_agent_run when searchAgent extra is present', async () => {
    const started: string[] = []
    const extras: Omit<McpExtras, 'isCommunitySource'> = {
      searchAgent: {
        start: (goal) => {
          started.push(goal)
          return { runId: 'r1', status: 'queued' }
        },
        get: (runId) => ({ runId, status: 'done', trajectory: [] }),
      },
    }
    const names = catalog(extras).map((t) => t.name)
    expect(names).toContain('search_agent')
    expect(names).toContain('get_agent_run')

    const start = catalog(extras).find((t) => t.name === 'search_agent')!
    expect(await start.run({ goal: '怡楽播客' })).toEqual({ runId: 'r1', status: 'queued' })
    expect(started).toEqual(['怡楽播客'])

    const get = catalog(extras).find((t) => t.name === 'get_agent_run')!
    expect(await get.run({ runId: 'r1' })).toMatchObject({ runId: 'r1', status: 'done' })
  })

  // action 档（run_action_recipe 的异步壳）：两层状态分开——run 的 status 是跑没跑完，
  // `result.status` 才是动作成没成；error 那一档必须把"动作可能已做了一部分"说出来，
  // 否则模型会把"后端重启"读成"没发出去"然后再发一条。
  it('get_agent_run 对 domain:"action" 的 run 投影 sourceId / result / error 提示', async () => {
    const rows: Record<string, unknown> = {
      done: { runId: 'a1', domain: 'action', goal: 'action:qq-send', status: 'done', trajectory: [], updatedAt: new Date().toISOString(),
        result: { status: 'blocked', sourceId: 'qq-send', reason: '没确认' } },
      err: { runId: 'a2', domain: 'action', goal: 'action:qq-send', status: 'error', trajectory: [], updatedAt: new Date().toISOString(),
        error: '中断（服务重启）' },
      live: { runId: 'a3', domain: 'action', goal: 'action:qq-send', status: 'running', trajectory: [], updatedAt: new Date().toISOString() },
    }
    const extras: Omit<McpExtras, 'isCommunitySource'> = { searchAgent: { start: () => ({}), get: (runId) => rows[runId] ?? null } }
    const get = catalog(extras).find((t) => t.name === 'get_agent_run')!
    const done = (await get.run({ runId: 'done' })) as Record<string, unknown>
    expect(done).toMatchObject({ domain: 'action', status: 'done', sourceId: 'qq-send', result: { status: 'blocked' } })
    expect(done.error).toBeUndefined()
    // 跑完的 run 不报 elapsedSec：updatedAt 是结束时刻，报出来的是"结束多久了"，会一直涨。
    expect(done.elapsedSec).toBeUndefined()
    const err = (await get.run({ runId: 'err' })) as Record<string, unknown>
    expect(err).toMatchObject({ domain: 'action', status: 'error', error: '中断（服务重启）' })
    expect(String(err.note)).toMatch(/可能已经做了一部分/)
    expect(err.result).toBeUndefined()
    const live = (await get.run({ runId: 'live' })) as Record<string, unknown>
    expect(live).toMatchObject({ domain: 'action', status: 'running', sourceId: 'qq-send', elapsedSec: 0 })
    expect(String(live.note)).toMatch(/别去重新调 run_action_recipe/)
  })

  // extract 工具面上唯二的参数都不是分支选择：diarize 是转写分支上的一档额外处理，rerun 是
  // 缓存旁路。rerun 缺席过一轮的后果不是报错而是「静默什么都没发生」——缓存只按 item 认，
  // 拨开识别发言人再取一次会原样退回没有说话人的旧记录。
  it('extract 把 diarize / rerun 一起透传给 extras.extract', () => {
    const calls: Array<[string, unknown]> = []
    const extras: Omit<McpExtras, 'isCommunitySource'> = { extract: (itemId, o) => (calls.push([itemId, o]), { status: 'running' }) }
    const tool = catalog(extras).find((t) => t.name === 'extract')!
    tool.run({ item: 'i1' })
    tool.run({ item: 'i1', diarize: true, rerun: true })
    expect(calls[0]).toEqual(['i1', { diarize: undefined, rerun: undefined }])
    expect(calls[1]).toEqual(['i1', { diarize: true, rerun: true }])
  })

  // focus 是窄回执的压缩镜头,必须原样递给 extras.extract——否则模型填了也白填。
  // schema 里**不许有 full**:那个开关曾开给模型,活体第一轮就被滥用(读什么都带 full:true),
  // 结构性收回(spec 2026-08-24-digest-authority)。这条钉的就是"别再把它加回来"。
  it('extract 透传 focus;schema 里没有 full 开关', () => {
    const calls: Array<[string, unknown]> = []
    const extras: Omit<McpExtras, 'isCommunitySource'> = { extract: (itemId, o) => (calls.push([itemId, o]), { status: 'running' }) }
    const tool = catalog(extras).find((t) => t.name === 'extract')!
    tool.run({ item: 'i1', focus: '找型号' })
    expect(calls[0]).toEqual(['i1', { diarize: undefined, rerun: undefined, focus: '找型号' }])
    expect(Object.keys(tool.schema)).not.toContain('full')
  })

  it('omits both tools when the extra is absent', () => {
    const names = catalog({}).map((t) => t.name)
    expect(names).not.toContain('search_agent')
    expect(names).not.toContain('get_agent_run')
  })

  it('exposes get_events when the events extra is present, absent otherwise', async () => {
    const extras: Omit<McpExtras, 'isCommunitySource'> = {
      events: {
        list: (opts) => [{ id: 3, type: 'transcribe.done', title: 'T', at: 1, severity: 'info', opts }],
      },
    }
    const withIt = catalog(extras).map((t) => t.name)
    expect(withIt).toContain('get_events')
    expect(catalog({}).map((t) => t.name)).not.toContain('get_events')
    const tool = catalog(extras).find((t) => t.name === 'get_events')!
    const out = (await tool.run({ since: 2, types: 'transcribe.done,auth.needed' })) as any[]
    expect(out[0].opts).toEqual({ since: 2, types: ['transcribe.done', 'auth.needed'] })
  })

  it('exposes list_person_appearances when the appearances extra is present, absent otherwise', async () => {
    const calls: Array<[string, number | undefined]> = []
    const extras: Omit<McpExtras, 'isCommunitySource'> = {
      appearances: {
        query: (person, minSeconds) => {
          calls.push([person, minSeconds])
          return [{ itemId: 'ep1', title: 'E1', source: 's', seconds: 90, segments: 3, firstAt: 0, nameAtTime: '庞博' }]
        },
      },
    }
    expect(catalog({}).map((t) => t.name)).not.toContain('list_person_appearances')
    const tool = catalog(extras).find((t) => t.name === 'list_person_appearances')!
    const out = (await tool.run({ person: '庞博', minSeconds: 60 })) as any[]
    expect(out[0]).toMatchObject({ itemId: 'ep1', seconds: 90, nameAtTime: '庞博' })
    expect(calls).toEqual([['庞博', 60]])
  })
})

describe('toolCatalog — intent tools', () => {
  // intent_dossier is deliberately NOT covered here — it's bespoke in server.ts (returns raw
  // markdown, not a JSON envelope), so its protocol-level behavior is tested there over a real
  // MCP client (see server.test.ts). This catalog only owns intent_create/intent_list.
  it('exposes intent_create/intent_list when intents extra is present', async () => {
    const created: string[] = []
    const fakeIntents = {
      create: async (input: { goal: string }) => {
        created.push(input.goal)
        return { id: 'i1', goal: input.goal, criteria: '相关判据', streamIds: [], cadenceHours: 24, status: 'active', createdAt: 1 }
      },
      list: () => [{ id: 'i1', goal: 'x', criteria: 'c', streamIds: [], cadenceHours: 24, status: 'active', createdAt: 1, ledgerCount: 3 }],
      dossier: (id: string) => (id === 'i1' ? '# 意图档案\n...' : null),
    } as unknown as import('../intent/service.ts').IntentService
    const extras: Omit<McpExtras, 'isCommunitySource'> = { intents: fakeIntents }
    const names = catalog(extras).map((t) => t.name)
    expect(names).toContain('intent_create')
    expect(names).toContain('intent_list')
    expect(names).not.toContain('intent_dossier')

    const create = catalog(extras).find((t) => t.name === 'intent_create')!
    expect(await create.run({ goal: '追某播客' })).toMatchObject({ id: 'i1', goal: '追某播客', criteria: '相关判据' })
    expect(created).toEqual(['追某播客'])

    const list = catalog(extras).find((t) => t.name === 'intent_list')!
    expect(await list.run({})).toMatchObject([{ id: 'i1', ledgerCount: 3 }])
  })

  it('omits intent tools when the extra is absent', () => {
    const names = catalog({}).map((t) => t.name)
    expect(names).not.toContain('intent_create')
    expect(names).not.toContain('intent_list')
    expect(names).not.toContain('intent_dossier')
  })
})

describe('purchase_decide — 购买线在工具面上唯一的入口', () => {
  it('旧的「素材 + 手工组装终稿」那一对不再注册——留着它们模型就会把回执手抄一遍', () => {
    const names = catalog({ purchaseDecide: () => ({ runId: 'r', status: 'queued' }) }).map((t) => t.name)
    expect(names).toContain('purchase_decide')
    expect(names).not.toContain('purchase_brief')
    expect(names).not.toContain('purchase_verdict')
  })

  it('只给品类也能跑：其余格子有默认值，**不许为了填表去问用户**', async () => {
    const seen: unknown[] = []
    const extras: Omit<McpExtras, 'isCommunitySource'> = {
      purchaseDecide: (c) => {
        seen.push(c)
        return { runId: 'run-1', status: 'queued' }
      },
    }
    const tool = catalog(extras).find((t) => t.name === 'purchase_decide')!
    // schema 层:缺 softCriteria/holdDays/willResell 也过
    expect(z.object(tool.schema).safeParse({ category: ['手机'] }).success).toBe(true)
    // run 层:不经 zod 直调也要有同样的默认(调用方不止一条路径)；**回的是 runId 不是回执**——
    // 同步等一次两三分钟的跑会撞宿主的单次调用上限(Claude Code 约 120s)。
    expect(await tool.run({ category: ['手机'], priceMax: 5000 })).toEqual({ runId: 'run-1', status: 'queued' })
    expect(tool.description).toMatch(/ASYNC/)
    expect(tool.description).toMatch(/get_agent_run/)
    expect(seen[0]).toEqual({
      category: ['手机'],
      priceRange: { min: undefined, max: 5000 },
      softCriteria: [],
      holdDays: 730,
      willResell: false,
    })
    expect(tool.description).toMatch(/CALL IT IMMEDIATELY/)
    expect(tool.description).toMatch(/Do NOT interview/)
  })
})

describe('toolCatalog — read_content 的结构性 digest 收口', () => {
  const LONG = 'A'.repeat(4100)
  // read_content 只需要 conversions.list;digestLongText 用假件替代真压缩器。
  const convOf = (text: string) =>
    ({
      list: ({ kind }: { kind?: string }) => ({
        items: kind === 'extract'
          ? [{ id: 'cv1', kind: 'extract', itemId: 'i1', status: 'done', createdAt: 'now', updatedAt: '', result: { text } }]
          : [],
      }),
    }) as unknown as NonNullable<McpExtras['conversions']>

  it('长正文默认经 digestLongText 压缩,回执带 digested/full_text_chars/next_step', async () => {
    const calls: string[] = []
    const tool = catalog({
      conversions: convOf(LONG),
      digestLongText: async (itemId, text) => {
        calls.push(itemId)
        return { status: 'done', result: { text: '- 要点「引」', digested: true, full_text_chars: (text as string).length } }
      },
    }).find((t) => t.name === 'read_content')!
    const out = (await tool.run({ itemId: 'i1' })) as Record<string, unknown>
    expect(out.text).toBe('- 要点「引」')
    expect(out.digested).toBe(true)
    expect(out.full_text_chars).toBe(LONG.length)
    expect(String(out.next_step)).toContain('get_conversions')
    expect(calls).toEqual(['i1'])
  })

  it('schema 里没有 full 开关(结构性收回,别加回来);短文压缩器原样退回也不改回执', async () => {
    const tool = catalog({
      conversions: convOf(LONG),
      digestLongText: async (_id, text) => ({ status: 'done', result: { text } }), // 未 digested = 原样
    }).find((t) => t.name === 'read_content')!
    expect(Object.keys(tool.schema)).not.toContain('full')
    const passthrough = (await tool.run({ itemId: 'i1' })) as Record<string, unknown>
    expect(passthrough.text).toBe(LONG)
    expect(passthrough.digested).toBeUndefined()
  })
})

// 追更 / 同步 / 撤销这四个工具的**注册门**。「没有落点就不装这个工具」——装一个必然报错的
// 动词比没有它更坏：模型会一直重试，而"工具不存在"和"模型不想用它"长得一模一样。
describe('toolCatalog — netdisk 追更那一组的注册门', () => {
  const core = {
    bindings: () => [],
    browse: async () => ({}),
    residue: async () => ({}),
    previewSpec: async () => ({}),
    applySpec: async () => ({}),
    reconcileStatus: async () => ({}),
    reconcileDecide: () => ({}),
    reconcileExecute: async () => ({}),
    reconcileUndoRun: async () => ({}),
    sync: async () => ({}),
  } as NonNullable<McpExtras['netdisk']>

  const names = (netdisk?: NonNullable<McpExtras['netdisk']>) =>
    catalog(netdisk ? { netdisk } : {}).map((t) => t.name)

  it('网盘整体没装配 → 四个都不在', () => {
    for (const n of ['netdisk_share_verify', 'netdisk_follow', 'netdisk_sync', 'reconcile_undo_run']) {
      expect(names()).not.toContain(n)
    }
  })

  it('网盘装配了 → netdisk_sync / reconcile_undo_run 在；追更没装配 → 那两个不在', () => {
    const got = names(core)
    expect(got).toContain('netdisk_sync')
    expect(got).toContain('reconcile_undo_run')
    expect(got).not.toContain('netdisk_share_verify')
    expect(got).not.toContain('netdisk_follow')
  })

  it('追更装配了 → netdisk_share_verify / netdisk_follow 才出现', () => {
    const got = names({ ...core, shareVerify: async () => ({}), follow: async () => ({}) })
    expect(got).toContain('netdisk_share_verify')
    expect(got).toContain('netdisk_follow')
  })

  it('参数透传：link 与 netdisk+pwdId 两种写法都原样递下去', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, shareVerify: async (a) => (seen.push(a), {}) },
    }).find((t) => t.name === 'netdisk_share_verify')!
    await tool.run({ link: 'https://pan.quark.cn/s/abc' })
    await tool.run({ netdisk: 'quark', pwdId: 'abc', passcode: '1234' })
    expect(seen).toEqual([
      { link: 'https://pan.quark.cn/s/abc', netdisk: undefined, pwdId: undefined, passcode: undefined },
      { link: undefined, netdisk: 'quark', pwdId: 'abc', passcode: '1234' },
    ])
  })

  it('netdisk_follow 的 action 是闭集，且 setId + action 原样递下去', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, follow: async (setId, action) => (seen.push([setId, action]), {}) },
    }).find((t) => t.name === 'netdisk_follow')!
    await tool.run({ setId: 's1', action: 'run' })
    expect(seen).toEqual([['s1', 'run']])
  })

  // 描述是一份承诺（docs/AGENT-TOOLING.md §8）：`run` 真的会往用户网盘里搬文件、还会删副本。
  // 这条钉的是"那句话还在"——没有测试能证明模型照做了，但描述被人顺手删掉是能挡住的。
  it('netdisk_follow 的描述必须说清 run 会真转存 + 会删落选副本 + 先跟用户说', () => {
    const d = catalog({ netdisk: { ...core, follow: async () => ({}) } })
      .find((t) => t.name === 'netdisk_follow')!.description
    expect(d).toContain('TRANSFERS')
    expect(d).toContain('DELETES')
    expect(d).toMatch(/BEFORE calling it with `run`/)
    expect(d).toContain('DO NOT poll')
  })

  it('reconcile_undo_run 的描述必须说清删撤不回来——{undone:0,skipped:7} 被报成撤销成功是最坏的一句', () => {
    const d = catalog({ netdisk: core }).find((t) => t.name === 'reconcile_undo_run')!.description
    expect(d).toContain('DELETES ARE NOT UNDONE')
    expect(d).toContain('skipped')
  })

  it('裁决器没装配 → reconcile_adjudicate / reconcile_revoke_adjudication 都不在；装配了才出现', () => {
    expect(names(core)).not.toContain('reconcile_adjudicate')
    expect(names(core)).not.toContain('reconcile_revoke_adjudication')
    const got = names({ ...core, adjudicate: async () => ({}), revokeAdjudication: async () => ({}) })
    expect(got).toContain('reconcile_adjudicate')
    expect(got).toContain('reconcile_revoke_adjudication')
  })

  it('reconcile_adjudicate：show + losers 原样递下去，losers 可省', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, adjudicate: async (show, opts) => (seen.push([show, opts]), {}) },
    }).find((t) => t.name === 'reconcile_adjudicate')!
    await tool.run({ show: 'binding:map_a3d90e', losers: true })
    expect(seen).toEqual([['binding:map_a3d90e', { losers: true }]])
  })

  it('reconcile_adjudicate 的描述必须说清模型不删文件、结论过代码闸、skipped 是正常节流', () => {
    const d = catalog({ netdisk: { ...core, adjudicate: async () => ({}) } })
      .find((t) => t.name === 'reconcile_adjudicate')!.description
    expect(d).toContain('NEVER DELETES')
    expect(d).toContain('CODE GATE')
    expect(d).toContain("skipped:'same cards'")
  })

  it('reconcile_revoke_adjudication：runId 原样递下去', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, revokeAdjudication: async (runId) => (seen.push(runId), {}) },
    }).find((t) => t.name === 'reconcile_revoke_adjudication')!
    await tool.run({ runId: 'adj_1' })
    expect(seen).toEqual(['adj_1'])
  })
})

// 试运行（2026-09-03，《喜剧之王单口季》）暴露的三处：将删清单翻不动、执行与预览之间没有闸、
// netdisk_browse 传错参数安静回根。三条都是**不报错**的那类，所以判据钉在这里。
describe('toolCatalog — 整理面试运行补的三处', () => {
  const core = {
    bindings: () => [],
    browse: async () => ({}),
    residue: async () => ({}),
    previewSpec: async () => ({}),
    applySpec: async () => ({}),
    reconcileStatus: async () => ({}),
    reconcileDecide: () => ({}),
    reconcileExecute: async () => ({}),
    reconcileUndoRun: async () => ({}),
    sync: async () => ({}),
  } as NonNullable<McpExtras['netdisk']>

  it('reconcile_status 收 deletesOffset 并原样递下去', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, reconcileStatus: async (show, opts) => (seen.push([show, opts]), {}) },
    }).find((t) => t.name === 'reconcile_status')!
    expect(Object.keys(tool.schema)).toContain('deletesOffset')
    await tool.run({ show: 'binding:map_a3d90e', deletesOffset: 50 })
    expect(seen).toEqual([['binding:map_a3d90e', { expandDir: undefined, offset: undefined, limit: undefined, deletesOffset: 50 }]])
  })

  it('reconcile_status 的描述给出翻页的具体参数名——「要么分页」曾经是一条不存在的指令', () => {
    const d = catalog({ netdisk: core }).find((t) => t.name === 'reconcile_status')!.description
    expect(d).toContain('deletesOffset')
    expect(d).toContain('plannedDeletesTotal')
    expect(d).toContain('planFingerprint')
  })

  it('reconcile_execute 收 expectFingerprint 并递下去', async () => {
    const seen: unknown[] = []
    const tool = catalog({
      netdisk: { ...core, reconcileExecute: async (show, opts) => (seen.push([show, opts]), {}) },
    }).find((t) => t.name === 'reconcile_execute')!
    expect(Object.keys(tool.schema)).toContain('expectFingerprint')
    await tool.run({ show: 'binding:map_a3d90e', expectFingerprint: 'abc123' })
    expect(seen).toEqual([['binding:map_a3d90e', { expectFingerprint: 'abc123' }]])
    expect(
      catalog({ netdisk: core }).find((t) => t.name === 'reconcile_execute')!.description,
    ).toContain('expectFingerprint')
  })

  // 安静地答非所问是最阴的一种：不报错，只是回了网盘根。schema 层直接拒。
  it('netdisk_browse 传 setId → schema 层拒绝，且说清该传什么', () => {
    const tool = catalog({ netdisk: core }).find((t) => t.name === 'netdisk_browse')!
    const bad = z.object(tool.schema).safeParse({ setId: 'map_a3d90e' })
    expect(bad.success).toBe(false)
    expect(JSON.stringify(bad.error)).toContain('netdisk_browse takes path, not setId — get dirPath from netdisk_bindings')
    expect(z.object(tool.schema).safeParse({ path: '/quark/x' }).success).toBe(true)
  })
})
