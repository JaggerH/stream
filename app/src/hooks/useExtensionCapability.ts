import { useCallback, useEffect, useState } from 'react'
import { api, type Connection } from '../lib/api.ts'
import type { BrowserCapabilityState } from '../lib/types.ts'

/**
 * 「这台机器装没装扩展、用户想不想被提醒」——首启横幅和动作现场那两处提示面共用的取数。
 *
 * **两口而不是一口**：`browser-capability` 只回答"装没装上"，"以后再说过没有"存在 settings
 * 里（`/api/extension/onboarding`）。少读后面那口的症状是拒绝了照样天天弹。
 *
 * 读不到时**不假装成 never-seen**：后端没接这条能力（端点 404）和"从没装过"是两回事，
 * 前者去看接线、后者去装扩展。所以 `state` 是 `undefined`，调用方据此什么都不画。
 */
export function useExtensionCapability(conn: Connection): {
  state?: BrowserCapabilityState
  declinedAt?: string
  /** 装完之后调它重读——**判据在这一口上**，不在 install 的回执上。 */
  refresh: () => void
} {
  const [state, setState] = useState<BrowserCapabilityState | undefined>(undefined)
  const [declinedAt, setDeclinedAt] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let alive = true
    api.extension
      .capability(conn)
      .then((c) => {
        if (alive) setState(c.state)
      })
      .catch(() => {
        if (alive) setState(undefined)
      })
    api.extension
      .onboarding(conn)
      .then((o) => {
        if (alive) setDeclinedAt(o.declinedAt)
      })
      .catch(() => {
        if (alive) setDeclinedAt(undefined)
      })
    return () => {
      alive = false
    }
  }, [conn, nonce])

  return { state, declinedAt, refresh: useCallback(() => setNonce((n) => n + 1), []) }
}
