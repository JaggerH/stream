# cdp-binding

## Why

Stream 只能驱动**装了扩展**的浏览器：配对、中继、标签组、cookie 全在 `extension/` 那一侧。没有窗口、
不能装扩展的 Chromium（无头运行、容器里、临时 profile）因此完全用不了——而那正是"把一台浏览器交给
Stream 自己管"的最常见形态。

CDP（Chrome DevTools Protocol）是浏览器自带的标准接口，本机进程连上它就能开标签、求值、点按、读
cookie。缺的只是一层翻译：**把 CDP 讲成扩展中继的那套协议**。服务端一行都不用改——同一套
`/api/ext/pair` → `/api/ext/verify` → WS `/api/ext`，同样的命令、同样的上下线事件，它眼里就是又一条
扩展绑定。

## What Changes

- 新增 `src/cdp-binding/`：配对（一次性码 → token、挑战应答）、状态文件（token + nodeId，0600）、
  一条到 Chromium 的 CDP 连接、把中继命令落到 CDP 上的映射层、以及生命周期（重连 / 心跳 / 撤销）。
- 公共入口 `startCdpBinding(opts) → { bindingId, online, close, done }`，从 `@streamapp/engine` 导出。
- CLI `stream cdp-bind --server <url> --state <file> [--cdp <url>]`：长驻进程，**配对码只从 stdin 读**。
- 服务端、扩展中继协议、事件类型、扩展本身：**都不改**。

## Capabilities

### New Capabilities
- `cdp-binding`：用 CDP 驱动一台没有装扩展的浏览器，对外讲扩展中继的同一套协议。

### Modified Capabilities
（无。协议与网关行为不变。）

## Impact

- 新增：`src/cdp-binding/{loopback,state,pairing,cdp-connection,ops,binding,index}.ts`、
  `src/install/cdp-bind-command.ts`。
- 改动：`src/install/cli.ts`（子命令解析与帮助）、`src/install/cli-entry.ts`（分派）、
  `src/engine/index.ts`（导出）、`src/engine/exports.guard.test.ts`（导出快照）、
  `docs/ARCHITECTURE.md`（这一档的说明）。
- 测试：`src/cdp-binding/{loopback,state,pairing,ops,binding,e2e}.test.ts`（后两个跑真 Chromium）、
  `src/install/cli.test.ts` 补 `cdp-bind` 的解析用例。
