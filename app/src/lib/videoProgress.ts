/**
 * Remember per-video playback position so a video resumes where you left off.
 * Keyed by provider+id (`<provider>:<vid>`), persisted in localStorage.
 * Entries older than 30 days are pruned on read — tiny, self-expiring store.
 */
const KEY = 'stream:vpos'
const MAX_AGE = 30 * 24 * 3600 * 1000

type Store = Record<string, { t: number; at: number }>

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY)
    const s = raw ? (JSON.parse(raw) as Store) : {}
    const now = Date.now()
    let changed = false
    for (const k of Object.keys(s)) {
      if (now - s[k].at > MAX_AGE) {
        delete s[k]
        changed = true
      }
    }
    if (changed) localStorage.setItem(KEY, JSON.stringify(s))
    return s
  } catch {
    return {}
  }
}

export function getProgress(key: string): number {
  return load()[key]?.t ?? 0
}

export function saveProgress(key: string, t: number): void {
  try {
    const s = load()
    s[key] = { t, at: Date.now() }
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* quota / disabled storage — resume is best-effort */
  }
}

export function clearProgress(key: string): void {
  try {
    const s = load()
    delete s[key]
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}
