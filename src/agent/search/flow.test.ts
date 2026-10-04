// src/agent/search/flow.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runSearch, type SearchFlowDeps } from './flow.ts'
import { hubPriority, netdiskDomain, targetNames } from './domains/netdisk.ts'
import type { NetdiskHit, TrajectoryStep, WebHit } from './types.ts'
import { textOf } from '../../llm/client.ts'
import type { ChatMessage, ChatResult } from '../../llm/client.ts'

const web = (over: Partial<WebHit>): WebHit => ({ title: 't', url: 'https://example.com', ...over })
const reply = (content: string): ChatResult => ({ content, raw: {} })

const TGSTAT = 'https://cn.tgstat.com/channel/@fulibas/4401'

// Route a chat call to the right joint by its system prompt marker, then (optionally) by user text.
const chatStub = (r: { queries: (user: string) => string; classify: (user: string) => string; score?: string }) =>
  vi.fn(async (messages: ChatMessage[]) => {
    const sys = textOf(messages[0].content)
    const user = textOf(messages[1].content)
    if (sys.includes('生成')) return reply(r.queries(user)) // proposeQueries
    if (sys.includes('分类')) return reply(r.classify(user)) // classifyHits
    if (sys.includes('打分')) return reply(r.score ?? '[]') // scoreTopicality
    return reply('[]')
  })

