/**
 * 东方财富网上交易的 HTTP 客户端。**不开浏览器**——登录态由宿主注入（`ctx.cookieFor`），
 * 取数和下单全是普通的 JSON 接口。端点与字段序抄自站点自己的 JS，逐条注在下面。
 *
 * 浏览器只在**登录**那一步出场（`eastmoney-login.recipe.json`）：那一步要认图形验证码、
 * 要让站点的安全控件在页内自己算密码。会话一旦建立，剩下的全在这里，纯 HTTP。
 */

const BASE = 'https://jywg.eastmoneysec.com'
const TIMEOUT_MS = 15_000
/** 站点对纯接口不挑 UA，但给一个真实的省得撞上某天新加的粗筛。 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 服务端把会话踢了。调用方该重登，不该重试。 */
export class SessionExpired extends Error {}

export interface EastmoneySession {
  cookie: string
  validatekey: string
}

/**
 * 建立一次会话上下文：cookie 从宿主取，`validatekey` 从交易页的隐藏 input 里读。
 *
 * **`validatekey` 用纯 HTTP 取，不需要浏览器**（活体实测 2026-09-02：GET /Trade/Buy 带
 * cookie → 200、45KB、`em_validatekey` 36 位）。这一条是整条迁移的支点：先前那份登录态导出
 * 之所以要经浏览器读 DOM，是因为它跑在扩展那一侧，而不是因为这个值只有浏览器拿得到。
 *
 * 它同时就是**会话活没活着**的判据：会话没了，这个 GET 会 302 去 /Login，或者回一张带
 * `txtZjzh`（登录表单的账号框）的页面。两种都翻成 SessionExpired。
 */
export async function openSession(cookie: string): Promise<EastmoneySession> {
  const r = await fetch(`${BASE}/Trade/Buy`, {
    headers: { cookie, 'user-agent': UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (r.status === 301 || r.status === 302) {
    throw new SessionExpired(`会话已失效（${r.status} → ${r.headers.get('location') ?? '?'}）`)
  }
  if (!r.ok) throw new Error(`GET /Trade/Buy → ${r.status}`)
  const html = await r.text()
  if (html.includes('txtZjzh')) throw new SessionExpired('会话已失效（拿回来的是登录页）')
  const m = html.match(/id="em_validatekey"[^>]*value="([^"]+)"/)
    ?? html.match(/name="em_validatekey"[^>]*value="([^"]+)"/)
    ?? html.match(/value="([^"]+)"[^>]*em_validatekey/)
  if (!m) throw new SessionExpired('交易页里没有 em_validatekey——会话多半已失效')
  return { cookie, validatekey: m[1]! }
}

/**
 * 打一个交易接口。**只做 POST**——站点这一组接口全是 POST，`validatekey` 走 query。
 *
 * 302 → /Login 与「回来的是登录页而不是 JSON」都翻成 SessionExpired：会话过期在这条链路上
 * 有两种长相，只认其中一种的话，另一种会表现成一个莫名其妙的 JSON 解析错。
 */
