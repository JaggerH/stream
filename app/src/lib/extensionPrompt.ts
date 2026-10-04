/**
 * 「这个能力今天提过安装提示了吗」——动作现场那条提示的节流（spec §4.2 防烦第一条）。
 *
 * **按能力分开记**：订阅提过一次，不该把"手动跑一次采集"那次也吞掉——两个动作是两回事，
 * 用户在第二个现场并不知道第一个现场发生过什么。
 *
 * 记录存 `localStorage`：这是**每个浏览器自己的便利**，不是要跨设备同步的状态。
 * 读写都可能抛（隐私窗口、站点数据被禁），所以一律裹 try/catch，取不到就当"没提过"——
 * 多提一次的代价远小于"该提的时候永远不提"。
 */
const KEY = 'stream.extension-prompt'

export interface PromptRecord {
  lastPromptedAt?: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 同一个能力**一天最多提一次**。没提过 / 记录坏掉 → 提。 */
export function shouldPrompt(_capability: string, record: PromptRecord, now: Date): boolean {
  const last = record.lastPromptedAt
  if (!last) return true
  const t = Date.parse(last)
  if (Number.isNaN(t)) return true
  return now.getTime() - t >= DAY_MS
}

function readAll(): Record<string, PromptRecord> {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Record<string, PromptRecord>) : {}
  } catch {
    return {}
  }
}

export function promptRecord(capability: string): PromptRecord {
  return readAll()[capability] ?? {}
}

export function recordPrompted(capability: string, now: Date): void {
  try {
    const all = readAll()
    all[capability] = { lastPromptedAt: now.toISOString() }
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* 存不下就算了：下次多提一次，不影响正确性 */
  }
}
