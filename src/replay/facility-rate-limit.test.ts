import { describe, expect, it } from 'vitest'
import { clampRateLimit, FacilityRateLimiter, RateLimitedError } from './facility-rate-limit.ts'
import { isEnvironmentUnavailable } from '../failure.ts'

// 站点封号的真实触发是**频率**，不是像不像人（2026-07-29 亲历：连续高频打 xhs detail →
// 登录墙。而拟人光标轨迹一直是开着的）。所以限速器的单位是「一次 recipe 运行」——一次
// 搜索、一次 detail、一次互动各算一次，因为那才是落到站点上的一次访问。
//
// 时间由外部注入：真实时钟的测试要么慢要么假绿（这台机器的单调时钟还偏快 7.6%）。
function harness(opts: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }) {
  let now = 0
  const sleeps: number[] = []
  const limiter = new FacilityRateLimiter(() => opts, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
  })
  return { limiter, sleeps, tick: (ms: number) => { now += ms } }
}

describe('FacilityRateLimiter', () => {
  it('放行 burst 之内的连续请求，一次都不等', async () => {
    const { limiter, sleeps } = harness({ burst: 3, perMinute: 6 })
    for (let i = 0; i < 3; i++) await limiter.take('xhs')
    expect(sleeps).toEqual([])
  })

  it('桶空了就等到下一个令牌 —— 这才是限速', async () => {
    // perMinute:6 → 每 10s 一个令牌
    const { limiter, sleeps } = harness({ burst: 2, perMinute: 6 })
    await limiter.take('xhs')
    await limiter.take('xhs')
    await limiter.take('xhs')
    expect(sleeps).toEqual([10_000])
  })

  it('等待期间攒下的令牌照常可用 —— 慢用户不该被罚', async () => {
    const { limiter, sleeps, tick } = harness({ burst: 3, perMinute: 6 })
    await limiter.take('xhs')
    tick(60_000) // 用户去干别的了
    for (let i = 0; i < 3; i++) await limiter.take('xhs')
    expect(sleeps).toEqual([]) // 桶被补满，三次全部即时放行
  })

  it('桶不会攒过 burst —— 放一天假不等于攒到无限次', async () => {
    const { limiter, sleeps, tick } = harness({ burst: 2, perMinute: 6 })
    tick(24 * 3600_000)
    await limiter.take('xhs')
    await limiter.take('xhs')
    await limiter.take('xhs')
    expect(sleeps).toEqual([10_000])
  })

  it('每个 facility 一个桶 —— 打爆小红书不该拖累抖音', async () => {
    const { limiter, sleeps } = harness({ burst: 1, perMinute: 6 })
    await limiter.take('xhs')
    await limiter.take('douyin')
    expect(sleeps).toEqual([])
  })

  it('要等太久就直接拒 —— 前台点一下不能挂在那里几分钟', async () => {
    const { limiter } = harness({ burst: 1, perMinute: 1, maxWaitMs: 5_000 })
    await limiter.take('xhs')
    // 下一个令牌要 60s，超过 maxWaitMs
    await expect(limiter.take('xhs')).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('拒的时候说清楚还要多久 —— UI 要能显示，不是一句 failed', async () => {
    const { limiter } = harness({ burst: 1, perMinute: 1, maxWaitMs: 5_000 })
    await limiter.take('xhs')
    const err = await limiter.take('xhs').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).facility).toBe('xhs')
    expect((err as RateLimitedError).retryAfterMs).toBe(60_000)
  })

  it('并发请求逐个排队，不会同时抢走同一个令牌', async () => {
    // 三个请求同时进来、桶里只有 1 个：必须串行放行（10s、20s），不能三个都当场过。
    const { limiter, sleeps } = harness({ burst: 1, perMinute: 6 })
    await Promise.all([limiter.take('xhs'), limiter.take('xhs'), limiter.take('xhs')])
    expect(sleeps).toEqual([10_000, 10_000])
  })

  it('被限速不是「源坏了」—— 它走 EnvironmentUnavailable 那条：什么都不记', async () => {
    // 限速时我们连标签都没开，命令根本没发出去，正是 EnvironmentUnavailableError 的判据。
    // 记成失败 = 用户手快点几下就把小红书点成红的、连点几次掉档，而源一点毛病没有。
    const { limiter } = harness({ burst: 1, perMinute: 1, maxWaitMs: 5_000 })
    await limiter.take('xhs')
    const err = await limiter.take('xhs').then(() => null, (e: unknown) => e)
    expect(isEnvironmentUnavailable(err)).toBe(true)
  })

  it('几条写腿声明同一个 bucket 就共用一份预算 —— 站点数的是账号一小时写了几次，不分上架还是编辑', async () => {
    let now = 0
    const limiter = new FacilityRateLimiter(() => undefined, { now: () => now, sleep: async (ms) => { now += ms } })
    const shared = { burst: 2, perMinute: 60, perHour: 2, bucket: 'goofish-write' }
    await limiter.take('goofish', { id: 'goofish-publish', limit: shared })
    await limiter.take('goofish', { id: 'goofish-edit', limit: shared })
    await expect(limiter.take('goofish', { id: 'goofish-polish', limit: shared })).rejects.toBeInstanceOf(RateLimitedError)
    // 没写 bucket 的腿还是各开各的桶，老行为一字不变。
    const own = { burst: 2, perMinute: 60, perHour: 2 }
    await limiter.take('goofish', { id: 'a', limit: own })
    await limiter.take('goofish', { id: 'a', limit: own })
    await limiter.take('goofish', { id: 'b', limit: own })
  })

  it('没配就不限速 —— 限速是每个 facility 自己声明的', async () => {
    const limiter = new FacilityRateLimiter(() => undefined)
    for (let i = 0; i < 50; i++) await limiter.take('anything')
  })
})

