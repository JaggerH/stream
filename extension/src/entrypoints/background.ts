import { runSync } from '../lib/sync.ts'
import { getConfig, matchesSyncedDomain, mergeDomains } from '../lib/config.ts'
import { startExtCdp, isRelayUp, forceReconnect } from '../lib/driver.ts'
import { keepDevReloadAlive } from '../lib/dev-reload.ts'

/**
 * 曾经有一个 `cookie-sync` 周期闹钟（默认 30 分钟）在这儿定时把 cookie 推给 Stream。
 * **别加回来。** 它存在的理由是"扩展不知道后端什么时候要用登录态，只能按时间猜"——
 * 而 direct 档已经反过来了：后端自己来取（`op:'cookiePull'`），它在三个真正的时机取，
 * 每个都比猜准：中继一连上（Chrome 刚起，快照最旧）、动手采集前发现手里那份太旧、
 * 以及扩展报「同步域里的 cookie 变了」的时候。
 *
 * 周期推唯一还剩的作用是兜底"错过了变更事件"，而它的代价是把最坏延迟钉死在一整个周期上：
 * 夸克 cookie 轮换之后干等 30 分钟、期间每次取流都 412——这正是要修的那件事。
 */
const ALARM_RETIRED = 'cookie-sync'

export default defineBackground(() => {
  // dev 期的自愈热重载通道。必须自己开一条：WXT 自带那条断了不重连，而我们这个扩展常驻一条
  // relay WS、SW 永不回收，等不到"SW 重启顺带重连"那条自愈路径（详见 dev-reload.ts 头注）。
  // 生产构建里这个分支被静态消除。
  if (import.meta.env.DEV) keepDevReloadAlive()

  // 老版本装过那个周期闹钟；alarms 是持久的，光删代码不会让已经排上的那一个消失。
  void chrome.alarms.clear(ALARM_RETIRED)

  // CDP transport：连后端 ext-relay，在原生 profile 的自动化 tab 上执行后端下发的 CDP 命令。
  void startExtCdp().catch(console.error)

  // Chrome 一起来就连中继，别等下一个 alarm。
  //
  // 采集搬到用户自己的 Chrome 之后，「浏览器活着」是定时采集的前提，而"活着"必须包含
  // **relay 已连**——Chrome 起来了但 SW 没醒，后端照样采不了。在此之前唯一的自动唤醒是
  // cookie-sync alarm 顺带把 MV3 SW 叫醒，所以就绪最多滞后一整个 alarm 周期。
  //
  // 注册这个监听器本身就是承重的：MV3 的 SW 只因事件而启动，有了 onStartup 监听，浏览器
  // 启动时 Chrome 才会来叫醒我们。SW 一启动顶层那行也会跑，所以这里其实是同一件事的第二个
  // 入口——`startExtCdp` 已按 SW 实例去重，重复调用不会开出第二条连接。
  chrome.runtime.onStartup.addListener(() => {
    void startExtCdp().catch(console.error)
  })

  // 配置一变就丢掉同步域缓存（下面那个 cookie 变更门要用它）。
  let domainsCache: string[] | undefined
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.config) domainsCache = undefined
  })

  // cookie 一变就同步（去抖 5s），新登录几秒内就生效。**周期闹钟撤掉之后这条是唯一的触发**
  // （另外两个时机在后端那边：中继连上、动手采集前发现快照太旧）。
  // 门必须按同步域开：没有门的话，正常浏览时任何网站的 cookie 抖动都会触发一轮（2026-07-23
  // 活体观察到几秒一次）——以前有闹钟兜底还只是浪费，现在它是唯一触发，更不能让它被噪声淹掉。
  let t: ReturnType<typeof setTimeout> | undefined
  chrome.cookies.onChanged.addListener((info) => {
    void (async () => {
      // 门要按**实际同步的范围**开，而不是只按用户自填的那几个：Stream 声明需要的域
      // （requiredDomains，上次同步缓存下来的）也会被推上去，漏进这个门就等于"新登录的
      // 夸克 cookie 不触发同步"，只能干等下一个 alarm。
      if (!domainsCache) {
        const cfg = await getConfig()
        domainsCache = mergeDomains(cfg.domains, cfg.requiredDomains ?? [])
      }
      if (!matchesSyncedDomain(info.cookie.domain, domainsCache)) return
      clearTimeout(t)
      t = setTimeout(async () => {
        if ((await getConfig()).autoSync) void runSync().catch(console.error)
      }, 5000)
    })()
  })

  // Let the popup/options trigger an immediate sync — always available, regardless of autoSync.
  chrome.runtime.onMessage.addListener((msg, _sender, send) => {
    if (msg?.type === 'sync-now') {
      runSync().then(send).catch((e) => send({ error: String(e) }))
      return true // async response
    }
    if (msg?.type === 'relay-status') {
      // popup 健康检查：查询到后端 /api/ext 的 WS 是否在线。查询本身会唤醒 SW，
      // 唤醒即重走 startExtCdp 重连，所以 false 也是「正在重连」的真实快照。
      send({ connected: isRelayUp() })
      return // 同步应答
    }
    if (msg?.type === 'relay-reconnect') {
      // 弹窗那个「立刻重连」。它**不是恢复的前提**——退避重连一直在跑（见 driver.ts
      // forceReconnect 的头注），这里只是把最坏 30s 的等待折叠掉。回的是"这就去试"，
      // 不是"已连上"：连上与否由 open 事件决定，弹窗自己复查 relay-status。
      send({ result: forceReconnect() })
      return // 同步应答
    }
  })
})
