import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawnBackend } from './spawn-backend.ts'
// errText 是共享实现(src/err-text.ts):同一个 bug——`(e as Error).message` 对非 Error 抛出物
// 产出字面量 "undefined"——在 plugin-gateway 里也有一份,两处用同一个函数,不各写各的。
import { errText } from '../err-text.ts'

// 侦测标记的实证(Task 9 Step 1,非猜测):McpServer(server.ts createMcpServer)内部的
// CallToolRequestSchema 处理器把工具 handler 抛出的任何 Error 捕获,转成
// { content: [{ type: 'text', text: error.message }], isError: true }(SDK
// dist/esm/server/mcp.js executeToolHandler 的 catch → createToolError)。NeedsBackendError
// 的 message 固定含 "needs the Stream backend running"、.code 固定是 "needs_backend" ——两个都是
// disk-service.ts 自己写的字符串,侦测认其一即可,不依赖 SDK 内部实现细节以外的任何东西。
/** disk 工具结果是不是「需后端在跑」——两个标记都是我们自己在 disk-service.ts 写的字符串。
 *  必须先看 isError:标记文本只可能经 SDK 的错误通道到达调用方(executeToolHandler 的 catch →
 *  createToolError 恒置 isError: true),而正文匹配是对**整个 payload**做的——一个纯读工具
 *  (如 content_search 原样返回采到的条目)只要内容里碰巧带上这句话,就会被误判成需要后端而白起一个
 *  进程。isError 这道闸把误判面收窄到只有真正的错误结果。 */
function looksNeedsBackend(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  if ((result as { isError?: unknown }).isError !== true) return false
  const s = JSON.stringify(result)
  return s.includes('needs the Stream backend running') || s.includes('needs_backend')
}

/** 取工具结果里的人读文本;拿不到就退回整包 JSON(失败信封宁可啰嗦,不可丢信息)。 */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content
  if (Array.isArray(content)) {
    const text = content
      .map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n')
    if (text) return text
  }
  return JSON.stringify(result) ?? String(result)
}

/** router 这一层只用 url + kill 两件事——不用 spawnBackend 整份 SpawnedBackend(尤其不用
 *  `exited`:那是`stream mcp`壳的respawn接缝,和这个 spawn/flip 路由是两回事),窄成自己的形状,
 *  别让 spawnBackend 的接口变化牵连这里。 */
export interface SpawnedChild { url: string; kill(): void }

export interface SpawnRouterOpts {
  disk: Server
  // onChild 是可选的第二个参数(Task 9 收尾):真实实现是 spawnBackend,它会在子进程刚创建、健康
  // 探针还没开始轮询之前同步调用一次,把杀掉它的能力早早交出来。测试里的假 spawn 可以不接这个参数——
  // 不接就退回旧行为(flip()内部各分支各自兜底 kill),接了才能在探针轮询期间被 killSpawned() 提前杀。
  spawn?: (onChild?: (child: { kill(): void }) => void) => Promise<SpawnedChild>
  connectForward?: (url: string) => Promise<Client>
}

/** 关停时等一次**在途** flip 落定的上限。
 *  为什么要等:关停旗标只保证 flip 在 spawn 落地后**自己**去杀子进程,而自杀发生在一个还没跑的
 *  续段里 —— stdio-entry 的 cleanup 跑完就 exit(0),那个续段永远等不到。子进程既没 detached
 *  也没 unref,父进程一死它只是被 reparent,继续活着占端口。所以关停必须显式等它落定。
 *  为什么要有上限:spawnBackend 最长会等 60s 健康探针,无上限等于把退出挂死一分钟。
 *  取 2s 的理由:够覆盖一次**已经在返回路上**的 spawn + connect 收尾(本地进程,毫秒级),
 *  又远短于 MCP 客户端 SIGTERM→SIGKILL 的常见宽限期,不会让客户端把我们当卡死。
 *  超时就放弃等:此刻 closed 已经立起,flip 落地后仍会自杀,只是我们不再为它拖住退出。 */
const IN_FLIGHT_FLIP_GRACE_MS = 2_000

// spawnBackend 的 onChild 是它自己 opts 上的一个字段,不是位置参数——包一层适配 SpawnRouterOpts.spawn
// 的 (onChild?) => Promise<SpawnedBackend> 形状,router 侧不用关心这个差异。
const defaultSpawn = (onChild?: (child: { kill(): void }) => void): Promise<SpawnedChild> =>
  spawnBackend({ onChild })

