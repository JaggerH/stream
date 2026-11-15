import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isUnavailable } from '../../shared/package-sdk/errors.ts'
import { loadPlugins } from '../../src/plugins/loader.ts'
import { DOUYIN_DETAIL_SOURCE, DETAIL_UNAVAILABLE_FIELD, readDouyinAweme } from './douyin-detail.ts'

const RECIPE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./douyin-detail.recipe.json', import.meta.url)), 'utf8'),
) as { sourceId: string; entryUrl: string; steps: { call: string }[]; output: { targetCount: number; mapping: Record<string, string> } }

describe('douyin-detail — recipe 与代码之间那两条对得上', () => {
  // 两边各写一份字面量 = 改了一边不会有任何一处报错（`ctx.readSource` 按包名限定全名，拼错只会
  // 在运行时报「没这条源」，而那已经是用户点开视频的时候了）。
  it('代码引的 source 名就是 recipe 自己的 sourceId', () => {
    expect(RECIPE.sourceId).toBe(DOUYIN_DETAIL_SOURCE)
  })

  // 这条最要紧：判据住在 recipe 的页内 JS（JSON 字符串里），翻译住在 TS。字段名一改，删掉的作品
  // 就会静静地变成一条没有媒体的「成功」，没有一处会喊 —— 所以两边都钉住。
  it('recipe 的 call 与 output 映射里都确实有 DETAIL_UNAVAILABLE_FIELD 这一格', () => {
    expect(RECIPE.steps[0].call).toContain(DETAIL_UNAVAILABLE_FIELD)
    expect(RECIPE.output.mapping[DETAIL_UNAVAILABLE_FIELD]).toBe(DETAIL_UNAVAILABLE_FIELD)
  })

  // 「作品没了」必须**产出**、不许抛：抛了会被 runner 判成 drift，RepairLedger 连吃三次就把整个源
  // 隔离，之后任何抖音链接都秒回一句毫不相干的空结果（活体 2026-09-23 真撞过）。
  it('recipe 在「没有 aweme_detail」那一格是 return 不是 throw', () => {
    const call = RECIPE.steps[0].call
    const branch = call.slice(call.indexOf('if (!a || !a.aweme_id)'))
    const stop = branch.indexOf('const av =')
    expect(branch.slice(0, stop)).toContain('return {')
    expect(branch.slice(0, stop)).not.toContain('throw ')
  })

  it('entryUrl 是调用方给的那条链接本身（短链靠浏览器跟跳转，不在我们这儿解析）', () => {
    expect(RECIPE.entryUrl).toBe('{url}')
    expect(RECIPE.output.targetCount).toBe(1)
  })

  // 「落地页不是 /video/<id>」这一档是**调用方的输入**造成的（用户主页等非作品页链接顶着
  // douyin.com 的域名走同一条认领路径），不是 recipe 坏了——最终抛错必须带 `input-error: `
  // 前缀自报（合同见 src/replay/recipe-runner.ts 的 INPUT_ERROR_PREFIX）。不带的话 runner 判成
  // drift，RepairLedger 连吃三次把整个源隔离，之后所有抖音链接 5ms 秒回「产出是空的」
  // （活体 2026-11-15：modal_id 链接试两次加重试一次就哑了）。
  it('「落地页不是作品页」的最终失败带 input-error 前缀，且只在这一档', () => {
    const call = RECIPE.steps[0].call
    const marked = call.indexOf("why.indexOf('落地页不是') === 0")
    expect(marked, 'recipe 里找不到落地页判据——again 的输入错误分支被挪走或改名了').toBeGreaterThan(-1)
    expect(call.slice(marked)).toContain("'input-error: 这不是一条抖音作品链接——'")
    // 其余失败（风控、模块搬家）仍是普通抛错——那才是 drift 该管的事。
    expect(call).toContain("throw new Error('douyin-detail: ' + ATTEMPTS")
  })

  // 验证码墙（活体：用户第一次粘贴时页面出了验证码）：loginCheck 必须声明 challenge 选择器，
  // runner 的失败后补探才能把它翻成 challenged（「需要人工过验证」），而不是 drift——
  // 判 drift 会把被验证码挡了一下的源关进隔离。判法复用 browser-drive 的阳性墙探测。
  it('loginCheck 声明了抖音的验证码容器（挑战翻案靠它）', () => {
    const lc = (RECIPE as unknown as { loginCheck: { challenge?: string; wall?: string } }).loginCheck
    expect(lc.challenge).toBe('#captcha_container')
    expect(lc.wall).toBe('#login-panel-new')
  })
})

// 两条成员（播放解析 / 贴链接抓媒体）都是经 `hybridVideoData` 跑这条 recipe 的，所以扇出层给它们的
// 时间必须比 recipe 自己的上限还宽。**这道闸咬过一次**（活体 2026-09-23 07:59：recipe 还在重试循环里，
// 扇出层 24s 就 `timed out after 25000ms`，用户侧表现成「解析失败」，而 recipe 什么都没做错）。
// 钉的是**关系**不是数字：谁改了 maxTaskMs 或把 member_timeout_ms 摘掉，这里就红。
describe('douyin-detail 的两个消费成员：扇出闸必须比 recipe 的上限宽', () => {
  const dtdl = loadPlugins('packages').find((p) => p.id === 'Douyin_TikTok_Download_API')!
  const maxTaskMs = (RECIPE as unknown as { policy: { maxTaskMs: number } }).policy.maxTaskMs

  it.each(['douyin-resolve', 'douyin-fetch-url'])('%s 自报的 member_timeout_ms > recipe 的 maxTaskMs', (local) => {
    const src = (dtdl.sources ?? []).find((s) => s.id.endsWith(`/${local}`) || s.id === local)
    expect(src, `找不到源 ${local}`).toBeTruthy()
    expect(src!.member_timeout_ms).toBeGreaterThan(maxTaskMs)
  })
})

