/**
 * 「有哪些频道 / 空间、此刻看的是哪一个」——面板这一侧的**唯一真相源**。
 *
 * 为什么是模块级 store 而不是某个组件的 state：这份状态有**两个读者、两棵 React 树**——
 * 内容区（`mount` 挂的 `StreamPanel`）和导航树（`mountNav` 挂的 `NavTree`）各是一个独立的
 * React root，跨 root 没有 context、没有 props 可走。以前那条路是让**宿主**在中间转发
 * （`onChannelNavState` 推出去、`setChannel` 接回来），于是每个宿主都得自己养一份镜像状态；
 * 状态住在这里之后，宿主只决定把两块摆在哪，不再参与同步。
 *
 * 两个 root 都用 `useSyncExternalStore(subscribe, getSnapshot)` 读它，所以 `getSnapshot`
 * **只在真变了的时候才换引用**——每次调用都造个新对象会让 React 认定"每渲染都变了"而无限重渲染。
 */
import { api, LOCAL } from '../../lib/api.ts'
import { DEFAULT_TIMELINE_CHANNEL_ID, type ChannelView } from '../../lib/types.ts'
import { panelSupportsChannel } from './support.ts'

/** 导航看到的一个空间（分组那一层）。 */
export interface NavSpace {
  id: string
  label: string
}

export interface ChannelNavSnapshot {
  /** 已按 position 排。**空间单独取一份，不从 channels 里推**：空的空间（建完还没往里放
   *  频道）在 channels 里没有任何痕迹，推导法会让它在导航里直接不存在——而"能先建一个空
   *  分组"正是这一层存在的理由。次序同理：position 只在空间记录上。 */
  spaces: NavSpace[]
  /** 全量，含面板伺候不了的那些（导航要把它们灰着列出来，不是悄悄不列）。 */
  channels: ChannelView[]
  /** 当前频道 id。 */
  active: string
  /** 名录到过货没有。false 时导航平铺，不画一个假的分组。 */
  loaded: boolean
  /** 此刻「要你拍板」的修复连累到的频道 id（spec 2026-09-12 §6）。导航给这些行画红点。 */
  attention: ReadonlySet<string>
}

const INITIAL: ChannelNavSnapshot = {
  spaces: [],
  channels: [],
  active: DEFAULT_TIMELINE_CHANNEL_ID,
  loaded: false,
  attention: new Set<string>(),
}

let snapshot: ChannelNavSnapshot = INITIAL
const listeners = new Set<() => void>()

function emit(): void {
  // 复制一份再遍历：订阅者在回调里退订是常态（React 卸载），边遍历边删会漏掉后面的。
  for (const fn of [...listeners]) fn()
}

export const channelStore = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  },

  getSnapshot(): ChannelNavSnapshot {
    return snapshot
  },

  /**
   * 拉一次 `/api/channels` + `/api/spaces` 写进快照。
   *
   * **两条独立的 catch**：空间读不到只该让导航少一层分组，不该把频道名录一起吞掉；
   * 反过来也一样。任一样失败就保留它上一份值——闪一次空名录会让整棵导航消失又回来。
   */
  async load(): Promise<void> {
    const [channels, spaces] = await Promise.all([
      api.channels(LOCAL).catch(() => undefined),
      api.spaces(LOCAL).catch(() => undefined),
    ])
    if (channels === undefined && spaces === undefined) return
    snapshot = {
      ...snapshot,
      channels: channels ?? snapshot.channels,
      spaces: spaces === undefined
        ? snapshot.spaces
        : [...spaces].sort((a, b) => a.position - b.position).map((s) => ({ id: s.id, label: s.label })),
      loaded: snapshot.loaded || channels !== undefined,
    }
    emit()
  },

  /**
   * 切频道。**只受理名录里画得出来的 id**——一个面板伺候不了的频道（如资源搜索）
   * 切进去只会是一页坏视图，静默不动比切进去诚实。导航把它们灰掉是第一道闸，这是第二道。
   */
  setActive(id: string): void {
    if (id === snapshot.active) return
    const hit = snapshot.channels.find((c) => c.id === id)
    if (hit === undefined || !panelSupportsChannel(hit)) return
    snapshot = { ...snapshot, active: id }
    emit()
  },

  /** 只在集合内容真变了时换引用（useSyncExternalStore 的前提，见文件头注）。 */
  setAttention(ids: Iterable<string>): void {
    const next = new Set(ids)
    const cur = snapshot.attention
    if (next.size === cur.size && [...next].every((id) => cur.has(id))) return
    snapshot = { ...snapshot, attention: next }
    emit()
  },

  /** 测试用：清回初值。模块级状态跨用例活着，不清就是上一条用例的名录漏进下一条。 */
  reset(): void {
    snapshot = INITIAL
    emit()
  },
}
