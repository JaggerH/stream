import { describe, it, expect, vi } from 'vitest'
import { runRepo, runSubscribe, type Broker, type TradingOptions } from './trading.ts'
import type { ConvertibleBond, NewStock, RevocableOrder } from './client.ts'

/**
 * 这两条任务会动真钱，所以判路必须在没有网络、没有账户的情况下被完整测出来。
 * 每条断言背后都是 Cockpit 那两条 python 任务已经在真账户上验过的行为——不一致的地方要有理由。
 */

const bond = (o: Partial<ConvertibleBond> = {}): ConvertibleBond => ({
  purchaseDate: '2026-09-02', purchaseCode: '370001', name: '某某转债',
  purchaseLimit: 10, parValue: 100, status: '0', market: '', ...o,
})

const stock = (o: Partial<NewStock> = {}): NewStock => ({
  purchaseDate: '2026-09-02', code: '601001', name: '某某股份', purchaseCode: '780001',
  youCanPurchaseShares: 16000, issuePrice: 12.5, status: '0', market: '', ...o,
})

function mkBroker(over: Partial<Broker> = {}, funds = 50_000): Broker {
  return {
    newStocks: async () => ({ availableFunds: funds, stocks: [] }),
    convertibleBonds: async () => [],
    countBse: async () => 0,
    submitSubscribe: async () => ({ ok: true, orderId: 'W1', message: '' }),
    revocableOrders: async () => [],
    batchCancel: async () => ({ ok: 0, fail: 0 }),
    submitReverseRepo: async () => ({ ok: true, orderId: 'R1', message: '' }),
    repoBid1: async () => 1.2,
    ...over,
  }
}

const opts = (over: Partial<TradingOptions> = {}): TradingOptions => ({
  live: true,
  now: () => new Date('2026-09-02T14:55:00+08:00'),
  sleep: async () => {},
  ...over,
})

describe('runSubscribe', () => {
  it('顶格申购今天可申的债和股', async () => {
    const submit = vi.fn<Broker['submitSubscribe']>(async () => ({ ok: true, orderId: 'W9', message: '' }))
    const b = mkBroker({
      convertibleBonds: async () => [bond({ purchaseLimit: 10, parValue: 100, purchaseCode: '370001' })],
      newStocks: async () => ({ availableFunds: 1000, stocks: [stock({ youCanPurchaseShares: 16000, issuePrice: 12.5, purchaseCode: '780001' })] }),
      submitSubscribe: submit,
    })
    const out = await runSubscribe(b, opts())
    expect(submit).toHaveBeenCalledTimes(2)
    // 债按张、价用面值；股按可申购股数、价用发行价。
    expect(submit.mock.calls[0]![0]).toEqual({ code: '370001', price: 100, amount: 10, market: 'SA' })
    expect(submit.mock.calls[1]![0]).toEqual({ code: '780001', price: 12.5, amount: 16000, market: 'HA' })
    expect(out.summary).toContain('2 笔')
  })

  // 待申（未来才开）的债下过去会收到"无此证券代码"——一个看起来像故障的假失败，它会污染告警。
  it('只对 status=0 的下单：待申 / 已结束 / 已申购全跳过', async () => {
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({
      convertibleBonds: async () => [bond({ status: '1' }), bond({ status: '-1' }), bond({ status: '2' })],
      submitSubscribe: submit,
    })
    const out = await runSubscribe(b, opts())
    expect(submit).not.toHaveBeenCalled()
    expect(out.summary).toContain('无可申标的')
  })

  it('额度为 0 / 没配到市值 / 没有发行价 ⇒ 跳过，不算失败', async () => {
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({
      convertibleBonds: async () => [bond({ purchaseLimit: 0 })],
      newStocks: async () => ({ availableFunds: 0, stocks: [
        stock({ youCanPurchaseShares: 0 }), stock({ issuePrice: 0 }),
      ] }),
      submitSubscribe: submit,
    })
    await expect(runSubscribe(b, opts())).resolves.toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
  })

  // 券商拒单（比如没有可转债权限）被吞成绿灯的话，调度中心上一片常绿，而你以为申了、其实没申。
  it('任一笔失败 ⇒ 整条任务抛（标红），消息里点名是哪一笔', async () => {
    const b = mkBroker({
      convertibleBonds: async () => [bond({ name: '甲转债' }), bond({ name: '乙转债', purchaseCode: '370002' })],
      submitSubscribe: async (o) => o.code === '370002'
        ? { ok: false, orderId: '', message: '无可转债交易权限' }
        : { ok: true, orderId: 'W1', message: '' },
    })
    await expect(runSubscribe(b, opts())).rejects.toThrow(/乙转债.*无可转债交易权限/)
  })

  it('提交本身抛异常也算这一笔失败，不掀翻另一笔', async () => {
    const b = mkBroker({
      convertibleBonds: async () => [bond({ name: '甲转债' })],
      submitSubscribe: async () => { throw new Error('connect ETIMEDOUT') },
    })
    await expect(runSubscribe(b, opts())).rejects.toThrow(/ETIMEDOUT/)
  })

  // 空跑是切换期的主力形态：照常算到底、照常写回执，就是不发那一个请求。
  it('未武装 ⇒ 一个提交都不发，但回执里算出了本该下的单', async () => {
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({
      convertibleBonds: async () => [bond({ name: '甲转债', purchaseLimit: 10 })],
      submitSubscribe: submit,
    })
    const out = await runSubscribe(b, opts({ live: false }))
    expect(submit).not.toHaveBeenCalled()
    expect(out.summary).toContain('空跑')
    expect(out.summary).toContain('甲转债 10张')
    expect((out.detail as { rows: { status: string }[] }).rows[0]!.status).toBe('dry')
  })

  it('北交所只报个数，不申购', async () => {
    const b = mkBroker({ countBse: async () => 3 })
    const out = await runSubscribe(b, opts())
    expect(out.summary).toContain('北交所另有 3 只（本任务不申）')
  })
})