export async function post<T = unknown>(
  s: EastmoneySession, path: string, form: Record<string, string> = {},
): Promise<T> {
  const r = await fetch(`${BASE}${path}?validatekey=${encodeURIComponent(s.validatekey)}`, {
    method: 'POST',
    headers: {
      cookie: s.cookie,
      'user-agent': UA,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
    },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (r.status === 301 || r.status === 302) {
    const loc = r.headers.get('location') ?? ''
    if (loc.includes('Login')) throw new SessionExpired(`会话已失效（302 → ${loc}）`)
    throw new Error(`POST ${path} → ${r.status} ${loc}`)
  }
  if (!r.ok) throw new Error(`POST ${path} → ${r.status}`)
  const text = await r.text()
  try {
    return JSON.parse(text) as T
  } catch {
    if (text.includes('txtZjzh') || text.includes('/Login')) {
      throw new SessionExpired(`会话已失效（${path} 回的是登录页）`)
    }
    throw new Error(`POST ${path} 回的不是 JSON（前 120 字：${text.slice(0, 120)}）`)
  }
}

// ── 申购日历 ────────────────────────────────────────────────────────────────

/**
 * 沪深主板 / 科创 / 创业新股。服务端回的是**逗号分隔的字符串数组**，下标含义抄自
 * `/Js/Trade/NewBuy_fullreg.js`（`data = stockDa[i].split(',')`）。只取这条链路真正用到的
 * 那几格——多抄一格就是多一个会漂的下标，而下标错了不报错，只是数字变得不对。
 */
const NEW_STOCK = {
  purchaseDate: 0, code: 1, name: 2, purchaseCode: 3,
  /** 你的可申购数（**万股**）——它已经算进了你的市值配额，所以是"顶格"那个数。 */
  youCanPurchaseWan: 7,
  issuePrice: 10,
  /** -1=结束 / 0=可申 / 2=已购 / 其他=待申（未来才开） */
  status: 14,
  market: 15,
} as const

export interface NewStock {
  purchaseDate: string
  code: string
  name: string
  purchaseCode: string
  youCanPurchaseShares: number
  issuePrice: number
  status: string
  market: string
}

const num = (v: string | undefined): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export interface NewStockList {
  availableFunds: number
  stocks: NewStock[]
}

export async function getNewStocks(s: EastmoneySession): Promise<NewStockList> {
  const resp = await post<{ NewStockList?: string[]; Kyzj?: string }>(s, '/Trade/GetNewStockListV3')
  return {
    availableFunds: num(resp.Kyzj),
    stocks: (resp.NewStockList ?? []).map((row) => {
      const f = row.split(',')
      return {
        purchaseDate: f[NEW_STOCK.purchaseDate] ?? '',
        code: f[NEW_STOCK.code] ?? '',
        name: f[NEW_STOCK.name] ?? '',
        purchaseCode: f[NEW_STOCK.purchaseCode] ?? '',
        // 接口给的是万股，下单要股数。整数化：这个数最终会进委托单的「数量」。
        youCanPurchaseShares: Math.round(num(f[NEW_STOCK.youCanPurchaseWan]) * 10_000),
        issuePrice: num(f[NEW_STOCK.issuePrice]),
        status: f[NEW_STOCK.status] ?? '',
        market: f[NEW_STOCK.market] ?? '',
      }
    }),
  }
}

export interface ConvertibleBond {
  purchaseDate: string
  purchaseCode: string
  name: string
  /** 可申购数量（张） */
  purchaseLimit: number
  parValue: number
  status: string
  market: string
}

/** 可转债。字段名抄自 `/Js/Trade/XzsgPurchase.js` 的 `getData()`——这一组是有名字的对象，
 *  不像新股那样按下标，所以漂的风险低得多。 */
export async function getConvertibleBonds(s: EastmoneySession): Promise<ConvertibleBond[]> {
  const resp = await post<{ Status?: number; Message?: string; Data?: Record<string, unknown>[] }>(
    s, '/Trade/GetConvertibleBondListV2',
  )
  if (resp.Status !== 0) throw new Error(`可转债列表：${resp.Message ?? `Status=${resp.Status}`}`)
  return (resp.Data ?? []).map((it) => ({
    purchaseDate: String(it.PURCHASEDATE ?? ''),
    purchaseCode: String(it.SUBCODE ?? ''),
    name: String(it.BONDNAME ?? ''),
    purchaseLimit: num(String(it.LIMITBUYVOL ?? '')),
    parValue: num(String(it.PARVALUE ?? '')) || 100,
    status: String(it.ExStatus ?? ''),
    market: String(it.Market ?? ''),
  }))
}

/** 北交所新股。这条链路**不申购**它（既有 python 也不申），只数一个数报在回执里——
 *  "今天北交所有几只"是人看的信息，不是这条任务的动作。 */
export async function countBseNewStocks(s: EastmoneySession): Promise<number> {
  const resp = await post<{ Status?: number; Data?: { Sublist?: unknown[] }[] }>(s, '/OtherTrade/SubscriptionList')
  if (resp.Status !== 0) return 0
  return (resp.Data ?? []).reduce((n, g) => n + (g.Sublist?.length ?? 0), 0)
}

// ── 下单 ────────────────────────────────────────────────────────────────────

export interface OrderResult {
  ok: boolean
  /** 委托编号。失败时空串。 */
  orderId: string
  /** 券商给的失败原因。成功时空串。 */
  message: string
}

/** 下单返回的统一解析。`Status===0` 才是成功——**别拿 HTTP 200 当成交**：券商拒单
 *  （没权限、超额、代码不存在）照样是 200，只是 `Status` 非 0、`Message` 里写着原因。 */
function parseOrder(resp: { Status?: number; Message?: string; Data?: { Wtbh?: string }[] }): OrderResult {
  if (resp.Status === 0) return { ok: true, orderId: resp.Data?.[0]?.Wtbh ?? '', message: '' }
  return { ok: false, orderId: '', message: resp.Message ?? `Status=${resp.Status}` }
}

export type Market = 'HA' | 'SA'

/**
 * 新股 / 新债申购。两者是**同一个端点、同一组字段**（抄自 `/Js/Trade/XzsgPurchase.js` 与
 * `/Js/Trade/NewBuy_fullreg.js` 的 data 构造段），只有代码和价格不同。
 *
 * ⚠ 这里的字段是 `market`（拼对的）。逆回购那条用的是 `marekt`（券商拼错了），**两条不能
 * 互抄**——抄错的表现是券商收下一个没有市场的委托，然后拒单，而拒单原因跟拼写毫无关系。
 */
export async function submitSubscribe(
  s: EastmoneySession,
  o: { code: string; price: number; amount: number; market: Market },
): Promise<OrderResult> {
  if (!Number.isInteger(o.amount) || o.amount <= 0) throw new Error(`申购数量必须是正整数，got ${o.amount}`)
  if (!(o.price > 0)) throw new Error(`申购价必须 >0，got ${o.price}`)
  return parseOrder(await post(s, '/Trade/SubmitTradeV2', {
    stockCode: o.code,
    price: String(o.price),
    amount: String(o.amount),
    tradeType: 'B',
    market: o.market,
  }))
}

/**
 * 国债逆回购（= 把闲钱融出去收利息）。
 *
 * ⚠ 字段名 `marekt` **不是笔误**——券商接口就是这个拼写，改成 `market` 它收不到。
 * `tradeType: '0S'` 是券商内部的"融券回购卖出"语义。
 */
export async function submitReverseRepo(
  s: EastmoneySession,
  o: { code: string; rate: number; qty: number; market: Market },
): Promise<OrderResult> {
  // 沪深都按 10 张一档（1 张 = 100 元面值）。不是 10 的倍数会被券商拒，但拒之前钱已经报出去了，
  // 而且拒单原因是一句看不出病因的话——本地挡住更便宜。
  if (!Number.isInteger(o.qty) || o.qty <= 0 || o.qty % 10 !== 0) {
    throw new Error(`逆回购张数必须是 >0 且 10 的倍数，got ${o.qty}`)
  }
  if (!(o.rate > 0)) throw new Error(`逆回购利率必须 >0，got ${o.rate}`)
  return parseOrder(await post(s, '/Trade/SubmitTradeV2', {
    stockCode: o.code,
    price: String(o.rate),
    amount: String(o.qty),
    tradeType: '0S',
    marekt: o.market,
  }))
}

// ── 撤单 ────────────────────────────────────────────────────────────────────

/** 一笔可撤委托。字段名是券商的原文（抄自 `/Js/Trade/Revoke.js`），不改名——撤单要把其中
 *  四个原样发回去，中间多一层译名只会多一处能漂的地方。 */
export interface RevocableOrder {
  Wtrq: string
  Wtbh: string
  Market: string
  Mmbz: string
  Zqdm?: string
  Zqmc?: string
  Mmsm?: string
  Wtsl?: string
  Wtjg?: string
}

/** 当前可撤委托。**新股申购天然不在里面**（申购不可撤），所以这条不会误撤掉今天刚申的。 */
export async function getRevocableOrders(s: EastmoneySession): Promise<RevocableOrder[]> {
  const resp = await post<{ Status?: number | string; Message?: string; Data?: RevocableOrder[] }>(
    s, '/Trade/queryRevocableWEBV1',
  )
  if (String(resp.Status) !== '0') throw new Error(`可撤委托：${resp.Message ?? `Status=${resp.Status}`}`)
  return resp.Data ?? []
}

/** 券商自己的批次大小（`Revoke.js` 里就是 40）。 */
const CANCEL_BATCH = 40

export interface CancelTally { ok: number; fail: number }

/** 批量撤单，40 笔一批——与站点自己的实现同一个数。 */
export async function batchCancel(s: EastmoneySession, orders: RevocableOrder[]): Promise<CancelTally> {
  const tally: CancelTally = { ok: 0, fail: 0 }
  for (let i = 0; i < orders.length; i += CANCEL_BATCH) {
    const chunk = orders.slice(i, i + CANCEL_BATCH).map((o) => ({
      wtrq: o.Wtrq, wtbh: o.Wtbh, market: o.Market, mmlb: o.Mmbz,
    }))
    const r = await fetch(`${BASE}/Trade/batchCancelStockWEB?validatekey=${encodeURIComponent(s.validatekey)}`, {
      method: 'POST',
      headers: {
        cookie: s.cookie, 'user-agent': UA,
        'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest',
      },
      body: JSON.stringify(chunk),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (r.status === 301 || r.status === 302) throw new SessionExpired('撤单途中会话失效')
    if (!r.ok) throw new Error(`批量撤单 → ${r.status}`)
    const body = await r.json() as { Status?: number; Data?: { successCount?: number; failCount?: number }[] }
    if (body.Status !== 0) throw new Error(`批量撤单：Status=${body.Status}`)
    tally.ok += body.Data?.[0]?.successCount ?? 0
    tally.fail += body.Data?.[0]?.failCount ?? 0
  }
  return tally
}

// ── 行情（逆回购要看买一价来报价）──────────────────────────────────────────

/**
 * 逆回购的买一价。**走券商自己的行情域，不走 push2.eastmoney.com**——本机网络对 push2 有
 * TCP 层拦截（多种 impersonate 都是 abrupt close，不是 JA3 的事），而这个域同一套数据、
 * 一直通。这条不是偏好，是既有实现踩过的坑（Cockpit 的 `dfcf/quotes.py` 头注）。
 *
 * 匿名可读，**不带 cookie**：它是公开行情，把登录态递给一个不需要它的域是白送风险。
 */
export async function getRepoBid1(code: string): Promise<number | null> {
  const r = await fetch(
    `https://emhsmarketwgmix.eastmoneysec.com/api/SHSZQuoteSnapshot?id=${encodeURIComponent(code)}`,
    { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) },
  )
  if (!r.ok) return null
  const j = await r.json() as { name?: string; fivequote?: Record<string, string> }
  if (!j.name) return null   // 券商的 not-found 形状：{code:10001, message:..., data:null}
  const v = Number(j.fivequote?.buy1)
  return Number.isFinite(v) && v > 0 ? v : null
}
