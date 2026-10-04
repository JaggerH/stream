/**
 * 东方财富的两条**会动钱**的任务：新股新债申购、撤单 + 全仓逆回购。
 *
 * 判路和数值全部照搬既有实现（Cockpit 的 `tasks/dfcf_subscribe.py` / `dfcf_repo.py`），逐条
 * 注在下面。**它们不是我重新想的**：那两条已经在真账户上跑了几个月，凡是与它们不一致的地方
 * 都得有理由。
 *
 * 这一层只依赖下面那个窄接口（`Broker`），不依赖 fetch——所以判路能在没有网络、没有账户的
 * 情况下被完整测出来。真实现是 `client.ts`。
 */
import type { TaskOutcome } from '../../src/tasks/types.ts'
import type {
  CancelTally, ConvertibleBond, Market, NewStockList, OrderResult, RevocableOrder,
} from './client.ts'

/** 这两条任务够得到的全部动作。**窄到只有它们真用的那几个**——多一个就是多一件测试要替身的东西。 */
export interface Broker {
  newStocks: () => Promise<NewStockList>
  convertibleBonds: () => Promise<ConvertibleBond[]>
  countBse: () => Promise<number>
  submitSubscribe: (o: { code: string; price: number; amount: number; market: Market }) => Promise<OrderResult>
  revocableOrders: () => Promise<RevocableOrder[]>
  batchCancel: (orders: RevocableOrder[]) => Promise<CancelTally>
  submitReverseRepo: (o: { code: string; rate: number; qty: number; market: Market }) => Promise<OrderResult>
  repoBid1: (code: string) => Promise<number | null>
}

export interface TradingOptions {
  /**
   * 武装了没有。**false = 空跑**：照常读、照常把"本该下什么单"算到底、照常写进回执，只是不发
   * 那一个提交请求。切换期就是靠它拿回执跟 python 那两条对同一天的结果。
   */
  live: boolean
  /** 现在几点（东八区）。测试注入；生产给真时钟。 */
  now: () => Date
  /** 撤单之后等资金释放。测试注入成立即返回。 */
  sleep: (ms: number) => Promise<void>
}

/** 今天可以申的。待申（未来才开）、已结束、已申购都不是这个值。 */
const CAN_SUBSCRIBE = '0'

/** 沪 / 深。代码前缀判market 只在券商没给 market 时兜底——它给了就用它给的。 */
function marketOf(given: string | undefined, code: string, shPrefixes: string[]): Market {
  if (given === 'HA' || given === 'SA') return given
  return shPrefixes.some((p) => code.startsWith(p)) ? 'HA' : 'SA'
}

export interface SubscribeRow {
  kind: 'bond' | 'stock'
  name: string
  code: string
  market: Market
  price: number
  amount: number
  status: 'ok' | 'dry' | 'fail'
  orderId?: string
  error?: string
}

/**
 * 09:45 顶格申购今天所有能申的新债和新股。
 *
 * 三条判路照搬既有实现，每条都防着一种具体的坏结果：
 * 1. **只对 `status==='0'` 的下单**。待申（未来才开）的债下过去会收到"无此证券代码"——一个
 *    看起来像故障的假失败，它会污染告警，让人以为链路坏了。
 * 2. **新股按 `you_can_purchase` 下**，那个数已经是券商按你的市值配额算好的顶格数；自己算
 *    会算错，而超额的后果是整笔被拒。
 * 3. **任何一笔失败就整条任务标红**（抛）。券商拒单（比如没有可转债权限）如果被吞成绿灯，
 *    调度中心上就是一片常绿，而你以为申了、其实一笔都没申。
 */