// 挑模板的主机判据：从**出货的那份 recipe 里抠出来**跑，不是抄一份到测试里——抄一份就只能证明
// 抄的那份对。活体 2026-09-23 咬过一次：那一趟只有 `www-hj.douyin.com` 发了 aweme/detail，而当时的
// 判据是 `n.indexOf('www.douyin.com') > -1`（对 `www-hj.douyin.com` 是 -1），于是一个模板都没挑到、
// 5 轮全让完，报「作品页还没发它自己的 aweme/detail 请求」——页面其实好好的，请求也真发了。
describe('douyin-detail 的 sameSite 判据（从 recipe 的 call 里抠出来）', () => {
  const src = (RECIPE as unknown as { steps: { call: string }[] }).steps[0].call
  const m = src.match(/const sameSite = \(n\) => \{[\s\S]*?\};/)
  const sameSite = (() => {
    expect(m, 'recipe 里找不到 sameSite —— 判据被改名或挪走了，这道守卫就空了').toBeTruthy()
    return new Function(`${m![0]} return sameSite;`)() as (n: string) => boolean
  })()

  it.each([
    ['https://www.douyin.com/aweme/v1/web/aweme/detail/?a=1', true],
    ['https://www-hj.douyin.com/aweme/v1/web/aweme/detail/?a=1', true], // ← 真咬过的那一个
    ['https://douyin.com/aweme/v1/web/aweme/detail/', true],
    ['https://www.iesdouyin.com/aweme/v1/web/aweme/detail/', false],
    ['https://douyin.com.evil.example/aweme/v1/web/aweme/detail/', false], // 后缀撞名不算自家
    ['not a url at all', false],
  ])('%s → %s', (url, want) => {
    expect(sameSite(url as string)).toBe(want)
  })
})

describe('readDouyinAweme', () => {
  it('把产物行里的 `douyin` 那格（整条 aweme）交回来，参数只有 url', async () => {
    const seen: unknown[] = []
    const aweme = { aweme_id: '7', desc: 'x' }
    const out = await readDouyinAweme(async (id, params) => {
      seen.push([id, params])
      return [{ guid: '7', douyin: aweme }]
    }, 'https://v.douyin.com/abc/')
    expect(out).toBe(aweme)
    expect(seen).toEqual([[DOUYIN_DETAIL_SOURCE, { url: 'https://v.douyin.com/abc/' }]])
  })

  it('跑完了但产出是空的 → 抛，不回 {}', async () => {
    await expect(readDouyinAweme(async () => [], 'https://www.douyin.com/video/1')).rejects.toThrow(/没有读到作品详情/)
  })

  it('产出行里没有 `douyin` 那格（映射漂了）→ 同样抛，不把半条当成功', async () => {
    await expect(readDouyinAweme(async () => [{ guid: '1' }], 'https://www.douyin.com/video/1')).rejects.toThrow(/没有读到作品详情/)
  })

  // 产出里带 `unavailable` → ContentUnavailableError（调用点据此回 404 而不是 502），
  // 而且**原样转述站方那句判词**：我们自己编的「已删除、私密或仅粉丝可见」是三种情况的并集，
  // 用户读完还是不知道该怎么办。
  it('产出带 unavailable → ContentUnavailableError，消息就是站方原话', async () => {
    const said = '因作品权限或已被删除，无法观看，去看看其他作品吧'
    const err = await readDouyinAweme(
      async () => [{ guid: '1', [DETAIL_UNAVAILABLE_FIELD]: said }],
      'https://www.douyin.com/video/1',
    ).catch((e: unknown) => e as Error)
    expect(isUnavailable(err)).toBe(true)
    expect(err.message).toBe(said)
  })

  // 反过来：recipe 真的跑挂（风控 / webpack 变了）仍然原样抛，绝不翻译成「内容不可用」——
  // 前者要人去看采集，后者告诉用户「这条没了」，说反了就把一次故障藏成一条正常的空结果。
  it('recipe 跑挂仍然原样抛，不翻译成「内容不可用」', async () => {
    const err = await readDouyinAweme(async () => {
      throw new Error('douyin-detail: signed-request module not found in any webpackChunk global')
    }, 'https://www.douyin.com/video/1').catch((e: unknown) => e as Error)
    expect(isUnavailable(err)).toBe(false)
    expect(err.message).toMatch(/webpackChunk/)
  })

  it('别的失败（风控 / webpack 变了）原样抛，绝不翻译成「内容不可用」', async () => {
    const err = await readDouyinAweme(async () => {
      throw new Error('douyin-detail: signed-request module not found in any webpackChunk global')
    }, 'https://www.douyin.com/video/1').catch((e: unknown) => e)
    expect(isUnavailable(err)).toBe(false)
    expect((err as Error).message).toMatch(/webpackChunk/)
  })
})