const order = (o: Partial<RevocableOrder> = {}): RevocableOrder => ({
  Wtrq: '20260902', Wtbh: '123', Market: 'HA', Mmbz: 'B', ...o,
})

describe('runRepo', () => {
  it('先撤单、等钱回来、再读可用资金 —— 顺序不能换', async () => {
    const seq: string[] = []
    const b = mkBroker({
      revocableOrders: async () => { seq.push('query'); return [order()] },
      batchCancel: async () => { seq.push('cancel'); return { ok: 1, fail: 0 } },
      newStocks: async () => { seq.push('funds'); return { availableFunds: 50_000, stocks: [] } },
    })
    await runRepo(b, opts({ sleep: async () => { seq.push('sleep') } }))
    // 反过来读到的是撤单前的余额，逆回购会少下一大截——而且不报错，只是当天少赚一点。
    expect(seq).toEqual(['query', 'cancel', 'sleep', 'funds'])
  })

  it('买一价高的那一边胜出，张数向下取整到整档', async () => {
    const submit = vi.fn<Broker['submitReverseRepo']>(async () => ({ ok: true, orderId: 'R7', message: '' }))
    const b = mkBroker({
      // 深市 R-001 报得高 ⇒ 走深市。
      repoBid1: async (code) => (code === '131810' ? 1.9 : 1.2),
      newStocks: async () => ({ availableFunds: 55_171.34, stocks: [] }),
      submitReverseRepo: submit,
    })
    const out = await runRepo(b, opts())
    // 55171.34 → 55 档 → 550 张 → 55,000 元；余下的 171.34 留在账上。
    expect(submit).toHaveBeenCalledWith({ code: '131810', rate: 1.9, qty: 550, market: 'SA' })
    expect(out.summary).toContain('R-001')
    expect(out.summary).toContain('550 张')
    expect(out.summary).toContain('委托号 R7')
  })

  it('两边一样高 ⇒ 走沪市 GC001', async () => {
    const submit = vi.fn<Broker['submitReverseRepo']>(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({ repoBid1: async () => 1.5, submitReverseRepo: submit })
    await runRepo(b, opts())
    expect(submit.mock.calls[0]![0]).toMatchObject({ code: '204001', market: 'HA' })
  })

  it('一边拿不到报价 ⇒ 用另一边，不是整条放弃', async () => {
    const submit = vi.fn<Broker['submitReverseRepo']>(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({
      repoBid1: async (code) => (code === '204001' ? null : 1.3),
      submitReverseRepo: submit,
    })
    await runRepo(b, opts())
    expect(submit.mock.calls[0]![0]).toMatchObject({ code: '131810', rate: 1.3 })
  })

  it('两边都拿不到报价 ⇒ 不下单，且说清是哪一种没做', async () => {
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({ repoBid1: async () => null, submitReverseRepo: submit })
    const out = await runRepo(b, opts())
    expect(submit).not.toHaveBeenCalled()
    expect((out.detail as { skipped?: string }).skipped).toBe('no-quote')
  })

  it('可用资金不足一档 ⇒ 不下单', async () => {
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({ newStocks: async () => ({ availableFunds: 999, stocks: [] }), submitReverseRepo: submit })
    const out = await runRepo(b, opts())
    expect(submit).not.toHaveBeenCalled()
    expect((out.detail as { skipped?: string }).skipped).toBe('low-funds')
  })

  // 尾盘的成交不确定，钱卡在半路比不做更糟。
  it('过了 15:25 ⇒ 什么都不做（连撤单都不做）', async () => {
    const cancel = vi.fn(async () => ({ ok: 0, fail: 0 }))
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({ revocableOrders: async () => [order()], batchCancel: cancel, submitReverseRepo: submit })
    const out = await runRepo(b, opts({ now: () => new Date('2026-09-02T15:26:00+08:00') }))
    expect(cancel).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect((out.detail as { skipped?: string }).skipped).toBe('past-cutoff')
  })

  // cutoff 只在武装时挡。空跑随时能跑，否则"想对一下今天会下什么单"永远得等到明天开盘。
  it('未武装 ⇒ 不受 cutoff 限制，也不撤单、不下单，但算出了本该下的', async () => {
    const cancel = vi.fn(async () => ({ ok: 0, fail: 0 }))
    const submit = vi.fn(async () => ({ ok: true, orderId: '', message: '' }))
    const b = mkBroker({
      revocableOrders: async () => [order(), order({ Wtbh: '124' })],
      batchCancel: cancel, submitReverseRepo: submit,
      newStocks: async () => ({ availableFunds: 20_000, stocks: [] }),
    })
    const out = await runRepo(b, opts({ live: false, now: () => new Date('2026-09-02T23:00:00+08:00') }))
    expect(cancel).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()
    expect(out.summary).toContain('撤单 2 笔')
    expect(out.summary).toContain('200 张')
    expect((out.detail as { repo?: { qty: number } }).repo?.qty).toBe(200)
  })

  it('逆回购被拒 ⇒ 抛（标红），消息里带券商说的原因', async () => {
    const b = mkBroker({ submitReverseRepo: async () => ({ ok: false, orderId: '', message: '资金不足' }) })
    await expect(runRepo(b, opts())).rejects.toThrow(/逆回购失败：资金不足/)
  })
})
