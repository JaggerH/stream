/**
 * 外部事件源子进程的真入口——由后端 `superviseWorker` spawn，环境变量是它与后端唯一的接口。
 * 单例锁（`O_EXCL` 拿 `<dataDir>/event-source/<source>.lock`）：锁被占说明上一个实例还活着，
 * 本进程立刻退出，交给它（配合 `supervise.ts` 的 adopt，重启期不会起出第二个）。
 * 无单测——端到端在 Task 8 覆盖（真起子进程、真连 ws）。
 */
import Database from 'better-sqlite3'
import { openSync, closeSync, unlinkSync, constants } from 'node:fs'
import WebSocket from 'ws'
import { Outbox } from '../outbox.ts'
import { runClient, type WsLike } from './client.ts'
import { fakeSource, type EventSource } from './source.ts'
import { EVENT_SOURCE_PROTOCOL } from '../relay.ts'

// 环境变量由后端 superviseWorker 注入。
const dataDir = process.env.ES_DATA_DIR!
const backendUrl = process.env.ES_BACKEND_URL! // ws://127.0.0.1:8900/api/event-source
const token = process.env.ES_TOKEN!
const sourceName = process.env.ES_SOURCE ?? 'fake'
const orphanTtlMs = Number(process.env.ES_ORPHAN_TTL_MS ?? 5 * 60_000)

const lockPath = `${dataDir}/event-source/${sourceName}.lock`
let lockFd: number
try {
  lockFd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR)
} catch {
  process.exit(0) // 锁已被占：已有一个实例在跑，本进程立刻退（单例）
}
function releaseLock() {
  try {
    closeSync(lockFd)
    unlinkSync(lockPath)
  } catch {
    /* 尽力 */
  }
}

const outbox = new Outbox(`${dataDir}/event-source/${sourceName}.db`, Database)
// 源选择：Spec 2 在这里换成闲鱼真源；本 plan 只有 fake。
const source: EventSource = fakeSource()

const client = runClient(
  outbox,
  source,
  {
    connect: () =>
      new Promise<WsLike | null>((resolve) => {
        // verifyHostUpgrade（src/http/host-relay.ts）的两道闸：
        // 1) Origin 必须不是 http(s)://——本进程是原生 Node 客户端，不设 Origin（ws 默认不发）。
        // 2) token 经 Sec-WebSocket-Protocol 子协议携带，而非 URL：offer [PROTOCOL, token]。
        const ws = new WebSocket(backendUrl, [EVENT_SOURCE_PROTOCOL, token])
        ws.on('open', () =>
          resolve({
            send: (r) => ws.send(r),
            onMessage: (cb) => ws.on('message', (d: Buffer) => cb(d.toString())),
            onClose: (cb) => ws.on('close', cb),
            close: () => ws.close(),
          }),
        )
        ws.on('error', () => resolve(null))
      }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onOrphanExit: () => {
      client.stop()
      outbox.close()
      releaseLock()
      process.exit(0)
    },
  },
  { orphanTtlMs },
)

process.on('SIGTERM', () => {
  client.stop()
  outbox.close()
  releaseLock()
  process.exit(0)
})