describe('runSearch (search-led)', () => {
  it('round 0 discovers a hub + a direct quark link, hits hubTarget → stops', async () => {
    const webSearch = vi.fn(async () => [
      web({ title: '怡楽 合集', url: 'https://pan.quark.cn/s/abc' }),
      web({ title: '福利吧', url: TGSTAT }),
    ])
    const chat = chatStub({
      queries: () => '["怡乐播客 网盘"]',
      classify: () => '{"items":[{"i":0,"kind":"netdisk"},{"i":1,"kind":"hub"}],"vocab":["付费合集"]}',
      score: '[{"i":0,"score":3}]',
    })
    const steps: TrajectoryStep[] = []
    const emit = (s: Omit<TrajectoryStep, 'seq' | 'at'>) => steps.push({ ...s, seq: steps.length, at: '' })
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 5, hubs: 1 }, maxRounds: 3 }

    const out = await runSearch('怡楽播客', deps, emit)

    expect(webSearch).toHaveBeenCalledTimes(1) // hubTarget reached round 0 → no expansion
    expect(out.targets.map((t) => t.netdisk)).toEqual(['quark'])
    expect(out.hubs.map((h) => h.kind)).toEqual(['telegram'])
    expect(out.onboardable).toContain(TGSTAT)
    expect(steps.map((s) => s.kind)).toEqual(['seed', 'search', 'classify', 'score', 'rank', 'result'])
  })

  it('B轴 expansion: round 0 finds only noise → learns → round 1 finds the hub', async () => {
    const webSearch = vi.fn(async (q: string) =>
      q === 'q1' ? [web({ url: TGSTAT })] : [web({ url: 'https://noise.example' })]
    )
    const chat = chatStub({
      queries: (user) => (user.includes('q0') ? '["q1"]' : '["q0"]'), // seed→q0, expand→q1
      classify: (user) =>
        user.includes('fulibas')
          ? '{"items":[{"i":0,"kind":"hub"}],"vocab":["福利吧"]}'
          : '{"items":[{"i":0,"kind":"noise"}],"vocab":["付费合集"]}',
    })
    const kinds: string[] = []
    const emit = (s: Omit<TrajectoryStep, 'seq' | 'at'>) => kinds.push(s.kind)
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 5, hubs: 1 }, maxRounds: 3 }

    const out = await runSearch('怡楽播客', deps, emit)

    expect(webSearch).toHaveBeenNthCalledWith(1, 'q0')
    expect(webSearch).toHaveBeenNthCalledWith(2, 'q1')
    expect(out.hubs).toHaveLength(1)
    expect(out.onboardable).toContain(TGSTAT)
    expect(kinds).toContain('expand')
  })

  it('乙档: fetches a discovered hub and extracts a concrete quark link', async () => {
    const webSearch = vi.fn(async () => [web({ title: '福利吧', url: TGSTAT })])
    const fetchPage = vi.fn(async (url: string) =>
      url === TGSTAT ? '怡楽合集 夸克：https://pan.quark.cn/s/reallink 提取码 ab12' : ''
    )
    const chat = chatStub({
      queries: () => '["怡乐播客 网盘"]',
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}', // tgstat is a hub, not a direct link
      score: '[{"i":0,"score":3}]',
    })
    const kinds: string[] = []
    const emit = (s: Omit<TrajectoryStep, 'seq' | 'at'>) => kinds.push(s.kind)
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, fetchPage, domain: netdiskDomain({}), earlyStop: { topical: 1, hubs: 99 }, maxRounds: 2 }

    const out = await runSearch('怡楽播客', deps, emit)

    expect(fetchPage).toHaveBeenCalledWith(TGSTAT)
    expect(out.targets.map((t) => t.netdisk)).toEqual(['quark'])
    expect(out.targets[0]).toMatchObject({ link: 'https://pan.quark.cn/s/reallink', password: 'ab12' })
    expect(out.hubs).toHaveLength(1) // the hub is still recorded + onboardable
    expect(kinds).toContain('fetch')
  })

  // The point of verifying: the scorer stops guessing from post text and judges the resource.
  it('verify runs BEFORE scoring, so the real file names reach the scoring joint', async () => {
    const webSearch = vi.fn(async () => [web({ title: '合集', url: 'https://pan.quark.cn/s/live1' })])
    let scoredWith = ''
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      if (sys.includes('生成')) return reply('["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"netdisk"}],"vocab":[]}')
      if (sys.includes('打分')) { scoredWith = textOf(messages[1].content); return reply('[{"i":0,"score":3}]') }
      return reply('[]')
    })
    const kinds: string[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, maxRounds: 1, earlyStop: { topical: 1, hubs: 5 },
      domain: netdiskDomain({
        verifyShare: async () => ({ validity: 'alive', files: [{ name: '怡楽播客 第01期' }] }),
        parseShareLink: (l) => (l.includes('quark') ? { netdisk: 'quark', pwd_id: 'live1' } : null),
      }),
    }

    const out = await runSearch('怡楽播客', deps, (s) => kinds.push(s.kind))

    expect(scoredWith).toContain('怡楽播客 第01期') // the file list, not just the title
    expect(kinds.indexOf('verify')).toBeGreaterThan(-1)
    expect(kinds.indexOf('verify')).toBeLessThan(kinds.indexOf('score')) // ordering is the whole point
    expect(out.targets[0].files).toEqual(['怡楽播客 第01期'])
  })

  it('a dead link never reaches scoring, and the trajectory says how many were dropped', async () => {
    const webSearch = vi.fn(async () => [
      web({ title: '活的', url: 'https://pan.quark.cn/s/live1' }),
      web({ title: '死的', url: 'https://pan.quark.cn/s/dead1' }),
    ])
    let scoredWith = ''
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      if (sys.includes('生成')) return reply('["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"netdisk"},{"i":1,"kind":"netdisk"}],"vocab":[]}')
      if (sys.includes('打分')) { scoredWith = textOf(messages[1].content); return reply('[{"i":0,"score":3}]') }
      return reply('[]')
    })
    const steps: Array<Omit<TrajectoryStep, 'seq' | 'at'>> = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, maxRounds: 1, earlyStop: { topical: 1, hubs: 5 },
      domain: netdiskDomain({
        verifyShare: async (_n, pwd) =>
          pwd === 'dead1' ? { validity: 'not-usable', files: [] } : { validity: 'alive', files: [{ name: '要的' }] },
        parseShareLink: (l) => ({ netdisk: 'quark', pwd_id: l.split('/s/')[1] }),
      }),
    }

    const out = await runSearch('g', deps, (s) => steps.push(s))

    expect(scoredWith).not.toContain('死的') // dropped before the expensive batch call
    expect(out.targets).toHaveLength(1)
    expect(steps.find((s) => s.kind === 'verify')?.output).toMatchObject({ alive: 1, dead: 1, unchecked: 0 })
  })

  it('without a verify dep the flow behaves exactly as before (links unchecked, no verify step)', async () => {
    const webSearch = vi.fn(async () => [web({ title: '合集', url: 'https://pan.quark.cn/s/x' })])
    const chat = chatStub({
      queries: () => '["q0"]',
      classify: () => '{"items":[{"i":0,"kind":"netdisk"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const kinds: string[] = []
    const out = await runSearch('g', { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 1, hubs: 5 }, maxRounds: 1 }, (s) => kinds.push(s.kind))
    expect(kinds).not.toContain('verify')
    expect(out.targets).toHaveLength(1)
    expect(out.targets[0].files).toBeUndefined()
  })

  it('stop rule: expansion dry (no new query) ends the loop', async () => {
    const webSearch = vi.fn(async () => [web({ url: 'https://noise.example' })])
    const chat = chatStub({
      queries: (user) => (user.includes('q0') ? 'nope' : '["q0"]'), // expand parse-fails → []
      classify: () => '{"items":[{"i":0,"kind":"noise"}],"vocab":[]}',
    })
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 5, hubs: 5 }, maxRounds: 5 }

    const out = await runSearch('g', deps, () => {})
    expect(webSearch).toHaveBeenCalledTimes(1) // stopped: no new query
    expect(out.targets).toHaveLength(0)
    expect(out.hubs).toHaveLength(0)
  })

  // 单条查询会因为被限流/被拦而抛错。这条腿必须分得清
  // 「这轮没找到」和「这轮压根没查成」——混成一个空数组的话，run 会安静地得出「没招到源」，
  // 而真相是搜索根本没跑起来。
  it('单条查询失败不拖垮整轮：其余查询的结果照常用', async () => {
    const webSearch = vi.fn(async (q: string) => {
      if (q === 'q-bad') throw new Error('[web_search] 这次没查成')
      return [web({ title: '怡楽 合集', url: 'https://pan.quark.cn/s/abc' })]
    })
    const chat = chatStub({
      queries: () => '["q-bad","q-ok"]',
      classify: () => '{"items":[{"i":0,"kind":"direct"}],"vocab":[]}',
      score: '[{"i":0,"score":90}]',
    })
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 1, hubs: 5 }, maxRounds: 1 }

    const out = await runSearch('g', deps, () => {})
    expect(out.targets.length).toBeGreaterThan(0)
  })

  it('一条都没查成 → 抛出原因，不谎报「没招到源」', async () => {
    const webSearch = vi.fn(async () => {
      throw new Error('[web_search] 这次没查成——google: 撞上验证码')
    })
    const chat = chatStub({ queries: () => '["q0"]', classify: () => '{"items":[],"vocab":[]}' })
    const deps: SearchFlowDeps<NetdiskHit> = { webSearch, chat, domain: netdiskDomain({}), earlyStop: { topical: 5, hubs: 5 }, maxRounds: 3 }

    await expect(runSearch('g', deps, () => {})).rejects.toThrow(/没有任何查询成功|Suspended/)
  })
})

