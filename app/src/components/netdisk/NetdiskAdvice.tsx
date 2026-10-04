import { useEffect, useState } from 'react'
import { api, type Connection } from '../../lib/api.ts'
import type { AuthorityStats } from '../../lib/types.ts'

/**
 * 网盘入口最上面那一句：**这条订阅该用哪个入口**。
 *
 * 卡住人的从来不是入口多，是分不清自己属于哪种情况——「源站列着但放不出来」（该用整理，把网盘
 * 里的文件配到这些集上）还是「源站每一集都能放」（那网盘里的是另一批节目，该去「添加来源」把
 * 那个目录当成一条来源加进来）。这句话只写在整理向导的说明文字里时得先点进去才看得见，于是要
 * 试错一轮才知道自己进错了门。
 *
 * 它**机器能直接算**：`stats.needsSupply` 就是源站放不出来的集数（判据见后端
 * `left-from-stream.ts` 的 `hasPlayableMedia`）。所以这里只呈现，不自己数——前端另数一遍
 * 就是第二个真相源，而 `/api/items` 上还挂着播放投影，照它数必然得出假结论。
 *
 * 三种情况一律**不出声**：还在取数、这条流库里没条目（判不了）、netdisk 没启用（503）。
 * 判不了的时候硬给一句建议，比不给更坏。
 */
export function NetdiskAdvice({ streamId, apiBase = '' }: { streamId: string; apiBase?: string }) {
  const [stats, setStats] = useState<AuthorityStats | null>(null)

  useEffect(() => {
    const conn: Connection = { baseUrl: apiBase }
    let dropped = false
    setStats(null)
    void api.reconcile
      .streamAuthority(conn, streamId)
      .then((r) => { if (!dropped) setStats(r.stats) })
      .catch(() => {})
    return () => { dropped = true }
  }, [streamId, apiBase])

  if (!stats || stats.entries === 0) return null
  const needs = stats.needsSupply > 0
  return (
    <div
      data-testid="netdisk-advice"
      className="mb-3 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-sm leading-relaxed"
    >
      {needs ? (
        <>
          这条订阅有 <b>{stats.needsSupply}</b> 集源站放不出来（共 {stats.entries} 集）。
          <span className="text-muted-foreground">
            {' '}网盘里的文件要配到这些集上 —— 用频道菜单里的<b>「整理」</b>。
          </span>
        </>
      ) : (
        <>
          这条订阅 <b>{stats.entries}</b> 集源站都能放，没有要补的。
          <span className="text-muted-foreground">
            {' '}网盘目录里的东西是<b>另一批节目</b>，用<b>「添加来源」</b>挑「网盘目录（音频）」把那个目录当成一条来源加进来，别拿去配对。
          </span>
        </>
      )}
    </div>
  )
}