const defaultConnectForward = async (url: string): Promise<Client> => {
  const c = new Client({ name: 'stream-stdio-spawned-forward', version: '0.1.0' })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`)))
  return c
}

/** stdio 的「后端即 standby 单元」路由(spec「stdio MCP 形态」):默认 disk;某个动作工具回
 *  needs_backend → spawn 后端 → 转发该次调用 → 之后全部走 forward。spawn 失败 → 原 needs_backend
 *  错误 + spawn 失败原因一起返回(比裸报错可诊断)。 */
export async function makeSpawnRouter(opts: SpawnRouterOpts): Promise<{ server: Server; killSpawned(): void; close(): Promise<void> }> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await opts.disk.connect(a)
  const diskClient = new Client({ name: 'stream-stdio-disk-inner', version: '0.1.0' })
  await diskClient.connect(b)

  let forward: Client | null = null
  let spawned: SpawnedChild | null = null
  // 本次 flip 尝试(如果正在跑)早绑定出来的杀句柄。只在"spawn 已经调用了 onChild、但整条 flip 链
  // 还没落定(spawn + connectForward 都算)"这段窗口里非 null——落定(无论成败)之后在 finally 里
  // 清 null,后续杀都走 spawned?.kill()。killSpawned() 靠它,在健康探针轮询期间**以及**
  // connectForward 收尾期间(两段都算"还没落定"),也能当场杀掉子进程,不必再依赖下面
  // settleInFlightFlip() 那条有上限的兜底等待。
  //
  // 曾经的坑(Task 9 收尾第二轮):早前实现在 spawn 一 resolve 就把 spawningChild 置 null("探针轮询
  // 结束了,不再需要它"的直觉),但 spawned 要等 connectForward 也成功才发布——孤儿窗口没有消灭,
  // 只是从"探针轮询期间"挪到了"connectForward 收尾期间"。killSpawned() 落在这段窗口里时,
  // spawningChild 已经是 null、spawned 还是 null,又变回纯 no-op。StreamableHTTPClientTransport.connect
  // 本身没有超时,一旦卡住,兜底只剩 IN_FLIGHT_FLIP_GRACE_MS 那 2s——超时一到,shutdown 放弃等待,
  // 子进程被 reparent。修法:spawningChild 必须活过 spawn *和* connectForward 两段,只在整条 flip
  // 链真正落定(成功或失败)的 finally 里清空。
  let spawningChild: (() => void) | null = null
  let flipping: Promise<Client> | null = null
  // 关停旗标。killSpawned()/close() 只能看到**调用那一刻**的 spawned;spawn 在途时(最长可达 spawn
  // 超时,现在 60s)它还是 null,关停会静默 no-op,随后 flip 完成再把句柄挂上去——子进程就此没人杀。
  // 所以关停要留下痕迹,让 flip 在 spawn 落地后自己去看。
  let closed = false

  // 并发的多次 needs_backend 调用必须共享同一次 in-flight spawn,而不是各起一个、抢同一个端口——
  // flipping 是那把互斥锁:第一次调用赋值 Promise,后续调用复用同一个 Promise 而不是再起一次 spawn。
  async function flip(): Promise<Client> {
    if (forward) return forward
    // MINOR 2:关停之后到达的 flip 调用,一次真 spawn 都不该起。少了这道早检查,旧代码只在 spawn
    // *返回之后*才看 closed——一次 post-shutdown 调用会先老老实实起一个真后端,直到 spawn 超时(最长
    // 60s)才把它杀掉,而彼时父进程早已退出。今天走不到这条路径(stdio-entry 先关 server 再杀),
    // 但下一个调用方不见得遵守这个顺序,提前挡住比事后指望调用顺序更可靠。
    if (closed) throw new Error('spawn router is shutting down')
    flipping ??= (async () => {
      // 句柄先留在局部:只有整条链(spawn + connect)全成才发布到外层 spawned。中途失败若已经写了外层
      // 句柄又不杀,这个孩子就成了孤儿——它没被 unref、也不在随父死的进程组里,会活过父进程退出,还占着
      // 端口;下一次调用起的第二个后端会在端口绑定上死掉,而健康探针对着那个**孤儿**变绿,于是路由把流量
      // 转发给一个自己杀不掉的进程。实测过 spawns=2, kills=[2]。
      //
      // earlyKill/killedThisAttempt 是这次尝试内部统一的 kill 入口:不管是 killSpawned() 经 spawningChild
      // 提前杀的(现在覆盖 spawn *和* connectForward 两段),还是下面几处分支各自兜底杀的,都收敛到
      // killChild() ——提前杀过了,下面任何一处分支再碰到就是安全的 no-op,不会把同一个子进程杀两次。
      // 旧式的假 spawn(测试里那些不接 onChild 参数的)不受影响:earlyKill 永远是 null,killChild() 退化
      // 成直接调 fallback.kill(),与改动前逐字一致。
      //
      // MINOR 4(双闩判断):spawnBackend 自己的返回句柄(defaultSpawn 场景)内部也有一把 killOnce 闩
      // (spawn-backend.ts)。生产路径下 spawningChild 的 c.kill 和 spawned.kill 的 fallback.kill 最终
      // 都指向同一个 killOnce 闭包,killedThisAttempt 这把闩是重复保险。特意留着它,原因是它不只保护
      // 生产路径——它同样要保护测试里注入的假 spawn:那些假实现里,onChild 交出的子对象和 spawn 最终
      // resolve 的 handle 常是两个**不共享状态**的独立对象(各自的 kill() 只是往同一个数组 push,互不知
      // 对方死活)。没有 killedThisAttempt,这类假 spawn 就会被真的杀两次,产生假阳性的"杀了两次"断言
      // 失败。结论:不把 source-side 的闩当唯一权威,两把都留——router 这把只为了让不自带闩的注入假件
      // 也表现得像真实实现一样幂等。
      let earlyKill: (() => void) | null = null
      let killedThisAttempt = false
      const killChild = (fallback?: { kill(): void }) => {
        if (killedThisAttempt) return
        killedThisAttempt = true
        if (earlyKill) earlyKill()
        else fallback?.kill()
      }
      // try/finally 包住整条链(spawn + connect):spawningChild 必须活到这次尝试真正落定(成功、
      // 中途失败、还是 spawn 本身就 reject)才清空,不能在 spawn 一 resolve 就清——那样孤儿窗口只是从
      // "探针轮询期间"搬到了"connectForward 收尾期间"(StreamableHTTPClientTransport.connect 没有自带
      // 超时,一旦卡住,兜底只剩 2s 的 IN_FLIGHT_FLIP_GRACE_MS)。finally 同时兜住 MINOR 1:如果
      // opts.spawn 自己在调用过 onChild 之后又 reject,spawningChild 也会在这里被清空,不会留下一个
      // 指向已死尝试的陈旧句柄。
      try {
        const child = await (opts.spawn ?? defaultSpawn)((c) => {
          earlyKill = () => c.kill()
          spawningChild = () => killChild()
        })
        if (closed) {
          killChild(child)
          throw new Error('spawn router is shutting down')
        }
        let fwd: Client
        try {
          fwd = await (opts.connectForward ?? defaultConnectForward)(child.url)
        } catch (e) {
          killChild(child)
          throw e
        }
        if (closed) {
          void fwd.close()
          killChild(child)
          throw new Error('spawn router is shutting down')
        }
        // spawned.kill 和 spawningChild 此刻短暂地指向同一个孩子——无妨:两者最终都落到同一个
        // killChild(),它的 killedThisAttempt 闩把重复调用收敛成 no-op(MINOR 4)。
        spawned = { url: child.url, kill: () => killChild(child) }
        forward = fwd
        return fwd
      } finally {
        spawningChild = null
      }
    })().finally(() => { flipping = null })
    return flipping
  }

  /** 等在途 flip 落定(成败都算落定),带上限。见 IN_FLIGHT_FLIP_GRACE_MS。 */
  async function settleInFlightFlip(): Promise<void> {
    const pending = flipping
    if (!pending) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<void>((r) => {
      timer = setTimeout(r, IN_FLIGHT_FLIP_GRACE_MS)
      // 别让这个兜底计时器自己把进程钉在事件循环里 —— 它只是上限,不是任务。
      timer.unref?.()
    })
    try {
      // pending 在关停期必然 reject('shutting down'),这里只关心「落定了」,不关心结果。
      await Promise.race([pending.then(() => {}, () => {}), bound])
    } finally {
      clearTimeout(timer)
    }
  }

  const server = new Server({ name: 'stream', version: '0.1.0' }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () => (forward ?? diskClient).listTools())
  server.setRequestHandler(ListResourcesRequestSchema, () => (forward ?? diskClient).listResources())
  server.setRequestHandler(ReadResourceRequestSchema, (req) => (forward ?? diskClient).readResource(req.params))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (forward) return forward.callTool(req.params)
    const diskResult = await diskClient.callTool(req.params)
    if (!looksNeedsBackend(diskResult)) return diskResult
    try {
      const fwd = await flip()
      // 重放安全:disk-service.ts 的 guard/asyncGuard 在做任何事之前就 throw——没有任何磁盘写入或
      // 浏览器动作先于抛错发生,所以把同一次调用原样对新起的后端重放一次,不会造成重复执行。
      return await fwd.callTool(req.params)
    } catch (e) {
      // 调用方要看的是「哪个动作需要后端」这句原话 + 「为什么没起来」,不是一坨包着它的 JSON。
      return {
        content: [{ type: 'text', text: `${resultText(diskResult)}\n(spawn attempt failed: ${errText(e)})` }],
        isError: true,
      }
    }
  })
  // MINOR 3:close() 和 killSpawned() 曾是两条独立的关停路径,只有 killSpawned() 杀子进程,close()
  // 单独调只关 diskClient/forward,子进程活下来没人管。今天没有生产影响——stdio-entry 的关停顺序永远
  // 先 killSpawned() 后 closeRouter()——但这是两个入口两套语义的形状,下一个调用方不见得记得这个顺序。
  // 收敛成一个内部函数,close() 内部也调它:不管走哪个入口,子进程都不可能被落下。天然幂等:closed/
  // spawned/spawningChild 在第一次调用后就已清空,第二次调用时判空,不会重复 kill 或重复 close。
  function doKillSpawned(): Promise<void> {
    closed = true
    // 探针可能仍在轮询、也可能卡在 connectForward 收尾 —— spawningChild 就是留给这整段窗口的:早绑定
    // 拿到的那把 kill,不必等 flip 落定(不依赖下面 close() 里那条有上限的 settleInFlightFlip 兜底)。
    spawningChild?.()
    spawned?.kill()
    spawned = null
    spawningChild = null
    // 只清子进程句柄、留着转发客户端,是拆了一半:后续任何调用仍会走 `if (forward)` 转发到一个
    // 进程已经没了的后端(SDK 客户端照样把它当活的,调用方拿到的是「成功」的陈旧响应),随后的
    // close() 还会对着这个已死连接再 close 一次。窗口只有关停这一小段,但确实是状态损坏 —— 一起拆。
    const dead = forward
    forward = null
    return dead ? dead.close().catch(() => {}) : Promise.resolve()
  }
  // 不再用 server.onclose 做清理:Protocol.onclose 是一个可直接赋值的普通属性,调用方(stdio-entry)
  // 也要在同一个 server 上挂 onclose,后赋的那个会把这里的悄悄盖掉——实测这个 handler 从来没跑过。
  // 改成显式 close(),由调用方在自己的关停路径里调,没有被覆盖的可能。
  return {
    server,
    // 公开接口仍是同步的 void——保持既有调用方(stdio-entry)不用改成 await;子进程 kill 本身是同步
    // 调用,forward.close() 才是异步的,原本就是 fire-and-forget,这里维持不变。
    killSpawned: () => { void doKillSpawned() },
    close: async () => {
      closed = true
      // 顺序是「先杀,再等落定」,不是反过来(MINOR C)。doKillSpawned() 走的是早绑定的
      // spawningChild 句柄——它在探针轮询和 connectForward 收尾两段窗口里都拿得到,杀是**立刻**
      // 生效的。先杀掉,在途 flip 随即在它自己的续段里失败落定,settleInFlightFlip() 几乎无事可等;
      // 反过来先 settle,一个只调 close()(不先调 killSpawned())的调用方要白白挂满
      // IN_FLIGHT_FLIP_GRACE_MS 才轮到杀,而 close() 现在是有文档的公开入口,这条路真有人走。
      // MINOR 3:即便调用方从没调过 killSpawned()、只单独调了 close(),子进程也必须被杀——两个
      // 入口收敛到同一份逻辑。若 killSpawned() 已经先调过,这里是 no-op(spawned/spawningChild/
      // forward 都已清空)。
      await doKillSpawned()
      // 仍然要等一次落定:kill 之后 flip 的续段还没跑完(它要走自己的失败分支、清 flipping),
      // 调用方 cleanup 一返回就 exit(0) 的话那段续段永远等不到。见 IN_FLIGHT_FLIP_GRACE_MS。
      await settleInFlightFlip()
      await diskClient.close()
    },
  }
}
