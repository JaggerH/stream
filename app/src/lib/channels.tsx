import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Connection } from './api.ts'
import { subscribeInventory } from './inventoryBus.ts'
import type { ChannelView } from './types.ts'

/** `PATCH /api/channels/:id` 的请求体（与 api.updateChannel 一致）。 */
export interface ChannelPatchBody {
  label?: string
  stream_ids?: string[]
  present?: 'timeline' | 'audio' | 'video'
  options?: Record<string, unknown>
  /** 换到别的空间（侧栏分组那一层）。 */
  space_id?: string
}

export interface ChannelsCtx {
  channels: ChannelView[]
  /** 成功拉过至少一次——区分「还在拉」和「拉完了但没这条频道」。 */
  loaded: boolean
  error: string | null
  reload: () => Promise<ChannelView[]>
  /**
   * 频道记录的**唯一写入口**：拿服务端返回的持久化 `ChannelView` 覆盖本地那一条。
   *
   * 不做手工合并。手工合并（写完把自己算出来的 next 塞回本地 state）会把「我以为我改成了
   * 什么」当成事实：一来服务端归一化后的结果可能与本地推测分叉，二来——真正咬人的那条——
   * 调用方手里那份频道快照可能已经陈旧，整份写回就会把别人刚存的改动覆盖掉（丢更新）。
   */
  patchChannel: (id: string, body: ChannelPatchBody) => Promise<ChannelView>
}

const Ctx = createContext<ChannelsCtx | null>(null)

export function useChannels(): ChannelsCtx {
  const v = useContext(Ctx)
  if (!v) throw new Error('useChannels outside ChannelsProvider')
  return v
}

/**
 * 频道记录（`ChannelView`）在前端的**唯一一份**共享状态。
 *
 * 在此之前 SlotSwitcher（chip）、ChannelManageSheet、频道列表页各自 `api.channels()` 拉一份
 * 私有快照，然后各自「读旧份 → 整份写回 options.slots」——同屏时后写的那次会把先写的覆盖掉。
 * 订阅同一份状态 + 写入用服务端返回体回填，这一类丢更新就不存在了。
 * 设计见 docs/superpowers/specs/2026-07-27-channel-record-shared-state-design.md。
 */
export function ChannelsProvider({ conn, children }: { conn: Connection; children: ReactNode }) {
  const [channels, setChannels] = useState<ChannelView[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const next = await api.channels(conn)
      setChannels(next)
      setError(null)
      setLoaded(true)
      return next
    } catch (e) {
      setError((e as Error).message)
      throw e
    }
  }, [conn])

  const patchChannel = useCallback(async (id: string, body: ChannelPatchBody) => {
    const updated = await api.updateChannel(conn, id, body)
    setChannels((prev) => (prev.some((c) => c.id === id) ? prev.map((c) => (c.id === id ? updated : c)) : [...prev, updated]))
    return updated
  }, [conn])

  useEffect(() => { void reload().catch(() => {}) }, [reload])

  // 别处改了库存就自己重读一次（总线的头注写了"别处"是谁）。自己写的那几次也会收到自己
  // 触发的广播，多一次 GET，换的是"不必分辨是谁改的"。
  useEffect(() => subscribeInventory(api.wsUrl(conn), () => { void reload().catch(() => {}) }), [conn, reload])

  return <Ctx.Provider value={{ channels, loaded, error, reload, patchChannel }}>{children}</Ctx.Provider>
}