// 令牌桶管的是**瞬时形状**，而 Google 拦人数的是**累计量**：一小时约一百发之后稳定回
// /sorry/index。这一组钉的就是那条令牌桶按定义管不住的维度。
describe('FacilityRateLimiter — 长时窗累计预算 (perHour)', () => {
  it('完全合规地跑满 perMinute 一小时，照样会撞上 perHour —— 这正是令牌桶漏掉的那一维', async () => {
    // 真实形状：google 声明 burst 6 / perMinute 30 / perHour 100。假时钟跑满一小时，期间
    // **一次都没有超速**（每 2s 一发 = 正好 30 次/分）——令牌桶按定义一次都不会拒，一小时能放
    // 1800 发，比实测撞墙点高 18 倍。累计预算必须在一百出头的地方把它按住。
    const { limiter, sleeps, tick } = harness({ burst: 6, perMinute: 30, perHour: 100, maxWaitMs: 10_000 })
    let passed = 0
    let stoppedBy: unknown = null
    for (let i = 0; i < 1800; i++) {
      const e = await limiter.take('google').then(() => null, (err: unknown) => err)
      if (e) { stoppedBy = e; break }
      passed++
      tick(2_000)
    }
    expect(stoppedBy).toBeInstanceOf(RateLimitedError)
    expect(sleeps).toEqual([]) // 令牌桶全程没拒也没等：它管的那一维压根没被触碰
    // 100 的预算 + 期间连续回血（每 36s 一格）≈ 107 发，离 1800 差一个数量级。
    expect(passed).toBeGreaterThanOrEqual(100)
    expect(passed).toBeLessThan(120)
  })

  it('预算撞满就**立刻**抛，不等 maxWaitMs —— 等一小时是没有意义的', async () => {
    const { limiter, sleeps } = harness({ burst: 10, perMinute: 60, perHour: 3, maxWaitMs: 10_000 })
    for (let i = 0; i < 3; i++) await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    expect(sleeps).toEqual([]) // 一次都没睡：分钟闸门没空，撞的是小时预算
  })

  it('maxWaitMs 没声明也照样立刻抛 —— 长时窗预算不走「等」那条路', async () => {
    const { limiter, sleeps } = harness({ burst: 10, perMinute: 60, perHour: 2 })
    await limiter.take('google')
    await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    expect(sleeps).toEqual([])
  })

  it('拒的时候说清楚还要多久 —— 报的是等到下一格预算的时间', async () => {
    // perHour 100 → 每 36s 回一格。速率闸门开得极松，免得它的等待推着假时钟走、把预算补回来。
    const { limiter } = harness({ burst: 200, perMinute: 60_000, perHour: 100 })
    for (let i = 0; i < 100; i++) await limiter.take('google')
    const err = await limiter.take('google').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect((err as RateLimitedError).facility).toBe('google')
    expect((err as RateLimitedError).retryAfterMs).toBe(36_000)
  })

  it('预算按时间连续回血，不是整点清零 —— 等够一格就能再发一次', async () => {
    const { limiter, tick } = harness({ burst: 200, perMinute: 60_000, perHour: 100 })
    for (let i = 0; i < 100; i++) await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    tick(36_000)
    await limiter.take('google') // 回了一格
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('预算攒不过 perHour —— 闲置一整天不等于攒到两百发', async () => {
    const { limiter, tick } = harness({ burst: 10, perMinute: 60, perHour: 3 })
    tick(24 * 3600_000)
    for (let i = 0; i < 3; i++) await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('被限速不是「源坏了」—— 撞预算同样走 EnvironmentUnavailable 那条', async () => {
    const { limiter } = harness({ burst: 10, perMinute: 60, perHour: 1 })
    await limiter.take('google')
    const err = await limiter.take('google').then(() => null, (e: unknown) => e)
    expect(isEnvironmentUnavailable(err)).toBe(true)
  })

  it('被分钟闸门拒掉的那次不扣预算 —— 没发出去的请求不算在累计量里', async () => {
    // 预算只有 2 格。第 2 发被**分钟闸门**拒掉（下一个令牌要 60s > maxWaitMs），它连标签都没开，
    // 不该算进累计量。等分钟闸门让开之后，第 3 发靠的正是那格没被误扣的预算。
    const { limiter, tick } = harness({ burst: 1, perMinute: 1, perHour: 2, maxWaitMs: 5_000 })
    await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    tick(60_000) // 分钟桶回一格；小时预算这 60s 只回 0.03 格，补不出一发来
    await limiter.take('google') // 误扣过就会在这里撞预算
  })

  it('每个 facility 一份预算 —— 打爆 Google 不该顺手关掉百度', async () => {
    const { limiter } = harness({ burst: 10, perMinute: 60, perHour: 1 })
    await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    await limiter.take('baidu-search') // 另一个 facility，预算是它自己的
  })

  it('同一个进程里的所有调用方共用同一份预算 —— 两条会话各自「没超速」正是翻车那次的形状', async () => {
    // 这条钉的不是并发，是**共享**：桶挂在 limiter 上，谁调都扣同一份。
    const { limiter } = harness({ burst: 10, perMinute: 60, perHour: 4 })
    const sessionA = () => limiter.take('google')
    const sessionB = () => limiter.take('google')
    await sessionA(); await sessionA()
    await sessionB(); await sessionB()
    await expect(sessionA()).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('没声明 perHour 就没有累计上限 —— 老包的行为一字不变', async () => {
    const { limiter } = harness({ burst: 500, perMinute: 6000 })
    for (let i = 0; i < 300; i++) await limiter.take('xhs')
  })

  it('只声明 perHour、不声明速率 —— 累计预算照样生效', async () => {
    const { limiter } = harness({ burst: 0, perMinute: 0, perHour: 2 })
    await limiter.take('google')
    await limiter.take('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
  })
})

// 分享包驱动的是用户自己的登录态浏览器，限流是站点属性——同 facility 多个包同时声明
// rateLimit 时，不该由后加载的那个包说了算，必须取两份声明里最严的一份。
// 撞墙的意思就是站点认为我们这一小时打太多了，而桶里还剩多少是**我们自己的记账**。
// 不排空的话，冷却一过就按原速接着打——2026-08-13 活体正是这个形状。
describe('FacilityRateLimiter — 撞墙时排空小时预算', () => {
  it('排空之后原本还够的那几发被挡住，且回报出撞墙前这一小时发了几发', async () => {
    const { limiter } = harness({ burst: 10, perMinute: 60, perHour: 10 })
    for (let i = 0; i < 4; i++) await limiter.take('google')
    expect(limiter.drainBudget('google')).toBe(4)
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
  })

  it('排空不是永久锁死：小时桶照常连续回血，够冷却到期时那一次自然探测', async () => {
    // perHour 10 → 每 360s 回一格
    const { limiter, tick } = harness({ burst: 10, perMinute: 60, perHour: 10 })
    await limiter.take('google')
    limiter.drainBudget('google')
    await expect(limiter.take('google')).rejects.toBeInstanceOf(RateLimitedError)
    tick(361_000)
    await expect(limiter.take('google')).resolves.toBeUndefined()
  })

  it('没声明 perHour / 这轮进程一发都没经过 → undefined（"这项没记到"，不是 0）', () => {
    const noBudget = harness({ burst: 10, perMinute: 60 })
    expect(noBudget.limiter.drainBudget('google')).toBeUndefined()
    const untouched = harness({ burst: 10, perMinute: 60, perHour: 10 })
    expect(untouched.limiter.drainBudget('google')).toBeUndefined()
  })
})

describe('clampRateLimit', () => {
  it('takes the stricter of every field', () => {
    expect(clampRateLimit({ burst: 5, perMinute: 6, maxWaitMs: 15000 }, { burst: 10, perMinute: 3 }))
      .toEqual({ burst: 5, perMinute: 3, maxWaitMs: 15000 })
  })
  it('one side undefined → the other verbatim', () => {
    expect(clampRateLimit(undefined, { burst: 1, perMinute: 1 })).toEqual({ burst: 1, perMinute: 1 })
    expect(clampRateLimit({ burst: 1, perMinute: 1 }, undefined)).toEqual({ burst: 1, perMinute: 1 })
    expect(clampRateLimit(undefined, undefined)).toBeUndefined()
  })
  it('两侧 maxWaitMs 都是有限值且不同时，取更小的那个', () => {
    expect(clampRateLimit({ burst: 5, perMinute: 6, maxWaitMs: 15000 }, { burst: 9, perMinute: 9, maxWaitMs: 8000 }))
      .toEqual({ burst: 5, perMinute: 6, maxWaitMs: 8000 })
  })
  it('perHour 同样取更严的一份', () => {
    expect(clampRateLimit({ burst: 5, perMinute: 6, perHour: 200 }, { burst: 5, perMinute: 6, perHour: 100 }))
      .toEqual({ burst: 5, perMinute: 6, perHour: 100 })
  })
  it('只有一侧声明 perHour → 那一侧就是更严的（没声明 = 无上限）', () => {
    expect(clampRateLimit({ burst: 5, perMinute: 6 }, { burst: 5, perMinute: 6, perHour: 100 }))
      .toEqual({ burst: 5, perMinute: 6, perHour: 100 })
    expect(clampRateLimit({ burst: 5, perMinute: 6, perHour: 100 }, { burst: 5, perMinute: 6 }))
      .toEqual({ burst: 5, perMinute: 6, perHour: 100 })
  })
})

// ---------------------------------------------------------------------------
// 源级第二道闸（recipe 的 `meta.rateLimit`）
//
// 存在的理由是一个真实翻车：闲鱼这个 facility 上挂着两条节奏差一个数量级的腿——
// goofish-search 一次购买决策要连打 4–10 发（facility 闸 burst 12 就是为它定的），而
// goofish-publish 上架 15 分钟 6 发就把整站打成 404（2026-09-08 亲历，facility 闸一次都没拦）。
// 压 facility 闸能保护写腿，但会顺手把读腿压死。所以危险的那条腿自己再带一道。
// ---------------------------------------------------------------------------

/** 两道闸：facility 一份，源一份（由调用方随 recipe 递进来，不查表）。 */
function twoGate(facilityCfg?: { burst: number; perMinute: number; perHour?: number; maxWaitMs?: number }) {
  let now = 0
  const sleeps: number[] = []
  const limiter = new FacilityRateLimiter(() => facilityCfg, {
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms },
  })
  return { limiter, sleeps, tick: (ms: number) => { now += ms } }
}

describe('FacilityRateLimiter — 源自己那道闸', () => {
  // 这条和下面那条「facility 更严时它说了算」是**对照组**：源闸整个不接时它们照样绿。
  // 留着是为了钉另一个方向（源闸不许覆盖 facility 闸），别把它们当成源闸的覆盖率。
  it('不声明就是老行为：只有 facility 那道管得着', async () => {
    const { limiter, sleeps } = twoGate({ burst: 3, perMinute: 6 })
    for (let i = 0; i < 3; i++) await limiter.take('goofish', { id: 'goofish-search' })
    expect(sleeps).toEqual([])
  })

  it('写腿被自己那道压住时，同 facility 的读腿照常不受影响', async () => {
    // facility 松（burst 12），写腿严（burst 1，每 2 分钟 1 发）——正是闲鱼那两条腿的形状。
    const { limiter, sleeps } = twoGate({ burst: 12, perMinute: 20 })
    const publish = { id: 'goofish-publish', limit: { burst: 1, perMinute: 0.5 } }
    await limiter.take('goofish', publish)
    await limiter.take('goofish', publish) // 第二发要等 2 分钟
    expect(sleeps).toEqual([120_000])

    // 读腿此刻照常即时放行：它走的是自己那把尺子（没声明源闸）+ 还很宽的 facility 桶。
    sleeps.length = 0
    for (let i = 0; i < 3; i++) await limiter.take('goofish', { id: 'goofish-search' })
    expect(sleeps).toEqual([])
  })

  it('facility 那道更严时它说了算 —— 两道都要过，不是源闸覆盖', async () => {
    const { limiter, sleeps } = twoGate({ burst: 1, perMinute: 6 })
    const loose = { id: 'w', limit: { burst: 10, perMinute: 60 } }
    await limiter.take('goofish', loose)
    await limiter.take('goofish', loose)
    expect(sleeps).toEqual([10_000]) // 等的是 facility 那道（每 10s 一个）
  })

  it('源的小时预算撞满 → 立刻抛，且抛的是可被识别为「非故障」的那一类', async () => {
    const { limiter } = twoGate({ burst: 12, perMinute: 20 })
    const publish = { id: 'goofish-publish', limit: { burst: 2, perMinute: 60, perHour: 2 } }
    await limiter.take('goofish', publish)
    await limiter.take('goofish', publish)
    const err = await limiter.take('goofish', publish).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(isEnvironmentUnavailable(err)).toBe(true)
  })

  it('被一道拒掉时另一道不许扣账 —— 半拉子消费等于给没发生的访问记了账', async () => {
    // 源闸 perHour 1：第二发必被源闸拒。此时 facility 的分钟令牌不该被吃掉。
    const { limiter, sleeps } = twoGate({ burst: 2, perMinute: 6 })
    const publish = { id: 'w', limit: { burst: 5, perMinute: 60, perHour: 1 } }
    await limiter.take('goofish', publish)
    await expect(limiter.take('goofish', publish)).rejects.toBeInstanceOf(RateLimitedError)
    // facility 桶此刻应该还剩 1 个令牌（只被第一发扣过）——读腿拿得走，且不必等。
    await limiter.take('goofish', { id: 'r' })
    expect(sleeps).toEqual([])
  })

  it('不同源各有各的桶，互不啃对方的额度', async () => {
    const { limiter, sleeps } = twoGate({ burst: 12, perMinute: 60 })
    const a = { id: 'a', limit: { burst: 1, perMinute: 0.5 } }
    const b = { id: 'b', limit: { burst: 1, perMinute: 0.5 } }
    await limiter.take('goofish', a)
    await limiter.take('goofish', b)
    expect(sleeps).toEqual([]) // b 有自己的桶，没被 a 花掉
    // 反过来也要钉住：a 自己那只桶是**真的**被扣了。少了这一句，上面那行在「源闸压根没接」
    // 时也照样绿——一条不会失败的用例。
    await limiter.take('goofish', a)
    expect(sleeps).toEqual([120_000])
  })

  it('同名源在不同 facility 下也是两个桶', async () => {
    const { limiter, sleeps } = twoGate({ burst: 12, perMinute: 60 })
    const publish = { id: 'publish', limit: { burst: 1, perMinute: 0.5 } }
    await limiter.take('goofish', publish)
    await limiter.take('xianyu2', publish)
    expect(sleeps).toEqual([]) // 另一个 facility 下同名，不共用
    // 同上：再打一次同一个 facility，证明那只桶真在计数。
    await limiter.take('goofish', publish)
    expect(sleeps).toEqual([120_000])
  })

  it('撞墙排空预算时，源桶也一起清 —— 站点拦的是整个站点，不是某条腿', async () => {
    // facility 那道**故意不设 perHour**：这样"再打一发被拒"只可能来自源桶被清空，
    // 而不是被 facility 的预算顺手挡下的（那样这条用例在源闸没接时也会绿）。
    const { limiter } = twoGate({ burst: 12, perMinute: 60 })
    const publish = { id: 'goofish-publish', limit: { burst: 5, perMinute: 60, perHour: 5 } }
    await limiter.take('goofish', publish)
    // facility 没声明 perHour → 台账那一格如实回 undefined（"这项没记到"，不是 0）。
    expect(limiter.drainBudget('goofish')).toBeUndefined()
    // 但写腿手里那 4 发额度必须已经没了。
    await expect(limiter.take('goofish', publish)).rejects.toBeInstanceOf(RateLimitedError)
  })
})
