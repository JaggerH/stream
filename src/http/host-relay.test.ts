import { describe, it, expect, vi } from 'vitest'
import {
  WsHostRelay,
  HostRelayDisconnected,
  HostRelayTimeout,
  HostSessionQueueTimeout,
  HostAbortedByUser,
  INTERACTIVE_SESSION_WAIT_MS,
  verifyHostUpgrade,
  HOST_RELAY_PROTOCOL,
  type HostSocket,
} from './host-relay.ts'
import { EVENT_SOURCE_PROTOCOL } from '../event-source/relay.ts'

function fakeSocket() {
  const sent: string[] = []
  const socket: HostSocket = { send: (d) => void sent.push(d) }
  return { socket, sent }
}

describe('WsHostRelay', () => {
  it('sends {id, op, args} and resolves the matching response by id', async () => {
    const relay = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    relay.connect(socket)
    const p = relay.send({ op: 'find', args: { query: { name: 'x' } } })
    expect(JSON.parse(sent[0])).toEqual({ id: 1, op: 'find', args: { query: { name: 'x' } } })
    relay.handleMessage(JSON.stringify({ id: 1, result: [{ ref: 'r1' }] }))
    expect(await p).toEqual([{ ref: 'r1' }])
  })

  it('omits args when the op has none', async () => {
    const relay = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    relay.connect(socket)
    void relay.send({ op: 'url' })
    expect(JSON.parse(sent[0])).toEqual({ id: 1, op: 'url' })
  })

  // 这条钉住的只是**单发 op 配对**的尾锁：同一条物理 WS 连接一次只有一个 op 在途、按 id 配对
  // 回复。它**不**防两条并发桌面 recipe 的 op 互相插队——那要靠会话租约（`withSession`，见下面
  // 「会话租约」一组测试和 `desktop-runner.test.ts` 里跨 `runDesktopRecipe` 的集成测试）。之前
  // 这条测试的注释把"单发尾锁"直接说成"两条并发 recipe 不会互相打断彼此的键盘输入"——那句话
  // 不成立：单发尾锁只保证一次只发一个 op，不保证连续几个 op 属于同一趟 recipe（复评实测过
  // A/B 两条 recipe 的 op 被严格轮流交错，字打进了别人的窗口）。
  it('单发尾锁：两个并发 send 被排成一条链，一次只有一个真的发到 socket，落定后才轮到下一个', async () => {
    const relay = new WsHostRelay()
    const { socket, sent } = fakeSocket()
    relay.connect(socket)
    const a = relay.send({ op: 'url' })
    const b = relay.send({ op: 'screenshot' })
    // b 此刻还没真的发出去——尾锁挡住了它，队列里只有 a 落地。
    expect(sent.length).toBe(1)
    const idA = JSON.parse(sent[0]).id
    relay.handleMessage(JSON.stringify({ id: idA, result: 'app#win' }))
    expect(await a).toBe('app#win')
    // a 落定后串行链推进一格，b 才真的发到 socket。
    await Promise.resolve()
    expect(sent.length).toBe(2)
    const idB = JSON.parse(sent[1]).id
    relay.handleMessage(JSON.stringify({ id: idB, result: { base64: 'zz' } }))
    expect(await b).toEqual({ base64: 'zz' })
  })

  it('rejects with an Error when the response carries one', async () => {
    const relay = new WsHostRelay()
    const { socket } = fakeSocket()
    relay.connect(socket)
    const p = relay.send({ op: 'invoke', args: { ref: 'bad' } })
    relay.handleMessage(JSON.stringify({ id: 1, error: 'element gone' }))
    await expect(p).rejects.toThrow('element gone')
  })

  it('ignores unknown / unparseable messages', async () => {
    const relay = new WsHostRelay()
    const { socket } = fakeSocket()
    relay.connect(socket)
    const p = relay.send({ op: 'url' })
    relay.handleMessage('not json')
    relay.handleMessage(JSON.stringify({ id: 999, result: 'stray' }))
    relay.handleMessage(JSON.stringify({ id: 1, result: 'ok' }))
    expect(await p).toBe('ok')
  })

  it('rejects immediately when no socket is connected', async () => {
    const relay = new WsHostRelay()
    await expect(relay.send({ op: 'url' })).rejects.toBeInstanceOf(HostRelayDisconnected)
  })

  it('rejects pending on disconnect', async () => {
    const relay = new WsHostRelay()
    const { socket } = fakeSocket()
    relay.connect(socket)
    const p = relay.send({ op: 'url' })
    relay.disconnect(socket)
    await expect(p).rejects.toBeInstanceOf(HostRelayDisconnected)
    expect(relay.connected).toBe(false)
  })

  it('latest connection wins — a new socket rejects the old socket pending', async () => {
    const relay = new WsHostRelay()
    const s1 = fakeSocket()
    const s2 = fakeSocket()
    relay.connect(s1.socket)
    const p = relay.send({ op: 'url' })
    relay.connect(s2.socket)
    await expect(p).rejects.toBeInstanceOf(HostRelayDisconnected)
    expect(relay.connected).toBe(true)
  })

  it('times out a send with no response', async () => {
    vi.useFakeTimers()
    try {
      const relay = new WsHostRelay({ timeoutMs: 100 })
      const { socket } = fakeSocket()
      relay.connect(socket)
      const p = relay.send({ op: 'find', args: {} })
      const assertion = expect(p).rejects.toBeInstanceOf(HostRelayTimeout)
      await vi.advanceTimersByTimeAsync(101)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  // I3: socket.send 同步抛（序列化失败/ws 状态异常）不该留着 inFlight=true 干等 30s 超时才
  // 自愈——那段时间整条桌面通道全停。fix 后应当当场 reject，且后续 op 能立刻接上（不受那 30s 拖累）。
  it('socket.send 同步抛时当场 reject，不占满超时窗口，后续 op 能立刻发出', async () => {
    const relay = new WsHostRelay({ timeoutMs: 30_000 })
    let shouldThrow = true
    const sent: string[] = []
    const socket: HostSocket = {
      send: (d) => {
        if (shouldThrow) throw new Error('ws not open')
        sent.push(d)
      },
    }
    relay.connect(socket)
    const p = relay.send({ op: 'url' })
    await expect(p).rejects.toThrow('ws not open')
    // 没有真的等 30s——上面这行在 fake timers 之外的真实时间里几乎瞬间返回，本身就是回归防线：
    // 若 fix 失效（inFlight 卡死），这个 await 会一直挂到测试超时。
    shouldThrow = false
    // 不 await 它落定（没人回 handleMessage，会一直挂着）——只关心它有没有**立刻发到 socket**，
    // 那正是"没被上一个失败的 op 拖住"的证据。租约空闲时发送是同步的，调用本身就已经够看。
    void relay.send({ op: 'url' })
    expect(sent.length).toBe(1)
  })

  describe('会话租约（withSession）', () => {
    it('公平排队：先 acquire 的先跑完，后 acquire 的等它释放才开始', async () => {
      const relay = new WsHostRelay()
      const order: string[] = []
      const pA = relay.withSession(async () => {
        order.push('A-start')
        await Promise.resolve()
        order.push('A-end')
      })
      const pB = relay.withSession(async () => {
        order.push('B-start')
        order.push('B-end')
      })
      await Promise.all([pA, pB])
      expect(order).toEqual(['A-start', 'A-end', 'B-start', 'B-end'])
    })

    it('异常路径下释放：fn 抛错，租约仍然让给下一个排队者', async () => {
      const relay = new WsHostRelay()
      const order: string[] = []
      const pA = relay.withSession(async () => {
        order.push('A')
        throw new Error('boom')
      })
      const pB = relay.withSession(async () => {
        order.push('B')
      })
      await expect(pA).rejects.toThrow('boom')
      await pB
      expect(order).toEqual(['A', 'B'])
    })

    it('租约持有者自己发的 op 跳过排队——不会被自己挡住', async () => {
      const relay = new WsHostRelay()
      const { socket, sent } = fakeSocket()
      relay.connect(socket)
      await relay.withSession(async () => {
        const p1 = relay.send({ op: 'a' })
        relay.handleMessage(JSON.stringify({ id: JSON.parse(sent[0]).id, result: {} }))
        await p1
        const p2 = relay.send({ op: 'b' })
        relay.handleMessage(JSON.stringify({ id: JSON.parse(sent[1]).id, result: {} }))
        await p2
      })
      expect(sent.map((s) => JSON.parse(s).op)).toEqual(['a', 'b'])
    })

    // I2: 排队等租约要有上界——不然被别人占着的时候可以无限期等下去，调用方分不清是"agent
    // 没响应"还是"只是排在后面"。
    it('排队等租约超时，报 HostSessionQueueTimeout（跟 op 本身超时的 HostRelayTimeout 分得开）', async () => {
      vi.useFakeTimers()
      try {
        const relay = new WsHostRelay({ sessionWaitMs: 100 })
        let releaseA: (() => void) | undefined
        const pA = relay.withSession(() => new Promise<void>((resolve) => { releaseA = resolve }))
        const pB = relay.withSession(async () => {})
        const assertion = expect(pB).rejects.toBeInstanceOf(HostSessionQueueTimeout)
        await vi.advanceTimersByTimeAsync(101)
        await assertion
        releaseA?.()
        await pA
      } finally {
        vi.useRealTimers()
      }
    })

    // I1：排队没有真取消（没有 AbortSignal），但等待上界本身就是"取消"的效果——排队里那份
    // 调用一旦因超时出队，`fn` 就永远不会被 grant，也就永远不会真的发出任何 op。用一个会
    // 发 op 的 fn（而不是空 async），证明的是"没有任何一个 op 悄悄发到了 socket"，不只是
    // "promise 拒绝了"。
    it('排队超时出队后，fn 永不执行——不会有任何 op 在放弃之后偷偷发出', async () => {
      vi.useFakeTimers()
      try {
        const relay = new WsHostRelay({ sessionWaitMs: 100 })
        const { socket, sent } = fakeSocket()
        relay.connect(socket)
        let releaseA: (() => void) | undefined
        const pA = relay.withSession(() => new Promise<void>((resolve) => { releaseA = resolve }))
        const bFn = vi.fn(async () => { await relay.send({ op: 'b-op' }) })
        const pB = relay.withSession(bFn)
        const assertion = expect(pB).rejects.toBeInstanceOf(HostSessionQueueTimeout)
        await vi.advanceTimersByTimeAsync(101)
        await assertion
        expect(bFn).not.toHaveBeenCalled()
        expect(sent).toEqual([]) // 没有任何 op 发到 socket——不是"发了但没等结果"，是压根没发
        releaseA?.()
        await pA
      } finally {
        vi.useRealTimers()
      }
    })

    // I1：一个超时出队的排队者不能把队列卡住——它必须真的从 `sessionQueue` 里摘除，不然
    // 释放时会把租约错发给这个已经拒绝过的 promise（resolve 一个已 settle 的 promise 是
    // no-op，`sessionHolder` 却被设成了它的 token，从此没人能再释放），排在它后面的正常
    // 等待者会永远等不到。用 C 探这条线：B 超时出队之后，A 释放，C（排在 B 后面）必须能
    // 拿到租约——拿不到就是队列卡死了。
    it('排队超时出队的那位不会卡住队列——排它后面的下一位照样能拿到租约', async () => {
      vi.useFakeTimers()
      try {
        const relay = new WsHostRelay({ sessionWaitMs: 100 })
        let releaseA: (() => void) | undefined
        const pA = relay.withSession(() => new Promise<void>((resolve) => { releaseA = resolve }))
        const pB = relay.withSession(async () => {}) // 会在 sessionWaitMs（100ms）后超时出队
        const order: string[] = []
        // C 的等待窗口特意给得比 B 长——只想让 B 单独先超时出队，不想连带把 C 也计时器
        // 撞车一起超时（那样测不出"B 卡住 C"，只测出"两个都超时"）。
        const pC = relay.withSession(async () => { order.push('C-ran') }, { waitMs: 10_000 })
        const bRejected = expect(pB).rejects.toBeInstanceOf(HostSessionQueueTimeout)
        await vi.advanceTimersByTimeAsync(101) // B 超时出队；C 还在等；A 仍持有租约
        await bRejected
        releaseA?.() // 轮到排在 B 后面的 C
        await pC
        expect(order).toEqual(['C-ran'])
      } finally {
        vi.useRealTimers()
      }
    })

    // I1：交互路径（cdp_act / run_action_recipe）传 INTERACTIVE_SESSION_WAIT_MS，比默认的
    // sessionWaitMs（180s）短得多——排队要在 MCP 客户端自己的调用超时之前先失败，见该常量
    // 头注。这里钉住"per-call 的 waitMs 真的覆盖了默认值"，而不是被默认值悄悄吃掉。
    it('withSession 的 opts.waitMs 覆盖默认 sessionWaitMs——交互路径的短等待生效', async () => {
      vi.useFakeTimers()
      try {
        // 默认 sessionWaitMs 给得很宽（远大于 INTERACTIVE_SESSION_WAIT_MS），只有真的传了
        // per-call 覆盖，B 才会在 INTERACTIVE_SESSION_WAIT_MS 这个短得多的窗口内超时。
        const relay = new WsHostRelay({ sessionWaitMs: INTERACTIVE_SESSION_WAIT_MS * 10 })
        let releaseA: (() => void) | undefined
        const pA = relay.withSession(() => new Promise<void>((resolve) => { releaseA = resolve }))
        const pB = relay.withSession(async () => {}, { waitMs: INTERACTIVE_SESSION_WAIT_MS })
        const assertion = expect(pB).rejects.toBeInstanceOf(HostSessionQueueTimeout)
        await vi.advanceTimersByTimeAsync(INTERACTIVE_SESSION_WAIT_MS + 1)
        await assertion
        releaseA?.()
        await pA
      } finally {
        vi.useRealTimers()
      }
    })

    // Minor 1：可重入保护——持有者在自己的会话上下文里再调一次 withSession，不该去排自己的
    // 队（那会稳定卡满 waitMs 才报错，且这个错看起来像"被别人占着"，实则是嵌套调用，两者
    // 对不上号）。直接跑 fn，行为等价于同一个 recipe 内部连续两次 send()。
    it('可重入：持有者在自己的会话里再调一次 withSession，直接执行，不排自己的队', async () => {
      const relay = new WsHostRelay()
      const order: string[] = []
      await relay.withSession(async () => {
        order.push('outer-start')
        await relay.withSession(async () => {
          order.push('inner')
        })
        order.push('outer-end')
      })
      expect(order).toEqual(['outer-start', 'inner', 'outer-end'])
    })
  })

  describe('用户热键中止', () => {
    it('收到 abort 帧 → 挂起的 op 以 HostAbortedByUser 拒掉（不是超时、不是断连）', async () => {
      const relay = new WsHostRelay()
      relay.connect({ send: () => {} })
      const p = relay.send({ op: 'click', args: { rect: { x: 0, y: 0, w: 1, h: 1 } } })
      const assertion = expect(p).rejects.toBeInstanceOf(HostAbortedByUser)
      relay.handleMessage(JSON.stringify({ type: 'abort', reason: 'user-hotkey' }))
      await assertion
    })

    it('中止之后租约让给排队者——一按热键就把桌面通道永久锁死是不可接受的', async () => {
      const relay = new WsHostRelay()
      relay.connect({ send: () => {} })
      let bRan = false
      const a = relay.withSession(async () => { await relay.send({ op: 'type', args: { text: 'x' } }) })
      const b = relay.withSession(async () => { bRan = true })
      const aRejected = expect(a).rejects.toBeInstanceOf(HostAbortedByUser)
      relay.handleMessage(JSON.stringify({ type: 'abort', reason: 'user-hotkey' }))
      await aRejected
      await b
      expect(bRan).toBe(true)
    })

    it('还没发出去、排在单发尾锁里的 op 也一并中止——留着它等于热键只停了一半', async () => {
      const relay = new WsHostRelay()
      relay.connect({ send: () => {} })
      const first = relay.send({ op: 'click', args: {} })
      const queued = relay.send({ op: 'type', args: { text: 'x' } })
      const assertions = Promise.all([
        expect(first).rejects.toBeInstanceOf(HostAbortedByUser),
        expect(queued).rejects.toBeInstanceOf(HostAbortedByUser),
      ])
      relay.handleMessage(JSON.stringify({ type: 'abort', reason: 'user-hotkey' }))
      await assertions
    })

    it('中止之后通道还能用——下一个 op 正常发出并收到回复', async () => {
      const sent: string[] = []
      const relay = new WsHostRelay()
      relay.connect({ send: (d) => void sent.push(d) })
      const aborted = expect(relay.send({ op: 'click', args: {} })).rejects.toBeInstanceOf(HostAbortedByUser)
      relay.handleMessage(JSON.stringify({ type: 'abort' }))
      await aborted
      const p = relay.send({ op: 'url' })
      const id = JSON.parse(sent[sent.length - 1]).id
      relay.handleMessage(JSON.stringify({ id, result: 'https://example.com' }))
      await expect(p).resolves.toBe('https://example.com')
    })
  })
})

describe('verifyHostUpgrade', () => {
  const token = 'sekret-token'

  it('accepts a native (non-web) origin offering the matching token in the subprotocol', () => {
    expect(
      verifyHostUpgrade({ origin: undefined, protocolHeader: `${HOST_RELAY_PROTOCOL}, ${token}` }, token),
    ).toBe(true)
    expect(
      verifyHostUpgrade({ origin: 'file://', protocolHeader: `${HOST_RELAY_PROTOCOL}, ${token}` }, token),
    ).toBe(true)
  })

  it('rejects a web (http/https) origin even with a valid token', () => {
    expect(
      verifyHostUpgrade({ origin: 'https://evil.example', protocolHeader: `${HOST_RELAY_PROTOCOL}, ${token}` }, token),
    ).toBe(false)
  })

  it('rejects a wrong or missing token', () => {
    expect(verifyHostUpgrade({ protocolHeader: `${HOST_RELAY_PROTOCOL}, nope` }, token)).toBe(false)
    expect(verifyHostUpgrade({ protocolHeader: HOST_RELAY_PROTOCOL }, token)).toBe(false)
  })

  it('accepts a different protocol name when passed explicitly, and the default rejects it', () => {
    const header = `${EVENT_SOURCE_PROTOCOL}, ${token}`
    expect(verifyHostUpgrade({ protocolHeader: header }, token, EVENT_SOURCE_PROTOCOL)).toBe(true)
    // Without the third arg, the default HOST_RELAY_PROTOCOL doesn't match the offered
    // event-source protocol name, so both entries survive the filter → length 2 → rejected.
    expect(verifyHostUpgrade({ protocolHeader: header }, token)).toBe(false)
  })
})
