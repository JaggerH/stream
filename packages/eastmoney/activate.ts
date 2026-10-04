/**
 * 东方财富包的代码槽位：交出三个**动作**，不交定时任务。
 *
 * 什么时候跑、跑不跑、用哪一格账号、要不要真下单——全是**用户定时任务行**的事（住 db，
 * 界面上改，改完不用重启）。这个包只回答"能干什么"。判据见 `src/tasks/package-actions.ts`
 * 与 `src/tasks/task-store.ts` 的头注（业务任务入库、运维任务留代码）。
 *
 * 参数从调用它的那条任务绑定的配置 row 来（`eastmoney` 那格：资金账号 / 交易密码 / 真下单），
 * 不从 argv、不从 env、也不从 config.yaml。
 */
import type { ActivateFn, PluginContext } from '../../src/packages/activate.ts'
import type { TaskOutcome } from '../../src/tasks/types.ts'
import {
  batchCancel, countBseNewStocks, getConvertibleBonds, getNewStocks, getRepoBid1,
  getRevocableOrders, openSession, SessionExpired, submitReverseRepo, submitSubscribe,
} from './client.ts'
import { runRepo, runSubscribe, type Broker } from './trading.ts'

const DOMAIN = 'eastmoneysec.com'

/** 今天可以申的（status='0'）——待申（未来才开）、已结束、已申购都不算。 */
const CAN_SUBSCRIBE = '0'

/** 这个包的 facility 名。宿主按它找登录 recipe（那条 recipe 的 `session.facility` 是同一个字）。 */
const FACILITY = 'eastmoney'

async function openOnce(ctx: PluginContext) {
  const cookie = await ctx.cookieFor(DOMAIN)
  if (!cookie) throw new SessionExpired(`没有 ${DOMAIN} 的登录态`)
  return await openSession(cookie)
}

/**
 * 建立一次会话；**会话没了就让宿主去登，然后只重做建会话这一步**。
 *
 * 券商的交易会话最长 3 小时（登录页那三个单选的上限），所以"掉了"是常态而不是异常：
 * 09:40 的日历、09:45 的申购、14:55 的逆回购，跨过午休就必然掉一次。以前这里只是抛一句
 * "先跑一次 eastmoney-login" 给人看——2026-09-03 早上三条任务因此全红，而登录 recipe 明明
 * 就在那儿、一次都没被调用过。
 *
 * **重试只圈住 `openOnce`，不圈住动作本身。** 这一段没有任何副作用（一次 GET /Trade/Buy
 * 加一次正则），重做一遍是安全的；而申购 / 逆回购那半**不能**这么重来——一个已经下过一半单
 * 的动作被自动重跑就是重复下单。这也是宿主刻意不替包做"失败了整个重跑"的原因：那件事安不
 * 安全只有包知道（见 `PluginContext.login` 头注）。
 *
 * **只重来一次。** 登回来了还是 302，说明问题不在会话（账号被风控、站点在维护），再登一次
 * 只是多敲一次券商的登录接口——而"连续失败登录"在券商那边是有后果的。
 */
async function session(ctx: PluginContext) {
  try {
    return await openOnce(ctx)
  } catch (e) {
    if (!(e instanceof SessionExpired)) throw e
    ctx.log(`交易会话已失效，去登录一次：${e.message}`)
    await ctx.login(FACILITY)
    return await openOnce(ctx)
  }
}

/** 把一次会话包成 `trading.ts` 要的那个窄接口。**每次跑建一次**——会话最长 3 小时（登录页那
 *  三个单选的上限，活体 2026-09-03：15分钟 / 30分钟 / 3小时），存成模块级的东西等于把一个会
 *  过期的答案冻住（`validatekey` 也随之作废）。 */
async function broker(ctx: PluginContext): Promise<Broker> {
  const s = await session(ctx)
  return {
    newStocks: () => getNewStocks(s),
    convertibleBonds: () => getConvertibleBonds(s),
    countBse: () => countBseNewStocks(s),
    submitSubscribe: (o) => submitSubscribe(s, o),
    revocableOrders: () => getRevocableOrders(s),
    batchCancel: (orders) => batchCancel(s, orders),
    submitReverseRepo: (o) => submitReverseRepo(s, o),
    repoBid1: (code) => getRepoBid1(code),
  }
}

/**
 * 武装了没有——由**这条任务绑的那格配置 row** 回答（`trading` 字段，界面上一个复选框）。
 *
 * **缺省 false**：没勾 = 空跑。这条不能反过来，"忘了配"必须等于"不下单"。
 * 判据只认真布尔：row 的 schema 是 `Schema.boolean()`，所以这里不做 `'true'` 之类的字符串
 * 宽容——宽容的代价是 `'false'` 这个字符串会被判成真。
 */
const armed = (params: Record<string, unknown>): boolean => params.trading === true

const clock = { now: () => new Date(), sleep: (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) }) }

/**
 * 看一眼今天有什么可申的。**只发查询，不下任何单**，跟 `trading` 那一格无关。
 *
 * 用处是在还来得及的时候确认会话活着：会话最长 3 小时，跨过午休必然掉一次，而"申购那一刻
 * 才发现没登录"没有补救余地。所以它通常被排在申购那条之前几分钟。**它自己也会触发自动登录**
 * （走 `session()`），所以排在前面这件事现在既是探针也是预热。
 */
async function calendar(ctx: PluginContext): Promise<TaskOutcome> {
  const s = await session(ctx)
  const [ipo, cbs] = await Promise.all([getNewStocks(s), getConvertibleBonds(s)])
  const stocks = ipo.stocks.filter((x) => x.status === CAN_SUBSCRIBE && x.youCanPurchaseShares > 0)
  const bonds = cbs.filter((x) => x.status === CAN_SUBSCRIBE && x.purchaseLimit > 0)
  const funds = ipo.availableFunds.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
  const names = [...bonds.map((b) => b.name), ...stocks.map((x) => x.name)]
  return {
    summary: names.length
      ? `今日可申 ${names.length} 笔：${names.join('、')}（可用资金 ${funds}）`
      : `今日无可申标的（可用资金 ${funds}）`,
    detail: {
      availableFunds: ipo.availableFunds,
      stocks: stocks.map((x) => ({
        name: x.name, purchaseCode: x.purchaseCode,
        shares: x.youCanPurchaseShares, price: x.issuePrice, market: x.market,
      })),
      bonds: bonds.map((b) => ({
        name: b.name, purchaseCode: b.purchaseCode,
        lots: b.purchaseLimit, price: b.parValue, market: b.market,
      })),
    },
  }
}

export const activate: ActivateFn = (ctx) => ({
  actions: {
    calendar: () => calendar(ctx),
    subscribe: async (params) => await runSubscribe(await broker(ctx), { live: armed(params), ...clock }),
    repo: async (params) => await runRepo(await broker(ctx), { live: armed(params), ...clock }),
  },
})
