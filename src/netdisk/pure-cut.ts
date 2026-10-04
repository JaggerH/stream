/**
 * 「纯享」剪辑的判据——引擎、归档器、裁决器三处同吃这一份（用户拍板 2026-09-03：纯享是另一条播放线，
 * 不是那一集）。
 *
 * 只看名字，且只是个筛子：文件名/标题里含「纯享」。
 */
export const PURE_CUT_DIR = '纯享'
export const isPureCut = (name: string): boolean => name.includes(PURE_CUT_DIR)

const QI = /第\s*0*\d{1,3}\s*期/
/**
 * 「这份文件不可能是这一集」的事实级判据（与时长矛盾同级）：文件名说自己是纯享，而清单这一集
 * 是**期-段体系里的正片**（标题带「第N期」且不含纯享）。只在期-段体系下问——「第 7 集」这类占位标题
 * 说明清单自己都不知道这集是什么，机器没资格替它说"不是"。
 *
 * 活体（脱口秀 map_c038e1，2026-09-03）：六份纯享早先被当成正片认领、刻了前缀；同步与归档器各看各的
 * 决定账本，任何一侧单独拦都拦不住另一侧再认一次——只有引擎自己不建这条边才两侧一致。
 */
export function pureCutMismatch(fileName: string, episodeTitle: string): boolean {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1)
  return isPureCut(base) && QI.test(episodeTitle) && !isPureCut(episodeTitle)
}
