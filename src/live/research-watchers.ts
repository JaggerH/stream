// src/live/research-watchers.ts — research present 频道的 fs-watcher 注册表。
//
// 为什么需要一个常驻对象而不是开机跑一遍 for 循环：research 频道是**运行期**建出来的
// （创建对话框），而 watcher 只在装配期起过一轮，于是新建的频道到下次重启前都拿不到
// `live-changed` 推送——页面打开时查得到 run，磁盘上新落一个 run 却不会自己刷新。
// 调度那一半（新建/改绑的流不再被采集）由 `store/collection-policy.ts` 的
// `applyCollectionPolicy` 守着，watcher 是同一个接缝的另一边：**每条会改变
// 「流—频道」关系、频道 present、或流成员表的写入路径，都要跑一次 `sync()`**。
// 漏一处的症状同样是安静的：那个频道只是不实时刷新，没有任何一处会喊。
//
// **所有权边界**：`kernel.effect` 是装配期的一次性登记，只用来接 `stopAll()`（进程收摊）。
// 运行期的增删（新建频道起 watcher、挪出 research 停 watcher）**全部由本对象自己负责关**——
// 别把单个 watcher 的 stop() 登记成 effect，那样运行期停掉的 watcher 仍挂在内核的
// dispose 链上，而内核也永远不知道它已经停了。

/** 一条 research 频道引用的流。只取 sync 判据要的两格，测试塞个字面量即可。 */
export interface ResearchChannelsView {
  listChannels(): Array<{ present: string; stream_ids: string[] }>
}

export interface ResearchWatchersDeps extends ResearchChannelsView {
  /** streamId → artifacts 目录。取不到就抛（源没配全）——那条流跳过，不是错误路径。 */
  dirForStream(streamId: string): string
  /** 起一个 watcher，返回它的 stop()。 */
  start(opts: { dir: string; streamId: string }): () => void
}

export interface ResearchWatchers {
  /** 幂等重建：按当下的频道表对齐 watcher 集合。 */
  sync(): void
  /** 全停。交给 `kernel.effect`。 */
  stopAll(): void
}

export function createResearchWatchers(deps: ResearchWatchersDeps): ResearchWatchers {
  /** streamId → 这条流现在盯着哪个目录 + 怎么停。
   *  **按 streamId 去重**：一条流同时挂在两个 research 频道下只起一个 watcher
   *  （watcher 推的是 `{streamId}`，起两个只会把同一条广播发两遍）。 */
  const live = new Map<string, { dir: string; stop: () => void }>()

  const desired = (): Map<string, string> => {
    const want = new Map<string, string>()
    for (const ch of deps.listChannels()) {
      if (ch.present !== 'research') continue
      for (const streamId of ch.stream_ids) {
        if (want.has(streamId)) continue
        let dir: string
        try { dir = deps.dirForStream(streamId) } catch { continue }
        want.set(streamId, dir)
      }
    }
    return want
  }

  return {
    sync(): void {
      const want = desired()
      // 先卸载：挪出 research / 频道被删 / 改绑成员导致 artifacts 目录变了。
      // 目录变了走「停掉再起」——`watchArtifactsDir` 的 dir 是构造期参数，没有换目录这个动作。
      for (const [streamId, entry] of [...live]) {
        if (want.get(streamId) === entry.dir) continue
        entry.stop()
        live.delete(streamId)
      }
      // 再装载：只装此刻没有的那些，所以同一份频道表连调两次不产生第二批 watcher。
      for (const [streamId, dir] of want) {
        if (live.has(streamId)) continue
        live.set(streamId, { dir, stop: deps.start({ dir, streamId }) })
      }
    },
    stopAll(): void {
      for (const entry of live.values()) entry.stop()
      live.clear()
    },
  }
}
