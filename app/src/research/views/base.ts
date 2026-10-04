// app/src/research/views/base.ts — 五个图表 view 共用的主题色轮。
// 迁自 app/src/boards/panels/base.ts:只留 themeColors 与 SERIES。BasePanelElement、
// microtask 合并、StreamPanelElement 类型不迁——那些是 custom element 挂载协议的一部分,
// 那条通道（面板资产 bundle）随 Task 14 一起删,壳没有理由跟着搬过来。
export type PanelTheme = 'light' | 'dark'

export interface ThemeColors { text: string; grid: string; series: string[] }

/** 色轮取自 Cockpit chart-utils 的 colorAt(迁移对位),两主题共用。 */
const SERIES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316', '#84cc16']

/** 没配 height 时图表卡多高（px）。真实 artifacts 里配过的值是 280/300/320,取最矮那档当默认。 */
export const DEFAULT_CHART_HEIGHT = 280

/** 图表宿主的高度，**永远是一个自足的像素值**。
 *
 *  别写百分比：图表卡挂在流式布局里（ArtifactView 的 root 只有 minHeight:0，ArtifactCard
 *  是自动高度），百分比高度没有可参照的父高，会回落成 auto → 算出来 0 → lightweight-charts
 *  的建图守卫恒假，一张图都画不出来，而且不报错也不降级。老看板里 height:100% 能用，是因为
 *  面板挂在固定尺寸的网格格子里；换成流式卡片后那个前提没了。 */
export function chartHeightPx(config: { height?: unknown }): number {
  const h = config.height
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? Math.round(h) : DEFAULT_CHART_HEIGHT
}

export function themeColors(theme: PanelTheme): ThemeColors {
  return theme === 'light'
    ? { text: '#374151', grid: '#e5e7eb', series: SERIES }
    : { text: '#a0a0b8', grid: '#2f2f45', series: SERIES }
}
