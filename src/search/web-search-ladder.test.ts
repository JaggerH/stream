import { describe, it, expect, vi } from 'vitest'
import {
  webSearchLadder,
  hasCJK,
  pickBrowserLegs,
  mergeHitsByUrl,
  type WebHit,
  type WebSearchLeg,
} from './web-search-ladder.ts'
import { RateLimitedError } from '../replay/facility-rate-limit.ts'

const hit = (url: string): WebHit => ({ title: url, url, snippet: 's' })

// 三条腿的出处名由装配处传入；这里给和生产一样的名字，好让 note 文案的断言照原样成立。
const primary = (search: WebSearchLeg['search']): WebSearchLeg => ({ label: 'Google', search })
const fallback = (search: WebSearchLeg['search']): WebSearchLeg => ({ label: 'Brave', search })
const cjk = (search: WebSearchLeg['search']): WebSearchLeg => ({ label: '百度', search })

describe('webSearchLadder — 主腿、备胎、中文并联腿各自什么时候上', () => {
  it('主腿有结果 → 直接给，不带噪音 note', async () => {
    const out = await webSearchLadder('q', {
      primary: primary(async () => [hit('https://a.example'), hit('https://b.example')]),
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://a.example', 'https://b.example'])
    expect(out.note).toBeUndefined()
  })

  it('主腿抛错 → 不抛出去，回落成「空结果 + 说明」', async () => {
    const onPrimaryFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => {
        throw new Error('rate limited on "google" — retry in 12s')
      }),
      onPrimaryFailure,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('rate limited')
    // 「没查成」必须说清，且**不能**变成一句邀请重试的话——对话循环没有退避。
    expect(out.note).not.toContain('稍后')
    expect(out.note).not.toContain('重试')
    expect(onPrimaryFailure).toHaveBeenCalledWith('q', 'rate limited on "google" — retry in 12s')
  })

  it('主腿跑通但 0 条 = 「主腿上确实没有」，不是失败，也不记失败', async () => {
    // 这条是被检疫机制逼出来的：把「确实没有」记成失败，RepairLedger 几次之后就把这条腿隔离，
    // 此后 ReplayAdapter 直接 DECLINE、连浏览器都不开、一个字都不报（2026-08-12 活体撞过）。
    const onPrimaryFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => []),
      onPrimaryFailure,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('也没有相符的结果')
    expect(out.note).not.toContain('没跑成')
    expect(onPrimaryFailure).not.toHaveBeenCalled()
  })

  it('主腿跑通但 0 条 → **不叫备胎**（那是结论，不是失败）', async () => {
    const fallbackSearch = vi.fn(async () => [hit('https://brave.example')])
    const out = await webSearchLadder('q', {
      primary: primary(async () => []),
      fallback: fallback(fallbackSearch),
    })
    expect(fallbackSearch).not.toHaveBeenCalled()
    expect(out.hits).toEqual([])
    expect(out.note).toContain('也没有相符的结果')
  })

  it('主腿抛错 → 叫醒备胎，备胎的结果直接顶上（主腿那次失败不再摆到模型面前）', async () => {
    const onPrimaryFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => {
        throw new Error('扩展没连')
      }),
      fallback: fallback(async () => [hit('https://brave.example')]),
      onPrimaryFailure,
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://brave.example'])
    expect(out.note).toBeUndefined()
    // 回落是软的，但不该是无声的：主腿断了这件事仍要落进日志。
    expect(onPrimaryFailure).toHaveBeenCalledWith('q', '扩展没连')
  })

  it('主腿撞满每小时预算 → 就是「这条腿不存在」，走备胎，用户拿到的是结果不是 error', async () => {
    // 累计预算（`FacilityRateLimit.perHour`）撞满时抛的就是这个 RateLimitedError，和「扩展没连」
    // 走同一条路——这里用真的那个类，是为了把「撞预算之后到底发生什么」钉在一处，而不是靠推断。
    const onPrimaryFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => {
        throw new RateLimitedError('google', 36_000)
      }),
      fallback: fallback(async () => [hit('https://brave.example')]),
      onPrimaryFailure,
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://brave.example'])
    expect(out.note).toBeUndefined() // 结果完好，不摆一句「主腿被限速了」让模型起疑
    expect(onPrimaryFailure).toHaveBeenCalledWith('q', 'rate limited on "google" — retry in 36s')
  })

  it('中文查询：主腿撞满预算、连备胎都没配 → 中文那条腿照样把结果给出去', async () => {
    // 预算是**按 facility** 的，撞满主腿不该顺手关掉并联的中文腿。
    const out = await webSearchLadder('中文查询', {
      primary: primary(async () => {
        throw new RateLimitedError('google', 36_000)
      }),
      cjk: cjk(async () => [hit('https://baidu-hit.example')]),
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://baidu-hit.example'])
    expect(out.note).toBeUndefined()
  })

  it('备胎跑通但 0 条 = 「备胎上也确实没有」，不是失败，也不记失败', async () => {
    const onFallbackFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => {
        throw new Error('撞上验证码')
      }),
      fallback: fallback(async () => []),
      onFallbackFailure,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('也没有相符的结果')
    expect(onFallbackFailure).not.toHaveBeenCalled()
  })

  it('主腿和备胎都没跑成 → 两个原因都说清，且不邀请重试', async () => {
    const onFallbackFailure = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => {
        throw new Error('rate limited on "google"')
      }),
      fallback: fallback(async () => {
        throw new Error('rate limited on "brave"')
      }),
      onFallbackFailure,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('rate limited on "google"')
    expect(out.note).toContain('rate limited on "brave"')
    expect(out.note).not.toContain('稍后')
    expect(out.note).not.toContain('重试')
    expect(onFallbackFailure).toHaveBeenCalledWith('q', 'rate limited on "brave"')
  })

  it('中文查询 → 主腿和中文腿**都**跑，结果合并（主腿的排前）', async () => {
    const out = await webSearchLadder('怡楽播客 小宇宙', {
      primary: primary(async () => [hit('https://g1.example')]),
      cjk: cjk(async () => [hit('https://b1.example'), hit('https://b2.example')]),
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://g1.example', 'https://b1.example', 'https://b2.example'])
    expect(out.note).toBeUndefined()
  })

  it('英文查询 → 只跑主腿，中文那条腿一次都不叫醒（不为它白开一个标签）', async () => {
    const cjkSearch = vi.fn(async () => [hit('https://b1.example')])
    const out = await webSearchLadder('typescript satisfies operator', {
      primary: primary(async () => [hit('https://g1.example')]),
      cjk: cjk(cjkSearch),
    })
    expect(cjkSearch).not.toHaveBeenCalled()
    expect(out.hits.map((h) => h.url)).toEqual(['https://g1.example'])
  })

  it('中文那条腿挂了 → 主腿的结果照常给出去，不变成 error、也不加噪音 note', async () => {
    const onCjkFailure = vi.fn()
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => [hit('https://g1.example')]),
      cjk: cjk(async () => {
        throw new Error('扩展没连')
      }),
      onCjkFailure,
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://g1.example'])
    expect(out.note).toBeUndefined()
    // 对结果没有影响 ⇒ 日志是它唯一的痕迹，更不能省。
    expect(onCjkFailure).toHaveBeenCalledWith('怡楽播客', '扩展没连')
  })

  it('主腿挂了、备胎也没有，但中文腿有 → 照样给结果（这正是中文腿并联而不是串联的意义）', async () => {
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => {
        throw new Error('撞上验证码')
      }),
      fallback: fallback(async () => {
        throw new Error('也撞上了')
      }),
      cjk: cjk(async () => [hit('https://b1.example')]),
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://b1.example'])
    expect(out.note).toBeUndefined()
  })

  it('两条腿都跑通但都没有 → 两句「确实没有」，且都不记失败', async () => {
    const onCjkFailure = vi.fn()
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => []),
      cjk: cjk(async () => []),
      onCjkFailure,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('也没有相符的结果')
    expect(out.note).toContain('百度上同样没有')
    expect(out.note).not.toContain('没跑成')
    expect(onCjkFailure).not.toHaveBeenCalled()
  })

  it('主腿说没有 + 中文那条腿没跑成 → 必须如实说中文来源没查全（这才是真缺口）', async () => {
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => []),
      cjk: cjk(async () => {
        throw new Error('rate limited on "baidu"')
      }),
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('中文来源没查全')
    expect(out.note).not.toContain('稍后')
    expect(out.note).not.toContain('重试')
  })

  it('两条腿撞上同一个页面 → 合成一条（百度的 mu 常常是 http://，别让它占第二格）', async () => {
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => [hit('https://www.xiaoyuzhoufm.com/podcast/5e80')]),
      cjk: cjk(async () => [hit('http://www.xiaoyuzhoufm.com/podcast/5e80/'), hit('https://b2.example')]),
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://www.xiaoyuzhoufm.com/podcast/5e80', 'https://b2.example'])
  })

  it('中文那条腿挂住 → 到点就不等了，主腿的结果照样按时给出去', async () => {
    // 并联的腿最容易犯的错：它挂住了，整条热路径跟着一起挂。活体撞见过 relay 的截图命令
    // 偶发挂满 30s，而 recipe 自己的 maxTaskMs 是 60s——不设软截止就是让用户等满 60s。
    const onCjkFailure = vi.fn()
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => [hit('https://g1.example')]),
      cjk: cjk(() => new Promise(() => {})), // 永不 settle
      cjkTimeoutMs: 20,
      onCjkFailure,
    })
    expect(out.hits.map((h) => h.url)).toEqual(['https://g1.example'])
    expect(onCjkFailure).toHaveBeenCalledWith('怡楽播客', expect.stringContaining('没回来'))
  })

  it('中文腿挂住 + 主腿也没有 → 如实说中文来源没查全（超时和抛错同一个待遇）', async () => {
    const out = await webSearchLadder('怡楽播客', {
      primary: primary(async () => []),
      cjk: cjk(() => new Promise(() => {})),
      cjkTimeoutMs: 20,
    })
    expect(out.hits).toEqual([])
    expect(out.note).toContain('中文来源没查全')
  })
})

