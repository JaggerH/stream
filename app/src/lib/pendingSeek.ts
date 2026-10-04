/**
 * 「先记下要落到哪一刻，等这条音轨真的加载好了再落过去」——全局 `<audio>` 的 pending-seek。
 *
 * 为什么需要它：`audioStage.seek` 拨的是**当前轨**的进度，对一条还没装上的轨没有意义（写下去
 * 搓的是别人的进度）。而「打开一集播客、从某一刻听起」这件事，天然是「换轨 + 落点」两步，
 * 中间隔着一次异步加载。
 *
 * **当前没有消费方**：唯一那个入口（详情页转写档的点段跳播）2026-08-12 已撤销，`playAt` 因此
 * 也暂时没人调。这份不删——它守的是一条会静默出错的不变量（过期落点写到别人的进度上），
 * 而下一个要做「从某一刻起播」的人一定会重新需要它。
 *
 * 但要知道**守卫只剩一半**：下面这些判据仍由 `pendingSeek.test.ts` 钉着，而 App 那一头的真接线
 * （`playAt` → arm + 起播、`loadedmetadata` → 兑现）原来由 `App.pendingSeek.test.tsx` 钉，那份
 * 测试是驱着转写档的按钮跑的，入口没了它也跟着删了——留着就是在测一条产品里不存在的路。
 * **谁重新接一个入口，谁把那份集成测试补回来。**
 *
 * 为什么在 `lib/` 而不是内联在 App 里：这里的判据是**过期的落点必须丢掉**——不丢就会把 A 的落点
 * 写到 B 的进度上，而且不报错。内联的三个 `if` 搜不到也钉不住；抽成具名模块之后它才有测试挂
 * （`pendingSeek.test.ts`）。状态仍然只有一份，住在 App（句柄的主人），见 App.tsx 的接线。
 *
 * 权威设计：`docs/superpowers/specs/2026-08-12-audio-pending-seek-design.md`
 */

/** 一条待兑现的落点：**带着它要落在哪条轨上**——只有 trackId 让「过期」变成可判定的事实。 */
export interface PendingSeek {
  trackId: string
  seconds: number
}

export interface PendingSeekStore {
  /** 记下一条（同一轨连点两段：后者覆盖前者）。 */
  arm: (trackId: string, seconds: number) => void
  /** 当前轨换了：目标不是它 → 这条过期，丢掉。 */
  retarget: (currentTrackId: string | undefined) => void
  /** 交出落点——只在目标就是当前轨时。无论落不落，这条都清掉（一条只兑现一次）。 */
  redeem: (currentTrackId: string | undefined) => number | null
  /** 显式作废（加载失败 / stop）。 */
  clear: () => void
}

export function createPendingSeek(): PendingSeekStore {
  let pending: PendingSeek | null = null
  return {
    arm: (trackId, seconds) => {
      pending = { trackId, seconds }
    },
    retarget: (currentTrackId) => {
      if (pending && pending.trackId !== currentTrackId) pending = null
    },
    redeem: (currentTrackId) => {
      const at = pending && pending.trackId === currentTrackId ? pending.seconds : null
      // 落不落都清：留着一条对不上的 pending，等于给"用户回头再播这条"埋一次意外跳转。
      pending = null
      return at
    },
    clear: () => {
      pending = null
    },
  }
}

/** 兑现到元素上：`<audio>` 的 `loadedmetadata` 里调一次。返回「落了没落」。
 *  元素还没挂上时**不兑现**（落点还得等），其余情形一律照 `redeem` 的判据走。 */
export function applyPendingSeek(
  store: PendingSeekStore,
  el: { currentTime: number } | null,
  currentTrackId: string | undefined
): boolean {
  if (!el) return false
  const at = store.redeem(currentTrackId)
  if (at === null) return false
  el.currentTime = at
  return true
}
