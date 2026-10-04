import { describe, it, expect } from 'vitest'
import * as acp from '@agentclientprotocol/sdk'
import { PassThrough, Readable, Writable } from 'node:stream'
import { openAcpClient, spawnAcpAgent } from './acp-client.ts'

/** 一个最小 ACP agent：initialize / session/new / session/prompt（发一条 tool_call、问一次权限、结束）/ session/cancel。 */
function fakeAgent(opts: { onPrompt?: (text: string) => void } = {}): acp.AgentApp {
  return acp.agent({ name: 'fake' })
    .onRequest(acp.methods.agent.initialize, async () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }))
    .onRequest(acp.methods.agent.session.new, async () => ({ sessionId: 'S1' }))
    .onRequest(acp.methods.agent.session.load, async () => ({}))
    .onNotification(acp.methods.agent.session.cancel, async () => {})
    .onRequest(acp.methods.agent.session.prompt, async (cx) => {
      const text = cx.params.prompt.map((b) => (b.type === 'text' ? b.text : '')).join('')
      opts.onPrompt?.(text)
      await cx.client.notify(acp.methods.client.session.update, {
        sessionId: cx.params.sessionId,
        update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: '看页面', kind: 'read', status: 'in_progress', rawInput: { a: 1 } },
      })
      const perm = await cx.client.request(acp.methods.client.session.requestPermission, {
        sessionId: cx.params.sessionId,
        toolCall: { toolCallId: 'c2', title: '跑 bash', kind: 'execute' },
        options: [{ optionId: 'y', name: '允许', kind: 'allow_once' }, { optionId: 'n', name: '拒绝', kind: 'reject_once' }],
      })
      await cx.client.notify(acp.methods.client.session.update, {
        sessionId: cx.params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `perm=${perm.outcome.outcome}` } },
      })
      return { stopReason: 'end_turn', usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } }
    })
}

describe('openAcpClient（进程内假 agent）', () => {
  it('initialize → newSession → prompt：更新逐条到 onUpdate，权限走 onPermission，usage 原样回', async () => {
    const updates: acp.SessionNotification[] = []
    const prompts: string[] = []
    const client = openAcpClient(fakeAgent({ onPrompt: (t) => prompts.push(t) }), {
      onUpdate: (n) => updates.push(n),
      onPermission: async (r) => ({ outcome: { outcome: 'selected', optionId: r.options[1]!.optionId } }),
    })
    const init = await client.initialize()
    expect(init.agentCapabilities?.loadSession).toBe(true)
    const s = await client.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(s.sessionId).toBe('S1')
    const res = await client.prompt('S1', '修一下')
    expect(prompts).toEqual(['修一下'])
    expect(res.stopReason).toBe('end_turn')
    expect(res.usage).toMatchObject({ totalTokens: 30, inputTokens: 20, outputTokens: 10 })
    expect(updates.map((u) => u.update.sessionUpdate)).toEqual(['tool_call', 'agent_message_chunk'])
    const last = updates[1]!.update as { content: { text: string } }
    expect(last.content.text).toBe('perm=selected')
    client.close()
    await client.closed
  })

  it('loadSession / cancel 都走到 agent 那一侧（cancel 是通知，不等回执）', async () => {
    const client = openAcpClient(fakeAgent(), {
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    })
    await client.initialize()
    await expect(client.loadSession({ sessionId: 'S1', cwd: '/tmp', mcpServers: [] })).resolves.toBeUndefined()
    await expect(client.cancel('S1')).resolves.toBeUndefined()
    client.close()
    await client.closed
  })
})

