/**
 * 「这几个地址里，哪一个是我配对过的那个大脑」——**判据是它能不能证明持有本机那把 secret，
 * 不是它答不答得出某个 API**。
 *
 * 这条判据换掉的是 `detectStreamUrl`：那一版探的是 Stream 专属端点，等于用「你是不是 Stream」
 * 选对端。两个后果，都不好：一是这只手从此只认识 Stream 一种对端；二是**选择这一步可以被
 * 抢占**——先按"谁答话"选定，再把 token 递过去验证，那么抢到本机端口的进程至少能让扩展
 * 停在它身上。把选择和信任合成一步之后，**算不出 proof 的候选根本不可能被选中**。
 *
 * 依赖注入而不是直接 import `native-host.ts` / `backend-identity.ts`：这两个都要真的 Chrome
 * runtime 和 WebCrypto，注入之后这一层能在 node 里测（扩展没有 jsdom，见本目录 sync-now.ts）。
 */

/** 配对成功的那一个：地址 + 这次用的 token。 */
export interface PairedPeer {
  baseUrl: string
  token: string
}

export interface PairingDeps {
  /** 从 native host 带外取 token（`nativeHostToken`）。取不到就抛。 */
  token(): Promise<string>
  /** 让对端证明它也持有这把 token（`verifyBackend`）。证不出来就抛。 */
  verify(baseUrl: string, token: string): Promise<void>
  /** 诊断用；不影响判定。调用方（pairing.ts 自己）只传对象字面量，形状钉死为
   *  Record<string, unknown> —— 唯一的真实调用点（driver.ts）不必再为此加一次类型断言。 */
  log?(event: string, detail: Record<string, unknown>): void
}

/**
 * 逐个候选找出配对过的那个对端。
 *
 * **没有任何候选证明得了 → 回 `null`，绝不回落**。回落到"连第一个答话的"就等于这道锁不存在。
 * @param candidates - 按优先级排好的地址（用户配的那个在前，探测默认值在后）。
 * @param deps - 注入点：取 token / 验对端 / 记一行日志。
 * @returns 第一个证明成功的对端；一个都没有则 `null`。
 */
export async function findPairedPeer(
  candidates: string[],
  deps: PairingDeps,
): Promise<PairedPeer | null> {
  if (!candidates.length) return null

  // token 只取一次：它是本机的，和候选是谁无关。取不到就没什么可谈的了——
  // native host 没登记时这里是唯一说得出原因的地方。
  let token: string
  try {
    token = await deps.token()
  } catch (e) {
    deps.log?.('pairing-no-token', { reason: e instanceof Error ? e.message : String(e) })
    return null
  }

  for (const raw of candidates) {
    const baseUrl = raw.replace(/\/$/, '')
    if (!baseUrl) continue
    try {
      await deps.verify(baseUrl, token)
      return { baseUrl, token }
    } catch (e) {
      // 证明不了不是异常情况：候选表里本来就可能有没起的、或者压根不是我们的东西。
      deps.log?.('pairing-rejected', { baseUrl, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return null
}