describe('pickBrowserLegs — 哪条查询值得多开一个中文标签', () => {
  it('有汉字就加挂中文腿', () => {
    expect(hasCJK('怡楽播客')).toBe(true)
    expect(hasCJK('podcast 播客')).toBe(true)
    expect(pickBrowserLegs('怡楽播客')).toEqual(['primary', 'cjk'])
  })

  it('纯 ASCII / 纯符号不加挂 —— 判据必须是「中文」而不是「非英文」', () => {
    expect(hasCJK('typescript satisfies')).toBe(false)
    expect(hasCJK('café naïve résumé')).toBe(false)
    expect(hasCJK('日本語')).toBe(true) // 含汉字，走进来无害
    expect(hasCJK('ひらがなだけ')).toBe(false) // 纯假名：中文腿没有优势，不为它开标签
    expect(pickBrowserLegs('typescript satisfies')).toEqual(['primary'])
  })
})

describe('mergeHitsByUrl — 两条腿的结果怎么并', () => {
  const h = (url: string): WebHit => ({ title: url, url })

  it('前面那组优先，重复的按 URL 丢掉', () => {
    expect(
      mergeHitsByUrl([h('https://a.example')], [h('https://a.example'), h('https://b.example')]).map((x) => x.url),
    ).toEqual(['https://a.example', 'https://b.example'])
  })

  it('协议、尾斜杠、host 大小写不算差异', () => {
    expect(mergeHitsByUrl([h('https://A.example/x')], [h('http://a.example/x/')]).length).toBe(1)
  })

  it('路径大小写**是**差异 —— 路径大小写敏感，一起归一化会并掉不同的页面', () => {
    expect(mergeHitsByUrl([h('https://a.example/X')], [h('https://a.example/x')]).length).toBe(2)
  })
})

