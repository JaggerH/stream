/**
 * 「面板里此刻有哪些内容」在壳侧的落点：正在看的那条 + 当前频道手边这一批。
 *
 * 和 `channel-nav-store.ts` 是同一个形状、同一条通路（bundle 经 mount 的回调把整份状态
 * 推进来，壳侧订阅），只是这一份的消费者不是 React 树而是 `@` 引用源。别再发明第二种
 * 跨 bundle 的传法。
 *
 * **单例、住在 host.ts 里**：panel bundle 的 React root 本来就是模块级单例（entry.tsx 明写
 * 同一时刻只能有一处挂载），所以"当前面板的内容"天然只有一份。做成单例还免掉了一件事——
 * 触发器源注册在插件根 ctx 上，而面板是 `StreamShell` 里的一个 effect 挂的，两者没有共同
 * 的父级能把 store 递下去；靠单例接头，谁都不用改。
 */

/** 壳侧看到的一条内容（app 的 `panel/itemRef.ts` 的结构镜像——两个包不共享类型）。 */
export interface PanelItemRef {
  id: string
  title: string
  url?: string
  author?: string
  streamId?: string
  /** 正文摘要（面板侧已截断）。 */
  excerpt?: string
  /** 上面那份 excerpt 是不是被截断了。 */
  truncated?: boolean
}

/** 推过来的整份状态。 */
export interface PanelItemContextState {
  open: PanelItemRef | null
  recent: PanelItemRef[]
  /** 主区被一块全屏内容占满了没有（详情页 **或** 影视全屏看片）——对话列据此让位。
   *  **不要改回从 `open` 推**：看片那一档没有 item，`open` 恒为 null，对话列就不让位了。 */
  fullscreen?: boolean
}

const EMPTY: PanelItemContextState = { open: null, recent: [], fullscreen: false }

export class ItemContextStore {
  #state: PanelItemContextState = EMPTY
  #listeners = new Set<() => void>()

  get = (): PanelItemContextState => this.#state

  /**
   * 订阅整份状态的变化。
   *
   * 加它是因为这份状态有了**第二个消费者**：`open` 非空 = 面板里正开着一条详情，壳靠它
   * 让对话列自动让位（`ShellLayoutController.setContentDetail`）。第一个消费者（`@` 引用源）
   * 是问一次答一次的，不需要推送。
   * @param fn - 状态变了就叫一声。
   */
  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  #notify(): void { for (const fn of this.#listeners) fn() }

  set = (s: PanelItemContextState): void => { this.#state = s; this.#notify() }

  /** 面板卸载时清空——面板不在了还报"你正在看 X"是在骗调用方。 */
  clear = (): void => { this.#state = EMPTY; this.#notify() }

  /**
   * 按 id 找一条（`@` 引用序列化时用：草稿里存的是 id，发送那一刻才回来取内容）。
   *
   * **正在看的那条也要找得到**：它未必在 `recent` 里（详情可以从搜索/深链打开，那条
   * 不在当前频道这一批中）。漏掉它的症状是"引用了正在看的这条，发出去却说取不到正文"。
   * @param id - item id。
   */
  find = (id: string): PanelItemRef | undefined => {
    if (this.#state.open?.id === id) return this.#state.open
    return this.#state.recent.find((r) => r.id === id)
  }
}

/** 全局唯一的一份（理由见文件头注）。 */
export const itemContext = new ItemContextStore()
