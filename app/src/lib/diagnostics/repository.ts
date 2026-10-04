import { EVENT_CAP, SAMPLE_CAP, SESSION_CAP, sessionsToDrop, trimToCapacity } from './ring.ts'
import type { DiagEvent, DiagnosticSession, ExportBundle, Sample } from './types.ts'

export const DB_NAME = 'stream-diagnostics'
const DB_VERSION = 1
const SESSIONS = 'sessions'
const SAMPLES = 'samples'
const EVENTS = 'events'

/** 导出物里随行的读者提示 —— 防止把趋势指标读成归因结论。 */
const EXPORT_NOTES = [
  'performance.memory 是 Chromium 专有的趋势指标：它不等于 renderer 进程总内存，不能单独用于归因。只看曲线是否持续上涨。',
  '会话状态 suspected-abnormal 表示上次没能正常收尾，是推断而非 OOM 的确证 —— renderer 被杀后没有代码能记录死因。',
  '播放 URL 已脱敏：只保留 host 与 pathname 的 hash，query/fragment 已丢弃。',
  '字段为 null 表示「未测量」，不是「实测为 0」。',
]

export interface DiagnosticsRepo {
  startSession(s: DiagnosticSession): Promise<void>
  markEnded(id: string): Promise<void>
  /** 把遗留的 running 会话改写为 suspected-abnormal，返回被改写的那些。保留其时间线。 */
  recoverAbnormal(): Promise<DiagnosticSession[]>
  addSample(s: Sample): Promise<void>
  addEvent(e: DiagEvent): Promise<void>
  listSessions(): Promise<DiagnosticSession[]>
  exportSession(id: string): Promise<ExportBundle | null>
  clear(): Promise<void>
  close(): void
}

/** 把一个 IDBRequest 包成 Promise。原生 IDB 是事件式的，这里只做最薄的适配 —— 不引运行时依赖。 */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * 打开诊断库。`factory` 可注入（测试用 fake-indexeddb 的 IDBFactory）；
 * 生产传 undefined = 用 globalThis.indexedDB。
 */