// Task 2：停止条件统一成「边际产出趋零 + 可选早停」（spec §2.5 ②——可判定性不同不是阈值不同：
// 网盘档「够 N 条」是事实、可判定，叠在通用的边际产出判据之上当早停参数；枚举档「收全了没」
// 不可判定，只能靠「候选集不再增长」这种启发式，且回执必须分得清「收敛了」和「跑满轮次被截断」。
describe('停止条件（Task 2）：边际产出趋零 + 早停分得开', () => {
  it('一整轮 check 后新增 0 个不重复候选 → 收敛停止，即使没到 maxRounds、也没到早停阈值', async () => {
    // 每轮换新词（q0/q1/q2…永不重复，扩源永不干涸），但 round 1 的窝给出与 round 0 **同一条**链：
    // 第二轮边际产出为 0 → 收敛即停。若按"跑满轮次"实现，webSearch 会被调 3 次，stopped 也不是 converged。
    const webSearch = vi.fn(async (q: string) => [web({ title: '窝', url: `https://hub.example.com/${q}` })])
    const fetchPage = vi.fn(async () => '夸克：https://pan.quark.cn/s/same-link 提取码 ab12')
    let n = 0
    const chat = chatStub({
      queries: () => `["q${n++}"]`,
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const steps: TrajectoryStep[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), maxRounds: 3, maxHubsPerRound: 1,
      earlyStop: { topical: 9, hubs: 99 }, // 高不可及——只有边际产出判据能停
    }

    const out = await runSearch('g', deps, (s) => steps.push(s as TrajectoryStep))

    expect(webSearch).toHaveBeenCalledTimes(2) // 第二轮收敛即停，不跑第三轮
    expect(out.stopped).toBe('converged')
    expect(steps.filter((s) => s.kind === 'fetch')).toHaveLength(2)
  })

  it('跑满轮次被截断要说出口：stopped=truncated，与收敛分得开', async () => {
    // 每轮都是新窝新链（identityOf 全不同）、早停阈值高不可及 → 三轮跑满 → truncated。
    const webSearch = vi.fn(async (q: string) => [web({ title: '窝', url: `https://hub.example.com/${q}` })])
    const fetchPage = vi.fn(async (url: string) => `夸克：https://pan.quark.cn/s/${url.split('/').pop()} 提取码 ab12`)
    let n = 0
    const chat = chatStub({
      queries: () => `["q${n++}"]`,
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), maxRounds: 3, maxHubsPerRound: 1,
      earlyStop: { topical: 99, hubs: 99 },
    }

    const out = await runSearch('g', deps, () => {})

    expect(webSearch).toHaveBeenCalledTimes(3)
    expect(out.stopped).toBe('truncated')
  })

  it('早停照旧：stopped=early，够 N 条就停', async () => {
    const webSearch = vi.fn(async () => [web({ title: '怡楽 合集', url: 'https://pan.quark.cn/s/abc' })])
    const chat = chatStub({
      queries: () => '["q0"]',
      classify: () => '{"items":[{"i":0,"kind":"netdisk"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, domain: netdiskDomain({}), maxRounds: 3, earlyStop: { topical: 1, hubs: 99 },
    }

    const out = await runSearch('g', deps, () => {})

    expect(webSearch).toHaveBeenCalledTimes(1)
    expect(out.stopped).toBe('early')
  })
})

// Task 3：产出量回灌窝优先级（spec §2.2）——「窝好不好」从猜改成学。信号必须是 check 之后
// 还算数的数量（§2.5 ③），不是抽出来的数量：一个窝抽出 200 行全是手机壳，按抽出量回灌会
// **正确地学到一个错误的偏好**，且没有任何一处会报错。
describe('产出量回灌（Task 3）：能出活的窝在后续轮次提优先级', () => {
  it('第一轮 A 抽出 5 行全过 check、B 抽出 20 行全被刷掉 → 第二轮 A 排到 B 前面（尽管先验 B 更靠前、B 抽得更多）', async () => {
    const A = 'https://site-a.example/p1'
    const B = 'https://t.me/s/b1'
    const A2 = 'https://site-a.example/p2'
    const B2 = 'https://t.me/s/b2'
    const webSearch = vi.fn(async (q: string) =>
      q === 'q0'
        ? [web({ title: '站A', url: A }), web({ title: '频道B', url: B })]
        : [web({ title: '站A2', url: A2 }), web({ title: '频道B2', url: B2 })]
    )
    const aPage = () => Array.from({ length: 5 }, (_, i) => `华为 Mate70 手机 https://pan.quark.cn/s/aa${i + 1} 提取码 x1`).join('\n')
    const a2Page = () => Array.from({ length: 5 }, (_, i) => `华为 Mate70 手机 https://pan.quark.cn/s/aa1${i + 1} 提取码 x1`).join('\n')
    const bPage = () => Array.from({ length: 20 }, (_, i) => `手机壳 保护壳 https://pan.quark.cn/s/bb${i + 1} 提取码 x1`).join('\n')
    const opened: string[] = []
    const fetchPage = vi.fn(async (url: string) => {
      opened.push(url)
      if (url === A2) return a2Page()
      return url.includes('site-a.example') ? aPage() : bPage()
    })
    // 打分关节按 snippet 分：含「华为」= 切题（3），其余（手机壳）= 0。
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      const user = textOf(messages[1].content)
      if (sys.includes('生成')) return reply(user.includes('q0') ? '["q1"]' : '["q0"]')
      if (sys.includes('分类')) return reply('{"items":[{"i":0,"kind":"hub"},{"i":1,"kind":"hub"}],"vocab":[]}')
      if (sys.includes('打分')) {
        const scores = [...user.matchAll(/(\d+)\. ([^\n]*)/g)].map((m) => ({
          i: Number(m[1]),
          score: /华为/.test(m[2]) ? 3 : 0,
        }))
        return reply(JSON.stringify(scores))
      }
      return reply('[]')
    })
    const steps: TrajectoryStep[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), maxRounds: 2, maxHubsPerRound: 2,
      earlyStop: { topical: 99, hubs: 99 }, // 只靠回灌改变开窝顺序，不靠早停收工
    }

    const out = await runSearch('g', deps, (s) => steps.push(s as TrajectoryStep))

    // 先验（纯站型）里 B 更靠前——telegram 排在 site 前面。
    expect(netdiskDomain({}).hubAffinity({ kind: 'telegram' }, 'g')).toBeLessThan(
      netdiskDomain({}).hubAffinity({ kind: 'site' }, 'g'),
    )
    // 第二轮名额 1 个，开的是**上一轮出活**的 A 家（site-a.example），不是先验更靠前的 B 家。
    // 若按抽出量回灌（B 抽 20 > A 抽 5）或干脆不回灌，这里开的就是 B2。
    expect(opened[2]).toBe(A2)
    // fetch 步骤把 fetched（抽了多少窝）和 kept（验完还剩多少算数）并排写出来——
    // 「抽得多但没一个算数」这种窝只有两个数摆在一起才看得见。
    const fetch0 = steps.filter((s) => s.kind === 'fetch')[0]!
    expect(fetch0.output).toMatchObject({ fetched: 2, extracted: 25, kept: 5, skipped: 0 })
    expect(out.stopped).toBe('truncated')
  })
})

