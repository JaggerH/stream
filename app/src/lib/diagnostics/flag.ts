import { useEffect, useState } from 'react'

// 诊断飞行记录器开关。关闭时不注册采样器、不注册全局异常监听、不建 recorder。
// 与 debugFlag 同构但**默认关闭**（诊断要写 IndexedDB，不该不问自开）。
const KEY = 'stream.diagnostics'
const EVT = 'stream-diagnostics-change'

export function isDiagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false // 隐私模式等：读不到就当关
  }
}

export function setDiagnosticsEnabled(on: boolean): void {
  localStorage.setItem(KEY, on ? '1' : '0')
  window.dispatchEvent(new Event(EVT))
}

/** 订阅开关；任意处变更都会让消费者重渲染。 */
export function useDiagnosticsEnabled(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(isDiagnosticsEnabled)
  useEffect(() => {
    const sync = () => setOn(isDiagnosticsEnabled())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  return [on, setDiagnosticsEnabled]
}
