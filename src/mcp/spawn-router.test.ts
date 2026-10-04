import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { makeSpawnRouter } from './spawn-router.ts'
import { wireShutdown } from './stdio-entry.ts'

/** 排空当前所有已排队的微任务。InMemoryTransport 的每一跳都是微任务(send 直接同步调对端
 *  onmessage),setImmediate 属于 check 阶段,一定排在它们之后 —— 所以这是**确定性**的屏障,
 *  不是「等 5ms 应该够了」那种靠墙钟赌运气的写法。 */
const flushMicrotasks = () => new Promise<void>((r) => { setImmediate(r) })

/** 计数闸:N 个调用者到齐才一起放行,并给出「都到齐了」的信号。
 *  用它取代墙钟 sleep:靠 sleep 让并发调用者进场,一旦时间不够,后到的调用会走「已 flip」快路,
 *  断言就以**错误的理由**变绿 —— 正是本项目反复吃亏的那种假绿。 */
function countedGate(n: number) {
  let arrived = 0
  let openAll!: () => void
  let markAllArrived!: () => void
  const opened = new Promise<void>((r) => { openAll = r })
  const allArrived = new Promise<void>((r) => { markAllArrived = r })
  return {
    async arrive(): Promise<void> {
      arrived += 1
      if (arrived >= n) { markAllArrived(); openAll() }
      await opened
    },
    allArrived,
    count: () => arrived,
  }
}

/** 一个只有两个工具的假 disk server:read_ok 正常返回;do_action 回 needs_backend 形状。
 *  `onAction` 是给并发测试用的闸门钩子:让多个 do_action 调用能被卡在 disk 这一步等齐。 */
function fakeDiskServer(onAction?: () => Promise<void>): Server {
  const s = new Server({ name: 'disk', version: '0' }, { capabilities: { tools: {} } })
  s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
    { name: 'read_ok', inputSchema: { type: 'object' } },
    { name: 'do_action', inputSchema: { type: 'object' } },
  ] }))
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'read_ok') return { content: [{ type: 'text', text: 'from-disk' }] }
    await onAction?.()
    return { content: [{ type: 'text', text: 'transcribe needs the Stream backend running — start it' }], isError: true }
  })
  return s
}
function fakeBackendServer(): Server {
  const s = new Server({ name: 'backend', version: '0' }, { capabilities: { tools: {} } })
  s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'do_action', inputSchema: { type: 'object' } }] }))
  s.setRequestHandler(CallToolRequestSchema, () => ({ content: [{ type: 'text', text: 'from-backend' }] }))
  return s
}
async function clientFor(server: Server): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const c = new Client({ name: 't', version: '0' })
  await c.connect(b)
  return c
}