describe('targetNames — 从 goal 里抠出「这一部叫什么」', () => {
  it('收书名号里的中文名和成组的拉丁原名，逗号/空格差异不影响比对', () => {
    const names = targetNames('动画剧集《阿达想当科学家》（Ada Twist, Scientist，Netflix 2021 出品）的可下载资源')
    expect(names).toContain('阿达想当科学家')
    expect(names).toContain('adatwistscientist') // 折叠后：逗号和空格都去掉
  })

  it('不收品类词——它们哪个窝都命中，收进来这条判据就废了', () => {
    // 「儿童动画」「网盘」既不在书名号里也不是拉丁词组，抠不出来即是正确行为。
    expect(targetNames('儿童动画 网盘资源 下载')).toEqual([])
  })

  it('单个大写词不算名字（Netflix 这种发行方会把所有窝都拉平）', () => {
    expect(targetNames('Netflix 出品的动画')).toEqual([])
  })
})

describe('hubPriority — 先看像不像目标，再看站型', () => {
  const names = targetNames('《阿达想当科学家》（Ada Twist, Scientist）')

  it('名字命中的普通站点排在名字没命中的 telegram 前面', () => {
    const blog = { kind: 'site', title: '《小科学家埃达 Ada Twist Scientist》1-4季全集' }
    const tg = { kind: 'telegram', title: '网盘资源分享频道' }
    expect(hubPriority(blog, names)).toBeLessThan(hubPriority(tg, names))
  })

  it('都命中名字时，站型仍然决定先后', () => {
    const tg = { kind: 'telegram', title: 'Ada Twist Scientist 全集' }
    const site = { kind: 'site', title: 'Ada Twist, Scientist 全集' }
    expect(hubPriority(tg, names)).toBeLessThan(hubPriority(site, names))
  })

  it('都没命中就退回纯站型排序（老行为）', () => {
    expect(hubPriority({ kind: 'telegram', title: 'x' }, names))
      .toBeLessThan(hubPriority({ kind: 'site', title: 'y' }, names))
  })

  it('没有名字可抠 / 窝没有标题 → 不因此把它排到命中者前面', () => {
    expect(hubPriority({ kind: 'site', title: 'Ada Twist Scientist' }, []))
      .toBe(hubPriority({ kind: 'site' }, names))
  })
})

