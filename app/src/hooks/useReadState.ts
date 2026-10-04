import { useCallback, useState } from 'react'

const KEY = 'stream:read'

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    return new Set(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set()
  }
}

/**
 * Per-item read state, persisted in localStorage. Opening an item marks it read
 * so its unread dot clears and the row dims — read items shouldn't keep nagging.
 * Capped so the store can't grow unbounded as the inbox churns.
 */
export function useReadState() {
  const [read, setRead] = useState<Set<string>>(load)

  const markRead = useCallback((id: string) => {
    setRead((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      // bound the store: keep the most recent 5000 ids
      const arr = [...next]
      const capped = arr.length > 5000 ? arr.slice(arr.length - 5000) : arr
      try {
        localStorage.setItem(KEY, JSON.stringify(capped))
      } catch {
        /* quota / disabled storage — read state stays in-memory only */
      }
      return new Set(capped)
    })
  }, [])

  const isRead = useCallback((id: string) => read.has(id), [read])

  return { isRead, markRead }
}
