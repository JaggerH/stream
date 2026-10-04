// src/mcp/extract-settle.ts
//
// 「在这次调用里等到好，别让模型为了同一件事调五遍」。
//
// ## 为什么等待必须在这一侧，而不是让模型轮询
//
// DSH 每次工具调用**只画一张卡**，而且那张卡是活的：工具视图拿到的是一份
// `ToolCallBlock`，先是 running 形态、结果落地后同一张卡重画成 settled 形态
// （`@deepseek-ai/dsh-client-ui-tool` 的渲染约定）。也就是说「一张卡片原地更新状态」
// 这件事**不需要任何额外机制**，它就等于「一次不提前返回的工具调用」。
//
// 反过来，提前回一个 `running` 就是把等待推给了模型，而**模型没有 sleep**：它只能
// 立刻再问一次，于是轮询频率由它的出字速度决定，跟这件事要多久毫无关系。代价是双份的
// ——用户看到五张卡片刷屏，上下文里进五份回执，中间那四份没有任何新信息
// （活体 2026-08-30 一轮 5 次）。
//
// ## 没有「跑完了回调你」这条路 —— 查过了，不是没找
//
// - MCP 协议没有服务端把结果**后补**给客户端的形状：一次 `tools/call` 一个应答，
//   没有第二次。
// - DSH 自己**有**一套长任务注册表（`@deepseek-ai/dsh-jobs`：job id、`wait`、
//   `onJobDone` 完成通知、`dsh-tool-jobs` 把这些露给模型）——但它自己的约定原文写着
//   「**约定是进程内的**」，`JobStart.run()` 传的是进程内的回调和 `Agent` 对象。
//   我们是**另一个进程里的 MCP server**，够不着。
// - `dsh-api-remotes` 是客户端 BFF，不是给外部进程往会话里塞消息的入口。
//
// 所以可用的机制只有一条：**在这次调用里阻塞，带预算**。
//
// ## 预算的天花板是 60 秒，而且是 MCP 客户端定的
//
// `@deepseek-ai/dsh-mcp-client` 的 `toolCallTimeoutMs` 是**每次 `callTool` 的超时，
// 默认 60000**。超了模型拿到的是硬错误 `TOOL_TIMEOUT`，不是我们这份说得清的
// 「还在跑」回执——**预算必须严格小于它**，这条不变量由 `hosts/dsh/cordis.patch.yml`
// 的 stream-mcp 行和 `src/http/dsh-bundle.contract.test.ts` 一起守着（那一行把它显式抬到
// {@link EXTRACT_SETTLE_BUDGET_MS} 的两倍以上，不吃默认值）。
//
// （别和 `ToolDefinition.timeoutMs` 搞混：那是**声明**，`dsh-tools` 注册表从不强制，
// 要强制得另装 `dsh-tool-call-timeout-policy`；它管的是 DSH 自己进程内的工具，
// 跟 MCP 这条线无关。这一条上一版注释写反了。）
//
// ## 90 秒是量出来的，不是拍的
//
// 活体 2026-08-30 的转换账本（`/api/conversions` 的 `timing.totalMs`）：
//
//   - `extract` 自己（转写）：1.0 / 1.1 / 1.4 / 1.7 / 2.1 / 15.5 秒 —— **一直够**。
//   - `frames`（画面文字层）：0 / 17.6 / 25.0 / 26.6 / 27.9 / 40.8 / 45.0 / 75.0 /
//     87.5 / 215.0 / 578.3 / 860.7 秒 —— 重尾，成本全在逐帧 OCR（不堵的时候约 8 秒
//     一帧，上限 40 帧）。
//
// 90 秒盖住这批样本的三分之二，含用户报的那条（7.33 秒抖音新闻，frames 40.8s）。
// **重尾一律盖不住，也不该去追**：为了 860 秒那条把整个对话冻 15 分钟，比让它落到
// 「还在跑」那一档坏得多。超预算之后回什么、以及为什么那时**不能**再叫模型重试，
// 见 `extract-frames-layer.ts`。
//
// 要调这个数就去量，别猜：`/api/conversions` 的 `timing.stages` 是现成的样本。

/** 一次等待的预算。**必须严格小于 MCP 客户端的 `toolCallTimeoutMs`**（见头注）。 */
export const EXTRACT_SETTLE_BUDGET_MS = 90_000

/** 两次查库之间隔多久。查的是本进程的 sqlite，一次几十微秒，密一点无所谓；
 *  太稀反而会白等——刚好在两次查询之间落定的话，要多等一个间隔。 */
export const EXTRACT_SETTLE_POLL_MS = 400

export interface SettleDeps {
  /** 这条句柄此刻还有没有没落定的转换（extract 自己 / 画面文字层）。 */
  pending: () => boolean
  /** 睡一会儿。注入是为了测试不用真等——**别改成直接 setTimeout**。 */
  sleep: (ms: number) => Promise<void>
  /** 当前时刻（同上，注入是为了测试）。 */
  now: () => number
}

/**
 * 等到这条句柄的转换落定，或者花光预算。
 *
 * @param deps - 判"还没好"的谓词 + 时钟。
 * @param budgetMs - 最多等多久。
 * @returns 落定了 → true；预算花光还没好 → false。
 */
export async function settleWithin(deps: SettleDeps, budgetMs = EXTRACT_SETTLE_BUDGET_MS): Promise<boolean> {
  const deadline = deps.now() + budgetMs
  // 先问一次再睡：绝大多数调用是「已经跑完了，再取一次缓存」，那种情况一秒都不该等。
  for (;;) {
    if (!deps.pending()) return true
    if (deps.now() >= deadline) return false
    await deps.sleep(EXTRACT_SETTLE_POLL_MS)
  }
}