// 这一条钉住的是 2026-08-10 真实栽过的那次：41 个窝、12 个名额，标题就是目标全名的那个博客帖
// 因为 kind:'site' 排在所有 telegram 后面，一个名额都没轮到；被打开的窝给出的是别的片子的链接，
// 切题打分全判 0——打分没错，是根本没把对的窝打开。
describe('进窝顺序（回归：名额有限时先开像目标的那个）', () => {
  it('名额只有 1 个时，开的是标题带目标名的那个站，不是排在前面的 telegram', async () => {
    const BLOG = 'https://blog.example.com/ada-twist'
    const TG = 'https://t.me/s/generic'
    const webSearch = vi.fn(async () => [
      web({ title: '网盘资源分享频道', url: TG }),
      web({ title: '《小科学家埃达 Ada Twist Scientist》1-4季全集', url: BLOG }),
    ])
    const fetchPage = vi.fn(async (url: string) =>
      url.includes('blog.example.com') ? '夸克：https://pan.quark.cn/s/adalink' : '夸克：https://pan.quark.cn/s/other'
    )
    const chat = chatStub({
      queries: () => '["q0"]',
      classify: () => '{"items":[{"i":0,"kind":"hub"},{"i":1,"kind":"hub"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), earlyStop: { topical: 1, hubs: 99 }, maxRounds: 1, maxHubsPerRound: 1,
    }

    const out = await runSearch('动画剧集《阿达想当科学家》（Ada Twist, Scientist）的可下载资源', deps, () => {})

    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith(BLOG)
    expect(out.targets[0]?.link).toBe('https://pan.quark.cn/s/adalink')
  })

  // 这一条钉住的是 2026-08-15 那次「摇滚夏令营3」：名额曾经是**整个 run** 的 12 个，round 0 一口气
  // 吃光，round 1 只剩 1 个名额、放弃 33 个窝，round 2 一个都没开。而后两轮恰恰是「学会词之后」搜出
  // 来的更好的窝（TG 网盘频道）——tab 全花在搜索上，没花在真正能抽出链接的地方，三轮下来 0 条切题。
  it('名额按轮给：后面的轮次照样能开窝，不被第一轮吃光', async () => {
    // 每轮各出一个**新**窝（url 不同），名额每轮 1 个 → 三轮该开三次。
    const webSearch = vi.fn(async (q: string) => [web({ title: q, url: `https://t.me/s/${q}` })])
    const opened: string[] = []
    const fetchPage = vi.fn(async (url: string) => {
      opened.push(url)
      return ''
    })
    let n = 0
    const chat = chatStub({
      queries: () => `["q${n++}"]`,
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), earlyStop: { topical: 9, hubs: 99 }, maxRounds: 3, maxHubsPerRound: 1,
    }

    await runSearch('目标', deps, () => {})

    expect(opened).toEqual([
      'https://t.me/s/q0', 'https://t.me/s/q1', 'https://t.me/s/q2',
    ])
  })

  // 同一次事故的第二半：round 2 名额为 0 时，整个 fetch 块（含那句「另有 N 个窝没开」）被 if 一起
  // 跳过，轨迹上连一条 fetch 步骤都没有——读起来像「这一轮就是没链接」，实际是「压根没开过窝」。
  it('这一轮一个窝都没开，也要留下一条 fetch 步骤说清楚', async () => {
    // 两轮都只招到**同一个**窝：round 1 的 eligible 因去重为空，不该静默消失。
    const webSearch = vi.fn(async () => [web({ title: 'a', url: 'https://t.me/s/a' })])
    let n = 0
    const chat = chatStub({
      // 每轮换个新词（proposeQueries 会滤掉已经查过的，同一条词会让循环提前收工），但招回来的
      // 是同一个窝——这正是要钉的场景：这一轮没有新窝可开。
      queries: () => `["q${n++}"]`,
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
    })
    const steps: TrajectoryStep[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage: async () => '', domain: netdiskDomain({}), earlyStop: { topical: 9, hubs: 99 }, maxRounds: 2, maxHubsPerRound: 1,
    }

    await runSearch('目标', deps, (s) => steps.push(s as TrajectoryStep))

    expect(steps.filter((s) => s.kind === 'fetch')).toHaveLength(2)
    expect(steps.filter((s) => s.kind === 'fetch')[1]?.output).toMatchObject({ fetched: 0 })
  })

  it('名额用完时，没开的窝数要报出来——沉默的截断读起来跟"全开过了"一样', async () => {
    const webSearch = vi.fn(async () => [
      web({ title: 'a', url: 'https://t.me/s/a' }),
      web({ title: 'b', url: 'https://t.me/s/b' }),
      web({ title: 'c', url: 'https://t.me/s/c' }),
    ])
    const chat = chatStub({
      queries: () => '["q0"]',
      classify: () => '{"items":[{"i":0,"kind":"hub"},{"i":1,"kind":"hub"},{"i":2,"kind":"hub"}],"vocab":[]}',
    })
    const steps: TrajectoryStep[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage: async () => '', domain: netdiskDomain({}), earlyStop: { topical: 9, hubs: 99 }, maxRounds: 1, maxHubsPerRound: 1,
    }

    await runSearch('目标', deps, (s) => steps.push(s as TrajectoryStep))

    const fetchStep = steps.find((s) => s.kind === 'fetch')!
    expect(fetchStep.output).toMatchObject({ fetched: 1, skipped: 2 })
    expect(String(fetchStep.note)).toContain('2 个窝没开')
  })
})

// 评审补的两条（2026-09-02）。两条钉的都是**安静出错**的形状：现有断言全绿、轨迹正常、
// 没有一处报错，只是结论悄悄变了。
describe('评审回归：收敛判据与 onboardable 的内容', () => {
  it('第 0 轮抽到候选但一条都不切题 → 继续往后跑，不当场收敛', async () => {
    // maxHubsPerRound 注释里那段教训（「摇滚夏令营3」）的形状：前几轮全是泛泛资源站、
    // 抽得到链却一条不切题，真能出活的窝要到学会品类词之后才搜得出来。若收敛判据写成
    // 「这一轮抽到过东西且没有新的算数候选」，这条 run 会停在第 0 轮。
    const webSearch = vi.fn(async (q: string) => [web({ title: '窝', url: `https://hub.example.com/${q}` })])
    const fetchPage = vi.fn(async (url: string) => `夸克：https://pan.quark.cn/s/${url.split('/').pop()} 提取码 ab12`)
    let n = 0
    const chat = chatStub({
      queries: () => `["q${n++}"]`,
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
      score: '[{"i":0,"score":0}]', // 抽到了，但不切题
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage, domain: netdiskDomain({}), maxRounds: 3, maxHubsPerRound: 1,
      earlyStop: { topical: 9, hubs: 99 },
    }

    const out = await runSearch('g', deps, () => {})

    expect(webSearch).toHaveBeenCalledTimes(3)
    expect(out.stopped).toBe('truncated')
  })

  it('onboardable 收的是切题候选来自的那个窝，不是分享链本身', async () => {
    // onboardable 回答的是「哪个站值得接进来」。把 identityOf（= link）当出处用，这里就会
    // 冒出一条网盘分享链，而断言窝 url 在不在的那些老测试照旧全绿——抓不到。
    const HUB = 'https://hub.example.com/a'
    const webSearch = vi.fn(async () => [web({ title: '窝', url: HUB })])
    const chat = chatStub({
      queries: () => '["q0"]',
      classify: () => '{"items":[{"i":0,"kind":"hub"}],"vocab":[]}',
      score: '[{"i":0,"score":3}]',
    })
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat, fetchPage: async () => '夸克：https://pan.quark.cn/s/xyz789 提取码 ab12',
      domain: netdiskDomain({}), maxRounds: 1, maxHubsPerRound: 1, earlyStop: { topical: 9, hubs: 99 },
    }

    const out = await runSearch('g', deps, () => {})

    expect(out.onboardable).toContain(HUB)
    expect(out.onboardable).not.toContain('https://pan.quark.cn/s/xyz789')
  })
})

// 上游 LLM 梯子是所有消费方共享的，会成串地瞬时打不出去（实测 2026-09-02：同一秒里
// llm.chat 和 story-fold.semantic 一起 no_result，而前一发 7717 token 刚成功——梯子在抖，
// 不是体积问题）。抖一下就毁掉整条 run，代价是**已经花钱验过的候选全没了**。
describe('一轮挂了：已攒下的要交货，一条没攒下才算真没跑成', () => {
  const flakyAt = (failRound: number) => {
    let round = -1
    return vi.fn(async (messages: ChatMessage[]) => {
      const sys = textOf(messages[0].content)
      if (sys.includes('分类')) {
        round++
        if (round === failRound) throw new Error('LLM 未配置')
        return reply('{"items":[{"i":0,"kind":"hub"}],"vocab":[]}')
      }
      if (sys.includes('生成')) return reply(`["q${Math.random()}"]`)
      if (sys.includes('打分')) return reply('[{"i":0,"score":3}]')
      return reply('[]')
    })
  }

  it('第 1 轮挂掉 → 第 0 轮验好的照样交货，stopped=interrupted 并在轨迹里说清', async () => {
    const webSearch = vi.fn(async (q: string) => [web({ title: '窝', url: `https://hub.example.com/${encodeURIComponent(q)}` })])
    const fetchPage = vi.fn(async (url: string) => `夸克：https://pan.quark.cn/s/${url.length} 提取码 ab12`)
    const steps: TrajectoryStep[] = []
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat: flakyAt(1), fetchPage, domain: netdiskDomain({}),
      maxRounds: 3, maxHubsPerRound: 1, earlyStop: { topical: 99, hubs: 99 },
    }

    const out = await runSearch('g', deps, (s) => steps.push(s as TrajectoryStep))

    expect(out.stopped).toBe('interrupted')
    expect(out.targets.length).toBeGreaterThan(0) // 第 0 轮的成果没被扔掉
    // 绝不能安静地收尾——轨迹里必须留下"它是残的"这句话。
    expect(steps.map((s) => String(s.note ?? '')).join('\n')).toMatch(/断了.*残的/s)
  })

  it('第 0 轮就挂 → 照抛，不许把「压根没跑成」伪装成一份空清单', async () => {
    const webSearch = vi.fn(async () => [web({ title: '窝', url: 'https://hub.example.com/a' })])
    const deps: SearchFlowDeps<NetdiskHit> = {
      webSearch, chat: flakyAt(0), fetchPage: async () => '', domain: netdiskDomain({}),
      maxRounds: 3, maxHubsPerRound: 1,
    }

    await expect(runSearch('g', deps, () => {})).rejects.toThrow('LLM 未配置')
  })
})
