import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { Readable, Transform, Writable, pipeline } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import * as acp from '@agentclientprotocol/sdk'

/**
 * ACP（Agent Client Protocol）的**协议层**——这个域里唯一 import SDK 的文件。
 *
 * 只做三件事：把一个 `Stream`（或进程内的 `AgentApp`，给测试）接成一条 ClientConnection、
 * 把 agent → client 的两条路（`session/update` 通知、`session/request_permission` 请求）交给
 * 调用方的回调、把 client → agent 的五个动词包成 Promise。**不认识 run、不认识 recipe**：
 * 那些归 repair-session.ts。为什么切在这儿：spec §12「不嵌任何一家 agent 的 SDK」——
 * 换 adapter 不改这层，换协议实现只改这层。
 */
export interface AcpHandlers {
  onUpdate(n: acp.SessionNotification): void
  onPermission(r: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>
  onStderr?(line: string): void
  /** SDK 解不出 JSON-RPC 的那一行（Gemini 往 stdout 打日志那种）——记一条，不崩。 */
  onProtocolError?(message: string): void
}

export interface AcpClient {
  initialize(): Promise<acp.InitializeResponse>
  newSession(p: acp.NewSessionRequest): Promise<acp.NewSessionResponse>
  loadSession(p: acp.LoadSessionRequest): Promise<void>
  prompt(sessionId: string, text: string): Promise<acp.PromptResponse>
  cancel(sessionId: string): Promise<void>
  close(): void
  readonly closed: Promise<void>
}

export function openAcpClient(target: acp.Stream | acp.AgentApp, handlers: AcpHandlers): AcpClient {
  const app = acp.client({ name: 'stream' })
    .onRequest(acp.methods.client.session.requestPermission, (cx) => handlers.onPermission(cx.params))
    .onNotification(acp.methods.client.session.update, (cx) => { handlers.onUpdate(cx.params) })
  // 两个重载签名不同，按运行时类型分派（AgentApp 是值导出的 class，Stream 是 {readable, writable}）。
  const conn: acp.ClientConnection = target instanceof acp.AgentApp ? app.connect(target) : app.connect(target)
  const agent = conn.agent
  return {
    initialize: () => agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      // 不申报 fs / terminal：agent 用它自己的工具读写，权限经 request_permission 过我们的门。
      clientCapabilities: {},
    }),
    newSession: (p) => agent.request(acp.methods.agent.session.new, p),
    loadSession: async (p) => { await agent.request(acp.methods.agent.session.load, p) },
    prompt: (sessionId, text) => agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] }),
    cancel: (sessionId) => agent.notify(acp.methods.agent.session.cancel, { sessionId }),
    close: () => conn.close(),
    closed: conn.closed.catch((e) => { handlers.onProtocolError?.(e instanceof Error ? e.message : String(e)) }),
  }
}

export type SpawnFn = typeof nodeSpawn

/**
 * 一个接上了的 agent 子进程。
 *
 * **`closed` 和 `exited` 是两件事，`close()` 也不杀进程。** `close()` 只关协议连接（`closed`
 * 随之 resolve），子进程照常活着；要它真的走开必须 `kill()`，然后等 `exited`。判「这一轮还
 * 活着吗」用 `Promise.race([closed, exited])` —— 单看任何一个都会漏掉另一半。
 * `kill()` 默认发 SIGTERM，不保证进程一定死；需要「一定收掉」的场景由上层等一段
 * `exited` 之后再 `kill('SIGKILL')` 兜底（`RepairSession.closeAgent` 就是那个上层），
 * 这层不替它决定等多久。
 */
export interface SpawnedAgent extends AcpClient {
  readonly exited: Promise<{ code: number | null; signal: string | null }>
  kill(signal?: NodeJS.Signals): void
}

const MAX_LINE_CHARS = 1 << 20

/**
 * 把 stdout 里**不是 JSON-RPC 的那些行**摘出来交给 `onProtocolError`，只把合法行往下游放。
 *
 * 为什么必须自己做：SDK 的 `ndJsonStream` 碰到解不出的行是**静默**处理的——它往对端回一个
 * parse-error 响应就把那行丢了，client 这一侧一个字都看不到。真 agent（Gemini 那类）往 stdout
 * 打启动日志时，症状就是「连上了、什么也没发生」。不留这道痕，`onProtocolError` 就是个
 * 永远不会被调用的空承诺。
 */
