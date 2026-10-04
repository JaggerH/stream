import { getConfig, type Config } from './config.ts'
import type { SyncResult } from './sync.ts'

/** 一次同步在 popup 眼里的结局：后台的回执，或者"根本没问到后台"。 */
export type SyncOutcome = SyncResult | { error: string }

/**
 * 点一下「Sync cookies」之后 popup 要做的全部事情：叫后台跑一轮，**然后无条件重读配置**。
 *
 * 重读那一步不是收尾的礼节，是这个界面的正确性：`runSync` 把 `lastSync` 写进 chrome.storage，
 * 而按钮旁边那行「last 12:34:56」是从 `cfg.lastSync` 渲染的，popup **没有 storage 监听器**。
 * 不重读，时间戳就一直停在打开 popup 的那一刻——同步明明成功了，界面上却像没生效，
 * 而且要关掉 popup 再打开才会自己好。**这一步不许挂任何条件**（它曾经挂在一个恒为 false 的
 * 字段上，正是这个症状）。
 *
 * 后台不可达时 `send` 会 reject（"Could not establish connection…"，SW 没了或起不来），
 * 回一个空也算不可达——两种都要变成看得见的失败，而不是一个卡住的按钮。
 */
export async function syncFromPopup(deps: {
  send: (msg: unknown) => Promise<unknown>
  readConfig?: () => Promise<Config>
}): Promise<{ outcome: SyncOutcome; config: Config }> {
  const readConfig = deps.readConfig ?? getConfig
  let outcome: SyncOutcome
  try {
    const res = (await deps.send({ type: 'sync-now' })) as SyncResult | undefined
    outcome = res ?? { error: 'no response from the extension background — reload the extension and retry.' }
  } catch (e) {
    outcome = { error: `${String(e)} — background unreachable; reload the extension, then retry.` }
  }
  return { outcome, config: await readConfig() }
}
