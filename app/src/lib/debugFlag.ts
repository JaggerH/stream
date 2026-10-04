import { useEffect, useState } from 'react'

// Global "debug mode" flag, controlled by the Debug switch in settings and read by the
// DebugBox. Persisted in localStorage; a custom event keeps every consumer in the same tab in
// sync (the native `storage` event only fires in OTHER tabs). Default = dev builds on.
const KEY = 'stream.debug'
const EVT = 'stream-debug-change'

export function isDebugEnabled(): boolean {
  const v = localStorage.getItem(KEY)
  return v === null ? import.meta.env.DEV : v === '1'
}

export function setDebugEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
  window.dispatchEvent(new Event(EVT))
}

/** Subscribe to the flag; re-renders when it changes anywhere in the app. */
export function useDebugEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(isDebugEnabled)
  useEffect(() => {
    const sync = () => setOn(isDebugEnabled())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return [on, setDebugEnabled]
}
