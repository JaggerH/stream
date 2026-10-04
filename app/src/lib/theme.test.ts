import { expect, test } from 'vitest'
import { appThemeToViewTheme } from './theme.ts'

// 研究页的图表（heatmap / backtest_chart / timeseries / scatter2d）按两档主题取背景和
// 坐标轴色，而应用主题有三档。映射一旦漂了，症状是「亮色页面里嵌着一组暗色图表」——
// 页面本身完全正常，没有任何一处会报错。
test('light 映射到 light', () => {
  expect(appThemeToViewTheme('light')).toBe('light')
})

test('dark 映射到 dark', () => {
  expect(appThemeToViewTheme('dark')).toBe('dark')
})

// acrylic 是偏亮的毛玻璃，归 light 那一档。
test('acrylic 映射到 light', () => {
  expect(appThemeToViewTheme('acrylic')).toBe('light')
})
