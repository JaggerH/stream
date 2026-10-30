/**
 * CDP 绑定的进程内主体：配对 → 连 CDP → 连中继 → 收命令 / 发事件，断了就重连。
 *
 * 对服务端来说它与扩展**没有区别**：同样的 `/api/ext/pair` → `/api/ext/verify` → WS
 * `/api/ext`（子协议带 token），同样的命令与心跳。区别只在浏览器那一侧——那边不是扩展的
 * `chrome.debugger`，而是一条到 Chromium 的 CDP 连接（`ops.ts`）。
 *
 * 两条独立的失联路径，各管各的：
 *
 * - **中继断了**（服务端重启 / 网络抖）：退避重连（1s → 30s），每次重连前重新让对端自证。
 * - **CDP 断了**（浏览器退出 / 被杀）：立刻断开中继（服务端据此判离线），然后按固定间隔重试
 *   CDP；CDP 回来再走一遍 verify + 连中继。**CDP 回来时不去重新配对**——token 在状态文件里。
 *
 * 撤销（4003）与「token 被拷到另一个 profile」（4004）是终态：不再重连，`done` 兑现。
 */
import WebSocket from 'ws'
import { CdpConnection } from './cdp-connection.ts'
import { CdpRelayOps } from './ops.ts'
import { RELAY_PROTOCOL, ServerNotTrusted, pairWithCode, verifyServer } from './pairing.ts'
import { loopbackCdpUrl, serverUrlOf } from './loopback.ts'
import { newNodeId, readCdpBindingState, writeCdpBindingState, type CdpBindingState } from './state.ts'

/** 服务端撤销这条绑定（与设备撤销同一个关闭码）。 */
const REVOKED_CLOSE_CODE = 4003
/** 这条绑定的 token 带着另一个节点来连（token 被拷到了别的 profile）。 */
const FOREIGN_NODE_CLOSE_CODE = 4004

export interface CdpBindingOptions {
  /** Chromium 的 CDP 地址，缺省 `http://127.0.0.1:9222`。**只许回环**。 */
  cdpUrl?: string
  /** Stream 的地址（`http://127.0.0.1:8900` / tailscale 地址 / https）。 */
  serverUrl: string
  /** token 与 nodeId 落在这里（0600）。路径由调用方给——CLI 传 `--state`。 */
  stateFile: string
  /**
   * 没有可用状态文件时，向这里要一次性配对码。**CLI 从 stdin 读**（不进命令行、不进环境变量）；
   * 有状态文件时不会调用它。
   */
  readPairingCode?: () => Promise<string>
  /** 配对时上报给服务端的显示名（缺省 `CDP 绑定`）。 */
  name?: string
  /** 日志只写命令名与生命周期，绝不写参数 / 返回 / token。 */
  log?: (line: string) => void
  /** 测试缝。 */
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  /** 中继断线退避的起点 / 上限（缺省 250ms / 30s）。起点很短：醒来后第一次重连不该等一秒。 */
  reconnectMs?: number
  maxReconnectMs?: number
  /** CDP 断开后的重试间隔（缺省 1s）。 */
  cdpRetryMs?: number
  /** 心跳周期（缺省 20s，与扩展一致）。 */
  pingIntervalMs?: number
  /** 墙钟（测试缝）。进程被冻住过时它一次前进很多——心跳据此立刻重连，不等 socket 自己报错。 */
  now?: () => number
}

export interface CdpBinding {
  /** 配对后的绑定 id；配对失败前是 null。 */
  readonly bindingId: string | null
  /** 中继此刻连着没有。 */
  readonly online: boolean
  /** 停掉：断 WS、断 CDP、结束重连循环。幂等。 */
  close(): Promise<void>
  /** 循环退出时兑现（`close()` 或撤销这类终态）。 */
  readonly done: Promise<void>
}

type RelayOutcome = 'retry' | 'cdp-gone' | 'stop'