describe('梯子出口的同源折叠 — 转载不再一条占一格', () => {
  const named = (title: string, url: string): WebHit => ({ title, url })

  it('跨站转载收成一条，被折的挂在 alsoAt 上', async () => {
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('OpenAI 发布新模型 GPT-6', 'https://a.example/1'),
        named('OpenAI 发布新模型 GPT-6_新浪科技', 'https://b.example/2'),
        named('另一件完全不相干的事', 'https://c.example/3'),
      ]),
    })
    expect(out.hits).toHaveLength(2)
    expect(out.hits[0].alsoAt?.map((x) => x.url)).toEqual(['https://b.example/2'])
    // 独立那条不带这个字段——没有同源就不该凭空多一个空数组。
    expect(out.hits[1].alsoAt).toBeUndefined()
  })

  it('**一条都不会丢**：折叠前后信息量相等', async () => {
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('同一篇稿子', 'https://a.example/1'),
        named('同一篇稿子', 'https://b.example/2'),
        named('同一篇稿子', 'https://c.example/3'),
      ]),
    })
    const all = out.hits.flatMap((h) => [h.url, ...(h.alsoAt ?? []).map((x) => x.url)])
    expect(all).toHaveLength(3)
  })

  it('同一档节目的两集不许被折（序列身份一票否决）', async () => {
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('怡乐播客-209.十五谈身边灵异事', 'https://a.example/1'),
        named('怡乐播客-210.十六谈身边灵异事', 'https://b.example/2'),
      ]),
    })
    expect(out.hits).toHaveLength(2)
  })

  // ——内容级那一档（接了 readUrl 才有）——
  const longBody = (seed: string): string => `${seed}。`.repeat(60)

  it('标题被改写过的转载，靠正文折起来', async () => {
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('OpenAI 发布新模型 GPT-6', 'https://a.example/1'),
        named('重磅！人工智能又有大动作', 'https://b.example/2'),
      ]),
      readUrl: async () => ({ text: longBody('同一段稿子的正文内容在这里') }),
    })
    expect(out.hits).toHaveLength(1)
    expect(out.hits[0].alsoAt?.map((x) => x.url)).toEqual(['https://b.example/2'])
  })

  it('转成文字全挂了也只是不折——搜索结果照常给，不变成 error', async () => {
    const failed: string[] = []
    const out = await webSearchLadder('q', {
      // **换一组 URL**：转成文字的草图缓存是进程级的，用上一条用例抓过的地址会命中缓存、
      // 根本不调 readUrl，那样这条用例就成了一条假绿。
      primary: primary(async () => [
        named('甲讲的事', 'https://fail1.example/x'),
        named('乙讲的事', 'https://fail2.example/x'),
      ]),
      readUrl: async () => {
        throw new Error('502')
      },
      onReadUrlFailure: (url) => failed.push(url),
    })
    expect(out.hits).toHaveLength(2)
    expect(out.note).toBeUndefined()
    expect(failed).toHaveLength(2)
  })

  // ——折叠整段的总预算——
  // 每一档各自有超时，合起来却没有上限：第 2 档 12 篇 × 4 并发 × 8s + 第 3 档 20s，实测冷跑能在
  // 搜索腿之上再叠 20–40s。折叠是锦上添花，**到点必须放弃、把没折的原样给出去**。

  it('折叠超过总预算 → 给没折的结果，不变成 error、也不改 note', async () => {
    const onFoldTimeout = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('OpenAI 发布新模型 GPT-7', 'https://budget1.example/x'),
        named('重磅！人工智能又出大招', 'https://budget2.example/x'),
      ]),
      // 挂住不回：没有总预算的话，这里要等满第 2 档自己的 8s 单篇超时。
      readUrl: () => new Promise(() => {}),
      foldBudgetMs: 30,
      onFoldTimeout,
    })
    // 两条原样都在（没折 ≠ 丢），也没有多出一句 note——这次搜索的结论一个字都没变。
    expect(out.hits.map((h) => h.url)).toEqual(['https://budget1.example/x', 'https://budget2.example/x'])
    expect(out.hits.some((h) => h.alsoAt)).toBe(false)
    expect(out.note).toBeUndefined()
    // 软回落不许无声。
    expect(onFoldTimeout).toHaveBeenCalledWith('q', 30)
  })

  it('预算够用时照折不误——预算是上限不是闸门', async () => {
    const onFoldTimeout = vi.fn()
    const out = await webSearchLadder('q', {
      primary: primary(async () => [
        named('某公司发布新产品 Z9', 'https://budget3.example/x'),
        named('业界又有大动作了', 'https://budget4.example/x'),
      ]),
      readUrl: async () => ({ text: longBody('同一段通稿的正文内容在这里') }),
      foldBudgetMs: 5_000,
      onFoldTimeout,
    })
    expect(out.hits).toHaveLength(1)
    expect(onFoldTimeout).not.toHaveBeenCalled()
  })
})