export async function runSubscribe(b: Broker, opts: TradingOptions): Promise<TaskOutcome> {
  const [ipo, bonds, bseCount] = await Promise.all([b.newStocks(), b.convertibleBonds(), b.countBse()])
  const rows: SubscribeRow[] = []

  for (const cb of bonds) {
    if (cb.status !== CAN_SUBSCRIBE || cb.purchaseLimit <= 0) continue
    rows.push(await submitOne(b, opts, {
      kind: 'bond', name: cb.name, code: cb.purchaseCode,
      // 可转债：沪市申购码 7/11/13/118 打头，其余深市。
      market: marketOf(cb.market, cb.purchaseCode, ['7', '11', '13', '118']),
      price: cb.parValue, amount: cb.purchaseLimit,
    }))
  }

  for (const st of ipo.stocks) {
    if (st.status !== CAN_SUBSCRIBE) continue
    // 没配到市值（可申购数为 0）或者没有发行价，都不是失败，是"轮不到你"。跳过，不记一行。
    if (st.youCanPurchaseShares <= 0 || st.issuePrice <= 0) continue
    rows.push(await submitOne(b, opts, {
      kind: 'stock', name: st.name, code: st.purchaseCode,
      // 新股：沪市申购码 7/9 打头，其余深市。
      market: marketOf(st.market, st.purchaseCode, ['7', '9']),
      price: st.issuePrice, amount: st.youCanPurchaseShares,
    }))
  }

  const failed = rows.filter((r) => r.status === 'fail')
  const outcome: TaskOutcome = {
    summary: summarize(rows, opts.live, ipo.availableFunds, bseCount),
    detail: { live: opts.live, availableFunds: ipo.availableFunds, bseCount, rows },
  }
  if (failed.length) {
    // 回执塞进 error 一起抛：失败路径下调度中心留下的只有这条消息，`detail` 到不了账本。
    throw Object.assign(
      new Error(`申购失败 ${failed.length} 笔 — ${failed.map((r) => `${r.name}(${r.code}): ${r.error}`).join('; ')}`),
      { outcome },
    )
  }
  return outcome
}

async function submitOne(
  b: Broker, opts: TradingOptions,
  o: { kind: 'bond' | 'stock'; name: string; code: string; market: Market; price: number; amount: number },
): Promise<SubscribeRow> {
  if (!opts.live) return { ...o, status: 'dry' }
  try {
    const r = await b.submitSubscribe({ code: o.code, price: o.price, amount: o.amount, market: o.market })
    return r.ok
      ? { ...o, status: 'ok', orderId: r.orderId }
      : { ...o, status: 'fail', error: r.message }
  } catch (e) {
    return { ...o, status: 'fail', error: (e as Error).message }
  }
}

function summarize(rows: SubscribeRow[], live: boolean, funds: number, bseCount: number): string {
  const money = funds.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const tail = bseCount ? `；北交所另有 ${bseCount} 只（本任务不申）` : ''
  if (!rows.length) return `${live ? '' : '空跑：'}今日无可申标的（可用资金 ${money}）${tail}`
  const parts = rows.map((r) => {
    const unit = r.kind === 'bond' ? '张' : '股'
    const mark = r.status === 'ok' ? '✓' : r.status === 'dry' ? '○' : '✗'
    const why = r.status === 'fail' ? `（${r.error}）` : ''
    return `${mark} ${r.name} ${r.amount}${unit}${why}`
  })
  return `${live ? '' : '空跑：'}${rows.length} 笔 — ${parts.join('，')}（可用资金 ${money}）${tail}`
}

// ── 撤单 + 全仓逆回购 ───────────────────────────────────────────────────────

/** 沪市 GC001 / 深市 R-001，一天期。哪边买一价高就走哪边。 */
const GC001 = '204001'
const R001 = '131810'
/** 过了这个点就别下逆回购了——尾盘的成交不确定，钱卡在半路比不做更糟。 */
const REPO_CUTOFF_MINUTES = 15 * 60 + 25
/** 低于这个金额不值当（一档是 1000 元）。 */
const MIN_FUNDS = 1000
/** 撤单之后等资金回到可用余额。既有实现等 3 秒。 */
const FUNDS_RELEASE_MS = 3000