export async function openRepo(factory: IDBFactory = globalThis.indexedDB): Promise<DiagnosticsRepo> {
  const open = factory.open(DB_NAME, DB_VERSION)
  open.onupgradeneeded = () => {
    const db = open.result
    if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' })
    if (!db.objectStoreNames.contains(SAMPLES)) {
      db.createObjectStore(SAMPLES, { autoIncrement: true }).createIndex('bySession', 'sessionId')
    }
    if (!db.objectStoreNames.contains(EVENTS)) {
      db.createObjectStore(EVENTS, { autoIncrement: true }).createIndex('bySession', 'sessionId')
    }
  }
  const db = await promisify(open)

  /**
   * 读出某会话的全部行（按插入顺序 = 时间顺序），连同它们的主键。
   *
   * 刻意用 getAll/getAllKeys 而非 openCursor(IDBKeyRange.only(...))：IDBKeyRange 是个**全局**，
   * 而本模块的 IDBFactory 是注入的。依赖全局会让「注入 factory」这件事只做了一半，测试里
   * 就得往 globalThis 塞东西。索引查询本就接受裸键，两个 getAll 的结果对同一 sessionId
   * 都按主键排序 —— 可以直接对位 zip。
   */
  async function rowsOf<T>(store: string, sessionId: string): Promise<{ key: IDBValidKey; value: T }[]> {
    const tx = db.transaction(store, 'readonly')
    const index = tx.objectStore(store).index('bySession')
    const values = (await promisify(index.getAll(sessionId))) as T[]
    const keys = await promisify(index.getAllKeys(sessionId))
    return values.map((value, i) => ({ key: keys[i], value }))
  }

  /** 按会话裁剪：只删这个 sessionId 名下最旧的那些，别的会话的证据一行不碰。 */
  async function trimStore(store: string, sessionId: string, cap: number): Promise<void> {
    const rows = await rowsOf(store, sessionId)
    if (rows.length <= cap) return
    const doomed = rows.slice(0, rows.length - cap).map((r) => r.key)
    const tx = db.transaction(store, 'readwrite')
    const os = tx.objectStore(store)
    for (const key of doomed) os.delete(key)
    await txDone(tx)
  }

  async function deleteSession(id: string): Promise<void> {
    for (const store of [SAMPLES, EVENTS]) {
      const rows = await rowsOf(store, id)
      const tx = db.transaction(store, 'readwrite')
      const os = tx.objectStore(store)
      for (const r of rows) os.delete(r.key)
      await txDone(tx)
    }
    const tx = db.transaction(SESSIONS, 'readwrite')
    tx.objectStore(SESSIONS).delete(id)
    await txDone(tx)
  }

  async function touch(sessionId: string, at: number): Promise<void> {
    const tx = db.transaction(SESSIONS, 'readwrite')
    const os = tx.objectStore(SESSIONS)
    const cur = (await promisify(os.get(sessionId))) as DiagnosticSession | undefined
    if (cur) os.put({ ...cur, lastWriteAt: at })
    await txDone(tx)
  }

  const repo: DiagnosticsRepo = {
    async listSessions() {
      const tx = db.transaction(SESSIONS, 'readonly')
      return (await promisify(tx.objectStore(SESSIONS).getAll())) as DiagnosticSession[]
    },

    async startSession(s) {
      const tx = db.transaction(SESSIONS, 'readwrite')
      tx.objectStore(SESSIONS).put(s)
      await txDone(tx)
      // 会话数上限兜住 1MB 预算；running 的（= 刚写的这个）永不丢。
      const all = await repo.listSessions()
      for (const id of sessionsToDrop(all, SESSION_CAP)) await deleteSession(id)
    },

    async markEnded(id) {
      const tx = db.transaction(SESSIONS, 'readwrite')
      const os = tx.objectStore(SESSIONS)
      const cur = (await promisify(os.get(id))) as DiagnosticSession | undefined
      if (cur) os.put({ ...cur, status: 'ended' })
      await txDone(tx)
    },

    async recoverAbnormal() {
      const all = await repo.listSessions()
      const stale = all.filter((s) => s.status === 'running')
      if (stale.length === 0) return []
      const tx = db.transaction(SESSIONS, 'readwrite')
      const os = tx.objectStore(SESSIONS)
      const recovered = stale.map((s) => ({ ...s, status: 'suspected-abnormal' as const }))
      for (const s of recovered) os.put(s)
      await txDone(tx)
      return recovered
    },

    async addSample(s) {
      const tx = db.transaction(SAMPLES, 'readwrite')
      tx.objectStore(SAMPLES).add(s)
      await txDone(tx)
      await trimStore(SAMPLES, s.sessionId, SAMPLE_CAP)
      await touch(s.sessionId, s.at)
    },

    async addEvent(e) {
      const tx = db.transaction(EVENTS, 'readwrite')
      tx.objectStore(EVENTS).add(e)
      await txDone(tx)
      await trimStore(EVENTS, e.sessionId, EVENT_CAP)
      await touch(e.sessionId, e.at)
    },

    async exportSession(id) {
      const tx = db.transaction(SESSIONS, 'readonly')
      const session = (await promisify(tx.objectStore(SESSIONS).get(id))) as DiagnosticSession | undefined
      if (!session) return null
      const samples = (await rowsOf<Sample>(SAMPLES, id)).map((r) => r.value)
      const events = (await rowsOf<DiagEvent>(EVENTS, id)).map((r) => r.value)
      return {
        session,
        samples: trimToCapacity(samples, SAMPLE_CAP),
        events: trimToCapacity(events, EVENT_CAP),
        exportedAt: Date.now(),
        notes: EXPORT_NOTES,
      }
    },

    async clear() {
      const tx = db.transaction([SESSIONS, SAMPLES, EVENTS], 'readwrite')
      tx.objectStore(SESSIONS).clear()
      tx.objectStore(SAMPLES).clear()
      tx.objectStore(EVENTS).clear()
      await txDone(tx)
    },

    close() {
      db.close()
    },
  }
  return repo
}