describe('spawn router', () => {
  it('reads stay on disk; action triggers spawn then forwards; later calls stay forwarded', async () => {
    const spawned: boolean[] = []
    const { server } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { spawned.push(true); return { url: 'mem://', kill: () => {} } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const read = await c.callTool({ name: 'read_ok', arguments: {} })
    expect(JSON.stringify(read)).toContain('from-disk')
    expect(spawned).toHaveLength(0)
    const act = await c.callTool({ name: 'do_action', arguments: {} })
    expect(spawned).toHaveLength(1)
    expect(JSON.stringify(act)).toContain('from-backend')
    const again = await c.callTool({ name: 'do_action', arguments: {} })
    expect(spawned).toHaveLength(1) // 不重复 spawn
    expect(JSON.stringify(again)).toContain('from-backend')
  })
  it('spawn failure surfaces the original needs_backend error', async () => {
    const { server } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { throw new Error('backend spawn timeout') },
      connectForward: async () => { throw new Error('unreachable') },
    })
    const c = await clientFor(server)
    const r = await c.callTool({ name: 'do_action', arguments: {} })
    expect(JSON.stringify(r)).toContain('needs the Stream backend running')
    expect(JSON.stringify(r)).toContain('backend spawn timeout')
  })

  // 失败信封:调用方要读到的是原话本身,而不是包着它的一坨 JSON;并且 throw 出来的不一定是 Error
  // ——`(e as Error).message` 对一个字符串会得到字面量 "undefined",把真正的原因整个吃掉。
  it('spawn failure envelope carries the plain message text and survives a non-Error throw', async () => {
    const { server } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { throw 'plain string boom' },
      connectForward: async () => { throw new Error('unreachable') },
    })
    const c = await clientFor(server)
    const r = await c.callTool({ name: 'do_action', arguments: {} }) as { content: { text: string }[] }
    expect(r.content[0].text).toContain('transcribe needs the Stream backend running')
    expect(r.content[0].text).not.toContain('"content"') // 不是 JSON 包壳
    expect(r.content[0].text).toContain('plain string boom')
    expect(r.content[0].text).not.toContain('undefined')
  })

  // CRITICAL 1 回归:spawn 成功但 connect 失败时,那个孩子必须**当场**被杀。老代码把句柄写进外层
  // spawned 后再 throw,句柄随后被第二次 spawn 覆盖,第一个孩子从此没人杀、还占着端口。
  it('kills the child when connectForward rejects, and does not publish a stale handle', async () => {
    const kills: number[] = []
    let n = 0
    let connectShouldFail = true
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { const id = ++n; return { url: 'mem://', kill: () => kills.push(id) } },
      connectForward: async () => {
        if (connectShouldFail) throw new Error('connect refused')
        return clientFor(fakeBackendServer())
      },
    })
    const c = await clientFor(server)
    const first = await c.callTool({ name: 'do_action', arguments: {} })
    expect(JSON.stringify(first)).toContain('connect refused')
    expect(kills).toEqual([1]) // 1 号当场被杀,不是留到进程退出

    connectShouldFail = false
    const second = await c.callTool({ name: 'do_action', arguments: {} })
    expect(JSON.stringify(second)).toContain('from-backend')
    expect(n).toBe(2)
    killSpawned()
    expect(kills).toEqual([1, 2]) // 只有 2 号被发布出去,killSpawned 杀的是它
  })

  // CRITICAL 2 回归:关停撞上一次在途 spawn(窗口最长 = spawn 超时,现在 60s)。killSpawned() 读到的
  // spawned 还是 null,若不留旗标,flip 完成后会把句柄挂到一个再也没人读的地方 → 孤儿。
  //
  // 计时注:必须用 flushMicrotasks()(排到 setImmediate 这个宏任务)而不是单次 `await Promise.resolve()`
  // ——disk 这一跳(diskClient.callTool 经 InMemoryTransport 两端各一跳)本身就要走好几个微任务,单次
  // await 未必等到 flip() 真正被调用。MINOR 2 给 flip() 加了「一进来就看 closed」的早检查之后,这个差异
  // 从「无关紧要」变成「决定了这条测试还测不测得到东西」:如果 killSpawned() 抢在 flip() 真正被调用之前
  // 落地,新的早检查会让 flip() 直接拒绝,spawn 从未被调用过,这条测试就退化成在测 MINOR 2、不再是在测
  // "spawn 已经在途、shutdown 追上它"这个 CRITICAL 2 场景。flushMicrotasks() 保证 flip() 已经真正调用
  // 了 opts.spawn(卡在 `await gate` 里)之后,才让 killSpawned() 登场。
  it('a shutdown during an in-flight spawn kills the child instead of orphaning it', async () => {
    const kills: number[] = []
    let spawnStarted = false
    let releaseSpawn!: () => void
    const gate = new Promise<void>((r) => { releaseSpawn = r })
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { spawnStarted = true; await gate; return { url: 'mem://', kill: () => kills.push(1) } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const inFlight = c.callTool({ name: 'do_action', arguments: {} })
    await flushMicrotasks()
    expect(spawnStarted).toBe(true) // 确实已经在途,不是还没调到 flip()

    killSpawned() // 关停到达时 spawn 还没落地
    expect(kills).toEqual([]) // 此刻确实无从可杀 —— 正是老代码 no-op 的那一刻

    releaseSpawn()
    const r = await inFlight
    expect(kills).toEqual([1]) // spawn 落地后自己发现已关停,当场自杀
    expect(JSON.stringify(r)).toContain('shutting down')
    expect(JSON.stringify(r)).toContain('needs the Stream backend running')
  })

  // Task 9 收尾:killSpawned() 必须能在健康探针**还在轮询**的时候就把子进程杀掉,不必等
  // IN_FLIGHT_FLIP_GRACE_MS 那条有上限的兜底(旧代码在这个窗口里就是纯 no-op,子进程活到父进程退出
  // 才被 reparent 孤儿化)。用 probeGate 卡住 spawn,模拟真实 spawnBackend 的形状:子进程一创建就
  // 同步经 onChild 交出句柄,随后才进健康探针轮询;killSpawned() 落在这段轮询期间。
  it('killSpawned kills a still-polling spawn immediately via early child registration, without waiting', async () => {
    const kills: number[] = []
    let probing = false
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((r) => { releaseProbe = r })
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async (onChild?: (c: { kill(): void }) => void) => {
        onChild?.({ kill: () => kills.push(1) }) // 子进程刚创建就同步交出句柄——早于轮询开始
        probing = true
        await probeGate // 卡住:证明此刻仍在"探针轮询"这一步,spawn 还没落地
        return { url: 'mem://', kill: () => kills.push(1) }
      },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const inFlight = c.callTool({ name: 'do_action', arguments: {} }).catch((e: unknown) => e)
    await flushMicrotasks()
    expect(probing).toBe(true) // 确实卡在轮询这一步,不是调用还没跑到

    killSpawned() // 关停到达——这次不依赖任何有上限的等待
    expect(kills).toEqual([1]) // 断言的是「此刻已经死了」,不是「早晚会死」

    releaseProbe()
    await inFlight
    expect(kills).toEqual([1]) // spawn 随后落地不会再杀第二次(idempotent)
  })

  // IMPORTANT(孤儿窗口第二轮回归):早前实现在 spawn 一 resolve 就把 spawningChild 置 null,孤儿窗口
  // 没消灭,只是从"探针轮询期间"挪到了"connectForward 收尾期间"——StreamableHTTPClientTransport.connect
  // 没有自带超时,一旦卡住,killSpawned() 落在这段窗口里就会读到 spawningChild === null 且 spawned
  // 仍是 null,变回纯 no-op,唯一的兜底只剩 IN_FLIGHT_FLIP_GRACE_MS 那条有上限的 settleInFlightFlip
  // 等待(2s,而 connect 可能永远卡住)。这条把 killSpawned() 卡死 connectForward 那一刻,断言子进程
  // 当场死掉——不依赖任何等待,不给"早晚会死"这种弱断言留空子。
  it('killSpawned kills a child parked inside connectForward, without waiting for the settle grace period', async () => {
    const kills: number[] = []
    let connecting = false
    let releaseConnect!: () => void
    const connectGate = new Promise<void>((r) => { releaseConnect = r })
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async (onChild?: (c: { kill(): void }) => void) => {
        onChild?.({ kill: () => kills.push(1) }) // spawn 落地前就同步交出句柄
        return { url: 'mem://', kill: () => kills.push(1) }
      },
      connectForward: async () => {
        connecting = true
        await connectGate // 卡住:spawn 已经落地,child 已经存在,唯独 connect 没收尾
        return clientFor(fakeBackendServer())
      },
    })
    const c = await clientFor(server)
    const inFlight = c.callTool({ name: 'do_action', arguments: {} }).catch((e: unknown) => e)
    await flushMicrotasks()
    expect(connecting).toBe(true) // 确实卡在 connectForward 里,spawn 已经成功、还没连上

    killSpawned() // 关停落在 spawn 成功之后、connect 收尾之前
    expect(kills).toEqual([1]) // 断言「此刻已经死了」——不依赖 settleInFlightFlip 的 2s 上限兜底

    releaseConnect()
    await inFlight
    expect(kills).toEqual([1]) // connect 收尾后不会再杀第二次(idempotent)
  })

  // IMPORTANT 4:并发互斥锁的牙。原有「不重复 spawn」断言是**顺序**的 —— 把 flipping 互斥锁换成
  // 裸的 spawn/connect,它照样绿。这条必须是真并发:三个动作调用同时在途,只许起一个后端。
  it('concurrent action calls share one in-flight spawn (mutex teeth)', async () => {
    let spawns = 0
    let releaseSpawn!: () => void
    const gate = new Promise<void>((r) => { releaseSpawn = r })
    // 三个调用者必须**真的**同时在途:计数闸把它们卡在 disk 那一步,到齐才一起放行。
    const arrivals = countedGate(3)
    const { server } = await makeSpawnRouter({
      disk: fakeDiskServer(() => arrivals.arrive()),
      spawn: async () => { spawns += 1; await gate; return { url: 'mem://', kill: () => {} } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const all = Promise.all([
      c.callTool({ name: 'do_action', arguments: {} }),
      c.callTool({ name: 'do_action', arguments: {} }),
      c.callTool({ name: 'do_action', arguments: {} }),
    ])
    await arrivals.allArrived
    expect(arrivals.count()).toBe(3) // 到齐了才继续,不靠「睡 5ms 应该够」
    // disk 结果一 resolve,处理器同一个微任务里就进 flip(中间没有别的 await),所以排空微任务
    // 之后三个调用者一定都已在 flip 里 —— 且 spawn 还被 gate 挡着,谁都不可能走「已 flip」快路。
    await flushMicrotasks()
    expect(spawns).toBe(1) // 没有 flipping 互斥锁的话,此刻就是 3
    releaseSpawn()
    const results = await all
    expect(spawns).toBe(1)
    for (const r of results) expect(JSON.stringify(r)).toContain('from-backend')
  })

  // CRITICAL(生产路径):自杀旗标本身不够 —— 自杀发生在一个还没跑的续段里,而 cleanup 一返回
  // wireShutdown 就 exit(0)。这条按**真实关停时序**建模,断言的是「shutdown 返回的那一刻孩子
  // 已经死了」,而不是「早晚会死」。
  //
  // MINOR 5 加固:这条测试的确定性曾经靠"routedServer.close() 只走微任务,所以排在它之后的
  // setImmediate(releaseSpawn) 一定晚于 killSpawned() 落地"这个隐含假设——SDK 内部实现细节,不是
  // 我们控制的契约。哪天 SDK 的 close() 改成等一个定时器(也是宏任务),spawn 就可能抢在 killSpawned()
  // 之前落地,断言的就是一条弱得多的性质(不是"kill 先于 spawn 完成",只是"最终都发生了"),而测试
  // 会在错误的理由下继续变绿。改法:把"何时放行 spawn"直接写进 cleanup 序列本身——releaseSpawn()
  // 紧跟在 killSpawned() 之后同步调用,不再借助任何外部计时器去"顺便"排出正确顺序;并且在 shutdown()
  // 被调用之前先断言一次"此刻确实还没杀过",让因果顺序在断言层面也是显式的。
  it('shutdown waits for an in-flight spawn: the child is already dead when shutdown returns', async () => {
    const kills: number[] = []
    let releaseSpawn!: () => void
    const gate = new Promise<void>((r) => { releaseSpawn = r })
    const { server: routedServer, killSpawned, close: closeRouter } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { await gate; return { url: 'mem://', kill: () => kills.push(1) } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(routedServer)
    // 关停会把 transport 一并关掉,这次在途调用最终以「Connection closed」告终 —— 生产里也是如此
    // (客户端正在走人)。这里先接住它,免得变成 unhandled rejection;真正要断言的是孩子的死活。
    const inFlight = c.callTool({ name: 'do_action', arguments: {} }).catch((e: unknown) => e)
    await flushMicrotasks() // 调用已进到 flip,spawn 被 gate 挡着
    expect(kills).toEqual([]) // shutdown 还没开始,此刻自然什么都没杀——显式断言,不留给后面反推

    const exits: number[] = []
    const killsAtExit: number[][] = []
    // stdio-entry 里那段 cleanup 的逐字复刻(routedServer.close → killSpawned → await closeRouter),
    // 唯一的差别是显式把 releaseSpawn() 排在 killSpawned() 之后——这就是"spawn-settle 顺序"本身,
    // 不再依赖 routedServer.close() 的内部实现细节去偶然排对。
    const shutdown = wireShutdown(async () => {
      await routedServer.close()
      killSpawned()
      // 显式排序:此刻 killSpawned() 已经跑过,才放行 spawn 落地。用 setImmediate 而非同步调用——
      // 同步放行会让 spawn 续段排进微任务队列,而 closeRouter() 后面那串 await 本身就够跑完它,
      // 于是断言在删掉 settleInFlightFlip() 后照样成立、测试失去鉴别力(实测过:改同步调用后
      // 删 settle 全绿)。排到宏任务上,只有 settleInFlightFlip() 等得到它。
      setImmediate(releaseSpawn)
      await closeRouter()
    }, {
      proc: new EventEmitter(),
      stdin: new EventEmitter(),
      exit: (code) => { killsAtExit.push([...kills]); exits.push(code) },
    })

    await shutdown()

    expect(kills).toEqual([1])        // shutdown 返回时孩子已经被杀
    expect(killsAtExit).toEqual([[1]]) // 而且是在 exit(0) **之前**,不是之后
    expect(exits).toEqual([0])
    await inFlight
  })

  // IMPORTANT:killSpawned() 清了子进程句柄却留着转发客户端 = 拆了一半。之后再来一次调用会被转发到
  // 一个进程已经没了的后端并拿到「成功」的陈旧响应,close() 还会对着它再 close 一次。
  it('killSpawned() unwires the forward client — no routing to a dead backend, no double close', async () => {
    const kills: number[] = []
    let closes = 0
    const { server, killSpawned, close } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => ({ url: 'mem://', kill: () => kills.push(1) }),
      connectForward: async () => {
        const fc = await clientFor(fakeBackendServer())
        const orig = fc.close.bind(fc)
        fc.close = async () => { closes += 1; return orig() }
        return fc
      },
    })
    const c = await clientFor(server)
    expect(JSON.stringify(await c.callTool({ name: 'do_action', arguments: {} }))).toContain('from-backend')

    killSpawned()
    expect(kills).toEqual([1])
    expect(closes).toBe(1) // 连接也拆了,不是只杀进程

    const after = await c.callTool({ name: 'do_action', arguments: {} })
    expect(JSON.stringify(after)).not.toContain('from-backend') // 绝不能再路由到死掉的后端
    expect(JSON.stringify(after)).toContain('needs the Stream backend running')

    await close()
    expect(closes).toBe(1) // 没有对着已死连接第二次 close
  })

  // MINOR:spawn 之后、connect 之前的那道 closed 检查,单独删掉时曾经**没有任何测试变红**——
  // 后面还有一道 post-connect 检查会把它兜住。这条把关停正好落在 spawn→connect 那个窗口里:
  // 检查在,connectForward 一次都不该被调到。
  it('a shutdown landing between spawn and connect kills the child without ever connecting', async () => {
    const kills: number[] = []
    let connectCalls = 0
    let releaseSpawn!: () => void
    let releaseConnect!: () => void
    const spawnGate = new Promise<void>((r) => { releaseSpawn = r })
    const connectGate = new Promise<void>((r) => { releaseConnect = r })
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { await spawnGate; return { url: 'mem://', kill: () => kills.push(1) } },
      connectForward: async () => { connectCalls += 1; await connectGate; return clientFor(fakeBackendServer()) },
    })
    const c = await clientFor(server)
    const inFlight = c.callTool({ name: 'do_action', arguments: {} })
    await flushMicrotasks()

    killSpawned()   // 关停先到
    releaseSpawn()  // spawn 随后落地 —— 正好落在 connect 之前
    await flushMicrotasks()

    expect(connectCalls).toBe(0) // 少了这道检查就会往下走去连一个我们已经不要的后端
    expect(kills).toEqual([1])

    releaseConnect() // 让「检查被删」的变体也能收尾,不至于把测试挂死
    expect(JSON.stringify(await inFlight)).toContain('shutting down')
  })

  // MINOR 5:侦测只能认 SDK 错误通道来的标记。一个纯读工具原样返回的采集内容里碰巧带上这句话
  // (content_search 就会),绝不能因此白起一个后端。
  it('a read tool whose content merely contains the marker text does not spawn', async () => {
    let spawns = 0
    const disk = new Server({ name: 'disk', version: '0' }, { capabilities: { tools: {} } })
    disk.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'content_search', inputSchema: { type: 'object' } }] }))
    disk.setRequestHandler(CallToolRequestSchema, () => ({
      // 无 isError —— 这是一次成功的读,文本只是碰巧引用了那句话。
      content: [{ type: 'text', text: 'harvested post: "transcribe needs the Stream backend running" (quoted verbatim)' }],
    }))
    const { server } = await makeSpawnRouter({
      disk,
      spawn: async () => { spawns += 1; return { url: 'mem://', kill: () => {} } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const r = await c.callTool({ name: 'content_search', arguments: {} })
    expect(spawns).toBe(0)
    expect(JSON.stringify(r)).toContain('quoted verbatim') // 结果原样透出,没被改写成失败信封
  })

  it('listTools reflects the backend tool set after the flip', async () => {
    const { server } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => ({ url: 'mem://', kill: () => {} }),
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['read_ok', 'do_action'])
    await c.callTool({ name: 'do_action', arguments: {} })
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['do_action']) // 后端的目录,不是 disk 的
  })

  it('killSpawned() is a safe no-op when nothing was ever spawned', async () => {
    let spawns = 0
    const { server, killSpawned, close } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { spawns += 1; return { url: 'mem://', kill: () => {} } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    await c.callTool({ name: 'read_ok', arguments: {} })
    expect(() => killSpawned()).not.toThrow()
    expect(spawns).toBe(0) // 「找到已有实例就不动它」的同规:从没 spawn 过就什么都不杀
    await expect(close()).resolves.toBeUndefined()
  })

  // MINOR 1:opts.spawn 自己在调过 onChild 之后又 reject——spawningChild 必须照样被清空,不能留着
  // 一个指向已死尝试的陈旧句柄。老代码里那行 `spawningChild = null` 紧跟在 spawn 成功路径后面,
  // spawn 本身 reject 时直接跳过,没有 finally 兜底;今天的 finally 应该覆盖这条路径。用一个独立的
  // kill 计数器验证:killSpawned() 事后调用不会再摸到这个陈旧句柄(不会让 kills 变成 2)。
  it('spawningChild is cleared even when spawn itself rejects after calling onChild', async () => {
    const kills: number[] = []
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async (onChild?: (c: { kill(): void }) => void) => {
        onChild?.({ kill: () => kills.push(1) }) // 交出句柄...
        throw new Error('spawn died right after handing out the child') // ...然后自己 reject
      },
      connectForward: async () => { throw new Error('unreachable') },
    })
    const c = await clientFor(server)
    const r = await c.callTool({ name: 'do_action', arguments: {} })
    expect(JSON.stringify(r)).toContain('spawn died right after handing out the child')
    // flip() 里 `await (opts.spawn ?? defaultSpawn)(...)` 本身没有 catch 包着——spawn 自己 reject 时
    // killChild() 从未被自动调用过(它只在 spawn *成功*返回一个 child 后的几处分支里才有机会触发)。
    expect(kills).toEqual([]) // 交出的句柄没有被自动杀过

    // 事后关停:如果 finally 没有把 spawningChild 清空(MINOR 1 描述的老行为),这里就会摸到一个指向
    // 已死尝试的陈旧闭包,凭空多打一次 kill——不是"重复杀同一个孩子两次"那种被闩挡住的形状,而是一次
    // 本不该发生的迟发调用。finally 修好之后,spawningChild 早在 flip 落定的那一刻就已经是 null,
    // killSpawned() 在这里必须是彻底的 no-op。
    killSpawned()
    expect(kills).toEqual([]) // 没有变成 [1] —— 陈旧句柄已经在 finally 里被清空,摸不到了
  })

  // MINOR 2:关停之后到达的 flip 调用一次真 spawn 都不该起。少了 flip() 顶部这道早检查,旧代码只在
  // spawn *返回之后*才看 closed——调用方会先老老实实起一个真后端,直到 spawn 超时(最长 60s)才被杀,
  // 而彼时父进程早就退出了。这条直接调 killSpawned() 立起关停旗标,再发一次 do_action,断言 spawn
  // 一次都没被调到。
  it('a flip arriving after shutdown never spawns at all', async () => {
    let spawns = 0
    const { server, killSpawned } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => { spawns += 1; return { url: 'mem://', kill: () => {} } },
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    killSpawned() // 关停在先,此刻从没 spawn 过,理应是 no-op
    expect(spawns).toBe(0)

    const r = await c.callTool({ name: 'do_action', arguments: {} })
    expect(spawns).toBe(0) // 早检查挡住了这次调用,spawn 从未被调用——不是"调用了但立刻被杀"
    expect(JSON.stringify(r)).toContain('shutting down')
    expect(JSON.stringify(r)).toContain('needs the Stream backend running')
  })

  // MINOR 3:close() 和 killSpawned() 曾是两条独立的关停路径,只有 killSpawned() 杀子进程——单独调
  // close() 会把子进程活生生落下。这条只调 close(),从不碰 killSpawned(),断言子进程照样被杀、且
  // 幂等(重复调 close() 不二次 kill)。
  it('close() alone kills a live spawned child — not just killSpawned()', async () => {
    const kills: number[] = []
    const { server, close } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      spawn: async () => ({ url: 'mem://', kill: () => kills.push(1) }),
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    expect(JSON.stringify(await c.callTool({ name: 'do_action', arguments: {} }))).toContain('from-backend')
    expect(kills).toEqual([]) // 后端还活着,还没关停

    await close() // 从未调用 killSpawned()
    expect(kills).toEqual([1]) // close() 本身必须把子进程杀掉,不能指望调用方先调 killSpawned()

    await close() // 重复调用必须是安全的 no-op
    expect(kills).toEqual([1])
  })

  // MINOR C:close() 必须**先杀再等落定**。早绑定的句柄让杀是立刻生效的,杀完在途 flip 随即
  // 失败落定,settle 就没什么可等的了;反过来先 settle,一个只调 close()(不先调 killSpawned())
  // 的调用方要白白挂满 IN_FLIGHT_FLIP_GRACE_MS(2s)才轮到杀 —— close() 现在是有文档的公开入口,
  // 这条路真有人走。屏障用 setImmediate(宏任务)而非墙钟:先 settle 的版本只能靠那个 2s 定时器
  // 才醒得过来,几轮宏任务后仍然 pending,断言确定性地变红。
  it('close() kills the in-flight child immediately instead of waiting out the settle grace', async () => {
    const kills: number[] = []
    let rejectSpawn!: (e: unknown) => void
    const { server, close } = await makeSpawnRouter({
      disk: fakeDiskServer(),
      // spawn 永远卡着不落定,直到子进程被杀 —— 真实场景就是"健康探针还在轮询"那段窗口。
      spawn: (onChild) => new Promise((_resolve, reject) => {
        rejectSpawn = reject
        onChild?.({ kill: () => { kills.push(1); rejectSpawn(new Error('killed while polling')) } })
      }),
      connectForward: async () => clientFor(fakeBackendServer()),
    })
    const c = await clientFor(server)
    const inFlight = c.callTool({ name: 'do_action', arguments: {} }).catch((e: unknown) => e)
    await flushMicrotasks() // 调用已进到 flip,spawn 卡在探针窗口里
    expect(kills).toEqual([])

    let settled = false
    const closing = close().then(() => { settled = true })
    // 关键断言:不推进任何计时器、只放几轮宏任务,close() 就该已经杀完并返回。
    await flushMicrotasks()
    expect(kills).toEqual([1]) // 杀在前
    await flushMicrotasks()
    await flushMicrotasks()
    expect(settled).toBe(true) // 而且没被 2s 的 settle 宽限期拖住
    await closing
    await inFlight
  })
})