export async function startCdpBinding(opts: CdpBindingOptions): Promise<CdpBinding> {
  const cdpBase = loopbackCdpUrl(opts.cdpUrl ?? 'http://127.0.0.1:9222')
  const serverUrl = serverUrlOf(opts.serverUrl)
  const log = opts.log ?? ((line: string) => console.error(line))
  const Impl = opts.WebSocketImpl ?? WebSocket
  const now = opts.now ?? Date.now
  const reconnectMs = opts.reconnectMs ?? 250
  const maxReconnectMs = opts.maxReconnectMs ?? 30_000
  const cdpRetryMs = opts.cdpRetryMs ?? 1_000
  const pingIntervalMs = opts.pingIntervalMs ?? 20_000
  // 墙钟一次前进这么多 = 进程被冻住过（虚拟机挂起 / 合盖 / SIGSTOP）。此刻的连接多半已经
  // 半开：服务端可能早就把它判死了，只是 FIN 还没到。不等它，立刻重连。
  // 阈值由节拍推出、明显大于节拍（1.5 倍）：定时器只会晚到，正常节拍醒来最多差一点节拍；
  // 阈值若等于节拍，机器没被冻住也会每拍误判（RM5 撞过：节拍 20s、阈值 20s，每 20s 重连）。
  const wallJumpMs = Math.max(5_000, pingIntervalMs * 1.5)

  let state = readCdpBindingState(opts.stateFile)
  if (state) {
    log('[cdp-binding] 用状态文件里的 token 重连（不再要配对码）')
  } else {
    if (!opts.readPairingCode) throw new Error('没有可用的状态文件，也没有给配对码读取方式')
    const code = (await opts.readPairingCode()).trim()
    if (!code) throw new Error('没有读到配对码')
    const paired = await pairWithCode({
      serverUrl,
      code,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    })
    state = { token: paired.token, nodeId: newNodeId(), bindingId: paired.bindingId }
    writeCdpBindingState(opts.stateFile, state)
    log('[cdp-binding] 配对完成（token 已写进状态文件，权限 0600）')
  }
  const fixed = state

  let stopped = false
  let online = false
  let cdp: CdpConnection | null = null
  let ops: CdpRelayOps | null = null
  let relay: WebSocket | null = null
  let wake: (() => void) | null = null
  let backoff = reconnectMs
  let doneResolve!: () => void
  const done = new Promise<void>((r) => {
    doneResolve = r
  })

  const nap = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = null
        resolve()
      }
    })

  const send = (msg: unknown) => {
    if (!relay || relay.readyState !== Impl.OPEN) return
    try {
      relay.send(JSON.stringify(msg))
    } catch {
      /* 正在断——重连路径会接上 */
    }
  }

  /** 连一次中继，等它结束。**不抛**：各种结束方式都折成一种结果。 */
  const relayOnce = (): Promise<RelayOutcome> =>
    new Promise<RelayOutcome>((resolve) => {
      const query = new URLSearchParams({ nodeId: fixed.nodeId, extVersion: 'cdp-binding/1' }).toString()
      const ws = new Impl(`${serverUrl}/api/ext?${query}`, [RELAY_PROTOCOL, fixed.token])
      relay = ws
      let settled = false
      let alive = true
      let heartbeat: ReturnType<typeof setInterval> | undefined
      const finish = (o: RelayOutcome) => {
        if (settled) return
        settled = true
        if (heartbeat) clearInterval(heartbeat)
        online = false
        if (relay === ws) relay = null
        try {
          ws.terminate()
        } catch {
          /* 已经死了 */
        }
        resolve(o)
      }
      // 心跳照扩展中继的规矩：每个周期 ping 一次；上一轮 ping 之后既没 pong 也没任何帧
      // = 对端冻住了（挂起 / 断网但没有 FIN），terminate 掉走重连。
      // 先看墙钟：进程自己被冻住过时，定时器会在醒来那一刻补跑，而 socket 可能还半开着、
      // 服务端却早已判死——这时立刻重连，别等下一轮 ping 的 20 s。
      let lastWall = now()
      heartbeat = setInterval(() => {
        const wall = now()
        const jumped = wall - lastWall > wallJumpMs
        lastWall = wall
        if (jumped) {
          // 醒来时浏览器那一侧的定时器也一起补跑了：它那条 WS 多半已被它自己判死（或者正半开着）。
          // 留着它去连中继，等于挂一条死管道——命令发出去没人接、每条都要等超时。连 CDP 一起重来。
          log('[cdp-binding] 墙钟跳变（进程被冻住过）——中继与浏览器连接一并重连')
          const conn = cdp
          cdp = null
          ops?.dispose()
          ops = null
          try {
            conn?.close()
          } catch {
            /* 已经死了 */
          }
          finish('retry')
          return
        }
        if (!alive) {
          log('[cdp-binding] 中继心跳无应答——断开重连')
          finish('retry')
          return
        }
        alive = false
        try {
          ws.ping()
        } catch {
          /* close 处理器会收尾 */
        }
      }, pingIntervalMs)
      ws.on('pong', () => {
        alive = true
      })
      ws.on('open', () => {
        online = true
        backoff = reconnectMs
        log(`[cdp-binding] 中继已连上（binding=${fixed.bindingId}）`)
      })
      ws.on('message', (data) => {
        alive = true
        let msg: unknown
        try {
          msg = JSON.parse(String(data))
        } catch {
          return
        }
        const current = ops
        if (!current) return
        void current
          .dispatch(msg)
          .then((reply) => {
            if (reply) send(reply)
          })
          .catch(() => {
            /* dispatch 自己已经把失败折成 {id,error}；这里只剩"发不出去" */
          })
      })
      ws.on('error', (e: Error) => {
        log(`[cdp-binding] 中继连接出错：${e.message}`)
      })
      ws.on('close', (code: number) => {
        if (code === REVOKED_CLOSE_CODE) {
          log('[cdp-binding] 这条绑定被服务端撤销了，不再重连')
          finish('stop')
        } else if (code === FOREIGN_NODE_CLOSE_CODE) {
          log('[cdp-binding] 这条绑定的 token 属于另一个节点，不再重连')
          finish('stop')
        } else {
          log(`[cdp-binding] 中继断开（${code}）`)
          finish(cdp ? 'retry' : 'cdp-gone')
        }
      })
    })

  const loop = async () => {
    while (!stopped) {
      if (!cdp) {
        try {
          cdp = await CdpConnection.connect(cdpBase.toString(), {
            ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
            ...(opts.WebSocketImpl ? { WebSocketImpl: opts.WebSocketImpl } : {}),
          })
          const conn = cdp
          ops = new CdpRelayOps(conn, { log })
          ops.onMessage(send)
          conn.onClose(() => {
            if (cdp !== conn) return
            cdp = null
            ops?.dispose()
            ops = null
            log('[cdp-binding] 浏览器 CDP 断开——中继一并断开（报离线），等它回来')
            try {
              relay?.terminate()
            } catch {
              /* 已经死了 */
            }
          })
          log('[cdp-binding] 已连上浏览器 CDP')
        } catch (e) {
          log(`[cdp-binding] CDP 连不上：${e instanceof Error ? e.message : String(e)}——${cdpRetryMs}ms 后重试`)
          await nap(cdpRetryMs)
          continue
        }
      }
      if (stopped) break // 连 CDP 的这几百毫秒里 close() 被调过——别再往下走一遍 verify
      try {
        await verifyServer({
          serverUrl,
          token: fixed.token,
          bindingId: fixed.bindingId,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        })
      } catch (e) {
        // 验不过就别连（见 pairing.ts 头注的顺序）。对端不是我们那台 → 重试也没用，但可能只是
        // 服务端在重启（`ServerNotTrusted` 之外的网络错都走这里），退避重试。
        log(`[cdp-binding] 对端身份验证失败：${e instanceof ServerNotTrusted ? e.message : String(e)}——${backoff}ms 后重试`)
        await nap(backoff)
        backoff = Math.min(backoff * 2, maxReconnectMs)
        continue
      }
      if (stopped) break
      const outcome = await relayOnce()
      if (outcome === 'stop' || stopped) {
        stopped = true
        break
      }
      if (outcome === 'retry') {
        await nap(backoff)
        backoff = Math.min(backoff * 2, maxReconnectMs)
      } else {
        // CDP 没了：固定间隔重试，不按中继的指数退避——这是"等浏览器起来"，不是"服务端不给连"。
        await nap(cdpRetryMs)
      }
    }
    cdp?.close()
    cdp = null
    ops?.dispose()
    ops = null
    doneResolve()
  }

  void loop().catch((e) => {
    log(`[cdp-binding] 循环异常退出：${e instanceof Error ? e.message : String(e)}`)
    doneResolve()
  })

  return {
    bindingId: fixed.bindingId,
    get online() {
      return online
    },
    async close() {
      if (!stopped) {
        stopped = true
        wake?.()
      }
      try {
        relay?.terminate()
      } catch {
        /* 已经死了 */
      }
      cdp?.close()
      await done
    },
    done,
  }
}