describe('spawnAcpAgent（注入的假 spawn）', () => {
  it('stdin/stdout 接成 ndjson 流，stderr 逐行回调，子进程退出可等', async () => {
    // 假子进程：stdout ← 假 agent 的输出，stdin → 假 agent 的输入
    const toAgent = new PassThrough()
    const fromAgent = new PassThrough()
    const stderr = new PassThrough()
    const exitCbs: Array<(code: number | null, signal: string | null) => void> = []
    const onEvent = (ev: string, cb: (...a: never[]) => void): void => {
      if (ev === 'exit') exitCbs.push(cb as (code: number | null, signal: string | null) => void)
    }
    const child = {
      stdin: toAgent, stdout: fromAgent, stderr,
      on: onEvent,
      once: onEvent,
      // 真子进程的 exit 是异步的：kill() 先返回，事件下一轮才到。
      kill: () => { setTimeout(() => { for (const cb of exitCbs) cb(0, null) }, 0); return true },
      pid: 4242,
    }
    // 假 agent 接在这两根管子的另一端
    const agentStream = acp.ndJsonStream(Writable.toWeb(fromAgent) as WritableStream<Uint8Array>, Readable.toWeb(toAgent) as ReadableStream<Uint8Array>)
    fakeAgent().connect(agentStream)
    const lines: string[] = []
    const spawned = spawnAcpAgent({ command: 'fake', args: [] }, {
      onUpdate: () => {}, onPermission: async (r) => ({ outcome: { outcome: 'selected', optionId: r.options[0]!.optionId } }),
      onStderr: (l) => lines.push(l),
    }, { cwd: '/tmp', spawnFn: (() => child) as never })
    stderr.write('warn: something\nsecond\n')
    await spawned.initialize()
    const s = await spawned.newSession({ cwd: '/tmp', mcpServers: [] })
    expect(s.sessionId).toBe('S1')
    expect(lines).toEqual(['warn: something', 'second'])
    spawned.kill()
    await expect(spawned.exited).resolves.toEqual({ code: 0, signal: null })
  })

  /** 上层（`RepairSession.closeAgent`）等不到 `exited` 时要能补一发 SIGKILL——这层必须把信号透下去，
   *  吞掉它的表现是「关停看起来做了收尾」而那个不肯死的子进程还在。 */
  it('kill(signal) 把信号原样发给子进程；不带参数就是默认 SIGTERM', () => {
    const killed: (NodeJS.Signals | number | undefined)[] = []
    const child = {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      on: () => {}, once: () => {},
      kill: (sig?: NodeJS.Signals | number) => { killed.push(sig); return true },
      pid: 4246,
    }
    const spawned = spawnAcpAgent({ command: 'fake', args: [] }, {
      onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    }, { cwd: '/tmp', spawnFn: (() => child) as never })
    spawned.kill()
    spawned.kill('SIGKILL')
    expect(killed).toEqual([undefined, 'SIGKILL'])
    spawned.close()
  })

  it('spawn 抛 → 错误从 initialize 抛出（不是静默挂着）', async () => {
    const spawned = spawnAcpAgent({ command: 'nope', args: [] }, { onUpdate: () => {}, onPermission: async () => ({ outcome: { outcome: 'cancelled' } }) }, {
      cwd: '/tmp', spawnFn: (() => { throw new Error('ENOENT nope') }) as never,
    })
    await expect(spawned.initialize()).rejects.toThrow(/ENOENT/)
    // 其余动词同样立刻 reject，不许有一个静默挂着的口子。
    await expect(spawned.newSession({ cwd: '/tmp', mcpServers: [] })).rejects.toThrow(/ENOENT/)
    await expect(spawned.loadSession({ sessionId: 'S1', cwd: '/tmp', mcpServers: [] })).rejects.toThrow(/ENOENT/)
    await expect(spawned.prompt('S1', 'x')).rejects.toThrow(/ENOENT/)
    await expect(spawned.cancel('S1')).rejects.toThrow(/ENOENT/)
    // 收尸的两个口子不抛、也不挂。
    spawned.kill()
    spawned.close()
    await spawned.closed
    await expect(spawned.exited).resolves.toEqual({ code: null, signal: null })
  })

  it('stdout 上混进非 JSON-RPC 的日志行 → onProtocolError 记一条，不把进程带崩', async () => {
    const toAgent = new PassThrough()
    const fromAgent = new PassThrough()
    const stderr = new PassThrough()
    const child = {
      stdin: toAgent, stdout: fromAgent, stderr,
      on: () => {}, once: () => {},
      kill: () => true,
      pid: 4243,
    }
    const errors: string[] = []
    const spawned = spawnAcpAgent({ command: 'noisy', args: [] }, {
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onProtocolError: (m) => errors.push(m),
    }, { cwd: '/tmp', spawnFn: (() => child) as never })
    fromAgent.write('gemini: loading credentials...\n')
    fromAgent.end()
    await spawned.closed
    expect(errors.length).toBeGreaterThan(0)
  })

  it('stdout 出错（EPIPE 那类）→ closed 会 resolve，不是永远挂着', async () => {
    const toAgent = new PassThrough()
    const fromAgent = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin: toAgent, stdout: fromAgent, stderr, on: () => {}, once: () => {}, kill: () => true, pid: 4245 }
    const errors: string[] = []
    const spawned = spawnAcpAgent({ command: 'dies', args: [] }, {
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onProtocolError: (m) => errors.push(m),
    }, { cwd: '/tmp', spawnFn: (() => child) as never })
    fromAgent.destroy(new Error('EPIPE'))
    // `pipe` 不转发源的 error：那种写法下 Transform 永不 end，这个 await 会一直挂到超时。
    await spawned.closed
    expect(errors.some((m) => m.includes('EPIPE'))).toBe(true)
  })

  it('日志行和协议消息混在一条 stdout 上：日志进 onProtocolError，协议消息原样到达（含被切成两半的汉字）', async () => {
    const toAgent = new PassThrough()
    const fromAgent = new PassThrough()
    const stderr = new PassThrough()
    const child = { stdin: toAgent, stdout: fromAgent, stderr, on: () => {}, once: () => {}, kill: () => true, pid: 4244 }
    const errors: string[] = []
    const spawned = spawnAcpAgent({ command: 'noisy', args: [] }, {
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      onProtocolError: (m) => errors.push(m),
    }, { cwd: '/tmp', spawnFn: (() => child) as never })

    // 先拿到 client 真正发出去的那条 initialize 请求的 id，才好手搓一条对得上的响应。
    const firstLine = new Promise<string>((resolve) => {
      let seen = ''
      toAgent.on('data', (c: Buffer) => {
        seen += c.toString('utf8')
        const i = seen.indexOf('\n')
        if (i >= 0) resolve(seen.slice(0, i))
      })
    })
    const init = spawned.initialize()
    const req = JSON.parse(await firstLine) as { id: number | string }

    const NOTE = '这一行里的汉字会被切成两半'
    const payload = `${JSON.stringify({
      jsonrpc: '2.0', id: req.id,
      result: { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {}, _meta: { note: NOTE } },
    })}\n`
    const bytes = Buffer.from(payload, 'utf8')
    // 切在一个三字节汉字的**中间**：按 chunk 各自解码的写法会在这里吐出替换字符，
    // 而外层 JSON 仍然 parse 得过——正是那条静默失真。
    const cut = bytes.indexOf(Buffer.from('两', 'utf8')) + 1
    expect(cut).toBeGreaterThan(0)

    fromAgent.write(Buffer.from('gemini: loading credentials...\n', 'utf8'))
    fromAgent.write(bytes.subarray(0, cut))
    fromAgent.write(bytes.subarray(cut))

    const res = await init
    expect((res._meta as { note: string }).note).toBe(NOTE)
    expect(errors).toEqual(['stdout 上不是 JSON-RPC 的一行：gemini: loading credentials...'])
    spawned.close()
    await spawned.closed
  })
})