export interface RepoDetail {
  live: boolean
  cancelled: number
  cancelFailed: number
  repo?: { name: string; code: string; rate: number; qty: number; orderId?: string }
  /** 没做逆回购时说清是**哪一种**没做——三种的处置完全不同，混成一句"未执行"就没法分诊。 */
  skipped?: 'past-cutoff' | 'low-funds' | 'no-quote'
}

/**
 * 14:55 撤掉全部挂单，把释放出来的钱全仓买入一天期国债逆回购。
 *
 * 顺序不能换：**先撤单、等钱回来、再读可用资金**。反过来读到的是撤单前的余额，逆回购就会
 * 少下一大截——而且这个错不会报错，只是当天少赚一点，没人会发现。
 */
export async function runRepo(b: Broker, opts: TradingOptions): Promise<TaskOutcome> {
  const now = opts.now()
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (opts.live && minutes > REPO_CUTOFF_MINUTES) {
    const detail: RepoDetail = { live: true, cancelled: 0, cancelFailed: 0, skipped: 'past-cutoff' }
    return { summary: '已过 15:25，未下单', detail }
  }

  const orders = await b.revocableOrders()
  let tally: CancelTally = { ok: 0, fail: 0 }
  if (orders.length && opts.live) {
    tally = await b.batchCancel(orders)
    await opts.sleep(FUNDS_RELEASE_MS)
  }

  const funds = (await b.newStocks()).availableFunds
  const money = funds.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const head = `${opts.live ? '' : '空跑：'}撤单 ${opts.live ? tally.ok : orders.length} 笔`

  const base: RepoDetail = { live: opts.live, cancelled: opts.live ? tally.ok : orders.length, cancelFailed: tally.fail }

  if (funds < MIN_FUNDS) {
    return {
      summary: `${head}；可用资金 ${money} < ${MIN_FUNDS}，未做逆回购`,
      detail: { ...base, skipped: 'low-funds' } satisfies RepoDetail,
    }
  }

  const [gc, r001] = await Promise.all([b.repoBid1(GC001), b.repoBid1(R001)])
  if (gc === null && r001 === null) {
    return {
      summary: `${head}；两市都拿不到买一价，未做逆回购`,
      detail: { ...base, skipped: 'no-quote' } satisfies RepoDetail,
    }
  }
  const pick = (r001 ?? 0) > (gc ?? 0)
    ? { code: R001, market: 'SA' as Market, name: 'R-001', rate: r001! }
    : { code: GC001, market: 'HA' as Market, name: 'GC001', rate: gc! }
  // 一档 = 10 张 = 1000 元面值。向下取整到整档，余数留在账上。
  const qty = Math.floor(funds / 1000) * 10
  const yuan = (qty * 100).toLocaleString('zh-CN')

  if (!opts.live) {
    return {
      summary: `${head}；空跑：${pick.name} ${pick.rate}% × ${qty} 张 ≈ ${yuan} 元（可用资金 ${money}）`,
      detail: { ...base, repo: { ...pick, qty } } satisfies RepoDetail,
    }
  }

  const r = await b.submitReverseRepo({ code: pick.code, rate: pick.rate, qty, market: pick.market })
  const detail: RepoDetail = {
    ...base,
    repo: { ...pick, qty, ...(r.ok ? { orderId: r.orderId } : {}) },
  }
  if (!r.ok) {
    // 同上：失败路径只剩这条消息，把回执挂上去。
    throw Object.assign(new Error(`${head}；逆回购失败：${r.message}`), {
      outcome: { summary: `${head}；逆回购失败：${r.message}`, detail },
    })
  }
  return {
    summary: `${head}；逆回购 ${pick.name} ${pick.rate}% × ${qty} 张 ≈ ${yuan} 元 委托号 ${r.orderId}`,
    detail,
  }
}