function filterJsonRpcLines(onProtocolError?: (message: string) => void): Transform {
  // 跨 chunk 持有半个多字节字符：按 chunk 各自 `toString('utf8')` 会把一个被切开的汉字解成两个
  // 替换字符，而**外层 JSON 照样 parse 得过**——payload 被静默改掉，没有任何一处会喊。
  const decoder = new StringDecoder('utf8')
  let buf = ''
  const take = (line: string, push: (chunk: string) => void): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      onProtocolError?.(`stdout 上不是 JSON-RPC 的一行：${trimmed.slice(0, 500)}`)
      return
    }
    if (parsed === null || (typeof parsed !== 'object')) {
      onProtocolError?.(`stdout 上不是 JSON-RPC 消息：${trimmed.slice(0, 500)}`)
      return
    }
    push(`${trimmed}\n`)
  }
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf += decoder.write(chunk)
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        take(buf.slice(0, i), (out) => this.push(out))
        buf = buf.slice(i + 1)
      }
      // 一行长到这个地步就不是 JSON-RPC 了（对端在往 stdout 灌无换行的东西）——报一条、丢掉，
      // 别让缓冲无上限地涨。
      if (buf.length > MAX_LINE_CHARS) {
        onProtocolError?.(`stdout 上一行超过 ${MAX_LINE_CHARS} 字符仍无换行，丢弃：${buf.slice(0, 200)}`)
        buf = ''
      }
      cb()
    },
    flush(cb) {
      buf += decoder.end()
      if (buf) take(buf, (out) => this.push(out))
      buf = ''
      cb()
    },
  })
}

/**
 * 起一个 ACP agent 子进程并接上。**spawn 经注入**（AGENTS.md：会 spawn 的域必须能注入假 spawn，
 * qrun 的锁护不住比测试活得久的子进程）。spawn 同步抛（命令不存在）不在这里抛：包成一个
 * 立即 reject 的连接，让 `initialize()` 把它抛出去——调用方只有一条错误路径要处理。
 */
export function spawnAcpAgent(
  cmd: { command: string; args: string[] },
  handlers: AcpHandlers,
  opts: { cwd: string; env?: NodeJS.ProcessEnv; spawnFn?: SpawnFn },
): SpawnedAgent {
  const spawnFn = opts.spawnFn ?? nodeSpawn
  let child: ChildProcess
  try {
    child = spawnFn(cmd.command, cmd.args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    const rejected = <T,>(): Promise<T> => Promise.reject(err)
    return {
      initialize: rejected, newSession: rejected, loadSession: rejected, prompt: rejected, cancel: rejected,
      close: () => {}, closed: Promise.resolve(), kill: () => {},
      exited: Promise.resolve({ code: null, signal: null }),
    }
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // stderr 逐行给上层：它不是协议流，但常常是「为什么没动」的唯一线索（登录过期、缺命令）。
  //
  // **不管有没有 onStderr 都要读**：这一层拥有这根 pipe，没人读它的时候子进程写满 64KB 内核缓冲
  // 就地卡住，而且不报错、不退出——症状是「agent 起来了，一个字都不说」。有回调才调回调，
  // 但排空是无条件的。setEncoding('utf8') 让 Node 自己跨 chunk 持有半个多字节字符。
  if (child.stderr) {
    let buf = ''
    const emit = (line: string): void => handlers.onStderr?.(line.replace(/\r$/, ''))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      buf += chunk
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, i)); buf = buf.slice(i + 1) }
      if (buf.length > MAX_LINE_CHARS) { emit(buf); buf = '' }
    })
    child.stderr.on('end', () => { if (buf) { emit(buf); buf = '' } })
    child.stderr.on('error', () => { /* 进程没了，stderr 跟着断——exited 会说这件事 */ })
  }
  // 用 pipeline 而不是 pipe：`pipe` **不转发源的 error**。stdout 上一个 EPIPE 会让 Transform 永远
  // 不 end、web ReadableStream 永远不 close，于是 `closed` 一直 pending 而 `exited` 早就 resolve 了
  // ——「连接还开着」和「对端已经死了」长得一模一样。pipeline 会把错误传下去并 destroy 目标。
  const incoming = filterJsonRpcLines(handlers.onProtocolError)
  pipeline(child.stdout!, incoming, (err) => {
    if (err) handlers.onProtocolError?.(`stdout 断了：${err.message}`)
  })
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
    Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
  )
  const client = openAcpClient(stream, handlers)
  return {
    ...client,
    exited,
    kill: (signal) => { try { child.kill(signal) } catch { /* 已经死了 */ } },
  }
}
