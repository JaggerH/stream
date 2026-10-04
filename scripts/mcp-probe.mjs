#!/usr/bin/env node
/**
 * 最小 stdio MCP 探针：`initialize` → `tools/list` →（可选）`tools/call`。
 *
 * **故意不依赖 MCP SDK。** 它验的是 `stream mcp` 这层壳本身——用 SDK 去验一个 SDK 写的
 * server，两边同时坏掉的那种错（协议版本、握手顺序、`notifications/initialized` 漏发）会被
 * 一起吃掉。这里手写 JSON-RPC over stdio，看到什么就是线上真有什么。
 *
 * 用法：
 *   node scripts/mcp-probe.mjs <命令> [参数...]            # 列工具名
 *   node scripts/mcp-probe.mjs --call <工具> <命令> ...     # 再调一次那个工具（无参数）
 *
 * 验收 `stream mcp`（判据：与后端 `/api/mcp` 的清单**逐名一致**）：
 *   node scripts/mcp-probe.mjs node cli/bin/stream.mjs mcp
 *   curl -s -X POST 127.0.0.1:8900/api/mcp -H 'content-type: application/json' \
 *     -H 'accept: application/json, text/event-stream' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 *
 * stdout 只打我们自己的几行摘要；被测进程的 stderr 带 `[probe-stderr]` 前缀转出来——
 * `stream mcp` 的日志全走 stderr，混进 stdout 的一个字节就会把这条 MCP 连接弄坏。
 */
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
let callTool
if (argv[0] === '--call') {
  callTool = argv[1]
  argv.splice(0, 2)
}
const [cmd, ...args] = argv
if (!cmd) {
  process.stderr.write('用法：node scripts/mcp-probe.mjs [--call <工具>] <命令> [参数...]\n')
  process.exit(2)
}

const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' })
let buf = ''
const pending = new Map()
let id = 0

child.stdout.on('data', (d) => {
  buf += d.toString('utf8')
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    } catch {
      // 不是 JSON 的一行 = 有人往 stdout 打了日志。**说出来**，别静默丢：这正是最难查的那种坏法。
      process.stderr.write(`[probe] stdout 上出现了非 JSON-RPC 的一行（这会弄坏 MCP 连接）：${line}\n`)
    }
  }
})
child.stderr.on('data', (d) => process.stderr.write(`[probe-stderr] ${d.toString('utf8')}`))

function call(method, params) {
  const myId = ++id
  return new Promise((resolve, reject) => {
    pending.set(myId, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`)
    setTimeout(() => reject(new Error(`timeout ${method}`)), 60_000)
  })
}

const init = await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'stream-mcp-probe', version: '0' },
})
console.log('INIT', JSON.stringify(init.result?.serverInfo))
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)

const list = await call('tools/list', {})
const names = (list.result?.tools ?? []).map((t) => t.name).sort()
console.log('TOOLCOUNT', names.length)
console.log('TOOLS', names.join(' '))

if (callTool) {
  const r = await call('tools/call', { name: callTool, arguments: {} })
  console.log('CALL', callTool, JSON.stringify(r.result ?? r.error).slice(0, 400))
}

child.stdin.end()
// 给被测进程一点时间走完它自己的收摊路径（`stream mcp` 会打一行 `disposed`）。
setTimeout(() => process.exit(0), 1500)
